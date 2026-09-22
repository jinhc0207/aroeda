/**
 * 후보 생성 증거 보관 migration 계약 테스트.
 *
 * 이 테스트는 SQL이 무엇을 약속하는지만 본다. 실제 PostgreSQL 동작(권한·방아쇠·멱등성)은
 * 깨끗한 컨테이너에 모든 migration을 순서대로 적용해 따로 확인한다.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import {
  CANDIDATE_GENERATION_EVIDENCE_CONTRACT_VERSION,
} from '../../supabase/functions/_shared/automatic-scripture-catalog-candidate-generation-evidence.ts';
import {
  ARTIFACT_HASH_FORMAT,
  CATALOG_CANDIDATE_HASH_FORMAT,
} from '../../supabase/functions/_shared/automatic-scripture-catalog-contract.ts';

const SQL = readFileSync(
  new URL(
    '../../supabase/migrations/20260922144425_create_scripture_catalog_candidate_generation_evidence_store.sql',
    import.meta.url,
  ),
  'utf8',
);
const CODE = SQL.split('\n').filter((line) => !/^\s*--/.test(line)).join('\n');
/** 줄바꿈·들여쓰기를 한 칸으로 눌러 놓은 사본. 긴 조건문을 그대로 대조할 때 쓴다. */
const FLAT = CODE.replace(/\s+/g, ' ');

const TABLE = 'private.scripture_catalog_candidate_generation_evidence';
const RPC = 'public.store_scripture_catalog_candidate_generation_evidence';
const SIGNATURE = `${RPC}(text, text, jsonb)`;

/** SQL 정규식 리터럴은 JS 정규식의 source와 같은 문자열이어야 한다. */
const sqlPattern = (format: RegExp) => format.source;

describe('후보 생성 증거 보관 migration · 표', () => {
  it('표 하나·색인 하나·방아쇠 둘·함수 하나만 만든다', () => {
    const tables = [...CODE.matchAll(/^create table ([^\s(]+)/gm)].map((m) => m[1]);
    const functions = [...CODE.matchAll(/^create (?:or replace )?function ([^(]+)\(/gm)].map((m) => m[1]);
    const indexes = [...CODE.matchAll(/^create index ([^\s]+)/gm)].map((m) => m[1]);
    const triggers = [...CODE.matchAll(/^create trigger ([^\s]+)/gm)].map((m) => m[1]);
    assert.deepEqual(tables, [TABLE]);
    assert.deepEqual(functions, [RPC]);
    assert.equal(indexes.length, 1);
    assert.equal(triggers.length, 2);
  });

  it('기존 표·함수·활성화 구조를 고치지 않는다', () => {
    for (const banned of [
      'create or replace function',
      'drop table',
      'drop function',
      'drop trigger',
      'alter function',
      'create policy',
    ]) {
      assert.equal(CODE.toLowerCase().includes(banned), false, banned);
    }
    // 기존 catalog 표를 바꾸는 alter는 없다. 신규 표에 대한 RLS alter만 허용된다.
    const alters = [...CODE.matchAll(/^alter table ([^\s]+)/gm)].map((m) => m[1]);
    assert.deepEqual([...new Set(alters)], [TABLE]);
  });

  it('후보를 외래 키로 참조하고 삭제를 막는다', () => {
    assert.ok(CODE.includes('references private.scripture_catalog_candidate (candidate_hash)'));
    assert.ok(CODE.includes('on delete restrict'));
  });

  it('artifactHash·candidateHash 형식을 TypeScript 계약과 같은 정규식으로 검사한다', () => {
    assert.ok(CODE.includes(`check (artifact_hash ~ '${sqlPattern(ARTIFACT_HASH_FORMAT)}')`));
    assert.ok(CODE.includes(`check (candidate_hash ~ '${sqlPattern(CATALOG_CANDIDATE_HASH_FORMAT)}')`));
  });

  it('JSON의 contractVersion·candidateHash·artifactHash가 열 값과 같아야 한다', () => {
    assert.ok(CODE.includes(`evidence ->> 'contractVersion' = '${CANDIDATE_GENERATION_EVIDENCE_CONTRACT_VERSION}'`));
    assert.ok(CODE.includes("evidence ->> 'candidateHash' = candidate_hash"));
    assert.ok(CODE.includes("evidence ->> 'artifactHash' = artifact_hash"));
    assert.ok(CODE.includes("jsonb_typeof(evidence) = 'object'"));
  });

  it('후보 1 : 증거 N — candidateHash에는 unique를 걸지 않는다', () => {
    assert.equal(CODE.includes('unique (candidate_hash)'), false);
    assert.ok(CODE.includes('artifact_hash text primary key'));
    // 다음 단계가 (증거, 후보) 짝을 외래 키로 결속할 수 있어야 한다.
    assert.ok(CODE.includes('unique (artifact_hash, candidate_hash)'));
  });

  it('기존 append-only 방아쇠를 재사용해 update·delete·truncate를 막는다', () => {
    assert.ok(CODE.includes('before update or delete on ' + TABLE));
    assert.ok(CODE.includes('before truncate on ' + TABLE));
    assert.equal((CODE.match(/private\.reject_scripture_catalog_mutation\(\)/g) ?? []).length, 2);
  });

  it('RLS를 켜고 모든 역할의 표 권한을 회수한다', () => {
    assert.ok(CODE.includes(`alter table ${TABLE} enable row level security`));
    assert.ok(CODE.includes(`revoke all on table ${TABLE} from public`));
    assert.ok(CODE.includes('from anon, authenticated, service_role'));
    // 표 권한을 다시 주는 grant는 없다.
    assert.equal(/grant[^;]*on table/i.test(CODE), false);
  });
});

describe('후보 생성 증거 보관 migration · 저장 RPC', () => {
  it('security definer이며 search_path를 고정한다', () => {
    assert.ok(CODE.includes('language plpgsql\nsecurity definer\nset search_path = private, pg_catalog'));
  });

  it('동적 SQL을 쓰지 않고 모든 객체를 스키마로 한정한다', () => {
    assert.equal(/\bexecute\s+(format|'|\$\$|v_)/i.test(CODE), false);
    // 표 참조는 전부 private. 로 한정된다.
    const bare = CODE.match(/(?<!private\.)\bscripture_catalog_candidate_generation_evidence\b/g) ?? [];
    // 제약·색인·방아쇠 이름은 스키마 없이 쓰므로, from/into/update 뒤의 맨이름만 없으면 된다.
    assert.equal(/\b(from|into|update|join)\s+scripture_catalog/i.test(CODE), false, bare.join(','));
  });

  it('형식·JSON 연결을 외부 접근 전에 검사한다', () => {
    assert.ok(CODE.includes(`p_artifact_hash !~ '${sqlPattern(ARTIFACT_HASH_FORMAT)}'`));
    assert.ok(CODE.includes(`p_candidate_hash !~ '${sqlPattern(CATALOG_CANDIDATE_HASH_FORMAT)}'`));
    assert.ok(CODE.includes("p_evidence ->> 'candidateHash' is distinct from p_candidate_hash"));
    assert.ok(CODE.includes("p_evidence ->> 'artifactHash' is distinct from p_artifact_hash"));
    assert.ok(CODE.includes("jsonb_typeof(p_evidence) <> 'object'"));
    assert.ok(CODE.includes("errcode = 'invalid_parameter_value'"));
  });

  it('후보가 없으면 저장하지 않는다', () => {
    assert.ok(CODE.includes('from private.scripture_catalog_candidate'));
    assert.ok(CODE.includes("errcode = 'no_data_found'"));
  });

  it('증거가 주장하는 버전·연구 연결을 후보 기록과 대조한다', () => {
    const columns = {
      baseVersionHash: 'base_version_hash',
      proposedVersionHash: 'proposed_version_hash',
      sourceResearchResultHash: 'source_research_result_hash',
    } as const;
    for (const [field, column] of Object.entries(columns)) {
      assert.ok(
        FLAT.includes(`p_evidence ->> '${field}' is distinct from v_candidate.${column}`),
        field,
      );
    }
    assert.ok(CODE.includes("errcode = 'check_violation'"));
  });

  it('먼저 INSERT ... ON CONFLICT DO NOTHING을 시도해 동시 재전송에서도 멱등을 지킨다', () => {
    // SELECT로 먼저 없는지 본 뒤 INSERT하는 순서가 아니어야 한다 — 그 사이에 동시 요청이
    // 끼어들면 둘 다 "없다"고 보고 둘 다 INSERT해 한쪽이 기본 키 충돌로 실패할 수 있다.
    assert.ok(FLAT.includes('on conflict (artifact_hash) do nothing'));
    assert.ok(FLAT.includes('returning artifact_hash into v_inserted_hash'));
    // INSERT 문장이 SELECT 대조보다 먼저 나와야 한다(형식·후보·버전 검사 다음).
    const insertIdx = CODE.indexOf('on conflict (artifact_hash) do nothing');
    const selectCompareIdx = CODE.indexOf('into v_existing_candidate_hash, v_existing_evidence');
    assert.ok(insertIdx > 0 && selectCompareIdx > insertIdx, 'INSERT가 대조용 SELECT보다 먼저다');
  });

  it('삽입이 실제로 일어났는지 확인해 성공하면 곧바로 반환한다', () => {
    assert.ok(FLAT.includes('if v_inserted_hash is not null then'));
    assert.ok(FLAT.includes('return v_inserted_hash;'));
  });

  it('삽입되지 않았으면 같은 문장의 CTE가 아니라 별도의 SELECT 문장으로 기존 행을 다시 읽는다', () => {
    // ON CONFLICT를 포함한 INSERT 문장과 대조용 SELECT가 서로 다른 최상위 SQL 문장이어야
    // 한다. with 절(CTE)로 한 문장 안에 묶으면 동시 커밋의 최신 상태를 못 볼 수 있다.
    assert.equal(/\bwith\b/i.test(CODE), false, 'CTE를 쓰지 않는다');
    assert.ok(FLAT.includes('select candidate_hash, evidence into v_existing_candidate_hash, v_existing_evidence'));
    assert.ok(FLAT.includes('from private.scripture_catalog_candidate_generation_evidence where artifact_hash = p_artifact_hash'));
  });

  it('candidateHash와 evidence가 모두 같으면 멱등, 다르면 unique_violation으로 거절한다', () => {
    assert.ok(FLAT.includes('if v_existing_candidate_hash = p_candidate_hash and v_existing_evidence = p_evidence then'));
    assert.ok(CODE.includes('return p_artifact_hash;'));
    assert.ok(CODE.includes("errcode = 'unique_violation'"));
  });

  it('넓은 예외 처리(EXCEPTION 블록)로 오류를 삼키지 않는다', () => {
    assert.equal(/\bexception\s+when\b/i.test(CODE), false);
  });

  it('service_role에만 실행을 주고 나머지는 회수한다', () => {
    assert.ok(CODE.includes(`revoke all on function ${SIGNATURE}\n  from public`));
    assert.ok(CODE.includes(`revoke all on function ${SIGNATURE}\n  from anon, authenticated, service_role`));
    assert.ok(CODE.includes(`grant execute on function ${SIGNATURE}\n  to service_role`));
    // anon·authenticated에 실행을 주는 grant는 없다.
    assert.equal(/grant execute[^;]*to[^;]*\b(anon|authenticated|public)\b/i.test(CODE), false);
  });

  it('지문을 SQL에서 다시 계산하지 않으며 그런 척도 하지 않는다', () => {
    // canonicalJson과 같지 않은 jsonb::text 해시를 같은 지문이라고 가장하지 않는다.
    for (const banned of ['digest(', 'sha256', 'encode(', 'evidence::text', 'md5(']) {
      assert.equal(CODE.toLowerCase().includes(banned.toLowerCase()), false, banned);
    }
    // 한계는 주석에 적혀 있어야 한다.
    assert.ok(SQL.includes('지문 재계산의 한계'));
  });

  it('머리말이 보장하지 않는 것을 분명히 적는다', () => {
    assert.ok(SQL.includes('"저장됨"은 "실제 호출이 증명됨"이 아니다'));
    assert.ok(SQL.includes('전자서명이 아니'));
    assert.ok(SQL.includes('fail-closed'));
  });
});
