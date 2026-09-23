/** 후보별 합성 사례 저작 요청과 응답 계약. 외부 호출·파일·환경변수 접근은 없다. */
import {
  canonicalJson, scanForbiddenContent, validateCatalogCandidate,
  type ScriptureCatalogCandidate, type ScriptureCatalogSnapshot, type CatalogCard,
} from './automatic-scripture-catalog-contract.ts';
import { CANDIDATE_GENERATION_CASE_AUTHOR_PROFILE as PROFILE } from './automatic-scripture-catalog-candidate-generation-evidence.ts';
import {
  CANDIDATE_GENERATION_CASES_PER_CARD as CASE_COUNT,
  CASE_AUTHOR_INSTRUCTIONS,
  CASE_AUTHOR_TEXT_MAX_LENGTH as TEXT_MAX,
  buildCaseAuthorResponseFormat,
} from './automatic-scripture-catalog-case-author-contract.ts';
import { CANDIDATE_GENERATION_RUNTIME_CONFIG } from './published-content-candidate-generation-runtime-config.ts';
import { CandidateGenerationError, type GenerationFailure } from './automatic-scripture-catalog-generation-failure.ts';
import { CANDIDATE_GENERATION_REQUEST_MAX_MS } from './automatic-scripture-catalog-generation-deadline.ts';

/** 원본은 generation-failure에 있다. 기존 import 경로를 지키기 위해 다시 내보낸다. */
export { CandidateGenerationError, type GenerationFailure };

/** 원본은 case-author-contract에 있다. 요청·봉인·재검증이 같은 문자열을 쓰도록 여기서는 다시 내보내기만 한다. */
export { CASE_AUTHOR_INSTRUCTIONS };

/** timeoutMs는 이 요청이 바라는 상한이다. 실제 제한은 transport 설정·60초·실행 남은 시간과 함께 가장 짧은 값으로 정해진다. */
export type CaseAuthorSpec = { body: Record<string, unknown>; timeoutMs: number };
export type AuthoredCase = { caseId: string; cardId: string; text: string };

const object = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);
const keysEqual = (v: Record<string, unknown>, keys: string[]) =>
  Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k));
const prose = (card: CatalogCard) => ({
  id: card.id, contextSummary: card.contextSummary, theologicalInsight: card.theologicalInsight,
  userExplanation: card.userExplanation, prayerDirection: card.prayerDirection, misuseGuards: [...card.misuseGuards],
});

/** 모델이 받은 내용만으로 자기 선언한 provenance를 만들지 않도록 호출 전에 후보부터 검증한다. */
export async function buildCaseAuthorRequest(
  candidate: ScriptureCatalogCandidate, base: ScriptureCatalogSnapshot,
): Promise<CaseAuthorSpec> {
  try {
    candidate = structuredClone(candidate);
    base = structuredClone(base);
    if (!(await validateCatalogCandidate(candidate, base)).valid) throw new CandidateGenerationError('input_invalid');
    if (candidate.generation.modelId !== CANDIDATE_GENERATION_RUNTIME_CONFIG.model) {
      throw new CandidateGenerationError('input_invalid');
    }
    const ids = candidate.cards.map(card => card.id);
    return {
      timeoutMs: CANDIDATE_GENERATION_REQUEST_MAX_MS,
      body: {
        model: PROFILE.modelId, instructions: CASE_AUTHOR_INSTRUCTIONS,
        input: canonicalJson({
          profileVersion: PROFILE.profileVersion, promptVersion: PROFILE.promptVersion, schemaVersion: PROFILE.schemaVersion,
          domain: candidate.newDomain ?? base.domains.find(d => d.id === candidate.targetDomainId),
          candidateCards: candidate.cards.map(prose),
          competingCards: base.cards.filter(c => c.domainId === candidate.targetDomainId).map(prose),
        }),
        reasoning: { effort: 'medium' }, max_output_tokens: 8192,
        text: { format: buildCaseAuthorResponseFormat(ids) },
        store: false, stream: false, background: false, truncation: 'disabled', service_tier: 'default', tools: [],
      },
    };
  } catch (error) {
    if (error instanceof CandidateGenerationError) throw error;
    throw new CandidateGenerationError('input_invalid');
  }
}

/** 완료된 한 assistant message만 읽는다. tool output·불완전·거절을 성공 JSON과 섞지 않는다. */
export function readGenerationResponse(raw: unknown, expectedModel: string): unknown {
  try {
    if (!object(raw) || raw.error != null) throw new CandidateGenerationError('provider_error');
    if (raw.status === 'incomplete' || raw.incomplete_details != null) throw new CandidateGenerationError('response_incomplete');
    if (raw.status !== 'completed' || raw.model !== expectedModel || !Array.isArray(raw.output)) {
      throw new CandidateGenerationError('response_invalid');
    }
    const messages: Record<string, unknown>[] = [];
    for (const item of raw.output) {
      if (!object(item)) throw new CandidateGenerationError('response_invalid');
      if (item.type === 'reasoning') continue;
      if (item.type !== 'message' || item.role !== 'assistant' || item.status !== 'completed' || !Array.isArray(item.content)) {
        throw new CandidateGenerationError('response_invalid');
      }
      if (item.content.some(c => object(c) && c.type === 'refusal')) throw new CandidateGenerationError('model_refusal');
      messages.push(item);
    }
    if (messages.length !== 1) throw new CandidateGenerationError('response_invalid');
    const content = messages[0].content as unknown[];
    if (content.length !== 1 || !object(content[0]) || content[0].type !== 'output_text' || typeof content[0].text !== 'string') {
      throw new CandidateGenerationError('response_invalid');
    }
    return JSON.parse(content[0].text);
  } catch (error) {
    if (error instanceof CandidateGenerationError) throw error;
    throw new CandidateGenerationError('response_invalid');
  }
}

/** 1:1 카드 대응과 모든 문장을 먼저 검사한다. 한 건이라도 어긋나면 부분 계획을 만들지 않는다. */
export function interpretCaseAuthorResponse(
  raw: unknown, candidate: ScriptureCatalogCandidate, base: ScriptureCatalogSnapshot,
): AuthoredCase[] {
  const parsed = readGenerationResponse(raw, PROFILE.modelId);
  const ids = candidate.cards.map(card => card.id);
  if (!object(parsed) || !keysEqual(parsed, ['scenarios']) || !object(parsed.scenarios) || !keysEqual(parsed.scenarios, ids)) {
    throw new CandidateGenerationError('response_contract_invalid');
  }
  const literals = [
    ...base.domains.map(d => d.id),
    candidate.targetDomainId,
    ...base.cards.map(c => c.referenceLabel),
    ...candidate.cards.map(c => c.referenceLabel),
  ];
  const seen = new Set<string>();
  const plan: AuthoredCase[] = [];
  for (const cardId of ids) {
    const texts = parsed.scenarios[cardId];
    if (!Array.isArray(texts) || texts.length !== CASE_COUNT) throw new CandidateGenerationError('response_contract_invalid');
    for (let i = 0; i < texts.length; i += 1) {
      const text = texts[i];
      if (typeof text !== 'string' || text.length === 0 || text.length > TEXT_MAX || text.trim() !== text ||
          /SC-\d{3,5}|\d+\s*:\s*\d+/.test(text) || literals.some(literal => text.includes(literal)) ||
          scanForbiddenContent(text).length > 0) throw new CandidateGenerationError('response_contract_invalid');
      const normalized = text.normalize('NFKC').replace(/[\p{P}\p{Z}\s]/gu, '').toLowerCase();
      if (!normalized || seen.has(normalized)) throw new CandidateGenerationError('response_contract_invalid');
      seen.add(normalized);
      plan.push({ caseId: `GEN-${cardId}-${String(i + 1).padStart(2, '0')}`, cardId, text });
    }
  }
  return plan;
}
