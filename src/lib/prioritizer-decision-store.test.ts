/**
 * Prioritizer 판단 보관소 · migration 테스트
 *
 * 실행: npm test
 *
 * 감사 결과 PROVEN_BINDING_GAP:
 *   Prioritizer의 합의 결과가 어디에도 남지 않아,
 *   Source Harvester가 부르는 쪽이 적어 보낸 값이 맞는지 대조할 원본이 없다.
 *
 * 이 단계에서는 보관소만 만든다. 아직 아무도 이 표를 읽거나 쓰지 않는다.
 * 여기서는 SQL 원문만 읽어 약속대로 쓰였는지 확인한다. DB에 붙지 않는다.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import { RESEARCHABLE_DOMAINS } from '../../supabase/functions/_shared/research-prioritizer-contract.ts';
import { RECOVERY_TICKET_TTL_MINUTES } from '../../supabase/functions/_shared/harvest-recovery-ticket.ts';

const MIGRATION = '../../supabase/migrations/20260902030000_prioritizer_decision.sql';

const sql = readFileSync(new URL(MIGRATION, import.meta.url), 'utf8');
/** 설명 주석에는 예시가 적혀 있으므로, 검사할 때는 주석을 뺀 SQL만 본다. */
const code = sql.replace(/^\s*--.*$/gm, '');

const CREATE_SIG = 'public.create_prioritizer_decision(text, text, bigint, text)';
const CONSUME_SIG = 'public.consume_prioritizer_decision(uuid, text, text, bigint, text)';

/** 함수 하나의 본문만 떼어 낸다. */
const bodyOf = (name: string) => {
  const start = code.indexOf(`create or replace function public.${name}`);
  assert.notEqual(start, -1, name);
  const rest = code.slice(start);
  const end = rest.indexOf('$$;');
  assert.notEqual(end, -1, name);
  return rest.slice(0, end);
};

/* ------------------------------------------------------------------ */

describe('Prioritizer 판단 보관소 · 표의 모양', () => {
  it('표는 private 스키마에 있다', () => {
    assert.ok(code.includes('create table private.prioritizer_decision'));
    assert.equal(/create table public\./.test(code), false);
  });

  it('줄의 이름은 서버가 만든 번호다', () => {
    assert.ok(code.includes('decision_id uuid primary key default gen_random_uuid()'));
    // 판단 시점 id는 이름이 아니라 따라다니는 정보다.
    assert.ok(code.includes('prioritizer_snapshot_id text not null'));
    assert.equal(code.includes('prioritizer_snapshot_id text primary key'), false);
  });

  it('같은 판단 시점이 여러 줄에 있을 수 있다', () => {
    // 여기에 unique를 걸면 같은 후보 상태에서 다시 합의가 나올 때 새 넘겨줌을 만들 수 없다.
    assert.equal(/unique \(?\s*prioritizer_snapshot_id/.test(code), false);
    assert.equal(code.includes('prioritizer_snapshot_id text unique'), false);
    assert.equal((code.match(/primary key/g) || []).length, 1);
  });

  it('담는 것은 일곱 칸뿐이다', () => {
    const table = code.split('create table private.prioritizer_decision')[1].split(');')[0];
    const expected = [
      'decision_id',
      'prioritizer_snapshot_id',
      'created_at',
      'expires_at',
      'target_domain',
      'evidence_version',
      'active_covered_hash',
    ];
    for (const column of expected) assert.ok(table.includes(column), column);

    // 칸 선언 줄만 센다. 제약(constraint) 줄은 세지 않는다.
    const declared = table
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => /^[a-z_]+ (text|timestamptz|bigint|uuid|jsonb|integer|boolean)/.test(line));
    assert.equal(declared.length, expected.length, declared.join(' | '));
  });

  it('상태 칸이 없다', () => {
    assert.equal(/^\s*status\s/m.test(code), false);
    for (const word of ['pending', 'processing', 'completed', 'failed', 'consumed', 'used']) {
      assert.equal(code.includes(word), false, word);
    }
  });

  it('평가자의 판단 근거와 사용자 정보를 담지 않는다', () => {
    for (const banned of [
      'reason',
      'score',
      'confidence',
      'rank',
      'evaluation',
      'raw',
      'response',
      'situation',
      'user_id',
      'session',
      'device',
      'token',
      'candidates',
    ]) {
      assert.equal(code.includes(banned), false, banned);
    }
  });

  it('활성 영역 목록을 통째로 담지 않고 지문만 담는다', () => {
    assert.ok(code.includes('active_covered_hash text not null'));
    assert.equal(code.includes('text[]'), false);
    assert.equal(code.includes('active_covered_domains'), false);
  });

  it('만료된 줄을 찾을 수 있게 해 둔다', () => {
    assert.ok(code.includes('create index prioritizer_decision_expires_at_idx'));
  });
});

describe('Prioritizer 판단 보관소 · 값의 조건', () => {
  it('수명이 만들어진 때보다 뒤여야 한다', () => {
    assert.ok(code.includes('check (expires_at > created_at)'));
  });

  it('판단 시점 id와 지문의 모양을 막아 둔다', () => {
    assert.ok(code.includes("check (prioritizer_snapshot_id ~ '^snap_[0-9a-f]{64}$')"));
    assert.ok(code.includes("check (active_covered_hash ~ '^[0-9a-f]{64}$')"));
  });

  it('근거 판본은 1 이상이다', () => {
    assert.ok(code.includes('check (evidence_version >= 1)'));
  });

  it('연구 대상 영역만 들어올 수 있고, 그 목록이 코드와 같다', () => {
    const constraint = code
      .split('prioritizer_decision_target_domain_allowed')[1]
      .split(')')[0];

    for (const domain of RESEARCHABLE_DOMAINS) {
      assert.ok(constraint.includes(`'${domain}'`), domain);
    }
    // 코드에 없는 영역이 SQL에만 적혀 있지 않다.
    const listed = [...constraint.matchAll(/'([a-z_]+)'/g)].map((match) => match[1]);
    assert.deepEqual([...listed].sort(), [...RESEARCHABLE_DOMAINS].sort());
  });
});

describe('Prioritizer 판단 보관소 · 수명', () => {
  it('30분을 서버가 정한다', () => {
    assert.ok(code.includes("now() + interval '30 minutes'"));
    // 이어서 할 표와 같은 값이다. 새 숫자를 만들지 않았다.
    assert.equal(RECOVERY_TICKET_TTL_MINUTES, 30);
  });

  it('수명과 시각을 인자로 받지 않는다', () => {
    assert.equal(/p_expires_at|p_created_at|p_ttl/.test(code), false);
  });

  it('만료된 줄은 두 함수가 지나가면서 치운다. 따로 도는 작업을 두지 않는다', () => {
    assert.equal((code.match(/where expires_at <= now\(\)/g) || []).length, 2);
    assert.equal(/cron|pg_cron|schedule|job/i.test(code), false);
  });
});

describe('Prioritizer 판단 보관소 · 권한', () => {
  it('표에 직접 손댈 수 있는 사람이 없다', () => {
    assert.ok(code.includes('alter table private.prioritizer_decision enable row level security'));
    assert.ok(code.includes('revoke all on table private.prioritizer_decision from public'));
    assert.ok(
      code.includes(
        'revoke all on table private.prioritizer_decision from anon, authenticated, service_role',
      ),
    );
    // 정책을 만들어 열어 두지 않는다. 권한 자체가 없다.
    assert.equal(code.includes('create policy'), false);
    assert.equal(/grant .* on table private\.prioritizer_decision/.test(code), false);
  });

  it('두 함수만 service_role이 부를 수 있다', () => {
    for (const signature of [CREATE_SIG, CONSUME_SIG]) {
      assert.ok(code.includes(`revoke all on function ${signature} from public`), signature);
      assert.ok(
        code.includes(`revoke all on function ${signature}\n  from anon, authenticated, service_role`),
        signature,
      );
      assert.ok(code.includes(`grant execute on function ${signature} to service_role`), signature);
    }
    // service_role 말고 다른 곳에 실행 권한을 주지 않는다.
    const grants = [...code.matchAll(/grant execute on function [^;]+ to ([a-z_, ]+);/g)];
    assert.equal(grants.length, 2);
    for (const grant of grants) assert.equal(grant[1].trim(), 'service_role');
  });

  it('두 함수 모두 정해진 자격으로 돌고 찾는 곳이 고정돼 있다', () => {
    for (const name of ['create_prioritizer_decision', 'consume_prioritizer_decision']) {
      const body = bodyOf(name);
      assert.ok(body.includes('security definer'), name);
      assert.ok(body.includes('set search_path = private, pg_catalog'), name);
    }
  });
});

describe('Prioritizer 판단 보관소 · 적어 두기', () => {
  const body = () => bodyOf('create_prioritizer_decision');

  it('F. 번호를 인자로 받지 않는다. 서버가 만든다', () => {
    const signature = code.split('create or replace function public.create_prioritizer_decision')[1]
      .split(')')[0];

    assert.equal(signature.includes('p_decision_id'), false);
    assert.equal((signature.match(/p_[a-z_]+ /g) || []).length, 4);
    for (const param of [
      'p_prioritizer_snapshot_id text',
      'p_target_domain text',
      'p_evidence_version bigint',
      'p_active_covered_hash text',
    ]) {
      assert.ok(signature.includes(param), param);
    }

    // 넣는 칸 목록에도 번호가 없다. 기본값(gen_random_uuid)이 채운다.
    const columns = body().split('insert into private.prioritizer_decision (')[1].split(')')[0];
    assert.equal(columns.includes('decision_id'), false);
  });

  it('G. 번호는 DB가 만드는 uuid다', () => {
    assert.ok(code.includes('decision_id uuid primary key default gen_random_uuid()'));
    assert.ok(body().includes('returning decision_id into v_decision_id;'));
    assert.ok(body().includes('v_decision_id uuid;'));
  });

  it('A. 같은 값으로 두 번 불러도 서로 다른 줄과 번호가 생긴다', () => {
    const text = body();

    // 같은 판단 시점이 이미 있어도 막거나 덮지 않는다. 그래야 새 넘겨줌이 생긴다.
    assert.equal(text.includes('on conflict'), false);
    assert.equal(text.includes('do nothing'), false);
    assert.equal(text.includes('do update'), false);

    // 이미 있는지 보고 건너뛰는 길도 없다.
    assert.equal(/if exists|select .* from private\.prioritizer_decision/i.test(text), false);

    // 번호는 줄마다 기본값으로 새로 생기고, 그 값이 유일하다(primary key).
    assert.ok(code.includes('decision_id uuid primary key default gen_random_uuid()'));
  });

  it('번호만 돌려준다', () => {
    assert.ok(body().includes('returns uuid'));
    assert.ok(body().includes('return v_decision_id;'));
    assert.equal(body().includes('returns table'), false);
    assert.equal(body().includes('returns boolean'), false);
  });
});

describe('Prioritizer 판단 보관소 · 대조하고 쓰기', () => {
  const body = () => bodyOf('consume_prioritizer_decision');
  /** 지우는 문장의 where 절만 떼어 낸다. */
  const whereOf = () =>
    body().split('delete from private.prioritizer_decision d')[1].split(';')[0];

  it('번호와 값 넷, 모두 다섯을 받는다', () => {
    const signature = code.split('create or replace function public.consume_prioritizer_decision')[1]
      .split(')')[0];
    for (const param of [
      'p_decision_id uuid',
      'p_prioritizer_snapshot_id text',
      'p_target_domain text',
      'p_evidence_version bigint',
      'p_active_covered_hash text',
    ]) {
      assert.ok(signature.includes(param), param);
    }
    assert.equal((signature.match(/p_[a-z_]+ /g) || []).length, 5);
  });

  it('C·E. 다섯 값이 모두 맞아야만 지운다', () => {
    const where = whereOf();
    for (const condition of [
      'd.decision_id = p_decision_id',
      'd.prioritizer_snapshot_id = p_prioritizer_snapshot_id',
      'd.target_domain = p_target_domain',
      'd.evidence_version = p_evidence_version',
      'd.active_covered_hash = p_active_covered_hash',
    ]) {
      assert.ok(where.includes(condition), condition);
    }
    // 조건 다섯 + 만료 하나가 전부 and로 묶여 있다. or가 없다.
    assert.equal((where.match(/ and /g) || []).length, 5);
    assert.equal(/ or /.test(where), false);
  });

  it('B·D·E. 어긋난 요청은 아무 줄도 지우지 않는다', () => {
    const where = whereOf();

    // 지우는 문장은 이 where 하나뿐이다. 조건을 우회하는 다른 삭제가 없다.
    // (앞의 만료 정리 한 줄은 별도 문장이므로 아래에서 따로 센다.)
    assert.equal((body().match(/delete from private\.prioritizer_decision/g) || []).length, 2);

    // 번호만 보고 지우거나, 판단 시점만 보고 지우는 길이 없다.
    assert.equal(/where\s+d\.decision_id = p_decision_id\s*;/.test(where), false);
    assert.ok(where.trim().startsWith('where'));
  });

  it('B. 다시 발급된 같은 판단은 옛 번호로 소비되지 않는다', () => {
    // 번호는 유일하고(primary key), 기본값으로 줄마다 새로 만들어진다.
    // 그래서 옛 번호는 옛 줄 하나만 가리키고, 그 줄은 이미 지워졌다.
    // 새로 적힌 줄은 번호가 다르므로 옛 번호의 where 조건에 걸리지 않는다.
    assert.ok(code.includes('decision_id uuid primary key default gen_random_uuid()'));
    assert.ok(whereOf().includes('d.decision_id = p_decision_id'));

    // 따라다니는 값으로 줄을 고르는 문장은 반드시 번호도 함께 본다.
    // 문장 단위로 확인한다. 조건이 적힌 순서에 기대지 않는다.
    const statements = code
      .split(';')
      .filter((statement) => statement.includes('delete from private.prioritizer_decision'));

    for (const statement of statements) {
      const usesProvenance = [
        'p_prioritizer_snapshot_id',
        'p_target_domain',
        'p_evidence_version',
        'p_active_covered_hash',
      ].some((param) => statement.includes(param));

      if (!usesProvenance) continue;
      assert.ok(statement.includes('d.decision_id = p_decision_id'), statement.trim());
    }
  });

  it('만료된 줄은 맞는 것으로 치지 않는다', () => {
    assert.ok(whereOf().includes('d.expires_at > now()'));
  });

  it('지우면서 판정한다. 읽고 나서 지우지 않는다', () => {
    const text = body();
    assert.ok(text.includes('get diagnostics v_deleted = row_count;'));
    assert.ok(text.includes('return v_deleted = 1;'));
    // 먼저 읽어 두고 나중에 지우면 두 요청이 같은 줄을 가져갈 수 있다.
    assert.equal(/select .* from private\.prioritizer_decision/i.test(text), false);
  });

  it('맞았는지만 알려주고 왜 틀렸는지는 알려주지 않는다', () => {
    assert.ok(body().includes('returns boolean'));
    assert.equal(body().includes('returns table'), false);
    assert.equal(/raise |exception|not_found|expired|mismatch/i.test(body()), false);
  });
});

describe('Prioritizer 판단 보관소 · 이 migration이 건드리지 않는 것', () => {
  it('다른 표를 만들거나 바꾸지 않는다', () => {
    for (const table of [
      'harvest_recovery_ticket',
      'content_research_queue',
      'coverage_gap_daily',
      'openai_rate_limit_state',
    ]) {
      assert.equal(code.includes(table), false, table);
    }
    assert.equal((code.match(/create table/g) || []).length, 1);
    assert.equal(/alter table (?!private\.prioritizer_decision)/.test(code), false);
    assert.equal(/drop table|drop function|drop schema/.test(code), false);
  });

  it('함수는 정확히 둘만 만든다', () => {
    assert.equal((code.match(/create or replace function/g) || []).length, 2);
    assert.ok(code.includes('create or replace function public.create_prioritizer_decision'));
    assert.ok(code.includes('create or replace function public.consume_prioritizer_decision'));
  });

  it('스스로 무언가를 부르지 않는다', () => {
    for (const banned of ['create trigger', 'http_post', 'net.http', 'pg_net', 'extension']) {
      assert.equal(code.includes(banned), false, banned);
    }
  });

  it('기존 migration 파일을 고치지 않았다', () => {
    // 이 표를 만드는 곳은 이 파일 하나뿐이다.
    const others = [
      '20260828061829_openai_rate_limit.sql',
      '20260828162853_coverage_gap_daily.sql',
      '20260828223535_content_research_queue.sql',
      '20260828223619_harden_content_research_queue_future_dates.sql',
      '20260828231933_research_queue_prioritizer_read_rpc.sql',
      '20260831143037_harvest_recovery_ticket.sql',
    ];
    for (const name of others) {
      const other = readFileSync(
        new URL(`../../supabase/migrations/${name}`, import.meta.url),
        'utf8',
      );
      assert.equal(other.includes('prioritizer_decision'), false, name);
    }
  });
});

describe('Prioritizer 판단 보관소 · 지금 누가 쓰는가', () => {
  const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');

  it('적는 함수는 Prioritizer의 바깥층 한 곳에서만 부른다', () => {
    const index = read('../../supabase/functions/research-prioritizer/index.ts');

    // 표로 나가는 길은 한 곳에만 적혀 있다.
    assert.ok(index.includes("const CREATE_DECISION_RPC_PATH = '/rest/v1/rpc/create_prioritizer_decision'"));
    assert.equal((index.match(/create_prioritizer_decision/g) || []).length, 1);
    // Queue를 읽는 길과 합쳐 DB로 나가는 길은 둘뿐이다.
    assert.equal((index.match(/\/rest\/v1\/rpc\//g) || []).length, 2);

    // 순수 판단 로직은 DB를 모른다.
    for (const path of [
      '../../supabase/functions/_shared/research-prioritizer.ts',
      '../../supabase/functions/_shared/research-prioritizer-edge.ts',
      '../../supabase/functions/_shared/research-prioritizer-contract.ts',
    ]) {
      assert.equal(read(path).includes('prioritizer_decision'), false, path);
      assert.equal(read(path).includes('/rest/v1/'), false, path);
    }
  });

  it('꺼내 쓰는 함수는 Source Harvester 바깥층 한 곳에서만 부른다', () => {
    const index = read('../../supabase/functions/source-harvester/index.ts');
    assert.ok(index.includes("const CONSUME_DECISION_PATH = '/rest/v1/rpc/consume_prioritizer_decision'"));

    // 설명 주석에도 함수 이름이 나오므로 주석을 뺀 코드에서 센다.
    const codeOnly = index.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '');
    assert.equal((codeOnly.match(/consume_prioritizer_decision/g) || []).length, 1);

    // Prioritizer 쪽은 꺼내 쓰지 않는다. 적기만 한다.
    for (const path of [
      '../../supabase/functions/research-prioritizer/index.ts',
      '../../supabase/functions/research-prioritizer/handler.ts',
    ]) {
      assert.equal(read(path).includes('consume_prioritizer_decision'), false, path);
    }
  });

  it('적는 쪽과 꺼내는 쪽이 서로 반대다', () => {
    const prioritizer = read('../../supabase/functions/research-prioritizer/index.ts');
    const harvester = read('../../supabase/functions/source-harvester/index.ts');

    assert.ok(prioritizer.includes('create_prioritizer_decision'));
    assert.equal(harvester.includes('create_prioritizer_decision'), false);
    assert.ok(harvester.includes('consume_prioritizer_decision'));
  });

  it('순수 실행 본체는 이 표를 전혀 모른다', () => {
    // DB에 닿는 곳은 Edge Function 바깥층뿐이다.
    for (const path of [
      '../../supabase/functions/_shared/source-harvester-execution.ts',
      '../../supabase/functions/_shared/harvest-recovery-ticket.ts',
      '../../supabase/functions/_shared/source-harvester-parallel-recovery-execution.ts',
    ]) {
      assert.equal(read(path).includes('prioritizer_decision'), false, path);
      assert.equal(read(path).includes('decisionId'), false, path);
    }
  });

  it('이어서 할 표의 두 함수는 그대로다', () => {
    const index = readFileSync(
      new URL('../../supabase/functions/source-harvester/index.ts', import.meta.url),
      'utf8',
    );
    assert.ok(index.includes('/rest/v1/rpc/create_harvest_recovery_ticket'));
    assert.ok(index.includes('/rest/v1/rpc/consume_harvest_recovery_ticket'));
    // 판단 대조와 꾸러미 적어 두기가 더해져 DB로 나가는 길은 넷이다. 그 이상 늘지 않았다.
    assert.equal((index.match(/\/rest\/v1\/rpc\//g) || []).length, 4);
  });
});
