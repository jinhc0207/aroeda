/** validation-context Supabase fetch transport 테스트. 실제 네트워크는 쓰지 않는다. */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import {
  computeCatalogVersionHash,
  computeThemeFingerprint,
} from '../../supabase/functions/_shared/automatic-scripture-catalog-contract.ts';
import {
  VALIDATION_CONTEXT_FETCH_TIMEOUT_MS,
  VALIDATION_CONTEXT_FETCH_TRANSPORT_POLICY,
  ValidationContextFetchError,
  fetchScriptureCatalogValidationContext,
} from '../../supabase/functions/_shared/automatic-scripture-catalog-validation-context-fetch-transport.ts';
import { buildBaselineCatalog } from './automatic-scripture-catalog-test-fixtures.ts';

const SUPABASE_URL = 'https://example.supabase.co';
const KEY = 'test-service-role-key-not-real';
const SECRET = 'DO-NOT-LEAK-SERVICE-ROLE-7102';
const PROVIDER_ERROR = 'DO-NOT-LEAK-PROVIDER-3901';
const WEAK = { kind: 'weak_match', domainId: 'decision_guidance' } as const;
const THEME_KEY = 'caregiving_strain';
const THEME = {
  kind: 'normalized_theme',
  themeKey: THEME_KEY,
  themeFingerprint: await computeThemeFingerprint(THEME_KEY),
} as const;
const WINDOW = { windowStartDate: '2026-08-01', windowEndDate: '2026-08-30' };
const SOURCE = new URL(
  '../../supabase/functions/_shared/automatic-scripture-catalog-validation-context-fetch-transport.ts',
  import.meta.url,
);

async function validResponse(binding: typeof WEAK | typeof THEME = WEAK) {
  const baseCatalog = buildBaselineCatalog();
  const subjectKey = binding.kind === 'weak_match' ? binding.domainId : binding.themeFingerprint;
  return {
    activeVersionHash: await computeCatalogVersionHash(baseCatalog),
    pointerRevision: 3,
    baseCatalog,
    demandCells: [{ evidenceKind: binding.kind, subjectKey, bucketDate: '2026-08-02', count: 4 }],
  };
}

type FetchCall = { url: unknown; init: RequestInit };
const fakeFetch = (respond: (call: FetchCall) => Response | Promise<Response>) => {
  const calls: FetchCall[] = [];
  const impl = (async (url: unknown, init: RequestInit) => {
    calls.push({ url, init });
    return await respond({ url, init });
  }) as unknown as typeof fetch;
  return { calls, impl };
};
const ok = (value: unknown) => new Response(JSON.stringify(value), { status: 200 });
/**
 * ok()와 달리 JSON.stringify/parse를 거치지 않고 넘긴 객체를 그대로 .json()에서 돌려준다.
 * 직렬화를 거치면 어떤 경로든 새 객체가 나오므로 "검증기가 다시 만든 값만 돌려주는가"를
 * 참조로는 가릴 수 없다 — 이 헬퍼로 원본 참조를 살려 둬야 그 차이를 볼 수 있다.
 */
const okObject = (value: unknown): Response => ({ ok: true, status: 200, json: async () => value } as unknown as Response);
const guardedNonOk = (status: number) => {
  const forbidden = () => { throw new Error('NON_OK_BODY_MUST_NOT_BE_READ'); };
  return { ok: false, status, json: forbidden, text: forbidden } as unknown as Response;
};

async function expectFailure(run: () => Promise<unknown>, kind: ValidationContextFetchError['kind']) {
  await assert.rejects(run, (error: unknown) => {
    assert.ok(error instanceof ValidationContextFetchError);
    assert.equal(error.kind, kind);
    assert.equal(error.message, kind);
    assert.equal(String(error).includes(SECRET), false);
    assert.equal(String(error).includes(PROVIDER_ERROR), false);
    return true;
  });
}

describe('validation context fetch transport · 정상 요청', () => {
  it('정해진 RPC에 exact params를 한 번 POST하고 검증된 context만 돌려준다', async () => {
    const raw = await validResponse();
    const before = structuredClone(raw);
    const { calls, impl } = fakeFetch(() => ok(raw));
    const result = await fetchScriptureCatalogValidationContext(WEAK, WINDOW, {
      supabaseUrl: SUPABASE_URL, serviceRoleKey: KEY, fetchImpl: impl,
    });
    assert.deepEqual(result, raw);
    assert.notEqual(result.baseCatalog, raw.baseCatalog);
    assert.deepEqual(raw, before);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.url, `${SUPABASE_URL}/rest/v1/rpc/get_scripture_catalog_validation_context`);
    assert.equal(calls[0]?.init.method, 'POST');
    assert.deepEqual(calls[0]?.init.headers, {
      apikey: KEY,
      authorization: `Bearer ${KEY}`,
      'content-type': 'application/json',
    });
    assert.deepEqual(JSON.parse(calls[0]?.init.body as string), {
      p_evidence_kind: 'weak_match',
      p_subject_key: 'decision_guidance',
      p_window_start_date: '2026-08-01',
      p_window_end_date: '2026-08-30',
    });
    assert.ok(calls[0]?.init.signal);
  });

  it('새 영역은 themeKey나 사용자 원문 대신 주제 지문만 보낸다', async () => {
    const { calls, impl } = fakeFetch(async () => ok(await validResponse(THEME)));
    await fetchScriptureCatalogValidationContext(THEME, WINDOW, {
      supabaseUrl: `${SUPABASE_URL}/`, serviceRoleKey: KEY, fetchImpl: impl,
    });
    const body = JSON.parse(calls[0]?.init.body as string);
    assert.equal(body.p_subject_key, THEME.themeFingerprint);
    assert.equal(JSON.stringify(body).includes(THEME_KEY), false);
    assert.equal(Object.keys(body).length, 4);
  });

  it('성공 뒤 timer를 정리해 signal이 나중에 바뀌지 않는다', async () => {
    const observed: { signal: AbortSignal | null } = { signal: null };
    const { impl } = fakeFetch(async ({ init }) => {
      observed.signal = init.signal ?? null;
      return ok(await validResponse());
    });
    await fetchScriptureCatalogValidationContext(WEAK, WINDOW, {
      // 전체 스위트가 함께 도는 무거운 상황에서도 안정적이도록 여유를 넉넉히 둔다(5ms는
      // 시스템 부하가 있으면 clearTimeout보다 타이머가 먼저 도는 flaky를 만들었다).
      supabaseUrl: SUPABASE_URL, serviceRoleKey: KEY, fetchImpl: impl, timeoutMs: 200,
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.ok(observed.signal);
    assert.equal(observed.signal.aborted, false);
  });

  it('검증기가 다시 지은 context만 돌려준다(원본 응답 객체를 그대로 넘기지 않는다)', async () => {
    // ok()는 JSON.stringify/parse를 거쳐 항상 새 객체를 낳으므로, "참조가 다르다"만으로는
    // 구현이 실제로 parseValidationContextRpcResponse의 결과를 돌려주는지 가릴 수 없다.
    // okObject()로 원본 참조를 살려 둬야, 검증을 건너뛰고 원본을 그대로 넘기는 결함을 잡는다.
    const raw = await validResponse();
    const { impl } = fakeFetch(() => okObject(raw));
    const result = await fetchScriptureCatalogValidationContext(WEAK, WINDOW, {
      supabaseUrl: SUPABASE_URL, serviceRoleKey: KEY, fetchImpl: impl,
    });
    assert.deepEqual(result, raw);
    assert.notEqual(result, raw);
    assert.notEqual(result.baseCatalog, raw.baseCatalog);
    assert.notEqual(result.demandCells, raw.demandCells);
  });
});

describe('validation context fetch transport · 사전 차단', () => {
  it('잘못된 URL·자격·시간 제한은 fetch 0회다', async () => {
    for (const patch of [
      { supabaseUrl: null }, { supabaseUrl: '' }, { supabaseUrl: 'not-a-url' },
      { supabaseUrl: 'ftp://example.com' }, { supabaseUrl: 'https://user:pass@example.com' },
      { supabaseUrl: 'https://example.com?secret=yes' }, { supabaseUrl: ' https://example.com' },
      { serviceRoleKey: null }, { serviceRoleKey: '' }, { serviceRoleKey: '   ' },
      { timeoutMs: 0 }, { timeoutMs: 60_001 }, { timeoutMs: 1.5 },
    ]) {
      const { calls, impl } = fakeFetch(() => { throw new Error('MUST_NOT_CALL'); });
      await expectFailure(
        () => fetchScriptureCatalogValidationContext(WEAK, WINDOW, {
          supabaseUrl: SUPABASE_URL, serviceRoleKey: KEY, fetchImpl: impl, ...patch,
        }),
        'configuration_error',
      );
      assert.equal(calls.length, 0);
    }
  });

  it('잘못된 날짜 범위는 자격을 보거나 fetch하기 전에 request_invalid다', async () => {
    const { calls, impl } = fakeFetch(() => { throw new Error('MUST_NOT_CALL'); });
    await expectFailure(
      () => fetchScriptureCatalogValidationContext(WEAK, {
        windowStartDate: '2026-08-30', windowEndDate: '2026-08-01',
      }, { supabaseUrl: SECRET, serviceRoleKey: SECRET, fetchImpl: impl }),
      'request_invalid',
    );
    assert.equal(calls.length, 0);
  });
});

describe('validation context fetch transport · HTTP와 응답 실패', () => {
  it('fetch reject는 provider_error이고 한 번만 시도한다', async () => {
    const { calls, impl } = fakeFetch(() => { throw new Error(PROVIDER_ERROR); });
    await expectFailure(
      () => fetchScriptureCatalogValidationContext(WEAK, WINDOW, {
        supabaseUrl: SUPABASE_URL, serviceRoleKey: SECRET, fetchImpl: impl,
      }),
      'provider_error',
    );
    assert.equal(calls.length, 1);
  });

  it('timer가 끊은 fetch만 provider_timeout이다', async () => {
    const { calls, impl } = fakeFetch(({ init }) => new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
    }));
    await expectFailure(
      () => fetchScriptureCatalogValidationContext(WEAK, WINDOW, {
        supabaseUrl: SUPABASE_URL, serviceRoleKey: KEY, fetchImpl: impl, timeoutMs: 1,
      }),
      'provider_timeout',
    );
    assert.equal(calls.length, 1);
  });

  it('408은 timeout, 429·5xx는 unavailable, 나머지 non-2xx는 provider_error다', async () => {
    for (const [status, kind] of [
      [400, 'provider_error'], [401, 'provider_error'], [403, 'provider_error'], [404, 'provider_error'],
      [408, 'provider_timeout'], [409, 'provider_error'], [429, 'provider_unavailable'],
      [500, 'provider_unavailable'], [503, 'provider_unavailable'],
    ] as const) {
      const { calls, impl } = fakeFetch(() => guardedNonOk(status));
      await expectFailure(
        () => fetchScriptureCatalogValidationContext(WEAK, WINDOW, {
          supabaseUrl: SUPABASE_URL, serviceRoleKey: KEY, fetchImpl: impl,
        }),
        kind,
      );
      assert.equal(calls.length, 1);
    }
  });

  it('성공 status의 body 읽기 실패는 provider_error이고 재시도하지 않는다', async () => {
    const response = { ok: true, status: 200, json: () => { throw new Error(PROVIDER_ERROR); } } as unknown as Response;
    const { calls, impl } = fakeFetch(() => response);
    await expectFailure(
      () => fetchScriptureCatalogValidationContext(WEAK, WINDOW, {
        supabaseUrl: SUPABASE_URL, serviceRoleKey: KEY, fetchImpl: impl,
      }),
      'provider_error',
    );
    assert.equal(calls.length, 1);
  });

  it('본문 읽기 중 timeout이면 provider_timeout이다', async () => {
    const response = {
      ok: true,
      status: 200,
      json: () => new Promise((_resolve, reject) => setTimeout(() => reject(new Error('late')), 5)),
    } as unknown as Response;
    const { impl } = fakeFetch(() => response);
    await expectFailure(
      () => fetchScriptureCatalogValidationContext(WEAK, WINDOW, {
        supabaseUrl: SUPABASE_URL, serviceRoleKey: KEY, fetchImpl: impl, timeoutMs: 1,
      }),
      'provider_timeout',
    );
  });

  it('RPC 응답 계약이 틀리면 response_contract_invalid다', async () => {
    for (const raw of [null, [], {}, { ...(await validResponse()), pointerRevision: 0 }]) {
      const { impl } = fakeFetch(() => ok(raw));
      await expectFailure(
        () => fetchScriptureCatalogValidationContext(WEAK, WINDOW, {
          supabaseUrl: SUPABASE_URL, serviceRoleKey: KEY, fetchImpl: impl,
        }),
        'response_contract_invalid',
      );
    }
  });
});

describe('validation context fetch transport · 책임 경계', () => {
  it('정책은 1회·무재시도·non-OK body 미독해·원문 미보관이다', () => {
    assert.deepEqual(VALIDATION_CONTEXT_FETCH_TRANSPORT_POLICY, {
      attempts: 1,
      automaticRetries: 0,
      nonOkBodyRead: false,
      rawResponsePersisted: false,
      providerErrorMessagePersisted: false,
      environmentReadHere: false,
      databaseWriteHere: false,
      logsHere: false,
    });
    assert.equal(VALIDATION_CONTEXT_FETCH_TIMEOUT_MS, 10_000);
  });

  it('소스는 환경변수·직접 DB·로그·재시도·하드코딩 프로젝트를 갖지 않는다', () => {
    const source = readFileSync(SOURCE, 'utf8');
    for (const forbidden of [
      'Deno.env', 'process.env', 'createClient(', '.from(', 'console.',
      'setInterval(', 'while (', 'for (;;', '.supabase.co', 'SUPABASE_SERVICE_ROLE_KEY',
    ]) assert.equal(source.includes(forbidden), false, forbidden);
    assert.equal((source.match(/await doFetch\(/g) ?? []).length, 1);
  });
});
