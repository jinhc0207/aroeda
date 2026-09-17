/** 자동 Scripture Catalog 검증 context 읽기 RPC migration 계약 테스트. */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import {
  GET_SCRIPTURE_CATALOG_VALIDATION_CONTEXT_RPC,
  VALIDATION_CONTEXT_DEMAND_CELL_FIELDS,
  VALIDATION_CONTEXT_RESPONSE_FIELDS,
} from '../../supabase/functions/_shared/automatic-scripture-catalog-validation-context.ts';
import { MAX_DEMAND_WINDOW_DAYS } from '../../supabase/functions/_shared/automatic-scripture-catalog-activation-contract.ts';

const SQL = readFileSync(
  new URL('../../supabase/migrations/20260917090000_add_scripture_catalog_validation_context_rpc.sql', import.meta.url),
  'utf8',
);
const CODE = SQL.split('\n').filter((line) => !/^\s*--/.test(line)).join('\n');
const QUALIFIED = `public.${GET_SCRIPTURE_CATALOG_VALIDATION_CONTEXT_RPC}(text, text, date, date)`;

describe('검증 context migration · 입력과 결과', () => {
  it('함수 하나만 만들고 표·트리거·정책은 만들지 않는다', () => {
    const functions = [...CODE.matchAll(/^create (?:or replace )?function ([^(]+)\(/gm)].map((match) => match[1]);
    assert.deepEqual(functions, [`public.${GET_SCRIPTURE_CATALOG_VALIDATION_CONTEXT_RPC}`]);
    for (const banned of ['create table', 'alter table', 'create trigger', 'create policy', 'insert into', 'update ', 'delete from']) {
      assert.equal(CODE.toLowerCase().includes(banned), false, banned);
    }
  });

  it('security definer·고정 search_path·stable 읽기 함수다', () => {
    assert.ok(CODE.includes('language plpgsql\nstable\nsecurity definer\nset search_path = private, pg_catalog'));
    assert.equal(CODE.includes('dynamic sql'), false);
    assert.equal(/\bexecute\s+(format|'|\$|v_)/i.test(CODE), false);
  });

  it('입력 종류·대상 모양·기간·서울 오늘 이전을 검사한다', () => {
    assert.ok(CODE.includes("array['weak_match', 'normalized_theme']"));
    assert.ok(CODE.includes("p_subject_key !~ '^[a-z][a-z0-9_]{2,47}$'"));
    assert.ok(CODE.includes("p_subject_key !~ '^sthm_[0-9a-f]{64}$'"));
    assert.ok(CODE.includes(`(p_window_end_date - p_window_start_date + 1) > ${MAX_DEMAND_WINDOW_DAYS}`));
    assert.ok(CODE.includes("p_window_end_date >= (now() at time zone 'Asia/Seoul')::date"));
  });

  it('활성 포인터와 그 버전의 catalog만 읽는다', () => {
    assert.ok(CODE.includes('from private.scripture_catalog_active_pointer'));
    assert.ok(CODE.includes('from private.scripture_catalog_version'));
    assert.ok(CODE.includes('where version_hash = v_pointer.active_version_hash'));
    assert.equal(CODE.includes('for update'), false, '읽기 RPC가 포인터를 잠그면 안 됩니다.');
  });

  it('weak_match 영역이 활성 catalog에 실제로 있어야 한다', () => {
    assert.ok(CODE.includes("jsonb_array_elements(v_catalog -> 'domains')"));
    assert.ok(CODE.includes("item ->> 'id' = p_subject_key"));
  });

  it('요청한 대상·기간의 수요 칸만 오름차순으로 읽는다', () => {
    assert.ok(CODE.includes('from private.scripture_demand_weak_match_daily'));
    assert.ok(CODE.includes('from private.scripture_demand_theme_daily'));
    assert.ok(CODE.includes('bucket_date between p_window_start_date and p_window_end_date'));
    assert.equal((CODE.match(/order by bucket_date/g) ?? []).length, 2);
  });

  it('응답과 수요 칸의 필드가 TS 계약과 정확히 같다', () => {
    for (const field of VALIDATION_CONTEXT_RESPONSE_FIELDS) assert.ok(CODE.includes(`'${field}'`), field);
    for (const field of VALIDATION_CONTEXT_DEMAND_CELL_FIELDS) assert.ok(CODE.includes(`'${field}'`), field);
  });
});

describe('검증 context migration · 권한과 개인정보', () => {
  it('public·사용자 역할·service_role 기본 권한을 회수한 뒤 service_role 실행만 연다', () => {
    assert.ok(CODE.includes(`revoke all on function ${QUALIFIED} from public;`));
    assert.match(CODE, new RegExp(`revoke all on function ${QUALIFIED.replace(/[().]/g, '\\$&')}\\s+from anon, authenticated, service_role;`));
    assert.ok(CODE.includes(`grant execute on function ${QUALIFIED} to service_role;`));
    assert.equal(/grant execute on function [^;]+ to (anon|authenticated|public)/.test(CODE), false);
  });

  it('사용자 원문·식별자·연락처·인증값 칸이 없다', () => {
    const lower = CODE.toLowerCase();
    for (const banned of ['user_id', 'usertext', 'user_text', 'device', 'ip_address', 'email', 'phone', 'token', 'authorization', 'api_key']) {
      assert.equal(lower.includes(banned), false, banned);
    }
  });

  it('외부 호출·공지·활성화·롤백·후보 저장이 없다', () => {
    const lower = CODE.toLowerCase();
    for (const banned of ['http_post', 'pg_net', 'pg_notify', 'scripture_catalog_activation', 'scripture_catalog_rollback', 'scripture_catalog_candidate', 'scripture_catalog_owner_notification']) {
      assert.equal(lower.includes(banned), false, banned);
    }
  });
});
