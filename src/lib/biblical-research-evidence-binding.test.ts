/**
 * 연구 결과를 실제 근거에 묶는가 · 테스트
 *
 * 실행: npm test
 *
 * 지키려는 것:
 *   모델은 "어떤 근거를 썼는가"만 고른다.
 *   그 근거가 어느 자료의 것인지는 서버가 찾는다.
 *   주해 근거는 그 후보 본문을 실제로 다루어야 한다.
 *   꾸러미 지문은 서버가 붙인다.
 *
 * 실제 DB·OpenAI·웹 호출은 하지 않는다.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import {
  bindBiblicalResearchEvidence,
  matchesEvidenceSet,
} from '../../supabase/functions/_shared/biblical-research-evidence-binding.ts';
import {
  buildBiblicalResearchHandoff,
  type BiblicalResearchHandoff,
} from '../../supabase/functions/_shared/biblical-research-handoff.ts';
import {
  BIBLICAL_RESEARCH_SCHEMA,
  buildBiblicalResearchInstructions,
} from '../../supabase/functions/_shared/biblical-research-contract.ts';
import { computeSourceId } from '../../supabase/functions/_shared/source-harvester.ts';
import { referencesOverlap } from '../../supabase/functions/_shared/bible-reference.ts';
import { getActiveCoveredDomains } from '../../supabase/functions/_shared/research-prioritizer-edge.ts';

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
const stripComments = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '');

const BINDING = '../../supabase/functions/_shared/biblical-research-evidence-binding.ts';

const activeCovered = getActiveCoveredDomains();
const SNAPSHOT = `snap_${'a'.repeat(64)}`;
const PSALM = { book: 'Psalms', chapter: 42, startVerse: 5, endVerse: 5 };
const OTHER = { book: 'John', chapter: 21, startVerse: 15, endVerse: 17 };
const PSALM1 = { book: 'Psalms', chapter: 1, startVerse: 1, endVerse: 3 };

const url = (index: number) => `https://sources.example.org/aroeda/fixture-${index}`;
const SOURCE_IDS = await Promise.all(
  Array.from({ length: 6 }, (_, index) => computeSourceId(url(index))),
);
const sid = (index: number) => SOURCE_IDS[index] as string;
const eid = (index: number, claim = 1) => `${sid(index)}:e${claim}`;

const STATEMENT = '이 자료는 본문의 흐름과 그 신학적 자리를 함께 설명한다고 관찰되었다. 충분히 긴 문장이다.';

/**
 * 0 주해(시편42) · 1 성경신학 · 2 주해(시편42) · 3 목회 · 4 안전(전문분야)
 * 0번 자료는 근거를 둘 갖는다. 한 자료가 여러 역할에 쓰이는 경우를 보기 위해서다.
 */
const SPECS = [
  {
    type: 'commentary',
    publisher: 'Fixture Academic Press',
    uses: ['exegesis', 'biblical_theology'],
    access: 'full_text',
    claims: [
      { use: 'exegesis', refs: [{ ...PSALM }] },
      { use: 'biblical_theology', refs: [] },
      { use: 'exegesis', refs: [{ ...PSALM1 }] },
    ],
  },
  {
    type: 'biblical_theology',
    publisher: 'Fixture University Press',
    uses: ['biblical_theology', 'doctrinal_context'],
    access: 'substantial_preview',
    claims: [{ use: 'doctrinal_context', refs: [] }],
  },
  {
    type: 'academic_article',
    publisher: 'Fixture Journal',
    uses: ['exegesis'],
    access: 'full_text',
    claims: [{ use: 'exegesis', refs: [{ ...OTHER }] }],
  },
  {
    type: 'pastoral_resource',
    publisher: 'Fixture Seminary',
    uses: ['pastoral_application'],
    access: 'full_text',
    claims: [{ use: 'pastoral_application', refs: [] }],
  },
  {
    type: 'professional_context',
    publisher: 'Fixture Public Health Agency',
    uses: ['pastoral_safety', 'real_world_context'],
    access: 'full_text',
    claims: [{ use: 'pastoral_safety', refs: [] }],
  },
];

const harvestSource = (index: number) => {
  const spec = SPECS[index];
  return {
    sourceId: sid(index),
    sourceType: spec.type,
    title: `연구 자료 ${index}`,
    authorOrOrganization: `연구자 ${index}`,
    publisherOrInstitution: spec.publisher,
    publicationYear: 2018 + index,
    url: url(index),
    accessedAt: '2026-09-02',
    accessLevel: spec.access,
    intendedUse: [...spec.uses],
    relevanceNote: '이 영역의 문맥을 확인하는 데 필요합니다.',
    evidenceClaims: spec.claims.map((claim, claimIndex) => ({
      evidenceId: eid(index, claimIndex + 1),
      intendedUse: claim.use,
      statement: `${STATEMENT} (${index}-${claimIndex})`,
      passageReferences: claim.refs,
    })),
  };
};

const handoffOf = async (): Promise<BiblicalResearchHandoff> => {
  const outcome = await buildBiblicalResearchHandoff({
    harvest: {
      targetDomain: 'financial_hardship',
      evidenceVersion: 4,
      prioritizerSnapshotId: SNAPSHOT,
      sources: SPECS.map((_, index) => harvestSource(index)),
      rejectedSources: [],
      unresolvedSourceQuestions: ['더 볼 자료가 있는가'],
    } as never,
    activeCoveredDomains: activeCovered,
  });
  assert.equal(outcome.ok, true, outcome.ok ? '' : outcome.errors.join(' / '));
  if (!outcome.ok) throw new Error('handoff failed');
  return outcome.handoff;
};

const HANDOFF = await handoffOf();

const support = (overrides: Record<string, unknown> = {}) => ({
  exegesisEvidenceIds: [eid(0, 1)],
  theologyEvidenceIds: [eid(1, 1)],
  pastoralEvidenceIds: [],
  safetyEvidenceIds: [],
  ...overrides,
});

const candidate = (overrides: Record<string, unknown> = {}) => ({
  reference: { ...PSALM },
  additionalReferences: [],
  canonicalContext: '본문이 놓인 흐름에 대한 메모입니다.',
  theologicalContribution: '이 영역에 주는 신학적 기여에 대한 메모입니다.',
  domainFit: '이 삶의 문제를 직접 다루기 때문입니다.',
  pastoralUse: ['이 본문을 어떻게 쓸 수 있는지에 대한 메모입니다.'],
  misuseRisks: ['이 본문이 오용될 수 있는 방식에 대한 메모입니다.'],
  distinctnessFromActiveCoverage: {
    distinct: true,
    nearestExistingDomain: null,
    explanation: '지금 카드가 다루는 영역과 구별되는 이유에 대한 메모입니다.',
  },
  researchConfidence: 0.8,
  sourceSupport: support(),
  ...overrides,
});

/** 두 번째 후보: 요한복음 21장. 그 본문을 다루는 주해 근거를 쓴다. */
const secondCandidate = () =>
  candidate({
    reference: { ...OTHER },
    sourceSupport: support({ exegesisEvidenceIds: [eid(2, 1)] }),
  });

/** 세 번째 후보: 시편 1편. 역시 그 본문을 다루는 주해 근거를 쓴다. */
const thirdCandidate = () =>
  candidate({
    reference: { ...PSALM1 },
    sourceSupport: support({ exegesisEvidenceIds: [eid(0, 3)] }),
  });

const draft = (overrides: Record<string, unknown> = {}) => ({
  targetDomain: 'financial_hardship',
  evidenceVersion: 4,
  prioritizerSnapshotId: SNAPSHOT,
  researchQuestion: '성경은 이 삶의 문제를 어떤 본문에서 직접 다루는가?',
  domainBoundaries: {
    includedConcerns: ['생계 압박'],
    excludedOrAdjacentConcerns: ['일반적인 미래 불안'],
  },
  candidatePassages: [candidate(), secondCandidate(), thirdCandidate()],
  rejectedPassages: [
    {
      reference: { book: 'Proverbs', chapter: 1, startVerse: 5, endVerse: 6 },
      rejectionReason: '이 영역의 핵심 문제를 다루지 않습니다.',
      riskCategory: 'adjacent_domain_only',
    },
  ],
  unresolvedQuestions: [],
  ...overrides,
});

const bind = (overrides: Record<string, unknown> = {}, handoff = HANDOFF) =>
  bindBiblicalResearchEvidence({ draft: draft(overrides) as never, handoff });

/** 첫 후보의 근거만 바꾼 초안 */
const withSupport = (patch: Record<string, unknown>) =>
  bind({
    candidatePassages: [
      candidate({ sourceSupport: support(patch) }),
      secondCandidate(),
      thirdCandidate(),
    ],
  });

/* ------------------------------------------------------------------ */

describe('근거 묶기 · A. 모델이 쓰는 초안 구조', () => {
  const supportSchema = () =>
    (BIBLICAL_RESEARCH_SCHEMA as unknown as {
      properties: {
        candidatePassages: {
          items: { properties: { sourceSupport: { properties: Record<string, unknown>; required: string[]; additionalProperties: boolean } } };
        };
      };
    }).properties.candidatePassages.items.properties.sourceSupport;

  it('초안은 근거 번호만 고르게 한다', () => {
    const schema = supportSchema();
    assert.deepEqual(Object.keys(schema.properties).sort(), [
      'exegesisEvidenceIds',
      'pastoralEvidenceIds',
      'safetyEvidenceIds',
      'theologyEvidenceIds',
    ]);
    assert.equal(schema.additionalProperties, false);
  });

  it('초안에 자료 id 자리가 없다', () => {
    const schema = supportSchema();
    for (const field of [
      'exegesisSourceIds',
      'theologySourceIds',
      'pastoralSourceIds',
      'safetySourceIds',
    ]) {
      assert.equal(field in schema.properties, false, field);
      assert.equal(schema.required.includes(field), false, field);
    }
  });

  it('초안에 꾸러미 지문 자리가 없다', () => {
    const top = (BIBLICAL_RESEARCH_SCHEMA as unknown as { properties: Record<string, unknown>; required: string[] });
    assert.equal('evidenceSetHash' in top.properties, false);
    assert.equal(top.required.includes('evidenceSetHash'), false);
  });

  it('지시문이 근거 번호를 고르라고 말한다', () => {
    const text = buildBiblicalResearchInstructions({
      targetDomain: 'financial_hardship',
      domainDescription: '생계와 경제적 어려움',
      activeCoveredDomains: activeCovered,
    });

    assert.ok(text.includes('자료 번호가 아니라 근거 번호(evidenceId)'));
    assert.ok(text.includes('sourceId는 적지 마십시오'));
    assert.ok(text.includes('번호를 지어내지 마십시오'));
    assert.ok(text.includes('같은 근거를 여러 역할에 나누어 쓰지 마십시오'));
    assert.ok(text.includes('그 후보 본문을 실제로 다루는 주해 근거만'));
    assert.ok(text.includes('제목과 저자만 보고 그 자료가 무엇을 말하는지 짐작하지 마십시오'));
    assert.ok(text.includes('서버가 원문과 대조해 그 뜻을 보증하지도 않았습니다'));
    assert.ok(text.includes('근거 없이 후보를 유지하지 마십시오'));
  });
});

describe('근거 묶기 · B. 아는 근거만 쓸 수 있다', () => {
  it('꾸러미에 있는 근거는 통과한다', () => {
    const outcome = bind();
    assert.equal(outcome.ok, true, outcome.ok ? '' : outcome.errors.join(' / '));
  });

  it('꾸러미에 없는 번호는 거절한다', () => {
    const outcome = withSupport({ exegesisEvidenceIds: [`${sid(0)}:e9`] });
    assert.equal(outcome.ok, false);
    if (outcome.ok) return;
    assert.ok(outcome.errors.some((error) => error.includes('꾸러미에 없는 근거')));
  });

  it('다른 자료의 번호를 지어내면 거절한다', () => {
    const outcome = withSupport({ exegesisEvidenceIds: [`${sid(5)}:e1`] });
    assert.equal(outcome.ok, false);
  });

  it('모양이 틀린 번호는 거절한다', () => {
    for (const bad of ['made-up', '', `${sid(0)}`, `${sid(0)}:x`]) {
      const outcome = withSupport({ exegesisEvidenceIds: [bad] });
      assert.equal(outcome.ok, false, bad);
    }
  });

  it('번호 문자열을 잘라 자료를 짐작하지 않는다', () => {
    const code = stripComments(read(BINDING));
    assert.ok(code.includes('index.get(evidenceId)'));
    // 번호에서 자료 id를 잘라 내는 자리가 없다.
    assert.equal(/split\(':'\)|indexOf\(':'\)|slice\(0,\s*evidenceId/.test(code), false);
  });
});

describe('근거 묶기 · C. 역할과 용도', () => {
  it('주해 근거는 주해 역할에 쓸 수 있다', () => {
    assert.equal(bind().ok, true);
  });

  it('목회 근거를 주해 역할에 쓰면 거절한다', () => {
    const outcome = withSupport({ exegesisEvidenceIds: [eid(3, 1)] });
    assert.equal(outcome.ok, false);
    if (outcome.ok) return;
    assert.ok(outcome.errors.some((error) => error.includes('쓸 수 없습니다')));
  });

  it('교리 근거는 신학 역할에 쓸 수 있다', () => {
    assert.equal(withSupport({ theologyEvidenceIds: [eid(1, 1)] }).ok, true);
  });

  it('안전 근거는 안전 역할에 쓸 수 있다', () => {
    assert.equal(withSupport({ safetyEvidenceIds: [eid(4, 1)] }).ok, true);
  });

  it('안전 근거를 신학 역할에 쓰면 거절한다', () => {
    assert.equal(withSupport({ theologyEvidenceIds: [eid(4, 1)] }).ok, false);
  });

  it('같은 근거를 두 역할에 쓰면 거절한다', () => {
    const outcome = withSupport({
      exegesisEvidenceIds: [eid(0, 1)],
      theologyEvidenceIds: [eid(0, 1), eid(1, 1)],
    });
    assert.equal(outcome.ok, false);
    if (outcome.ok) return;
    assert.ok(outcome.errors.some((error) => error.includes('여러 역할에 썼습니다')));
  });

  it('한 역할 안에서 같은 근거를 두 번 쓰면 거절한다', () => {
    const outcome = withSupport({ exegesisEvidenceIds: [eid(0, 1), eid(0, 1)] });
    assert.equal(outcome.ok, false);
    if (outcome.ok) return;
    assert.ok(outcome.errors.some((error) => error.includes('두 번')));
  });

  it('용도 목록을 새로 적지 않았다', () => {
    const code = stripComments(read(BINDING));
    assert.ok(code.includes('SUPPORT_ROLE_EVIDENCE_USES[role]'));
    assert.equal(/'exegesis'\s*,\s*'biblical_theology'/.test(code), false);
  });
});

describe('근거 묶기 · D. 자료 id는 서버가 뽑는다', () => {
  it('같은 자료의 근거 둘이면 자료 id는 하나다', () => {
    // 0번 자료는 주해 근거와 성경신학 근거를 함께 갖는다.
    const outcome = withSupport({
      exegesisEvidenceIds: [eid(0, 1)],
      theologyEvidenceIds: [eid(0, 2), eid(1, 1)],
    });
    assert.equal(outcome.ok, true, outcome.ok ? '' : outcome.errors.join(' / '));
    if (!outcome.ok) return;

    const first = outcome.result.candidatePassages[0].sourceSupport;
    assert.deepEqual(first.exegesisSourceIds, [sid(0)]);
    assert.deepEqual(first.theologySourceIds, [sid(0), sid(1)].sort());
  });

  it('서로 다른 자료의 근거면 자료 id도 둘이다', () => {
    const outcome = withSupport({ theologyEvidenceIds: [eid(0, 2), eid(1, 1)] });
    assert.equal(outcome.ok, true);
    if (!outcome.ok) return;
    assert.equal(outcome.result.candidatePassages[0].sourceSupport.theologySourceIds.length, 2);
  });

  it('자료 id는 정해진 순서로 나온다', () => {
    const outcome = withSupport({ theologyEvidenceIds: [eid(1, 1), eid(0, 2)] });
    assert.equal(outcome.ok, true);
    if (!outcome.ok) return;

    const ids = outcome.result.candidatePassages[0].sourceSupport.theologySourceIds;
    assert.deepEqual(ids, [...ids].sort());
  });

  it('근거 번호는 모델이 적은 순서 그대로 둔다', () => {
    const outcome = withSupport({ theologyEvidenceIds: [eid(1, 1), eid(0, 2)] });
    assert.equal(outcome.ok, true);
    if (!outcome.ok) return;
    assert.deepEqual(outcome.result.candidatePassages[0].sourceSupport.theologyEvidenceIds, [
      eid(1, 1),
      eid(0, 2),
    ]);
  });

  it('모델이 자료 id를 넣을 길이 없다', () => {
    // 초안에 그 칸이 없으므로 넣어도 최종 검사에서 걸린다.
    const outcome = withSupport({ exegesisSourceIds: [sid(4)] } as Record<string, unknown>);
    assert.equal(outcome.ok, false);
  });
});

describe('근거 묶기 · E. 자료 정책은 그대로다', () => {
  it('초록만 본 자료의 근거는 주해가 되지 못한다', async () => {
    const abstractOnly = { ...harvestSource(2), accessLevel: 'abstract_only' };
    const outcome = await buildBiblicalResearchHandoff({
      harvest: {
        targetDomain: 'financial_hardship',
        evidenceVersion: 4,
        prioritizerSnapshotId: SNAPSHOT,
        sources: [harvestSource(0), harvestSource(1), abstractOnly, harvestSource(3), harvestSource(4)],
        rejectedSources: [],
        unresolvedSourceQuestions: [],
      } as never,
      activeCoveredDomains: activeCovered,
    });
    assert.equal(outcome.ok, true, outcome.ok ? '' : outcome.errors.join(' / '));
    if (!outcome.ok) return;

    // 근거의 용도는 맞지만 자료의 확인 수준이 모자란다.
    const bound = bindBiblicalResearchEvidence({
      draft: draft({
        candidatePassages: [
          candidate({
            reference: { ...OTHER },
            sourceSupport: support({ exegesisEvidenceIds: [eid(2, 1)] }),
          }),
          candidate(),
          thirdCandidate(),
        ],
      }) as never,
      handoff: outcome.handoff,
    });
    assert.equal(bound.ok, false);
  });

  it('전문 분야 자료는 주해 근거가 되지 못한다', () => {
    assert.equal(withSupport({ exegesisEvidenceIds: [eid(4, 1)] }).ok, false);
  });

  it('목회 보조자료는 신학 핵심 근거가 되지 못한다', () => {
    assert.equal(withSupport({ theologyEvidenceIds: [eid(3, 1)] }).ok, false);
  });

  it('자료 역할 규칙을 여기서 다시 적지 않는다', () => {
    const code = stripComments(read(BINDING));
    assert.ok(code.includes('validateBiblicalResearchResult('));
    assert.equal(code.includes('DEEP_ACCESS_LEVELS'), false);
    assert.equal(code.includes('isSourceAllowedForRole'), false);
  });
});

describe('근거 묶기 · F. 주해 근거는 그 본문을 다루어야 한다', () => {
  it('같은 본문을 다룬 주해 근거는 통과한다', () => {
    assert.equal(bind().ok, true);
  });

  it('전혀 다른 본문을 다룬 주해 근거는 거절한다', () => {
    // 2번 자료의 주해 근거는 요한복음 21장을 다룬다. 후보는 시편 42편이다.
    const outcome = withSupport({ exegesisEvidenceIds: [eid(2, 1)] });
    assert.equal(outcome.ok, false);
    if (outcome.ok) return;
    assert.ok(outcome.errors.some((error) => error.includes('이 후보 본문을 다루지 않는 주해 근거')));
  });

  it('이어지는 본문과 맞아도 통과한다', () => {
    const outcome = bind({
      candidatePassages: [
        candidate({
          reference: { book: 'Psalms', chapter: 8, startVerse: 1, endVerse: 2 },
          additionalReferences: [{ ...PSALM }],
        }),
        secondCandidate(),
        thirdCandidate(),
      ],
    });
    assert.equal(outcome.ok, true, outcome.ok ? '' : outcome.errors.join(' / '));
  });

  it('절 범위가 겹치기만 해도 통과한다', () => {
    const outcome = bind({
      candidatePassages: [
        candidate({ reference: { book: 'Psalms', chapter: 42, startVerse: 1, endVerse: 11 } }),
        secondCandidate(),
        thirdCandidate(),
      ],
    });
    assert.equal(outcome.ok, true);
  });

  it('주해가 아닌 역할에는 본문 일치를 요구하지 않는다', () => {
    // 성경신학·목회·안전 근거는 본문 위치가 비어 있어도 된다.
    const outcome = withSupport({
      theologyEvidenceIds: [eid(1, 1)],
      pastoralEvidenceIds: [eid(3, 1)],
      safetyEvidenceIds: [eid(4, 1)],
    });
    assert.equal(outcome.ok, true, outcome.ok ? '' : outcome.errors.join(' / '));
  });

  it('본문 비교 규칙을 새로 만들지 않았다', () => {
    const code = stripComments(read(BINDING));
    assert.ok(code.includes('referencesOverlap('));
    // 책 이름을 손으로 비교하거나 문자열을 해석하지 않는다.
    assert.equal(/Psalms|Genesis|BIBLE_REFERENCE_INDEX|\.split\(' '\)/.test(code), false);

    // 겹침 판정은 이미 검증된 네 값으로만 한다.
    assert.equal(referencesOverlap(PSALM, { ...PSALM }), true);
    assert.equal(referencesOverlap(PSALM, OTHER), false);
    assert.equal(referencesOverlap(PSALM, { book: 'Psalms', chapter: 42, startVerse: 1, endVerse: 4 }), false);
    assert.equal(referencesOverlap(PSALM, { book: 'Psalms', chapter: 42, startVerse: 1, endVerse: 5 }), true);
    assert.equal(referencesOverlap(PSALM, { book: 'Psalms', chapter: 43, startVerse: 5, endVerse: 5 }), false);
    assert.equal(referencesOverlap(PSALM, { book: 'Psalmss', chapter: 42, startVerse: 5, endVerse: 5 }), false);
  });
});

describe('근거 묶기 · G. 꾸러미 지문', () => {
  it('최종 결과의 지문은 꾸러미의 것이다', () => {
    const outcome = bind();
    assert.equal(outcome.ok, true);
    if (!outcome.ok) return;
    assert.equal(outcome.result.evidenceSetHash, HANDOFF.evidenceSetHash);
    assert.match(outcome.result.evidenceSetHash, /^evset_[0-9a-f]{64}$/);
  });

  it('모델이 지문을 적으면 무시하지 않고 거절한다', () => {
    const outcome = bind({ evidenceSetHash: `evset_${'f'.repeat(64)}` });
    assert.equal(outcome.ok, false);
  });

  it('지문은 꾸러미에서만 온다', () => {
    const code = stripComments(read(BINDING));
    assert.ok(code.includes('evidenceSetHash: handoff.evidenceSetHash'));
    // 여기서 새로 계산하지 않는다.
    assert.equal(code.includes('computeBiblicalResearchEvidenceSetHash'), false);
    assert.equal(code.includes('crypto'), false);
  });

  it('다른 꾸러미에서 나온 결과인지 확인할 수 있다', () => {
    const outcome = bind();
    if (!outcome.ok) return;

    assert.equal(matchesEvidenceSet(outcome.result, HANDOFF).valid, true);
    assert.equal(
      matchesEvidenceSet(outcome.result, {
        ...HANDOFF,
        evidenceSetHash: `evset_${'0'.repeat(64)}`,
      }).valid,
      false,
    );
  });
});

describe('근거 묶기 · H. 어느 연구인지', () => {
  it('영역이 다르면 거절한다', () => {
    assert.equal(bind({ targetDomain: 'spiritual_dryness' }).ok, false);
  });

  it('근거 판본이 다르면 거절한다', () => {
    const outcome = bind({ evidenceVersion: 5 });
    assert.equal(outcome.ok, false);
    if (outcome.ok) return;
    assert.ok(outcome.errors.some((error) => error.includes('근거 판본')));
  });

  it('판단 시점이 다르면 거절한다', () => {
    assert.equal(bind({ prioritizerSnapshotId: `snap_${'b'.repeat(64)}` }).ok, false);
  });

  it('provenance 세 값이 결과에 그대로 남는다', () => {
    const outcome = bind();
    if (!outcome.ok) return;
    assert.equal(outcome.result.targetDomain, HANDOFF.brief.targetDomain);
    assert.equal(outcome.result.evidenceVersion, HANDOFF.brief.evidenceVersion);
    assert.equal(outcome.result.prioritizerSnapshotId, HANDOFF.brief.prioritizerSnapshotId);
  });
});

describe('근거 묶기 · I. 글을 고치지 않는다', () => {
  it('후보의 글이 그대로다', () => {
    const outcome = bind();
    if (!outcome.ok) return;

    const first = outcome.result.candidatePassages[0];
    const original = candidate();
    assert.equal(first.canonicalContext, original.canonicalContext);
    assert.equal(first.theologicalContribution, original.theologicalContribution);
    assert.equal(first.domainFit, original.domainFit);
    assert.deepEqual(first.reference, original.reference);
  });

  it('근거 번호가 그대로다', () => {
    const outcome = bind();
    if (!outcome.ok) return;
    assert.deepEqual(outcome.result.candidatePassages[0].sourceSupport.exegesisEvidenceIds, [
      eid(0, 1),
    ]);
  });

  it('남은 물음 두 가지를 섞지 않는다', () => {
    const outcome = bind({ unresolvedQuestions: ['연구 단계에서 남은 물음'] });
    if (!outcome.ok) return;

    assert.deepEqual(outcome.result.unresolvedQuestions, ['연구 단계에서 남은 물음']);
    // 자료 수집 단계의 물음은 결과에 섞이지 않는다.
    assert.equal(JSON.stringify(outcome.result).includes('더 볼 자료가 있는가'), false);
  });

  it('꾸러미의 근거를 다 쓰지 않아도 된다', () => {
    const outcome = bind();
    assert.equal(outcome.ok, true);
    if (!outcome.ok) return;

    const used = new Set(
      outcome.result.candidatePassages.flatMap((entry) => [
        ...entry.sourceSupport.exegesisEvidenceIds,
        ...entry.sourceSupport.theologyEvidenceIds,
        ...entry.sourceSupport.pastoralEvidenceIds,
        ...entry.sourceSupport.safetyEvidenceIds,
      ]),
    );
    const available = HANDOFF.sources.flatMap((source) =>
      source.evidenceClaims.map((claim) => claim.evidenceId),
    );
    assert.ok(used.size < available.length);
  });

  it('제외한 본문에는 근거를 붙이지 않는다', () => {
    const outcome = bind();
    if (!outcome.ok) return;
    for (const rejected of outcome.result.rejectedPassages) {
      assert.equal('sourceSupport' in rejected, false);
    }
  });
});

describe('근거 묶기 · J. 바깥과 닿지 않는다', () => {
  it('네트워크·DB·환경변수를 모른다', () => {
    const code = stripComments(read(BINDING));
    for (const banned of [
      'fetch(',
      'Deno.env',
      'process.env',
      'createClient',
      '/rest/v1/',
      'OpenAI',
      'api.openai.com',
    ]) {
      assert.equal(code.includes(banned), false, banned);
    }
  });

  it('새 자료를 찾지 않는다', () => {
    const code = stripComments(read(BINDING));
    for (const banned of ['web_search', 'search(', 'browser', 'url:', 'http']) {
      assert.equal(code.includes(banned), false, banned);
    }
  });

  it('사용자 정보를 받을 자리가 없다', () => {
    const code = stripComments(read(BINDING));
    for (const banned of [
      'situation',
      'userId',
      'sessionId',
      'deviceId',
      'prayerText',
      'decisionId',
      'recoveryId',
      'severity',
    ]) {
      assert.equal(code.includes(banned), false, banned);
    }

    const outcome = bind();
    if (!outcome.ok) return;
    const dumped = JSON.stringify(outcome.result);
    for (const banned of ['situation', 'userId', 'sessionId', 'deviceId', 'decisionId']) {
      assert.equal(dumped.includes(banned), false, banned);
    }
  });

  it('가져오는 것은 기존 계약뿐이다', () => {
    const imports = [...read(BINDING).matchAll(/from '([^']+)'/g)].map((match) => match[1]);
    assert.deepEqual([...new Set(imports)].sort(), [
      './bible-reference.ts',
      './biblical-research-handoff.ts',
      './biblical-researcher.ts',
      './research-source.ts',
    ]);
  });
});


/* ------------------------------------------------------------------ */
/* 꾸러미 자체가 어긋난 경우                                             */
/* ------------------------------------------------------------------ */

describe('근거 묶기 · 꾸러미의 주인 관계를 다시 본다', () => {
  /** 검증을 거치지 않고 직접 만든 꾸러미. 어긋난 상태를 넣어 보기 위해서다. */
  const forged = (sources: unknown[]): BiblicalResearchHandoff =>
    ({ ...HANDOFF, sources }) as unknown as BiblicalResearchHandoff;

  const sourceOf = (index: number, claims: unknown[]) => ({
    ...HANDOFF.sources[index],
    evidenceClaims: claims,
  });

  const claimOf = (index: number, claim: number) =>
    HANDOFF.sources[index].evidenceClaims.find(
      (entry) => entry.evidenceId === eid(index, claim),
    );

  it('정상 꾸러미는 그대로 통과한다', () => {
    assert.equal(bind({}, forged([...HANDOFF.sources])).ok, true);
  });

  it('두 자료가 같은 번호를 갖고 있으면 거절한다', () => {
    // 1번 자료가 0번 자료의 번호를 들고 있다. 덮어쓰기가 일어나면 주인이 바뀐다.
    const stolen = sourceOf(1, [{ ...claimOf(0, 1), intendedUse: 'doctrinal_context' }]);
    const outcome = bind({}, forged([HANDOFF.sources[0], stolen, ...HANDOFF.sources.slice(2)]));

    assert.equal(outcome.ok, false);
    if (outcome.ok) return;

    // 번호에 자료 id가 들어 있으므로 순서 검사가 먼저 잡는다.
    // 어느 쪽이 잡든 덮어쓰기 전에 멈추는 것이 중요하다.
    assert.ok(
      outcome.errors.some(
        (error) =>
          error.includes('번호가 서버가 붙인 것과 다릅니다') ||
          error.includes('같은 번호가 두 번'),
      ),
      outcome.errors.join(' / '),
    );
  });

  it('덮어쓰기로 주인이 바뀐 채 통과하지 않는다', () => {
    // 앞의 시험과 같은 상황에서, 그 번호를 실제로 쓰는 초안을 넣어 본다.
    const stolen = sourceOf(1, [{ ...claimOf(0, 1), intendedUse: 'doctrinal_context' }]);
    const outcome = bind(
      { candidatePassages: [candidate(), secondCandidate(), thirdCandidate()] },
      forged([HANDOFF.sources[0], stolen, ...HANDOFF.sources.slice(2)]),
    );
    assert.equal(outcome.ok, false);
  });

  it('첫 번째 근거의 번호가 e2면 거절한다', () => {
    const shifted = sourceOf(1, [{ ...claimOf(1, 1), evidenceId: eid(1, 2) }]);
    const outcome = bind({}, forged([HANDOFF.sources[0], shifted, ...HANDOFF.sources.slice(2)]));

    assert.equal(outcome.ok, false);
    if (outcome.ok) return;
    assert.ok(outcome.errors.some((error) => error.includes('번호가 서버가 붙인 것과 다릅니다')));
  });

  it('다른 자료의 번호를 달고 있으면 거절한다', () => {
    const wrong = sourceOf(1, [{ ...claimOf(1, 1), evidenceId: `${sid(4)}:e1` }]);
    assert.equal(bind({}, forged([HANDOFF.sources[0], wrong, ...HANDOFF.sources.slice(2)])).ok, false);
  });

  it('같은 자료가 두 번 들어 있으면 거절한다', () => {
    const outcome = bind({}, forged([...HANDOFF.sources, HANDOFF.sources[0]]));
    assert.equal(outcome.ok, false);
    if (outcome.ok) return;
    assert.ok(outcome.errors.some((error) => error.includes('같은 자료가 두 번')));
  });

  it('표를 만들 때 덮어쓰지 않는다', () => {
    const code = stripComments(read(BINDING));
    assert.ok(code.includes('if (index.has(claim.evidenceId))'));
    assert.ok(code.includes('`${source.sourceId}:e${claimIndex + 1}`'));
    // 실패하면 표를 쓰지 않고 그대로 끝낸다.
    assert.ok(code.includes('if (!built.ok) return { ok: false, errors: built.errors };'));
  });
});

describe('근거 묶기 · 지시문에 옛 지시가 남아 있지 않다', () => {
  const text = () =>
    buildBiblicalResearchInstructions({
      targetDomain: 'financial_hardship',
      domainDescription: '생계와 경제적 어려움',
      activeCoveredDomains: activeCovered,
    });

  it('sourceId를 고르라는 옛 문장이 없다', () => {
    assert.equal(text().includes('sourceId만 쓰십시오'), false);
    assert.equal(text().includes('sourceId만 가리키면 됩니다'), false);
  });

  it('근거 번호를 고르라고 말한다', () => {
    assert.ok(text().includes('함께 전달된 근거 목록에 실제로 있는 evidenceId만 사용하십시오'));
    assert.ok(text().includes('없는 번호를 지어내지 마십시오'));
  });

  it('sourceId를 적지 말라고 말한다', () => {
    assert.ok(text().includes('sourceId는 적지 마십시오'));
    assert.ok(text().includes('서버가 찾습니다'));
  });

  it('자료를 새로 만들지 말라는 지시는 그대로다', () => {
    assert.ok(text().includes('새 자료를 만들지 말고'));
    assert.ok(text().includes('자료 metadata를 다시 적어 보내지 마십시오'));
  });
});

describe('근거 묶기 · 어느 꾸러미에서 나왔는지 네 값으로 본다', () => {
  const boundResult = () => {
    const outcome = bind();
    assert.equal(outcome.ok, true);
    if (!outcome.ok) throw new Error('bind failed');
    return outcome.result;
  };

  it('같은 연구·같은 꾸러미면 통과한다', () => {
    assert.equal(matchesEvidenceSet(boundResult(), HANDOFF).valid, true);
  });

  it('지문이 같아도 영역이 다르면 거절한다', () => {
    const result = { ...boundResult(), targetDomain: 'spiritual_dryness' };
    const outcome = matchesEvidenceSet(result, HANDOFF);
    assert.equal(outcome.valid, false);
    assert.ok(outcome.errors.some((error) => error.includes('연구 영역')));
  });

  it('지문이 같아도 근거 판본이 다르면 거절한다', () => {
    const outcome = matchesEvidenceSet({ ...boundResult(), evidenceVersion: 5 }, HANDOFF);
    assert.equal(outcome.valid, false);
    assert.ok(outcome.errors.some((error) => error.includes('근거 판본')));
  });

  it('지문이 같아도 판단 시점이 다르면 거절한다', () => {
    const outcome = matchesEvidenceSet(
      { ...boundResult(), prioritizerSnapshotId: `snap_${'c'.repeat(64)}` },
      HANDOFF,
    );
    assert.equal(outcome.valid, false);
    assert.ok(outcome.errors.some((error) => error.includes('판단 시점')));
  });

  it('지문이 다르면 거절한다', () => {
    const outcome = matchesEvidenceSet(
      { ...boundResult(), evidenceSetHash: `evset_${'0'.repeat(64)}` },
      HANDOFF,
    );
    assert.equal(outcome.valid, false);
    assert.ok(outcome.errors.some((error) => error.includes('근거 꾸러미에서 나온 것이 아닙니다')));
  });

  it('여기서 지문을 새로 계산하지 않는다', () => {
    const code = stripComments(read(BINDING));
    const body = code.split('export function matchesEvidenceSet(')[1];
    assert.equal(body.includes('crypto'), false);
    assert.equal(body.includes('computeBiblicalResearchEvidenceSetHash'), false);
  });
});
