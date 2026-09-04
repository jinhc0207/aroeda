/**
 * Research Prioritizer v1 테스트
 *
 * 실행: npm test
 *
 * 실제 OpenAI나 Supabase를 부르지 않는다. 순수 로직만 확인한다.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { COVERED_DOMAINS } from '../../supabase/functions/_shared/situation-domains.ts';
import {
  InvalidCoverageSnapshotError,
  PRIORITIZER_RESULT_SCHEMA,
  REASON_MAX_LENGTH,
  RESEARCHABLE_DOMAINS,
  buildPrioritizerInstructions,
  sanitizeActiveCoveredDomains,
} from '../../supabase/functions/_shared/research-prioritizer-contract.ts';
import {
  buildEvaluationPayload,
  computeSnapshotId,
  decidePriority,
  selectEligibleCandidates,
  validateEvaluation,
  type CandidateEvaluation,
  type EligibleResearchQueueItem,
  type ResearchQueueItem,
} from '../../supabase/functions/_shared/research-prioritizer.ts';

/** 지금 카드가 있는 영역 (판단 시점의 snapshot으로 넘긴다) */
const activeCovered = [...COVERED_DOMAINS];

const queueItem = (overrides: Partial<ResearchQueueItem> = {}): ResearchQueueItem => ({
  targetDomain: 'financial_hardship',
  researchKind: 'domain_expansion',
  status: 'queued',
  totalGapCount: 12,
  recent7dCount: 4,
  recent30dCount: 9,
  firstDetectedDate: '2026-08-01',
  lastDetectedDate: '2026-08-29',
  evidenceVersion: 3,
  ...overrides,
});

const evaluation = (overrides: Partial<CandidateEvaluation> = {}): CandidateEvaluation => ({
  targetDomain: 'financial_hardship',
  evidenceVersion: 3,
  pastoralNeed: 4,
  coverageGapDistinctness: 4,
  researchReadiness: 4,
  demandInterpretation: 'moderate',
  recommendedRank: 1,
  reason: '최근 30일 동안 반복해서 나타났고 지금 다루는 영역들과 삶의 문제가 구분된다.',
  confidence: 0.7,
  ...overrides,
});

const resultOf = (snapshotId: string, ...evaluations: CandidateEvaluation[]) => ({
  snapshotId,
  evaluations,
});

describe('Research Prioritizer · 후보 선별', () => {
  it('queued domain_expansion만 후보가 된다', () => {
    const candidates = selectEligibleCandidates([queueItem()], activeCovered);
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].targetDomain, 'financial_hardship');
  });

  it('blocked / ready / researching / completed는 제외한다', () => {
    for (const status of ['blocked', 'ready', 'researching', 'completed']) {
      assert.deepEqual(selectEligibleCandidates([queueItem({ status })], activeCovered), []);
    }
  });

  it('taxonomy_discovery와 other_uncovered는 제외한다', () => {
    assert.deepEqual(
      selectEligibleCandidates(
        [queueItem({ targetDomain: 'other_uncovered', researchKind: 'taxonomy_discovery', status: 'blocked' })],
        activeCovered,
      ),
      [],
    );
    assert.deepEqual(
      selectEligibleCandidates([queueItem({ targetDomain: 'other_uncovered', status: 'queued' })], activeCovered),
      [],
    );
    assert.deepEqual(
      selectEligibleCandidates([queueItem({ researchKind: 'taxonomy_discovery' })], activeCovered),
      [],
    );
  });

  it('이미 카드가 있는 영역은 후보에서 빠진다', () => {
    const withCard = [...activeCovered, 'financial_hardship'];
    assert.deepEqual(selectEligibleCandidates([queueItem()], withCard), []);
    assert.equal(
      selectEligibleCandidates([queueItem({ targetDomain: 'burnout_exhaustion' })], withCard).length,
      1,
    );
  });

  it('숫자가 앞뒤로 맞지 않으면 제외한다', () => {
    for (const bad of [
      { totalGapCount: 0 },
      { totalGapCount: 2.5 },
      { evidenceVersion: 0 },
      { recent7dCount: 10, recent30dCount: 9 },
      { recent30dCount: 20, totalGapCount: 12 },
      { recent7dCount: -1 },
    ]) {
      assert.deepEqual(selectEligibleCandidates([queueItem(bad)], activeCovered), [], JSON.stringify(bad));
    }
  });

  it('날짜가 이상하면 제외한다', () => {
    for (const bad of [
      { firstDetectedDate: '2026-13-01' },
      { firstDetectedDate: '2026-02-30' },
      { lastDetectedDate: 'yesterday' },
      { firstDetectedDate: '2026-08-29', lastDetectedDate: '2026-08-01' },
    ]) {
      assert.deepEqual(selectEligibleCandidates([queueItem(bad)], activeCovered), [], JSON.stringify(bad));
    }
  });

  it('알려진 uncovered 7개만 후보가 될 수 있다', () => {
    assert.equal(RESEARCHABLE_DOMAINS.length, 7);
    assert.equal(RESEARCHABLE_DOMAINS.includes('other_uncovered'), false);

    for (const domain of RESEARCHABLE_DOMAINS) {
      assert.equal(selectEligibleCandidates([queueItem({ targetDomain: domain })], activeCovered).length, 1);
    }
    for (const covered of ['fear_uncertainty', 'grief_loss']) {
      assert.deepEqual(selectEligibleCandidates([queueItem({ targetDomain: covered })], activeCovered), []);
    }
  });
});

describe('Research Prioritizer · 활성 영역 목록 정리', () => {
  it('아는 영역만 남기고 중복을 없애고 정렬한다', () => {
    const cleaned = sanitizeActiveCoveredDomains(['grief_loss', 'fear_uncertainty', 'grief_loss']);
    assert.deepEqual(cleaned, ['fear_uncertainty', 'grief_loss']);
  });

  it('모르는 문자열이 하나라도 있으면 실패한다', () => {
    for (const bad of [
      ['fear_uncertainty', 'made_up_domain'],
      ['사용자가 쓴 문장이 섞임'],
      ['', 'grief_loss'],
    ]) {
      assert.throws(() => sanitizeActiveCoveredDomains(bad), InvalidCoverageSnapshotError);
    }
  });

  it('other_uncovered는 활성 영역이 될 수 없다', () => {
    assert.throws(
      () => sanitizeActiveCoveredDomains([...activeCovered, 'other_uncovered']),
      InvalidCoverageSnapshotError,
    );
  });
});

describe('Research Prioritizer · AI 입력', () => {
  it('보내는 정보는 정해진 항목뿐이다', async () => {
    const payload = await buildEvaluationPayload(
      selectEligibleCandidates([queueItem()], activeCovered),
      activeCovered,
    );

    assert.deepEqual(Object.keys(payload).sort(), ['candidates', 'coveredDomains', 'snapshotId']);
    assert.deepEqual(Object.keys(payload.candidates[0]).sort(), [
      'domainDescription',
      'evidenceVersion',
      'firstDetectedDate',
      'hasActiveScriptureCard',
      'lastDetectedDate',
      'recent30dCount',
      'recent7dCount',
      'targetDomain',
      'totalGapCount',
    ]);
    assert.equal(payload.candidates[0].hasActiveScriptureCard, false);
    assert.deepEqual(payload.coveredDomains, [...activeCovered].sort());
  });

  it('후보 검사를 건너뛴 raw Queue를 넘겨도 걸러진다', async () => {
    const rawQueue = [
      queueItem({ targetDomain: 'other_uncovered', researchKind: 'taxonomy_discovery', status: 'blocked' }),
      queueItem({ targetDomain: 'burnout_exhaustion', status: 'blocked' }),
      queueItem({ targetDomain: 'chronic_illness', status: 'researching' }),
      queueItem({ targetDomain: 'spiritual_dryness', status: 'completed' }),
      queueItem({ targetDomain: 'loneliness_isolation', status: 'ready' }),
      queueItem({ targetDomain: 'financial_hardship', status: 'queued' }),
    ] as unknown as EligibleResearchQueueItem[];

    const payload = await buildEvaluationPayload(rawQueue, activeCovered);
    const domains = payload.candidates.map((item) => item.targetDomain);

    assert.deepEqual(domains, ['financial_hardship']);
    assert.equal(JSON.stringify(payload).includes('other_uncovered'), false);
  });

  it('모르는 활성 영역이 있으면 입력을 만들지 않는다', async () => {
    await assert.rejects(
      () =>
        buildEvaluationPayload(selectEligibleCandidates([queueItem()], activeCovered), [
          ...activeCovered,
          'unknown_domain_from_somewhere',
        ]),
      InvalidCoverageSnapshotError,
    );

    await assert.rejects(
      () =>
        buildEvaluationPayload(selectEligibleCandidates([queueItem()], activeCovered), [
          ...activeCovered,
          'other_uncovered',
        ]),
      InvalidCoverageSnapshotError,
    );
  });

  it('모르는 값이 프롬프트에 들어가지 않는다', () => {
    assert.throws(
      () => buildPrioritizerInstructions([...activeCovered, '사용자가 쓴 문장']),
      InvalidCoverageSnapshotError,
    );

    const instructions = buildPrioritizerInstructions(activeCovered);
    assert.equal(instructions.includes('사용자가 쓴 문장'), false);
    assert.equal(instructions.includes('other_uncovered'), false);
  });

  it('사용자 정보가 들어갈 자리가 없다', async () => {
    const payload = await buildEvaluationPayload(
      selectEligibleCandidates([queueItem()], activeCovered),
      activeCovered,
    );

    const keys = new Set<string>();
    const collect = (value: unknown) => {
      if (Array.isArray(value)) return value.forEach(collect);
      if (typeof value === 'object' && value !== null) {
        for (const [key, child] of Object.entries(value)) {
          keys.add(key.toLowerCase());
          collect(child);
        }
      }
    };
    collect(payload);

    for (const banned of [
      'situation',
      'userid',
      'user_id',
      'uid',
      'uuid',
      'jwt',
      'token',
      'ipaddress',
      'sessionid',
      'deviceid',
      'emotiontags',
      'prayermodes',
    ]) {
      assert.equal(keys.has(banned), false, `${banned} 항목이 전달됩니다.`);
    }

    const text = JSON.stringify(payload).toLowerCase();
    for (const pattern of [/\buser\b/, /\bjwt\b/, /\btoken\b/, /bearer/, /eyj[a-z0-9]/]) {
      assert.equal(pattern.test(text), false, `${pattern} 가 전달됩니다.`);
    }
  });

  it('지시문이 금지 사항과 숫자 규칙을 담고 있다', () => {
    const instructions = buildPrioritizerInstructions(activeCovered);

    for (const marker of [
      '고유 사용자 수가 아닙니다',
      'reason에는 gap count 숫자를 다시 적지 말고',
      `${REASON_MAX_LENGTH}자를 넘기지 마십시오`,
      '성경본문을 고르거나 추천하지 않는다',
      'Scripture Card나 그 초안을 쓰지 않는다',
      '기도문',
      '하나님의 뜻',
      '새로운 영역(domain) 이름이나 분류를 만들지 않는다',
      '빈도가 높다는 이유만으로 순위를 정하지 마십시오',
      'coverageGapDistinctness',
      '실제 Scripture Card의 내용이 주어지지 않습니다',
      'snapshotId를 그대로 돌려주십시오',
    ]) {
      assert.ok(instructions.includes(marker), `지시문에 없습니다: ${marker}`);
    }

    assert.ok(buildPrioritizerInstructions([]).includes('- (없음)'));
  });

  it('응답 구조에 성경본문·카드·기도문 자리가 없다', () => {
    const properties = PRIORITIZER_RESULT_SCHEMA.properties.evaluations.items.properties;
    assert.deepEqual(
      Object.keys(properties).sort(),
      [
        'confidence',
        'coverageGapDistinctness',
        'demandInterpretation',
        'evidenceVersion',
        'pastoralNeed',
        'reason',
        'recommendedRank',
        'researchReadiness',
        'targetDomain',
      ].sort(),
    );
    assert.equal(PRIORITIZER_RESULT_SCHEMA.properties.evaluations.items.additionalProperties, false);
    assert.equal(PRIORITIZER_RESULT_SCHEMA.additionalProperties, false);
    assert.deepEqual([...PRIORITIZER_RESULT_SCHEMA.required].sort(), ['evaluations', 'snapshotId']);
    assert.deepEqual([...properties.targetDomain.enum], [...RESEARCHABLE_DOMAINS]);
  });
});

describe('Research Prioritizer · 판단 시점(snapshotId)', () => {
  const base = [queueItem(), queueItem({ targetDomain: 'burnout_exhaustion', evidenceVersion: 2 })];

  it('SHA-256 hex 64자리를 쓴다', async () => {
    const id = await computeSnapshotId(base, activeCovered);
    assert.match(id, /^snap_[0-9a-f]{64}$/);
  });

  it('순서만 다르고 내용이 같으면 값이 같다', async () => {
    const forward = await computeSnapshotId(base, activeCovered);
    const reversed = await computeSnapshotId([...base].reverse(), [...activeCovered].reverse());
    assert.equal(forward, reversed);
  });

  it('근거 수치가 하나라도 바뀌면 값이 달라진다', async () => {
    const before = await computeSnapshotId(base, activeCovered);

    const changes: Partial<ResearchQueueItem>[] = [
      { totalGapCount: 13 },
      { recent7dCount: 5 },
      { recent30dCount: 10 },
      { firstDetectedDate: '2026-07-31' },
      { lastDetectedDate: '2026-08-30' },
      { evidenceVersion: 4 },
    ];

    for (const change of changes) {
      const after = await computeSnapshotId(
        [queueItem(change), queueItem({ targetDomain: 'burnout_exhaustion', evidenceVersion: 2 })],
        activeCovered,
      );
      assert.notEqual(after, before, `달라지지 않았습니다: ${JSON.stringify(change)}`);
    }
  });

  it('후보가 늘거나 줄면 값이 달라진다', async () => {
    const before = await computeSnapshotId(base, activeCovered);
    const added = await computeSnapshotId(
      [...base, queueItem({ targetDomain: 'chronic_illness' })],
      activeCovered,
    );
    const removed = await computeSnapshotId([base[0]], activeCovered);

    assert.notEqual(added, before);
    assert.notEqual(removed, before);
  });

  it('다루는 영역이 바뀌면 값이 달라진다', async () => {
    const before = await computeSnapshotId(base, activeCovered);
    const after = await computeSnapshotId(base, [...activeCovered, 'loneliness_isolation']);
    assert.notEqual(before, after);
  });

  it('모르는 영역이 섞이면 값을 만들지 않는다', async () => {
    await assert.rejects(
      () => computeSnapshotId(base, [...activeCovered, 'made_up_domain']),
      InvalidCoverageSnapshotError,
    );
  });
});

describe('Research Prioritizer · 결과 검증', () => {
  const candidates = selectEligibleCandidates([queueItem()], activeCovered);
  const snapshotIdOf = () => computeSnapshotId(candidates, activeCovered);

  it('올바른 결과는 통과한다', async () => {
    const snapshotId = await snapshotIdOf();
    const check = validateEvaluation(resultOf(snapshotId, evaluation()), candidates, snapshotId);
    assert.equal(check.valid, true, check.errors.join(' / '));
  });

  it('최상위에 다른 항목이 있으면 무효다', async () => {
    const snapshotId = await snapshotIdOf();

    for (const extra of [
      { userData: { id: 'u1' } },
      { suggestedVerse: '시편 23:1' },
      { note: '메모' },
    ]) {
      const check = validateEvaluation(
        { ...resultOf(snapshotId, evaluation()), ...extra },
        candidates,
        snapshotId,
      );
      assert.equal(check.valid, false, `${JSON.stringify(extra)}가 통과되었습니다.`);
    }
  });

  it('snapshotId가 없거나 다르면 무효다', async () => {
    const snapshotId = await snapshotIdOf();
    assert.equal(validateEvaluation({ evaluations: [evaluation()] }, candidates, snapshotId).valid, false);
    assert.equal(
      validateEvaluation(resultOf(`snap_${'0'.repeat(64)}`, evaluation()), candidates, snapshotId).valid,
      false,
    );
  });

  it('후보에 없는 영역과 other_uncovered는 무효다', async () => {
    const snapshotId = await snapshotIdOf();
    assert.equal(
      validateEvaluation(
        resultOf(snapshotId, evaluation({ targetDomain: 'burnout_exhaustion' })),
        candidates,
        snapshotId,
      ).valid,
      false,
    );
    assert.equal(
      validateEvaluation(
        resultOf(snapshotId, evaluation({ targetDomain: 'other_uncovered' as never })),
        candidates,
        snapshotId,
      ).valid,
      false,
    );
  });

  it('점수·확신·순위 범위를 벗어나면 무효다', async () => {
    const snapshotId = await snapshotIdOf();

    for (const bad of [0, 6, 2.5, -1]) {
      assert.equal(
        validateEvaluation(resultOf(snapshotId, evaluation({ pastoralNeed: bad })), candidates, snapshotId).valid,
        false,
      );
      assert.equal(
        validateEvaluation(
          resultOf(snapshotId, evaluation({ coverageGapDistinctness: bad })),
          candidates,
          snapshotId,
        ).valid,
        false,
      );
    }
    for (const bad of [-0.1, 1.2]) {
      assert.equal(
        validateEvaluation(resultOf(snapshotId, evaluation({ confidence: bad })), candidates, snapshotId).valid,
        false,
      );
    }
    for (const bad of [0, -1, 1.5]) {
      assert.equal(
        validateEvaluation(resultOf(snapshotId, evaluation({ recommendedRank: bad })), candidates, snapshotId)
          .valid,
        false,
      );
    }
  });

  it('순위가 겹치면 무효다', async () => {
    const two = selectEligibleCandidates(
      [queueItem(), queueItem({ targetDomain: 'burnout_exhaustion' })],
      activeCovered,
    );
    const id = await computeSnapshotId(two, activeCovered);
    const duplicated = validateEvaluation(
      resultOf(id, evaluation(), evaluation({ targetDomain: 'burnout_exhaustion', recommendedRank: 1 })),
      two,
      id,
    );
    assert.equal(duplicated.valid, false);
  });

  it('gap_count를 사용자 수라고 표현하면 무효다', async () => {
    const snapshotId = await snapshotIdOf();
    for (const reason of [
      '고유 사용자 수가 많아 우선순위가 높다.',
      '지난주 12명이 이 문제로 들어왔다.',
      '이용자 수가 계속 늘고 있다.',
    ]) {
      assert.equal(
        validateEvaluation(resultOf(snapshotId, evaluation({ reason })), candidates, snapshotId).valid,
        false,
        `통과되었습니다: ${reason}`,
      );
    }
  });

  it('발생 횟수를 숫자로 다시 쓰면 무효다', async () => {
    const snapshotId = await snapshotIdOf();
    for (const reason of [
      '최근 7일 99회 발생했다.',
      '최근 30일 동안 40건이 기록되었다.',
      '지금까지 7 사람이 이 문제를 말했다.',
    ]) {
      assert.equal(
        validateEvaluation(resultOf(snapshotId, evaluation({ reason })), candidates, snapshotId).valid,
        false,
        `통과되었습니다: ${reason}`,
      );
    }

    const ok = validateEvaluation(
      resultOf(snapshotId, evaluation({ reason: '최근 7일과 최근 30일 모두에서 꾸준히 나타난다.' })),
      candidates,
      snapshotId,
    );
    assert.equal(ok.valid, true, ok.errors.join(' / '));
  });

  it(`reason이 ${REASON_MAX_LENGTH}자를 넘으면 무효다`, async () => {
    const snapshotId = await snapshotIdOf();
    const long = '가'.repeat(REASON_MAX_LENGTH + 1);
    assert.equal(
      validateEvaluation(resultOf(snapshotId, evaluation({ reason: long })), candidates, snapshotId).valid,
      false,
    );
    const exact = '가'.repeat(REASON_MAX_LENGTH);
    assert.equal(
      validateEvaluation(resultOf(snapshotId, evaluation({ reason: exact })), candidates, snapshotId).valid,
      true,
    );
  });

  it('성경본문·카드·기도문을 만들면 무효다', async () => {
    const snapshotId = await snapshotIdOf();
    for (const reason of [
      '시편 23편을 본문으로 쓰면 좋겠다.',
      '카드 초안을 이렇게 쓰면 된다.',
      '이 영역을 위한 기도문이 필요하다.',
      '하나님의 뜻은 이 영역을 먼저 다루는 것이다.',
    ]) {
      assert.equal(
        validateEvaluation(resultOf(snapshotId, evaluation({ reason })), candidates, snapshotId).valid,
        false,
        `통과되었습니다: ${reason}`,
      );
    }
  });

  it('필수 항목이 없거나 남는 항목이 있으면 무효다', async () => {
    const snapshotId = await snapshotIdOf();

    const { confidence, ...withoutConfidence } = evaluation();
    void confidence;
    assert.equal(
      validateEvaluation({ snapshotId, evaluations: [withoutConfidence] }, candidates, snapshotId).valid,
      false,
    );

    const extra = { ...evaluation(), suggestedVerse: '시편 23:1' };
    assert.equal(validateEvaluation({ snapshotId, evaluations: [extra] }, candidates, snapshotId).valid, false);
  });

  it('모든 후보를 평가하지 않으면 무효다', async () => {
    const two = selectEligibleCandidates(
      [queueItem(), queueItem({ targetDomain: 'chronic_illness' })],
      activeCovered,
    );
    const id = await computeSnapshotId(two, activeCovered);
    assert.equal(validateEvaluation(resultOf(id, evaluation()), two, id).valid, false);
  });

  it('객체가 아니거나 비어 있으면 무효다', async () => {
    const snapshotId = await snapshotIdOf();
    for (const value of [null, 'ok', 42, [], {}, { snapshotId, evaluations: [] }]) {
      assert.equal(validateEvaluation(value, candidates, snapshotId).valid, false);
    }
  });
});

describe('Research Prioritizer · 합의', () => {
  const queue = [queueItem(), queueItem({ targetDomain: 'burnout_exhaustion', evidenceVersion: 2 })];
  const candidates = selectEligibleCandidates(queue, activeCovered);
  const snapshotIdOf = () => computeSnapshotId(candidates, activeCovered);

  const fullResult = (topDomain: string, id: string) =>
    resultOf(
      id,
      evaluation({
        targetDomain: 'financial_hardship',
        evidenceVersion: 3,
        recommendedRank: topDomain === 'financial_hardship' ? 1 : 2,
      }),
      evaluation({
        targetDomain: 'burnout_exhaustion',
        evidenceVersion: 2,
        recommendedRank: topDomain === 'burnout_exhaustion' ? 1 : 2,
      }),
    );

  it('후보가 없으면 AI 결과와 무관하게 no_eligible_research다', async () => {
    const id = await snapshotIdOf();
    const outcome = await decidePriority({
      queue: [queueItem({ status: 'blocked' })],
      activeCoveredDomains: activeCovered,
      evaluationA: fullResult('financial_hardship', id),
      evaluationB: fullResult('financial_hardship', id),
    });
    assert.deepEqual(outcome, { status: 'no_eligible_research', recommendedDomain: null });
  });

  it('두 평가가 같은 1위를 고르면 합의다', async () => {
    const id = await snapshotIdOf();
    const outcome = await decidePriority({
      queue,
      activeCoveredDomains: activeCovered,
      evaluationA: fullResult('financial_hardship', id),
      evaluationB: fullResult('financial_hardship', id),
    });
    assert.deepEqual(outcome, {
      status: 'consensus',
      recommendedDomain: 'financial_hardship',
      evidenceVersion: 3,
      snapshotId: id,
    });
  });

  it('1위가 갈리면 임의로 고르지 않고 다시 본다', async () => {
    const id = await snapshotIdOf();
    const outcome = await decidePriority({
      queue,
      activeCoveredDomains: activeCovered,
      evaluationA: fullResult('financial_hardship', id),
      evaluationB: fullResult('burnout_exhaustion', id),
    });
    assert.equal(outcome.status, 'recheck');
    assert.equal(outcome.recommendedDomain, null);
  });

  it('한쪽 결과가 무효면 다시 본다', async () => {
    const id = await snapshotIdOf();
    const broken = resultOf(
      id,
      evaluation({ targetDomain: 'financial_hardship', evidenceVersion: 3, confidence: 5 }),
      evaluation({ targetDomain: 'burnout_exhaustion', evidenceVersion: 2, recommendedRank: 2 }),
    );
    const outcome = await decidePriority({
      queue,
      activeCoveredDomains: activeCovered,
      evaluationA: fullResult('financial_hardship', id),
      evaluationB: broken,
    });
    assert.equal(outcome.status, 'recheck');
    assert.equal(outcome.recommendedDomain, null);
  });

  it('모르는 활성 영역이 오면 판단하지 않는다', async () => {
    const id = await snapshotIdOf();
    const outcome = await decidePriority({
      queue,
      activeCoveredDomains: [...activeCovered, 'made_up_domain'],
      evaluationA: fullResult('financial_hardship', id),
      evaluationB: fullResult('financial_hardship', id),
    });
    assert.equal(outcome.status, 'recheck');
    assert.equal(outcome.recommendedDomain, null);
  });

  it('snapshotId가 다르면 stale_evidence다', async () => {
    const id = await snapshotIdOf();
    const outcome = await decidePriority({
      queue,
      activeCoveredDomains: activeCovered,
      evaluationA: fullResult('financial_hardship', `snap_${'a'.repeat(64)}`),
      evaluationB: fullResult('financial_hardship', id),
    });
    assert.deepEqual(outcome, { status: 'stale_evidence', recommendedDomain: null });
  });

  it('근거 수치가 바뀌면 stale_evidence다', async () => {
    const id = await snapshotIdOf();
    const outcome = await decidePriority({
      queue: [
        queueItem({ totalGapCount: 20 }),
        queueItem({ targetDomain: 'burnout_exhaustion', evidenceVersion: 2 }),
      ],
      activeCoveredDomains: activeCovered,
      evaluationA: fullResult('financial_hardship', id),
      evaluationB: fullResult('financial_hardship', id),
    });
    assert.deepEqual(outcome, { status: 'stale_evidence', recommendedDomain: null });
  });

  it('다루는 영역이 바뀌어도 stale_evidence다', async () => {
    const id = await snapshotIdOf();
    const outcome = await decidePriority({
      queue,
      activeCoveredDomains: [...activeCovered, 'loneliness_isolation'],
      evaluationA: fullResult('financial_hardship', id),
      evaluationB: fullResult('financial_hardship', id),
    });
    assert.deepEqual(outcome, { status: 'stale_evidence', recommendedDomain: null });
  });

  it('결과에 사용자 정보나 성경 내용이 담기지 않는다', async () => {
    const id = await snapshotIdOf();
    const outcome = await decidePriority({
      queue,
      activeCoveredDomains: activeCovered,
      evaluationA: fullResult('financial_hardship', id),
      evaluationB: fullResult('financial_hardship', id),
    });
    assert.deepEqual(Object.keys(outcome).sort(), [
      'evidenceVersion',
      'recommendedDomain',
      'snapshotId',
      'status',
    ]);
  });
});
