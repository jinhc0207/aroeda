/**
 * Biblical Researcher v1 계약 테스트
 *
 * 실행: npm test
 *
 * 실제 AI, 웹 검색, Supabase를 쓰지 않는다. fixture만 사용한다.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  BIBLICAL_RESEARCH_SCHEMA,
  CANDIDATE_MAX,
  CANDIDATE_MIN,
  RESEARCH_CONSTITUTION,
  REJECTED_MAX,
  RISK_CATEGORIES,
  RESEARCHABLE_DOMAINS,
  buildBiblicalResearchInstructions,
} from '../../supabase/functions/_shared/biblical-research-contract.ts';
import {
  DRAFT_TOP_LEVEL_FIELDS,
  InvalidResearchBriefError,
  SUPPORT_DRAFT_FIELDS,
  buildResearchBrief,
  validateBiblicalResearchDraftResult,
  validateBiblicalResearchResult,
  type BiblicalResearchBrief,
  type BiblicalResearchResult,
  type CandidatePassage,
  type SourceSupport,
} from '../../supabase/functions/_shared/biblical-researcher.ts';
import type { ResearchSource } from '../../supabase/functions/_shared/research-source.ts';
import { getActiveCoveredDomains } from '../../supabase/functions/_shared/research-prioritizer-edge.ts';
import { COVERED_DOMAINS } from '../../supabase/functions/_shared/situation-domains.ts';
import { InvalidCoverageSnapshotError } from '../../supabase/functions/_shared/research-prioritizer-contract.ts';

const activeCovered = getActiveCoveredDomains();

const brief = (): BiblicalResearchBrief =>
  buildResearchBrief({
    targetDomain: 'financial_hardship',
    evidenceVersion: 4,
    prioritizerSnapshotId: `snap_${'a'.repeat(64)}`,
    activeCoveredDomains: activeCovered,
  });

/**
 * fixture 자료. 실제 조사 결과가 아니라 구조 확인용이다.
 * 실제로는 Source Harvester가 만들어 넘겨 준다.
 */
const sources = (): ResearchSource[] => [
  {
    sourceId: 'src-1',
    sourceType: 'commentary',
    title: '테스트용 주석 자료',
    authorOrOrganization: '테스트 저자',
    publisherOrInstitution: '테스트 학술 출판사',
    publicationYear: 2019,
    url: 'https://example.org/fixture-1',
    accessedAt: '2026-08-29',
    accessLevel: 'full_text',
    intendedUse: ['exegesis', 'biblical_theology'],
  },
  {
    sourceId: 'src-2',
    sourceType: 'biblical_theology',
    title: '테스트용 성경신학 자료',
    authorOrOrganization: '테스트 저자',
    publisherOrInstitution: '테스트 대학 출판부',
    publicationYear: 2021,
    url: 'https://example.org/fixture-2',
    accessedAt: '2026-08-29',
    accessLevel: 'substantial_preview',
    intendedUse: ['biblical_theology', 'doctrinal_context'],
  },
  {
    sourceId: 'src-3',
    sourceType: 'pastoral_resource',
    title: '테스트용 목회 보조자료',
    authorOrOrganization: '테스트 저자',
    publisherOrInstitution: '테스트 신학교',
    publicationYear: null,
    url: 'https://example.org/fixture-3',
    accessedAt: '2026-08-29',
    accessLevel: 'full_text',
    intendedUse: ['pastoral_application', 'pastoral_safety'],
  },
  {
    sourceId: 'src-4',
    sourceType: 'professional_context',
    title: '테스트용 전문 분야 자료',
    authorOrOrganization: '테스트 기관',
    publisherOrInstitution: '테스트 공공기관',
    publicationYear: 2024,
    url: 'https://example.org/fixture-4',
    accessedAt: '2026-08-29',
    accessLevel: 'full_text',
    intendedUse: ['pastoral_safety', 'real_world_context'],
  },
];

const support = (overrides: Partial<SourceSupport> = {}): SourceSupport => {
  // 자료 id는 서버가 근거 번호에서 뽑는다. fixture도 같은 관계를 지킨다.
  const base: SourceSupport = {
    exegesisEvidenceIds: ['src-1:e1'],
    theologyEvidenceIds: ['src-2:e1'],
    pastoralEvidenceIds: [],
    safetyEvidenceIds: [],
    exegesisSourceIds: ['src-1'],
    theologySourceIds: ['src-2'],
    pastoralSourceIds: [],
    safetySourceIds: [],
  };

  const merged = { ...base, ...overrides };

  // 자료 id만 바꾼 시험이 많다. 근거 번호가 따로 지정되지 않았으면 함께 맞춘다.
  for (const role of ['exegesis', 'theology', 'pastoral', 'safety'] as const) {
    const sourceField = `${role}SourceIds` as keyof SourceSupport;
    const evidenceField = `${role}EvidenceIds` as keyof SourceSupport;
    if (sourceField in overrides && !(evidenceField in overrides)) {
      merged[evidenceField] = (overrides[sourceField] as string[]).map((id) => `${id}:e1`);
    }
  }

  return merged;
};

// 실제 개역한글 성경에 있는 위치만 fixture로 쓴다. 없는 위치는 이제 검증에서 거절된다.
const candidate = (overrides: Partial<CandidatePassage> = {}): CandidatePassage => ({
  reference: { book: 'Psalms', chapter: 1, startVerse: 1, endVerse: 3 },
  additionalReferences: [],
  canonicalContext: '이 본문이 놓인 원래 흐름에 대한 연구 메모입니다.',
  theologicalContribution: '이 본문이 이 영역에 주는 신학적 기여에 대한 메모입니다.',
  domainFit: '감정이 비슷해서가 아니라 이 삶의 문제를 직접 다루기 때문입니다.',
  pastoralUse: ['위로'],
  misuseRisks: ['결과 보장으로 사용하지 않는다.'],
  distinctnessFromActiveCoverage: {
    distinct: true,
    nearestExistingDomain: 'fear_uncertainty',
    explanation: '불안 일반이 아니라 생계라는 구체적 상황을 다룹니다.',
  },
  researchConfidence: 0.6,
  sourceSupport: support(),
  ...overrides,
});

const candidates = (count: number) =>
  Array.from({ length: count }, (_, index) =>
    candidate({ reference: { book: 'Psalms', chapter: index + 1, startVerse: 1, endVerse: 3 } }),
  );

const rejected = (count: number) =>
  Array.from({ length: count }, (_, index) => ({
    reference: { book: 'Proverbs', chapter: index + 1, startVerse: 5, endVerse: 6 },
    rejectionReason: '유명하지만 이 영역의 핵심 문제를 다루지 않습니다.',
    riskCategory: 'adjacent_domain_only' as const,
  }));

const result = (overrides: Partial<BiblicalResearchResult> = {}): BiblicalResearchResult => {
  const base = brief();
  return {
    targetDomain: base.targetDomain,
    evidenceVersion: base.evidenceVersion,
    prioritizerSnapshotId: base.prioritizerSnapshotId,
    researchQuestion: '성경은 이 삶의 문제를 어떤 본문에서 직접 다루는가?',
    domainBoundaries: {
      includedConcerns: ['생계 압박'],
      excludedOrAdjacentConcerns: ['일반적인 미래 불안'],
    },
    // 꾸러미 지문은 서버가 붙인다. 시험에서도 모양이 맞는 값을 쓴다.
    evidenceSetHash: `evset_${'a'.repeat(64)}`,
    candidatePassages: candidates(3),
    rejectedPassages: rejected(2),
    unresolvedQuestions: [],
    ...overrides,
  };
};

describe('Biblical Researcher · 연구 의뢰서', () => {
  it('카드가 없는 7개 영역만 연구 대상이 된다', () => {
    for (const domain of RESEARCHABLE_DOMAINS) {
      const made = buildResearchBrief({
        targetDomain: domain,
        evidenceVersion: 1,
        prioritizerSnapshotId: 'snap_x',
        activeCoveredDomains: activeCovered,
      });
      assert.equal(made.targetDomain, domain);
      assert.ok(made.domainDescription.length > 0, `${domain} 설명이 없습니다.`);
    }
  });

  it('other_uncovered와 이미 카드가 있는 영역은 거절한다', () => {
    for (const domain of ['other_uncovered', 'grief_loss', 'fear_uncertainty', 'made_up']) {
      assert.throws(
        () =>
          buildResearchBrief({
            targetDomain: domain,
            evidenceVersion: 1,
            prioritizerSnapshotId: 'snap_x',
            activeCoveredDomains: activeCovered,
          }),
        InvalidResearchBriefError,
        domain,
      );
    }
  });

  it('카드가 새로 생긴 영역도 연구 대상에서 빠진다', () => {
    assert.throws(
      () =>
        buildResearchBrief({
          targetDomain: 'financial_hardship',
          evidenceVersion: 1,
          prioritizerSnapshotId: 'snap_x',
          activeCoveredDomains: [...activeCovered, 'financial_hardship'],
        }),
      InvalidResearchBriefError,
    );
  });

  it('모르는 활성 영역이 섞이면 의뢰서를 만들지 않는다', () => {
    assert.throws(
      () =>
        buildResearchBrief({
          targetDomain: 'financial_hardship',
          evidenceVersion: 1,
          prioritizerSnapshotId: 'snap_x',
          activeCoveredDomains: [...activeCovered, '사용자가 쓴 문장'],
        }),
      InvalidCoverageSnapshotError,
    );
  });

  it('영역 설명과 활성 영역은 기존 데이터를 그대로 쓴다', () => {
    const made = brief();
    assert.equal(made.domainDescription, '생계와 경제적 어려움');

    // 활성 영역은 새로 쓰지 않고 Scripture Card 데이터에서 뽑은 목록을 쓴다.
    assert.deepEqual(made.activeCoveredDomains, getActiveCoveredDomains());
    assert.ok(made.activeCoveredDomains.length > 0);
    for (const domain of made.activeCoveredDomains) {
      assert.ok(
        (COVERED_DOMAINS as readonly string[]).includes(domain),
        `카드가 없는 영역이 활성 목록에 있습니다: ${domain}`,
      );
    }
  });

  it('의뢰서에 사용자 정보나 Prioritizer 판단 근거가 없다', () => {
    const made = brief();
    assert.deepEqual(Object.keys(made).sort(), [
      'activeCoveredDomains',
      'domainDescription',
      'evidenceVersion',
      'prioritizerSnapshotId',
      'targetDomain',
    ]);

    const text = JSON.stringify(made).toLowerCase();
    for (const banned of ['situation', 'reason', 'confidence', 'pastoralneed', 'rank', 'userid', 'jwt']) {
      assert.equal(text.includes(banned), false, `${banned}가 들어 있습니다.`);
    }
  });

  it('근거 버전과 판단 시점이 없으면 만들지 않는다', () => {
    for (const bad of [
      { evidenceVersion: 0 },
      { evidenceVersion: 1.5 },
      { prioritizerSnapshotId: '' },
    ]) {
      assert.throws(
        () =>
          buildResearchBrief({
            targetDomain: 'financial_hardship',
            evidenceVersion: 1,
            prioritizerSnapshotId: 'snap_x',
            activeCoveredDomains: activeCovered,
            ...bad,
          }),
        InvalidResearchBriefError,
      );
    }
  });
});

describe('Biblical Researcher · 지시문과 응답 구조', () => {
  it('지시문에 금지 사항과 원칙이 들어 있다', () => {
    const made = brief();
    const instructions = buildBiblicalResearchInstructions(made);

    for (const marker of [
      '최종 본문을 확정하지 않는다',
      '성경 본문 문장을 직접 쓰지 않는다',
      '기억에 의존해 성경 문장을 적지 마십시오',
      '자기 연구를 스스로 승인하지 않는다',
      '결과를 보장하는 질문을 세우지 마십시오',
      'distinct를 false로 두고',
      '모른다고 적는 것은 실패가 아닙니다',
      '새 자료를 만들지 말고',
      '자료 metadata를 다시 적어 보내지 마십시오',
      '의료·법률·재정·상담 자료의 근거는 safetyEvidenceIds에만 쓸 수 있습니다',
      '목회 보조자료의 근거는 pastoralEvidenceIds와 safetyEvidenceIds에만 쓸 수 있습니다',
      '초록만 확인한 자료의 근거는 exegesisEvidenceIds와 theologyEvidenceIds에 쓸 수 없습니다',
      '목회 자료나 전문 분야 자료만으로 후보 본문을 세울 수 없습니다',
      'financial_hardship',
      '생계와 경제적 어려움',
    ]) {
      assert.ok(instructions.includes(marker), `지시문에 없습니다: ${marker}`);
    }

    for (const principle of RESEARCH_CONSTITUTION) {
      assert.ok(instructions.includes(principle), `원칙이 빠졌습니다: ${principle}`);
    }
    assert.equal(RESEARCH_CONSTITUTION.length, 10);
  });

  it('응답 구조에 성경 원문·카드·기도·자료 metadata 자리가 없다', () => {
    const properties = BIBLICAL_RESEARCH_SCHEMA.properties;
    // sources가 없다. 자료 목록은 Source Harvester가 정하고 연구 결과는 sourceId만 가리킨다.
    assert.deepEqual(Object.keys(properties).sort(), [
      'candidatePassages',
      'domainBoundaries',
      'evidenceVersion',
      'prioritizerSnapshotId',
      'rejectedPassages',
      'researchQuestion',
      'targetDomain',
      'unresolvedQuestions',
    ]);
    assert.equal(BIBLICAL_RESEARCH_SCHEMA.additionalProperties, false);

    const schemaText = JSON.stringify(BIBLICAL_RESEARCH_SCHEMA).toLowerCase();
    for (const banned of ['verseText', 'passageText', 'userExplanation', 'prayerDirection', 'scriptureText']) {
      assert.equal(schemaText.includes(banned.toLowerCase()), false, `${banned} 자리가 있습니다.`);
    }
    assert.deepEqual([...properties.targetDomain.enum], [...RESEARCHABLE_DOMAINS]);
  });
});

describe('Biblical Researcher · 결과 검증', () => {
  const base = brief();
  const check = (value: unknown, list: ResearchSource[] = sources()) =>
    validateBiblicalResearchResult(value, base, list);

  it('올바른 결과는 통과한다', () => {
    const outcome = check(result());
    assert.equal(outcome.valid, true, outcome.errors.join(' / '));
  });

  it('의뢰서와 대상·버전·판단 시점이 다르면 무효다', () => {
    assert.equal(check(result({ targetDomain: 'burnout_exhaustion' })).valid, false);
    assert.equal(check(result({ evidenceVersion: 5 })).valid, false);
    assert.equal(check(result({ prioritizerSnapshotId: 'snap_other' })).valid, false);
  });

  it(`후보는 ${CANDIDATE_MIN}~${CANDIDATE_MAX}개여야 한다`, () => {
    assert.equal(check(result({ candidatePassages: [] })).valid, false);
    assert.equal(check(result({ candidatePassages: candidates(2) })).valid, false);
    assert.equal(check(result({ candidatePassages: candidates(8) })).valid, false);
    assert.equal(check(result({ candidatePassages: candidates(7) })).valid, true);
  });

  it('채택하지 않은 본문도 남겨야 한다', () => {
    assert.equal(check(result({ rejectedPassages: [] })).valid, false);
    assert.equal(check(result({ rejectedPassages: rejected(REJECTED_MAX + 1) })).valid, false);
  });

  it('같은 본문이 중복되면 무효다', () => {
    const duplicated = [candidate(), candidate(), candidate({ researchConfidence: 0.4 })];
    assert.equal(check(result({ candidatePassages: duplicated })).valid, false);

    const rejectedDuplicated = [rejected(1)[0], rejected(1)[0]];
    assert.equal(check(result({ rejectedPassages: rejectedDuplicated })).valid, false);
  });

  it('같은 본문이 후보와 제외 목록에 함께 있으면 무효다', () => {
    const shared = { book: 'Psalms', chapter: 1, startVerse: 1, endVerse: 3 };
    const outcome = check(
      result({
        rejectedPassages: [
          { reference: shared, rejectionReason: '이유', riskCategory: 'generic_application' },
        ],
      }),
    );
    assert.equal(outcome.valid, false);
  });

  it('본문 위치가 이상하거나 실제 성경에 없으면 무효다', () => {
    for (const bad of [
      { book: '', chapter: 1, startVerse: 1, endVerse: 2 },
      { book: 'TestBook', chapter: 1, startVerse: 1, endVerse: 2 }, // 없는 책
      { book: 'Psalms', chapter: 0, startVerse: 1, endVerse: 2 },
      { book: 'Psalms', chapter: 151, startVerse: 1, endVerse: 2 }, // 없는 장
      { book: 'Psalms', chapter: 1, startVerse: 0, endVerse: 2 },
      { book: 'Psalms', chapter: 1, startVerse: 1, endVerse: 99 }, // 없는 절
      { book: 'Psalms', chapter: 1, startVerse: 5, endVerse: 2 },
      { book: 'Psalms', chapter: 1.5, startVerse: 1, endVerse: 2 },
    ]) {
      const outcome = check(
        result({
          candidatePassages: [candidate({ reference: bad as never }), ...candidates(3).slice(1)],
        }),
      );
      assert.equal(outcome.valid, false, JSON.stringify(bad));
    }
  });

  it('확신 값이 범위를 벗어나면 무효다', () => {
    for (const bad of [-0.1, 1.2, Number.NaN, Number.POSITIVE_INFINITY]) {
      const outcome = check(
        result({
          candidatePassages: [candidate({ researchConfidence: bad }), ...candidates(3).slice(1)],
        }),
      );
      assert.equal(outcome.valid, false, String(bad));
    }
  });

  it('근거 자료가 없거나 없는 자료를 가리키면 무효다', () => {
    const withSupport = (overrides: Partial<SourceSupport>) =>
      result({
        candidatePassages: [
          candidate({ sourceSupport: support(overrides) }),
          ...candidates(3).slice(1),
        ],
      });

    assert.equal(check(withSupport({ exegesisSourceIds: [] })).valid, false);
    assert.equal(check(withSupport({ theologySourceIds: [] })).valid, false);
    assert.equal(check(withSupport({ exegesisSourceIds: ['src-없음'] })).valid, false);
    assert.equal(check(result(), []).valid, false);
  });

  it('넘겨받은 자료 목록에 같은 id가 두 번 있으면 무효다', () => {
    const duplicated = [sources()[0], { ...sources()[1], sourceId: 'src-1' }];
    assert.equal(check(result(), duplicated).valid, false);
  });

  it('알 수 없는 riskCategory는 무효다', () => {
    const outcome = check(
      result({
        rejectedPassages: [
          {
            reference: { book: 'Proverbs', chapter: 9, startVerse: 1, endVerse: 2 },
            rejectionReason: '이유',
            riskCategory: 'made_up_reason' as never,
          },
        ],
      }),
    );
    assert.equal(outcome.valid, false);
    assert.equal(RISK_CATEGORIES.length, 7);
  });

  it('기존 영역과의 구별을 반드시 적어야 한다', () => {
    const outcome = check(
      result({
        candidatePassages: [
          candidate({
            distinctnessFromActiveCoverage: {
              distinct: true,
              nearestExistingDomain: 'made_up_domain',
              explanation: '설명',
            },
          }),
          ...candidates(3).slice(1),
        ],
      }),
    );
    assert.equal(outcome.valid, false);

    // 기존 영역의 변형일 뿐이라고 판단하는 것 자체는 정상이다.
    const honest = check(
      result({
        candidatePassages: [
          candidate({
            distinctnessFromActiveCoverage: {
              distinct: false,
              nearestExistingDomain: 'fear_uncertainty',
              explanation: '사실상 불안 일반에 대한 본문입니다.',
            },
          }),
          ...candidates(3).slice(1),
        ],
      }),
    );
    assert.equal(honest.valid, true, honest.errors.join(' / '));
  });

  it('모르는 항목이 붙으면 무효다', () => {
    assert.equal(check({ ...result(), extraField: 1 }).valid, false);

    const nestedExtra = result();
    (nestedExtra.candidatePassages[0] as unknown as Record<string, unknown>).extraNote = 'x';
    assert.equal(check(nestedExtra).valid, false);

    const badReference = result();
    (badReference.candidatePassages[0].reference as unknown as Record<string, unknown>).translation = 'KRV';
    assert.equal(check(badReference).valid, false);

    const badBoundaries = result();
    (badBoundaries.domainBoundaries as unknown as Record<string, unknown>).note = 'x';
    assert.equal(check(badBoundaries).valid, false);
  });

  it('성경 원문·카드 문안·기도 항목을 넣으면 무효다', () => {
    for (const [key, value] of [
      ['text', '아무 것도 염려하지 말고'],
      ['verseText', '본문'],
      ['scripture', '본문'],
      ['userExplanation', '설명'],
      ['prayerDirection', '기도 방향'],
      ['prayer', '기도문'],
      ['card', {}],
    ] as [string, unknown][]) {
      const withBanned = result() as unknown as Record<string, unknown>;
      withBanned[key] = value;
      assert.equal(check(withBanned).valid, false, `${key}가 통과되었습니다.`);
    }

    // 후보 안쪽에 숨겨도 막는다.
    const nested = result();
    (nested.candidatePassages[0] as unknown as Record<string, unknown>).verseText = '본문 문장';
    assert.equal(check(nested).valid, false);
  });

  it('사용자 데이터 항목은 어디에 있든 무효다', () => {
    for (const key of ['situation', 'rawSituation', 'userId', 'sessionId', 'deviceId', 'jwt', 'token']) {
      const withUserData = result() as unknown as Record<string, unknown>;
      withUserData[key] = 'x';
      assert.equal(check(withUserData).valid, false, `${key}가 통과되었습니다.`);
    }
  });

  it('모르는 것을 남기는 것은 실패가 아니다', () => {
    assert.equal(check(result({ unresolvedQuestions: [] })).valid, true);
    const withQuestions = check(
      result({ unresolvedQuestions: ['이 본문이 개인적 상황과 공동체적 상황 중 어디에 가까운지'] }),
    );
    assert.equal(withQuestions.valid, true, withQuestions.errors.join(' / '));
  });

  it('실제 성경에 없는 후보 본문은 거절한다', () => {
    const fake = check(
      result({
        candidatePassages: [
          candidate({ reference: { book: 'Hezekiah', chapter: 3, startVerse: 1, endVerse: 4 } }),
          ...candidates(3).slice(1),
        ],
      }),
    );
    assert.equal(fake.valid, false);

    // 실제 있는 책이어도 없는 절이면 거절한다.
    const outOfRange = check(
      result({
        candidatePassages: [
          candidate({ reference: { book: 'Jude', chapter: 1, startVerse: 24, endVerse: 40 } }),
          ...candidates(3).slice(1),
        ],
      }),
    );
    assert.equal(outOfRange.valid, false);
  });

  it('실제 성경에 없는 제외 본문도 거절한다', () => {
    const fake = check(
      result({
        rejectedPassages: [
          {
            reference: { book: 'Psalms', chapter: 151, startVerse: 1, endVerse: 2 },
            rejectionReason: '이유',
            riskCategory: 'generic_application',
          },
        ],
      }),
    );
    assert.equal(fake.valid, false);
  });

  it('여러 장에 걸친 본문도 각각 실제로 있어야 한다', () => {
    const ok = check(
      result({
        candidatePassages: [
          candidate({
            additionalReferences: [{ book: 'Psalms', chapter: 2, startVerse: 1, endVerse: 4 }],
          }),
          ...candidates(3).slice(1),
        ],
      }),
    );
    assert.equal(ok.valid, true, ok.errors.join(' / '));

    const broken = check(
      result({
        candidatePassages: [
          candidate({
            additionalReferences: [{ book: 'Psalms', chapter: 999, startVerse: 1, endVerse: 4 }],
          }),
          ...candidates(3).slice(1),
        ],
      }),
    );
    assert.equal(broken.valid, false);
  });

  it('객체가 아니거나 필수 항목이 빠지면 무효다', () => {
    for (const value of [null, 'ok', 42, []]) {
      assert.equal(check(value).valid, false);
    }
    const { domainBoundaries: _boundaries, ...withoutBoundaries } = result();
    void _boundaries;
    assert.equal(check(withoutBoundaries).valid, false);
  });
});

describe('Biblical Researcher · 자료의 역할 경계', () => {
  const base = brief();
  const check = (value: unknown, list: ResearchSource[] = sources()) =>
    validateBiblicalResearchResult(value, base, list);

  const withSupport = (overrides: Partial<SourceSupport>) =>
    result({
      candidatePassages: [
        candidate({ sourceSupport: support(overrides) }),
        ...candidates(3).slice(1),
      ],
    });

  it('전문 분야 자료(src-4)는 안전 근거로만 쓸 수 있다', () => {
    const ok = check(withSupport({ safetySourceIds: ['src-4'] }));
    assert.equal(ok.valid, true, ok.errors.join(' / '));

    for (const field of ['exegesisSourceIds', 'theologySourceIds', 'pastoralSourceIds'] as const) {
      const outcome = check(withSupport({ [field]: ['src-4'] }));
      assert.equal(outcome.valid, false, field);
      assert.ok(outcome.errors.some((error) => error.includes('professional_context')));
    }
  });

  it('목회 보조자료(src-3)는 적용·안전 근거로만 쓸 수 있다', () => {
    const pastoral = check(withSupport({ pastoralSourceIds: ['src-3'] }));
    assert.equal(pastoral.valid, true, pastoral.errors.join(' / '));

    const safety = check(withSupport({ safetySourceIds: ['src-3'] }));
    assert.equal(safety.valid, true, safety.errors.join(' / '));

    for (const field of ['exegesisSourceIds', 'theologySourceIds'] as const) {
      const outcome = check(withSupport({ [field]: ['src-3'] }));
      assert.equal(outcome.valid, false, field);
      assert.ok(outcome.errors.some((error) => error.includes('pastoral_resource')));
    }
  });

  it('학술 자료는 맞는 역할에 쓸 수 있다', () => {
    // 주석 + 주해, 성경신학 + 성경신학, 조직신학 + 교리적 자리
    const systematic: ResearchSource = {
      ...sources()[1],
      sourceId: 'src-5',
      sourceType: 'systematic_theology',
      intendedUse: ['doctrinal_context'],
      accessLevel: 'full_text',
    };

    const outcome = check(
      withSupport({ exegesisSourceIds: ['src-1'], theologySourceIds: ['src-2', 'src-5'] }),
      [...sources(), systematic],
    );
    assert.equal(outcome.valid, true, outcome.errors.join(' / '));
  });

  it('초록만 확인한 자료는 주해·신학 근거가 될 수 없다', () => {
    const abstractOnly = sources().map((source) =>
      source.sourceId === 'src-1' || source.sourceId === 'src-2'
        ? { ...source, accessLevel: 'abstract_only' as const }
        : source,
    );

    const outcome = check(result(), abstractOnly);
    assert.equal(outcome.valid, false);
    assert.ok(outcome.errors.some((error) => error.includes('exegesisSourceIds')));
    assert.ok(outcome.errors.some((error) => error.includes('theologySourceIds')));
  });

  it('본문을 실제로 확인한 자료는 주해·신학 근거가 된다', () => {
    for (const level of ['full_text', 'substantial_preview'] as const) {
      const list = sources().map((source) => ({ ...source, accessLevel: level }));
      const outcome = check(result(), list);
      assert.equal(outcome.valid, true, `${level}: ${outcome.errors.join(' / ')}`);
    }
  });

  it('한 역할 안에서 같은 자료를 두 번 세지 않는다', () => {
    const outcome = check(withSupport({ theologySourceIds: ['src-2', 'src-2'] }));
    assert.equal(outcome.valid, false);
    assert.ok(outcome.errors.some((error) => error.includes('두 번')));
  });

  it('한 자료가 역할에 맞으면 여러 역할에 함께 쓸 수 있다', () => {
    // src-1은 주해와 성경신학 둘 다 승인된 주석 자료다.
    // 다만 같은 근거 하나를 두 역할에 나누어 쓰지는 못한다. 근거마다 용도가 하나뿐이기 때문이다.
    const outcome = check(
      withSupport({
        exegesisEvidenceIds: ['src-1:e1'],
        exegesisSourceIds: ['src-1'],
        theologyEvidenceIds: ['src-1:e2', 'src-2:e1'],
        theologySourceIds: ['src-1', 'src-2'],
      }),
    );
    assert.equal(outcome.valid, true, outcome.errors.join(' / '));
  });

  it('같은 근거를 두 역할에 나누어 쓰면 무효다', () => {
    const outcome = check(
      withSupport({
        exegesisEvidenceIds: ['src-1:e1'],
        exegesisSourceIds: ['src-1'],
        theologyEvidenceIds: ['src-1:e1', 'src-2:e1'],
        theologySourceIds: ['src-1', 'src-2'],
      }),
    );
    assert.equal(outcome.valid, false);
    assert.ok(outcome.errors.some((error) => error.includes('여러 역할에 썼습니다')));
  });

  it('sourceSupport에 모르는 항목이 붙으면 무효다', () => {
    const broken = result();
    (broken.candidatePassages[0].sourceSupport as unknown as Record<string, unknown>).otherSourceIds = [];
    assert.equal(check(broken).valid, false);
  });

  it('Researcher가 자료 metadata를 다시 적어 보내면 무효다', () => {
    const tampered = sources();

    // 자료 목록 자체를 결과에 넣는 것부터 막는다. 그래서 종류·용도·확인 수준·주소를 바꿀 방법이 없다.
    for (const changed of [
      { ...tampered[3], sourceType: 'commentary' as const },
      { ...tampered[0], intendedUse: ['exegesis', 'pastoral_safety'] as never },
      { ...tampered[1], accessLevel: 'full_text' as const },
      { ...tampered[0], url: 'https://내가바꾼주소.example.org/x' },
    ]) {
      const withSources = { ...result(), sources: [changed] } as unknown as Record<string, unknown>;
      const outcome = check(withSources);
      assert.equal(outcome.valid, false);
      assert.ok(outcome.errors.some((error) => error.includes('sources')));
    }
  });

  it('Harvester가 정한 역할은 Researcher 쪽에서 바뀌지 않는다', () => {
    // 전문 분야 자료의 용도를 결과에서 바꾸려 해도, 검증은 넘겨받은 원본 목록만 본다.
    const outcome = check(withSupport({ theologySourceIds: ['src-2', 'src-4'] }));
    assert.equal(outcome.valid, false);
    assert.ok(outcome.errors.some((error) => error.includes('src-4')));
  });
});

/* ------------------------------------------------------------------ */
/* 모델 초안 검사                                                        */
/* ------------------------------------------------------------------ */

/** 최종 결과에서 서버가 붙이는 값만 걷어내면 초안이 된다. */
const draft = (overrides: Record<string, unknown> = {}) => {
  const full = result() as unknown as Record<string, unknown>;
  const { evidenceSetHash: _hash, ...rest } = full;

  rest.candidatePassages = (rest.candidatePassages as Record<string, unknown>[]).map((entry) => {
    const support = entry.sourceSupport as Record<string, unknown>;
    const trimmed: Record<string, unknown> = {};
    for (const field of SUPPORT_DRAFT_FIELDS) trimmed[field] = support[field];
    return { ...entry, sourceSupport: trimmed };
  });

  return { ...rest, ...overrides };
};

describe('Biblical Researcher · 모델 초안 검사', () => {
  it('올바른 초안은 통과한다', () => {
    const checked = validateBiblicalResearchDraftResult(draft(), brief());
    assert.equal(checked.valid, true, checked.errors.join(' / '));
  });

  it('초안에는 꾸러미 지문이 없어도 된다', () => {
    const checked = validateBiblicalResearchDraftResult(draft(), brief());
    assert.deepEqual(
      checked.errors.filter((error) => error.includes('evidenceSetHash')),
      [],
    );
  });

  it('모델이 꾸러미 지문을 적어 오면 거절한다', () => {
    const checked = validateBiblicalResearchDraftResult(
      draft({ evidenceSetHash: `evset_${'a'.repeat(64)}` }),
      brief(),
    );
    assert.equal(checked.valid, false);
  });

  it('모델이 자료 id를 적어 오면 거절한다', () => {
    const invalid = draft() as Record<string, unknown>;
    const first = (invalid.candidatePassages as Record<string, unknown>[])[0] as Record<string, unknown>;
    (first.sourceSupport as Record<string, unknown>).exegesisSourceIds = ['src-1'];
    assert.equal(validateBiblicalResearchDraftResult(invalid, brief()).valid, false);
  });

  it('초안이 쓸 수 있는 항목은 최종 결과에서 지문 하나만 뺀 것이다', () => {
    assert.equal(DRAFT_TOP_LEVEL_FIELDS.includes('evidenceSetHash' as never), false);
    assert.equal(DRAFT_TOP_LEVEL_FIELDS.length, 8);
  });

  it('빠진 항목·더 붙은 항목·잘못된 값은 최종 검사와 똑같이 거절한다', () => {
    const missing = draft() as Record<string, unknown>;
    delete missing.researchQuestion;
    assert.equal(validateBiblicalResearchDraftResult(missing, brief()).valid, false);

    assert.equal(validateBiblicalResearchDraftResult(draft({ extra: 1 }), brief()).valid, false);
    assert.equal(
      validateBiblicalResearchDraftResult(draft({ candidatePassages: [] }), brief()).valid,
      false,
    );
    assert.equal(
      validateBiblicalResearchDraftResult(draft({ targetDomain: 'grief_loss' }), brief()).valid,
      false,
    );
  });

  it('성경에 없는 장·절은 거절한다', () => {
    const invalid = draft() as Record<string, unknown>;
    const first = (invalid.candidatePassages as Record<string, unknown>[])[0] as Record<string, unknown>;
    first.reference = { book: 'Psalms', chapter: 999, startVerse: 1, endVerse: 1 };
    assert.equal(validateBiblicalResearchDraftResult(invalid, brief()).valid, false);
  });

  it('근거가 실제로 있는지·역할에 맞는지는 여기서 보지 않는다', () => {
    // 그 판단은 근거에 묶는 단계가 한다. 같은 규칙을 두 곳에 두지 않는다.
    const unknownEvidence = draft() as Record<string, unknown>;
    for (const entry of unknownEvidence.candidatePassages as Record<string, unknown>[]) {
      (entry.sourceSupport as Record<string, unknown>).exegesisEvidenceIds = ['src-99:e1'];
    }
    const checked = validateBiblicalResearchDraftResult(unknownEvidence, brief());
    assert.equal(checked.valid, true, checked.errors.join(' / '));
  });

  it('최종 검사는 그대로다. 초안을 최종 결과로 통과시키지 않는다', () => {
    const asFinal = validateBiblicalResearchResult(draft(), brief(), sources());
    assert.equal(asFinal.valid, false);
  });
});
