/**
 * 자동 Scripture Catalog migration · 계약·권한·원자성 테스트
 *
 * 실행: npm test
 *
 * 이 테스트는 DB를 건드리지 않는다.
 *   로컬에 Postgres가 없어 migration을 적용하지 않고 글자로만 확인한다.
 *   그래서 "이 SQL이 실제로 돈다", "트리거가 실제로 트랜잭션을 되돌린다"는 것은 확인하지 못한다.
 *   문법과 실제 동작은 적용 전 별도 단계에서 실제 DB로 확인해야 한다.
 *
 * 확인하는 것
 *   A. SQL에 한 벌 더 적힌 값(필수 검증 항목, 기준값, 후보 종류, 롤백 사유, 지문 모양 등)이 계약과 같다.
 *   B. 모든 표가 RLS·권한 회수·append-only 방아쇠를 갖고, 쓰기는 좁은 SECURITY DEFINER 함수로만 열린다.
 *   C. 활성화·롤백 함수가 fail-closed·멱등·잠금·같은 트랜잭션 공지 규칙을 글자로 담고 있다.
 *   D. 사람 검토 경계(published_content*)를 건드리지 않았고, 개인정보·외부 발송이 없다.
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import {
  ARTIFACT_HASH_FORMAT,
  CANDIDATE_CONTRACT_VERSION,
  CANDIDATE_KINDS,
  CATALOG_CANDIDATE_HASH_FORMAT,
  CATALOG_CONTRACT_VERSION,
  CATALOG_VERSION_HASH_FORMAT,
  THEME_FINGERPRINT_FORMAT,
} from '../../supabase/functions/_shared/automatic-scripture-catalog-contract.ts';
import {
  ACTIVATE_SCRIPTURE_CATALOG_CANDIDATE_RPC,
  AUTOMATED_OPERATIONS_AUTHORITY,
  AUTOMATED_VALIDATION_AUTHORITY,
  AUTOMATIC_CATALOG_RPCS,
  AUTOMATIC_CATALOG_TABLES,
  MIN_DEMAND_ACTIVE_DAYS,
  MIN_DEMAND_OCCURRENCES,
  MIN_GENERATION_CASES_PER_CARD,
  MIN_INDEPENDENT_EVALUATIONS,
  OWNER_NOTIFICATION_KINDS,
  RECORD_SCRIPTURE_DEMAND_THEME_RPC,
  RECORD_SCRIPTURE_DEMAND_WEAK_MATCH_RPC,
  REGISTER_SCRIPTURE_CATALOG_BASELINE_RPC,
  REQUEST_ID_FORMAT,
  REQUIRED_VALIDATION_CHECKS,
  ROLLBACK_REASON_CODES,
  ROLLBACK_SCRIPTURE_CATALOG_VERSION_RPC,
  STORE_SCRIPTURE_CATALOG_CANDIDATE_RPC,
  STORE_SCRIPTURE_CATALOG_VALIDATION_RPC,
  ATTESTATION_HASH_FORMAT,
  THEOLOGY_CRITERION_IDS,
  VALIDATION_CONTRACT_VERSION,
  VALIDATION_HASH_FORMAT,
  VALIDATOR_PROFILE_HASH_FORMAT,
  VALIDATOR_REGISTRY_HASH_FORMAT,
} from '../../supabase/functions/_shared/automatic-scripture-catalog-activation-contract.ts';
import { SOURCE_SHA256 } from '../../supabase/functions/_shared/bible-reference-index.ts';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const MIGRATION_DIR = path.join(projectRoot, 'supabase/migrations');
const MIGRATION_NAME = '20260915120000_create_automatic_scripture_catalog.sql';
const PROFILE_MIGRATION_NAME = '20260916011019_register_automatic_scripture_catalog_validator_profiles.sql';
const V3_MIGRATION_NAME = '20260916141221_upgrade_automatic_scripture_catalog_validation_v3.sql';
const V4_MIGRATION_NAME = '20260922234709_bind_candidate_generation_evidence_to_validation_v4.sql';
const VALIDATION_CONTEXT_MIGRATION_NAME = '20260917090000_add_scripture_catalog_validation_context_rpc.sql';
const GENERATION_EVIDENCE_MIGRATION_NAME =
  '20260922144425_create_scripture_catalog_candidate_generation_evidence_store.sql';
const RUNTIME_RPC_MIGRATION_NAME = '20260923090000_add_active_scripture_catalog_runtime_rpc.sql';
const SQL = readFileSync(path.join(MIGRATION_DIR, MIGRATION_NAME), 'utf8');
const V3_SQL = readFileSync(path.join(MIGRATION_DIR, V3_MIGRATION_NAME), 'utf8');
const V4_SQL = readFileSync(path.join(MIGRATION_DIR, V4_MIGRATION_NAME), 'utf8');

/** 설명 주석에는 예시 낱말이 있다. 동작을 볼 때는 한 줄 주석을 뺀 것만 본다. */
const stripComments = (sql: string) => sql.split('\n').filter((line) => !/^\s*--/.test(line)).join('\n');
const CODE = stripComments(SQL);
const V3_CODE = stripComments(V3_SQL);
const V4_CODE = stripComments(V4_SQL);

/** 함수 하나의 본문(as $$ ... $$;)만 code에서 잘라 온다. create나 create or replace 둘 다 찾는다. */
function functionBodyIn(code: string, schemaAndName: string): string {
  const start = (() => {
    const created = code.indexOf(`create function ${schemaAndName}(`);
    const replaced = code.indexOf(`create or replace function ${schemaAndName}(`);
    if (created === -1 && replaced === -1) return -1;
    return replaced === -1 ? created : replaced;
  })();
  assert.notEqual(start, -1, `${schemaAndName}를 찾지 못했습니다.`);
  const open = code.indexOf('as $$', start);
  const close = code.indexOf('$$;', open + 5);
  assert.ok(open > start && close > open, `${schemaAndName} 본문을 자르지 못했습니다.`);
  return code.slice(start, close + 3);
}

/** 기준 migration에서 함수 본문을 자른다. */
function functionBody(schemaAndName: string): string {
  return functionBodyIn(CODE, schemaAndName);
}

/** v3 업그레이드 migration에서 함수 본문을 자른다(create or replace로 다시 만든 것). */
function v3FunctionBody(schemaAndName: string): string {
  return functionBodyIn(V3_CODE, schemaAndName);
}

function v4FunctionBody(schemaAndName: string): string {
  return functionBodyIn(V4_CODE, schemaAndName);
}

function readSqlTextArray(body: string, name: string): string[] {
  const match = body.match(new RegExp(`${name}\\s+constant\\s+text\\[\\]\\s*:=\\s*array\\[([\\s\\S]*?)\\]`));
  assert.ok(match, `${name} 목록을 찾지 못했습니다.`);
  return match![1]
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => {
      assert.match(item, /^'[^']*'$/, `${name}의 값이 문자열이 아닙니다: ${item}`);
      return item.slice(1, -1);
    });
}

function readSqlConstant(body: string, name: string, type: 'integer' | 'text'): string {
  const match = body.match(new RegExp(`${name}\\s+constant\\s+${type}\\s*:=\\s*([^;]+);`));
  assert.ok(match, `${name} 값을 찾지 못했습니다.`);
  return match![1].trim();
}

/** check (x in ('a', 'b')) 목록 하나를 읽는다. */
function readCheckInList(constraintName: string, column: string): string[] {
  const start = CODE.indexOf(`constraint ${constraintName}`);
  assert.notEqual(start, -1, `${constraintName}를 찾지 못했습니다.`);
  const match = CODE.slice(start).match(new RegExp(`${column} in \\(([\\s\\S]*?)\\)\\)`));
  assert.ok(match, `${constraintName}의 목록을 찾지 못했습니다.`);
  return [...match![1].matchAll(/'([^']+)'/g)].map((item) => item[1]);
}

const PUBLIC_RPCS = [...AUTOMATIC_CATALOG_RPCS];
const TABLES = Object.values(AUTOMATIC_CATALOG_TABLES);
const DEMAND_COUNTER_TABLES: readonly string[] = [
  AUTOMATIC_CATALOG_TABLES.weakMatchDemand,
  AUTOMATIC_CATALOG_TABLES.themeDemand,
];
const APPEND_ONLY_TABLES = TABLES.filter(
  (table) => table !== AUTOMATIC_CATALOG_TABLES.activePointer && !DEMAND_COUNTER_TABLES.includes(table),
);

/* ================================================================== */
/* A. SQL 사본이 계약과 같은가                                          */
/* ================================================================== */

describe('자동 카탈로그 migration · A. SQL 사본이 계약과 같은가', () => {
  const activation = functionBody(`public.${ACTIVATE_SCRIPTURE_CATALOG_CANDIDATE_RPC}`);
  const rollback = functionBody(`public.${ROLLBACK_SCRIPTURE_CATALOG_VERSION_RPC}`);
  const storeCandidate = functionBody(`public.${STORE_SCRIPTURE_CATALOG_CANDIDATE_RPC}`);

  it('필수 검증 항목이 이름도 차례도 같다', () => {
    assert.deepEqual(readSqlTextArray(activation, 'v_required_checks'), [...REQUIRED_VALIDATION_CHECKS]);
  });

  it('활성화 기준값이 같다', () => {
    assert.equal(Number(readSqlConstant(activation, 'v_min_independent_evaluations', 'integer')), MIN_INDEPENDENT_EVALUATIONS);
    assert.equal(Number(readSqlConstant(activation, 'v_min_demand_occurrences', 'integer')), MIN_DEMAND_OCCURRENCES);
    assert.equal(Number(readSqlConstant(activation, 'v_min_demand_active_days', 'integer')), MIN_DEMAND_ACTIVE_DAYS);
    assert.equal(Number(readSqlConstant(activation, 'v_min_generation_cases_per_card', 'integer')), MIN_GENERATION_CASES_PER_CARD);
    assert.equal(readSqlConstant(activation, 'v_bible_source_sha256', 'text'), `'${SOURCE_SHA256}'`);
  });

  it('후보 종류가 함수와 표 조건 모두에서 같다', () => {
    assert.deepEqual(readSqlTextArray(storeCandidate, 'v_candidate_kinds'), [...CANDIDATE_KINDS]);
    assert.deepEqual(readCheckInList('scripture_catalog_candidate_kind_allowed', 'candidate_kind'), [...CANDIDATE_KINDS]);
  });

  it('롤백 사유가 함수와 표 조건 모두에서 같다', () => {
    assert.deepEqual(readSqlTextArray(rollback, 'v_rollback_reason_codes'), [...ROLLBACK_REASON_CODES]);
    assert.deepEqual(readCheckInList('scripture_catalog_rollback_reason_allowed', 'reason_code'), [...ROLLBACK_REASON_CODES]);
  });

  it('공지 종류가 같다', () => {
    assert.deepEqual(
      readCheckInList('scripture_catalog_owner_notification_kind_allowed', 'notification_kind'),
      [...OWNER_NOTIFICATION_KINDS],
    );
  });

  it('지문·요청 번호 모양이 같다', () => {
    for (const format of [
      CATALOG_VERSION_HASH_FORMAT,
      CATALOG_CANDIDATE_HASH_FORMAT,
      VALIDATION_HASH_FORMAT,
      ARTIFACT_HASH_FORMAT,
      THEME_FINGERPRINT_FORMAT,
      VALIDATOR_PROFILE_HASH_FORMAT,
      VALIDATOR_REGISTRY_HASH_FORMAT,
      ATTESTATION_HASH_FORMAT,
      REQUEST_ID_FORMAT,
    ]) {
      assert.ok(CODE.includes(`'${format.source}'`), `SQL에 ${format.source}가 없습니다.`);
    }
    // 계약에 없는 다른 지문 모양을 쓰지 않는다.
    const used = new Set([...CODE.matchAll(/'\^(s[a-z]+)_\[0-9a-f\]\{(\d+)\}\$'/g)].map((item) => `${item[1]}:${item[2]}`));
    assert.deepEqual(
      [...used].sort(),
      ['sart:64', 'satt:64', 'scat:64', 'sccand:64', 'screq:32', 'scval:64', 'sthm:64', 'svp:64', 'svreg:64'],
    );
  });

  it('계약 버전과 authority 문자열이 같다', () => {
    // VALIDATION_CONTRACT_VERSION(v3)은 기준 migration이 아니라 v3 업그레이드 migration에 있다(§E).
    // 기준 migration은 손대지 않았으므로 여전히 옛 v2 문자열을 담고 있다 — 그것은 죽은 역사 기록이고
    // 실제로 강제되는 값은 v3 migration의 ALTER 제약·CREATE OR REPLACE 함수다.
    for (const value of [CATALOG_CONTRACT_VERSION, CANDIDATE_CONTRACT_VERSION]) {
      assert.ok(CODE.includes(`'${value}'`), value);
    }
    assert.ok(CODE.includes(`validation ->> 'validationAuthority' = '${AUTOMATED_VALIDATION_AUTHORITY}'`));
    assert.ok(CODE.includes(`check (authority = '${AUTOMATED_VALIDATION_AUTHORITY}')`));
    assert.equal((CODE.match(new RegExp(`check \\(authority = '${AUTOMATED_OPERATIONS_AUTHORITY}'\\)`, 'g')) ?? []).length, 2);
  });

  it('SQL에 적힌 필수 항목 목록을 실제 반복 검사에 쓴다', () => {
    assert.ok(activation.includes('foreach v_check_name in array v_required_checks loop'));
    assert.ok(activation.includes("array_length(v_required_checks, 1)"));
  });
});

/* ================================================================== */
/* B. 표와 함수 권한                                                   */
/* ================================================================== */

describe('자동 카탈로그 migration · B. 표와 함수 권한', () => {
  it('계약의 표 이름과 SQL이 만든 표가 정확히 같다', () => {
    const created = [...CODE.matchAll(/^create table private\.([a-z_]+) \(/gm)].map((item) => item[1]);
    assert.deepEqual(created.sort(), [...TABLES].sort());
    assert.equal(/create table if not exists/.test(CODE), false, '예상 못 한 같은 이름의 표를 조용히 넘기면 안 됩니다.');
  });

  it('모든 표가 RLS를 켜고 모든 역할에서 권한을 거둔다', () => {
    for (const table of TABLES) {
      assert.ok(CODE.includes(`alter table private.${table} enable row level security;`), table);
      assert.ok(CODE.includes(`revoke all on table private.${table} from public;`), table);
      assert.ok(CODE.includes(`revoke all on table private.${table} from anon, authenticated, service_role;`), table);
    }
    assert.equal(/grant\s+[a-z, ]+\s+on\s+table/i.test(CODE), false, '표에 직접 권한을 주면 안 됩니다.');
    assert.equal(/create policy/i.test(CODE), false, '정책을 만들면 표가 열립니다.');
  });

  it('수요 카운터와 포인터를 뺀 모든 표가 고치기·지우기·비우기를 거절한다', () => {
    for (const table of APPEND_ONLY_TABLES) {
      assert.match(
        CODE,
        new RegExp(`before update or delete on private\\.${table}\\s+for each statement execute function private\\.reject_scripture_catalog_mutation\\(\\);`),
        table,
      );
      assert.match(
        CODE,
        new RegExp(`before truncate on private\\.${table}\\s+for each statement execute function private\\.reject_scripture_catalog_mutation\\(\\);`),
        table,
      );
    }
  });

  it('수요 카운터는 같은 키의 횟수만 1씩 늘릴 수 있고 지우기·비우기는 거절한다', () => {
    const guard = functionBody('private.guard_scripture_demand_counter_update');
    assert.ok(guard.includes('new.match_count <> old.match_count + 1'));
    assert.ok(guard.includes('new.theme_count <> old.theme_count + 1'));
    assert.ok(guard.includes('new.bucket_date is distinct from old.bucket_date'));
    for (const table of DEMAND_COUNTER_TABLES) {
      assert.match(
        CODE,
        new RegExp(`before update on private\\.${table}\\s+for each row execute function private\\.guard_scripture_demand_counter_update\\(\\);`),
        table,
      );
      assert.match(
        CODE,
        new RegExp(`before delete on private\\.${table}\\s+for each statement execute function private\\.reject_scripture_catalog_mutation\\(\\);`),
        table,
      );
      assert.match(
        CODE,
        new RegExp(`before truncate on private\\.${table}\\s+for each statement execute function private\\.reject_scripture_catalog_mutation\\(\\);`),
        table,
      );
    }
  });

  it('포인터는 지우기·비우기를 거절하고, 한 단계씩만 바뀌고, 커밋 순간에 기록과 공지를 요구한다', () => {
    const pointer = AUTOMATIC_CATALOG_TABLES.activePointer;
    assert.match(CODE, new RegExp(`before delete on private\\.${pointer}\\s+for each statement execute function private\\.reject_scripture_catalog_mutation`));
    assert.match(CODE, new RegExp(`before truncate on private\\.${pointer}\\s+for each statement execute function private\\.reject_scripture_catalog_mutation`));
    assert.match(CODE, new RegExp(`before update on private\\.${pointer}\\s+for each row execute function private\\.guard_scripture_catalog_pointer_update`));

    const guard = functionBody('private.guard_scripture_catalog_pointer_update');
    assert.ok(guard.includes('new.pointer_revision <> old.pointer_revision + 1'));
    assert.ok(guard.includes('new.active_version_hash = old.active_version_hash'));

    assert.match(
      CODE,
      new RegExp(
        `create constraint trigger scripture_catalog_active_pointer_transition\\s+after insert or update on private\\.${pointer}\\s+deferrable initially deferred`,
      ),
    );
    const transition = functionBody('private.check_scripture_catalog_pointer_transition');
    for (const table of ['scripture_catalog_owner_notification', 'scripture_catalog_baseline', 'scripture_catalog_activation', 'scripture_catalog_rollback']) {
      assert.ok(transition.includes(`private.${table}`), `${table}를 확인하지 않습니다.`);
    }
  });

  // 실제 PostgreSQL 17.6에서 잡힌 결함이다. 이 트리거는 지연이라 RPC가 끝난 뒤
  // 커밋 시점에 돈다. 그때는 SECURITY DEFINER 함수 밖이라 호출자(service_role) 권한이
  // 쓰이는데, service_role에는 private 스키마 권한이 없어 확인 자체가 막히고
  // 기준 등록·활성화·롤백 전체가 'permission denied for schema private'로 되돌아갔다.
  it('커밋 시점 포인터 전환 확인은 SECURITY DEFINER다(지연 실행이라 호출자 권한으로는 막힌다)', () => {
    const name = 'check_scripture_catalog_pointer_transition';
    const transition = functionBody(`private.${name}`);

    assert.ok(
      transition.includes('security definer'),
      '지연 트리거 함수가 SECURITY INVOKER면 service_role 호출이 커밋에서 전부 롤백된다.',
    );
    assert.ok(transition.includes('set search_path = private, pg_catalog'), 'search_path가 고정되어야 합니다.');

    // 권한을 넓혀 막은 것이 아니다. 실행 권한은 여전히 아무에게도 없다.
    assert.match(CODE, new RegExp(`revoke all on function private\\.${name}\\(\\) from public;`));
    assert.match(CODE, new RegExp(`revoke all on function private\\.${name}\\(\\) from anon, authenticated, service_role;`));
    assert.equal(new RegExp(`grant execute on function private\\.${name}`).test(CODE), false, '아무에게도 열지 않습니다.');

    // 지연 계약은 그대로여야 한다. 즉시 실행으로 바꾸면 한 트랜잭션 원자성이 깨진다.
    assert.match(
      CODE,
      new RegExp(
        `create constraint trigger scripture_catalog_active_pointer_transition\\s+after insert or update on private\\.${AUTOMATIC_CATALOG_TABLES.activePointer}\\s+deferrable initially deferred\\s+for each row execute function private\\.${name}\\(\\);`,
      ),
      'deferrable initially deferred 계약이 유지되어야 합니다.',
    );

    // 필요한 함수 하나만 definer다. 나머지 private 도구 함수까지 넓히지 않는다.
    for (const other of [
      'check_scripture_catalog_attestation_link',
      'guard_scripture_catalog_pointer_update',
      'guard_scripture_demand_counter_update',
      'reject_scripture_catalog_mutation',
    ]) {
      assert.equal(
        functionBody(`private.${other}`).includes('security definer'),
        false,
        `${other}는 SECURITY DEFINER 함수 안에서 바로 돌기 때문에 definer가 필요 없습니다.`,
      );
    }
  });

  it('계약의 RPC 이름과 SQL의 public 함수가 정확히 같다', () => {
    const created = [...CODE.matchAll(/^create function public\.([a-z_]+)\(/gm)].map((item) => item[1]);
    assert.deepEqual(created.sort(), [...PUBLIC_RPCS].sort());
    assert.equal(/create or replace function/.test(CODE), false, '같은 이름의 함수를 조용히 덮으면 안 됩니다.');
  });

  it('public 함수는 SECURITY DEFINER, search_path 고정, 모든 역할 회수 뒤 service_role에만 열린다', () => {
    for (const rpc of PUBLIC_RPCS) {
      const body = functionBody(`public.${rpc}`);
      assert.ok(body.includes('security definer'), `${rpc}: security definer`);
      assert.ok(body.includes('set search_path = private, pg_catalog'), `${rpc}: search_path`);

      const signature = body.match(new RegExp(`create function public\\.${rpc}\\(([\\s\\S]*?)\\)\\s*returns`))![1];
      const types = signature
        .split(',')
        .map((param) => param.trim().split(/\s+/)[1])
        .join(', ');
      const qualified = `public.${rpc}(${types})`;
      assert.ok(CODE.includes(`revoke all on function ${qualified} from public;`), `${rpc}: public 회수`);
      assert.match(CODE, new RegExp(`revoke all on function ${qualified.replace(/[().]/g, '\\$&')}\\s+from anon, authenticated, service_role;`), `${rpc}: 역할 회수`);
      assert.ok(CODE.includes(`grant execute on function ${qualified} to service_role;`), `${rpc}: service_role 허용`);
    }
    const grants = [...CODE.matchAll(/grant execute on function [^;]+ to ([a-z_, ]+);/g)].map((item) => item[1].trim());
    assert.deepEqual(grants, PUBLIC_RPCS.map(() => 'service_role'), 'service_role 말고 다른 역할에 열린 함수가 있습니다.');
  });

  it('입력은 모든 public 함수에서 모양부터 검사한다', () => {
    for (const rpc of PUBLIC_RPCS) {
      const body = functionBody(`public.${rpc}`);
      assert.ok(body.includes("using errcode = 'invalid_parameter_value'"), `${rpc}: 입력 검사`);
    }
  });

  it('private 도구 함수도 모든 역할에서 실행 권한을 거두고 아무에게도 열지 않는다', () => {
    const privateFunctions = [...CODE.matchAll(/^create function private\.([a-z_0-9]+)\(/gm)].map((item) => item[1]);
    assert.deepEqual(privateFunctions.sort(), [
      'check_scripture_catalog_attestation_link',
      'check_scripture_catalog_pointer_transition',
      'guard_scripture_catalog_pointer_update',
      'guard_scripture_demand_counter_update',
      'reject_scripture_catalog_mutation',
    ]);
    for (const name of privateFunctions) {
      assert.match(CODE, new RegExp(`revoke all on function private\\.${name}\\([^)]*\\) from public;`), name);
      assert.match(CODE, new RegExp(`revoke all on function private\\.${name}\\([^)]*\\) from anon, authenticated, service_role;`), name);
      assert.equal(new RegExp(`grant execute on function private\\.${name}`).test(CODE), false, name);
      assert.ok(functionBody(`private.${name}`).includes('set search_path ='), `${name}: search_path`);
    }
  });

  it('동적 SQL을 쓰지 않는다', () => {
    assert.equal(/\bexecute\s+(format|'|\$|v_)/i.test(CODE), false);
  });

  /**
   * 독립성의 뿌리다. validator profile을 스스로 등록할 수 있으면, 실행기가 자기 자신을
   * "서로 다른 독립 평가자"로 만들어 attestation을 찍을 수 있다.
   * 그래서 이 migration에는 profile을 넣는 길이 아예 없어야 한다(검토된 다음 migration으로만 등록).
   */
  it('validator profile을 스스로 등록하는 길이 없다', () => {
    assert.equal(
      CODE.includes(`insert into private.${AUTOMATIC_CATALOG_TABLES.validatorProfile}`),
      false,
      'validator profile을 넣는 코드가 있습니다.',
    );
    for (const rpc of PUBLIC_RPCS) {
      assert.equal(
        functionBody(`public.${rpc}`).includes(AUTOMATIC_CATALOG_TABLES.validatorProfile.concat(' (')),
        false,
        `${rpc}가 validator profile을 넣습니다.`,
      );
    }
  });

  /**
   * 수요 조작의 상한이다. 집계 칸의 날짜를 요청에서 받으면 과거를 지어내 하루 만에
   * "7일 이상 발생"을 만들 수 있다. 날짜는 항상 서울 기준 오늘이어야 한다.
   */
  it('수요 기록 함수는 날짜를 받지 않고 서울 기준 오늘로만 센다', () => {
    for (const rpc of [RECORD_SCRIPTURE_DEMAND_WEAK_MATCH_RPC, RECORD_SCRIPTURE_DEMAND_THEME_RPC]) {
      const body = functionBody(`public.${rpc}`);
      const signature = body.match(new RegExp(`create function public\\.${rpc}\\(([\\s\\S]*?)\\)\\s*returns`))![1];
      assert.equal(signature.split(',').length, 1, `${rpc}: 값을 하나만 받아야 합니다.`);
      assert.equal(/date|timestamp/i.test(signature), false, `${rpc}: 날짜를 받으면 안 됩니다.`);
      assert.ok(body.includes("(now() at time zone 'Asia/Seoul')::date"), `${rpc}: 서울 기준 오늘을 쓰지 않습니다.`);
      assert.ok(/match_count \+ 1|theme_count \+ 1/.test(body), `${rpc}: 1씩만 늘려야 합니다.`);
    }
  });
});

/* ================================================================== */
/* C. fail-closed · 멱등 · 원자성                                      */
/* ================================================================== */

describe('자동 카탈로그 migration · C. 활성화와 롤백 규칙', () => {
  const activation = functionBody(`public.${ACTIVATE_SCRIPTURE_CATALOG_CANDIDATE_RPC}`);
  const rollback = functionBody(`public.${ROLLBACK_SCRIPTURE_CATALOG_VERSION_RPC}`);
  const baseline = functionBody(`public.${REGISTER_SCRIPTURE_CATALOG_BASELINE_RPC}`);
  const storeCandidate = functionBody(`public.${STORE_SCRIPTURE_CATALOG_CANDIDATE_RPC}`);
  const storeValidation = functionBody(`public.${STORE_SCRIPTURE_CATALOG_VALIDATION_RPC}`);

  it('어느 함수도 예외를 삼키지 않는다(실패가 곧 전체 되돌림이어야 한다)', () => {
    assert.equal(/\bexception\s+when\b/i.test(CODE), false);
    assert.equal(/\b(commit|rollback)\s*;/i.test(CODE), false);
  });

  it('활성화는 검증 결과를 요청에서 받지 않는다', () => {
    const signature = activation.match(/create function public\.[a-z_]+\(([\s\S]*?)\)\s*returns/)![1];
    assert.equal(signature.includes('jsonb'), false);
  });

  it('활성화는 멱등 재실행을 먼저 가리고, 포인터를 잠근 뒤 기대 버전과 기준 버전을 대조한다', () => {
    const replay = activation.indexOf('where request_id = p_request_id');
    const lock = activation.indexOf('where singleton for update');
    const stale = activation.indexOf('v_pointer.active_version_hash <> p_expected_active_version_hash');
    const baseMatch = activation.indexOf('v_candidate.base_version_hash <> v_pointer.active_version_hash');
    assert.ok(replay > -1 && lock > replay && stale > lock && baseMatch > stale);
    assert.ok(activation.includes("using errcode = 'serialization_failure'"));
  });

  it('활성화는 적혀 있는 검증 기록을 다시 확인한다', () => {
    for (const fragment of [
      "v_validation ->> 'validationAuthority' is distinct from 'automated_validation'",
      "v_validation ->> 'overallStatus' is distinct from 'pass'",
      "v_validation ->> 'baseVersionHash' is distinct from v_candidate.base_version_hash",
      "v_validation ->> 'proposedVersionHash' is distinct from v_candidate.proposed_version_hash",
      "v_checks -> v_check_name ->> 'status' is distinct from 'pass'",
      'from private.scripture_catalog_validation_attestation a',
      'join private.scripture_catalog_validator_profile vp on vp.profile_hash = a.profile_hash',
      // 등록만으로는 부족하다. 그 profile이 이 항목을 판정할 권한이 있어야 한다.
      'vp.authorized_checks @> array[v_check_name]',
      'count(distinct vp.independence_group)',
      'v_group_count < v_min_independent_evaluations',
      // 적어 낸 수요를 믿지 않고 집계 표에서 다시 만들어 글자 그대로 대조한다.
      'from generate_series(v_window_start::timestamp, v_window_end::timestamp',
      "v_demand -> 'dailyCounts' is distinct from v_expected_daily",
      'v_demand_total < v_min_demand_occurrences',
      'v_demand_active_days < v_min_demand_active_days',
      "v_checks #> '{safetyBoundary,payload,cases}'",
      "v_checks #> '{duplicateCheck,payload,overlaps}' is distinct from '[]'::jsonb",
      "v_checks #> '{corpusRegression,payload,cases}'",
      ') < v_min_generation_cases_per_card',
    ]) {
      assert.ok(activation.includes(fragment), `활성화 확인이 빠졌습니다: ${fragment}`);
    }
  });

  it('활성화·공지·포인터 전환이 한 함수 안에 함께 있고, 같은 후보·버전의 중복 활성화를 막는다', () => {
    const insertActivation = activation.indexOf('insert into private.scripture_catalog_activation');
    const insertNotice = activation.indexOf('insert into private.scripture_catalog_owner_notification');
    const updatePointer = activation.indexOf('update private.scripture_catalog_active_pointer');
    assert.ok(insertActivation > -1 && insertNotice > insertActivation && updatePointer > insertNotice);
    assert.ok(activation.includes("'catalog_activated'"));
    assert.match(CODE, /candidate_hash text not null unique\s+references private\.scripture_catalog_candidate/);
    assert.match(CODE, /to_version_hash text not null unique\s+references private\.scripture_catalog_version/);
    assert.match(CODE, /foreign key \(validation_hash, candidate_hash\)\s+references private\.scripture_catalog_validation \(validation_hash, candidate_hash\)/);
  });

  it('요청 번호는 등록·활성화·롤백 표에서 모두 유일하다', () => {
    assert.equal((CODE.match(/request_id text not null unique,/g) ?? []).length, 3);
  });

  it('롤백은 이전에 활성이었던 조상 버전으로만, 기록·공지·포인터를 함께 남긴다', () => {
    assert.ok(rollback.includes('with recursive ancestors'));
    for (const table of ['scripture_catalog_baseline', 'scripture_catalog_activation', 'scripture_catalog_rollback']) {
      assert.ok(rollback.includes(`select 1 from private.${table} where`), `${table} 활성 이력을 보지 않습니다.`);
    }
    assert.ok(rollback.includes('p_target_version_hash = v_pointer.active_version_hash'));
    assert.ok(rollback.includes('where request_id = p_request_id'));
    assert.ok(rollback.includes('where singleton for update'));
    const insertRollback = rollback.indexOf('insert into private.scripture_catalog_rollback');
    const insertNotice = rollback.indexOf('insert into private.scripture_catalog_owner_notification');
    const updatePointer = rollback.indexOf('update private.scripture_catalog_active_pointer');
    assert.ok(insertRollback > -1 && insertNotice > insertRollback && updatePointer > insertNotice);
    assert.ok(rollback.includes("'catalog_rolled_back'"));
  });

  it('기준 등록은 한 번뿐이고, 공지와 포인터를 함께 만든다', () => {
    assert.match(CODE, /singleton boolean not null default true unique,/);
    assert.ok(baseline.includes('기준 카탈로그는 이미 등록됐습니다.'));
    assert.ok(baseline.includes('insert into private.scripture_catalog_owner_notification'));
    assert.ok(baseline.includes('insert into private.scripture_catalog_active_pointer'));
  });

  it('후보 보관은 결과 카탈로그가 정확히 기준+후보인지 구조로 다시 만들어 대조한다', () => {
    assert.ok(storeCandidate.includes("jsonb_array_elements(v_base_catalog -> 'cards')"));
    assert.ok(storeCandidate.includes("jsonb_array_elements(p_candidate -> 'cards')"));
    assert.ok(storeCandidate.includes("order by item ->> 'id' collate \"C\""));
    assert.ok(storeCandidate.includes('if p_proposed_catalog <> jsonb_build_object('));
    assert.ok(storeCandidate.includes('같은 지문으로 다른 후보가 들어왔습니다.'));
  });

  it('검증 기록 보관은 후보와 이어지지 않으면 거절하고, 활성화 여부를 정하지 않는다', () => {
    assert.ok(storeValidation.includes("p_validation ->> 'baseVersionHash' is distinct from v_candidate.base_version_hash"));
    assert.equal(storeValidation.includes('scripture_catalog_active_pointer'), false);
  });
});

/* ================================================================== */
/* D. 사람 검토 경계 · 개인정보 · 외부 발송                              */
/* ================================================================== */

describe('자동 카탈로그 migration · D. 경계와 개인정보', () => {
  it('사람 검토 경계의 표·함수·authority를 건드리지 않는다', () => {
    const lower = CODE.toLowerCase();
    for (const banned of ['published_content', 'review_published', 'reviewer', "'human'", 'auth.uid', 'authenticated;']) {
      assert.equal(lower.includes(banned), false, `${banned}를 참조합니다.`);
    }
  });

  it('게시 콘텐츠 사람 검토 migration 두 개가 한 글자도 바뀌지 않았다', () => {
    const pinned: Record<string, string> = {
      '20260905163654_create_published_content_store.sql': '4a1e9c850a77a78cade8e57756b718d708286ef5008d3e36cc9a20eb40264634',
      '20260905235643_create_published_content_review_read_rpcs.sql': '4373eeebca7ac8850261e72b468f8ba4b43a3da4eb691748829f954839e36008',
    };
    for (const [name, hash] of Object.entries(pinned)) {
      const actual = createHash('sha256').update(readFileSync(path.join(MIGRATION_DIR, name))).digest('hex');
      assert.equal(actual, hash, `${name}이 바뀌었습니다.`);
      const human = readFileSync(path.join(MIGRATION_DIR, name), 'utf8');
      assert.equal(human.includes('scripture_catalog'), false, `${name}이 자동 카탈로그를 참조합니다.`);
    }
  });

  it('검토된 profile·v3·읽기 context·생성 증거 migration 외 다른 migration이 자동 카탈로그 함수·표를 다시 만들거나 권한을 주지 않는다', () => {
    const others = readdirSync(MIGRATION_DIR)
      .filter((name) => name.endsWith('.sql')
        && name !== MIGRATION_NAME && name !== PROFILE_MIGRATION_NAME && name !== V3_MIGRATION_NAME
        && name !== V4_MIGRATION_NAME
        && name !== VALIDATION_CONTEXT_MIGRATION_NAME && name !== GENERATION_EVIDENCE_MIGRATION_NAME
        && name !== RUNTIME_RPC_MIGRATION_NAME)
      .map((name) => readFileSync(path.join(MIGRATION_DIR, name), 'utf8'));
    for (const sql of others) {
      assert.equal(sql.includes('scripture_catalog'), false);
    }
  });

  it('개인정보·인증 값·모델 원본 응답을 담는 칸이 없다', () => {
    const lower = CODE.toLowerCase();
    for (const banned of ['user_id', 'session', 'device', 'ip_address', 'token', 'openai', 'raw_response', 'email', 'phone']) {
      assert.equal(lower.includes(banned), false, `${banned}가 있습니다.`);
    }
  });

  it('외부로 보내는 호출이 없다(공지는 적어 두기만 한다)', () => {
    const lower = CODE.toLowerCase();
    for (const banned of ['net.http', 'pg_net', 'http_post', 'pg_notify', 'notify ', 'dblink']) {
      assert.equal(lower.includes(banned), false, `${banned}가 있습니다.`);
    }
  });

  it('공지 기록에 받는 사람 주소가 없고 지문·사유 코드만 담는다', () => {
    const notices = [...CODE.matchAll(/jsonb_build_object\(\s*'kind'([\s\S]*?)\)\s*\);/g)].map((item) => item[0]);
    assert.equal(notices.length, 3);
    for (const notice of notices) {
      const keys = [...notice.matchAll(/'([A-Za-z]+)',/g)].map((item) => item[1]);
      assert.deepEqual(keys.sort(), ['candidateHash', 'fromVersionHash', 'kind', 'pointerRevision', 'reasonCode', 'toVersionHash']);
    }
  });
});

/* ================================================================== */
/* E. v2 → v3 업그레이드 (criterion 단위 신학 attestation)                */
/* ================================================================== */

describe('자동 카탈로그 migration · E. v2 → v3 업그레이드', () => {
  const v3Store = v3FunctionBody(`public.${STORE_SCRIPTURE_CATALOG_VALIDATION_RPC}`);
  const v3Activation = v3FunctionBody(`public.${ACTIVATE_SCRIPTURE_CATALOG_CANDIDATE_RPC}`);

  it('기준 migration·profile 등록 migration은 한 글자도 바뀌지 않았다', () => {
    const pinned: Record<string, string> = {
      [MIGRATION_NAME]: 'bbc8a8752d23cd0590c790f038a76ad7a9056a89e0bedd1586c87cd3e3ebcf53',
      [PROFILE_MIGRATION_NAME]: '2aecf108e0b96b48d2b624caefb3a7ab6fa0a25839b856288c10dd770541721b',
    };
    for (const [name, hash] of Object.entries(pinned)) {
      const actual = createHash('sha256').update(readFileSync(path.join(MIGRATION_DIR, name))).digest('hex');
      assert.equal(actual, hash, `${name}이 바뀌었습니다.`);
    }
  });

  it('profile 등록 migration은 여전히 profile 등록만 한다(함수·표를 새로 만들거나 다시 정의하지 않는다)', () => {
    const profileSql = readFileSync(path.join(MIGRATION_DIR, PROFILE_MIGRATION_NAME), 'utf8');
    assert.ok(profileSql.includes('insert into private.scripture_catalog_validator_profile'));
    for (const banned of ['create function', 'create or replace function', 'create table', 'alter table', 'grant ', 'revoke ']) {
      assert.equal(profileSql.toLowerCase().includes(banned), false, `profile 등록 migration에 ${banned}가 있습니다.`);
    }
  });

  it('v3 migration은 역사적 v3 문자열을 그대로 고정한다', () => {
    assert.equal(VALIDATION_CONTRACT_VERSION, 'automatic-scripture-catalog-validation/v4');
    assert.ok(V3_CODE.includes("'automatic-scripture-catalog-validation/v3'"));
    // 옛 v2 문자열을 v3 migration 안에서 실행 코드로 쓰지 않는다(주석 설명은 예외).
    assert.equal(V3_CODE.includes('automatic-scripture-catalog-validation/v2'), false);
  });

  it('v3 migration은 검증 표의 계약 버전 제약을 드롭하고 v3 제약으로 다시 만든다', () => {
    assert.ok(V3_CODE.includes('drop constraint scripture_catalog_validation_matches_candidate'));
    assert.match(
      V3_CODE,
      /add constraint scripture_catalog_validation_matches_candidate\s+check \(\s*jsonb_exists\(validation, 'contractVersion'\)\s*and validation ->> 'contractVersion' = 'automatic-scripture-catalog-validation\/v3'/,
    );
  });

  it('v3 migration은 검증 저장·활성화 두 함수만 create or replace로 다시 만든다(다른 함수·표는 없다)', () => {
    const createdOrReplaced = [...V3_CODE.matchAll(/^create (?:or replace )?function public\.([a-z_]+)\(/gm)].map((item) => item[1]);
    assert.deepEqual(createdOrReplaced.sort(), [ACTIVATE_SCRIPTURE_CATALOG_CANDIDATE_RPC, STORE_SCRIPTURE_CATALOG_VALIDATION_RPC].sort());
    assert.equal(/^create table/m.test(V3_CODE), false, 'v3 migration이 표를 새로 만들면 안 됩니다.');
    assert.equal(/^create function private\./m.test(V3_CODE), false, 'v3 migration이 private 도구 함수를 새로 만들면 안 됩니다.');
  });

  it('v3 검증 저장 RPC는 v3 계약 버전만 받고, 그 밖의 검사는 기준과 같다', () => {
    assert.ok(v3Store.includes("p_validation ->> 'contractVersion' is distinct from 'automatic-scripture-catalog-validation/v3'"));
    assert.equal(v3Store.includes('automatic-scripture-catalog-validation/v2'), false);
    // 필수 항목 목록은 기준과 같은 값을 그대로 옮겼다.
    assert.deepEqual(readSqlTextArray(v3Store, 'v_required_checks'), [...REQUIRED_VALIDATION_CHECKS]);
    assert.ok(v3Store.includes('security definer'));
    assert.ok(v3Store.includes('set search_path = private, pg_catalog'));
  });

  it('v3 활성화 RPC는 v3 계약 버전을 확인하고 criterion 아홉 개를 TS 계약과 같은 순서로 고정한다', () => {
    assert.ok(v3Activation.includes("v_validation ->> 'contractVersion' is distinct from 'automatic-scripture-catalog-validation/v3'"));
    assert.deepEqual(readSqlTextArray(v3Activation, 'v_required_criteria'), [...THEOLOGY_CRITERION_IDS]);
    assert.deepEqual(readSqlTextArray(v3Activation, 'v_required_checks'), [...REQUIRED_VALIDATION_CHECKS]);
    assert.ok(v3Activation.includes('security definer'));
    assert.ok(v3Activation.includes('set search_path = private, pg_catalog'));
  });

  it('신학 활성화 경로의 SQL 원문에 옛 cardVerdicts가 실행 코드로 남아 있지 않다(주석 제외)', () => {
    assert.equal(v3Activation.includes('cardVerdicts'), false);
    assert.equal(v3Store.includes('cardVerdicts'), false);
    // 파일 원문(주석 포함)에는 옛 계약을 설명하는 역사적 언급만 있고, 실행 코드에는 전혀 없다.
    assert.equal(V3_CODE.includes('cardVerdicts'), false);
  });

  it('v3 활성화 RPC는 evaluation·카드·criterion 세 층 모두에서 정확한 필드만 허용한다(exact-fields)', () => {
    assert.ok(v3Activation.includes("array['cardEvaluations', 'profileHash']"), 'evaluation 필드가 정확히 profileHash·cardEvaluations인지 확인하지 않습니다.');
    assert.ok(v3Activation.includes("array['cardId', 'criteria']"), '카드 필드가 정확히 cardId·criteria인지 확인하지 않습니다.');
    assert.ok(v3Activation.includes("array['criterionId', 'verdict']"), 'criterion 필드가 정확히 criterionId·verdict인지 확인하지 않습니다.');
  });

  it('v3 활성화 RPC는 카드 차례·criterion 차례를 후보·rubric과 정확히 대조한다', () => {
    assert.ok(v3Activation.includes('v_expected_card_ids'), '카드 차례를 후보에서 다시 만들지 않습니다.');
    assert.ok(v3Activation.includes("card ->> 'cardId' order by ord"), '카드 차례를 순서대로 뽑지 않습니다.');
    assert.ok(v3Activation.includes("entry ->> 'criterionId' is distinct from v_required_criteria[ord]"), 'criterion 차례를 자리별로 대조하지 않습니다.');
  });

  it('v3 함수 권한은 기준과 같다(회수 후 service_role에만 실행)', () => {
    for (const rpc of [STORE_SCRIPTURE_CATALOG_VALIDATION_RPC, ACTIVATE_SCRIPTURE_CATALOG_CANDIDATE_RPC]) {
      const qualified = rpc === STORE_SCRIPTURE_CATALOG_VALIDATION_RPC
        ? `public.${rpc}(text, text, jsonb, jsonb)`
        : `public.${rpc}(text, text, text, text)`;
      assert.ok(V3_CODE.includes(`revoke all on function ${qualified} from public;`), `${rpc}: public 회수`);
      assert.match(V3_CODE, new RegExp(`revoke all on function ${qualified.replace(/[().]/g, '\\$&')}\\s+from anon, authenticated, service_role;`), `${rpc}: 역할 회수`);
      assert.ok(V3_CODE.includes(`grant execute on function ${qualified} to service_role;`), `${rpc}: service_role 허용`);
    }
    const grants = [...V3_CODE.matchAll(/grant execute on function [^;]+ to ([a-z_, ]+);/g)].map((item) => item[1].trim());
    assert.deepEqual(grants, grants.map(() => 'service_role'), 'service_role 말고 다른 역할에 열린 함수가 있습니다.');
  });

  it('v3 migration도 예외를 삼키지 않고 동적 SQL을 쓰지 않는다', () => {
    assert.equal(/\bexception\s+when\b/i.test(V3_CODE), false);
    assert.equal(/\bexecute\s+(format|'|\$|v_)/i.test(V3_CODE), false);
  });
});

/* ================================================================== */
/* F. v3 → v4 업그레이드 (후보 생성 증거 결속)                           */
/* ================================================================== */

describe('자동 카탈로그 migration · F. v3 → v4 증거 결속', () => {
  const v4Store = v4FunctionBody(`public.${STORE_SCRIPTURE_CATALOG_VALIDATION_RPC}`);
  const v4Activation = v4FunctionBody(`public.${ACTIVATE_SCRIPTURE_CATALOG_CANDIDATE_RPC}`);

  it('현재 TS 계약과 v4 저장·활성화 함수가 같은 버전을 쓴다', () => {
    assert.equal(VALIDATION_CONTRACT_VERSION, 'automatic-scripture-catalog-validation/v4');
    assert.ok(v4Store.includes(`p_validation ->> 'contractVersion' is distinct from '${VALIDATION_CONTRACT_VERSION}'`));
    assert.ok(v4Activation.includes(`v_validation ->> 'contractVersion' is distinct from '${VALIDATION_CONTRACT_VERSION}'`));
  });

  it('기존 v3 행은 null 증거 연결로 보존하지만 v4 행은 payload와 같은 지문을 반드시 저장한다', () => {
    assert.ok(V4_CODE.includes('add column candidate_generation_evidence_artifact_hash text'));
    assert.ok(V4_CODE.includes("validation ->> 'contractVersion' = 'automatic-scripture-catalog-validation/v3'"));
    assert.ok(V4_CODE.includes("validation ->> 'contractVersion' = 'automatic-scripture-catalog-validation/v4'"));
    assert.ok(V4_CODE.includes("validation #>> '{checks,candidateGenerationEvaluation,payload,evidenceArtifactHash}'"));
  });

  it('검증 행은 정확한 (증거 지문, 후보 지문) 복합 외래 키로 증거 보관소에 이어진다', () => {
    assert.match(
      V4_CODE,
      /foreign key \(candidate_generation_evidence_artifact_hash, candidate_hash\)\s+references private\.scripture_catalog_candidate_generation_evidence \(artifact_hash, candidate_hash\)\s+on delete restrict/,
    );
  });

  it('저장과 활성화가 증거 행을 후보와 함께 다시 읽고 사례 id·카드 id의 순서까지 대조한다', () => {
    for (const body of [v4Store, v4Activation]) {
      assert.ok(body.includes('from private.scripture_catalog_candidate_generation_evidence'));
      assert.ok(body.includes('artifact_hash = v_evidence_hash'));
      assert.ok(body.includes('candidate_hash = p_candidate_hash'));
      assert.ok(body.includes("jsonb_build_object('caseId', item ->> 'caseId', 'cardId', item ->> 'cardId')"));
      assert.ok(body.includes('v_validation_case_projection is distinct from v_evidence_case_projection'));
    }
  });

  it('v4 함수는 고정 search_path·권한 회수·service_role 실행만 유지한다', () => {
    for (const rpc of [STORE_SCRIPTURE_CATALOG_VALIDATION_RPC, ACTIVATE_SCRIPTURE_CATALOG_CANDIDATE_RPC]) {
      const body = rpc === STORE_SCRIPTURE_CATALOG_VALIDATION_RPC ? v4Store : v4Activation;
      const qualified = rpc === STORE_SCRIPTURE_CATALOG_VALIDATION_RPC
        ? `public.${rpc}(text, text, jsonb, jsonb)`
        : `public.${rpc}(text, text, text, text)`;
      assert.ok(body.includes('security definer'));
      assert.ok(body.includes('set search_path = private, pg_catalog'));
      assert.ok(V4_CODE.includes(`revoke all on function ${qualified} from public;`));
      assert.ok(V4_CODE.includes(`grant execute on function ${qualified} to service_role;`));
    }
    assert.equal(/\bexception\s+when\b/i.test(V4_CODE), false);
    assert.equal(/\bexecute\s+(format|'|\$|v_)/i.test(V4_CODE), false);
  });
});
