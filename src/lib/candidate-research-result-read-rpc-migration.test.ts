/**
 * 연구 결과 읽기 함수 migration · 계약 테스트
 *
 * 실행: npm test
 *
 * 여기서는 DB를 부르지 않는다. SQL 파일의 글자만 본다.
 *
 * 보려는 것.
 *
 *   1. 서버 열쇠만 부를 수 있다. 사람도 익명도 아무나도 부를 수 없다.
 *   2. 표의 권한은 하나도 건드리지 않는다. 함수 하나만 열린다.
 *   3. 지문 하나로 정확히 한 건만 찾는다. 둘러볼 방법이 없다.
 *   4. 아무것도 고치지 않는다.
 *   5. 연구 결과 본문만 준다. 줄 번호도 시각도 근거 기록도 주지 않는다.
 *   6. SQL 안의 지문 모양 검사가 TypeScript 원본과 같은 것을 걸러 낸다.
 *
 * 값을 여기 다시 적지 않는다.
 * 함수 이름도 지문 모양도 계약에서 가져와 SQL과 대조한다.
 * 두 벌을 손으로 적어 두면 언젠가 서로 달라진다.
 */

import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import {
  FORBIDDEN_READ_RETURN_FIELDS,
  FUTURE_READ_RPC_SQL_INVARIANTS,
  GET_RESEARCH_RESULT_FOR_CANDIDATE_GENERATION_RPC,
  NO_ENUMERATION_INVARIANT,
  READ_RESULT_COLUMN,
} from '../../supabase/functions/_shared/candidate-research-result-read-boundary-contract.ts';
import { RESEARCH_RESULT_HASH_FORMAT } from '../../supabase/functions/_shared/research-result-store-contract.ts';

/* ------------------------------------------------------------------ */
/* migration 파일 찾기                                                  */
/* ------------------------------------------------------------------ */

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const MIGRATION_DIR = path.join(projectRoot, 'supabase/migrations');

const RPC = GET_RESEARCH_RESULT_FOR_CANDIDATE_GENERATION_RPC;

/**
 * 이 함수를 실제로 만든 migration 하나를 찾는다.
 *
 * 파일 이름으로 찾지 않는다. 이름은 바뀔 수 있지만 무엇을 만드는지는 바뀌지 않는다.
 * 하나가 아니면 그 자리에서 실패한다.
 */
const migrationSql = (): string => {
  const files = readdirSync(MIGRATION_DIR)
    .filter((name) => name.endsWith('.sql'))
    .map((name) => readFileSync(path.join(MIGRATION_DIR, name), 'utf8'))
    .filter((sql) => sql.includes(`create function public.${RPC}`));

  assert.equal(files.length, 1, '읽기 함수를 만든 migration이 하나가 아닙니다.');
  return files[0] as string;
};

const SQL = migrationSql();

/** 설명글에 적힌 단어 때문에 잘못 걸리지 않도록, 실제로 실행되는 부분만 본다. */
const executable = SQL.split('\n')
  .filter((line) => !line.trim().startsWith('--'))
  .join('\n');

/** 함수 본문만 잘라 온다. 본문 밖의 revoke/grant까지 함께 보면 엉뚱한 곳을 보게 된다. */
const functionBody = (): string => {
  const start = executable.indexOf(`create function public.${RPC}`);
  assert.notEqual(start, -1, `${RPC} 를 찾지 못했습니다.`);

  const bodyStart = executable.indexOf('as $$', start);
  assert.notEqual(bodyStart, -1, '본문 시작을 찾지 못했습니다.');

  const bodyEnd = executable.indexOf('\n$$;', bodyStart);
  assert.notEqual(bodyEnd, -1, '본문 끝을 찾지 못했습니다.');

  return executable.slice(bodyStart + 'as $$'.length, bodyEnd);
};

/** 함수 선언부(본문 앞)만 잘라 온다. 반환형과 성질을 볼 자리다. */
const functionHeader = (): string => {
  const start = executable.indexOf(`create function public.${RPC}`);
  assert.notEqual(start, -1, RPC);
  return executable.slice(start, executable.indexOf('as $$', start));
};

const BODY = functionBody();
const HEADER = functionHeader();
const SIGNATURE = `${RPC}(text)`;

/* ================================================================== */
/* A. 범위                                                             */
/* ================================================================== */

describe('연구 결과 읽기 migration · A. 범위', () => {
  it('이 함수를 만드는 migration은 하나뿐이다', () => {
    const matches = readdirSync(MIGRATION_DIR)
      .filter((name) => name.endsWith('.sql'))
      .filter((name) =>
        readFileSync(path.join(MIGRATION_DIR, name), 'utf8').includes(`create function public.${RPC}`),
      );
    assert.equal(matches.length, 1);
  });

  it('이 migration이 만드는 함수는 하나뿐이다', () => {
    const created = [...executable.matchAll(/create (or replace )?function ([^\s(]+)/g)].map(
      (m) => m[2] as string,
    );
    assert.deepEqual(created, [`public.${RPC}`]);
  });

  it('표를 만들거나 고치지 않는다', () => {
    for (const banned of ['create table', 'alter table', 'drop table', 'create trigger']) {
      assert.equal(executable.includes(banned), false, banned);
    }
  });

  it('기존 migration을 건드리지 않는다 — 새 파일 하나만 늘었다', () => {
    // 연구 결과 보관소와 persistence RPC는 그대로 있어야 한다.
    const names = readdirSync(MIGRATION_DIR).filter((n) => n.endsWith('.sql'));
    assert.ok(names.includes('20260905084418_create_research_result_store.sql'));
    assert.ok(names.includes('20260905090418_research_result_persistence_rpc.sql'));
    assert.ok(names.includes('20260905163654_create_published_content_store.sql'));
  });

  it('Candidate/OpenAI/provider 로직이 SQL에 없다', () => {
    // 함수 이름에는 candidate 가 들어간다. 누구를 위한 길인지 이름에 적기로 했기 때문이다.
    // 그래서 이름을 뺀 나머지에서 본다. 여기서 보려는 것은 이름이 아니라 로직이다.
    const withoutName = executable.split(RPC).join('');
    for (const banned of ['candidate', 'openai', 'gpt', 'prompt', 'model', 'http', 'provider']) {
      assert.equal(withoutName.toLowerCase().includes(banned), false, banned);
    }
  });

  it('글(Candidate) 표를 건드리지 않는다', () => {
    for (const banned of ['published_content', 'store_published_content_candidate']) {
      assert.equal(executable.includes(banned), false, banned);
    }
  });
});

/* ================================================================== */
/* B. 모양                                                             */
/* ================================================================== */

describe('연구 결과 읽기 migration · B. 함수의 모양', () => {
  it('create or replace 를 쓰지 않는다', () => {
    assert.equal(FUTURE_READ_RPC_SQL_INVARIANTS.createOrReplaceForbidden, true);
    assert.equal(executable.includes('create or replace function'), false);
    assert.ok(executable.includes(`create function public.${RPC}`));
  });

  it('받는 것은 지문 하나뿐이다', () => {
    const params = HEADER.slice(HEADER.indexOf('(') + 1, HEADER.indexOf(')'));
    const declared = params
      .split(',')
      .map((p) => p.trim())
      .filter((p) => p.length > 0);

    assert.equal(declared.length, 1);
    assert.match(declared[0] as string, /^p_research_result_hash\s+text$/);
  });

  it('목록·건수·정렬 같은 인자를 받지 않는다', () => {
    const params = HEADER.slice(HEADER.indexOf('(') + 1, HEADER.indexOf(')')).toLowerCase();
    for (const banned of ['limit', 'offset', 'sort', 'order', 'domain', 'date', 'text[]', 'jsonb']) {
      assert.equal(params.includes(banned), false, banned);
    }
  });

  it('남의 권한을 빌린다', () => {
    assert.equal(FUTURE_READ_RPC_SQL_INVARIANTS.securityDefiner, true);
    assert.ok(HEADER.includes('security definer'));
  });

  it('계약이 정한 성질 그대로다', () => {
    assert.ok(HEADER.includes(FUTURE_READ_RPC_SQL_INVARIANTS.volatility));
  });

  it('계약이 정한 search_path 그대로다', () => {
    assert.ok(HEADER.includes(`set search_path = ${FUTURE_READ_RPC_SQL_INVARIANTS.searchPath}`));
  });

  it('연구 결과 본문 하나를 돌려준다', () => {
    assert.ok(HEADER.includes('returns jsonb'));
  });
});

/* ================================================================== */
/* C. 권한                                                             */
/* ================================================================== */

describe('연구 결과 읽기 migration · C. 권한', () => {
  it('아무에게나 열린 권한을 회수한다', () => {
    assert.ok(executable.includes(`revoke all on function public.${SIGNATURE} from public;`));
  });

  it('세 역할에서 모두 회수한다', () => {
    const start = executable.indexOf(`revoke all on function public.${SIGNATURE}\n`);
    assert.notEqual(start, -1, '세 역할 회수 구문을 찾지 못했습니다.');
    const revoke = executable.slice(start, start + 200);
    for (const role of ['anon', 'authenticated', 'service_role']) {
      assert.ok(revoke.includes(role), role);
    }
  });

  it('서버 열쇠에만 실행 권한을 준다', () => {
    const grantees = [...executable.matchAll(/grant execute on function [^;]+ to ([^;]+);/g)].map(
      (m) => (m[1] as string).trim(),
    );
    assert.deepEqual(grantees, [FUTURE_READ_RPC_SQL_INVARIANTS.grantExecuteTo]);
  });

  it('로그인한 사람과 익명에게는 주지 않는다', () => {
    for (const role of ['anon', 'authenticated']) {
      assert.equal(
        executable.includes(`grant execute on function public.${SIGNATURE} to ${role};`),
        false,
        role,
      );
    }
  });

  it('회수가 부여보다 먼저 온다', () => {
    const firstRevoke = executable.indexOf('revoke all on function');
    const firstGrant = executable.indexOf('grant execute on function');
    assert.notEqual(firstRevoke, -1);
    assert.notEqual(firstGrant, -1);
    assert.ok(firstRevoke < firstGrant);
  });
});

/* ================================================================== */
/* D. 표의 권한은 그대로                                                */
/* ================================================================== */

describe('연구 결과 읽기 migration · D. 표는 계속 닫혀 있다', () => {
  it('표를 직접 읽는 권한을 주지 않는다', () => {
    assert.equal(FUTURE_READ_RPC_SQL_INVARIANTS.tablePrivilegeGrant, false);
    for (const banned of [
      'grant select on private.research_result',
      'grant select on table private.research_result',
      'grant all on private.research_result',
      'grant all on table private.research_result',
    ]) {
      assert.equal(executable.toLowerCase().includes(banned), false, banned);
    }
  });

  it('private 스키마를 쓸 권한을 주지 않는다', () => {
    assert.equal(executable.toLowerCase().includes('grant usage on schema'), false);
    assert.equal(executable.toLowerCase().includes('grant usage on schema private'), false);
  });

  it('표에 주는 권한 구문이 아예 없다', () => {
    // 함수에 주는 것 말고 grant 는 없어야 한다.
    const grants = [...executable.matchAll(/^grant [^;]+;/gm)].map((m) => m[0] as string);
    for (const grant of grants) {
      assert.ok(grant.startsWith('grant execute on function'), grant);
    }
  });

  it('RLS나 권한 정책을 건드리지 않는다', () => {
    for (const banned of ['row level security', 'create policy', 'alter policy', 'drop policy']) {
      assert.equal(executable.toLowerCase().includes(banned), false, banned);
    }
  });
});

/* ================================================================== */
/* E. 어떻게 찾는가                                                     */
/* ================================================================== */

describe('연구 결과 읽기 migration · E. 찾는 방식', () => {
  it('표 이름을 온전히 적는다', () => {
    assert.ok(BODY.includes(FUTURE_READ_RPC_SQL_INVARIANTS.fullyQualifiedTableReference));
  });

  it('정확히 같은 값으로만 찾는다', () => {
    assert.ok(BODY.includes('r.result_hash = p_research_result_hash'));
  });

  it('표의 칸을 보는 조건은 그 하나뿐이다', () => {
    // where 절에서 표의 칸(r.)을 언급하는 조건이 하나여야 한다.
    // 지문 모양 검사는 받은 값만 보므로 어느 줄이 걸리는지를 바꾸지 못한다.
    const where = BODY.slice(BODY.indexOf('where'));
    const columnPredicates = [...where.matchAll(/r\.[a-z_]+/g)].map((m) => m[0] as string);
    assert.deepEqual(columnPredicates, ['r.result_hash']);
  });

  it('넓게 찾는 방법을 쓰지 않는다', () => {
    const body = BODY.toLowerCase();
    for (const banned of [
      ' like ',
      ' ilike ',
      ' similar to ',
      'substring(',
      'starts_with(',
      'position(',
      ' any(',
      ' in (',
      'order by',
      'limit ',
      'offset ',
      'group by',
      'count(',
    ]) {
      assert.equal(body.includes(banned), false, banned);
    }
  });

  it('훑는 것을 금지한 계약과 SQL이 일치한다', () => {
    assert.equal(NO_ENUMERATION_INVARIANT.exactHashLookupOnly, true);
    assert.equal(FUTURE_READ_RPC_SQL_INVARIANTS.exactEqualityOnly, true);
  });

  it('많아야 한 줄인 것은 표의 유일 조건이 보장한다', () => {
    // 건수를 자르지 않아도 하나다. 그 근거가 실제로 있는지 본다.
    const storeSql = readFileSync(
      path.join(MIGRATION_DIR, '20260905084418_create_research_result_store.sql'),
      'utf8',
    );
    assert.ok(storeSql.includes('research_result_hash_unique'));
    assert.ok(storeSql.includes('unique (result_hash)'));
    assert.equal(FUTURE_READ_RPC_SQL_INVARIANTS.maximumRows, 1);
  });

  it('부르는 쪽이 이름을 정하는 SQL을 만들지 않는다', () => {
    assert.equal(FUTURE_READ_RPC_SQL_INVARIANTS.dynamicSql, false);
    for (const banned of ['execute ', 'format(', 'quote_ident', 'quote_literal', '||']) {
      assert.equal(BODY.toLowerCase().includes(banned), false, banned);
    }
  });
});

/* ================================================================== */
/* F. 아무것도 고치지 않는다                                            */
/* ================================================================== */

describe('연구 결과 읽기 migration · F. 읽기만 한다', () => {
  it('본문에 고치는 구문이 없다', () => {
    const body = BODY.toLowerCase();
    for (const banned of [
      'insert',
      'update',
      'delete',
      'merge',
      'upsert',
      'on conflict',
      'nextval',
      'truncate',
      'for update',
      'returning',
    ]) {
      assert.equal(body.includes(banned), false, banned);
    }
  });

  it('계약의 고치기 금지와 일치한다', () => {
    assert.equal(FUTURE_READ_RPC_SQL_INVARIANTS.insertAllowed, false);
    assert.equal(FUTURE_READ_RPC_SQL_INVARIANTS.updateAllowed, false);
    assert.equal(FUTURE_READ_RPC_SQL_INVARIANTS.deleteAllowed, false);
    assert.equal(FUTURE_READ_RPC_SQL_INVARIANTS.sideEffects, false);
  });

  it('다른 함수를 부르지 않는다 — 특히 적어 두는 함수를', () => {
    for (const banned of [
      'store_biblical_research_result',
      'store_published_content_candidate',
      'perform ',
      'select public.',
    ]) {
      assert.equal(BODY.toLowerCase().includes(banned), false, banned);
    }
  });

  it('없을 때 다른 줄을 주거나 다시 찾지 않는다', () => {
    // select 문이 하나뿐이면 대체 조회가 있을 수 없다.
    const selects = [...BODY.matchAll(/\bselect\b/gi)];
    assert.equal(selects.length, 1);
    assert.equal(BODY.toLowerCase().includes('coalesce('), false);
    assert.equal(BODY.toLowerCase().includes('union'), false);
  });
});

/* ================================================================== */
/* G. 무엇을 돌려주는가                                                 */
/* ================================================================== */

describe('연구 결과 읽기 migration · G. 돌려주는 것', () => {
  it('연구 결과 본문 칸 하나만 읽는다', () => {
    assert.ok(BODY.includes(`r.${READ_RESULT_COLUMN}`));
  });

  it('표에서 읽는 칸은 그 하나뿐이다', () => {
    const select = BODY.slice(BODY.indexOf('select'), BODY.indexOf('from'));
    const columns = [...select.matchAll(/r\.([a-z_]+)/g)].map((m) => m[1] as string);
    assert.deepEqual(columns, [READ_RESULT_COLUMN]);
  });

  it('근거 기록을 돌려주지 않는다', () => {
    assert.equal(BODY.includes('provenance'), false);
    assert.ok(FORBIDDEN_READ_RETURN_FIELDS.includes('provenance'));
  });

  it('줄 번호와 시각을 돌려주지 않는다', () => {
    assert.equal(BODY.includes('research_result_id'), false);
    assert.equal(BODY.includes('created_at'), false);
  });

  it('지문 자체를 되돌려 주지 않는다', () => {
    // 조건으로는 쓰지만 돌려주는 값에는 없다.
    const select = BODY.slice(BODY.indexOf('select'), BODY.indexOf('from'));
    assert.equal(select.includes('result_hash'), false);
  });

  it('여러 칸을 묶어 주지 않는다', () => {
    for (const banned of ['jsonb_build_object', 'row_to_json', 'to_jsonb', 'r.*', 'select *']) {
      assert.equal(BODY.includes(banned), false, banned);
    }
  });
});

/* ================================================================== */
/* H. 지문 모양 사본이 원본과 같은가                                     */
/* ================================================================== */

describe('연구 결과 읽기 migration · H. 지문 모양 대조', () => {
  /**
   * SQL 안의 지문 모양 검사를 뽑아 온다.
   *
   * 여기에 패턴을 손으로 적지 않는다. 적으면 세 번째 주인이 된다.
   * SQL에서 뽑아 와서 TypeScript 원본과 대조하는 것이 이 시험의 전부다.
   */
  const sqlPattern = (): string => {
    const matched = /~\s*'([^']+)'/.exec(BODY);
    assert.notEqual(matched, null, 'SQL에 지문 모양 검사가 없습니다.');
    return (matched as RegExpExecArray)[1] as string;
  };

  it('SQL에 지문 모양 검사가 있다', () => {
    assert.ok(sqlPattern().length > 0);
  });

  it('뽑아 온 패턴의 글자가 원본과 같다', () => {
    assert.equal(sqlPattern(), RESEARCH_RESULT_HASH_FORMAT.source);
  });

  it('뽑아 온 패턴과 원본이 같은 것을 걸러 낸다', () => {
    // 글자가 같다는 것만으로 그치지 않는다. 실제로 같은 판단을 하는지 본다.
    //
    // 여기서 도는 것은 JavaScript 정규식이다. Postgres가 아니다.
    // 다만 이 패턴에 쓰인 것(^ $ 글자 [0-9a-f] {64})은
    // 두 곳에서 같은 뜻이고, 줄바꿈에 대한 기본 동작도 같다.
    // 그래서 이 대조는 "사본이 원본과 어긋났는가"를 잡는 데 쓴다.
    const mirror = new RegExp(sqlPattern());

    const hex64 = 'a'.repeat(64);
    const corpus = [
      // 통과해야 하는 것
      `rres_${hex64}`,
      `rres_${'0123456789abcdef'.repeat(4)}`,
      `rres_${'f'.repeat(64)}`,
      // 막혀야 하는 것
      `rres_${'A'.repeat(64)}`,
      `rres_${'a'.repeat(63)}`,
      `rres_${'a'.repeat(65)}`,
      hex64,
      `evset_${hex64}`,
      `pcand_${hex64}`,
      `rres_${'g'.repeat(64)}`,
      `rres_${'a'.repeat(63)}z`,
      ` rres_${hex64}`,
      `rres_${hex64} `,
      `\nrres_${hex64}`,
      `rres_${hex64}\n`,
      `rres_${hex64}\nrres_${hex64}`,
      '',
      'rres_',
      'rres',
      `RRES_${hex64}`,
    ];

    for (const sample of corpus) {
      assert.equal(
        mirror.test(sample),
        RESEARCH_RESULT_HASH_FORMAT.test(sample),
        `사본과 원본의 판단이 다릅니다: ${JSON.stringify(sample)}`,
      );
    }
  });

  it('통과해야 할 것과 막혀야 할 것이 실제로 그렇게 갈린다', () => {
    // 두 벌이 똑같이 "전부 통과" 시켜도 위 시험은 통과한다. 그것까지 막는다.
    const mirror = new RegExp(sqlPattern());
    const hex64 = 'a'.repeat(64);

    assert.equal(mirror.test(`rres_${hex64}`), true);
    assert.equal(mirror.test(`rres_${'A'.repeat(64)}`), false);
    assert.equal(mirror.test(`evset_${hex64}`), false);
    assert.equal(mirror.test(''), false);
  });

  it('SQL 사본은 두 번째 주인이 아니다', () => {
    // 계약이 그렇게 분류해 두었는지 확인한다.
    const contract = readFileSync(
      path.join(projectRoot, 'supabase/functions/_shared/candidate-research-result-read-boundary-contract.ts'),
      'utf8',
    );
    assert.ok(contract.includes('SECURITY_CRITICAL_ENFORCEMENT_MIRROR'));
    assert.ok(contract.includes('sqlSideIsCopyNotOwner: true'));
  });

  it('모양이 틀린 지문으로는 표의 조건이 무의미해진다', () => {
    // 모양 검사가 where 절 안에 있어야 한다. 밖에 있으면 막지 못한다.
    const where = BODY.slice(BODY.indexOf('where'));
    assert.ok(where.includes('~'));
  });
});
