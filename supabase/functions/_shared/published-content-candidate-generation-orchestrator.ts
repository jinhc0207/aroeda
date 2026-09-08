/**
 * Candidate Generation 전체를 실제로 잇는 자리.
 *
 * commit된 Orchestration Contract가 순서와 조건을 못 박아 두었다.
 * 이 파일은 그 순서대로 이미 있는 함수들을 부르는 glue layer일 뿐이다.
 *
 * 새 판단을 만들지 않는다.
 *   지문을 맞춰 보는 것, 모델 입력을 만드는 것, 프롬프트를 쓰는 것,
 *   실제로 부르는 것, 조립하는 것 — 전부 이미 주인이 있다.
 *   여기서 하는 일은 그 주인들을 계약이 정한 순서로 부르는 것뿐이다.
 *
 * 이 파일이 새로 갖는 것 하나.
 *   적어 두는 자리(Store)는 아직 실제 구현이 없다.
 *   그래서 그 자리만 부르는 쪽이 주입한다.
 *
 * 환경변수를 읽지 않는다. Supabase client를 만들지 않는다.
 * 열쇠와 store 함수는 전부 부르는 쪽이 넘긴다.
 */

import {
  buildCandidateModelGenerationInput,
} from './published-content-candidate-generation-contract.ts';
import { buildCandidateGenerationPrompt } from './published-content-candidate-generation-prompt.ts';
import { buildCandidateGenerationOpenAIRequestSpec } from './published-content-candidate-generation-openai-adapter-contract.ts';
import { callCandidateGenerationOpenAIFetchTransport } from './published-content-candidate-generation-openai-fetch-transport.ts';
import { buildPublishedContentCandidate } from './published-content-candidate-builder.ts';
import type { BiblicalResearchResult } from './biblical-researcher.ts';
import {
  builderOutcomeToOrchestrationResult,
  canProceedToCandidateBuilder,
  canProceedToCandidateStore,
  preflightFailureToOrchestrationResult,
  storeOutcomeToOrchestrationResult,
  transportOutcomeToOrchestrationResult,
  verifyCandidateGenerationLineage,
  type CandidateGenerationOrchestrationInput,
  type CandidateGenerationOrchestrationResult,
  type CandidateGenerationStoreCall,
} from './published-content-candidate-generation-orchestration-contract.ts';

/* ------------------------------------------------------------------ */
/* 부르는 쪽이 넘겨야 하는 것                                           */
/* ------------------------------------------------------------------ */

/**
 * 실행에 필요한 것 셋.
 *
 * apiKey와 fetchImpl은 Fetch Transport의 config 모양 그대로다.
 * 여기서 새 모양을 만들지 않는다.
 *
 * storeCandidate는 계약이 정한 타입 그대로다.
 * 실제 DB RPC는 이 안에 없다. 무엇을 넘길지는 부르는 쪽이 정한다.
 */
export type CandidateGenerationOrchestratorDependencies = {
  apiKey: unknown;
  fetchImpl?: typeof fetch;
  storeCandidate: CandidateGenerationStoreCall;
};

/**
 * Candidate Generation 한 번을 실행한다.
 *
 * Orchestration Contract의 열두 단계를 그대로 따른다.
 *
 *   ①~⑤ lineage preflight — 계약의 verifyCandidateGenerationLineage 그대로.
 *       여기서 멈추면 프롬프트도, 요청도, 모델 호출도 만들어지지 않는다.
 *   ⑥ 프롬프트, ⑦ 요청 — 값은 하나도 여기서 정하지 않는다.
 *   ⑧ 모델 호출 — 최대 한 번. 실패해도 다시 부르지 않는다.
 *   ⑨ 결과 분기 — 계약의 분류 함수 그대로.
 *   ⑩ 조립 — 모델이 썼을 때만.
 *   ⑪ 적어 두기 — 조립이 성공했을 때만, 정확히 한 번.
 *   ⑫ 적힌 뒤에만 성공을 알린다.
 */
export async function runCandidateGenerationOrchestrator(
  input: CandidateGenerationOrchestrationInput,
  deps: CandidateGenerationOrchestratorDependencies,
): Promise<CandidateGenerationOrchestrationResult> {
  // ①~⑤ 모델을 부르기 전에 지문부터 맞춰 본다.
  const lineage = await verifyCandidateGenerationLineage(input);
  if (!lineage.ok) {
    return preflightFailureToOrchestrationResult(lineage);
  }

  // ⑥ 프롬프트. ⑦ 요청. 규칙은 각자 계약이 갖고 있다. 여기서 다시 만들지 않는다.
  const prompt = buildCandidateGenerationPrompt(lineage.generationInput);
  const requestSpec = buildCandidateGenerationOpenAIRequestSpec(prompt);

  // ⑧ 모델 호출. 이 함수 자체가 최대 한 번만 보낸다(재시도 없음).
  // 열쇠가 쓸 수 없으면 이 함수 안에서 이미 막힌다 — 여기서 다시 확인하지 않는다.
  const transportOutcome = await callCandidateGenerationOpenAIFetchTransport(
    requestSpec,
    lineage.generationInput,
    { apiKey: deps.apiKey, fetchImpl: deps.fetchImpl },
  );

  // ⑨ 결과 분기. validated_generate가 아니면 여기서 끝난다.
  // canProceedToCandidateBuilder(=canInvokeCandidateBuilder)로 다시 확인한다.
  // 새 eligible outcome 목록을 만드는 것이 아니라, 판단 그 자체를 그대로 재사용하는 것이다.
  if (transportOutcome.outcome !== 'validated_generate' || !canProceedToCandidateBuilder(transportOutcome)) {
    return transportOutcomeToOrchestrationResult(transportOutcome) ?? { category: 'generation_failure' };
  }

  // ⑩ 조립. 모델이 정하면 안 되는 다섯 항목은 여기서 채우지 않는다 — Builder가 한다.
  const builderOutcome = await buildPublishedContentCandidate({
    researchResultHash: input.researchResultHash,
    researchResult: input.researchResult as BiblicalResearchResult,
    draft: transportOutcome.response.draft,
  });

  if (!builderOutcome.ok || !canProceedToCandidateStore(builderOutcome)) {
    return builderOutcomeToOrchestrationResult(builderOutcome) ?? { category: 'candidate_build_failure' };
  }

  // ⑪ 적어 두기. 정확히 한 번. 실패해도 다시 부르지 않는다.
  // candidateHash를 여기서 다시 계산하지 않는다. Builder가 만든 값을 그대로 넘긴다.
  const storeOutcome = await deps.storeCandidate({
    candidateHash: builderOutcome.candidateHash,
    researchResultHash: input.researchResultHash,
    candidate: builderOutcome.candidate,
  });

  // ⑫ 적힌 뒤에만 성공이다. 적히지 못했으면 모델이 썼어도 성공이 아니다.
  return storeOutcomeToOrchestrationResult(storeOutcome);
}
