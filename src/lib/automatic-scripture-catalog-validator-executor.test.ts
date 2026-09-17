/** 자동 Scripture Catalog 검증 실행기의 순서·중단·봉인 계약 테스트. 외부 호출은 전부 막는다. */

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import {
  REQUIRED_VALIDATION_CHECKS,
  validateAutomaticValidationRecord,
} from '../../supabase/functions/_shared/automatic-scripture-catalog-activation-contract.ts';
import type {
  CandidateGenerationEvaluationPayload,
  CorpusRegressionPayload,
  SafetyBoundaryPayload,
} from '../../supabase/functions/_shared/automatic-scripture-catalog-activation-contract.ts';
import {
  AROEDA_VALIDATOR_REGISTRY,
  ASTRA_MODEL_ID,
  ASTRA_PROFILE_ID,
  SOL_MODEL_ID,
  SOL_PROFILE_ID,
  THEOLOGY_REVIEW_RUBRIC,
  THEOLOGY_RUBRIC_VERSION,
} from '../../supabase/functions/_shared/automatic-scripture-catalog-validator-registry.ts';
import {
  AUTOMATIC_VALIDATOR_RULE_VERSION,
  executeAutomaticScriptureCatalogValidation,
} from '../../supabase/functions/_shared/automatic-scripture-catalog-validator-executor.ts';
import type {
  AutomaticValidatorExecutorInput,
  StagePins,
  TheologyEvaluationRequest,
} from '../../supabase/functions/_shared/automatic-scripture-catalog-validator-executor.ts';
import { canonicalJson } from '../../supabase/functions/_shared/automatic-scripture-catalog-contract.ts';
import type {
  ScriptureCatalogCandidate,
  ScriptureCatalogSnapshot,
} from '../../supabase/functions/_shared/automatic-scripture-catalog-contract.ts';
import {
  FIXTURE_DEMAND_WINDOW,
  buildBaselineCatalog,
  makeDemandCells,
  makeExistingDomainCandidate,
  makeNewDomainCandidate,
  resolveKrvPassage,
} from './automatic-scripture-catalog-test-fixtures.ts';

type Calls = { safety: number; corpus: number; generation: number; sol: number; astra: number; observed: number };

const passingSafety = (): SafetyBoundaryPayload => ({
  rulesVersion: 'executor-safety/v1',
  cases: Array.from({ length: 12 }, (_, index) => ({
    caseId: `SAFE-${String(index + 1).padStart(3, '0')}`,
    expectedRoute: 'safety',
    observedRoute: 'safety',
  })),
});

const passingCorpus = (): CorpusRegressionPayload => ({
  corpusVersion: 'executor-corpus/v1',
  cases: Array.from({ length: 10 }, (_, index) => ({
    caseId: `EVAL-${String(index + 1).padStart(3, '0')}`,
    baseline: { domainMatch: index % 2 === 0, acceptableMatch: index % 3 === 0, safetyFalsePositive: false },
    candidate: { domainMatch: true, acceptableMatch: true, safetyFalsePositive: false },
  })),
});

const passingGeneration = (candidate: ScriptureCatalogCandidate): CandidateGenerationEvaluationPayload => ({
  cases: candidate.cards.flatMap((card, cardIndex) =>
    Array.from({ length: 3 }, (_, index) => ({
      caseId: `GEN-${cardIndex + 1}-${index + 1}`,
      cardId: card.id,
      passed: true,
    })),
  ),
});

/** 카드마다 rubric criterion 전부를 같은 verdict로 채운다. 모델은 criterion만 낸다 — 카드 최종 verdict는 없다. */
const criteriaAll = (verdict: 'pass' | 'fail') =>
  THEOLOGY_REVIEW_RUBRIC.criteria.map((criterion) => ({ criterionId: criterion.criterionId, verdict }));
const verdicts = (candidate: ScriptureCatalogCandidate, verdict: 'pass' | 'fail' = 'pass') =>
  candidate.cards.map((card) => ({ cardId: card.id, criteria: criteriaAll(verdict) }));

async function makeHarness(
  options: {
    candidateKind?: 'existing' | 'new-domain';
    demandCells?: AutomaticValidatorExecutorInput['demandCells'];
    safety?: unknown;
    corpus?: unknown;
    generation?: unknown;
    sol?: unknown | ((request: TheologyEvaluationRequest) => unknown);
    astra?: unknown | ((request: TheologyEvaluationRequest) => unknown);
    resolvePassageText?: AutomaticValidatorExecutorInput['deterministic']['resolvePassageText'];
    observePins?: (pinned: StagePins, calls: Calls) => StagePins | Promise<StagePins>;
  } = {},
) {
  const base = buildBaselineCatalog();
  const fixture = options.candidateKind === 'new-domain'
    ? await makeNewDomainCandidate(base)
    : await makeExistingDomainCandidate(base);
  const candidate = fixture.candidate;
  const calls: Calls = { safety: 0, corpus: 0, generation: 0, sol: 0, astra: 0, observed: 0 };
  const pinned: StagePins = {
    candidateHash: fixture.candidateHash,
    baseVersionHash: candidate.baseVersionHash,
    rubricVersion: THEOLOGY_RUBRIC_VERSION,
  };

  const input: AutomaticValidatorExecutorInput = {
    candidate,
    baseCatalog: base,
    demandWindow: FIXTURE_DEMAND_WINDOW,
    demandCells: options.demandCells ?? makeDemandCells(candidate.demandBinding),
    evaluationCorpusVersion: 'executor-corpus/v1',
    deterministic: {
      resolvePassageText: options.resolvePassageText ?? resolveKrvPassage,
      evaluateSafetyBoundary: async () => {
        calls.safety += 1;
        return options.safety ?? passingSafety();
      },
      evaluateCorpusRegression: async () => {
        calls.corpus += 1;
        return options.corpus ?? passingCorpus();
      },
      evaluateCandidateGeneration: async () => {
        calls.generation += 1;
        return options.generation ?? passingGeneration(candidate);
      },
    },
    evaluateSol: async (request) => {
      calls.sol += 1;
      return typeof options.sol === 'function' ? options.sol(request) : options.sol ?? verdicts(candidate);
    },
    evaluateAstra: async (request) => {
      calls.astra += 1;
      return typeof options.astra === 'function' ? options.astra(request) : options.astra ?? verdicts(candidate);
    },
    observePins: async () => {
      calls.observed += 1;
      return options.observePins ? options.observePins(pinned, calls) : pinned;
    },
  };
  return { base, candidate, calls, input };
}

async function assertRecordValid(
  result: Awaited<ReturnType<typeof executeAutomaticScriptureCatalogValidation>>,
  candidate: ScriptureCatalogCandidate,
  base: ScriptureCatalogSnapshot,
) {
  assert.ok('record' in result && result.record);
  assert.ok('attestations' in result && result.attestations);
  const check = await validateAutomaticValidationRecord(result.record, {
    candidate,
    baseCatalog: base,
    resolvePassageText: resolveKrvPassage,
    validatorRegistry: AROEDA_VALIDATOR_REGISTRY,
    attestations: result.attestations,
  });
  assert.equal(check.valid, true, check.errors.join(' / '));
}

let originalFetch: typeof globalThis.fetch | undefined;
beforeEach(() => {
  originalFetch = globalThis.fetch;
  globalThis.fetch = (() => {
    throw new Error('검증 실행기 테스트에서 외부 호출을 시도했습니다.');
  }) as typeof globalThis.fetch;
});
afterEach(() => {
  if (originalFetch) globalThis.fetch = originalFetch;
});

describe('자동 validator 실행기 · 정상 경로', () => {
  it('등록 순서대로 네 단계를 한 번씩 실행하고 검증 가능한 기록·9개 attestation을 만든다', async () => {
    const { input, calls, candidate, base } = await makeHarness();
    const result = await executeAutomaticScriptureCatalogValidation(input);

    assert.equal(result.kind, 'validated');
    assert.deepEqual(result.stageTrace, [
      { stageId: 'demand-counter', outcome: 'pass', reasonCodes: [] },
      { stageId: 'deterministic-checks', outcome: 'pass', reasonCodes: [] },
      { stageId: 'theology-sol', outcome: 'pass', reasonCodes: [] },
      { stageId: 'theology-astra', outcome: 'pass', reasonCodes: [] },
    ]);
    assert.deepEqual(calls, { safety: 1, corpus: 1, generation: 1, sol: 1, astra: 1, observed: 4 });
    assert.equal(result.attestations.length, 9);
    assert.equal(result.attestationHashes.length, 9);
    assert.equal(new Set(result.attestationHashes).size, 9);
    assert.equal(result.record.overallStatus, 'pass');
    assert.equal(result.record.validatorRuleVersion, AUTOMATIC_VALIDATOR_RULE_VERSION);
    assert.deepEqual(result.record.modelIdentifiers.evaluators, [ASTRA_MODEL_ID, SOL_MODEL_ID].sort());
    assert.deepEqual(Object.keys(result.record.checks), REQUIRED_VALIDATION_CHECKS);
    await assertRecordValid(result, candidate, base);
  });

  it('같은 입력은 기록·지문·attestation까지 같은 결과를 만든다', async () => {
    const first = await makeHarness();
    const second = await makeHarness();
    const a = await executeAutomaticScriptureCatalogValidation(first.input);
    const b = await executeAutomaticScriptureCatalogValidation(second.input);
    assert.equal(a.kind, 'validated');
    assert.equal(b.kind, 'validated');
    assert.deepEqual(a, b);
  });

  it('새 영역 후보도 같은 네 단계와 독립 평가 둘을 통과한다', async () => {
    const { input, calls, candidate, base } = await makeHarness({ candidateKind: 'new-domain' });
    const result = await executeAutomaticScriptureCatalogValidation(input);
    assert.equal(result.kind, 'validated');
    assert.equal(candidate.cards.length, 3);
    assert.equal(calls.sol, 1);
    assert.equal(calls.astra, 1);
    await assertRecordValid(result, candidate, base);
  });

  it('Sol·Astra 연결부에는 등록 모델·profile·동일 rubric만 전달한다', async () => {
    const seen: TheologyEvaluationRequest[] = [];
    const { input, candidate } = await makeHarness({
      sol: (request: TheologyEvaluationRequest) => { seen.push(request); return verdicts(request.candidate); },
      astra: (request: TheologyEvaluationRequest) => { seen.push(request); return verdicts(request.candidate); },
    });
    const result = await executeAutomaticScriptureCatalogValidation(input);
    assert.equal(result.kind, 'validated');
    assert.equal(seen.length, 2);
    assert.equal(seen[0].modelId, SOL_MODEL_ID);
    assert.equal(seen[0].profileId, SOL_PROFILE_ID);
    assert.equal(seen[1].modelId, ASTRA_MODEL_ID);
    assert.equal(seen[1].profileId, ASTRA_PROFILE_ID);
    assert.notEqual(seen[0].candidate, candidate);
    assert.deepEqual(seen[0].candidate, candidate);
    assert.equal(seen[0].rubric, THEOLOGY_REVIEW_RUBRIC);
    assert.equal(seen[1].rubric, THEOLOGY_REVIEW_RUBRIC);
  });

  it('주입된 모델이 받은 후보 복사본을 바꿔도 원본과 Astra 입력은 오염되지 않는다', async () => {
    let astraSummary = '';
    const { input, candidate } = await makeHarness({
      sol: (request: TheologyEvaluationRequest) => {
        request.candidate.cards[0].contextSummary = '외부 연결부가 잘못 바꾼 문장';
        return verdicts(request.candidate);
      },
      astra: (request: TheologyEvaluationRequest) => {
        astraSummary = request.candidate.cards[0].contextSummary;
        return verdicts(request.candidate);
      },
    });
    const originalSummary = candidate.cards[0].contextSummary;
    const result = await executeAutomaticScriptureCatalogValidation(input);
    assert.equal(result.kind, 'validated');
    assert.equal(candidate.cards[0].contextSummary, originalSummary);
    assert.equal(astraSummary, originalSummary);
  });
});

describe('자동 validator 실행기 · 앞 단계 실패는 뒤 호출을 막는다', () => {
  it('수요 기준 미달이면 결정 검사와 두 모델을 한 번도 부르지 않는다', async () => {
    const { input, calls } = await makeHarness({ demandCells: [] });
    const result = await executeAutomaticScriptureCatalogValidation(input);
    assert.equal(result.kind, 'rejected');
    if (result.kind !== 'rejected') return;
    assert.equal(result.failedStage, 'demand-counter');
    assert.deepEqual(result.reasonCodes, ['DEMAND_THRESHOLD_NOT_MET']);
    assert.deepEqual(calls, { safety: 0, corpus: 0, generation: 0, sol: 0, astra: 0, observed: 1 });
    assert.equal('record' in result, false);
  });

  it('안전 회귀가 있으면 실패 기록을 남기고 Sol·Astra를 부르지 않는다', async () => {
    const safety = passingSafety();
    safety.cases[0].observedRoute = 'recommend';
    const { input, calls, candidate, base } = await makeHarness({ safety });
    const result = await executeAutomaticScriptureCatalogValidation(input);
    assert.equal(result.kind, 'rejected');
    if (result.kind !== 'rejected') return;
    assert.equal(result.failedStage, 'deterministic-checks');
    assert.equal(result.record?.checks.safetyBoundary.status, 'fail');
    assert.equal(result.record?.checks.contextTheologyReview.status, 'not_run');
    assert.equal(result.attestations?.length, 7);
    assert.equal(calls.sol, 0);
    assert.equal(calls.astra, 0);
    await assertRecordValid(result, candidate, base);
  });

  it('코퍼스 퇴행이면 Sol·Astra를 부르지 않는다', async () => {
    const corpus = passingCorpus();
    corpus.cases[0].candidate.domainMatch = false;
    const { input, calls } = await makeHarness({ corpus });
    const result = await executeAutomaticScriptureCatalogValidation(input);
    assert.equal(result.kind, 'rejected');
    assert.equal(calls.sol, 0);
    assert.equal(calls.astra, 0);
    if (result.kind === 'rejected') assert.equal(result.record?.checks.corpusRegression.status, 'fail');
  });

  it('카드별 생성 평가가 세 건보다 적으면 Sol·Astra를 부르지 않는다', async () => {
    const base = buildBaselineCatalog();
    const { candidate } = await makeExistingDomainCandidate(base);
    const generation = passingGeneration(candidate);
    generation.cases.pop();
    const { input, calls } = await makeHarness({ generation });
    const result = await executeAutomaticScriptureCatalogValidation(input);
    assert.equal(result.kind, 'rejected');
    assert.equal(calls.sol, 0);
    assert.equal(calls.astra, 0);
    if (result.kind === 'rejected') assert.equal(result.record?.checks.candidateGenerationEvaluation.status, 'fail');
  });

  it('개역한글 본문을 읽지 못하면 실패 기록을 남기고 모델을 부르지 않는다', async () => {
    const { input, calls, candidate, base } = await makeHarness({ resolvePassageText: () => null });
    const result = await executeAutomaticScriptureCatalogValidation(input);
    assert.equal(result.kind, 'rejected');
    assert.equal(calls.sol, 0);
    assert.equal(calls.astra, 0);
    if (result.kind === 'rejected') assert.equal(result.record?.checks.krvTextMatch.status, 'fail');
    // 이 기록은 같은 null resolver로 확인하면 사실대로인 유효한 실패 기록이다.
    if (result.kind === 'rejected' && result.record && result.attestations) {
      const check = await validateAutomaticValidationRecord(result.record, {
        candidate,
        baseCatalog: base,
        resolvePassageText: () => null,
        validatorRegistry: AROEDA_VALIDATOR_REGISTRY,
        attestations: result.attestations,
      });
      assert.equal(check.valid, true, check.errors.join(' / '));
    }
  });

  it('본문 수는 맞아도 절 번호가 어긋나면 실패하고 독립 재검증도 같은 결론을 낸다', async () => {
    const shiftedResolver: AutomaticValidatorExecutorInput['deterministic']['resolvePassageText'] = (passage) => {
      const verses = resolveKrvPassage(passage);
      return verses?.map((verse) => ({ ...verse, verse: verse.verse + 1 })) ?? null;
    };
    const { input, calls, candidate, base } = await makeHarness({ resolvePassageText: shiftedResolver });
    const result = await executeAutomaticScriptureCatalogValidation(input);
    assert.equal(result.kind, 'rejected');
    assert.equal(calls.sol, 0);
    assert.equal(calls.astra, 0);
    if (result.kind !== 'rejected' || !result.record || !result.attestations) return;
    assert.equal(result.record.checks.krvTextMatch.status, 'fail');
    const verified = await validateAutomaticValidationRecord(result.record, {
      candidate,
      baseCatalog: base,
      resolvePassageText: shiftedResolver,
      validatorRegistry: AROEDA_VALIDATOR_REGISTRY,
      attestations: result.attestations,
    });
    assert.equal(verified.valid, true, verified.errors.join(' / '));
    assert.ok(verified.activationBlockers.some((item) => item.includes('krvTextMatch')));
  });

  it('Sol이 카드 하나를 fail하면 Astra를 부르지 않고 8개 attestation 기록을 남긴다', async () => {
    const { input, calls, candidate, base } = await makeHarness({ sol: (request: TheologyEvaluationRequest) => verdicts(request.candidate, 'fail') });
    const result = await executeAutomaticScriptureCatalogValidation(input);
    assert.equal(result.kind, 'rejected');
    if (result.kind !== 'rejected') return;
    assert.equal(result.failedStage, 'theology-sol');
    assert.equal(calls.sol, 1);
    assert.equal(calls.astra, 0);
    assert.equal(result.record?.checks.contextTheologyReview.status, 'fail');
    assert.equal(result.attestations?.length, 8);
    await assertRecordValid(result, candidate, base);
  });

  it('Astra가 fail하면 두 평가를 모두 기록하되 전체 활성화는 거절한다', async () => {
    const { input, calls, candidate, base } = await makeHarness({ astra: (request: TheologyEvaluationRequest) => verdicts(request.candidate, 'fail') });
    const result = await executeAutomaticScriptureCatalogValidation(input);
    assert.equal(result.kind, 'rejected');
    if (result.kind !== 'rejected') return;
    assert.equal(result.failedStage, 'theology-astra');
    assert.equal(calls.sol, 1);
    assert.equal(calls.astra, 1);
    assert.equal(result.record?.checks.contextTheologyReview.status, 'fail');
    assert.equal(result.attestations?.length, 9);
    await assertRecordValid(result, candidate, base);
  });
});

describe('자동 validator 실행기 · 모양 오류·변경 감지는 fail-closed', () => {
  for (const sample of [
    { label: '누락', make: (candidate: ScriptureCatalogCandidate) => verdicts(candidate).slice(1) },
    { label: '중복', make: (candidate: ScriptureCatalogCandidate) => [verdicts(candidate)[0], verdicts(candidate)[0]] },
    { label: '후보 밖 카드', make: (candidate: ScriptureCatalogCandidate) => [{ ...verdicts(candidate)[0], cardId: 'SC-999' }] },
    {
      label: '알 수 없는 criterion 판정',
      make: (candidate: ScriptureCatalogCandidate) => {
        const [first] = verdicts(candidate);
        return [{ ...first, criteria: [{ ...first.criteria[0], verdict: 'maybe' }, ...first.criteria.slice(1)] }];
      },
    },
    {
      label: '카드에 최종 verdict를 끼워 넣음(모델이 카드 판정을 스스로 냄)',
      make: (candidate: ScriptureCatalogCandidate) => [{ ...verdicts(candidate)[0], verdict: 'pass' }],
    },
    {
      // 앞쪽 criterion들은 순서대로 정확히 맞는 채 마지막 하나만 빠진 경우. 차례 비교가 짧은
      // 배열 안에서는 전부 들어맞아 버리므로, criterion 개수 자체를 반드시 대조해야 잡힌다.
      label: 'criterion 누락(뒤쪽)',
      make: (candidate: ScriptureCatalogCandidate) => {
        const [first, ...rest] = verdicts(candidate);
        return [{ ...first, criteria: first.criteria.slice(0, -1) }, ...rest];
      },
    },
    {
      label: 'criterion 순서 뒤바뀜(같은 criterion 집합)',
      make: (candidate: ScriptureCatalogCandidate) => {
        const [first, ...rest] = verdicts(candidate);
        return [{ ...first, criteria: [...first.criteria].reverse() }, ...rest];
      },
    },
  ]) {
    it(`Sol 결과 ${sample.label}은 unavailable이고 Astra 호출은 0회다`, async () => {
      const { input, calls } = await makeHarness({ sol: (request: TheologyEvaluationRequest) => sample.make(request.candidate) });
      const result = await executeAutomaticScriptureCatalogValidation(input);
      assert.equal(result.kind, 'unavailable');
      if (result.kind === 'unavailable') assert.equal(result.failedStage, 'theology-sol');
      assert.equal(calls.sol, 1);
      assert.equal(calls.astra, 0);
    });
  }

  it('Astra 결과가 누락되면 unavailable이고 검증 기록을 꾸며 내지 않는다', async () => {
    const { input, calls } = await makeHarness({ astra: [] });
    const result = await executeAutomaticScriptureCatalogValidation(input);
    assert.equal(result.kind, 'unavailable');
    assert.equal(calls.sol, 1);
    assert.equal(calls.astra, 1);
    assert.equal('record' in result, false);
  });

  it('결정 검사 payload가 malformed면 두 모델을 부르지 않고 unavailable이다', async () => {
    const { input, calls } = await makeHarness({ safety: { rulesVersion: 'x', cases: [], pass: true } });
    const result = await executeAutomaticScriptureCatalogValidation(input);
    assert.equal(result.kind, 'unavailable');
    if (result.kind === 'unavailable') assert.deepEqual(result.reasonCodes, ['DETERMINISTIC_PAYLOAD_INVALID']);
    assert.equal(calls.sol, 0);
    assert.equal(calls.astra, 0);
  });

  it('Astra 직전 후보 지문이 달라지면 Astra를 부르지 않는다', async () => {
    const { input, calls } = await makeHarness({
      observePins: (pinned, current) => current.observed === 4 ? { ...pinned, candidateHash: `sccand_${'0'.repeat(64)}` } : pinned,
    });
    const result = await executeAutomaticScriptureCatalogValidation(input);
    assert.equal(result.kind, 'unavailable');
    if (result.kind === 'unavailable') assert.equal(result.failedStage, 'theology-astra');
    assert.equal(calls.sol, 1);
    assert.equal(calls.astra, 0);
    assert.equal(result.stageTrace.at(-1)?.outcome, 'blocked');
  });

  it('rubric 버전이 중간에 바뀌면 다음 단계를 실행하지 않는다', async () => {
    const { input, calls } = await makeHarness({
      observePins: (pinned, current) => current.observed === 3 ? { ...pinned, rubricVersion: 'changed-rubric/v2' } : pinned,
    });
    const result = await executeAutomaticScriptureCatalogValidation(input);
    assert.equal(result.kind, 'unavailable');
    if (result.kind === 'unavailable') assert.equal(result.failedStage, 'theology-sol');
    assert.equal(calls.sol, 0);
    assert.equal(calls.astra, 0);
  });

  it('candidate 자체가 무효면 어떤 adapter도 부르지 않는다', async () => {
    const { input, calls } = await makeHarness();
    input.candidate = { bad: true };
    const result = await executeAutomaticScriptureCatalogValidation(input);
    assert.equal(result.kind, 'unavailable');
    if (result.kind === 'unavailable') assert.equal(result.failedStage, 'input');
    assert.deepEqual(calls, { safety: 0, corpus: 0, generation: 0, sol: 0, astra: 0, observed: 0 });
  });

  it('평가 코퍼스 버전이 비었거나 공백뿐이거나 너무 길면 어떤 adapter도 부르지 않는다', async () => {
    for (const bad of ['', '   ', 'x'.repeat(101), ' padded ']) {
      const { input, calls } = await makeHarness();
      input.evaluationCorpusVersion = bad;
      const result = await executeAutomaticScriptureCatalogValidation(input);
      assert.equal(result.kind, 'unavailable', JSON.stringify(bad));
      if (result.kind === 'unavailable') assert.deepEqual(result.reasonCodes, ['CORPUS_VERSION_INVALID']);
      assert.deepEqual(calls, { safety: 0, corpus: 0, generation: 0, sol: 0, astra: 0, observed: 0 }, JSON.stringify(bad));
    }
  });
});

describe('자동 validator 실행기 · adapter는 본문 밖 필드를 끼워 넣지 못한다', () => {
  it('Sol이 카드 판정에 profileHash·status·설명·카드 최종 verdict 같은 여분 필드를 끼워 넣으면 unavailable이다', async () => {
    const { input, calls } = await makeHarness({
      sol: (request: TheologyEvaluationRequest) =>
        request.candidate.cards.map((card) => ({
          cardId: card.id,
          criteria: criteriaAll('pass'),
          verdict: 'pass',
          profileHash: 'svp_' + '0'.repeat(64),
          explanation: '모델이 스스로 적어 넣은 설명',
        })),
    });
    const result = await executeAutomaticScriptureCatalogValidation(input);
    assert.equal(result.kind, 'unavailable');
    if (result.kind === 'unavailable') assert.equal(result.failedStage, 'theology-sol');
    assert.equal(calls.astra, 0);
  });

  it('Sol이 criterion 판정에 설명·확신도 같은 여분 필드를 끼워 넣으면 unavailable이다', async () => {
    const { input, calls } = await makeHarness({
      sol: (request: TheologyEvaluationRequest) =>
        request.candidate.cards.map((card) => ({
          cardId: card.id,
          criteria: THEOLOGY_REVIEW_RUBRIC.criteria.map((criterion) => ({
            criterionId: criterion.criterionId,
            verdict: 'pass',
            confidence: 0.9,
          })),
        })),
    });
    const result = await executeAutomaticScriptureCatalogValidation(input);
    assert.equal(result.kind, 'unavailable');
    if (result.kind === 'unavailable') assert.equal(result.failedStage, 'theology-sol');
    assert.equal(calls.astra, 0);
  });

  it('Sol이 판정 순서를 바꿔 돌려주면(같은 카드 집합) unavailable이고 Astra는 부르지 않는다', async () => {
    const { input, calls } = await makeHarness({
      candidateKind: 'new-domain',
      sol: (request: TheologyEvaluationRequest) => [...verdicts(request.candidate)].reverse(),
    });
    const result = await executeAutomaticScriptureCatalogValidation(input);
    assert.equal(result.kind, 'unavailable');
    if (result.kind === 'unavailable') assert.equal(result.failedStage, 'theology-sol');
    assert.equal(calls.astra, 0);
  });

  it('Sol 연결부가 예외를 던지면 unavailable이고 Astra는 부르지 않는다', async () => {
    const { input, calls } = await makeHarness({
      sol: () => { throw new Error('네트워크 실패'); },
    });
    const result = await executeAutomaticScriptureCatalogValidation(input);
    assert.equal(result.kind, 'unavailable');
    if (result.kind === 'unavailable') assert.equal(result.failedStage, 'theology-sol');
    assert.equal(calls.astra, 0);
  });

  it('Astra 연결부가 예외를 던지면 unavailable이고 가짜 기록을 만들지 않는다', async () => {
    const { input, calls } = await makeHarness({
      astra: () => { throw new Error('네트워크 실패'); },
    });
    const result = await executeAutomaticScriptureCatalogValidation(input);
    assert.equal(result.kind, 'unavailable');
    if (result.kind === 'unavailable') assert.equal(result.failedStage, 'theology-astra');
    assert.equal(calls.sol, 1);
    assert.equal('record' in result, false);
  });

  it('결정적 adapter가 예외를 던지면 unavailable이고 두 모델을 부르지 않는다', async () => {
    const { input, calls } = await makeHarness();
    input.deterministic.evaluateSafetyBoundary = async () => { throw new Error('timeout'); };
    const result = await executeAutomaticScriptureCatalogValidation(input);
    assert.equal(result.kind, 'unavailable');
    if (result.kind === 'unavailable') assert.deepEqual(result.reasonCodes, ['DETERMINISTIC_ADAPTER_UNAVAILABLE']);
    assert.equal(calls.sol, 0);
    assert.equal(calls.astra, 0);
  });

  it('safetyBoundary payload에 여분 필드가 있으면 unavailable이다(형만 맞춰서는 통과하지 못한다)', async () => {
    const safety = passingSafety() as unknown as Record<string, unknown>;
    (safety as { extra?: string }).extra = '허용되지 않은 필드';
    const { input, calls } = await makeHarness({ safety });
    const result = await executeAutomaticScriptureCatalogValidation(input);
    assert.equal(result.kind, 'unavailable');
    if (result.kind === 'unavailable') assert.deepEqual(result.reasonCodes, ['DETERMINISTIC_PAYLOAD_INVALID']);
    assert.equal(calls.sol, 0);
    assert.equal(calls.astra, 0);
  });
});

describe('자동 validator 실행기 · adapter가 받는 candidate 복사본은 서로 격리된다', () => {
  it('결정적 adapter 하나가 넘겨받은 candidate를 바꿔도 다른 결정적 adapter·Sol·원본은 오염되지 않는다', async () => {
    const seenBySafety: string[] = [];
    const seenByCorpus: string[] = [];
    let seenBySol = '';
    const { input, candidate } = await makeHarness();
    const originalSummary = candidate.cards[0].contextSummary;

    input.deterministic.evaluateSafetyBoundary = async (received) => {
      seenBySafety.push(received.cards[0].contextSummary);
      received.cards[0].contextSummary = 'safety adapter가 잘못 바꾼 문장';
      return passingSafety();
    };
    input.deterministic.evaluateCorpusRegression = async (received) => {
      seenByCorpus.push(received.cards[0].contextSummary);
      return passingCorpus();
    };
    input.evaluateSol = async (request) => {
      seenBySol = request.candidate.cards[0].contextSummary;
      return verdicts(request.candidate);
    };

    const result = await executeAutomaticScriptureCatalogValidation(input);
    assert.equal(result.kind, 'validated');
    assert.deepEqual(seenBySafety, [originalSummary]);
    assert.deepEqual(seenByCorpus, [originalSummary], 'safety adapter의 변조가 corpus adapter로 새면 안 됩니다.');
    assert.equal(seenBySol, originalSummary, 'safety adapter의 변조가 Sol 입력으로 새면 안 됩니다.');
    assert.equal(candidate.cards[0].contextSummary, originalSummary, '원본 candidate는 그대로여야 합니다.');
  });
});

describe('자동 validator 실행기 · 완성된 기록은 다시 검증해야만 반환된다', () => {
  it('resolver가 기록을 만든 뒤 딴말을 하면(내부 재검증 불일치) 가짜 기록 대신 unavailable을 낸다', async () => {
    // 첫 호출(기록을 짓는 동안)에는 실제 본문을, 이후 호출(finish()의 독립 재검증)에는
    // 빈 본문을 돌려주는 resolver다. 실행기 스스로는 통과로 적었지만 다시 확인하면 걸린다.
    let calls = 0;
    const inconsistentResolver: AutomaticValidatorExecutorInput['deterministic']['resolvePassageText'] = (passage) => {
      calls += 1;
      const real = resolveKrvPassage(passage);
      if (calls <= 1) return real;
      return real ? real.map((verse) => ({ ...verse, text: '' })) : null;
    };
    const { input, calls: adapterCalls } = await makeHarness({ resolvePassageText: inconsistentResolver });
    const result = await executeAutomaticScriptureCatalogValidation(input);
    assert.equal(result.kind, 'unavailable');
    if (result.kind === 'unavailable') {
      assert.equal(result.failedStage, 'theology-astra');
      assert.deepEqual(result.reasonCodes, ['SELF_VALIDATION_FAILED']);
    }
    assert.ok(calls >= 2, 'resolver가 기록 작성과 재검증 양쪽에서 불려야 합니다.');
    assert.equal(adapterCalls.sol, 1);
    assert.equal(adapterCalls.astra, 1, 'Astra까지 통과한 뒤에야 마지막 재검증에서 걸려야 합니다.');
    assert.equal('record' in result, false, '내부 재검증이 실패했으면 기록을 내보내면 안 됩니다.');
  });
});

describe('자동 validator 실행기 · Sol·Astra에 넘기는 증거', () => {
  it('기준 카탈로그 영역이 id 오름차순으로, 영역 셋(id·displayName·description)만 담겨 간다', async () => {
    const seen: TheologyEvaluationRequest[] = [];
    const { input, base } = await makeHarness({
      sol: (request: TheologyEvaluationRequest) => { seen.push(request); return verdicts(request.candidate); },
    });
    const result = await executeAutomaticScriptureCatalogValidation(input);
    assert.equal(result.kind, 'validated');
    const request = seen[0];
    assert.equal(request.baselineDomains.length, base.domains.length);
    assert.ok(base.domains.length > 0);
    const ids = request.baselineDomains.map((domain) => domain.id);
    assert.deepEqual(ids, [...ids].sort());
    assert.deepEqual(new Set(ids), new Set(base.domains.map((domain) => domain.id)));
    for (const domain of request.baselineDomains) {
      assert.deepEqual(Object.keys(domain).sort(), ['description', 'displayName', 'id']);
    }
  });

  it('새 영역 후보에도 기존 17개 영역 정보가 그대로 제공된다', async () => {
    const seen: TheologyEvaluationRequest[] = [];
    const { input, base, candidate } = await makeHarness({
      candidateKind: 'new-domain',
      sol: (request: TheologyEvaluationRequest) => { seen.push(request); return verdicts(request.candidate); },
    });
    const result = await executeAutomaticScriptureCatalogValidation(input);
    assert.equal(result.kind, 'validated');
    assert.equal(candidate.candidateKind, 'new_domain_with_cards');
    assert.equal(seen[0].baselineDomains.length, base.domains.length);
    assert.ok(seen[0].baselineDomains.every((domain) => !('cards' in domain)));
  });

  it('실제 개역한글 본문이 후보 카드·본문 순서 그대로 담겨 간다(resolver로 다시 읽지 않고 재사용)', async () => {
    const seen: TheologyEvaluationRequest[] = [];
    const { input, candidate } = await makeHarness({
      candidateKind: 'new-domain',
      sol: (request: TheologyEvaluationRequest) => { seen.push(request); return verdicts(request.candidate); },
    });
    const result = await executeAutomaticScriptureCatalogValidation(input);
    assert.equal(result.kind, 'validated');
    const expected = candidate.cards.flatMap((card, cardIndex) =>
      card.passages.map((passage, passageIndex) => ({ cardId: card.id, passageIndex, passage, cardIndex })),
    );
    assert.equal(seen[0].verifiedPassages.length, expected.length);
    seen[0].verifiedPassages.forEach((evidence, index) => {
      assert.equal(evidence.cardId, expected[index].cardId, `${index}: cardId 순서`);
      assert.equal(evidence.passageIndex, expected[index].passageIndex, `${index}: passageIndex 순서`);
      assert.deepEqual(evidence.passage, expected[index].passage, `${index}: passage`);
      const real = resolveKrvPassage(expected[index].passage)!;
      assert.deepEqual(evidence.verses, real.map((verse) => ({ verse: verse.verse, text: verse.text })), `${index}: 실제 개역한글 본문과 같아야 합니다.`);
    });
  });

  it('Sol·Astra는 modelId·profileId만 다르고 나머지 증거는 canonical JSON이 완전히 같다', async () => {
    const seen: TheologyEvaluationRequest[] = [];
    const { input } = await makeHarness({
      candidateKind: 'new-domain',
      sol: (request: TheologyEvaluationRequest) => { seen.push(request); return verdicts(request.candidate); },
      astra: (request: TheologyEvaluationRequest) => { seen.push(request); return verdicts(request.candidate); },
    });
    const result = await executeAutomaticScriptureCatalogValidation(input);
    assert.equal(result.kind, 'validated');
    assert.equal(seen.length, 2);
    assert.notEqual(seen[0].modelId, seen[1].modelId);
    assert.notEqual(seen[0].profileId, seen[1].profileId);
    const strip = (request: TheologyEvaluationRequest) => {
      const { modelId, profileId, ...rest } = request;
      return rest;
    };
    assert.equal(canonicalJson(strip(seen[0])), canonicalJson(strip(seen[1])));
  });

  it('본문 resolver는 결정 검사에서만 불리고, Sol·Astra를 부르는 동안에는 추가로 불리지 않는다', async () => {
    let resolverCalls = 0;
    const callsWhenSolCalled: number[] = [];
    const callsWhenAstraCalled: number[] = [];
    const countingResolver: AutomaticValidatorExecutorInput['deterministic']['resolvePassageText'] = (passage) => {
      resolverCalls += 1;
      return resolveKrvPassage(passage);
    };
    const { input, candidate } = await makeHarness({
      candidateKind: 'new-domain',
      resolvePassageText: countingResolver,
      sol: (request: TheologyEvaluationRequest) => { callsWhenSolCalled.push(resolverCalls); return verdicts(request.candidate); },
      astra: (request: TheologyEvaluationRequest) => { callsWhenAstraCalled.push(resolverCalls); return verdicts(request.candidate); },
    });
    const expectedPassageCount = candidate.cards.flatMap((card) => card.passages).length;
    const result = await executeAutomaticScriptureCatalogValidation(input);
    assert.equal(result.kind, 'validated');
    assert.equal(callsWhenSolCalled[0], expectedPassageCount, '결정 검사에서 부른 횟수(본문 수)와 같아야 합니다.');
    assert.equal(callsWhenAstraCalled[0], expectedPassageCount, 'Sol을 부르는 동안 resolver를 추가로 부르면 안 됩니다.');
  });

  it('본문 검증에 실패하면 Sol에게 증거 자체가 전달되지 않는다(호출이 아예 없다)', async () => {
    const { input, calls } = await makeHarness({ resolvePassageText: () => null });
    const result = await executeAutomaticScriptureCatalogValidation(input);
    assert.equal(result.kind, 'rejected');
    assert.equal(calls.sol, 0);
    assert.equal(calls.astra, 0);
  });

  it('Sol이 받은 증거(baselineDomains·verifiedPassages)를 바꿔도 Astra 입력과 원본은 그대로다', async () => {
    let astraDomainsSeen = 0;
    let astraPassagesSeen = 0;
    const { input, candidate } = await makeHarness({
      candidateKind: 'new-domain',
      sol: (request: TheologyEvaluationRequest) => {
        (request.baselineDomains as unknown as { id: string }[]).push({ id: 'injected', displayName: 'x', description: 'y' } as never);
        (request.verifiedPassages as unknown as { verses: unknown }[])[0].verses = [{ verse: 999, text: '조작된 본문' }];
        return verdicts(request.candidate);
      },
      astra: (request: TheologyEvaluationRequest) => {
        astraDomainsSeen = request.baselineDomains.length;
        astraPassagesSeen = request.verifiedPassages[0].verses.length === 1 && request.verifiedPassages[0].verses[0].verse === 999 ? -1 : request.verifiedPassages.length;
        return verdicts(request.candidate);
      },
    });
    const originalDomainCount = 17;
    const originalPassageCount = candidate.cards.flatMap((card) => card.passages).length;
    const result = await executeAutomaticScriptureCatalogValidation(input);
    assert.equal(result.kind, 'validated');
    assert.equal(astraDomainsSeen, originalDomainCount, 'Sol이 늘린 영역이 Astra로 새면 안 됩니다.');
    assert.equal(astraPassagesSeen, originalPassageCount, 'Sol이 조작한 본문이 Astra로 새면 안 됩니다.');
  });

  it('기준 카탈로그 전체 카드·API 키·사용자 원문은 증거 어디에도 없다', async () => {
    const seen: TheologyEvaluationRequest[] = [];
    const { input, base } = await makeHarness({
      candidateKind: 'new-domain',
      sol: (request: TheologyEvaluationRequest) => { seen.push(request); return verdicts(request.candidate); },
    });
    const result = await executeAutomaticScriptureCatalogValidation(input);
    assert.equal(result.kind, 'validated');
    // 기준 카탈로그에는 카드가 51장 있다. baselineDomains에는 영역 셋(id·displayName·description)만 있어야 하고
    // 그 51장 카드 내용(예: 기준 카탈로그의 다른 영역 카드 지시문 등)이 새어 들어가면 안 된다.
    assert.ok(base.cards.length > 0);
    const domainsSerialized = JSON.stringify(seen[0].baselineDomains);
    assert.equal(domainsSerialized.includes('"cards"'), false, 'baselineDomains에 카드 목록이 들어가면 안 됩니다.');
    assert.equal(seen[0].baselineDomains.every((domain) => Object.keys(domain).length === 3), true);
    const fullSerialized = JSON.stringify(seen[0]);
    for (const forbidden of ['sk-', 'situationText', 'userText', 'apiKey', 'OPENAI_API_KEY', 'password']) {
      assert.equal(fullSerialized.includes(forbidden), false, forbidden);
    }
  });
});
