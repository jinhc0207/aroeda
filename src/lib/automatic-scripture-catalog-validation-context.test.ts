/** 자동 Scripture Catalog 검증 context RPC 응답 계약 테스트. */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import {
  computeCatalogVersionHash,
  computeThemeFingerprint,
} from '../../supabase/functions/_shared/automatic-scripture-catalog-contract.ts';
import {
  GET_SCRIPTURE_CATALOG_VALIDATION_CONTEXT_RPC,
  VALIDATION_CONTEXT_PRIVACY_POLICY,
  buildValidationContextRpcSpec,
  parseValidationContextRpcResponse,
} from '../../supabase/functions/_shared/automatic-scripture-catalog-validation-context.ts';
import { buildBaselineCatalog } from './automatic-scripture-catalog-test-fixtures.ts';

const WEAK = { kind: 'weak_match', domainId: 'decision_guidance' } as const;
const THEME_KEY = 'caregiving_strain';
const THEME = {
  kind: 'normalized_theme',
  themeKey: THEME_KEY,
  themeFingerprint: await computeThemeFingerprint(THEME_KEY),
} as const;
const WINDOW = { windowStartDate: '2026-08-01', windowEndDate: '2026-08-30' };

async function response(binding: typeof WEAK | typeof THEME = WEAK) {
  const baseCatalog = buildBaselineCatalog();
  const subjectKey = binding.kind === 'weak_match' ? binding.domainId : binding.themeFingerprint;
  return {
    activeVersionHash: await computeCatalogVersionHash(baseCatalog),
    pointerRevision: 4,
    baseCatalog,
    demandCells: [
      { evidenceKind: binding.kind, subjectKey, bucketDate: '2026-08-02', count: 3 },
      { evidenceKind: binding.kind, subjectKey, bucketDate: '2026-08-09', count: 7 },
    ],
  };
}

describe('자동 검증 context · 요청 spec', () => {
  it('weak_match는 사용자 원문 없이 영역·기간만 보낸다', () => {
    assert.deepEqual(buildValidationContextRpcSpec(WEAK, WINDOW), {
      functionName: GET_SCRIPTURE_CATALOG_VALIDATION_CONTEXT_RPC,
      params: {
        p_evidence_kind: 'weak_match',
        p_subject_key: 'decision_guidance',
        p_window_start_date: '2026-08-01',
        p_window_end_date: '2026-08-30',
      },
    });
  });

  it('normalized_theme은 정규화 지문만 보낸다', () => {
    assert.equal(buildValidationContextRpcSpec(THEME, WINDOW)?.params.p_subject_key, THEME.themeFingerprint);
  });

  it('역전·잘못된 날짜·90일 초과 기간은 요청을 만들지 않는다', () => {
    for (const window of [
      { windowStartDate: '2026-08-02', windowEndDate: '2026-08-01' },
      { windowStartDate: '2026-02-30', windowEndDate: '2026-03-01' },
      { windowStartDate: '2026-01-01', windowEndDate: '2026-04-01' },
    ]) assert.equal(buildValidationContextRpcSpec(WEAK, window), null);
  });
});

describe('자동 검증 context · 응답 해석', () => {
  it('활성 카탈로그와 오름차순 수요 칸을 받아들인다', async () => {
    const raw = await response();
    const parsed = await parseValidationContextRpcResponse(raw, WEAK, WINDOW);
    assert.equal(parsed.ok, true);
    if (!parsed.ok) return;
    assert.deepEqual(parsed.context, raw);
    assert.notEqual(parsed.context.baseCatalog, raw.baseCatalog);
  });

  it('수요 칸이 없는 것도 유효하다(뒤에서 0으로 채운다)', async () => {
    const raw = { ...(await response()), demandCells: [] };
    assert.equal((await parseValidationContextRpcResponse(raw, WEAK, WINDOW)).ok, true);
  });

  it('새 영역 주제 지문도 같은 계약으로 읽는다', async () => {
    assert.equal((await parseValidationContextRpcResponse(await response(THEME), THEME, WINDOW)).ok, true);
  });

  it('최상위 누락·여분 필드는 거절한다', async () => {
    const raw = await response();
    const { pointerRevision: _removed, ...missing } = raw;
    assert.equal((await parseValidationContextRpcResponse(missing, WEAK, WINDOW)).ok, false);
    assert.equal((await parseValidationContextRpcResponse({ ...raw, extra: true }, WEAK, WINDOW)).ok, false);
  });

  it('포인터 revision은 양의 safe integer여야 한다', async () => {
    for (const pointerRevision of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, '4']) {
      assert.equal((await parseValidationContextRpcResponse({ ...(await response()), pointerRevision }, WEAK, WINDOW)).ok, false);
    }
  });

  it('activeVersionHash를 카탈로그 내용에서 다시 계산한다', async () => {
    const raw = await response();
    assert.equal((await parseValidationContextRpcResponse({ ...raw, activeVersionHash: `scat_${'0'.repeat(64)}` }, WEAK, WINDOW)).ok, false);
    const changed = structuredClone(raw);
    changed.baseCatalog.domains[0]!.description += '변조';
    assert.equal((await parseValidationContextRpcResponse(changed, WEAK, WINDOW)).ok, false);
  });

  it('유효하지 않은 카탈로그는 거절한다', async () => {
    const raw = await response();
    assert.equal((await parseValidationContextRpcResponse({ ...raw, baseCatalog: { bad: true } }, WEAK, WINDOW)).ok, false);
  });

  it('수요 칸은 exact fields만 허용한다', async () => {
    const raw = await response();
    const extra = structuredClone(raw);
    Object.assign(extra.demandCells[0]!, { userText: '금지' });
    assert.equal((await parseValidationContextRpcResponse(extra, WEAK, WINDOW)).ok, false);
    const missing = structuredClone(raw) as { demandCells: Array<Record<string, unknown>> };
    delete missing.demandCells[0]!.count;
    assert.equal((await parseValidationContextRpcResponse(missing, WEAK, WINDOW)).ok, false);
  });

  it('다른 종류·대상·기간 밖 날짜를 거절한다', async () => {
    for (const patch of [
      { evidenceKind: 'normalized_theme' },
      { subjectKey: 'other_domain' },
      { bucketDate: '2026-09-01' },
    ]) {
      const raw = await response();
      Object.assign(raw.demandCells[0]!, patch);
      assert.equal((await parseValidationContextRpcResponse(raw, WEAK, WINDOW)).ok, false);
    }
  });

  it('날짜 중복·역순을 거절한다', async () => {
    const duplicate = await response();
    duplicate.demandCells[1]!.bucketDate = duplicate.demandCells[0]!.bucketDate;
    assert.equal((await parseValidationContextRpcResponse(duplicate, WEAK, WINDOW)).ok, false);
    const reversed = await response();
    reversed.demandCells.reverse();
    assert.equal((await parseValidationContextRpcResponse(reversed, WEAK, WINDOW)).ok, false);
  });

  it('count는 양의 safe integer여야 한다', async () => {
    for (const count of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, '3']) {
      const raw = await response() as { demandCells: Array<Record<string, unknown>> } & Record<string, unknown>;
      raw.demandCells[0]!.count = count;
      assert.equal((await parseValidationContextRpcResponse(raw, WEAK, WINDOW)).ok, false);
    }
  });

  it('어떤 이상한 값도 예외 대신 거절한다', async () => {
    for (const value of [null, undefined, 1, 'x', [], {}, { then: () => {} }]) {
      assert.equal((await parseValidationContextRpcResponse(value, WEAK, WINDOW)).ok, false);
    }
  });
});

describe('자동 검증 context · 개인정보와 책임 경계', () => {
  it('개인정보를 받거나 돌려주지 않는 읽기 전용 정책이다', () => {
    assert.deepEqual(VALIDATION_CONTEXT_PRIVACY_POLICY, {
      acceptsUserText: false,
      returnsUserText: false,
      returnsUserId: false,
      returnsDeviceId: false,
      returnsIpAddress: false,
      returnsCredential: false,
      readOnly: true,
    });
  });

  it('계약 파일은 DB·fetch·환경변수에 접근하지 않는다', () => {
    const source = readFileSync(new URL('../../supabase/functions/_shared/automatic-scripture-catalog-validation-context.ts', import.meta.url), 'utf8');
    for (const banned of ['fetch(', 'Deno.env', 'process.env', 'createClient(', '/rest/v1/', 'service_role']) {
      assert.equal(source.includes(banned), false, banned);
    }
  });
});
