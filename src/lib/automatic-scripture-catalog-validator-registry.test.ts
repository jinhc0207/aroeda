/**
 * 실제 validator registry · 신학 검수 rubric · 실행 순서 계약 테스트.
 *
 * 이 테스트가 지키려는 것
 *   1. 실제로 쓸 profile 넷이 무엇을 판정할 수 있는지 글자로 고정한다.
 *   2. 신학 평가 둘이 진짜로 독립인지(같은 모델 계열을 다른 이름으로 위장하지 않았는지) 확인한다.
 *   3. 비싼 마지막 평가자(Astra)가 앞 단계를 건너뛰고 불릴 수 없음을 확인한다.
 *   4. rubric 문구가 바뀌면 지문이 달라져 반드시 걸리게 한다.
 *
 * 규칙을 하나씩 일부러 어긋나게 만들어(변조) 검사가 실제로 잡는지도 함께 본다.
 * 바깥으로 나가는 호출은 하지 않는다. fetch를 막아 두고 돌린다.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import {
  CHECK_VALIDATOR_KIND,
  MIN_INDEPENDENT_EVALUATIONS,
  REQUIRED_VALIDATION_CHECKS,
  VALIDATOR_PROFILE_CONTRACT_VERSION,
  VALIDATOR_REGISTRY_CONTRACT_VERSION,
  computeValidatorProfileHash,
  computeValidatorRegistryHash,
  validateAutomaticValidationRecord,
  validateValidatorRegistry,
} from '../../supabase/functions/_shared/automatic-scripture-catalog-activation-contract.ts';
import type {
  ValidatorProfile,
  ValidatorRegistry,
} from '../../supabase/functions/_shared/automatic-scripture-catalog-activation-contract.ts';
import {
  APPROVED_THEOLOGY_EVALUATOR_MODELS,
  AROEDA_VALIDATOR_REGISTRY,
  ASTRA_MODEL_ID,
  ASTRA_PROFILE_ID,
  CHECKS_REQUIRING_INDEPENDENT_DUPLICATION,
  DEMAND_COUNTER_PROFILE_ID,
  DETERMINISTIC_CHECKS,
  DETERMINISTIC_PROFILE_ID,
  EVALUATOR_MODEL_FAMILIES,
  EXPECTED_ATTESTATIONS_PER_CHECK,
  REQUIRED_PROFILE_IDS,
  SOL_MODEL_ID,
  SOL_PROFILE_ID,
  THEOLOGY_REVIEW_RUBRIC,
  THEOLOGY_RUBRIC_FINGERPRINT,
  THEOLOGY_RUBRIC_VERSION,
  VALIDATION_STAGES,
  VALIDATOR_REGISTRY_VERSION,
  checkTheologyRubricIntegrity,
  checkValidationStagePolicy,
  checkValidatorRegistryPolicy,
  computeTheologyRubricFingerprint,
  evaluateStageGate,
  lookupEvaluatorModel,
} from '../../supabase/functions/_shared/automatic-scripture-catalog-validator-registry.ts';
import type {
  StageGateFacts,
  TheologyReviewRubric,
  ValidationStage,
} from '../../supabase/functions/_shared/automatic-scripture-catalog-validator-registry.ts';
import {
  buildBaselineCatalog,
  makeAttestations,
  makeExistingDomainCandidate,
  makePassingValidationRecord,
  resealRecord,
  resolveKrvPassage,
} from './automatic-scripture-catalog-test-fixtures.ts';

/* ------------------------------------------------------------------ */
/* 고정 기대값 — 구현에서 가져오지 않고 여기에 따로 적는다                 */
/* ------------------------------------------------------------------ */

const EXPECTED_REGISTRY_HASH = 'svreg_d8f8521d48e1e69b1416a08eba213b20e20f953fe2f8f77397b4cf863294af30';
const EXPECTED_RUBRIC_FINGERPRINT = 'srub_6d2483bb9e76970d9b9dd767c08534a9abe371e38588b9f3b6cfe41b070aa672';
const EXPECTED_PROFILE_HASHES: Readonly<Record<string, string>> = {
  'aroeda-demand-counter': 'svp_ca88d91ef46455ee8d1110d3fbf0d030f6d020326c01a36f2e444b0eb219b115',
  'aroeda-deterministic-checker': 'svp_82b20e37a6c92a100cfad020194544bff123acda8af9ef11d92170c4fcbc074b',
  'aroeda-theology-astra': 'svp_57670984311b1b579170ee91095b75110f4a28343f5626a99e742fdfd925bb40',
  'aroeda-theology-sol': 'svp_9bbbf31a18b25ea69204058fb671323c6019a4e9114552da6c15a08960fb96d3',
};

const clone = <T>(value: T): T => structuredClone(value) as T;
const profileOf = (registry: ValidatorRegistry, profileId: string): ValidatorProfile =>
  registry.profiles.find((profile) => profile.profileId === profileId)!;

/** 변조한 registry가 정책 검사에서 반드시 거절되는지 본다. */
function assertRejected(registry: ValidatorRegistry, needle: string, label: string) {
  const result = checkValidatorRegistryPolicy(registry);
  assert.equal(result.valid, false, `${label}: 거절되지 않았습니다.`);
  assert.ok(
    result.errors.some((error) => error.includes(needle)),
    `${label}: 기대한 사유가 없습니다 → ${result.errors.join(' / ')}`,
  );
}

/* ------------------------------------------------------------------ */

describe('실제 validator registry · A. profile 네 개', () => {
  it('기존 계약의 validateValidatorRegistry를 그대로 통과한다', () => {
    const result = validateValidatorRegistry(AROEDA_VALIDATOR_REGISTRY);
    assert.deepEqual(result.errors, []);
    assert.equal(result.valid, true);
  });

  it('정책 검사도 통과한다', () => {
    const result = checkValidatorRegistryPolicy();
    assert.deepEqual(result.errors, []);
    assert.equal(result.valid, true);
  });

  it('profile은 정확히 네 개이고 계약 버전과 registry 버전이 고정돼 있다', () => {
    assert.equal(AROEDA_VALIDATOR_REGISTRY.profiles.length, 4);
    assert.equal(AROEDA_VALIDATOR_REGISTRY.contractVersion, VALIDATOR_REGISTRY_CONTRACT_VERSION);
    assert.equal(AROEDA_VALIDATOR_REGISTRY.registryVersion, VALIDATOR_REGISTRY_VERSION);
    assert.equal(VALIDATOR_REGISTRY_VERSION, 'aroeda-validator-registry/v1');
    assert.deepEqual([...REQUIRED_PROFILE_IDS].sort(), AROEDA_VALIDATOR_REGISTRY.profiles.map((p) => p.profileId).sort());
    for (const profile of AROEDA_VALIDATOR_REGISTRY.profiles) {
      assert.equal(profile.contractVersion, VALIDATOR_PROFILE_CONTRACT_VERSION);
      assert.equal(profile.profileVersion, 'v1', `${profile.profileId}: profileVersion`);
    }
  });

  it('실제 registry와 profile·권한 배열은 실행 중 바꿀 수 없게 고정돼 있다', () => {
    assert.equal(Object.isFrozen(AROEDA_VALIDATOR_REGISTRY), true);
    assert.equal(Object.isFrozen(AROEDA_VALIDATOR_REGISTRY.profiles), true);
    for (const profile of AROEDA_VALIDATOR_REGISTRY.profiles) {
      assert.equal(Object.isFrozen(profile), true, profile.profileId);
      assert.equal(Object.isFrozen(profile.authorizedChecks), true, `${profile.profileId}.authorizedChecks`);
    }
  });

  it('수요 집계 profile은 demandSignal만 맡고 모델·평가 기준이 없다', () => {
    const profile = profileOf(AROEDA_VALIDATOR_REGISTRY, DEMAND_COUNTER_PROFILE_ID);
    assert.equal(profile.validatorKind, 'aggregate_counter');
    assert.deepEqual(profile.authorizedChecks, ['demandSignal']);
    assert.equal(profile.independenceGroup, 'aroeda-demand-aggregate');
    assert.equal(profile.modelId, null);
    assert.equal(profile.rubricVersion, null);
  });

  it('결정적 profile은 여섯 항목만 계약 순서대로 맡고 모델·평가 기준이 없다', () => {
    const profile = profileOf(AROEDA_VALIDATOR_REGISTRY, DETERMINISTIC_PROFILE_ID);
    assert.equal(profile.validatorKind, 'deterministic');
    assert.deepEqual(profile.authorizedChecks, [
      'passageExistence',
      'krvTextMatch',
      'safetyBoundary',
      'duplicateCheck',
      'corpusRegression',
      'candidateGenerationEvaluation',
    ]);
    assert.deepEqual([...DETERMINISTIC_CHECKS], profile.authorizedChecks);
    // 계약이 정한 전체 순서의 부분열이어야 한다(임의 순서로 적지 못한다).
    assert.deepEqual(
      profile.authorizedChecks,
      REQUIRED_VALIDATION_CHECKS.filter((name) => profile.authorizedChecks.includes(name)),
    );
    assert.equal(profile.independenceGroup, 'aroeda-deterministic-suite');
    assert.equal(profile.modelId, null);
    assert.equal(profile.rubricVersion, null);
  });

  it('Sol은 contextTheologyReview만 맡고 모델이 정확히 gpt-5.6-sol이다', () => {
    const profile = profileOf(AROEDA_VALIDATOR_REGISTRY, SOL_PROFILE_ID);
    assert.equal(profile.validatorKind, 'model_evaluator');
    assert.deepEqual(profile.authorizedChecks, ['contextTheologyReview']);
    assert.equal(profile.modelId, 'gpt-5.6-sol');
    assert.equal(profile.modelId, SOL_MODEL_ID);
    assert.equal(profile.rubricVersion, THEOLOGY_RUBRIC_VERSION);
    assert.equal(profile.independenceGroup, 'openai-gpt-5-6');
  });

  it('Astra는 contextTheologyReview만 맡고 모델이 정확히 gpt-6-astra다', () => {
    const profile = profileOf(AROEDA_VALIDATOR_REGISTRY, ASTRA_PROFILE_ID);
    assert.equal(profile.validatorKind, 'model_evaluator');
    assert.deepEqual(profile.authorizedChecks, ['contextTheologyReview']);
    assert.equal(profile.modelId, 'gpt-6-astra');
    assert.equal(profile.modelId, ASTRA_MODEL_ID);
    assert.equal(profile.rubricVersion, THEOLOGY_RUBRIC_VERSION);
    assert.equal(profile.independenceGroup, 'openai-gpt-6');
  });

  it('profiles 배열은 profileId@profileVersion 오름차순이다(정렬 순서이지 실행 순서가 아니다)', () => {
    const keys = AROEDA_VALIDATOR_REGISTRY.profiles.map((p) => `${p.profileId}@${p.profileVersion}`);
    assert.deepEqual(keys, [...keys].sort());
    // 배열에서는 Astra가 Sol보다 앞이다. 그래서 실행 순서를 배열에서 읽으면 안 된다.
    assert.ok(keys.indexOf(`${ASTRA_PROFILE_ID}@v1`) < keys.indexOf(`${SOL_PROFILE_ID}@v1`));
  });

  it('profile ID와 독립 그룹은 소문자·숫자·하이픈 모양이다', () => {
    for (const profile of AROEDA_VALIDATOR_REGISTRY.profiles) {
      assert.match(profile.profileId, /^[a-z][a-z0-9-]{2,48}$/, profile.profileId);
      assert.match(profile.independenceGroup, /^[a-z][a-z0-9-]{2,48}$/, profile.independenceGroup);
    }
  });
});

describe('실제 validator registry · B. 검증 항목 배정', () => {
  it('필수 여덟 항목이 빠짐없이, 종류가 맞는 profile에게 배정됐다', () => {
    for (const name of REQUIRED_VALIDATION_CHECKS) {
      const owners = AROEDA_VALIDATOR_REGISTRY.profiles.filter((p) => p.authorizedChecks.includes(name));
      assert.ok(owners.length > 0, `${name}: 맡은 profile이 없습니다.`);
      for (const owner of owners) {
        assert.equal(owner.validatorKind, CHECK_VALIDATOR_KIND[name], `${name}: ${owner.profileId} 종류`);
      }
    }
  });

  it('신학 평가만 두 번 배정되고 나머지 일곱 항목은 정확히 한 번이다', () => {
    const counts = Object.fromEntries(
      REQUIRED_VALIDATION_CHECKS.map((name) => [
        name,
        AROEDA_VALIDATOR_REGISTRY.profiles.filter((p) => p.authorizedChecks.includes(name)).length,
      ]),
    );
    assert.deepEqual(counts, {
      demandSignal: 1,
      passageExistence: 1,
      krvTextMatch: 1,
      contextTheologyReview: 2,
      safetyBoundary: 1,
      duplicateCheck: 1,
      corpusRegression: 1,
      candidateGenerationEvaluation: 1,
    });
  });

  it('중복 attestation이 필요한 항목은 신학 평가 하나뿐임을 계약으로 못 박는다', () => {
    assert.deepEqual([...CHECKS_REQUIRING_INDEPENDENT_DUPLICATION], ['contextTheologyReview']);
    assert.equal(EXPECTED_ATTESTATIONS_PER_CHECK.contextTheologyReview, MIN_INDEPENDENT_EVALUATIONS);
    assert.equal(MIN_INDEPENDENT_EVALUATIONS, 2);
    for (const name of REQUIRED_VALIDATION_CHECKS) {
      if (name === 'contextTheologyReview') continue;
      assert.equal(EXPECTED_ATTESTATIONS_PER_CHECK[name], 1, `${name}: 중복 attestation이 필요하지 않습니다.`);
    }
    // 실제 배정과 기대 개수가 같은 값이어야 한다.
    const total = REQUIRED_VALIDATION_CHECKS.reduce((sum, name) => sum + EXPECTED_ATTESTATIONS_PER_CHECK[name], 0);
    assert.equal(total, 9);
  });
});

describe('실제 validator registry · C. 독립성', () => {
  it('두 신학 평가자는 서로 다른 모델·계열·독립 그룹이다', () => {
    const sol = profileOf(AROEDA_VALIDATOR_REGISTRY, SOL_PROFILE_ID);
    const astra = profileOf(AROEDA_VALIDATOR_REGISTRY, ASTRA_PROFILE_ID);
    assert.notEqual(sol.modelId, astra.modelId);
    assert.notEqual(sol.independenceGroup, astra.independenceGroup);
    const solFamily = lookupEvaluatorModel(sol.modelId!)!;
    const astraFamily = lookupEvaluatorModel(astra.modelId!)!;
    assert.notEqual(solFamily.family, astraFamily.family);
    assert.equal(sol.independenceGroup, solFamily.independenceGroup);
    assert.equal(astra.independenceGroup, astraFamily.independenceGroup);
  });

  it('네 profile의 독립 그룹이 모두 다르다', () => {
    const groups = AROEDA_VALIDATOR_REGISTRY.profiles.map((p) => p.independenceGroup);
    assert.equal(new Set(groups).size, groups.length);
  });

  it('계열 판정은 이름 훑기가 아니라 allowlist 매핑이다', () => {
    // Terra는 아는 모델이지만 Sol과 같은 계열이다. 이름이 달라도 독립이 아니다.
    assert.equal(lookupEvaluatorModel('gpt-5.6-terra')!.family, lookupEvaluatorModel('gpt-5.6-sol')!.family);
    assert.notEqual(lookupEvaluatorModel('gpt-6-astra')!.family, lookupEvaluatorModel('gpt-5.6-sol')!.family);
    // 모르는 모델은 계열을 모른다고 답한다. 문자열이 비슷해도 추측하지 않는다.
    assert.equal(lookupEvaluatorModel('gpt-6-astra-v2'), null);
    assert.equal(lookupEvaluatorModel('gpt-5.6-sol-copy'), null);
    assert.equal(lookupEvaluatorModel('constructor'), null);
    assert.equal(lookupEvaluatorModel('toString'), null);
    // 승인 목록은 정확히 둘이다.
    assert.deepEqual([...APPROVED_THEOLOGY_EVALUATOR_MODELS], ['gpt-5.6-sol', 'gpt-6-astra']);
    assert.equal(Object.keys(EVALUATOR_MODEL_FAMILIES).includes('gpt-5.6-terra'), true, 'Terra는 계열 비교용으로 남아 있어야 합니다.');
  });

  it('Sol + Terra는 독립 평가 둘로 인정하지 않는다', () => {
    const registry = clone(AROEDA_VALIDATOR_REGISTRY);
    const astra = profileOf(registry, ASTRA_PROFILE_ID);
    astra.modelId = 'gpt-5.6-terra';
    astra.independenceGroup = 'openai-gpt-5-6-terra'; // 다른 그룹인 척한다
    assertRejected(registry, '같은 모델 계열', 'Sol + Terra');
  });

  it('Sol을 이름만 바꿔 두 번 부르는 구성은 거절한다', () => {
    const registry = clone(AROEDA_VALIDATOR_REGISTRY);
    const astra = profileOf(registry, ASTRA_PROFILE_ID);
    astra.modelId = SOL_MODEL_ID;
    astra.independenceGroup = 'openai-gpt-5-6-second-run';
    assertRejected(registry, '두 평가자가 함께 씁니다', 'Sol 두 번');
  });

  it('두 평가자가 같은 독립 그룹이면 거절한다', () => {
    const registry = clone(AROEDA_VALIDATOR_REGISTRY);
    profileOf(registry, ASTRA_PROFILE_ID).independenceGroup = profileOf(registry, SOL_PROFILE_ID).independenceGroup;
    assertRejected(registry, 'independenceGroup', '같은 그룹');
  });

  // 위 시험은 "계열이 정한 그룹과 다르다"는 사유에도 함께 걸린다.
  // 그래서 그룹 중복 자체만으로 걸리는 경우를 따로 둔다. 모델과 무관한 두 profile을 쓴다.
  it('모델과 무관한 두 profile이 독립 그룹을 함께 써도 거절한다', () => {
    const registry = clone(AROEDA_VALIDATOR_REGISTRY);
    const shared = profileOf(registry, DEMAND_COUNTER_PROFILE_ID).independenceGroup;
    profileOf(registry, DETERMINISTIC_PROFILE_ID).independenceGroup = shared;
    const result = checkValidatorRegistryPolicy(registry);
    assert.equal(result.valid, false);
    assert.deepEqual(
      result.errors,
      [`registry: independenceGroup ${shared}을(를) ${DEMAND_COUNTER_PROFILE_ID}, ${DETERMINISTIC_PROFILE_ID}가 함께 씁니다.`],
      '그룹 중복 하나만 사유여야 합니다.',
    );
  });

  it('승인 목록에 없는 모델은 거절한다', () => {
    const registry = clone(AROEDA_VALIDATOR_REGISTRY);
    const astra = profileOf(registry, ASTRA_PROFILE_ID);
    astra.modelId = 'gpt-5.6-terra';
    astra.independenceGroup = 'openai-gpt-5-6';
    assertRejected(registry, '승인 목록에 없습니다', '미승인 모델');
  });

  it('모델 평가자가 둘이 아니면 거절한다', () => {
    const one = clone(AROEDA_VALIDATOR_REGISTRY);
    one.profiles = one.profiles.filter((p) => p.profileId !== ASTRA_PROFILE_ID);
    assertRejected(one, '모델 평가자는 2개여야 합니다', '평가자 하나');

    const three = clone(AROEDA_VALIDATOR_REGISTRY);
    const extra = clone(profileOf(three, ASTRA_PROFILE_ID));
    extra.profileId = 'aroeda-theology-zeta';
    extra.independenceGroup = 'openai-gpt-6-zeta';
    three.profiles = [...three.profiles, extra];
    assertRejected(three, '모델 평가자는 2개여야 합니다', '평가자 셋');
  });
});

describe('실제 validator registry · D. 변조하면 거절한다', () => {
  it('profile 하나가 빠지면 거절한다', () => {
    for (const profileId of REQUIRED_PROFILE_IDS) {
      const registry = clone(AROEDA_VALIDATOR_REGISTRY);
      registry.profiles = registry.profiles.filter((p) => p.profileId !== profileId);
      assertRejected(registry, `${profileId} profile이 없습니다`, `${profileId} 제거`);
    }
  });

  it('검증 항목이 미할당되면 거절한다', () => {
    const registry = clone(AROEDA_VALIDATOR_REGISTRY);
    const deterministic = profileOf(registry, DETERMINISTIC_PROFILE_ID);
    deterministic.authorizedChecks = deterministic.authorizedChecks.filter((name) => name !== 'krvTextMatch');
    assertRejected(registry, 'krvTextMatch', 'krvTextMatch 미할당');
  });

  it('검증 항목이 중복 할당되면 거절한다', () => {
    const registry = clone(AROEDA_VALIDATOR_REGISTRY);
    const extra = clone(profileOf(registry, DETERMINISTIC_PROFILE_ID));
    // 오름차순은 그대로 지킨다. 순서 위반이 아니라 중복 배정으로 걸려야 한다.
    extra.profileId = 'aroeda-deterministic-mirror';
    extra.independenceGroup = 'aroeda-deterministic-mirror';
    registry.profiles = [...registry.profiles.slice(0, 2), extra, ...registry.profiles.slice(2)];
    assert.deepEqual(
      registry.profiles.map((p) => `${p.profileId}@${p.profileVersion}`),
      [...registry.profiles.map((p) => `${p.profileId}@${p.profileVersion}`)].sort(),
      '이 변조는 정렬을 깨지 않아야 합니다.',
    );
    assertRejected(registry, '맡은 profile이 2개입니다', '결정적 검사 중복');
  });

  it('잘못된 종류가 항목을 맡으면 거절한다', () => {
    const registry = clone(AROEDA_VALIDATOR_REGISTRY);
    profileOf(registry, DEMAND_COUNTER_PROFILE_ID).authorizedChecks = ['krvTextMatch'];
    const result = checkValidatorRegistryPolicy(registry);
    assert.equal(result.valid, false);
    assert.ok(result.errors.join(' ').includes('판정할 수 없는'), result.errors.join(' / '));
  });

  it('rubric 버전이 어긋나면 거절한다', () => {
    const registry = clone(AROEDA_VALIDATOR_REGISTRY);
    profileOf(registry, SOL_PROFILE_ID).rubricVersion = 'aroeda-theology-rubric/v2';
    assertRejected(registry, 'rubricVersion', 'rubric 버전 불일치');
  });

  it('모델 평가자가 아닌데 모델이 적혀 있으면 거절한다', () => {
    const registry = clone(AROEDA_VALIDATOR_REGISTRY);
    profileOf(registry, DEMAND_COUNTER_PROFILE_ID).modelId = SOL_MODEL_ID;
    const result = checkValidatorRegistryPolicy(registry);
    assert.equal(result.valid, false);
  });

  it('배열 순서가 canonical order가 아니면 거절한다', () => {
    const registry = clone(AROEDA_VALIDATOR_REGISTRY);
    registry.profiles = [...registry.profiles].reverse();
    assertRejected(registry, '오름차순', '역순 배열');
  });
});

describe('실제 validator registry · E. 실행 순서와 Astra 게이트', () => {
  const stages = VALIDATION_STAGES;
  const order = (stageId: string) => stages.find((stage) => stage.stageId === stageId)!.order;

  it('단계는 수요 → 결정적 → Sol → Astra 순서다', () => {
    assert.deepEqual(
      stages.map((stage) => stage.stageId),
      ['demand-counter', 'deterministic-checks', 'theology-sol', 'theology-astra'],
    );
    assert.deepEqual(stages.map((stage) => stage.order), [1, 2, 3, 4]);
    assert.ok(order('theology-sol') < order('theology-astra'), 'Sol이 Astra보다 먼저여야 합니다.');
    assert.equal(stages[stages.length - 1].profileId, ASTRA_PROFILE_ID, 'Astra가 마지막이어야 합니다.');
  });

  it('단계 정책 검사를 통과한다', () => {
    const result = checkValidationStagePolicy();
    assert.deepEqual(result.errors, []);
  });

  it('Astra를 Sol보다 앞으로 옮기면 거절한다', () => {
    const swapped: ValidationStage[] = clone([...stages]) as ValidationStage[];
    const sol = swapped.find((s) => s.stageId === 'theology-sol')!;
    const astra = swapped.find((s) => s.stageId === 'theology-astra')!;
    sol.order = 4;
    astra.order = 3;
    astra.requiresStages = ['demand-counter', 'deterministic-checks'];
    sol.requiresStages = ['demand-counter', 'deterministic-checks', 'theology-astra'];
    const reordered = [...swapped].sort((a, b) => a.order - b.order);
    const result = checkValidationStagePolicy(AROEDA_VALIDATOR_REGISTRY, reordered);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((error) => error.includes('Astra는 Sol보다 뒤여야 합니다')), result.errors.join(' / '));
  });

  // Sol 뒤이기만 하면 되는 것이 아니라 '마지막'이어야 한다.
  // Sol 다음에 오지만 뒤에 다른 단계가 남아 있는 배치를 따로 시험한다.
  it('Astra 뒤에 다른 단계가 남아 있으면 거절한다(Sol보다는 뒤인데도)', () => {
    const tampered: ValidationStage[] = clone([...stages]) as ValidationStage[];
    const find = (id: string) => tampered.find((s) => s.stageId === id)!;
    find('theology-sol').order = 2;
    find('theology-sol').requiresStages = ['demand-counter'];
    find('theology-astra').order = 3;
    find('theology-astra').requiresStages = ['demand-counter', 'theology-sol'];
    find('deterministic-checks').order = 4;
    find('deterministic-checks').requiresStages = ['demand-counter'];
    const reordered = [...tampered].sort((a, b) => a.order - b.order);

    const result = checkValidationStagePolicy(AROEDA_VALIDATOR_REGISTRY, reordered);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((error) => error.includes('Astra는 마지막 단계여야 합니다')), result.errors.join(' / '));
  });

  it('단계 ID를 복제해 다른 단계를 없애면 거절한다', () => {
    const tampered: ValidationStage[] = clone([...stages]) as ValidationStage[];
    tampered[1].stageId = 'demand-counter';
    const result = checkValidationStagePolicy(AROEDA_VALIDATOR_REGISTRY, tampered);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((error) => error.includes('단계 ID와 배열 순서')), result.errors.join(' / '));
  });

  it('단계의 담당 profile·산출물·선행 조건을 각각 바꾸면 거절한다', () => {
    const mutations: Array<(items: ValidationStage[]) => void> = [
      (items) => {
        items[0].profileId = DETERMINISTIC_PROFILE_ID;
      },
      (items) => {
        items[1].producesChecks = ['passageExistence'];
      },
      (items) => {
        items[2].requiresStages = ['demand-counter'];
      },
    ];
    for (const mutate of mutations) {
      const tampered: ValidationStage[] = clone([...stages]) as ValidationStage[];
      mutate(tampered);
      assert.equal(checkValidationStagePolicy(AROEDA_VALIDATOR_REGISTRY, tampered).valid, false);
    }
  });

  it('Astra가 Sol을 선행 조건에서 빼면 거절한다', () => {
    const tampered: ValidationStage[] = clone([...stages]) as ValidationStage[];
    tampered.find((s) => s.stageId === 'theology-astra')!.requiresStages = ['demand-counter', 'deterministic-checks'];
    const result = checkValidationStagePolicy(AROEDA_VALIDATOR_REGISTRY, tampered);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((error) => error.includes('Sol을 선행 조건으로')), result.errors.join(' / '));
  });

  const baseFacts = (): StageGateFacts => ({
    stageId: 'theology-astra',
    completedStages: ['demand-counter', 'deterministic-checks', 'theology-sol'],
    demandThresholdMet: true,
    deterministicAllPassed: true,
    solCardVerdicts: [
      { cardId: 'SC-052', verdict: 'pass' },
      { cardId: 'SC-053', verdict: 'pass' },
    ],
    candidateCardIds: ['SC-052', 'SC-053'],
    pinned: { candidateHash: 'sccand_a', baseVersionHash: 'scat_a', rubricVersion: THEOLOGY_RUBRIC_VERSION },
    observed: { candidateHash: 'sccand_a', baseVersionHash: 'scat_a', rubricVersion: THEOLOGY_RUBRIC_VERSION },
  });

  it('네 조건이 모두 참이면 Astra를 부를 수 있다', () => {
    const result = evaluateStageGate(baseFacts());
    assert.deepEqual(result.blockers, []);
    assert.equal(result.allowed, true);
  });

  it('수요 기준을 넘지 못하면 Astra를 부를 수 없다', () => {
    const facts = baseFacts();
    facts.demandThresholdMet = false;
    const result = evaluateStageGate(facts);
    assert.equal(result.allowed, false);
    assert.ok(result.blockers.some((item) => item.includes('수요 기준')), result.blockers.join(' / '));
  });

  it('결정적 검사가 하나라도 실패하면 Astra를 부를 수 없다', () => {
    const facts = baseFacts();
    facts.deterministicAllPassed = false;
    const result = evaluateStageGate(facts);
    assert.equal(result.allowed, false);
    assert.ok(result.blockers.some((item) => item.includes('결정적 검사')), result.blockers.join(' / '));
  });

  it('Sol이 한 카드라도 통과시키지 않으면 Astra를 부를 수 없다', () => {
    const facts = baseFacts();
    facts.solCardVerdicts = [
      { cardId: 'SC-052', verdict: 'pass' },
      { cardId: 'SC-053', verdict: 'fail' },
    ];
    const result = evaluateStageGate(facts);
    assert.equal(result.allowed, false);
    assert.ok(result.blockers.some((item) => item.includes('SC-053')), result.blockers.join(' / '));
  });

  it('Sol이 후보 카드 하나를 빠뜨리면 Astra를 부를 수 없다', () => {
    const facts = baseFacts();
    facts.solCardVerdicts = [{ cardId: 'SC-052', verdict: 'pass' }];
    const result = evaluateStageGate(facts);
    assert.equal(result.allowed, false);
    assert.ok(result.blockers.some((item) => item.includes('Sol 평가에 SC-053가 없습니다')), result.blockers.join(' / '));
  });

  it('Sol이 같은 카드 판정을 두 번 적으면 Astra를 부를 수 없다', () => {
    const facts = baseFacts();
    facts.solCardVerdicts = [
      { cardId: 'SC-052', verdict: 'pass' },
      { cardId: 'SC-052', verdict: 'pass' },
      { cardId: 'SC-053', verdict: 'pass' },
    ];
    const result = evaluateStageGate(facts);
    assert.equal(result.allowed, false);
    assert.ok(result.blockers.some((item) => item.includes('같은 카드가 두 번')), result.blockers.join(' / '));
  });

  it('후보 카드 번호 자체가 중복되면 Astra를 부를 수 없다', () => {
    const facts = baseFacts();
    facts.candidateCardIds = ['SC-052', 'SC-052'];
    facts.solCardVerdicts = [{ cardId: 'SC-052', verdict: 'pass' }];
    const result = evaluateStageGate(facts);
    assert.equal(result.allowed, false);
    assert.ok(result.blockers.some((item) => item.includes('후보 카드 번호가 중복')), result.blockers.join(' / '));
  });

  it('Sol 단계를 건너뛰면 Astra를 부를 수 없다', () => {
    const facts = baseFacts();
    facts.completedStages = ['demand-counter', 'deterministic-checks'];
    const result = evaluateStageGate(facts);
    assert.equal(result.allowed, false);
    assert.ok(result.blockers.some((item) => item.includes('theology-sol가 끝나지 않았습니다')), result.blockers.join(' / '));
  });

  it('후보·기준 버전·rubric 버전이 중간에 바뀌면 Astra를 부를 수 없다', () => {
    for (const field of ['candidateHash', 'baseVersionHash', 'rubricVersion'] as const) {
      const facts = baseFacts();
      facts.observed = { ...facts.observed, [field]: 'changed' };
      const result = evaluateStageGate(facts);
      assert.equal(result.allowed, false, field);
      assert.ok(result.blockers.some((item) => item.includes('중간에 바뀌었습니다')), `${field}: ${result.blockers.join(' / ')}`);
    }
  });

  it('고정한 rubric 버전이 현재 rubric과 다르면 어느 단계도 돌릴 수 없다', () => {
    const facts = baseFacts();
    facts.pinned = { ...facts.pinned, rubricVersion: 'aroeda-theology-rubric/v0' };
    facts.observed = { ...facts.observed, rubricVersion: 'aroeda-theology-rubric/v0' };
    const result = evaluateStageGate(facts);
    assert.equal(result.allowed, false);
    assert.ok(result.blockers.some((item) => item.includes('현재 rubric과 다릅니다')), result.blockers.join(' / '));
  });

  it('Sol 단계도 결정적 검사가 끝나야 돌릴 수 있다', () => {
    const facts = baseFacts();
    facts.stageId = 'theology-sol';
    facts.completedStages = ['demand-counter'];
    facts.deterministicAllPassed = false;
    const result = evaluateStageGate(facts);
    assert.equal(result.allowed, false);
    assert.ok(result.blockers.some((item) => item.includes('deterministic-checks가 끝나지 않았습니다')), result.blockers.join(' / '));
  });

  it('첫 단계는 선행 조건 없이 돌릴 수 있다', () => {
    const facts = baseFacts();
    facts.stageId = 'demand-counter';
    facts.completedStages = [];
    facts.demandThresholdMet = false;
    facts.deterministicAllPassed = false;
    facts.solCardVerdicts = [];
    const result = evaluateStageGate(facts);
    assert.deepEqual(result.blockers, []);
  });

  it('알 수 없는 단계는 거절한다', () => {
    const facts = baseFacts();
    (facts as { stageId: string }).stageId = 'theology-terra';
    assert.equal(evaluateStageGate(facts).allowed, false);
  });
});

describe('실제 validator registry · F. rubric', () => {
  it('아홉 개 기준이 순서대로 들어 있고 각각 fail 사례가 있다', () => {
    assert.deepEqual(
      THEOLOGY_REVIEW_RUBRIC.criteria.map((item) => item.criterionId),
      [
        'context-fidelity',
        'no-unpromised-outcome',
        'no-divine-intent-claim',
        'domain-tag-support',
        'crisis-guidance-precedence',
        'no-coerced-reconciliation',
        'krv-citation-integrity',
        'new-domain-distinctness',
        'uncertainty-defaults-to-fail',
      ],
    );
    for (const criterion of THEOLOGY_REVIEW_RUBRIC.criteria) {
      assert.ok(criterion.title.length > 0, criterion.criterionId);
      assert.ok(criterion.requirement.length > 0, criterion.criterionId);
      assert.ok(criterion.failWhen.length > 0, criterion.criterionId);
    }
  });

  it('불확실하면 fail이고, 한 카드라도 실패하면 후보 전체가 실패다', () => {
    assert.equal(THEOLOGY_REVIEW_RUBRIC.verdictOnUncertainty, 'fail');
    assert.equal(THEOLOGY_REVIEW_RUBRIC.verdictScope, 'per_card_all_must_pass');
  });

  it('rubric 버전이 두 평가자의 rubricVersion과 정확히 이어져 있다', () => {
    assert.equal(THEOLOGY_REVIEW_RUBRIC.rubricVersion, THEOLOGY_RUBRIC_VERSION);
    assert.equal(THEOLOGY_RUBRIC_VERSION, 'aroeda-theology-rubric/v1');
    for (const profileId of [SOL_PROFILE_ID, ASTRA_PROFILE_ID]) {
      assert.equal(profileOf(AROEDA_VALIDATOR_REGISTRY, profileId).rubricVersion, THEOLOGY_RUBRIC_VERSION);
    }
  });

  it('rubric 지문이 고정돼 있다', async () => {
    assert.equal(await computeTheologyRubricFingerprint(), EXPECTED_RUBRIC_FINGERPRINT);
    assert.equal(THEOLOGY_RUBRIC_FINGERPRINT, EXPECTED_RUBRIC_FINGERPRINT);
    const result = await checkTheologyRubricIntegrity();
    assert.deepEqual(result.errors, []);
  });

  it('문구만 고치고 버전을 그대로 두면 지문이 잡는다', async () => {
    const tampered = clone(THEOLOGY_REVIEW_RUBRIC) as TheologyReviewRubric;
    (tampered.criteria as unknown as { requirement: string }[])[0].requirement += ' (살짝 고침)';
    assert.equal(tampered.rubricVersion, THEOLOGY_RUBRIC_VERSION, '버전은 그대로 두었다');
    const result = await checkTheologyRubricIntegrity(tampered);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((error) => error.includes('다시 계산한 지문')), result.errors.join(' / '));
  });

  it('fail 사례 한 줄을 지워도 지문이 잡는다', async () => {
    const tampered = clone(THEOLOGY_REVIEW_RUBRIC) as TheologyReviewRubric;
    (tampered.criteria as unknown as { failWhen: string[] }[])[4].failWhen.pop();
    const result = await checkTheologyRubricIntegrity(tampered);
    assert.equal(result.valid, false);
  });

  it('불확실할 때의 판정을 pass로 바꾸면 거절한다', async () => {
    const tampered = clone(THEOLOGY_REVIEW_RUBRIC) as TheologyReviewRubric;
    (tampered as { verdictOnUncertainty: string }).verdictOnUncertainty = 'pass';
    const result = await checkTheologyRubricIntegrity(tampered);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((error) => error.includes('fail이어야')), result.errors.join(' / '));
  });
});

describe('실제 validator registry · G. 지문 고정과 바깥 호출 부재', () => {
  it('profile 네 개의 지문이 고정돼 있다', async () => {
    for (const profile of AROEDA_VALIDATOR_REGISTRY.profiles) {
      const hash = await computeValidatorProfileHash(profile);
      assert.equal(hash, EXPECTED_PROFILE_HASHES[profile.profileId], profile.profileId);
      assert.match(hash, /^svp_[0-9a-f]{64}$/);
    }
    assert.equal(Object.keys(EXPECTED_PROFILE_HASHES).length, 4);
  });

  it('registry 전체 지문이 고정돼 있다', async () => {
    const hash = await computeValidatorRegistryHash(AROEDA_VALIDATOR_REGISTRY);
    assert.equal(hash, EXPECTED_REGISTRY_HASH);
    assert.match(hash, /^svreg_[0-9a-f]{64}$/);
  });

  it('profile을 한 글자만 고쳐도 지문이 달라진다', async () => {
    const registry = clone(AROEDA_VALIDATOR_REGISTRY);
    profileOf(registry, SOL_PROFILE_ID).independenceGroup = 'openai-gpt-5-7';
    assert.notEqual(await computeValidatorRegistryHash(registry), EXPECTED_REGISTRY_HASH);
    assert.notEqual(
      await computeValidatorProfileHash(profileOf(registry, SOL_PROFILE_ID)),
      EXPECTED_PROFILE_HASHES[SOL_PROFILE_ID],
    );
  });

  it('registry 모듈에 네트워크·OpenAI·Supabase 호출이 없다', () => {
    const source = readFileSync(
      path.join(
        path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..'),
        'supabase/functions/_shared/automatic-scripture-catalog-validator-registry.ts',
      ),
      'utf8',
    );
    const code = source
      .split('\n')
      .filter((line) => !/^\s*(\*|\/\/|\/\*)/.test(line))
      .join('\n');
    for (const token of ['fetch(', 'XMLHttpRequest', 'WebSocket', 'createClient(', "from 'openai'", 'https://', 'Deno.', 'process.env']) {
      assert.equal(code.includes(token), false, `registry 모듈에 ${token}가 있습니다.`);
    }
    // functions 폴더 바깥을 참조하지 않는다.
    for (const specifier of [...code.matchAll(/from\s+'([^']+)'/g)].map((match) => match[1])) {
      assert.equal(specifier.startsWith('./'), true, specifier);
    }
  });

  it('계약 검사와 게이트는 fetch를 막아 두어도 그대로 돈다', async () => {
    const original = globalThis.fetch;
    let called = 0;
    globalThis.fetch = (() => {
      called += 1;
      throw new Error('이 테스트는 바깥으로 나가지 않습니다.');
    }) as typeof fetch;
    try {
      assert.equal(checkValidatorRegistryPolicy().valid, true);
      assert.equal(checkValidationStagePolicy().valid, true);
      assert.equal((await checkTheologyRubricIntegrity()).valid, true);
      assert.equal(await computeValidatorRegistryHash(AROEDA_VALIDATOR_REGISTRY), EXPECTED_REGISTRY_HASH);
      assert.equal(await computeTheologyRubricFingerprint(), EXPECTED_RUBRIC_FINGERPRINT);
    } finally {
      globalThis.fetch = original;
    }
    assert.equal(called, 0, '바깥으로 나가는 호출이 있었습니다.');
  });
});

describe('실제 validator registry · H. 기존 검증 계약과 맞물리는가', () => {
  /**
   * fixture registry 자리에 실제 registry를 넣어도 검증 기록이 성립하는지 본다.
   * foundation fixture 전체를 갈아엎지 않고, 실제 registry에 묶이는 세 곳만 바꿔 끼운다.
   *   1. 기록의 validatorRegistryHash
   *   2. 신학 평가 payload의 평가자 profile 지문
   *   3. modelIdentifiers.evaluators (등록된 평가자의 실제 모델 목록)
   * 이 셋 말고 더 손대야 한다면 registry가 계약과 어긋난 것이다.
   */
  const buildRecordOnRealRegistry = async () => {
    const base = buildBaselineCatalog();
    const candidate = await makeExistingDomainCandidate(base);
    const record = await makePassingValidationRecord(candidate.candidate, candidate.candidateHash, base);

    record.validatorRegistryHash = await computeValidatorRegistryHash(AROEDA_VALIDATOR_REGISTRY);
    const evaluatorHashes: string[] = [];
    for (const profileId of [SOL_PROFILE_ID, ASTRA_PROFILE_ID]) {
      evaluatorHashes.push(await computeValidatorProfileHash(profileOf(AROEDA_VALIDATOR_REGISTRY, profileId)));
    }
    record.checks.contextTheologyReview.payload.evaluations.forEach((evaluation, index) => {
      evaluation.profileHash = evaluatorHashes[index];
    });
    record.modelIdentifiers.evaluators = [SOL_MODEL_ID, ASTRA_MODEL_ID];
    await resealRecord(record);

    return { base, candidate, record, attestations: makeAttestations(record, AROEDA_VALIDATOR_REGISTRY) };
  };

  it('실제 registry로 만든 검증 기록이 활성화 계약을 통과한다', async () => {
    const fixture = await buildRecordOnRealRegistry();
    assert.equal(fixture.attestations.length, 9, '항목 8개 중 신학 평가만 둘이라 9개여야 합니다.');

    const result = await validateAutomaticValidationRecord(fixture.record, {
      candidate: fixture.candidate.candidate,
      baseCatalog: fixture.base,
      resolvePassageText: resolveKrvPassage,
      validatorRegistry: AROEDA_VALIDATOR_REGISTRY,
      attestations: fixture.attestations,
    });
    assert.deepEqual(result.errors, []);
    assert.equal(result.valid, true);
    assert.deepEqual(result.activationBlockers, []);
  });

  it('실제 registry의 attestation은 Sol과 Astra 둘이 각각 낸다', async () => {
    const fixture = await buildRecordOnRealRegistry();
    const theology = fixture.attestations.filter((item) => item.checkName === 'contextTheologyReview');
    assert.equal(theology.length, 2);
    const profileHashes = new Set(theology.map((item) => item.profileHash));
    assert.equal(profileHashes.size, 2, '같은 profile이 두 번 낸 것이 아니어야 합니다.');
    for (const profileId of [SOL_PROFILE_ID, ASTRA_PROFILE_ID]) {
      assert.ok(
        profileHashes.has(await computeValidatorProfileHash(profileOf(AROEDA_VALIDATOR_REGISTRY, profileId))),
        `${profileId}의 attestation이 없습니다.`,
      );
    }
  });

  it('평가자를 Sol 하나로 줄이면 활성화가 막힌다', async () => {
    const fixture = await buildRecordOnRealRegistry();
    const solHash = await computeValidatorProfileHash(profileOf(AROEDA_VALIDATOR_REGISTRY, SOL_PROFILE_ID));
    fixture.record.checks.contextTheologyReview.payload.evaluations.forEach((evaluation) => {
      evaluation.profileHash = solHash;
    });
    fixture.record.modelIdentifiers.evaluators = [SOL_MODEL_ID, SOL_MODEL_ID];
    await resealRecord(fixture.record);

    const result = await validateAutomaticValidationRecord(fixture.record, {
      candidate: fixture.candidate.candidate,
      baseCatalog: fixture.base,
      resolvePassageText: resolveKrvPassage,
      validatorRegistry: AROEDA_VALIDATOR_REGISTRY,
      attestations: makeAttestations(fixture.record, AROEDA_VALIDATOR_REGISTRY),
    });
    assert.equal(result.valid && result.activationBlockers.length === 0, false, '같은 평가자 둘은 독립이 아닙니다.');
  });
});
