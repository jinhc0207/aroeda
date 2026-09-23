/**
 * Edge Function 공용 요청 처리
 *
 * analyze-situation과 recommend-scripture가 똑같은 입력 규칙과 똑같은 Analyzer 호출을 쓰도록
 * 한 곳에 모아 둔다. 두 함수가 서로 다르게 동작하지 않게 하기 위한 것이다.
 *
 * 이 파일에는 Deno 전용 코드를 넣지 않는다.
 * API Key 읽기와 실제 네트워크 호출은 각 함수의 index.ts가 맡는다.
 *
 * 개인정보 원칙:
 *   - 사용자의 문장을 저장하지 않는다.
 *   - 로그에 문장 원문이나 OpenAI 응답 전체를 남기지 않는다.
 *   - OpenAI 요청은 store: false로 보낸다.
 */

import { corsHeaders, handlePreflight } from './cors.ts';
import { extractOutputText } from './openai-response.ts';
import type { QuotaChecker } from './rate-limit.ts';
import {
  INSTRUCTIONS,
  MODEL,
  SITUATION_ANALYSIS_SCHEMA,
  buildAnalyzerInstructions,
  buildSituationAnalysisSchema,
} from './analyzer-contract.ts';
import type { AnalyzerDomainManifest } from './automatic-scripture-catalog-analyzer-domain-manifest.ts';
import type {
  ScriptureCatalogRuntime,
  ScriptureCatalogRuntimeLoader,
} from './automatic-scripture-catalog-runtime.ts';
import {
  validateSituationAnalysisForDomains,
  type SituationAnalysis,
} from './situation-analysis.ts';

export const MAX_SITUATION_LENGTH = 3000;

export type ErrorCode =
  | 'METHOD_NOT_ALLOWED'
  | 'INVALID_JSON'
  | 'INVALID_INPUT'
  | 'SITUATION_TOO_LONG'
  | 'CATALOG_UNAVAILABLE'
  | 'OPENAI_API_KEY_MISSING'
  | 'OPENAI_REQUEST_FAILED'
  | 'INVALID_ANALYSIS_RESPONSE'
  | 'RATE_LIMITED'
  | 'RATE_LIMIT_UNAVAILABLE'
  | 'INTERNAL_ERROR';

export type ErrorBody = { ok: false; error: ErrorCode };

export type EdgeDeps = {
  /** 활성 포인터와 카탈로그를 원자적으로 읽고 검증한다. 정적 fallback은 허용하지 않는다. */
  loadCatalogRuntime: ScriptureCatalogRuntimeLoader;
  /**
   * OpenAI를 부르기 전에 사용량을 한 번 소비한다.
   * 두 Edge Function이 같은 quota를 쓰도록 같은 checker를 넘긴다.
   * 필수 항목이다. 빠뜨리면 보호 장치 없이 OpenAI를 부르게 되므로 타입으로 막는다.
   */
  checkQuota: QuotaChecker;
  /** 없으면 OPENAI_API_KEY_MISSING */
  getApiKey: () => string | undefined;
  /** OpenAI Responses API 호출. 테스트에서는 가짜 함수를 넣는다. */
  callOpenAI: (payload: Record<string, unknown>, apiKey: string) => Promise<unknown>;
  /** 로그용. 사용자 문장은 절대 넣지 않는다. */
  log?: (message: string) => void;
  /** 요청 구분용 id */
  requestId?: () => string;
};

/** 모든 응답(성공/오류)에 CORS 헤더를 함께 붙인다. 브라우저가 오류 내용도 읽을 수 있어야 한다. */
export const jsonResponse = (body: unknown, status: number) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'content-type': 'application/json; charset=utf-8' },
  });

export const errorResponse = (error: ErrorCode, status: number, extraHeaders?: Record<string, string>) =>
  new Response(JSON.stringify({ ok: false, error } satisfies ErrorBody), {
    status,
    headers: {
      ...corsHeaders,
      'content-type': 'application/json; charset=utf-8',
      ...(extraHeaders ?? {}),
    },
  });

/**
 * OpenAI Responses API 응답에서 모델이 쓴 텍스트만 꺼낸다.
 * SDK의 output_text와 같은 값을 직접 계산한다.
 * 구현은 _shared/openai-response.ts 한 곳에만 두고 여러 기능이 같이 쓴다.
 */
export { extractOutputText };

/**
 * OpenAI에 보낼 요청 본문.
 * 로컬 테스트에서 검증된 설정을 그대로 쓴다.
 * max_output_tokens는 넣지 않는다. 작은 값을 넣으면 응답이 잘려 오류가 난다.
 */
export function buildOpenAIPayload(situation: string): Record<string, unknown> {
  return {
    model: MODEL,
    store: false,
    instructions: INSTRUCTIONS,
    input: situation,
    text: {
      format: {
        type: 'json_schema',
        name: 'situation_analysis',
        strict: true,
        schema: SITUATION_ANALYSIS_SCHEMA,
      },
    },
  };
}

/** 검증된 동적 manifest를 쓰는 payload. 후보 생성과 활성 카탈로그 운영 요청이 함께 쓴다. */
export function buildOpenAIPayloadForManifest(
  situation: string,
  manifest: AnalyzerDomainManifest,
): Record<string, unknown> {
  return {
    model: MODEL,
    store: false,
    instructions: buildAnalyzerInstructions(manifest),
    input: situation,
    text: {
      format: {
        type: 'json_schema',
        name: 'situation_analysis',
        strict: true,
        schema: buildSituationAnalysisSchema(manifest),
      },
    },
  };
}

export type AnalyzeStepResult =
  | { ok: true; analysis: SituationAnalysis<string>; runtime: ScriptureCatalogRuntime }
  | { ok: false; response: Response };

/**
 * 요청 검증 → OpenAI 호출 → 규격 검증까지 한다.
 * 실패하면 그대로 돌려줄 Response를 함께 준다.
 */
export async function analyzeSituationRequest(
  request: Request,
  deps: EdgeDeps,
  preloadedRuntime?: ScriptureCatalogRuntime,
): Promise<AnalyzeStepResult> {
  const log = deps.log ?? (() => {});
  const requestId = deps.requestId ? deps.requestId() : 'req';
  const failWith = (
    code: ErrorCode,
    status: number,
    detail?: string,
    extraHeaders?: Record<string, string>,
  ) => {
    log(`[${requestId}] ${code} ${status}${detail ? ` (${detail})` : ''}`);
    return { ok: false as const, response: errorResponse(code, status, extraHeaders) };
  };

  // 브라우저 사전 요청(OPTIONS)은 여기서 끝낸다. Analyzer도 OpenAI도 부르지 않는다.
  const preflight = handlePreflight(request);
  if (preflight) {
    return { ok: false as const, response: preflight };
  }

  if (request.method !== 'POST') {
    return failWith('METHOD_NOT_ALLOWED', 405);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return failWith('INVALID_JSON', 400);
  }

  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return failWith('INVALID_INPUT', 400);
  }

  const situationValue = (body as { situation?: unknown }).situation;
  if (typeof situationValue !== 'string' || situationValue.trim().length === 0) {
    return failWith('INVALID_INPUT', 400);
  }

  if (situationValue.length > MAX_SITUATION_LENGTH) {
    return failWith('SITUATION_TOO_LONG', 400);
  }

  // 사용자 입력이 유효한 뒤, quota와 OpenAI 호출 전에 활성 포인터 한 판을 읽는다.
  // 읽기·지문·manifest 중 하나라도 실패하면 정적 카드와 조용히 섞지 않는다.
  let runtime: ScriptureCatalogRuntime;
  try {
    runtime = preloadedRuntime ?? await deps.loadCatalogRuntime();
  } catch {
    return failWith('CATALOG_UNAVAILABLE', 503);
  }

  // 사용량 확인은 OpenAI를 부르기 직전에 한다.
  // 잘못된 요청(형식 오류, 빈 입력, 길이 초과)은 여기까지 오지 않으므로 quota를 쓰지 않는다.
  let quota: Awaited<ReturnType<QuotaChecker>>;
  try {
    quota = await deps.checkQuota(request);
  } catch {
    // 확인 자체가 실패하면 통과시키지 않는다(fail-closed).
    return failWith('RATE_LIMIT_UNAVAILABLE', 503);
  }

  if (quota.status === 'limited') {
    return failWith('RATE_LIMITED', 429, undefined, {
      'Retry-After': String(quota.retryAfterSeconds),
    });
  }

  if (quota.status !== 'allowed') {
    return failWith('RATE_LIMIT_UNAVAILABLE', 503);
  }

  const apiKey = deps.getApiKey();
  if (!apiKey || apiKey.trim().length === 0) {
    return failWith('OPENAI_API_KEY_MISSING', 500);
  }

  let raw: unknown;
  try {
    raw = await deps.callOpenAI(buildOpenAIPayloadForManifest(situationValue, runtime.manifest), apiKey);
  } catch {
    // OpenAI의 상세 오류 메시지는 사용자에게 전달하지 않는다.
    return failWith('OPENAI_REQUEST_FAILED', 502);
  }

  const text = extractOutputText(raw);
  if (!text) {
    return failWith('INVALID_ANALYSIS_RESPONSE', 502, '빈 응답');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return failWith('INVALID_ANALYSIS_RESPONSE', 502, 'JSON 아님');
  }

  // OpenAI가 JSON을 돌려줬다는 이유만으로 그대로 쓰지 않는다.
  const validation = validateSituationAnalysisForDomains(
    parsed,
    [
      ...runtime.manifest.coveredDomains.map((domain) => domain.id),
      ...runtime.manifest.uncoveredDomains.map((domain) => domain.id),
      runtime.manifest.fallbackDomain.id,
    ],
    runtime.manifest.fallbackDomain.id,
    runtime.manifest.situationTags,
  );
  if (!validation.valid) {
    // 원인은 남기되 사용자 문장은 남기지 않는다.
    return failWith('INVALID_ANALYSIS_RESPONSE', 502, validation.errors.join(' / '));
  }

  return { ok: true, analysis: parsed as SituationAnalysis<string>, runtime };
}

/**
 * 응답에 담을 분석 결과. OpenAI 원본과 usage, 사용자 문장은 포함하지 않는다.
 * 영역 우선순위 필드는 이름을 하나씩 적어 명시적으로 옮긴다.
 */
export function toAnalysisPayload<TDomain extends string>(
  analysis: SituationAnalysis<TDomain>,
): SituationAnalysis<TDomain> {
  return {
    domainPriority: analysis.domainPriority,
    primaryDomain: analysis.primaryDomain,
    domainChoiceCandidates: analysis.domainChoiceCandidates,
    secondaryDomains: analysis.secondaryDomains,
    situationTags: analysis.situationTags,
    emotionTags: analysis.emotionTags,
    spiritualQuestionTags: analysis.spiritualQuestionTags,
    prayerModes: analysis.prayerModes,
    pastoralFunctions: analysis.pastoralFunctions,
    safety: {
      level: analysis.safety.level,
      categories: analysis.safety.categories,
    },
    confidence: analysis.confidence,
  };
}
