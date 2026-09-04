/**
 * 연구 결과 보관 계약 · 테스트
 *
 * 실행: npm test
 *
 * 이 계약이 지켜야 할 것은 넷이다.
 *   1. 연구 내용은 이미 있는 검사기가 본다. 여기서 같은 규칙을 또 만들지 않는다.
 *   2. 연구 결과 안에 있는 값을 보관 기록에 또 적지 않는다.
 *   3. 근거 꾸러미가 사라진 뒤에도 무엇을 보고 나온 연구인지 확인할 수 있다.
 *   4. 사용자 이야기와 게시용 문구는 이 계층에 들어오지 못한다.
 *
 * fixture는 지어내지 않는다.
 *   자료 번호는 실제 함수(computeSourceId)로 만들고,
 *   근거 꾸러미 지문도 실제 함수로 계산한다.
 *   그래야 "시험에서만 통과하는 값"이 생기지 않는다.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import {
  FORBIDDEN_STORE_FIELDS,
  RESEARCH_RESULT_INSERT_FIELDS,
  RESEARCH_RESULT_PROVENANCE_FIELDS,
  RESEARCH_RESULT_HASH_FORMAT,
  computeResearchResultHash,
  validateResearchResultInsert,
  type ResearchResultProvenance,
} from '../../supabase/functions/_shared/research-result-store-contract.ts';
import {
  buildResearchBrief,
  type BiblicalResearchResult,
  type CandidatePassage,
  type SourceSupport,
} from '../../supabase/functions/_shared/biblical-researcher.ts';
import {
  computeBiblicalResearchEvidenceSetHash,
  type BiblicalResearchEvidenceSource,
} from '../../supabase/functions/_shared/biblical-research-handoff.ts';
import { computeSourceId } from '../../supabase/functions/_shared/source-harvester.ts';
import { getActiveCoveredDomains } from '../../supabase/functions/_shared/research-prioritizer-edge.ts';

/* ------------------------------------------------------------------ */
/* fixture                                                             */
/* ------------------------------------------------------------------ */

const activeCovered = getActiveCoveredDomains();
const SNAPSHOT = `snap_${'a'.repeat(64)}`;
const STATEMENT =
  '이 주석은 본문의 반복되는 자기 권면을 절망의 부정이 아니라 신뢰 회복의 움직임으로 읽는다.';

const url = (index: number) => `https://sources.example.org/aroeda/store-fixture-${index}`;

// 자료 번호는 주소에서 서버가 만든다. 시험에서도 지어내지 않고 같은 함수를 쓴다.
const SOURCE_IDS = await Promise.all([0, 1].map((index) => computeSourceId(url(index))));
const sourceId = (index: number) => SOURCE_IDS[index] as string;

const BRIEF = buildResearchBrief({
  targetDomain: 'financial_hardship',
  evidenceVersion: 4,
  prioritizerSnapshotId: SNAPSHOT,
  activeCoveredDomains: activeCovered,
});

const SOURCES: BiblicalResearchEvidenceSource[] = [
  {
    sourceId: sourceId(0),
    sourceType: 'commentary',
    title: '연구 자료 0',
    authorOrOrganization: '연구자 0',
    publisherOrInstitution: 'Fixture Academic Press',
    publicationYear: 2018,
    url: url(0),
    accessedAt: '2026-09-02',
    accessLevel: 'full_text',
    intendedUse: ['exegesis'],
    evidenceClaims: [
      {
        evidenceId: `${sourceId(0)}:e1`,
        intendedUse: 'exegesis',
        statement: `${STATEMENT} (0)`,
        passageReferences: [{ book: 'Psalms', chapter: 1, startVerse: 1, endVerse: 3 }],
      },
    ],
  },
  {
    sourceId: sourceId(1),
    sourceType: 'biblical_theology',
    title: '연구 자료 1',
    authorOrOrganization: '연구자 1',
    publisherOrInstitution: 'Fixture University Press',
    publicationYear: 2019,
    url: url(1),
    accessedAt: '2026-09-02',
    accessLevel: 'substantial_preview',
    intendedUse: ['biblical_theology', 'doctrinal_context'],
    evidenceClaims: [
      {
        evidenceId: `${sourceId(1)}:e1`,
        intendedUse: 'biblical_theology',
        statement: `${STATEMENT} (1)`,
        passageReferences: [],
      },
    ],
  },
] as BiblicalResearchEvidenceSource[];

const SOURCE_UNRESOLVED = ['이 영역의 사회적 배경을 더 확인해야 합니다.'];

const support = (): SourceSupport => ({
  exegesisEvidenceIds: [`${sourceId(0)}:e1`],
  theologyEvidenceIds: [`${sourceId(1)}:e1`],
  pastoralEvidenceIds: [],
  safetyEvidenceIds: [],
  exegesisSourceIds: [sourceId(0)],
  theologySourceIds: [sourceId(1)],
  pastoralSourceIds: [],
  safetySourceIds: [],
});

const candidate = (chapter: number): CandidatePassage => ({
  reference: { book: 'Psalms', chapter, startVerse: 1, endVerse: 3 },
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
});

const EVIDENCE_SET_HASH = await computeBiblicalResearchEvidenceSetHash({
  brief: BRIEF,
  sources: SOURCES,
  sourceUnresolvedQuestions: SOURCE_UNRESOLVED,
});

const result = (overrides: Partial<BiblicalResearchResult> = {}): BiblicalResearchResult => ({
  targetDomain: BRIEF.targetDomain,
  evidenceVersion: BRIEF.evidenceVersion,
  prioritizerSnapshotId: BRIEF.prioritizerSnapshotId,
  researchQuestion: '성경은 이 삶의 문제를 어떤 본문에서 직접 다루는가?',
  domainBoundaries: {
    includedConcerns: ['생계 압박'],
    excludedOrAdjacentConcerns: ['일반적인 미래 불안'],
  },
  candidatePassages: [candidate(1), candidate(2), candidate(3)],
  rejectedPassages: [
    {
      reference: { book: 'Proverbs', chapter: 3, startVerse: 5, endVerse: 6 },
      rejectionReason: '유명하지만 이 영역의 핵심 문제를 다루지 않습니다.',
      riskCategory: 'adjacent_domain_only',
    },
    {
      reference: { book: 'Proverbs', chapter: 4, startVerse: 5, endVerse: 6 },
      rejectionReason: '이 영역의 핵심 문제를 직접 다루지 않습니다.',
      riskCategory: 'adjacent_domain_only',
    },
  ],
  unresolvedQuestions: [],
  evidenceSetHash: EVIDENCE_SET_HASH,
  ...overrides,
});

const provenance = (
  overrides: Partial<ResearchResultProvenance> = {},
): ResearchResultProvenance => ({
  domainDescription: BRIEF.domainDescription,
  activeCoveredDomains: [...BRIEF.activeCoveredDomains],
  sources: SOURCES,
  sourceUnresolvedQuestions: [...SOURCE_UNRESOLVED],
  ...overrides,
});

/**
 * 보관 요청 한 건을 만든다.
 *
 * 지문은 마지막에 실린 연구 결과에서 계산한다.
 * 기본값에서 미리 계산해 두면, 연구 내용을 바꾼 시험이
 * 정작 보려던 규칙이 아니라 지문 검사에 걸려서 통과해 버린다.
 * 지문 자체를 시험할 때만 따로 지정한다.
 */
const insert = async (overrides: Record<string, unknown> = {}) => {
  const merged = {
    result: result(),
    provenance: provenance(),
    ...overrides,
  } as Record<string, unknown>;

  if (!('resultHash' in overrides)) {
    merged.resultHash = await computeResearchResultHash(merged.result as BiblicalResearchResult);
  }

  return merged;
};

/* ================================================================== */
/* A. 정상 보관                                                         */
/* ================================================================== */

describe('연구 결과 보관 · A. 정상 값', () => {
  it('제대로 된 연구 결과와 근거는 보관할 수 있다', async () => {
    const checked = await validateResearchResultInsert(await insert());
    assert.deepEqual(checked.errors, []);
    assert.equal(checked.valid, true);
  });

  it('보관할 때 넘기는 항목은 셋뿐이다', () => {
    assert.deepEqual([...RESEARCH_RESULT_INSERT_FIELDS], ['result', 'provenance', 'resultHash']);
  });

  it('번호와 시각은 넘기는 쪽이 정하지 않는다', async () => {
    // 부르는 쪽이 시각을 정하면 같은 연구가 서로 다른 시각으로 들어올 수 있다.
    for (const field of ['researchResultId', 'createdAt']) {
      const checked = await validateResearchResultInsert(await insert({ [field]: 'x' }));
      assert.equal(checked.valid, false, field);
      assert.ok(checked.errors.some((e) => e.includes(field)), field);
    }
  });
});

/* ================================================================== */
/* B. 지문                                                              */
/* ================================================================== */

describe('연구 결과 보관 · B. 지문', () => {
  it('같은 연구는 항상 같은 지문이 나온다', async () => {
    const a = await computeResearchResultHash(result());
    const b = await computeResearchResultHash(result());
    assert.equal(a, b);
    assert.match(a, RESEARCH_RESULT_HASH_FORMAT);
  });

  it('항목을 적은 순서가 달라도 같은 지문이 나온다', async () => {
    const normal = result();
    // 같은 내용을 항목 순서만 뒤집어 다시 만든다.
    const reordered = Object.fromEntries(
      Object.entries(normal).reverse(),
    ) as unknown as BiblicalResearchResult;

    assert.notEqual(JSON.stringify(normal), JSON.stringify(reordered));
    assert.equal(await computeResearchResultHash(reordered), await computeResearchResultHash(normal));
  });

  it('내용이 한 글자만 달라도 다른 지문이 나온다', async () => {
    const changed = result({ researchQuestion: '성경은 이 삶의 문제를 어떤 본문에서 다루는가?' });
    assert.notEqual(await computeResearchResultHash(changed), await computeResearchResultHash(result()));
  });

  it('본문 차례가 바뀌면 다른 연구로 본다', async () => {
    // 배열은 정렬하지 않는다. 연구에서는 순서가 뜻을 가진다.
    const reversed = result({ candidatePassages: [candidate(3), candidate(2), candidate(1)] });
    assert.notEqual(await computeResearchResultHash(reversed), await computeResearchResultHash(result()));
  });

  it('근거 꾸러미 지문과 헷갈리지 않게 앞머리가 다르다', async () => {
    const hash = await computeResearchResultHash(result());
    assert.ok(hash.startsWith('rres_'));
    assert.ok(EVIDENCE_SET_HASH.startsWith('evset_'));
  });

  it('내용과 맞지 않는 지문은 거절한다', async () => {
    const checked = await validateResearchResultInsert(
      await insert({ resultHash: `rres_${'b'.repeat(64)}` }),
    );
    assert.equal(checked.valid, false);
    assert.ok(checked.errors.some((e) => e.includes('지문이 내용과 맞지')));
  });

  it('모양이 틀린 지문은 모양이 틀렸다고 알린다', async () => {
    // 내용이 다른 것과 모양이 틀린 것은 고쳐야 할 것이 다르다.
    // 둘 다 "거절됨"으로만 끝나면 어디를 봐야 할지 알 수 없다.
    for (const bad of ['', 'rres_짧음', `evset_${'a'.repeat(64)}`, `rres_${'a'.repeat(63)}`]) {
      const checked = await validateResearchResultInsert(await insert({ resultHash: bad }));
      assert.equal(checked.valid, false, bad);
      assert.ok(
        checked.errors.some((e) => e.includes('지문의 모양이 맞지 않습니다')),
        bad,
      );
    }
  });
});

/* ================================================================== */
/* C. 근거가 사라져도 확인할 수 있다                                     */
/* ================================================================== */

describe('연구 결과 보관 · C. 근거 확인', () => {
  it('보관할 근거 항목은 넷뿐이다', () => {
    assert.deepEqual(
      [...RESEARCH_RESULT_PROVENANCE_FIELDS],
      ['domainDescription', 'activeCoveredDomains', 'sources', 'sourceUnresolvedQuestions'],
    );
  });

  it('근거 자료가 없으면 보관하지 않는다', async () => {
    // 번호만 남기고 자료를 버리면 나중에 아무것도 찾을 수 없다.
    const checked = await validateResearchResultInsert(
      await insert({ provenance: provenance({ sources: [] }) }),
    );
    assert.equal(checked.valid, false);
    assert.ok(checked.errors.some((e) => e.includes('근거 자료가 하나도 없습니다')));
  });

  it('근거를 나중에 손대면 지문이 맞지 않아 걸린다', async () => {
    // 이것이 이 계약의 핵심이다.
    // 꾸러미가 지워진 뒤라도, 보관된 근거가 그때 그 근거인지 다시 계산해서 확인한다.
    const tampered = SOURCES.map((source, index) =>
      index === 0
        ? {
            ...source,
            evidenceClaims: [{ ...source.evidenceClaims[0], statement: '조용히 바꾼 문장입니다.' }],
          }
        : source,
    ) as BiblicalResearchEvidenceSource[];

    const checked = await validateResearchResultInsert(
      await insert({ provenance: provenance({ sources: tampered }) }),
    );
    assert.equal(checked.valid, false);
    assert.ok(checked.errors.some((e) => e.includes('근거 지문과 맞지 않습니다')));
  });

  it('수집 단계의 남은 질문을 지워도 걸린다', async () => {
    const checked = await validateResearchResultInsert(
      await insert({ provenance: provenance({ sourceUnresolvedQuestions: [] }) }),
    );
    assert.equal(checked.valid, false);
    assert.ok(checked.errors.some((e) => e.includes('근거 지문과 맞지 않습니다')));
  });

  it('연구 당시 이미 다루던 영역을 바꿔도 걸린다', async () => {
    const checked = await validateResearchResultInsert(
      await insert({ provenance: provenance({ activeCoveredDomains: ['grief_loss'] }) }),
    );
    assert.equal(checked.valid, false);
  });

  it('영역 설명이 비어 있으면 보관하지 않는다', async () => {
    const checked = await validateResearchResultInsert(
      await insert({ provenance: provenance({ domainDescription: '   ' }) }),
    );
    assert.equal(checked.valid, false);
    assert.ok(checked.errors.some((e) => e.includes('영역 설명이 없습니다')));
  });
});

/* ================================================================== */
/* D. 같은 값을 두 곳에 두지 않는다                                      */
/* ================================================================== */

describe('연구 결과 보관 · D. 중복 금지', () => {
  it('연구 결과에 이미 있는 값을 근거 기록에 또 적지 않는다', () => {
    // 두 곳에 있으면 언젠가 서로 달라진다. 그때 어느 쪽이 진짜인지 알 수 없다.
    for (const field of [
      'targetDomain',
      'evidenceVersion',
      'prioritizerSnapshotId',
      'evidenceSetHash',
      'researchQuestion',
      'candidatePassages',
    ]) {
      assert.equal(
        (RESEARCH_RESULT_PROVENANCE_FIELDS as readonly string[]).includes(field),
        false,
        field,
      );
    }
  });

  it('근거 기록에 없는 항목을 넣으면 거절한다', async () => {
    const checked = await validateResearchResultInsert(
      await insert({
        provenance: { ...provenance(), targetDomain: 'financial_hardship' },
      }),
    );
    assert.equal(checked.valid, false);
    assert.ok(checked.errors.some((e) => e.includes('targetDomain')));
  });

  it('연구 내용 검사를 여기서 새로 만들지 않는다', () => {
    // 같은 규칙을 두 벌 만들면 언젠가 서로 달라진다. 이미 있는 검사기를 쓴다.
    const source = readSource();
    assert.ok(source.includes('validateBiblicalResearchResult'));
    assert.ok(source.includes('computeBiblicalResearchEvidenceSetHash'));
    // 연구 항목 이름을 여기서 다시 늘어놓지 않는다.
    assert.equal(source.includes('canonicalContext'), false);
    assert.equal(source.includes('researchConfidence'), false);
    assert.equal(source.includes('rejectionReason'), false);
  });
});

/* ================================================================== */
/* E. 이 계층에 오면 안 되는 것                                          */
/* ================================================================== */

describe('연구 결과 보관 · E. 넘어오면 안 되는 것', () => {
  it('사용자에게 보여줄 문구와 게시 상태는 받지 않는다', async () => {
    for (const field of ['userExplanation', 'prayerDirection', 'status', 'publishedAt']) {
      const checked = await validateResearchResultInsert(await insert({ [field]: '무엇이든' }));
      assert.equal(checked.valid, false, field);
    }
  });

  it('사용자의 이야기와 기도는 받지 않는다', async () => {
    // 이 연구는 카드를 만들기 위한 것이지 어떤 사람을 위한 것이 아니다.
    for (const field of ['situation', 'prayer', 'userId']) {
      const checked = await validateResearchResultInsert(await insert({ [field]: '무엇이든' }));
      assert.equal(checked.valid, false, field);
      assert.ok(checked.errors.some((e) => e.includes(field)), field);
    }
  });

  it('깊이 숨겨 넣어도 걸린다', async () => {
    const checked = await validateResearchResultInsert(
      await insert({
        provenance: {
          ...provenance(),
          sources: [{ ...SOURCES[0], situation: '오늘 너무 힘듭니다.' }, SOURCES[1]],
        },
      }),
    );
    assert.equal(checked.valid, false);
    assert.ok(checked.errors.some((e) => e.includes('situation')));
  });

  it('Scripture Card 번호를 여기서 붙이지 않는다', async () => {
    // 어느 카드로 만들지는 다음 계층(게시)에서 정한다.
    const checked = await validateResearchResultInsert(await insert({ scriptureCardId: 'SC-001' }));
    assert.equal(checked.valid, false);
  });

  it('막는 항목 목록이 조용히 줄지 않는다', () => {
    assert.deepEqual(
      [...FORBIDDEN_STORE_FIELDS],
      [
        'userExplanation',
        'prayerDirection',
        'status',
        'publishedAt',
        'reviewedAt',
        'scriptureCardId',
        'situation',
        'prayer',
        'userId',
      ],
    );
  });
});

/* ================================================================== */
/* F. 이상한 값에도 멈추지 않는다                                        */
/* ================================================================== */

describe('연구 결과 보관 · F. 이상한 값', () => {
  it('어떤 모양이 들어와도 예외를 던지지 않는다', async () => {
    const weird: unknown[] = [
      null,
      undefined,
      0,
      '',
      [],
      {},
      { result: null, provenance: null, resultHash: null },
      { result: [], provenance: [], resultHash: [] },
      { result: {}, provenance: { sources: [{}] }, resultHash: `rres_${'a'.repeat(64)}` },
    ];

    for (const value of weird) {
      const checked = await validateResearchResultInsert(value);
      assert.equal(checked.valid, false, JSON.stringify(value));
      assert.ok(checked.errors.length > 0, JSON.stringify(value));
    }
  });

  it('연구 내용이 어긋나면 거절한다', async () => {
    const checked = await validateResearchResultInsert(
      await insert({ result: result({ candidatePassages: [] }) }),
    );
    assert.equal(checked.valid, false);
  });
});

/** 계약 파일 원본. 규칙을 두 벌 만들지 않았는지 확인할 때만 쓴다. */
function readSource() {
  return readFileSync(
    new URL('../../supabase/functions/_shared/research-result-store-contract.ts', import.meta.url),
    'utf8',
  );
}
