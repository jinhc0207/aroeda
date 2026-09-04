/**
 * 연구 근거 꾸러미 보관소 · migration 테스트
 *
 * 실행: npm test
 *
 * 왜 이 표가 필요한가:
 *   수집이 끝난 근거 꾸러미가 서버에 남지 않아서,
 *   부르는 쪽이 자료와 근거를 통째로 지어내도 대조할 원본이 없다.
 *
 * 이 단계에서는 보관소만 만든다. 아직 아무도 이 표를 읽거나 쓰지 않는다.
 * 여기서는 SQL 원문만 읽어 약속대로 쓰였는지 확인한다. DB에 붙지 않는다.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import { RECOVERY_TICKET_TTL_MINUTES } from '../../supabase/functions/_shared/harvest-recovery-ticket.ts';

const MIGRATION = '../../supabase/migrations/20260902120000_biblical_research_handoff.sql';

const sql = readFileSync(new URL(MIGRATION, import.meta.url), 'utf8');
/** 설명 주석에는 예시가 적혀 있으므로, 검사할 때는 주석을 뺀 SQL만 본다. */
const code = sql.replace(/^\s*--.*$/gm, '');

const CREATE_SIG = 'public.create_biblical_research_handoff(jsonb, text)';
const CONSUME_SIG = 'public.consume_biblical_research_handoff(uuid, text)';

/** 함수 하나의 본문만 떼어 낸다. */
const bodyOf = (name: string) => {
  const start = code.indexOf(`create or replace function public.${name}`);
  assert.notEqual(start, -1, name);
  const rest = code.slice(start);
  const end = rest.indexOf('$$;');
  assert.notEqual(end, -1, name);
  return rest.slice(0, end);
};

/** 칸 선언 부분만 떼어 낸다. 함수의 인자 이름과 섞이지 않게 한다. */
const TABLE = code.split('create table private.biblical_research_handoff')[1].split(');')[0];

/* ------------------------------------------------------------------ */

describe('근거 꾸러미 보관소 · 표의 모양', () => {
  it('표는 private 스키마에 있다', () => {
    assert.ok(code.includes('create table private.biblical_research_handoff'));
    assert.equal(/create table public\./.test(code), false);
  });

  it('줄의 이름은 서버가 만든 번호다', () => {
    assert.ok(code.includes('handoff_id uuid primary key default gen_random_uuid()'));
    assert.equal((code.match(/primary key/g) || []).length, 1);
  });

  it('담는 것은 다섯 칸뿐이다', () => {
    const expected = [
      'handoff_id',
      'created_at',
      'expires_at',
      'active_covered_hash',
      'handoff_payload',
    ];
    for (const column of expected) assert.ok(TABLE.includes(column), column);

    // 칸 선언 줄만 센다. 제약(constraint) 줄은 세지 않는다.
    const declared = TABLE.split('\n')
      .map((line) => line.trim())
      .filter((line) => /^[a-z_]+ (text|timestamptz|bigint|uuid|jsonb|integer|boolean)/.test(line));
    assert.equal(declared.length, expected.length, declared.join(' | '));
  });

  it('꾸러미는 통째로 담는다', () => {
    assert.ok(TABLE.includes('handoff_payload jsonb not null'));
  });

  it('활성 영역 지문만 꾸러미 밖에 둔다', () => {
    assert.ok(TABLE.includes('active_covered_hash text not null'));
  });

  it('꾸러미 안에 있는 값을 밖에 한 번 더 적지 않는다', () => {
    // 칸 선언 부분만 본다. 함수 인자 이름과 헷갈리지 않게 한다.
    for (const column of [
      'target_domain',
      'evidence_version',
      'prioritizer_snapshot_id',
      'evidence_set_hash',
    ]) {
      assert.equal(TABLE.includes(column), false, column);
    }
  });

  it('상태 칸이 없다', () => {
    assert.equal(/^\s*status\s/m.test(TABLE), false);
    for (const word of ['pending', 'processing', 'completed', 'failed', 'consumed', 'used']) {
      assert.equal(code.includes(word), false, word);
    }
  });

  it('사용자 정보와 앞 단계 번호를 담지 않는다', () => {
    for (const banned of [
      'user_id',
      'userid',
      'session',
      'device',
      'raw_situation',
      'situation',
      'prayer',
      'decision_id',
      'recovery_id',
      'jwt',
      'token',
    ]) {
      assert.equal(code.includes(banned), false, banned);
    }
  });

  it('만료된 줄을 찾을 수 있게 해 둔다', () => {
    assert.ok(
      code.includes(
        'create index biblical_research_handoff_expires_at_idx\n  on private.biblical_research_handoff (expires_at)',
      ),
    );
    // 30분짜리 보관소다. 찾는 길을 더 만들지 않는다.
    assert.equal((code.match(/create index/g) || []).length, 1);
    assert.equal(/using gin|using gist|jsonb_path_ops/.test(code), false);
  });

  it('다른 표와 이어 붙이지 않는다', () => {
    assert.equal(/references |foreign key|on delete cascade/.test(code), false);
  });
});

describe('근거 꾸러미 보관소 · 값의 조건', () => {
  it('수명이 만들어진 때보다 뒤여야 한다', () => {
    assert.ok(code.includes('check (expires_at > created_at)'));
  });

  it('지문의 모양을 막아 둔다. 앞의 보관소와 같은 조건이다', () => {
    const condition = "check (active_covered_hash ~ '^[0-9a-f]{64}$')";
    assert.ok(code.includes(condition));

    // 새 형식을 만들지 않았다. 앞의 두 보관소가 쓰는 그 조건이다.
    for (const other of [
      '20260902030000_prioritizer_decision.sql',
      '20260831143037_harvest_recovery_ticket.sql',
    ]) {
      const source = readFileSync(
        new URL(`../../supabase/migrations/${other}`, import.meta.url),
        'utf8',
      );
      assert.ok(source.includes(condition), other);
    }
  });
});

describe('근거 꾸러미 보관소 · 수명', () => {
  it('30분을 서버가 정한다', () => {
    assert.ok(code.includes("now() + interval '30 minutes'"));
    // 앞의 보관소들과 같은 값이다. 새 숫자를 만들지 않았다.
    assert.equal(RECOVERY_TICKET_TTL_MINUTES, 30);
  });

  it('수명과 시각을 인자로 받지 않는다', () => {
    assert.equal(/p_expires_at|p_created_at|p_ttl|p_handoff_id uuid,\s*p_expires/.test(code), false);
  });

  it('만료된 줄은 두 함수가 지나가면서 치운다. 따로 도는 작업을 두지 않는다', () => {
    assert.equal((code.match(/where expires_at <= now\(\)/g) || []).length, 2);
    assert.equal(/cron|pg_cron|schedule|job/i.test(code), false);
  });
});

describe('근거 꾸러미 보관소 · 권한', () => {
  it('표에 직접 손댈 수 있는 사람이 없다', () => {
    assert.ok(
      code.includes('alter table private.biblical_research_handoff enable row level security'),
    );
    assert.ok(code.includes('revoke all on table private.biblical_research_handoff from public'));
    assert.ok(
      code.includes(
        'revoke all on table private.biblical_research_handoff from anon, authenticated, service_role',
      ),
    );
    // 정책을 만들어 열어 두지 않는다. 권한 자체가 없다.
    assert.equal(code.includes('create policy'), false);
    assert.equal(/grant .* on table private\.biblical_research_handoff/.test(code), false);
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
    for (const name of ['create_biblical_research_handoff', 'consume_biblical_research_handoff']) {
      const body = bodyOf(name);
      assert.ok(body.includes('security definer'), name);
      assert.ok(body.includes('set search_path = private, pg_catalog'), name);
    }
  });
});

describe('근거 꾸러미 보관소 · 적어 두기', () => {
  const body = () => bodyOf('create_biblical_research_handoff');

  it('받는 것은 꾸러미와 지문 둘뿐이다', () => {
    const signature = code
      .split('create or replace function public.create_biblical_research_handoff(')[1]
      .split(')')[0];

    assert.ok(signature.includes('p_handoff jsonb'));
    assert.ok(signature.includes('p_active_covered_hash text'));

    // 꾸러미 안의 값을 따로 받지 않는다. 따로 받으면 어긋난 값이 들어올 수 있다.
    for (const banned of [
      'p_handoff_id',
      'p_target_domain',
      'p_evidence_version',
      'p_prioritizer_snapshot_id',
      'p_evidence_set_hash',
      'p_expires_at',
      'p_created_at',
    ]) {
      assert.equal(signature.includes(banned), false, banned);
    }
    // 인자는 정확히 둘이다.
    assert.equal(signature.split(',').length, 2);
  });

  it('번호는 DB가 만드는 uuid다', () => {
    assert.ok(code.includes('create or replace function public.create_biblical_research_handoff'));
    assert.ok(body().includes('returning handoff_id into v_handoff_id'));
    assert.ok(body().includes('return v_handoff_id'));
    // 부르는 쪽이 번호를 정할 수 없다.
    assert.equal(body().includes('p_handoff_id'), false);
  });

  it('같은 꾸러미로 두 번 불러도 서로 다른 줄과 번호가 생긴다', () => {
    // 덮어쓰거나 막지 않는다. 번호 하나가 곧 한 번의 권한이다.
    assert.equal(code.includes('on conflict'), false);
    assert.equal(/unique/.test(code), false);
    assert.equal(body().includes('update'), false);
  });

  it('번호만 돌려준다. 꾸러미는 돌려주지 않는다', () => {
    const declaration = code
      .split('create or replace function public.create_biblical_research_handoff')[1]
      .split('as $$')[0];
    assert.ok(declaration.includes('returns uuid'));
    assert.equal(declaration.includes('returns table'), false);
    assert.equal(body().includes('return v_handoff_payload'), false);
  });
});

describe('근거 꾸러미 보관소 · 꺼내 쓰기', () => {
  const body = () => bodyOf('consume_biblical_research_handoff');

  it('받는 것은 번호와 지금의 지문 둘뿐이다', () => {
    const signature = code
      .split('create or replace function public.consume_biblical_research_handoff(')[1]
      .split(')')[0];

    assert.ok(signature.includes('p_handoff_id uuid'));
    assert.ok(signature.includes('p_current_active_covered_hash text'));
    assert.equal(signature.split(',').length, 2);
  });

  it('꾸러미를 돌려준다', () => {
    const declaration = code
      .split('create or replace function public.consume_biblical_research_handoff')[1]
      .split('as $$')[0];
    assert.ok(declaration.includes('returns jsonb'));
    assert.ok(body().includes('return v_handoff_payload'));
  });

  it('세 조건이 모두 같은 지우기 안에 있다', () => {
    // 이것이 핵심이다. 조건이 지우기 밖에 있으면 어긋난 요청도 줄을 태운다.
    const consume = body().split('delete from private.biblical_research_handoff h')[1];
    assert.ok(consume.includes('h.handoff_id = p_handoff_id'));
    assert.ok(consume.includes('h.expires_at > now()'));
    assert.ok(consume.includes('h.active_covered_hash = p_current_active_covered_hash'));
    assert.ok(consume.includes('returning h.handoff_payload into v_handoff_payload'));
  });

  it('지우면서 꺼낸다. 읽고 나서 지우지 않는다', () => {
    assert.equal(/select .* from private\.biblical_research_handoff/.test(body()), false);
    assert.equal(body().includes('for update'), false);
    // 지우는 문장은 둘뿐이다. 만료된 줄 치우기와 꺼내기.
    assert.equal((body().match(/delete from/g) || []).length, 2);
  });

  it('꺼낸 뒤에 영역을 대조하지 않는다', () => {
    // 나중에 대조하면 어긋났을 때 이미 줄이 사라진 뒤다.
    const afterDelete = body().split('returning h.handoff_payload into v_handoff_payload')[1];
    assert.equal(afterDelete.includes('p_current_active_covered_hash'), false);
    assert.equal(afterDelete.includes('active_covered_hash'), false);
  });

  it('표시만 남기고 놔두지 않는다', () => {
    for (const banned of ['consumed_at', 'used_at', 'deleted_at', 'is_deleted', 'set consumed']) {
      assert.equal(code.includes(banned), false, banned);
    }
  });

  it('왜 못 꺼냈는지 알려주지 않는다', () => {
    // 없는 번호, 만료, 이미 쓴 것, 영역 달라짐. 넷 다 같은 빈 값이다.
    assert.equal(body().includes('raise'), false);
    assert.equal(/return '[a-z_]+'/.test(body()), false);
    assert.equal(body().includes('get diagnostics'), false);
  });
});

describe('근거 꾸러미 보관소 · DB가 하지 않는 일', () => {
  it('꾸러미 안을 들여다보지 않는다', () => {
    for (const banned of [
      "->'brief'",
      "->>'targetDomain'",
      "->>'evidenceVersion'",
      "->>'prioritizerSnapshotId'",
      "->>'evidenceSetHash'",
      "->'sources'",
      "->'evidenceClaims'",
      '->>',
      '->',
      'jsonb_array_length',
      'jsonb_each',
      'jsonb_path_query',
    ]) {
      assert.equal(code.includes(banned), false, banned);
    }
  });

  it('지문을 다시 계산하지 않는다', () => {
    for (const banned of ['sha256', 'digest(', 'encode(', 'pgcrypto', 'md5', 'hashtext']) {
      assert.equal(code.includes(banned), false, banned);
    }
  });

  it('영역 목록을 여기에 다시 적지 않는다', () => {
    // 어느 영역인지는 꾸러미 안에 있다. 표가 그 목록을 따로 알 이유가 없다.
    for (const domain of ['loneliness_isolation', 'financial_hardship', 'chronic_illness']) {
      assert.equal(code.includes(domain), false, domain);
    }
  });
});

describe('근거 꾸러미 보관소 · 이 migration이 건드리지 않는 것', () => {
  it('다른 표를 만들거나 바꾸지 않는다', () => {
    for (const table of [
      'prioritizer_decision',
      'harvest_recovery_ticket',
      'content_research_queue',
      'coverage_gap_daily',
      'openai_rate_limit_state',
    ]) {
      assert.equal(code.includes(table), false, table);
    }
    assert.equal((code.match(/create table/g) || []).length, 1);
    assert.equal(/alter table (?!private\.biblical_research_handoff)/.test(code), false);
    assert.equal(/drop table|drop function|drop schema/.test(code), false);
  });

  it('함수는 정확히 둘만 만든다', () => {
    assert.equal((code.match(/create or replace function/g) || []).length, 2);
    assert.ok(code.includes('create or replace function public.create_biblical_research_handoff'));
    assert.ok(code.includes('create or replace function public.consume_biblical_research_handoff'));
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
      '20260902030000_prioritizer_decision.sql',
    ];
    for (const name of others) {
      const other = readFileSync(
        new URL(`../../supabase/migrations/${name}`, import.meta.url),
        'utf8',
      );
      assert.equal(other.includes('biblical_research_handoff'), false, name);
    }
  });

  it('이 migration이 가장 뒤에 온다', () => {
    const others = [
      '20260828061829',
      '20260828162853',
      '20260828223535',
      '20260828223619',
      '20260828231933',
      '20260831143037',
      '20260902030000',
    ];
    for (const stamp of others) {
      assert.ok('20260902120000' > stamp, stamp);
    }
  });
});

describe('근거 꾸러미 보관소 · 지금 누가 쓰는가', () => {
  const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');

  it('적어 두는 곳은 자료 수집의 바깥층 하나뿐이다', () => {
    const index = read('../../supabase/functions/source-harvester/index.ts');
    assert.ok(index.includes('/rest/v1/rpc/create_biblical_research_handoff'));

    // 꾸러미 계약과 연구 실행 순서는 표를 모른다.
    for (const path of [
      '../../supabase/functions/_shared/biblical-research-handoff.ts',
      '../../supabase/functions/_shared/biblical-researcher-runtime-contract.ts',
    ]) {
      const source = read(path);
      assert.equal(source.includes('biblical_research_handoff'), false, path);
      assert.equal(source.includes('handoffId'), false, path);
    }
  });

  it('꺼내 쓰는 곳은 아직 없다', () => {
    // 꺼내 쓰기는 연구 단계의 몫이다. 그 단계는 아직 만들지 않았다.
    for (const path of [
      '../../supabase/functions/source-harvester/handler.ts',
      '../../supabase/functions/source-harvester/index.ts',
    ]) {
      assert.equal(read(path).includes('consume_biblical_research_handoff'), false, path);
    }
  });

  it('부르는 자리는 이 표의 함수 이름을 그대로 쓴다', () => {
    // 표의 이름과 부르는 쪽의 이름이 어긋나면 실행할 때야 알게 된다.
    const adapter = read('../../supabase/functions/_shared/biblical-research-handoff-store.ts');
    for (const name of ['create_biblical_research_handoff', 'consume_biblical_research_handoff']) {
      assert.ok(code.includes(`create or replace function public.${name}(`), name);
      assert.ok(adapter.includes(`'${name}'`), name);
    }
  });
});
