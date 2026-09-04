/**
 * Biblical Researcher 실행 계약 (순수 로직)
 *
 * 무엇을 정하는가:
 *   모델에게 무엇을 보여줄 것인가.
 *   무엇을 출력하게 할 것인가.
 *   돌아온 답을 어디에 다시 묶을 것인가.
 *
 * 무엇을 정하지 않는가:
 *   어느 모델을 쓸 것인가, 얼마나 기다릴 것인가, 얼마나 쓸 것인가.
 *   그것은 실행 정책(biblical-researcher-runtime-policy.ts)이 정한다.
 *   이 계약은 어느 모델을 쓰는지 몰라도 성립한다.
 *   실제 요청을 보내는 일도 여기서 하지 않는다.
 *
 * 유일한 권위 있는 입력은 근거 꾸러미 하나다.
 *   영역·근거 판본·판단 시점·자료·근거를 따로 받지 않는다.
 *   따로 받으면 꾸러미와 어긋난 값이 들어올 수 있다.
 *
 * 이 파일이 하지 않는 일:
 *   네트워크, DB, 환경변수, OpenAI 호출, 웹 검색.
 *   근거 문장을 고치거나 줄이지 않는다. 자료를 빼지 않는다.
 *   꾸러미를 바꾸지 않는다.
 */

import { BIBLICAL_RESEARCH_SCHEMA, buildBiblicalResearchInstructions } from './biblical-research-contract.ts';
import type { BiblicalResearchHandoff } from './biblical-research-handoff.ts';

/**
 * 모델 요청 횟수. 한 번뿐이다.
 *
 * 이 단계는 새로 조사하는 단계가 아니라
 * Source Harvester가 이미 확인한 근거를 해석하는 단계다.
 */
export const BIBLICAL_RESEARCH_EXPECTED_MODEL_CALLS = 1;

/**
 * 쓸 수 있는 도구. 없다.
 *
 * 웹 검색도, 페이지 열기도 없다.
 * 근거가 모자라면 새로 찾는 것이 아니라 후보를 버리거나 남은 물음에 적는다.
 */
export const BIBLICAL_RESEARCH_TOOLS = [] as const;

/**
 * 대화를 저장하지 않는다.
 *
 * 이 값의 주인은 여기다. 실행 정책은 가져다 쓰기만 한다.
 * 같은 값을 두 곳에서 정하면 언젠가 서로 달라진다.
 */
export const BIBLICAL_RESEARCH_STORE = false;

/** 모델이 보는 자료 한 건. 꾸러미에 있는 것을 그대로 옮긴다. */
export type BiblicalResearchModelSource = {
  sourceId: string;
  sourceType: string;
  title: string;
  authorOrOrganization: string;
  publisherOrInstitution: string;
  publicationYear: number | null;
  url: string;
  accessedAt: string;
  accessLevel: string;
  intendedUse: string[];
  evidenceClaims: {
    evidenceId: string;
    intendedUse: string;
    statement: string;
    passageReferences: { book: string; chapter: number; startVerse: number; endVerse: number }[];
  }[];
};

/**
 * 모델에게 보내는 내용.
 *
 * 꾸러미 지문(evidenceSetHash)은 여기 없다.
 * 그것은 서버가 들고 있는 값이고, 모델이 볼 이유도 만들 이유도 없다.
 */
export type BiblicalResearchModelInput = {
  targetDomain: string;
  domainDescription: string;
  evidenceVersion: number;
  prioritizerSnapshotId: string;
  activeCoveredDomains: string[];
  sources: BiblicalResearchModelSource[];
  /** 자료를 모으는 단계에서 남은 물음. 연구 단계의 물음과 다르다. */
  sourceUnresolvedQuestions: string[];
};

/**
 * 한 번의 실행에 필요한 것.
 *
 * 어느 모델을 쓸지, 얼마나 기다릴지는 여기에 없다.
 * 그 정책이 정해지면 실제 요청을 만드는 바깥층이 이 계획에 얹는다.
 */
export type BiblicalResearchExecutionPlan = {
  instructions: string;
  modelInput: BiblicalResearchModelInput;
  /** 응답 형식은 하나뿐이다. 여기서 다시 적지 않는다. */
  structuredOutputSchema: typeof BIBLICAL_RESEARCH_SCHEMA;
  tools: typeof BIBLICAL_RESEARCH_TOOLS;
  store: typeof BIBLICAL_RESEARCH_STORE;
  expectedModelCalls: typeof BIBLICAL_RESEARCH_EXPECTED_MODEL_CALLS;
};

/**
 * 근거 꾸러미 하나로 실행 계획을 만든다.
 *
 * 꾸러미를 바꾸지 않는다. 새 배열과 객체로 옮겨 담기만 한다.
 * 근거 문장, 본문 위치, 번호는 한 글자도 손대지 않는다.
 *
 * 토큰을 아끼려고 자료나 근거를 빼지 않는다.
 * 수와 길이는 이미 수집 단계에서 정해져 있다. 여기서 두 번째 줄임을 만들지 않는다.
 */
export function buildBiblicalResearchExecutionPlan(input: {
  handoff: BiblicalResearchHandoff;
}): BiblicalResearchExecutionPlan {
  const { handoff } = input;
  const { brief } = handoff;

  const modelInput: BiblicalResearchModelInput = {
    targetDomain: brief.targetDomain,
    domainDescription: brief.domainDescription,
    evidenceVersion: brief.evidenceVersion,
    prioritizerSnapshotId: brief.prioritizerSnapshotId,
    activeCoveredDomains: [...brief.activeCoveredDomains],

    sources: handoff.sources.map((source) => ({
      sourceId: source.sourceId,
      sourceType: source.sourceType,
      title: source.title,
      authorOrOrganization: source.authorOrOrganization,
      publisherOrInstitution: source.publisherOrInstitution,
      publicationYear: source.publicationYear,
      url: source.url,
      accessedAt: source.accessedAt,
      accessLevel: source.accessLevel,
      intendedUse: [...source.intendedUse],
      evidenceClaims: source.evidenceClaims.map((claim) => ({
        evidenceId: claim.evidenceId,
        intendedUse: claim.intendedUse,
        statement: claim.statement,
        passageReferences: claim.passageReferences.map((reference) => ({ ...reference })),
      })),
    })),

    sourceUnresolvedQuestions: [...handoff.sourceUnresolvedQuestions],
  };

  return {
    // 지시문은 한 곳에만 있다. 여기서 다시 쓰지 않는다.
    instructions: buildBiblicalResearchInstructions({
      targetDomain: brief.targetDomain,
      domainDescription: brief.domainDescription,
      activeCoveredDomains: brief.activeCoveredDomains,
    }),
    modelInput,
    structuredOutputSchema: BIBLICAL_RESEARCH_SCHEMA,
    tools: BIBLICAL_RESEARCH_TOOLS,
    store: BIBLICAL_RESEARCH_STORE,
    expectedModelCalls: BIBLICAL_RESEARCH_EXPECTED_MODEL_CALLS,
  };
}

/**
 * 모델이 만든 답을 최종 결과로 만드는 길.
 *
 * 모델이 만드는 것은 초안뿐이다. 최종 결과는 서버가 만든다.
 *
 *   모델 응답
 *   → BiblicalResearchDraftResult
 *   → bindBiblicalResearchEvidence({ draft, handoff })
 *   → BiblicalResearchResult
 *
 * 그 사이를 건너뛰는 길은 없다.
 * 그리고 반드시 계획을 만들 때 쓴 **그 꾸러미**를 다시 넘겨야 한다.
 * 모델 응답으로 꾸러미를 다시 만들지 않는다.
 */
export const BIBLICAL_RESEARCH_FINALIZATION_RULE =
  '모델 응답 → 초안 → bindBiblicalResearchEvidence(초안, 같은 꾸러미) → 최종 결과';
