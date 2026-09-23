/** 활성 카탈로그 runtime 계약·fetch·migration 회귀 테스트. 실제 네트워크는 쓰지 않는다. */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import {
  applyCandidateToCatalog,
  computeCatalogVersionHash,
} from '../../supabase/functions/_shared/automatic-scripture-catalog-contract.ts';
import {
  GET_ACTIVE_SCRIPTURE_CATALOG_RUNTIME_RPC,
  SCRIPTURE_CATALOG_RUNTIME_PRIVACY_POLICY,
  parseScriptureCatalogRuntimeResponse,
} from '../../supabase/functions/_shared/automatic-scripture-catalog-runtime.ts';
import {
  SCRIPTURE_CATALOG_RUNTIME_FETCH_POLICY,
  ScriptureCatalogRuntimeFetchError,
  createScriptureCatalogRuntimeLoader,
} from '../../supabase/functions/_shared/automatic-scripture-catalog-runtime-fetch-transport.ts';
import { analyzerDomainIds } from '../../supabase/functions/_shared/automatic-scripture-catalog-analyzer-domain-manifest.ts';
import { buildBaselineCatalog, finalizeCandidate, makeNewDomainCandidate } from './automatic-scripture-catalog-test-fixtures.ts';

const SQL = readFileSync(new URL(
  '../../supabase/migrations/20260923090000_add_active_scripture_catalog_runtime_rpc.sql',
  import.meta.url,
), 'utf8');
const CODE = SQL.split('\n').filter((line) => !/^\s*--/.test(line)).join('\n');
const SUPABASE_URL = 'https://example.supabase.co';
const KEY = 'test-service-role-key-not-real';

async function responseFixture(catalog = buildBaselineCatalog()) {
  return {
    activeVersionHash: await computeCatalogVersionHash(catalog),
    pointerRevision: 7,
    catalog,
  };
}

async function dynamicCatalog() {
  const base = buildBaselineCatalog();
  const { candidate: raw } = await makeNewDomainCandidate(base);
  const { baseVersionHash: _base, proposedVersionHash: _proposed, ...draft } = raw;
  const { candidate } = await finalizeCandidate(base, draft);
  return { base, catalog: applyCandidateToCatalog(base, candidate) };
}

describe('활성 카탈로그 runtime · 응답 계약', () => {
  it('지문을 다시 계산하고 catalog·manifest·Gate cards를 격리해 만든다', async () => {
    const raw = await responseFixture();
    const result = await parseScriptureCatalogRuntimeResponse(raw);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.runtime.activeVersionHash, raw.activeVersionHash);
    assert.equal(result.runtime.pointerRevision, 7);
    assert.notEqual(result.runtime.catalog, raw.catalog);
    assert.equal(result.runtime.cards.length, raw.catalog.cards.length);
    assert.equal(analyzerDomainIds(result.runtime.manifest).includes('fear_uncertainty'), true);
  });

  it('활성 catalog의 새 영역을 Analyzer와 Gate cards에 함께 반영한다', async () => {
    const { catalog } = await dynamicCatalog();
    const parsed = await parseScriptureCatalogRuntimeResponse(await responseFixture(catalog));
    assert.equal(parsed.ok, true);
    if (!parsed.ok) return;
    assert.equal(analyzerDomainIds(parsed.runtime.manifest).includes('caregiving_strain'), true);
    assert.equal(parsed.runtime.manifest.situationTags.includes('시험용 상황'), true);
    assert.equal(parsed.runtime.cards.some((card) =>
      (card.domains as readonly string[]).some((domain) => domain === 'caregiving_strain')), true);
  });

  it('필드·revision·catalog·지문이 어긋나면 모두 fail-closed다', async () => {
    const valid = await responseFixture();
    for (const bad of [
      null, [], {}, { ...valid, extra: true }, { ...valid, pointerRevision: 0 },
      { ...valid, activeVersionHash: `scat_${'0'.repeat(64)}` },
      { ...valid, catalog: { ...valid.catalog, cards: [] } },
    ]) assert.deepEqual(await parseScriptureCatalogRuntimeResponse(bad), { ok: false });
  });

  it('개인정보 없이 읽기 전용이며 정적 fallback을 금지한다', () => {
    assert.deepEqual(SCRIPTURE_CATALOG_RUNTIME_PRIVACY_POLICY, {
      acceptsUserText: false, returnsUserText: false, returnsUserId: false,
      returnsCredential: false, readOnly: true, fallbackToStaticCatalog: false,
    });
  });
});

describe('활성 카탈로그 runtime · service_role fetch', () => {
  it('전용 RPC를 정확히 한 번 호출하고 검증된 runtime만 반환한다', async () => {
    const calls: Array<{ url: unknown; init: RequestInit }> = [];
    const raw = await responseFixture();
    const loader = createScriptureCatalogRuntimeLoader({
      supabaseUrl: SUPABASE_URL,
      serviceRoleKey: KEY,
      fetchImpl: (async (url: unknown, init: RequestInit) => {
        calls.push({ url, init });
        return new Response(JSON.stringify(raw), { status: 200 });
      }) as typeof fetch,
    });
    const runtime = await loader();
    assert.equal(runtime.activeVersionHash, raw.activeVersionHash);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.url, `${SUPABASE_URL}/rest/v1/rpc/${GET_ACTIVE_SCRIPTURE_CATALOG_RUNTIME_RPC}`);
    assert.equal(calls[0]?.init.body, '{}');
    assert.equal((calls[0]?.init.headers as Record<string, string>).authorization, `Bearer ${KEY}`);
  });

  it('설정·HTTP·응답 오류는 원문 없이 정제된 오류이고 재시도·fallback이 없다', async () => {
    const expectKind = async (loader: () => Promise<unknown>, kind: ScriptureCatalogRuntimeFetchError['kind']) => {
      await assert.rejects(loader, (error: unknown) =>
        error instanceof ScriptureCatalogRuntimeFetchError && error.kind === kind && error.message === kind);
    };
    await expectKind(createScriptureCatalogRuntimeLoader({ supabaseUrl: null, serviceRoleKey: KEY }), 'configuration_error');
    await expectKind(createScriptureCatalogRuntimeLoader({
      supabaseUrl: SUPABASE_URL, serviceRoleKey: KEY,
      fetchImpl: (async () => new Response('secret provider body', { status: 503 })) as typeof fetch,
    }), 'unavailable');
    await expectKind(createScriptureCatalogRuntimeLoader({
      supabaseUrl: SUPABASE_URL, serviceRoleKey: KEY,
      fetchImpl: (async () => new Response('{}', { status: 200 })) as typeof fetch,
    }), 'response_invalid');
    assert.deepEqual(SCRIPTURE_CATALOG_RUNTIME_FETCH_POLICY, {
      attempts: 1, automaticRetries: 0, fallbackToStaticCatalog: false,
      nonOkBodyRead: false, logsHere: false, databaseWriteHere: false,
    });
  });

  it('fetch가 abort를 무시해도 정해진 시간 안에 timeout으로 끝난다', async () => {
    const startedAt = Date.now();
    const loader = createScriptureCatalogRuntimeLoader({
      supabaseUrl: SUPABASE_URL,
      serviceRoleKey: KEY,
      timeoutMs: 10,
      fetchImpl: (() => new Promise<Response>(() => {})) as typeof fetch,
    });
    await assert.rejects(loader, (error: unknown) =>
      error instanceof ScriptureCatalogRuntimeFetchError && error.kind === 'timeout');
    assert.ok(Date.now() - startedAt < 500);
  });

  it('호출자의 전체 마감 신호가 오면 abort를 무시하는 fetch도 즉시 기다리기를 끝낸다', async () => {
    const controller = new AbortController();
    let receivedSignal: AbortSignal | undefined;
    const loader = createScriptureCatalogRuntimeLoader({
      supabaseUrl: SUPABASE_URL,
      serviceRoleKey: KEY,
      timeoutMs: 1_000,
      fetchImpl: ((_url: unknown, init: RequestInit) => {
        receivedSignal = init.signal as AbortSignal;
        return new Promise<Response>(() => {});
      }) as typeof fetch,
    });
    const startedAt = Date.now();
    const pending = loader({ signal: controller.signal });
    controller.abort();
    await assert.rejects(pending, (error: unknown) =>
      error instanceof ScriptureCatalogRuntimeFetchError && error.kind === 'cancelled');
    assert.equal(receivedSignal?.aborted, true);
    assert.ok(Date.now() - startedAt < 500);
  });
});

describe('활성 카탈로그 runtime · migration', () => {
  it('단일 SELECT join으로 pointer·version을 같은 SQL snapshot에서 읽는다', () => {
    assert.match(CODE, /create function public\.get_active_scripture_catalog_runtime\(\)/);
    assert.ok(CODE.includes('language sql\nstable\nsecurity definer'));
    assert.ok(CODE.includes('from private.scripture_catalog_active_pointer as p'));
    assert.ok(CODE.includes('join private.scripture_catalog_version as v'));
    assert.ok(CODE.includes('on v.version_hash = p.active_version_hash'));
    assert.equal((CODE.match(/\bselect\b/g) ?? []).length, 1);
    for (const banned of ['insert ', 'update ', 'delete ', 'for update', 'create table', 'create trigger']) {
      assert.equal(CODE.toLowerCase().includes(banned), false, banned);
    }
  });

  it('service_role execute만 열고 사용자 입력 인자가 없다', () => {
    const qualified = 'public.get_active_scripture_catalog_runtime()';
    assert.ok(CODE.includes(`revoke all on function ${qualified} from public;`));
    assert.match(CODE, /revoke all on function public\.get_active_scripture_catalog_runtime\(\)\s+from anon, authenticated, service_role;/);
    assert.ok(CODE.includes(`grant execute on function ${qualified} to service_role;`));
    assert.equal(/grant execute on function [^;]+ to (anon|authenticated|public)/.test(CODE), false);
  });
});
