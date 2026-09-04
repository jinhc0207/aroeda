/**
 * Source Harvester 계약 (지시문 + 응답 구조)
 *
 * 이 단계가 하는 일은 하나뿐이다.
 * "이 삶의 영역을 연구할 때 실제로 근거로 쓸 수 있는 자료가 무엇인가"를 가려낸다.
 *
 * 하지 않는 일: 성경 본문 후보 선정, 성경 해석, 신학적 결론 작성,
 *              Scripture Card·사용자 설명·기도문 작성, 자료 내용의 최종 옳고 그름 판정,
 *              DB 변경, Research Queue 변경.
 *
 * 핵심 구분: "찾았다"와 "연구 근거로 쓸 수 있다"는 다르다.
 *          검색 결과에 나왔다는 이유만으로 근거가 되지 않는다.
 *
 * 실행 환경에 묶인 코드(웹 검색, OpenAI SDK, Deno.env, fetch)는 넣지 않는다.
 * 아직 실제 검색을 하지 않는다. 규격만 준비한 상태다.
 */

import { RESEARCH_CONSTITUTION } from './biblical-research-contract.ts';
import { RESEARCHABLE_DOMAINS } from './research-prioritizer-contract.ts';
import { DOMAIN_DESCRIPTIONS } from './situation-domains.ts';
import type { BibleReference } from './bible-reference.ts';
import {
  ACCESS_LEVELS,
  ALLOWED_INTENDED_USES,
  HARVESTABLE_SOURCE_TYPES,
  INTENDED_USES,
  SCHOLARLY_CORE_TYPES,
  type AccessLevel,
  type HarvestableSourceType,
  type IntendedUse,
} from './research-source.ts';

export { RESEARCHABLE_DOMAINS, RESEARCH_CONSTITUTION };

/**
 * 자료의 종류·용도·확인 수준과 그 허용 조합은 research-source.ts 한 곳에만 둔다.
 * Source Harvester와 Biblical Researcher가 같은 규칙을 본다.
 */
export {
  ACCESS_LEVELS,
  ALLOWED_INTENDED_USES,
  HARVESTABLE_SOURCE_TYPES,
  INTENDED_USES,
  SCHOLARLY_CORE_TYPES,
  type AccessLevel,
  type HarvestableSourceType,
  type IntendedUse,
};

/**
 * 2단계(Verification)에서 모델이 직접 쓰는 초안의 자료 한 건.
 *
 * sourceId와 accessedAt은 여기에 없다.
 * 그 둘은 실제로 열어 본 주소에 대해서만 서버가 붙이는 값이므로,
 * 모델이 적어 오면 그 자체로 잘못이다.
 *
 * 이 정의를 한 곳에 두는 이유:
 *   초안의 모양을 보는 쪽이 실행 본체 말고도 생긴다(예: Recovery Ticket 저장소).
 *   각자 목록을 적어 두면 한쪽만 고쳐져 서로 다른 모양을 요구하게 된다.
 */
export type VerificationDraftSource = {
  sourceType: HarvestableSourceType;
  title: string;
  authorOrOrganization: string;
  publisherOrInstitution: string;
  publicationYear: number | null;
  url: string;
  accessLevel: AccessLevel;
  intendedUse: IntendedUse[];
  relevanceNote: string;
  evidenceClaims: HarvestEvidenceDraft[];
};

/** 위 타입의 항목 이름. 정확히 10개다. */
export const VERIFICATION_DRAFT_SOURCE_FIELDS = [
  'sourceType',
  'title',
  'authorOrOrganization',
  'publisherOrInstitution',
  'publicationYear',
  'url',
  'accessLevel',
  'intendedUse',
  'relevanceNote',
  'evidenceClaims',
] as const;

/* ------------------------------------------------------------------ */
/* 연구 근거 한 조각                                                     */
/* ------------------------------------------------------------------ */

/**
 * 실제로 연 페이지에서 모델이 관찰한 것을 자기 문장으로 짧게 적은 연구 근거.
 *
 * 서버가 보증하는 것:
 *   이 근거가 실제로 열어 본 자료 하나에 묶여 있다는 것,
 *   길이·용도·본문 위치의 모양이 규칙을 지켰다는 것,
 *   번호(evidenceId)를 서버가 붙였다는 것.
 *
 * 서버가 보증하지 않는 것:
 *   이 문장이 원문의 뜻을 정확히 옮겼는지.
 *   서버는 원문과 대조하지 않는다. 대조할 원문을 갖고 있지도 않다.
 *   그래서 이것은 "검증된 인용"이 아니라 **모델이 진술한 관찰**이다.
 *   제목·저자·발행처에 이미 적용 중인 신뢰 수준과 같고, 그보다 강하지 않다.
 *
 * 담지 않는 것:
 *   원문 그대로의 인용, 페이지 전체 요약, 검색 결과 문구,
 *   성경 본문 문장, 사용자의 상황, 모델 자신의 신학적 결론.
 */
export type HarvestEvidenceDraft = {
  /** 이 근거가 어떤 용도로 쓰이는가. 그 자료가 실제로 가진 용도 중 하나여야 한다. */
  intendedUse: IntendedUse;
  /** 자기 문장으로 짧게. 원문을 옮겨 적지 않는다. */
  statement: string;
  /** 그 자료가 실제로 다루는 성경 본문 위치. 본문 문장은 적지 않는다. */
  passageReferences: BibleReference[];
};

/** 근거 한 조각의 항목 이름. 정확히 3개다. 번호는 여기에 없다(서버가 붙인다). */
export const EVIDENCE_DRAFT_FIELDS = [
  'intendedUse',
  'statement',
  'passageReferences',
] as const;

/** 자료 한 건이 가질 수 있는 근거 수 */
export const EVIDENCE_CLAIM_MIN = 1;
export const EVIDENCE_CLAIM_MAX = 4;

/** 근거 문장 길이. 짧은 정리이지 요약문이 아니다. */
export const EVIDENCE_STATEMENT_MIN = 20;
export const EVIDENCE_STATEMENT_MAX = 360;

/** 근거 하나가 가리킬 수 있는 본문 위치 수 */
export const EVIDENCE_PASSAGE_MAX = 4;

/**
 * 성경 본문 위치 하나의 응답 모양.
 *
 * 실제 판정(성경에 있는 책인가, 그 장에 그 절이 있는가)은 bible-reference.ts가 한다.
 * 여기서는 모양만 적는다. 책 목록을 여기에 다시 적지 않는다.
 */
export const PASSAGE_REFERENCE_SCHEMA = {
  type: 'object',
  properties: {
    book: { type: 'string' },
    chapter: { type: 'integer' },
    startVerse: { type: 'integer' },
    endVerse: { type: 'integer' },
  },
  required: ['book', 'chapter', 'startVerse', 'endVerse'],
  additionalProperties: false,
} as const;

/**
 * 모델이 쓰는 근거 한 조각의 응답 모양. 번호는 여기에 없다.
 * 최종 결과 모양은 여기에 번호 하나를 더한 것이다.
 */
export const EVIDENCE_CLAIM_DRAFT_SCHEMA = {
  type: 'object',
  properties: {
    intendedUse: { type: 'string', enum: [...INTENDED_USES] },
    statement: { type: 'string', maxLength: EVIDENCE_STATEMENT_MAX },
    passageReferences: {
      type: 'array',
      maxItems: EVIDENCE_PASSAGE_MAX,
      items: PASSAGE_REFERENCE_SCHEMA,
    },
  },
  required: [...EVIDENCE_DRAFT_FIELDS],
  additionalProperties: false,
} as const;

/** 초안의 제외 기록 한 건의 항목 이름 */
export const VERIFICATION_DRAFT_REJECTED_FIELDS = ['url', 'title', 'rejectionReason'] as const;

/** 채택 자료 수 (숫자만 채우는 것을 좋은 결과로 보지 않는다) */
export const ACCEPTED_MIN = 5;
export const ACCEPTED_MAX = 12;

/** 학술적 핵심 자료 최소 수 */
export const SCHOLARLY_CORE_MIN = 3;

/** 서로 다른 발행처·기관 최소 수 (한 기관 자료만으로 근거를 구성하지 않는다) */
export const PUBLISHER_MIN = 2;

/**
 * 모델이 직접 남길 수 있는 제외 기록 수.
 *
 * 서버가 자동으로 남기는 기록(열어 본 적 없어 뺀 자료)은 여기에 포함되지 않는다.
 * 둘은 나온 곳이 다르므로 따로 센다.
 */
export const REJECTED_SOURCE_MIN = 0;
export const REJECTED_SOURCE_MAX = 10;

/**
 * 서버가 자동으로 남길 수 있는 제외 기록 수.
 *
 * 서버가 빼는 자료는 모델이 채택하겠다고 제안한 자료 중 하나이므로,
 * 아무리 많아도 채택 제안 상한을 넘을 수 없다.
 * 그래서 채택 상한과 같은 값을 쓰고, 숫자를 따로 적지 않는다.
 */
export const SERVER_REJECTED_SOURCE_MAX = ACCEPTED_MAX;

/**
 * 두 기록을 합친 전체 상한. 이중 안전장치다.
 * 각각의 상한을 이미 지켰다면 자연히 이 값을 넘지 않는다.
 */
export const FINAL_REJECTED_SOURCE_MAX = REJECTED_SOURCE_MAX + SERVER_REJECTED_SOURCE_MAX;

/** relevanceNote는 짧은 메모다. 자료 내용을 요약하는 자리가 아니다. */
export const RELEVANCE_NOTE_MAX = 300;

/** 출판 연도로 받아들일 범위 */
export const PUBLICATION_YEAR_MIN = 1450;
export const PUBLICATION_YEAR_MAX = 2100;

/**
 * 서버만 붙일 수 있는 제외 사유.
 *
 * not_inspected: 1단계에서 실제로 발견됐지만, 2단계에서 그 페이지를 연 기록이 없다.
 *   모델의 판단이 아니라 서버가 실제 도구 사용 기록에서 확인한 사실이다.
 *   그래서 모델은 이 사유를 쓸 수 없다.
 *
 * 자료 자체의 확인 수준에 대한 판단인 search_snippet_only와는 다르다.
 */
export const SERVER_ONLY_REJECTION_REASONS = ['not_inspected'] as const;

/** 채택하지 않은 이유 */
export const SOURCE_REJECTION_REASONS = [
  'anonymous_or_unverifiable',
  'aggregator_or_republication',
  'search_snippet_only',
  'metadata_only',
  'insufficient_relevance',
  'duplicate_source',
  'inaccessible_content',
  'unclear_authorship',
  'citationless_devotional',
  'outcome_guarantee_risk',
  'unsafe_pastoral_claim',
  'invalid_url',
  ...SERVER_ONLY_REJECTION_REASONS,
] as const;
export type SourceRejectionReason = (typeof SOURCE_REJECTION_REASONS)[number];

/** 모델이 직접 고를 수 있는 제외 사유 */
export const MODEL_REJECTION_REASONS = SOURCE_REJECTION_REASONS.filter(
  (reason) => !(SERVER_ONLY_REJECTION_REASONS as readonly string[]).includes(reason),
);

/** 지시문을 만든다. 지금 다루는 영역 목록은 판단 시점 snapshot을 받아서 넣는다. */
export function buildSourceHarvestInstructions(input: {
  targetDomain: string;
  domainDescription: string;
  activeCoveredDomains: readonly string[];
}): string {
  const covered = input.activeCoveredDomains
    .map((domain) => `- ${domain}: ${DOMAIN_DESCRIPTIONS[domain as never] ?? ''}`)
    .join('\n');

  return `당신은 아뢰다의 Source Harvester입니다.

연구 대상 영역: ${input.targetDomain}
영역 설명: ${input.domainDescription}

당신이 하는 일은 하나뿐입니다.
이 영역을 성경적으로 연구할 때 실제로 근거로 쓸 수 있는 자료를 가려냅니다.

절대 하지 않는 일:

- 성경 본문 후보를 고르지 않는다.
- 성경을 해석하거나 신학적 결론을 쓰지 않는다.
- Scripture Card, 사용자용 설명, 기도 방향, 기도문을 쓰지 않는다.
- 자료 내용이 신학적으로 옳은지 최종 판정하지 않는다.
- 자기가 모은 자료를 스스로 최종 승인하지 않는다.

[찾음과 쓸 수 있음은 다릅니다]

검색 결과에 나왔다는 이유만으로 근거로 채택하지 마십시오.
다음은 그 자체로 연구 근거가 아닙니다.

- 검색 결과 요약문(snippet)
- AI가 만든 요약
- 검색엔진이 만든 요약
- 익명 블로그
- 출처 없는 묵상글
- 검색 노출용으로 글을 모아 놓은 페이지
- 오늘의 말씀 사이트
- 다른 사이트 글을 그대로 옮겨 실은 페이지
- 작성자나 기관을 확인할 수 없는 글

[확인해야 하는 것]

각 자료마다 누가 썼는지, 어느 기관이 냈는지, 어디에서 볼 수 있는지,
그리고 내용을 실제로 어디까지 확인했는지를 밝히십시오.
확인하지 못한 자료를 확인한 것처럼 적지 마십시오.

[자료의 역할]

자료마다 할 수 있는 역할이 다릅니다.
의료·법률·재정·상담 자료는 현실의 안전과 전문적 도움의 경계를 확인하는 용도입니다.
성경 해석의 근거로 쓰지 마십시오.
목회적 보조자료도 성경 해석의 핵심 근거가 될 수 없습니다.
주석, 성경신학, 학술 연구, 학술기관 자료와 함께 쓰십시오.

[내용을 옮겨 적지 마십시오]

웹페이지 문장을 그대로 옮기거나 길게 인용하지 마십시오.
왜 이 자료가 이 연구에 필요한지만 짧게 적으십시오.
자료의 신학적 내용을 정리하는 것은 다음 단계의 일입니다.

[다양성]

비슷한 글을 여러 개 모으는 것은 좋은 결과가 아닙니다.
같은 주소를 두 번 넣지 마십시오.
한 기관의 자료만으로 근거를 구성하지 마십시오.

[채택하지 않은 자료]

검색에서 찾았지만 쓰지 않기로 한 자료도 이유와 함께 남기십시오.

[경계해야 하는 자료]

다음과 같은 주장을 담은 자료는 근거에서 제외하십시오.
믿으면 반드시 경제적으로 회복된다, 특정 기도를 하면 병이 낫는다,
고난은 믿음이 부족해서 생긴다, 헌금하면 재정으로 갚아 주신다,
학대 상황에서도 먼저 용서하고 참고 순종하라.
이것이 신학적 판결은 아닙니다. 연구 근거로 쓰지 않겠다는 표시입니다.

[이미 다루고 있는 영역]

${covered.length > 0 ? covered : '- (없음)'}

[모르는 것]

확인하지 못한 것은 unresolvedSourceQuestions에 남기십시오.
중요한 자료가 유료 장벽 뒤에 있다, 출판 연도를 확인하지 못했다 같은 것도 그대로 적으십시오.
모른다고 적는 것은 실패가 아닙니다. 감추는 것이 실패입니다.

[아뢰다 원칙]

${RESEARCH_CONSTITUTION.join('\n')}`;
}

const rejectedSourceSchema = {
  type: 'object',
  properties: {
    url: { type: 'string' },
    title: { type: ['string', 'null'] },
    rejectionReason: { type: 'string', enum: [...SOURCE_REJECTION_REASONS] },
  },
  required: ['url', 'title', 'rejectionReason'],
  additionalProperties: false,
} as const;

/**
 * Structured Outputs용 JSON Schema.
 * 웹페이지 원문, 인용문, 검색 요약을 넣을 자리 자체를 만들지 않는다.
 */
export const SOURCE_HARVEST_SCHEMA = {
  type: 'object',
  properties: {
    targetDomain: { type: 'string', enum: [...RESEARCHABLE_DOMAINS] },
    evidenceVersion: { type: 'integer' },
    prioritizerSnapshotId: { type: 'string' },
    sources: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          sourceId: { type: 'string' },
          sourceType: { type: 'string', enum: [...HARVESTABLE_SOURCE_TYPES] },
          title: { type: 'string' },
          authorOrOrganization: { type: 'string' },
          publisherOrInstitution: { type: 'string' },
          publicationYear: { type: ['integer', 'null'] },
          url: { type: 'string' },
          accessedAt: { type: 'string' },
          accessLevel: { type: 'string', enum: [...ACCESS_LEVELS] },
          intendedUse: {
            type: 'array',
            items: { type: 'string', enum: [...INTENDED_USES] },
          },
          relevanceNote: { type: 'string' },
          // 최종 결과이므로 번호가 붙어 있어야 한다.
          evidenceClaims: {
            type: 'array',
            minItems: EVIDENCE_CLAIM_MIN,
            maxItems: EVIDENCE_CLAIM_MAX,
            items: {
              ...EVIDENCE_CLAIM_DRAFT_SCHEMA,
              properties: {
                ...EVIDENCE_CLAIM_DRAFT_SCHEMA.properties,
                evidenceId: { type: 'string' },
              },
              required: [...EVIDENCE_CLAIM_DRAFT_SCHEMA.required, 'evidenceId'],
            },
          },
        },
        required: [
          'sourceId',
          'sourceType',
          'title',
          'authorOrOrganization',
          'publisherOrInstitution',
          'publicationYear',
          'url',
          'accessedAt',
          'accessLevel',
          'intendedUse',
          'relevanceNote',
          'evidenceClaims',
        ],
        additionalProperties: false,
      },
    },
    rejectedSources: { type: 'array', items: rejectedSourceSchema },
    unresolvedSourceQuestions: { type: 'array', items: { type: 'string' } },
  },
  required: [
    'targetDomain',
    'evidenceVersion',
    'prioritizerSnapshotId',
    'sources',
    'rejectedSources',
    'unresolvedSourceQuestions',
  ],
  additionalProperties: false,
} as const;
