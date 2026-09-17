/**
 * 자동 Scripture Catalog가 실제로 쓸 validator profile · 신학 검수 rubric · 실행 순서의 단일 원본.
 *
 * 이 파일이 정하는 것
 *   1. 검증 항목 8개를 누가 판정하는가 (profile 4개).
 *   2. 신학 평가자가 무엇을 보고 판정하는가 (버전형 rubric + 지문).
 *   3. 어떤 순서로 돌리고, 마지막 평가자를 언제 부를 수 있는가 (단계 데이터 + 순수 게이트 함수).
 *
 * 이 파일이 정하지 않는 것
 *   - DB 등록. profile을 DB에 넣는 migration은 아직 없다. 그래서 자동 활성화는 계속 닫혀 있다.
 *   - 실행. 실행기도 네트워크 호출도 여기에 없다. 순서와 조건을 데이터와 순수 함수로만 적어 둔다.
 *
 * 독립성에 대하여
 *   독립성은 평가자 이름이 아니라 등록된 independenceGroup으로만 판단한다.
 *   같은 모델 계열·같은 운영 주체는 같은 그룹이다. 그래서 다음은 독립 평가 둘이 아니다.
 *     - Sol + Terra (같은 gpt-5.6 계열)
 *     - Sol을 이름이나 지시문만 바꿔 두 번 부르기
 *     - 같은 profile을 두 번 부르기
 *     - 같은 independenceGroup에 속한 평가 둘
 *   계열 판정은 이름에 무엇이 들어 있는지 훑어보는 방식이 아니라, 아래 allowlist가 정확히 매핑한다.
 */

import { canonicalJson, sha256Hex } from './automatic-scripture-catalog-contract.ts';
import type { ContractCheck } from './automatic-scripture-catalog-contract.ts';
import {
  CHECK_VALIDATOR_KIND,
  MIN_INDEPENDENT_EVALUATIONS,
  REQUIRED_VALIDATION_CHECKS,
  VALIDATOR_NAME_FORMAT,
  VALIDATOR_PROFILE_CONTRACT_VERSION,
  VALIDATOR_REGISTRY_CONTRACT_VERSION,
  validateValidatorRegistry,
} from './automatic-scripture-catalog-activation-contract.ts';
import type {
  RequiredValidationCheck,
  ValidatorProfile,
  ValidatorRegistry,
  Verdict,
} from './automatic-scripture-catalog-activation-contract.ts';

/* ------------------------------------------------------------------ */
/* 1. 지원 모델 allowlist — 계열과 운영 주체를 명시적으로 매핑한다          */
/* ------------------------------------------------------------------ */

export const EVALUATOR_MODEL_FAMILY_CONTRACT_VERSION = 'scripture-catalog-evaluator-models/v1';

export type EvaluatorModelEntry = {
  /** 모델 계열. 같은 계열이면 독립 평가로 세지 않는다. */
  family: string;
  /** 운영 주체. 같은 주체가 돌리는 두 모델도 계열이 같으면 독립이 아니다. */
  operator: string;
  /** 이 모델을 쓰는 profile이 반드시 가져야 하는 independenceGroup. */
  independenceGroup: string;
};

/**
 * 아는 모델 전부. 승인 여부와는 별개다.
 * Terra를 여기에 남겨 두는 이유: Sol과 같은 계열임을 데이터로 못 박아,
 * 누가 Terra를 다른 그룹으로 적어 독립 평가 둘로 위장하면 바로 걸리게 하기 위해서다.
 */
export const EVALUATOR_MODEL_FAMILIES: Readonly<Record<string, EvaluatorModelEntry>> = Object.freeze({
  'gpt-5.6-sol': Object.freeze({ family: 'openai-gpt-5-6', operator: 'openai', independenceGroup: 'openai-gpt-5-6' }),
  'gpt-5.6-terra': Object.freeze({ family: 'openai-gpt-5-6', operator: 'openai', independenceGroup: 'openai-gpt-5-6' }),
  'gpt-6-astra': Object.freeze({ family: 'openai-gpt-6', operator: 'openai', independenceGroup: 'openai-gpt-6' }),
});

/** 신학 평가에 실제로 쓰기로 한 모델 둘. 이 밖의 모델은 allowlist에 있어도 거절한다. */
export const APPROVED_THEOLOGY_EVALUATOR_MODELS = ['gpt-5.6-sol', 'gpt-6-astra'] as const;
export type ApprovedTheologyEvaluatorModel = (typeof APPROVED_THEOLOGY_EVALUATOR_MODELS)[number];

export const SOL_MODEL_ID: ApprovedTheologyEvaluatorModel = 'gpt-5.6-sol';
export const ASTRA_MODEL_ID: ApprovedTheologyEvaluatorModel = 'gpt-6-astra';

/** 이름 문자열을 훑지 않는다. allowlist에 없으면 계열을 모른다고 답한다(= 거절 사유). */
export function lookupEvaluatorModel(modelId: string): EvaluatorModelEntry | null {
  return Object.prototype.hasOwnProperty.call(EVALUATOR_MODEL_FAMILIES, modelId)
    ? EVALUATOR_MODEL_FAMILIES[modelId]
    : null;
}

/* ------------------------------------------------------------------ */
/* 2. 신학 검수 rubric — 버전형 구조화 데이터                             */
/* ------------------------------------------------------------------ */

export const THEOLOGY_RUBRIC_CONTRACT_VERSION = 'scripture-catalog-theology-rubric/v1';
export const THEOLOGY_RUBRIC_VERSION = 'aroeda-theology-rubric/v1';

export type TheologyRubricCriterion = {
  /** 판정 근거를 가리키는 고정 식별자. 문구가 다듬어져도 이 값은 유지한다. */
  criterionId: string;
  title: string;
  /** 이것이 참이어야 통과다. */
  requirement: string;
  /** 하나라도 해당하면 그 카드는 fail이다. */
  failWhen: readonly string[];
};

export const THEOLOGY_REVIEW_RUBRIC = Object.freeze({
  contractVersion: THEOLOGY_RUBRIC_CONTRACT_VERSION,
  rubricVersion: THEOLOGY_RUBRIC_VERSION,
  /** 근거가 모자라면 통과가 아니라 fail이다. 판단을 미루는 선택지는 없다. */
  verdictOnUncertainty: 'fail' as Verdict,
  /** 한 카드라도 fail이면 후보 전체가 fail이다. */
  verdictScope: 'per_card_all_must_pass',
  criteria: Object.freeze([
    Object.freeze({
      criterionId: 'context-fidelity',
      title: '본문 문맥과 카드 설명의 일치',
      requirement: '카드의 문맥 요약·신학적 통찰·사용자 설명이 인용한 성경 본문의 원래 문맥과 신학적 의미에 맞는다.',
      failWhen: Object.freeze([
        '본문의 대상·시점·언약 관계를 무시하고 오늘의 상황에 곧바로 옮겨 적었다.',
        '본문을 감정을 달래는 명언처럼 잘라 썼다.',
        '설명이 본문이 아니라 다른 구절이나 일반론에 기대고 있다.',
      ]),
    }),
    Object.freeze({
      criterionId: 'no-unpromised-outcome',
      title: '본문에 없는 약속·결과를 보장하지 않음',
      requirement: '카드가 본문이 말하지 않은 결과(치유, 회복, 성공, 관계 회복 등)를 보장하지 않는다.',
      failWhen: Object.freeze([
        '기도하면 반드시 그렇게 된다는 취지로 결과를 단정했다.',
        '조건부 약속을 무조건 약속으로 바꿔 적었다.',
        '본문에 없는 기한이나 방식을 덧붙였다.',
      ]),
    }),
    Object.freeze({
      criterionId: 'no-divine-intent-claim',
      title: '하나님의 구체적 뜻·계시·예언을 단정하지 않음',
      requirement: '지금 이 사람의 상황에 대한 하나님의 숨은 뜻이나 앞일을 단정하지 않는다.',
      failWhen: Object.freeze([
        '이 고난은 하나님이 무엇을 하시려는 것이라고 이유를 지정했다.',
        '앞으로 일어날 일을 예언처럼 말했다.',
        '하나님을 대신해 개인에게 지시를 내렸다.',
      ]),
    }),
    Object.freeze({
      criterionId: 'domain-tag-support',
      title: '영역·상황 태그·목회 기능을 본문이 실제로 지지함',
      requirement: '카드에 붙은 영역, 감정·신앙질문 태그, 기도 방식, 목회 기능을 인용 본문이 실제로 받쳐 준다.',
      failWhen: Object.freeze([
        '본문과 무관한 태그를 검색이 잘 되도록 덧붙였다.',
        '목회 기능이 본문의 성격과 어긋난다(예: 책망 본문을 위로로만 붙였다).',
        '영역 연결의 근거가 본문이 아니라 카드 설명뿐이다.',
      ]),
    }),
    Object.freeze({
      criterionId: 'crisis-guidance-precedence',
      title: '위험 상황에서 안전 안내가 먼저',
      requirement:
        '자해·타해·학대·긴급 의료·현재 진행 중인 위험 상황에서, 말씀 추천이 현실적인 안전 안내를 대신하거나 미루게 하지 않는다.',
      failWhen: Object.freeze([
        '도움을 청하는 대신 기도만 하도록 이끈다.',
        '위험을 영적 시험으로 재해석해 신고·대피·치료를 늦춘다.',
        '전문가·기관의 도움을 믿음이 약한 것으로 암시한다.',
      ]),
    }),
    Object.freeze({
      criterionId: 'no-coerced-reconciliation',
      title: '피해자에게 용서·인내·관계 유지를 강요하지 않음',
      requirement: '피해를 입은 사람에게 용서, 참음, 순종, 관계 유지를 의무로 지우지 않는다.',
      failWhen: Object.freeze([
        '용서를 지금 해야 할 일로 지시했다.',
        '참고 견디는 것을 신앙의 증거로 제시했다.',
        '가해자와의 관계를 유지·회복하는 것을 전제로 삼았다.',
      ]),
    }),
    Object.freeze({
      criterionId: 'krv-citation-integrity',
      title: '개역한글 본문 위치와 인용의 무결성',
      requirement: '인용한 책·장·절이 실제 위치와 같고, 개역한글 원문을 고치거나 줄여 쓰지 않았다.',
      failWhen: Object.freeze([
        '장절 표기가 실제 본문과 다르다.',
        '원문 문장을 다듬거나 현대어로 바꿔 인용했다.',
        '여러 구절을 이어 붙여 하나의 인용처럼 보이게 했다.',
      ]),
    }),
    Object.freeze({
      criterionId: 'new-domain-distinctness',
      title: '새 영역의 구분과 한국어 표시 이름',
      requirement: '새 영역이면 기존 영역과 실질적으로 구분되고, 표시 이름이 자연스러운 한국어다.',
      failWhen: Object.freeze([
        '기존 영역과 사실상 같은 범위를 다른 이름으로 나눴다.',
        '표시 이름이 번역투이거나 사용자가 자기 상황으로 알아보기 어렵다.',
        '영역 설명이 카드 내용과 어긋난다.',
      ]),
    }),
    Object.freeze({
      criterionId: 'uncertainty-defaults-to-fail',
      title: '불확실하면 fail',
      requirement: '판단할 근거가 모자라거나 확신이 서지 않으면 통과가 아니라 fail로 적는다.',
      failWhen: Object.freeze([
        '근거가 부족한데 일단 통과로 적었다.',
        '판단을 보류하는 제3의 결과를 만들어 냈다.',
        '다른 평가자가 볼 것이라는 이유로 확인을 건너뛰었다.',
      ]),
    }),
  ]) as readonly TheologyRubricCriterion[],
});

export type TheologyReviewRubric = typeof THEOLOGY_REVIEW_RUBRIC;

/**
 * rubric의 criterion id 아홉 개를 순서 그대로 뽑아 둔다. rubric.criteria에서 그저 파생한 값이다.
 * 계약(activation-contract.ts)의 THEOLOGY_CRITERION_IDS와 값이 같아야 한다 — 이 값을 그쪽이
 * 참조하지는 않는다(참조 방향은 반대다). 값이 실제로 같은지는 이 파일의 테스트가 대조해 고정한다.
 */
export const THEOLOGY_RUBRIC_CRITERION_IDS = THEOLOGY_REVIEW_RUBRIC.criteria.map((criterion) => criterion.criterionId);

/** rubric 전체의 지문. 문구가 한 글자라도 바뀌면 값이 달라진다. */
export async function computeTheologyRubricFingerprint(
  rubric: TheologyReviewRubric = THEOLOGY_REVIEW_RUBRIC,
): Promise<string> {
  return `srub_${await sha256Hex(canonicalJson(rubric))}`;
}

/**
 * 위 rubric의 지문을 글자로 못 박아 둔다.
 * 문구만 고치고 버전을 그대로 두는 실수를 잡는 걸림돌이다.
 * rubric을 진짜로 바꿀 때는 THEOLOGY_RUBRIC_VERSION과 이 값을 함께 올려야 한다.
 */
export const THEOLOGY_RUBRIC_FINGERPRINT = 'srub_6d2483bb9e76970d9b9dd767c08534a9abe371e38588b9f3b6cfe41b070aa672';

/* ------------------------------------------------------------------ */
/* 3. 실제 registry — profile 4개                                       */
/* ------------------------------------------------------------------ */

export const VALIDATOR_REGISTRY_VERSION = 'aroeda-validator-registry/v1';

export const DEMAND_COUNTER_PROFILE_ID = 'aroeda-demand-counter';
export const DETERMINISTIC_PROFILE_ID = 'aroeda-deterministic-checker';
export const ASTRA_PROFILE_ID = 'aroeda-theology-astra';
export const SOL_PROFILE_ID = 'aroeda-theology-sol';

/** 결정적 검사가 담당하는 여섯 항목. 계약의 REQUIRED_VALIDATION_CHECKS 순서를 그대로 따른다. */
export const DETERMINISTIC_CHECKS = [
  'passageExistence',
  'krvTextMatch',
  'safetyBoundary',
  'duplicateCheck',
  'corpusRegression',
  'candidateGenerationEvaluation',
] as const;

/** 독립 평가자 둘이 각각 attestation을 내야 하는 항목. 이것만 예외다. */
export const CHECKS_REQUIRING_INDEPENDENT_DUPLICATION = ['contextTheologyReview'] as const;

/** 항목마다 필요한 attestation 개수. 신학 평가만 2, 나머지는 1이다. */
export const EXPECTED_ATTESTATIONS_PER_CHECK: Readonly<Record<RequiredValidationCheck, number>> = Object.freeze(
  Object.fromEntries(
    REQUIRED_VALIDATION_CHECKS.map((name) => [
      name,
      (CHECKS_REQUIRING_INDEPENDENT_DUPLICATION as readonly string[]).includes(name) ? MIN_INDEPENDENT_EVALUATIONS : 1,
    ]),
  ) as Record<RequiredValidationCheck, number>,
);

const theologyProfile = (profileId: string, modelId: ApprovedTheologyEvaluatorModel): ValidatorProfile => ({
  contractVersion: VALIDATOR_PROFILE_CONTRACT_VERSION,
  profileId,
  profileVersion: 'v1',
  validatorKind: 'model_evaluator',
  authorizedChecks: ['contextTheologyReview'],
  independenceGroup: EVALUATOR_MODEL_FAMILIES[modelId].independenceGroup,
  modelId,
  rubricVersion: THEOLOGY_RUBRIC_VERSION,
});

/** export 뒤 실행 중 profile이나 권한 배열을 바꾸지 못하게 한다. */
const freezeValidatorProfile = (profile: ValidatorProfile): ValidatorProfile =>
  Object.freeze({
    ...profile,
    authorizedChecks: Object.freeze([...profile.authorizedChecks]) as unknown as RequiredValidationCheck[],
  });

/**
 * profiles는 profileId@profileVersion 오름차순이다(계약이 요구한다).
 * 그래서 배열 순서는 Astra가 Sol보다 앞이다. 이것은 정렬 순서일 뿐 실행 순서가 아니다.
 * 실행 순서는 아래 VALIDATION_STAGES가 따로 정한다.
 */
export const AROEDA_VALIDATOR_REGISTRY: ValidatorRegistry = Object.freeze({
  contractVersion: VALIDATOR_REGISTRY_CONTRACT_VERSION,
  registryVersion: VALIDATOR_REGISTRY_VERSION,
  profiles: Object.freeze(
    [
      {
      contractVersion: VALIDATOR_PROFILE_CONTRACT_VERSION,
      profileId: DEMAND_COUNTER_PROFILE_ID,
      profileVersion: 'v1',
      validatorKind: 'aggregate_counter',
      authorizedChecks: ['demandSignal'],
      independenceGroup: 'aroeda-demand-aggregate',
      modelId: null,
      rubricVersion: null,
      },
      {
      contractVersion: VALIDATOR_PROFILE_CONTRACT_VERSION,
      profileId: DETERMINISTIC_PROFILE_ID,
      profileVersion: 'v1',
      validatorKind: 'deterministic',
      authorizedChecks: [...DETERMINISTIC_CHECKS],
      independenceGroup: 'aroeda-deterministic-suite',
      modelId: null,
      rubricVersion: null,
      },
      theologyProfile(ASTRA_PROFILE_ID, ASTRA_MODEL_ID),
      theologyProfile(SOL_PROFILE_ID, SOL_MODEL_ID),
    ].map((profile) => freezeValidatorProfile(profile as ValidatorProfile)),
  ) as unknown as ValidatorProfile[],
});

export const REQUIRED_PROFILE_IDS = [
  DEMAND_COUNTER_PROFILE_ID,
  DETERMINISTIC_PROFILE_ID,
  ASTRA_PROFILE_ID,
  SOL_PROFILE_ID,
] as const;

/* ------------------------------------------------------------------ */
/* 4. 실행 순서                                                         */
/* ------------------------------------------------------------------ */

export const VALIDATION_STAGE_IDS = [
  'demand-counter',
  'deterministic-checks',
  'theology-sol',
  'theology-astra',
] as const;
export type ValidationStageId = (typeof VALIDATION_STAGE_IDS)[number];

export type ValidationStage = {
  stageId: ValidationStageId;
  /** 1부터 시작하는 실행 순서. 건너뛰거나 겹치지 않는다. */
  order: number;
  /** 이 단계를 맡는 profile. */
  profileId: string;
  /** 이 단계가 채우는 검증 항목. */
  producesChecks: readonly RequiredValidationCheck[];
  /** 이 단계 전에 전부 통과해 있어야 하는 단계. */
  requiresStages: readonly ValidationStageId[];
};

/**
 * Astra는 마지막이다. 앞선 결정적 검사와 Sol 평가가 모두 통과한 후보에만 부른다.
 * 값이 비싼 평가를 실패할 후보에까지 쓰지 않기 위해서다.
 */
export const VALIDATION_STAGES: readonly ValidationStage[] = Object.freeze([
  Object.freeze({
    stageId: 'demand-counter' as const,
    order: 1,
    profileId: DEMAND_COUNTER_PROFILE_ID,
    producesChecks: Object.freeze(['demandSignal'] as const),
    requiresStages: Object.freeze([] as readonly ValidationStageId[]),
  }),
  Object.freeze({
    stageId: 'deterministic-checks' as const,
    order: 2,
    profileId: DETERMINISTIC_PROFILE_ID,
    producesChecks: Object.freeze([...DETERMINISTIC_CHECKS] as const),
    requiresStages: Object.freeze(['demand-counter'] as readonly ValidationStageId[]),
  }),
  Object.freeze({
    stageId: 'theology-sol' as const,
    order: 3,
    profileId: SOL_PROFILE_ID,
    producesChecks: Object.freeze(['contextTheologyReview'] as const),
    requiresStages: Object.freeze(['demand-counter', 'deterministic-checks'] as readonly ValidationStageId[]),
  }),
  Object.freeze({
    stageId: 'theology-astra' as const,
    order: 4,
    profileId: ASTRA_PROFILE_ID,
    producesChecks: Object.freeze(['contextTheologyReview'] as const),
    requiresStages: Object.freeze([
      'demand-counter',
      'deterministic-checks',
      'theology-sol',
    ] as readonly ValidationStageId[]),
  }),
]);

/* ------------------------------------------------------------------ */
/* 5. 단계 실행 게이트 (순수 함수)                                        */
/* ------------------------------------------------------------------ */

/** 게이트가 보는 사실. 바깥에서 무엇을 관찰했는지만 담는다. 여기서 아무것도 부르지 않는다. */
export type StageGateFacts = {
  stageId: ValidationStageId;
  /** 지금까지 통과로 끝난 단계. */
  completedStages: readonly ValidationStageId[];
  /** 수요 기준(합계·활동일)을 넘겼는가. */
  demandThresholdMet: boolean;
  /** 결정적 검사 여섯 개가 모두 통과했는가. */
  deterministicAllPassed: boolean;
  /** Sol이 카드마다 낸 판정. */
  solCardVerdicts: readonly { cardId: string; verdict: Verdict }[];
  /** 후보에 들어 있는 카드 전체. Sol이 빠뜨린 카드를 찾기 위해 쓴다. */
  candidateCardIds: readonly string[];
  /** 단계를 시작할 때 고정해 둔 값. */
  pinned: { candidateHash: string; baseVersionHash: string; rubricVersion: string };
  /** 지금 다시 읽은 값. pinned와 다르면 중간에 바뀐 것이다. */
  observed: { candidateHash: string; baseVersionHash: string; rubricVersion: string };
};

export type StageGateResult = { allowed: boolean; blockers: string[] };

const stageById = (stageId: ValidationStageId): ValidationStage | undefined =>
  VALIDATION_STAGES.find((stage) => stage.stageId === stageId);

/**
 * 이 단계를 지금 돌려도 되는가. 막을 이유가 하나라도 있으면 돌리지 않는다(fail-closed).
 * 네트워크도 시계도 보지 않는다. 받은 사실만으로 답한다.
 */
export function evaluateStageGate(facts: StageGateFacts): StageGateResult {
  const blockers: string[] = [];
  const stage = stageById(facts.stageId);
  if (!stage) return { allowed: false, blockers: [`${facts.stageId}: 알 수 없는 단계입니다.`] };

  for (const required of stage.requiresStages) {
    if (!facts.completedStages.includes(required)) {
      blockers.push(`${stage.stageId}: 앞 단계 ${required}가 끝나지 않았습니다.`);
    }
  }

  // 순서를 우회해 앞질러 온 경우. 끝났다고 적힌 단계가 이 단계보다 뒤면 거짓말이다.
  for (const done of facts.completedStages) {
    const doneStage = stageById(done);
    if (!doneStage) blockers.push(`${stage.stageId}: 알 수 없는 완료 단계 ${done}가 있습니다.`);
    else if (doneStage.order >= stage.order) {
      blockers.push(`${stage.stageId}: ${done}는 이 단계보다 뒤이거나 같은 순서입니다.`);
    }
  }

  if (stage.order >= 2 && !facts.demandThresholdMet) {
    blockers.push(`${stage.stageId}: 수요 기준을 넘지 못했습니다.`);
  }
  if (stage.order >= 3 && !facts.deterministicAllPassed) {
    blockers.push(`${stage.stageId}: 결정적 검사가 모두 통과하지 않았습니다.`);
  }

  if (stage.stageId === 'theology-astra') {
    if (facts.candidateCardIds.length === 0) {
      blockers.push('theology-astra: 후보 카드가 없습니다.');
    }
    if (new Set(facts.candidateCardIds).size !== facts.candidateCardIds.length) {
      blockers.push('theology-astra: 후보 카드 번호가 중복됐습니다.');
    }
    if (new Set(facts.solCardVerdicts.map((item) => item.cardId)).size !== facts.solCardVerdicts.length) {
      blockers.push('theology-astra: Sol 평가에 같은 카드가 두 번 있습니다.');
    }
    const verdictByCard = new Map(facts.solCardVerdicts.map((item) => [item.cardId, item.verdict]));
    for (const cardId of facts.candidateCardIds) {
      const verdict = verdictByCard.get(cardId);
      if (verdict === undefined) blockers.push(`theology-astra: Sol 평가에 ${cardId}가 없습니다.`);
      else if (verdict !== 'pass') blockers.push(`theology-astra: Sol이 ${cardId}를 통과시키지 않았습니다.`);
    }
    for (const item of facts.solCardVerdicts) {
      if (!facts.candidateCardIds.includes(item.cardId)) {
        blockers.push(`theology-astra: Sol 평가에 후보에 없는 ${item.cardId}가 있습니다.`);
      }
    }
  }

  if (facts.observed.candidateHash !== facts.pinned.candidateHash) {
    blockers.push(`${stage.stageId}: 후보가 중간에 바뀌었습니다.`);
  }
  if (facts.observed.baseVersionHash !== facts.pinned.baseVersionHash) {
    blockers.push(`${stage.stageId}: 기준 버전이 중간에 바뀌었습니다.`);
  }
  if (facts.observed.rubricVersion !== facts.pinned.rubricVersion) {
    blockers.push(`${stage.stageId}: 평가 기준 버전이 중간에 바뀌었습니다.`);
  }
  if (facts.pinned.rubricVersion !== THEOLOGY_RUBRIC_VERSION) {
    blockers.push(`${stage.stageId}: 고정한 평가 기준 버전이 현재 rubric과 다릅니다.`);
  }

  return { allowed: blockers.length === 0, blockers };
}

/* ------------------------------------------------------------------ */
/* 6. fail-closed 정책 검사                                             */
/* ------------------------------------------------------------------ */

/**
 * registry·단계·rubric이 서로 어긋나면 거절한다.
 * 계약의 validateValidatorRegistry가 모양을 보고, 여기서는 "이 registry가 맞는 registry인가"를 본다.
 */
export function checkValidatorRegistryPolicy(
  registry: ValidatorRegistry = AROEDA_VALIDATOR_REGISTRY,
  stages: readonly ValidationStage[] = VALIDATION_STAGES,
  rubric: TheologyReviewRubric = THEOLOGY_REVIEW_RUBRIC,
): ContractCheck {
  const shape = validateValidatorRegistry(registry);
  if (!shape.valid) return shape;

  const errors: string[] = [];
  const profiles = registry.profiles;

  // (1) profile 네 개가 정확히 있어야 한다.
  const ids = profiles.map((profile) => profile.profileId);
  for (const required of REQUIRED_PROFILE_IDS) {
    if (!ids.includes(required)) errors.push(`registry: ${required} profile이 없습니다.`);
  }
  if (profiles.length !== REQUIRED_PROFILE_IDS.length) {
    errors.push(`registry: profile은 정확히 ${REQUIRED_PROFILE_IDS.length}개여야 합니다(현재 ${profiles.length}개).`);
  }

  // 배열 순서(profileId@profileVersion 오름차순)는 위 validateValidatorRegistry가 이미 막는다.
  // 여기서 한 번 더 보면 그 검사가 지워져도 이쪽이 대신 잡아 주어, 어느 쪽도 증명되지 않는다.
  // 그래서 순서의 주인은 계약 하나로 둔다.

  // (2) 필수 항목이 빠짐없이, 정해진 횟수만큼 배정됐는가.
  for (const name of REQUIRED_VALIDATION_CHECKS) {
    const owners = profiles.filter((profile) => profile.authorizedChecks.includes(name));
    const expected = EXPECTED_ATTESTATIONS_PER_CHECK[name];
    if (owners.length !== expected) {
      errors.push(`registry: ${name}을(를) 맡은 profile이 ${owners.length}개입니다(${expected}개여야 합니다).`);
    }
    // (3) 종류가 맞는 profile만 맡을 수 있다.
    for (const owner of owners) {
      if (owner.validatorKind !== CHECK_VALIDATOR_KIND[name]) {
        errors.push(`registry: ${owner.profileId}는 ${name}을(를) 맡을 수 있는 종류가 아닙니다.`);
      }
    }
  }

  // (4) independenceGroup은 서로 겹치지 않는다.
  const groups = profiles.map((profile) => profile.independenceGroup);
  for (const group of new Set(groups)) {
    const shared = profiles.filter((profile) => profile.independenceGroup === group);
    if (shared.length > 1) {
      errors.push(`registry: independenceGroup ${group}을(를) ${shared.map((p) => p.profileId).join(', ')}가 함께 씁니다.`);
    }
  }
  for (const profile of profiles) {
    if (!VALIDATOR_NAME_FORMAT.test(profile.independenceGroup)) {
      errors.push(`registry: ${profile.profileId}의 independenceGroup 모양이 맞지 않습니다.`);
    }
  }

  // (5) 모델 평가자는 정확히 둘이고, 승인된 모델이고, 계열이 서로 달라야 한다.
  const evaluators = profiles.filter((profile) => profile.validatorKind === 'model_evaluator');
  if (evaluators.length !== MIN_INDEPENDENT_EVALUATIONS) {
    errors.push(`registry: 모델 평가자는 ${MIN_INDEPENDENT_EVALUATIONS}개여야 합니다(현재 ${evaluators.length}개).`);
  }
  const seenModels = new Set<string>();
  const seenFamilies = new Map<string, string>();
  for (const evaluator of evaluators) {
    const modelId = evaluator.modelId;
    if (typeof modelId !== 'string') {
      errors.push(`registry: ${evaluator.profileId}에 모델 식별자가 없습니다.`);
      continue;
    }
    if (!(APPROVED_THEOLOGY_EVALUATOR_MODELS as readonly string[]).includes(modelId)) {
      errors.push(`registry: ${evaluator.profileId}의 모델 ${modelId}은(는) 승인 목록에 없습니다.`);
    }
    if (seenModels.has(modelId)) errors.push(`registry: 모델 ${modelId}을(를) 두 평가자가 함께 씁니다.`);
    seenModels.add(modelId);

    const entry = lookupEvaluatorModel(modelId);
    if (!entry) {
      errors.push(`registry: 모델 ${modelId}의 계열을 모릅니다.`);
      continue;
    }
    // 같은 계열을 다른 그룹으로 적어 독립 평가 둘로 위장하는 것을 여기서 막는다.
    const already = seenFamilies.get(entry.family);
    if (already !== undefined) {
      errors.push(`registry: ${already}와 ${evaluator.profileId}는 같은 모델 계열 ${entry.family}입니다.`);
    }
    seenFamilies.set(entry.family, evaluator.profileId);

    if (evaluator.independenceGroup !== entry.independenceGroup) {
      errors.push(
        `registry: ${evaluator.profileId}의 independenceGroup이 모델 계열이 정한 ${entry.independenceGroup}과(와) 다릅니다.`,
      );
    }
    // (6) rubric 버전이 어긋나면 안 된다.
    if (evaluator.rubricVersion !== rubric.rubricVersion) {
      errors.push(`registry: ${evaluator.profileId}의 rubricVersion이 현재 rubric과 다릅니다.`);
    }
  }
  // 계열이 겹치는 경우와 계열을 모르는 경우는 위 반복문이 이미 각각 사유를 남긴다.
  // 여기서 개수만 다시 세면 위 검사가 지워져도 이쪽이 가려 주므로 두지 않는다.

  // (7) 모델 평가자가 아닌 profile은 modelId·rubricVersion이 비어 있어야 한다.
  for (const profile of profiles) {
    if (profile.validatorKind !== 'model_evaluator' && (profile.modelId !== null || profile.rubricVersion !== null)) {
      errors.push(`registry: ${profile.profileId}는 모델 평가자가 아닌데 모델·평가 기준이 적혀 있습니다.`);
    }
  }

  errors.push(...checkValidationStagePolicy(registry, stages).errors);
  return { valid: errors.length === 0, errors };
}

/** 단계 데이터 자체가 맞는가. 순서, 담당 profile, 선행 조건, Astra의 마지막 자리를 본다. */
export function checkValidationStagePolicy(
  registry: ValidatorRegistry = AROEDA_VALIDATOR_REGISTRY,
  stages: readonly ValidationStage[] = VALIDATION_STAGES,
): ContractCheck {
  const errors: string[] = [];
  const knownProfileIds = new Set(registry.profiles.map((profile) => profile.profileId));

  if (stages.length !== VALIDATION_STAGE_IDS.length) {
    errors.push(`stages: 단계는 ${VALIDATION_STAGE_IDS.length}개여야 합니다(현재 ${stages.length}개).`);
  }
  const actualStageIds = stages.map((stage) => stage.stageId);
  if (canonicalJson(actualStageIds) !== canonicalJson(VALIDATION_STAGE_IDS)) {
    errors.push('stages: 단계 ID와 배열 순서가 고정 계약과 다릅니다.');
  }

  const expectedByStage: Readonly<
    Record<ValidationStageId, Pick<ValidationStage, 'profileId' | 'producesChecks' | 'requiresStages'>>
  > = {
    'demand-counter': {
      profileId: DEMAND_COUNTER_PROFILE_ID,
      producesChecks: ['demandSignal'],
      requiresStages: [],
    },
    'deterministic-checks': {
      profileId: DETERMINISTIC_PROFILE_ID,
      producesChecks: DETERMINISTIC_CHECKS,
      requiresStages: ['demand-counter'],
    },
    'theology-sol': {
      profileId: SOL_PROFILE_ID,
      producesChecks: ['contextTheologyReview'],
      requiresStages: ['demand-counter', 'deterministic-checks'],
    },
    'theology-astra': {
      profileId: ASTRA_PROFILE_ID,
      producesChecks: ['contextTheologyReview'],
      requiresStages: ['demand-counter', 'deterministic-checks', 'theology-sol'],
    },
  };

  stages.forEach((stage, index) => {
    if (stage.order !== index + 1) errors.push(`stages: ${stage.stageId}의 order가 ${index + 1}이 아닙니다.`);
    if (!knownProfileIds.has(stage.profileId)) errors.push(`stages: ${stage.stageId}의 profile ${stage.profileId}이 registry에 없습니다.`);
    const expected = expectedByStage[stage.stageId];
    if (expected) {
      if (stage.profileId !== expected.profileId) {
        errors.push(`stages: ${stage.stageId}의 담당 profile이 고정 계약과 다릅니다.`);
      }
      if (canonicalJson(stage.producesChecks) !== canonicalJson(expected.producesChecks)) {
        errors.push(`stages: ${stage.stageId}의 검증 산출물이 고정 계약과 다릅니다.`);
      }
      if (canonicalJson(stage.requiresStages) !== canonicalJson(expected.requiresStages)) {
        errors.push(`stages: ${stage.stageId}의 선행 단계가 고정 계약과 다릅니다.`);
      }
    }
    const profile = registry.profiles.find((item) => item.profileId === stage.profileId);
    if (profile) {
      for (const name of stage.producesChecks) {
        if (!profile.authorizedChecks.includes(name)) {
          errors.push(`stages: ${stage.profileId}는 ${name}을(를) 판정할 권한이 없습니다.`);
        }
      }
    }
    // 선행 단계는 반드시 자기보다 앞 순서여야 한다.
    for (const required of stage.requiresStages) {
      const before = stages.find((item) => item.stageId === required);
      if (!before) errors.push(`stages: ${stage.stageId}의 선행 단계 ${required}가 없습니다.`);
      else if (before.order >= stage.order) errors.push(`stages: ${stage.stageId}가 ${required}보다 먼저 옵니다.`);
    }
  });

  const sol = stages.find((stage) => stage.profileId === SOL_PROFILE_ID);
  const astra = stages.find((stage) => stage.profileId === ASTRA_PROFILE_ID);
  if (!sol || !astra) {
    errors.push('stages: Sol과 Astra 단계가 모두 있어야 합니다.');
  } else {
    if (astra.order <= sol.order) errors.push('stages: Astra는 Sol보다 뒤여야 합니다.');
    if (astra.order !== stages.length) errors.push('stages: Astra는 마지막 단계여야 합니다.');
    if (!astra.requiresStages.includes(sol.stageId)) errors.push('stages: Astra는 Sol을 선행 조건으로 두어야 합니다.');
  }

  // 모든 필수 항목이 어느 단계에선가 만들어져야 한다.
  for (const name of REQUIRED_VALIDATION_CHECKS) {
    if (!stages.some((stage) => stage.producesChecks.includes(name))) {
      errors.push(`stages: ${name}을(를) 만드는 단계가 없습니다.`);
    }
  }
  return { valid: errors.length === 0, errors };
}

/** rubric 문구가 지문과 맞는지. 문구만 고치고 버전을 그대로 둔 경우를 잡는다. */
export async function checkTheologyRubricIntegrity(
  rubric: TheologyReviewRubric = THEOLOGY_REVIEW_RUBRIC,
  expectedFingerprint: string = THEOLOGY_RUBRIC_FINGERPRINT,
): Promise<ContractCheck> {
  const errors: string[] = [];
  if (rubric.rubricVersion !== THEOLOGY_RUBRIC_VERSION) {
    errors.push('rubric: 버전이 이 파일이 고정한 값과 다릅니다.');
  }
  const fingerprint = await computeTheologyRubricFingerprint(rubric);
  if (fingerprint !== expectedFingerprint) {
    errors.push(`rubric: 문구에서 다시 계산한 지문이 고정한 값과 다릅니다(${fingerprint}).`);
  }
  const ids = rubric.criteria.map((item) => item.criterionId);
  if (new Set(ids).size !== ids.length) errors.push('rubric: criterionId가 겹칩니다.');
  if (rubric.criteria.some((item) => item.failWhen.length === 0)) {
    errors.push('rubric: 모든 기준에 fail 사례가 하나 이상 있어야 합니다.');
  }
  if (rubric.verdictOnUncertainty !== 'fail') errors.push('rubric: 불확실할 때의 판정은 fail이어야 합니다.');
  return { valid: errors.length === 0, errors };
}
