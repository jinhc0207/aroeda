/**
 * 후보 생성 증거 저장 RPC의 동시성 회귀. 실제 PostgreSQL 두 연결로 확인한다.
 *
 * 이 파일이 하는 일
 *   READ COMMITTED 아래에서 같은 증거를 동시에 두 번 보내면, 순진한 "SELECT로 없는지
 *   본 뒤 INSERT" 순서는 둘 다 "없다"고 보고 둘 다 INSERT를 시도해 한쪽이 기본 키
 *   충돌로 실패한다. "같은 증거 재전송은 멱등"이라는 계약이 동시 요청에서 깨지는
 *   것이다. `INSERT ... ON CONFLICT (artifact_hash) DO NOTHING`을 먼저 쓰면, 동시에
 *   도달한 두 트랜잭션 중 아직 커밋하지 않은 쪽이 있을 때 PostgreSQL이 그 문장을
 *   커밋될 때까지 기다리게 한다 — 그 대기를 이 코드가 따로 구현하지 않는다.
 *
 *   이 테스트는 그 대기가 실제로 일어나고 올바르게 풀리는지, 순수 자바스크립트
 *   유닛 테스트로는 확인할 수 없는 것을 확인한다.
 *
 * fail-closed 판정 (중요)
 *   `psqlOnce`·`psqlSession`은 자식 프로세스의 종료 코드(`code`)와 시그널(`signal`)을
 *   버리지 않는다. 모든 성공·실패 판정은 `code === 0`을 기준으로 하며, `stderr`에
 *   대문자 `ERROR`가 있는지 문자열로 짐작하지 않는다 — 존재하지 않는 컨테이너
 *   (`docker exec`가 "Error response from daemon: No such container..."를 내며
 *   code 1로 죽는다. 대문자 ERROR가 없다), Docker daemon 오류, psql 연결 실패
 *   (`psql: error: ... FATAL:  database ... does not exist`로 code 2, 여기도 대문자
 *   ERROR는 없다), psql 실행 파일 부재를 모두 문자열 매칭 없이 code로 잡는다. 실제
 *   docker/psql을 불러 이 두 경우를 확인한다(아래 "fail-closed 회귀" describe 참고).
 *
 * 세션 정리 (중요)
 *   두 동시성 시나리오 모두 A 세션을 `try/finally`로 감싼다. 중간 단언이 실패하거나
 *   B가 예상과 다르게 끝나도 `finally`의 `A.dispose()`가 반드시 돈다. `dispose()`는
 *   (1) 아직 열려 있을 수 있는 트랜잭션에 `rollback`을 보내고(이미 커밋했거나 트랜잭션이
 *   없으면 PostgreSQL이 WARNING만 내고 넘어간다 — `ON_ERROR_STOP`은 실제 ERROR에만
 *   반응하므로 세션이 끊기지 않는다), (2) `\q`로 psql을 끝내고, (3) 프로세스의 `close`
 *   이벤트를 실제로 기다리며, (4) 정해진 시간 안에 끝나지 않으면 SIGKILL 뒤 다시
 *   `close`를 기다린다. 이미 종료된 세션에서 다시 불러도 안전하다(같은 결과를 그대로
 *   돌려준다). A가 아직 커밋 전에 정리되면 A의 미커밋 INSERT가 롤백되므로, 그 행에
 *   충돌해 잠겨 있던 B의 INSERT도 풀려난다 — 그래서 B promise도 `finally`에서 함께
 *   받아 두어 처리되지 않은 rejection이나 영원한 잠금 대기를 남기지 않는다.
 *
 * 왜 다른 *.test.ts와 다른가
 *   이 저장소의 `*.test.ts`는 원칙적으로 실제 DB·네트워크를 쓰지 않는다
 *   (`biblical-research-handoff.test.ts` 등 여러 파일의 머리말 참고). 이 파일은
 *   그 원칙의 의도적인 예외다 — 동시성은 실제 트랜잭션 잠금 없이는 재현할 수 없다.
 *   그래서 실행 조건을 하나 더 둔다: `AROEDA_SCRIPTURE_CATALOG_TEST_CONTAINER`
 *   환경변수로 이미 떠 있는(모든 migration이 적용된) PostgreSQL 컨테이너 이름을
 *   받았을 때만 실제로 돈다. 없으면 건너뛴다 — `npm run test:logic`을 깨뜨리지
 *   않는다. DB 관리자 역할은 실제 Supabase PostgreSQL 이미지의 소유자 역할인
 *   `supabase_admin`이 기본값이고, 별도 부트스트랩 환경은
 *   `AROEDA_SCRIPTURE_CATALOG_TEST_DB_USER`로 재정의할 수 있다. Docker·컨테이너
 *   준비는 이 테스트의 책임이 아니다.
 *
 *   준비 방법(수동):
 *     docker run -d --name aroeda-evidence-ci -e POSTGRES_PASSWORD=pw \
 *       -e POSTGRES_DB=app postgres:17.6
 *     (역할 부트스트랩 + supabase/migrations/*.sql 순서대로 적용)
 *     AROEDA_SCRIPTURE_CATALOG_TEST_CONTAINER=aroeda-evidence-ci npm run test:logic
 *
 * 헬퍼 자체의 회귀 (fail-closed 회귀 describe)
 *   `psqlOnce`·`psqlSession`은 `container` 이름을 인자로 받는 순수 함수라, 실제 저장
 *   RPC나 migration 스키마의 정확성과 무관하게 그 자체로 시험할 수 있다. 존재하지
 *   않는 컨테이너, psql 자체의 연결 실패(대문자 ERROR 없이 code 2로 죽는 실제 fixture),
 *   중간 단언 실패 뒤 정리까지를 실제 컨테이너 기능 시나리오 4건과 겹치지 않는 별도
 *   테스트로 확인한다.
 *
 * 무엇을 쓰지 않는가
 *   `pg` 같은 DB 드라이버 패키지를 추가하지 않는다. `node:child_process`로
 *   `docker exec ... psql`을 불러 같은 컨테이너 안에서 두 세션을 낸다. 패키지를
 *   새로 설치하지 않는다는 제약을 지킨다.
 */

import assert from 'node:assert/strict';
import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { describe, it } from 'node:test';

import {
  buildBaselineCatalog,
  finalizeCandidate,
  makeExistingDomainCandidate,
  requestId,
} from './automatic-scripture-catalog-test-fixtures.ts';
import { buildCurrentAnalysisSnapshotEnvironment } from '../../supabase/functions/_shared/automatic-scripture-catalog-analysis-environment.ts';
import { sealCandidateGenerationEvidence } from '../../supabase/functions/_shared/automatic-scripture-catalog-candidate-generation-evidence.ts';
import type { SituationAnalysis } from '../../supabase/functions/_shared/situation-analysis.ts';

const CONTAINER = process.env.AROEDA_SCRIPTURE_CATALOG_TEST_CONTAINER;
const DB_ADMIN_ROLE = process.env.AROEDA_SCRIPTURE_CATALOG_TEST_DB_USER ?? 'supabase_admin';

type PsqlResult = {
  /** 정상 종료면 종료 코드, 시그널로 죽었으면 null. code === 0만 성공으로 본다. */
  code: number | null;
  /** 시그널로 죽었으면 그 이름(예: 'SIGKILL'), 아니면 null. */
  signal: NodeJS.Signals | null;
  out: string;
  err: string;
  ms: number;
};

/** proc의 close 이벤트(또는 spawn 자체의 error)를 한 번만 기다리는 promise로 만든다. 여러 번 불러도 같은 promise를 돌려준다. */
function closeOf(proc: ChildProcessWithoutNullStreams, startedAt: number, getOut: () => string, getErr: () => string): Promise<PsqlResult> {
  return new Promise((resolve) => {
    proc.once('close', (code, signal) => resolve({ code, signal, out: getOut(), err: getErr(), ms: Date.now() - startedAt }));
    proc.once('error', () => resolve({ code: null, signal: null, out: getOut(), err: getErr(), ms: Date.now() - startedAt }));
  });
}

/**
 * 한 번의 docker exec ... psql 호출. 종료 코드·시그널·stdout·stderr·소요 시간을 모두 돌려준다.
 *
 * 시간 제한을 넘기면 SIGKILL하고, 그 뒤에도 실제 close 이벤트를 기다려 좀비로 남기지
 * 않는다. 그 결과는 `code: null, signal: 'SIGKILL'`(또는 이미 죽어 있었다면 그 신호)로
 * 돌아오므로, 호출자가 `code === 0`을 확인하면 시간 초과도 자동으로 실패 처리된다 —
 * 시간 초과를 성공으로 오인할 수 없다.
 */
function psqlOnce(container: string, sql: string, timeoutMs = 15_000): Promise<PsqlResult> {
  const startedAt = Date.now();
  const proc = spawn('docker', ['exec', '-i', container, 'psql', '-U', DB_ADMIN_ROLE, '-d', 'app', '-tA', '-v', 'ON_ERROR_STOP=1'], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let out = '';
  let err = '';
  proc.stdout.on('data', (d) => { out += d.toString(); });
  proc.stderr.on('data', (d) => { err += d.toString(); });
  const closed = closeOf(proc, startedAt, () => out, () => err);
  const timer = setTimeout(() => { proc.kill('SIGKILL'); }, timeoutMs);
  void closed.finally(() => clearTimeout(timer));
  try { proc.stdin.write(sql); proc.stdin.end(); } catch { /* spawn 자체가 실패했으면 close/error가 처리한다 */ }
  return closed;
}

/** 한 세션을 계속 열어 두고 명령을 순서대로 보낼 수 있게 한다. BEGIN한 트랜잭션을 미커밋 상태로 붙잡을 때 쓴다. */
function psqlSession(container: string) {
  const startedAt = Date.now();
  const proc = spawn('docker', ['exec', '-i', container, 'psql', '-U', DB_ADMIN_ROLE, '-d', 'app', '-v', 'ON_ERROR_STOP=1'], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let out = '';
  let err = '';
  let exited = false;
  proc.stdout.on('data', (d) => { out += d.toString(); });
  proc.stderr.on('data', (d) => { err += d.toString(); });
  const closed = closeOf(proc, startedAt, () => out, () => err).then((result) => { exited = true; return result; });

  let disposePromise: Promise<PsqlResult> | undefined;
  /**
   * 세션을 정리한다: 아직 열려 있을 트랜잭션을 롤백하고, psql을 끝내고, 실제 종료를
   * 기다린다. 시간 안에 끝나지 않으면 죽이고 다시 기다린다. 몇 번을 불러도 안전하다 —
   * 두 번째 호출부터는 첫 호출이 만든 같은 promise를 그대로 돌려준다.
   */
  function dispose(): Promise<PsqlResult> {
    if (disposePromise) return disposePromise;
    disposePromise = (async () => {
      try { proc.stdin.write('rollback;\n\\q\n'); proc.stdin.end(); } catch { /* 이미 끊겼으면 무시 */ }
      const graceMs = 5_000;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const graceTimeout = new Promise<'timeout'>((resolve) => { timer = setTimeout(() => resolve('timeout'), graceMs); });
      const outcome = await Promise.race([closed, graceTimeout]);
      clearTimeout(timer);
      if (outcome === 'timeout') {
        proc.kill('SIGKILL');
        return closed;
      }
      return outcome;
    })();
    return disposePromise;
  }

  return {
    send: (sql: string) => { proc.stdin.write(sql + '\n'); },
    /**
     * marker가 stdout에 나타날 때까지 기다린다. 실제 Postgres 오류 줄(`ERROR:`로 시작하는
     * 줄)이 먼저 보이면 marker를 못 찾았다는 뜻이므로 조용히 넘어가지 않고 던진다 —
     * 호출자가 "대기가 끝났으니 성공"이라고 잘못 넘겨짚지 못하게 한다.
     */
    waitFor: async (marker: string, timeoutMs = 8_000) => {
      const startedAtWait = Date.now();
      while (true) {
        if (out.includes(marker)) return;
        if (/^ERROR:/m.test(err)) throw new Error(`"${marker}" 대기 중 오류. out=${out} err=${err}`);
        if (Date.now() - startedAtWait > timeoutMs) throw new Error(`timeout waiting for "${marker}". out=${out} err=${err}`);
        await new Promise((r) => setTimeout(r, 20));
      }
    },
    dispose,
    /** 내부 close 이벤트가 실제로 발생했는지. dispose()가 정착했다면 반드시 true여야 한다(그 불변조건을 별도 헬퍼 테스트가 직접 확인한다). */
    hasExited: () => exited,
  };
}

const jsonbLiteral = (value: unknown) => `'${JSON.stringify(value).replace(/'/g, "''")}'::jsonb`;

const analysis = (): SituationAnalysis => ({
  domainPriority: 'resolved', primaryDomain: 'decision_guidance', domainChoiceCandidates: [], secondaryDomains: [],
  situationTags: ['오래된 기도'], emotionTags: ['걱정'], spiritualQuestionTags: ['지혜'],
  prayerModes: ['간구'], pastoralFunctions: ['인도'], safety: { level: 'normal', categories: [] }, confidence: 0.9,
});

/** 후보와 후보에 이어질 증거 한 건을 실제 TypeScript 계약으로 만든다. 문장에 난수를 섞어 매 실행마다 artifactHash가 달라지게 한다(append-only 표라 정리하지 않고도 재실행 안전). */
async function buildFixtureEvidence(seed: string) {
  const base = buildBaselineCatalog();
  const { candidate: made } = await makeExistingDomainCandidate(base);
  const { baseVersionHash: _b, proposedVersionHash: _p, ...draft } = made;
  draft.cards[0].situationTags = ['오래된 기도'];
  draft.generation.modelId = 'gpt-5.6-sol';
  const built = await finalizeCandidate(base, draft);
  const candidate = built.candidate;

  const environment = await buildCurrentAnalysisSnapshotEnvironment(candidate.baseVersionHash);
  const texts = [
    `중요한 결정을 앞두고 오래 기도했지만 마음이 복잡해요 ${seed}.`,
    `앞으로 어느 길을 갈지 차분히 생각하며 지혜를 구해요 ${seed}.`,
    `선택해야 할 때 제 생각만 믿어도 될지 고민돼요 ${seed}.`,
  ];
  const evidence = await sealCandidateGenerationEvidence({
    candidate, environment,
    cases: texts.map((text, i) => ({ caseId: `GEN-SC-052-0${i + 1}`, cardId: 'SC-052', text, analysis: analysis() })),
  });
  return { base, candidate, candidateHash: built.candidateHash, proposedCatalog: built.proposedCatalog, evidence };
}

type Fixture = Awaited<ReturnType<typeof buildFixtureEvidence>>;

/** 후보가 DB에 실제로 있어야 저장 RPC를 시험할 수 있다. baseline·candidate 등록은 이미 멱등이므로 매 실행 재등록해도 안전하다. */
async function seedCandidate(container: string, fixture: Fixture) {
  const { base, candidate, candidateHash, proposedCatalog } = fixture;
  const seedResult = await psqlOnce(container, `
    insert into private.research_result (result_hash, result, provenance)
    values ('${candidate.sourceResearchResultHash}', '{"seed":true}'::jsonb, '{"seed":true}'::jsonb)
    on conflict do nothing;
    set role service_role;
    select public.register_scripture_catalog_baseline('${requestId(9001)}', '${candidate.baseVersionHash}', ${jsonbLiteral(base)});
    reset role;
  `);
  if (seedResult.code !== 0) {
    throw new Error(
      `baseline seed 실패: code=${seedResult.code} signal=${seedResult.signal} out=${seedResult.out} err=${seedResult.err}`,
    );
  }
  const candidateSeed = await psqlOnce(container, `
    set role service_role;
    select public.store_scripture_catalog_candidate('${candidateHash}', ${jsonbLiteral(candidate)}, ${jsonbLiteral(proposedCatalog)});
    reset role;
  `);
  if (candidateSeed.code !== 0) {
    throw new Error(
      `candidate seed 실패: code=${candidateSeed.code} signal=${candidateSeed.signal} out=${candidateSeed.out} err=${candidateSeed.err}`,
    );
  }
}

const describeOrSkip = CONTAINER ? describe : describe.skip;

describeOrSkip('후보 생성 증거 저장 RPC · 동시성 (실제 PostgreSQL, ' + (CONTAINER ?? '') + ')', () => {
  it('컨테이너가 준비돼 있다', async () => {
    const ready = await psqlOnce(CONTAINER!, 'select 1;');
    assert.equal(ready.code, 0, `code=${ready.code} signal=${ready.signal} err=${ready.err}`);
    assert.equal(ready.signal, null);
    assert.equal(ready.out.trim(), '1');
  });

  it('fixture seed는 같은 입력 재실행만 허용하고, unique_violation도 성공으로 오인하지 않는다', async () => {
    const fixture = await buildFixtureEvidence(`seed${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);

    // baseline과 candidate RPC가 같은 입력을 멱등 성공으로 돌려줘야 하므로 두 번 모두
    // code 0으로 끝나야 한다. seedCandidate는 어떤 nonzero도 허용하지 않는다.
    await seedCandidate(CONTAINER!, fixture);
    await seedCandidate(CONTAINER!, fixture);

    // 같은 candidateHash에 다른 후보 JSON을 붙이면 기존 RPC가 unique_violation으로
    // 거절한다. 오류 문구에 unique_violation이 있어도 seed 성공으로 취급하면 안 된다.
    const conflicting: Fixture = {
      ...fixture,
      candidate: {
        ...fixture.candidate,
        generation: {
          ...fixture.candidate.generation,
          modelId: 'gpt-6-astra',
        },
      },
    };
    await assert.rejects(
      () => seedCandidate(CONTAINER!, conflicting),
      /candidate seed 실패: code=[^0].*같은 지문으로 다른 후보가 들어왔습니다/s,
    );
  });

  it('경쟁 없이 새 증거를 저장하면(ON CONFLICT를 타지 않는 경로) 곧바로 그 artifactHash를 반환한다', async () => {
    // v_inserted_hash가 실제로 채워졌는지 확인하고 곧바로 반환하는 분기를 직접 시험한다.
    // 이 분기가 없거나 무조건 반환으로 바뀌면(널 확인 없이), 경쟁이 없을 때도 NULL을
    // 돌려주는 오류가 생길 수 있는데 두 동시성 시나리오만으로는 그 경로를 타지 않는다.
    const fixture = await buildFixtureEvidence(`단독${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    const { evidence } = fixture;
    await seedCandidate(CONTAINER!, fixture);

    const result = await psqlOnce(CONTAINER!, `set role service_role;\nselect public.store_scripture_catalog_candidate_generation_evidence('${evidence.artifactHash}', '${evidence.candidateHash}', ${jsonbLiteral(evidence)});\n`);
    assert.equal(result.code, 0, `code=${result.code} signal=${result.signal} err=${result.err}`);
    assert.equal(result.out.trim().split('\n').pop(), evidence.artifactHash);

    const countResult = await psqlOnce(CONTAINER!, `select count(*) from private.scripture_catalog_candidate_generation_evidence where artifact_hash = '${evidence.artifactHash}';`);
    assert.equal(countResult.code, 0, countResult.err);
    assert.equal(countResult.out.trim(), '1');
  });

  it('동시에 같은 유효 증거를 보내면: A 미커밋 상태에서 B가 잠금 대기하다가 실패 없이 같은 artifactHash를 반환하고, 최종 행은 1개다', async () => {
    const fixture = await buildFixtureEvidence(`동시${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    const { evidence } = fixture;
    await seedCandidate(CONTAINER!, fixture);

    const A = psqlSession(CONTAINER!);
    let bPromise: Promise<PsqlResult> | undefined;
    try {
      A.send('begin;');
      A.send(`insert into private.scripture_catalog_candidate_generation_evidence (artifact_hash, candidate_hash, evidence) values ('${evidence.artifactHash}', '${evidence.candidateHash}', ${jsonbLiteral(evidence)});`);
      await A.waitFor('INSERT 0 1');

      const bCall = `set role service_role;\nselect public.store_scripture_catalog_candidate_generation_evidence('${evidence.artifactHash}', '${evidence.candidateHash}', ${jsonbLiteral(evidence)});\n`;
      bPromise = psqlOnce(CONTAINER!, bCall);

      // B가 실제로 잠금 대기 중인지 서버 상태로 확인한다(추측이 아니다).
      await new Promise((r) => setTimeout(r, 400));
      const lockCheck = await psqlOnce(CONTAINER!, `
        select count(*) from pg_stat_activity
        where wait_event_type = 'Lock'
          and query like '%store_scripture_catalog_candidate_generation_evidence%';
      `);
      assert.equal(lockCheck.code, 0, lockCheck.err);
      assert.equal(lockCheck.out.trim(), '1', 'B가 실제로 잠금 대기 중이어야 한다');

      A.send('commit;');
      const bResult = await bPromise;

      assert.equal(bResult.code, 0, `B가 실패하면 안 된다: code=${bResult.code} signal=${bResult.signal} err=${bResult.err}`);
      assert.equal(bResult.out.trim().split('\n').pop(), evidence.artifactHash);
      assert.ok(bResult.ms >= 350, `B는 A의 커밋까지 실제로 기다려야 한다 (측정: ${bResult.ms}ms)`);

      const countResult = await psqlOnce(CONTAINER!, `select count(*) from private.scripture_catalog_candidate_generation_evidence where artifact_hash = '${evidence.artifactHash}';`);
      assert.equal(countResult.code, 0, countResult.err);
      assert.equal(countResult.out.trim(), '1');
    } finally {
      // 중간에 무엇이 실패했든 A의 트랜잭션을 끝내고(그래야 B의 잠금 대기가 풀린다)
      // psql 프로세스의 실제 종료를 기다린다. B promise도 여기서 받아 두어 처리되지
      // 않은 rejection이나 영원한 잠금 대기를 남기지 않는다.
      await A.dispose();
      if (bPromise) await bPromise.catch(() => {});
    }
  });

  it('같은 artifactHash에 동시에 다른 JSON이 오면: 한쪽은 unique_violation으로 거절되고 최종 행은 1개다', async () => {
    const fixture = await buildFixtureEvidence(`충돌${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    const { evidence } = fixture;
    await seedCandidate(CONTAINER!, fixture);

    const conflicting = structuredClone(evidence);
    conflicting.cases[0] = { ...conflicting.cases[0], text: `전혀 다른 문장으로 바꾼 사례입니다 ${Date.now()}.` };

    const A = psqlSession(CONTAINER!);
    let bPromise: Promise<PsqlResult> | undefined;
    try {
      A.send('begin;');
      A.send(`insert into private.scripture_catalog_candidate_generation_evidence (artifact_hash, candidate_hash, evidence) values ('${evidence.artifactHash}', '${evidence.candidateHash}', ${jsonbLiteral(evidence)});`);
      await A.waitFor('INSERT 0 1');

      const bCall = `set role service_role;\nselect public.store_scripture_catalog_candidate_generation_evidence('${evidence.artifactHash}', '${evidence.candidateHash}', ${jsonbLiteral(conflicting)});\n`;
      bPromise = psqlOnce(CONTAINER!, bCall);
      await new Promise((r) => setTimeout(r, 400));
      A.send('commit;');
      const bResult = await bPromise;

      assert.notEqual(bResult.code, 0, `B는 실패해야 한다(다른 payload). code=${bResult.code} out=${bResult.out}`);
      assert.ok(bResult.err.includes('같은 지문으로 다른 후보 생성 증거가 들어왔습니다'), bResult.err);

      const countResult = await psqlOnce(CONTAINER!, `select count(*) from private.scripture_catalog_candidate_generation_evidence where artifact_hash = '${evidence.artifactHash}';`);
      assert.equal(countResult.code, 0, countResult.err);
      assert.equal(countResult.out.trim(), '1');
    } finally {
      await A.dispose();
      if (bPromise) await bPromise.catch(() => {});
    }
  });
});

/**
 * 헬퍼 자체의 fail-closed 회귀.
 *
 * 위 네 가지 기능 시나리오는 migration SQL이 옳다는 전제 위에서 돈다. 이 블록은 그
 * 전제와 무관하게 `psqlOnce`·`psqlSession`·`dispose` 자체가 성공·실패를 code로
 * 정확히 판정하고 프로세스·트랜잭션을 남기지 않는지를 따로 확인한다 — 기능 시나리오가
 * 우연히 통과하는 바람에 이 부분의 결함이 가려지지 않게 하려는 목적이다.
 */
describeOrSkip('후보 생성 증거 저장 RPC · 동시성 헬퍼 · fail-closed 회귀', () => {
  it('dispose()는 실제 close 이벤트가 발생한 뒤에만 정착한다', async () => {
    // 실제 DB 시나리오를 통한 간접 관찰(행 수·pg_stat_activity)은 각 확인 사이에 수십~
    // 수백ms의 docker exec 왕복이 끼어들어, dispose()가 종료를 "기다리지 않고" 즉시
    // 반환해도 그 사이에 실제 종료가 우연히 끝나 버려 차이가 드러나지 않을 수 있다.
    // 그래서 이 불변조건("dispose()가 정착했다면 실제 close 이벤트도 이미 발생했어야
    // 한다")을 완전히 직접 확인한다 — 다른 어떤 지연에도 기대지 않는다.
    const s = psqlSession(CONTAINER!);
    assert.equal(s.hasExited(), false, '방금 만든 세션이 벌써 종료 상태면 안 된다');
    const result = await s.dispose();
    assert.equal(s.hasExited(), true, 'dispose()가 정착했다면 실제 close 이벤트도 이미 발생했어야 한다');
    assert.equal(result.code, 0, `code=${result.code} signal=${result.signal} err=${result.err}`);
    // 다시 불러도 안전하고 같은 결과를 그대로 돌려준다.
    const again = await s.dispose();
    assert.deepEqual(again, result);
  });

  it('존재하지 않는 컨테이너는 준비 확인을 실패로 판정한다', async () => {
    const bogus = `aroeda-nonexistent-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const result = await psqlOnce(bogus, 'select 1;');
    // 예전 판정(err.includes('ERROR'))이라면 이 케이스를 통과시켰을 것이다 — docker의
    // 실제 오류 문구는 "Error response from daemon: ..."이며 대문자 ERROR가 없다.
    assert.equal(result.err.includes('ERROR'), false, '이 fixture는 대문자 ERROR가 없어야 재현 가치가 있다');
    assert.notEqual(result.code, 0, `code=${result.code} out=${result.out} err=${result.err}`);
    assert.ok(/No such container/i.test(result.err), result.err);
  });

  it('psql 자체가 연결에 실패해 nonzero로 끝나지만 stderr에 대문자 ERROR가 없는 실제 fixture를 code로 잡는다', async () => {
    // 컨테이너는 실제로 존재한다 — psql이 존재하지 않는 DB에 붙으려다 실패하는 경우다.
    // 실제 문구는 "psql: error: ... FATAL:  database ... does not exist"로, 소문자
    // "error"와 "FATAL"만 있고 대문자 ERROR는 없다.
    const sanity = await psqlOnce(CONTAINER!, 'select 1;');
    assert.equal(sanity.code, 0, '사전 조건: 정상 접속은 되어야 한다');

    const bogusDbName = `totally_missing_db_${Date.now()}`;
    const startedAt = Date.now();
    const bogusDb = spawn('docker', ['exec', '-i', CONTAINER!, 'psql', '-U', DB_ADMIN_ROLE, '-d', bogusDbName, '-tA', '-v', 'ON_ERROR_STOP=1'], { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    bogusDb.stdout.on('data', (d) => { out += d.toString(); });
    bogusDb.stderr.on('data', (d) => { err += d.toString(); });
    bogusDb.stdin.write('select 1;');
    bogusDb.stdin.end();
    const failure = await closeOf(bogusDb, startedAt, () => out, () => err);

    assert.equal(failure.err.includes('ERROR'), false, `이 fixture는 대문자 ERROR가 없어야 재현 가치가 있다: ${failure.err}`);
    assert.notEqual(failure.code, 0, `code=${failure.code} out=${failure.out} err=${failure.err}`);
    assert.ok(/FATAL/.test(failure.err), failure.err);
  });

  it('동시성 시나리오 중간에 단언이 실패해도 A 프로세스·트랜잭션·B 잠금 대기가 남지 않는다', async () => {
    const fixture = await buildFixtureEvidence(`정리${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    const { evidence } = fixture;
    await seedCandidate(CONTAINER!, fixture);

    const A = psqlSession(CONTAINER!);
    let bPromise: Promise<PsqlResult> | undefined;
    let threw: unknown;
    try {
      A.send('begin;');
      A.send(`insert into private.scripture_catalog_candidate_generation_evidence (artifact_hash, candidate_hash, evidence) values ('${evidence.artifactHash}', '${evidence.candidateHash}', ${jsonbLiteral(evidence)});`);
      await A.waitFor('INSERT 0 1');

      bPromise = psqlOnce(CONTAINER!, `set role service_role;\nselect public.store_scripture_catalog_candidate_generation_evidence('${evidence.artifactHash}', '${evidence.candidateHash}', ${jsonbLiteral(evidence)});\n`);
      await new Promise((r) => setTimeout(r, 400));

      // 실제 프로덕션 코드가 여기서 하듯 커밋하기 전에 일부러 단언을 터뜨린다 — A는
      // 아직 미커밋이고 B는 그 잠금을 기다리는 최악의 시점이다.
      assert.fail('강제 실패 — cleanup 검증용. A는 아직 미커밋, B는 잠금 대기 중이어야 한다.');
    } catch (error) {
      threw = error;
    } finally {
      await A.dispose();
      if (bPromise) await bPromise.catch(() => {});
    }

    assert.ok(threw instanceof Error && /강제 실패/.test(threw.message), 'assert.fail이 실제로 던져졌어야 한다');

    // A가 롤백되면 그 행이 사라지므로, 잠금을 기다리던 B의 같은 INSERT ... ON CONFLICT가
    // 더는 충돌하지 않아 B 자신이 정상적으로 그 행을 넣고 끝날 수 있다 — 이것은 정확한
    // 동작이다(A가 사라져도 B의 요청은 데이터를 잃지 않고 스스로 완결된다). 그래서 이
    // 시점에 "행이 없어야 한다"고 단정하지 않는다. 검증할 불변조건은 두 가지다:
    // 중복이 생기지 않는 것(최대 1행), 그리고 A·B의 서버 세션이 남지 않는 것.
    const rows = await psqlOnce(CONTAINER!, `select count(*), coalesce(string_agg(evidence ->> 'artifactHash', ','), '') from private.scripture_catalog_candidate_generation_evidence where artifact_hash = '${evidence.artifactHash}';`);
    assert.equal(rows.code, 0, rows.err);
    const [rowCount, storedArtifactHashes] = rows.out.trim().split('|');
    assert.ok(rowCount === '0' || rowCount === '1', `중복 없이 최대 1행이어야 한다: ${rows.out}`);
    if (rowCount === '1') assert.equal(storedArtifactHashes, evidence.artifactHash, '남은 한 행의 내용이 원본과 일치해야 한다(부분/오염된 쓰기가 아니어야 한다)');

    // A·B가 만든 세션이 서버 쪽에도 더는 남아 있지 않아야 한다.
    // pg_stat_activity에는 이 확인 쿼리 자신도 실행 중인 백엔드로 잡힌다(질의문 자체에
    // artifactHash 문자열이 들어 있어 like 조건에 자기 자신이 걸린다). pg_backend_pid()로
    // 자신을 빼야 진짜로 남은 세션만 센다.
    const lingering = await psqlOnce(CONTAINER!, `
      select count(*) from pg_stat_activity
      where query like '%${evidence.artifactHash}%' and pid <> pg_backend_pid();
    `);
    assert.equal(lingering.code, 0, lingering.err);
    assert.equal(lingering.out.trim(), '0', '단언 실패 뒤에도 A·B의 서버 세션이 남아 있으면 안 된다');
  });
});

if (!CONTAINER) {
  describe('후보 생성 증거 저장 RPC · 동시성 (건너뜀)', () => {
    it('AROEDA_SCRIPTURE_CATALOG_TEST_CONTAINER가 없어 건너뛴다', () => {
      // 이 테스트 파일의 머리말이 준비 방법을 설명한다. npm run test:logic은 이 파일
      // 없이도(즉 Docker 없이도) 그대로 통과해야 한다.
      assert.equal(CONTAINER, undefined);
    });
  });
}
