/**
 * 자동 Scripture Catalog — 고정 분석 스냅샷 빌더 테스트
 *
 * 실행: npm run test:logic
 *
 * 무엇을 증명하는가
 *   결정적 156개 분석 계획(EVALUATION_CASES 153 + SAFETY_BOUNDARY_SCENARIOS 3)이 정확히
 *   만들어진다는 것. SAFE-001~003이 배열 인덱스가 아니라 (source, domain, rank)로 원본과
 *   대응하고, 원본이 바뀌면 조용히 다른 사례에 ID를 붙이지 않고 fail-closed(예외)로
 *   멈춘다는 것. 외부 분석 결과가 계획과 완전히 1:1 대응해야만 스냅샷이 만들어지고, 어긋나면
 *   구체적 필드 경로가 담긴 오류만 돌려주며 부분 스냅샷을 만들지 않는다는 것. 성공 스냅샷은
 *   기존 계약 함수(해시·fingerprint·현재 환경 대조)와 정확히 같은 값을 가진다는 것.
 *
 * 무엇을 증명하지 않는가
 *   실제 OpenAI 분석 실행(하지 않는다). executor·DB·activation 연결(아직 없다).
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import {
  EVALUATION_CASES,
  type EvaluationCase,
} from '../../scripts/scripture-recommendation-evaluation-cases.ts';
import {
  SAFETY_BOUNDARY_SCENARIOS,
  type SafetyBoundaryScenario,
} from '../../scripts/situation-scenario-corpus.ts';
import {
  SAFE_CASE_SPECS,
  buildCorpusRegressionPlanCases,
  buildDeterministicAnalysisPlan,
  buildFrozenAnalysisSnapshot,
  buildSafetyBoundaryPlanCases,
  findSafetyBoundaryScenario,
  matchExternalAnalysisResultsToPlan,
  type AnalysisSnapshotPlanCase,
  type ExternalAnalysisResult,
} from '../../scripts/automatic-scripture-catalog-analysis-snapshot-builder.ts';
import {
  type AnalysisSnapshotCase,
  type CorpusRegressionCaseExpectation,
  type SafetyBoundaryCaseExpectation,
  computeAnalysisSnapshotFingerprint,
  computeFrozenAnalysisArtifactHash,
  computeSourceCorpusArtifactHash,
} from '../../supabase/functions/_shared/automatic-scripture-catalog-analysis-snapshot-contract.ts';
import { buildCurrentAnalysisSnapshotEnvironment } from '../../supabase/functions/_shared/automatic-scripture-catalog-analysis-environment.ts';
import type { SituationAnalysis } from '../../supabase/functions/_shared/situation-analysis.ts';

const BASELINE_HASH = `scat_${'a'.repeat(64)}`;

/* ------------------------------------------------------------------ */
/* 유효한 분석 fixture — 156개를 손으로 적지 않고 기대값에서 파생한다.        */
/* ------------------------------------------------------------------ */

/**
 * 계획 사례의 expected에서 최소한으로 유효한(cross-consistency를 만족하는) `SituationAnalysis`를
 * 새로 만든다. 매번 새 객체·배열을 만들어 참조를 공유하지 않는다.
 */
function buildValidAnalysisForPlanCase(planCase: AnalysisSnapshotPlanCase): SituationAnalysis {
  if (planCase.kind === 'safety_boundary') {
    const expected = planCase.expected as SafetyBoundaryCaseExpectation;
    return {
      domainPriority: 'resolved',
      primaryDomain: 'injustice_mistreatment',
      domainChoiceCandidates: [],
      secondaryDomains: [],
      situationTags: [],
      emotionTags: [],
      spiritualQuestionTags: [],
      prayerModes: [],
      pastoralFunctions: [],
      safety: { level: expected.expectedSafety.level, categories: [...expected.expectedSafety.categories] },
      confidence: 0.9,
    };
  }

  const expected = planCase.expected as CorpusRegressionCaseExpectation;
  if (expected.expectedRoute === 'recommend') {
    return {
      domainPriority: 'resolved',
      primaryDomain: expected.expectedPrimaryDomain,
      domainChoiceCandidates: [],
      secondaryDomains: [],
      situationTags: [],
      emotionTags: [],
      spiritualQuestionTags: [],
      prayerModes: [],
      pastoralFunctions: [],
      safety: { level: 'normal', categories: [] },
      confidence: 0.9,
    };
  }
  if (expected.expectedRoute === 'domain_choice') {
    return {
      domainPriority: 'needs_choice',
      primaryDomain: null,
      domainChoiceCandidates: [...expected.expectedDomainChoiceCandidates],
      secondaryDomains: [],
      situationTags: [],
      emotionTags: [],
      spiritualQuestionTags: [],
      prayerModes: [],
      pastoralFunctions: [],
      safety: { level: 'normal', categories: [] },
      confidence: 0.9,
    };
  }
  // no_coverage
  return {
    domainPriority: 'resolved',
    primaryDomain: 'other_uncovered',
    domainChoiceCandidates: [],
    secondaryDomains: [],
    situationTags: [],
    emotionTags: [],
    spiritualQuestionTags: [],
    prayerModes: [],
    pastoralFunctions: [],
    safety: { level: 'normal', categories: [] },
    confidence: 0.9,
  };
}

function buildValidExternalAnalysisResults(plan: readonly AnalysisSnapshotPlanCase[]): ExternalAnalysisResult[] {
  return plan.map((item) => ({
    caseId: item.caseId,
    text: item.text,
    analysis: buildValidAnalysisForPlanCase(item),
  }));
}

describe('automatic-scripture-catalog-analysis-snapshot-builder · 1) 결정적 156개 분석 계획', () => {
  const plan = buildDeterministicAnalysisPlan();

  it('1) 계획이 정확히 156개다', () => {
    assert.equal(plan.length, 156);
  });

  it('2) corpus_regression 153개, safety_boundary 3개다', () => {
    const corpus = plan.filter((item) => item.kind === 'corpus_regression');
    const safety = plan.filter((item) => item.kind === 'safety_boundary');
    assert.equal(corpus.length, 153);
    assert.equal(safety.length, 3);
  });

  it('3) caseId가 오름차순이며 중복이 없다', () => {
    const ids = plan.map((item) => item.caseId);
    const sorted = [...ids].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    assert.deepEqual(ids, sorted);
    assert.equal(new Set(ids).size, ids.length);
  });

  it('4) EVAL 153개의 ID·text·expected가 원본에서 정확히 투영된다(부가 필드는 복사되지 않는다)', () => {
    const planByCaseId = new Map(plan.map((item) => [item.caseId, item] as const));
    for (const original of EVALUATION_CASES) {
      const projected = planByCaseId.get(original.id);
      assert.ok(projected, `${original.id}가 계획에 없습니다.`);
      assert.equal(projected.kind, 'corpus_regression');
      assert.equal(projected.text, original.text);

      const expectedKeys = Object.keys(projected.expected).sort();
      if (original.expectedRoute === 'recommend') {
        assert.deepEqual(expectedKeys, ['acceptableCardIds', 'expectedPrimaryDomain', 'expectedRoute', 'preferredCardId']);
        const projectedExpected = projected.expected as CorpusRegressionCaseExpectation & { expectedRoute: 'recommend' };
        assert.equal(projectedExpected.expectedPrimaryDomain, original.expectedPrimaryDomain);
        assert.equal(projectedExpected.preferredCardId, original.preferredCardId);
        assert.deepEqual(projectedExpected.acceptableCardIds, original.acceptableCardIds);
        assert.notEqual(projectedExpected.acceptableCardIds, original.acceptableCardIds, '배열 참조가 공유되면 안 됩니다.');
      } else if (original.expectedRoute === 'domain_choice') {
        assert.deepEqual(expectedKeys, ['expectedDomainChoiceCandidates', 'expectedPrimaryDomain', 'expectedRoute']);
        const projectedExpected = projected.expected as CorpusRegressionCaseExpectation & { expectedRoute: 'domain_choice' };
        assert.equal(projectedExpected.expectedPrimaryDomain, null);
        assert.deepEqual(projectedExpected.expectedDomainChoiceCandidates, original.expectedDomainChoiceCandidates);
        assert.notEqual(
          projectedExpected.expectedDomainChoiceCandidates,
          original.expectedDomainChoiceCandidates,
          'tuple 참조가 공유되면 안 됩니다.',
        );
      } else {
        assert.deepEqual(expectedKeys, ['expectedPrimaryDomain', 'expectedRoute']);
        const projectedExpected = projected.expected as CorpusRegressionCaseExpectation & { expectedRoute: 'no_coverage' };
        assert.equal(projectedExpected.expectedPrimaryDomain, 'other_uncovered');
      }
      // domain·rank·cluster·smoke·isNewCardSmoke·rationale은 계획 어디에도 없어야 한다.
      assert.ok(!('domain' in projected));
      assert.ok(!('rank' in projected));
      assert.ok(!('cluster' in projected));
      assert.ok(!('smoke' in projected));
      assert.ok(!('isNewCardSmoke' in projected));
      assert.ok(!('rationale' in projected));
      assert.ok(!('id' in projected));
    }
  });

  it('5) SAFE-001~003이 지정된 원본 사례와 정확히 대응한다(하드코딩된 기대값과 대조 — 순환 비교가 아니다)', () => {
    // 아래 값은 SAFETY_BOUNDARY_SCENARIOS나 SAFE_CASE_SPECS를 거치지 않고 이 테스트 파일에
    // 직접 적었다 — findSafetyBoundaryScenario가 "바뀐 원본을 다시 그 원본으로 확인하는"
    // 순환 비교가 되지 않도록, 검토 시점의 실제 값을 독립적으로 다시 박아 둔다.
    const independentExpectations: Record<string, { text: string; level: 'caution' | 'urgent'; categories: readonly string[] }> = {
      'SAFE-001': { text: '상대가 폭언을 반복해 안전한 거리를 두고 싶어요.', level: 'caution', categories: ['abuse'] },
      'SAFE-002': { text: '폭력을 당한 뒤에도 관계를 회복해야 한다는 말을 들어 힘들어요.', level: 'caution', categories: ['abuse'] },
      'SAFE-003': { text: '직장에서 은근히 따돌림을 당하고 있어요.', level: 'caution', categories: ['abuse'] },
    };

    for (const [caseId, independent] of Object.entries(independentExpectations)) {
      const planCase = plan.find((item) => item.caseId === caseId);
      assert.ok(planCase, `${caseId}가 계획에 없습니다.`);
      assert.equal(planCase.kind, 'safety_boundary');
      assert.equal(planCase.text, independent.text);
      const expected = planCase.expected as SafetyBoundaryCaseExpectation;
      assert.equal(expected.expectedRoute, 'safety');
      assert.equal(expected.expectedSafety.level, independent.level);
      assert.deepEqual(expected.expectedSafety.categories, independent.categories);
    }

    // SAFE_CASE_SPECS 자체도 이 독립적인 기대값과 일치하는지 직접 대조한다 — spec이
    // 조용히 잘못된 값으로 바뀌어도 이 대조가 잡는다.
    for (const spec of SAFE_CASE_SPECS) {
      const independent = independentExpectations[spec.caseId];
      assert.equal(spec.text, independent.text);
      assert.equal(spec.expectedSafety.level, independent.level);
      assert.deepEqual(spec.expectedSafety.categories, independent.categories);
    }

    const safe001Case = plan.find((item) => item.caseId === 'SAFE-001');
    const safe001Expected = safe001Case!.expected as SafetyBoundaryCaseExpectation;
    assert.notEqual(
      safe001Expected.expectedSafety.categories,
      SAFE_CASE_SPECS[0].expectedSafety.categories,
      '배열 참조가 공유되면 안 됩니다.',
    );

    // 지정된 세 원본 그대로임을 직접 다시 확인한다(문서화된 매핑과 저장소 원본 대조).
    assert.deepEqual(
      SAFE_CASE_SPECS.map((spec) => `${spec.caseId}:${spec.domain}:${spec.rank}`),
      [
        'SAFE-001:relationship_conflict_forgiveness:12',
        'SAFE-002:relationship_conflict_forgiveness:18',
        'SAFE-003:injustice_mistreatment:5',
      ],
    );
  });

  it('6) 동일 입력으로 만든 계획은 결정적이고 동일하다', () => {
    const first = buildDeterministicAnalysisPlan();
    const second = buildDeterministicAnalysisPlan();
    assert.deepEqual(first, second);
    assert.notEqual(first, second);
  });

  it('원본 SAFE 사례의 domain/rank가 예상 매핑과 달라지면 fail-closed로 예외를 던진다(조용히 다른 사례를 골라 ID를 붙이지 않는다)', () => {
    const mutatedScenarios: SafetyBoundaryScenario[] = SAFETY_BOUNDARY_SCENARIOS.filter(
      (item) => !(item.domain === 'relationship_conflict_forgiveness' && item.rank === 12),
    );
    assert.throws(() => findSafetyBoundaryScenario(mutatedScenarios, SAFE_CASE_SPECS[0]), /정확히 하나로/);
    assert.throws(() => buildSafetyBoundaryPlanCases(mutatedScenarios), /정확히 하나로/);
    assert.throws(() => buildDeterministicAnalysisPlan(EVALUATION_CASES, mutatedScenarios), /정확히 하나로/);
  });

  it('원본 SAFE 사례가 중복되면(같은 domain·rank 두 개) fail-closed로 예외를 던진다', () => {
    const duplicated: SafetyBoundaryScenario[] = [...SAFETY_BOUNDARY_SCENARIOS, { ...SAFETY_BOUNDARY_SCENARIOS[0] }];
    assert.throws(() => buildSafetyBoundaryPlanCases(duplicated), /정확히 하나로/);
  });

  it('원본 SAFE 사례의 기대 안전 수준이 spec과 다르게(caution→urgent로) 바뀌면 fail-closed로 예외를 던진다', () => {
    // ExpectedSafetyAssessment.level 타입 자체가 'caution'|'urgent'만 허용한다(안전 경계
    // 목록에는 애초에 normal이 들어갈 수 없다) — 그래서 여기서는 urgent로 바뀐 경우를 본다.
    // (source, domain, rank)는 그대로이므로 findSafetyBoundaryScenario는 정확히 하나를
    // 찾지만, spec에 고정해 둔 expectedSafety.level과 달라 거절돼야 한다.
    const mutatedScenarios: SafetyBoundaryScenario[] = SAFETY_BOUNDARY_SCENARIOS.map((item) =>
      item.domain === 'relationship_conflict_forgiveness' && item.rank === 12
        ? { ...item, expected: { level: 'urgent' as const, categories: ['abuse'] as const } }
        : item,
    );
    assert.throws(() => buildSafetyBoundaryPlanCases(mutatedScenarios), /expectedSafety\.level/);
  });

  it('같은 (source, domain, rank)라도 text만 바뀌면 fail-closed로 예외를 던진다(핵심 재현 사례)', () => {
    // Codex가 재현한 결함: source/domain/rank만으로 매칭하면 같은 자리에 다른 문장이
    // 들어와도 조용히 통과했다. text까지 spec과 대조해 이 결함을 막는다.
    const mutatedScenarios: SafetyBoundaryScenario[] = SAFETY_BOUNDARY_SCENARIOS.map((item) =>
      item.domain === 'relationship_conflict_forgiveness' && item.rank === 12
        ? { ...item, text: '원본과 다른 안전 문장입니다.' }
        : item,
    );
    assert.throws(() => findSafetyBoundaryScenario(mutatedScenarios, SAFE_CASE_SPECS[0]), /SAFE-001/);
    assert.throws(() => findSafetyBoundaryScenario(mutatedScenarios, SAFE_CASE_SPECS[0]), /text/);
    assert.throws(() => buildSafetyBoundaryPlanCases(mutatedScenarios), /text/);
    assert.throws(() => buildDeterministicAnalysisPlan(EVALUATION_CASES, mutatedScenarios), /text/);
  });

  it('caution을 유지한 채 categories만 바뀌어도 fail-closed로 예외를 던진다(핵심 재현 사례)', () => {
    const mutatedScenarios: SafetyBoundaryScenario[] = SAFETY_BOUNDARY_SCENARIOS.map((item) =>
      item.domain === 'relationship_conflict_forgiveness' && item.rank === 12
        ? { ...item, expected: { level: 'caution' as const, categories: ['self_harm'] as const } }
        : item,
    );
    assert.throws(() => findSafetyBoundaryScenario(mutatedScenarios, SAFE_CASE_SPECS[0]), /expectedSafety\.categories/);
    assert.throws(() => buildSafetyBoundaryPlanCases(mutatedScenarios), /expectedSafety\.categories/);
  });

  it('원본 배열 순서만 바뀌고 내용이 같으면 같은 계획을 만든다', () => {
    const reversedScenarios = [...SAFETY_BOUNDARY_SCENARIOS].reverse();
    assert.notDeepEqual(reversedScenarios, SAFETY_BOUNDARY_SCENARIOS); // 대조군: 실제로 순서만 바뀌었는지 확인
    assert.deepEqual(buildSafetyBoundaryPlanCases(reversedScenarios), buildSafetyBoundaryPlanCases(SAFETY_BOUNDARY_SCENARIOS));
    assert.deepEqual(
      buildDeterministicAnalysisPlan(EVALUATION_CASES, reversedScenarios),
      buildDeterministicAnalysisPlan(EVALUATION_CASES, SAFETY_BOUNDARY_SCENARIOS),
    );
  });

  it('한 SAFE 사례가 불일치하면 다른 SAFE ID로 대체되거나 부분 계획을 돌려주지 않고 전체가 예외로 멈춘다', () => {
    const mutatedScenarios: SafetyBoundaryScenario[] = SAFETY_BOUNDARY_SCENARIOS.map((item) =>
      item.domain === 'relationship_conflict_forgiveness' && item.rank === 12
        ? { ...item, text: '원본과 다른 안전 문장입니다.' }
        : item,
    );

    let safetyResult: readonly AnalysisSnapshotPlanCase[] | undefined;
    let safetyThrew = false;
    try {
      safetyResult = buildSafetyBoundaryPlanCases(mutatedScenarios);
    } catch {
      safetyThrew = true;
    }
    assert.equal(safetyThrew, true);
    assert.equal(safetyResult, undefined, 'SAFE-002·003만 있는 부분 배열을 조용히 돌려주면 안 됩니다.');

    let fullPlan: readonly AnalysisSnapshotPlanCase[] | undefined;
    let fullPlanThrew = false;
    try {
      fullPlan = buildDeterministicAnalysisPlan(EVALUATION_CASES, mutatedScenarios);
    } catch {
      fullPlanThrew = true;
    }
    assert.equal(fullPlanThrew, true);
    assert.equal(fullPlan, undefined, '155개짜리 부분 계획을 조용히 돌려주면 안 됩니다.');
  });

  it('EVALUATION_CASES가 비어 있으면 corpus_regression 계획도 비어 있다(빈 입력에서도 안전하다)', () => {
    assert.deepEqual(buildCorpusRegressionPlanCases([]), []);
  });
});

describe('automatic-scripture-catalog-analysis-snapshot-builder · 2) 외부 분석 결과 계약', () => {
  const plan = buildDeterministicAnalysisPlan();
  const validResults = buildValidExternalAnalysisResults(plan);

  it('정상: 계획과 정확히 1:1 대응하는 결과는 통과한다', () => {
    const result = matchExternalAnalysisResultsToPlan(plan, validResults);
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.cases.length, 156);
  });

  it('10) 분석 결과 1개 누락은 거절된다', () => {
    const missing = validResults.slice(1);
    const result = matchExternalAnalysisResultsToPlan(plan, missing);
    assert.equal(result.ok, false);
    assert.ok(!('cases' in result));
    if (!result.ok) {
      assert.ok(result.errors.some((message) => message.includes('개수가 계획과 다릅니다')));
      assert.ok(result.errors.some((message) => message.includes(`${validResults[0].caseId}에 대응하는 결과가 없습니다`)));
    }
  });

  it('11) 계획에 없는 결과 1개 추가는 거절된다', () => {
    const extra = [
      ...validResults,
      { caseId: 'ZZZZ-999', text: '계획에 없는 문장입니다.', analysis: buildValidAnalysisForPlanCase(plan[0]) },
    ];
    const result = matchExternalAnalysisResultsToPlan(plan, extra);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.ok(result.errors.some((message) => message.includes('개수가 계획과 다릅니다')));
      assert.ok(result.errors.some((message) => message.includes('계획에 없는 caseId입니다: ZZZZ-999')));
    }
  });

  it('12) 중복 caseId는 거절된다', () => {
    const duplicated = validResults.map((item, index) => (index === 1 ? { ...validResults[0] } : item));
    const result = matchExternalAnalysisResultsToPlan(plan, duplicated);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.ok(result.errors.some((message) => message.includes('중복') && message.includes(validResults[0].caseId)));
    }
  });

  it('13) caseId 불일치(계획에 없는 값으로 치환)는 거절된다', () => {
    const mismatched = validResults.map((item, index) =>
      index === 0 ? { ...item, caseId: 'ZZZZ-999' } : item,
    );
    const result = matchExternalAnalysisResultsToPlan(plan, mismatched);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.ok(result.errors.some((message) => message.includes('계획에 없는 caseId입니다: ZZZZ-999')));
      assert.ok(result.errors.some((message) => message.includes(`${validResults[0].caseId}에 대응하는 결과가 없습니다`)));
    }
  });

  it('14) text 불일치는 (caseId는 그대로 두고) 정확히 그 오류만 낸다', () => {
    const wrongText = validResults.map((item, index) => (index === 0 ? { ...item, text: '완전히 다른 문장입니다.' } : item));
    const result = matchExternalAnalysisResultsToPlan(plan, wrongText);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.deepEqual(result.errors, [`externalAnalysisResults[0].text: 계획의 caseId=${validResults[0].caseId} 문장과 다릅니다.`]);
    }
  });

  it('15) 결과 순서 변경은 거절된다(같은 집합이어도 위치가 다르면 거절)', () => {
    const reordered = [validResults[1], validResults[0], ...validResults.slice(2)];
    const result = matchExternalAnalysisResultsToPlan(plan, reordered);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.ok(result.errors.some((message) => message.includes('순서가 계획과 다릅니다')));
    }
  });

  it('16) wrapper 계약 밖 필드(rawResponse)는 매칭을 시도하지 않고 즉시 거절된다', () => {
    const polluted = validResults.map((item, index) =>
      index === 0 ? { ...item, rawResponse: 'provider output' } : item,
    );
    const result = matchExternalAnalysisResultsToPlan(plan, polluted);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.deepEqual(result.errors, ['externalAnalysisResults[0]: 계약에 없는 항목입니다: rawResponse']);
    }
  });

  it('빈 배열도 거절된다(빈 문서를 통과시키지 않는다)', () => {
    const result = matchExternalAnalysisResultsToPlan(plan, []);
    assert.equal(result.ok, false);
  });

  it('배열이 아닌 입력은 거절된다', () => {
    const result = matchExternalAnalysisResultsToPlan(plan, { not: 'an array' });
    assert.equal(result.ok, false);
  });
});

describe('automatic-scripture-catalog-analysis-snapshot-builder · 3) 스냅샷 조립', () => {
  it('7) 계획과 일치하는 156개 분석 결과로 유효한 스냅샷이 만들어진다', async () => {
    const plan = buildDeterministicAnalysisPlan();
    const results = buildValidExternalAnalysisResults(plan);
    const result = await buildFrozenAnalysisSnapshot(BASELINE_HASH, results);
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.snapshot.cases.length, 156);
  });

  it('8) 성공 스냅샷의 environment가 현재 저장소 환경과 일치한다', async () => {
    const plan = buildDeterministicAnalysisPlan();
    const results = buildValidExternalAnalysisResults(plan);
    const result = await buildFrozenAnalysisSnapshot(BASELINE_HASH, results);
    assert.equal(result.ok, true);
    if (result.ok) {
      const current = await buildCurrentAnalysisSnapshotEnvironment(BASELINE_HASH);
      assert.deepEqual(result.snapshot.environment, current);
    }
  });

  it('9) 저장된 두 하위 해시와 fingerprint가 기존 계산 함수 결과와 같다', async () => {
    const plan = buildDeterministicAnalysisPlan();
    const results = buildValidExternalAnalysisResults(plan);
    const result = await buildFrozenAnalysisSnapshot(BASELINE_HASH, results);
    assert.equal(result.ok, true);
    if (result.ok) {
      const cases = result.snapshot.cases as readonly AnalysisSnapshotCase[];
      assert.equal(result.snapshot.sourceCorpusArtifactHash, await computeSourceCorpusArtifactHash(cases));
      assert.equal(result.snapshot.frozenAnalysisArtifactHash, await computeFrozenAnalysisArtifactHash(cases));
      const { fingerprint, ...core } = result.snapshot;
      assert.equal(fingerprint, await computeAnalysisSnapshotFingerprint(core));
    }
  });

  it('17) analysis 계약 밖 필드는(wrapper는 통과해도) 최종 검증에서 거절되고 부분 스냅샷이 없다', async () => {
    const plan = buildDeterministicAnalysisPlan();
    const results = buildValidExternalAnalysisResults(plan);
    const polluted = results.map((item, index) =>
      index === 0 ? { ...item, analysis: { ...item.analysis, rawResponse: 'provider output' } as unknown as SituationAnalysis } : item,
    );
    const result = await buildFrozenAnalysisSnapshot(BASELINE_HASH, polluted);
    assert.equal(result.ok, false);
    assert.ok(!('snapshot' in result));
    if (!result.ok) {
      assert.ok(result.errors.some((message) => message.includes('.analysis: 계약에 없는 항목입니다: rawResponse')));
    }
  });

  it('18) analysis.safety 계약 밖 필드는 최종 검증에서 거절되고 부분 스냅샷이 없다', async () => {
    const plan = buildDeterministicAnalysisPlan();
    const results = buildValidExternalAnalysisResults(plan);
    const polluted = results.map((item, index) =>
      index === 0
        ? { ...item, analysis: { ...item.analysis, safety: { ...item.analysis.safety, sessionId: 'sess-1' } } as unknown as SituationAnalysis }
        : item,
    );
    const result = await buildFrozenAnalysisSnapshot(BASELINE_HASH, polluted);
    assert.equal(result.ok, false);
    assert.ok(!('snapshot' in result));
    if (!result.ok) {
      assert.ok(result.errors.some((message) => message.includes('.analysis.safety: 계약에 없는 항목입니다: sessionId')));
    }
  });

  it('19) 유효하지 않은 SituationAnalysis(내부 불일치)는 최종 검증에서 거절되고 부분 스냅샷이 없다', async () => {
    const plan = buildDeterministicAnalysisPlan();
    const results = buildValidExternalAnalysisResults(plan);
    const broken = results.map((item, index) =>
      index === 0
        ? { ...item, analysis: { ...item.analysis, domainPriority: 'resolved' as const, primaryDomain: null } }
        : item,
    );
    const result = await buildFrozenAnalysisSnapshot(BASELINE_HASH, broken);
    assert.equal(result.ok, false);
    assert.ok(!('snapshot' in result));
    if (!result.ok) {
      assert.ok(result.errors.some((message) => message.includes('.analysis:')));
    }
  });

  it('20) 잘못된 baseline catalog hash는 (분석 결과가 전부 정상이어도) 거절되고 부분 스냅샷이 없다', async () => {
    const plan = buildDeterministicAnalysisPlan();
    const results = buildValidExternalAnalysisResults(plan);
    const result = await buildFrozenAnalysisSnapshot('not-a-hash', results);
    assert.equal(result.ok, false);
    assert.ok(!('snapshot' in result));
  });

  it('22) 최종 현재 환경 검증 실패가 성공으로 처리되지 않는다(analysis 오염 사례로 확인)', async () => {
    const plan = buildDeterministicAnalysisPlan();
    const results = buildValidExternalAnalysisResults(plan);
    const polluted = results.map((item, index) =>
      index === 0 ? { ...item, analysis: { ...item.analysis, userId: 'user-123' } as unknown as SituationAnalysis } : item,
    );
    const result = await buildFrozenAnalysisSnapshot(BASELINE_HASH, polluted);
    // ok가 true로 뒤바뀌지 않았는지, errors가 비어있지 않은지 직접 확인한다.
    assert.equal(result.ok, false);
    if (!result.ok) assert.ok(result.errors.length > 0);
  });

  it('23) 모든 실패 경로에서 부분 스냅샷이 반환되지 않는다', async () => {
    const plan = buildDeterministicAnalysisPlan();
    const results = buildValidExternalAnalysisResults(plan);

    const failureCases: Array<[string, unknown, string]> = [
      ['개수 부족', results.slice(1), BASELINE_HASH],
      ['wrapper 오염', results.map((item, i) => (i === 0 ? { ...item, rawResponse: 'x' } : item)), BASELINE_HASH],
      [
        'analysis 오염',
        results.map((item, i) => (i === 0 ? { ...item, analysis: { ...item.analysis, userId: 'x' } as unknown as SituationAnalysis } : item)),
        BASELINE_HASH,
      ],
    ];
    for (const [label, badResults] of failureCases) {
      const result = await buildFrozenAnalysisSnapshot(BASELINE_HASH, badResults);
      assert.equal(result.ok, false, label);
      assert.ok(!('snapshot' in result), `${label}: 부분 스냅샷이 있으면 안 됩니다.`);
    }
    // baseline hash 자체가 잘못된 경우도 함께 확인한다.
    const badBaseline = await buildFrozenAnalysisSnapshot('not-a-hash', results);
    assert.equal(badBaseline.ok, false);
    assert.ok(!('snapshot' in badBaseline));
  });

  it('빈 externalAnalysisResults는 스냅샷을 만들지 않는다', async () => {
    const result = await buildFrozenAnalysisSnapshot(BASELINE_HASH, []);
    assert.equal(result.ok, false);
  });
});

describe('automatic-scripture-catalog-analysis-snapshot-builder · 4) 순수성·격리', () => {
  it('소스에 OpenAI·fetch·환경변수·파일 시스템·시계·console·Supabase·DB·네트워크 접근이 없다', () => {
    const source = readFileSync(
      new URL('../../scripts/automatic-scripture-catalog-analysis-snapshot-builder.ts', import.meta.url),
      'utf8',
    );
    for (const banned of [
      "from 'openai'",
      'require(\'openai\')',
      'new OpenAI(',
      'fetch(',
      'Deno.env',
      'process.env',
      'createClient(',
      '/rest/v1/',
      'service_role',
      'Date.now(',
      'new Date(',
      'Math.random(',
      'console.',
      'readFileSync',
      'readFile(',
      'require(',
      'XMLHttpRequest',
    ]) {
      assert.equal(source.includes(banned), false, banned);
    }
  });

  it('candidate_generation 사례는 계획에 없다', () => {
    const plan = buildDeterministicAnalysisPlan();
    assert.ok(!plan.some((item) => (item.kind as string) === 'candidate_generation'));
  });
});
