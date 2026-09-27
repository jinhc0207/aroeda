import { SCRIPTURE_CARDS } from '@/data/scripture-cards';
import type { SituationDomain } from '@/data/situation-domains';
import { ensureAnonymousSession } from '@/lib/anonymous-session';
import {
  parseRetryAfterSeconds,
  type RecommendationDeps,
} from '@/lib/request-recommendation';
import { supabase } from '@/lib/supabase';
import { SCRIPTURE_CATALOG_RUNTIME_CLIENT_VERSION } from '../../supabase/functions/_shared/automatic-scripture-catalog-runtime';

/** 서버가 준 카드 id가 실제로 우리가 가진 정적 카드인지 확인한다. */
const cardExists = (cardId: string) => SCRIPTURE_CARDS.some((card) => card.id === cardId);

/** 서버가 준 정적 카드·영역 짝을 그대로 믿지 않는다. */
const cardBelongsToDomain = (cardId: string, domain: SituationDomain) => {
  const card = SCRIPTURE_CARDS.find((item) => item.id === cardId);
  return card ? card.domains.includes(domain) : false;
};

async function invokeRecommendScripture(body: {
  situation: string;
  catalogRuntimeVersion: typeof SCRIPTURE_CATALOG_RUNTIME_CLIENT_VERSION;
}) {
  const { data, error } = await supabase.functions.invoke('recommend-scripture', { body });

  if (error) {
    const context = (error as {
      context?: { status?: unknown; headers?: { get?: (name: string) => unknown } };
    }).context;
    const status = context?.status;
    const retryAfterSeconds = parseRetryAfterSeconds(context?.headers?.get?.('Retry-After'));
    return {
      ok: false as const,
      httpStatus: typeof status === 'number' ? status : undefined,
      ...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}),
    };
  }

  return { ok: true as const, data };
}

/** 첫 입력과 추가 설명 화면이 같은 세션·호출·응답 검증 규칙을 사용한다. */
export const APP_RECOMMENDATION_DEPS: RecommendationDeps = {
  ensureSession: () => ensureAnonymousSession(supabase.auth),
  invokeRecommendScripture,
  cardExists,
  cardBelongsToDomain,
};
