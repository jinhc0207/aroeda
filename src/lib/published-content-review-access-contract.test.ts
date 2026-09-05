/**
 * 검토자 관리와 읽기 경계 · 테스트
 *
 * 실행: npm test
 *
 * 지키려는 것 여섯 가지.
 *
 *   1. 검토자를 늘리고 줄이는 일은 애플리케이션 기능이 아니다.
 *   2. 읽기도 승인과 같은 신분 경계를 쓴다. 로그인만으로는 부족하다.
 *   3. 목록은 고르는 자리다. 연구 근거를 담지 않는다.
 *   4. 꾸러미는 판단하는 자리다. 연구 근거를 담되 검토자만 본다.
 *   5. 읽는 것은 예약이 아니다. 최종 판단은 승인 함수의 몫이다.
 *   6. 읽는 길이 쓰는 길로 넘어가지 않는다.
 *
 * 여기서 확인하는 것 상당수는 "앞으로 만들 함수가 지켜야 할 약속"이다.
 * 지금 그 함수는 존재하지 않는다. 약속이 조용히 바뀌지 않게 못을 박는 것이다.
 *
 * fixture는 지어내지 않는다.
 *   자료 번호도, 근거 꾸러미 지문도, 연구 지문도, 글 지문도 실제 함수로 만든다.
 *   그래야 "시험에서만 통과하는 값"이 생기지 않는다.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import * as accessContract from '../../supabase/functions/_shared/published-content-review-access-contract.ts';
import {
  FORBIDDEN_PACKET_FIELDS,
  FORBIDDEN_QUEUE_FIELDS,
  FUTURE_READ_BOUNDARY,
  GET_PUBLISHED_CONTENT_REVIEW_PACKET_RPC,
  LIST_PUBLISHED_CONTENT_REVIEW_QUEUE_RPC,
  READ_BOUNDARY_LIMITATION,
  REVIEWER_BOOTSTRAP_STEPS,
  REVIEWER_MANAGEMENT_BOUNDARY,
  REVIEW_PACKET_FIELDS,
  REVIEW_QUEUE_ITEM_FIELDS,
  REVIEW_QUEUE_MAX_ITEMS,
  REVIEW_QUEUE_ORDER,
  buildReviewQueueItem,
  validatePublishedContentReviewPacket,
  validateReviewQueueItem,
} from '../../supabase/functions/_shared/published-content-review-access-contract.ts';
import {
  PUBLISHED_CONTENT_TABLES,
  REVIEW_PUBLISHED_CONTENT_CANDIDATE_RPC,
  type CandidateStoreRow,
} from '../../supabase/functions/_shared/published-content-store-contract.ts';
import {
  computePublishedContentCandidateHash,
  type PublishedContentCandidate,
} from '../../supabase/functions/_shared/published-content-contract.ts';
import {
  computeResearchResultHash,
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

const CONTRACT_PATH =
  '../../supabase/functions/_shared/published-content-review-access-contract.ts';
const CONTRACT_SOURCE = readFileSync(new URL(CONTRACT_PATH, import.meta.url), 'utf8');

/* ------------------------------------------------------------------ */
/* fixture · 연구 결과                                                  */
/* ------------------------------------------------------------------ */

const activeCovered = getActiveCoveredDomains();
const SNAPSHOT = `snap_${'b'.repeat(64)}`;
const STATEMENT =
  '이 주석은 본문의 반복되는 자기 권면을 절망의 부정이 아니라 신뢰 회복의 움직임으로 읽는다.';

const url = (index: number) => `https://sources.example.org/aroeda/review-access-fixture-${index}`;

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

const passageDraft = (chapter: number): CandidatePassage => ({
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

const researchResult = (
  overrides: Partial<BiblicalResearchResult> = {},
): BiblicalResearchResult => ({
  targetDomain: BRIEF.targetDomain,
  evidenceVersion: BRIEF.evidenceVersion,
  prioritizerSnapshotId: BRIEF.prioritizerSnapshotId,
  researchQuestion: '성경은 이 삶의 문제를 어떤 본문에서 직접 다루는가?',
  domainBoundaries: {
    includedConcerns: ['생계 압박'],
    excludedOrAdjacentConcerns: ['일반적인 미래 불안'],
  },
  candidatePassages: [passageDraft(1), passageDraft(2), passageDraft(3)],
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

// 연구 지문은 실제 함수로 계산한다. 지어낸 값을 쓰면 지문 검사가 의미를 잃는다.
const RESEARCH_HASH = await computeResearchResultHash(researchResult());

/* ------------------------------------------------------------------ */
/* fixture · 검토 대상 글                                               */
/* ------------------------------------------------------------------ */

const candidate = (
  overrides: Partial<PublishedContentCandidate> = {},
): PublishedContentCandidate => ({
  researchResultHash: RESEARCH_HASH,
  targetDomain: 'financial_hardship',
  passage: { book: 'Psalms', chapter: 1, startVerse: 1, endVerse: 3 },
  additionalPassages: [],
  referenceLabel: '시편 1:1–3',
  situationTags: ['생계가 흔들림'],
  emotionTags: ['막막함'],
  spiritualQuestionTags: ['하나님의 돌보심'],
  prayerModes: ['간구'],
  pastoralFunction: ['위로'],
  contextSummary: '이 본문이 놓인 흐름을 짧게 정리한 내부 설명입니다.',
  theologicalInsight: '이 본문이 붙드는 신학적 중심을 한 문장으로 적은 것입니다.',
  userExplanation: '지금 형편이 막막할 때 이 말씀이 무엇을 말하는지 쉬운 말로 설명합니다.',
  prayerDirection: '이 말씀을 붙들고 무엇을 아뢸 수 있는지 방향을 짧게 안내합니다.',
  misuseGuards: ['형편이 곧 나아진다는 약속으로 읽지 않는다.'],
  ...overrides,
});

const CANDIDATE_HASH = await computePublishedContentCandidateHash(candidate());

const CANDIDATE_CREATED_AT = '2026-09-05T16:36:54.000Z';
const RESEARCH_CREATED_AT = '2026-09-05T09:04:18.000Z';

const storedRow = (): CandidateStoreRow => ({
  candidateHash: CANDIDATE_HASH,
  researchResultHash: RESEARCH_HASH,
  candidate: candidate(),
  createdAt: CANDIDATE_CREATED_AT,
});

/**
 * 검토 꾸러미 한 건을 만든다.
 *
 * 지문은 마지막에 실린 내용에서 계산한다.
 * 기본값에서 미리 계산해 두면, 내용을 바꾼 시험이
 * 정작 보려던 규칙이 아니라 지문 검사에 걸려서 통과해 버린다.
 */
const packet = async (overrides: Record<string, unknown> = {}) => {
  const merged = {
    candidate: candidate(),
    candidateCreatedAt: CANDIDATE_CREATED_AT,
    researchResult: researchResult(),
    researchProvenance: provenance(),
    researchResultCreatedAt: RESEARCH_CREATED_AT,
    ...overrides,
  } as Record<string, unknown>;

  if (!('researchResultHash' in overrides)) {
    merged.researchResultHash = await computeResearchResultHash(
      merged.researchResult as BiblicalResearchResult,
    );
  }
  if (!('candidateHash' in overrides)) {
    merged.candidateHash = await computePublishedContentCandidateHash(
      merged.candidate as PublishedContentCandidate,
    );
  }

  return merged;
};

const queueItem = (overrides: Record<string, unknown> = {}) => ({
  ...buildReviewQueueItem(storedRow()),
  ...overrides,
});

/* ================================================================== */
/* A. 검토자 관리 경계                                                  */
/* ================================================================== */

describe('읽기 경계 · A. 검토자 관리', () => {
  it('검토자 관리는 운영자만 한다', () => {
    assert.equal(REVIEWER_MANAGEMENT_BOUNDARY.reviewerManagementMode, 'operator_only');
  });

  it('검토자를 관리하는 애플리케이션 함수를 만들지 않는다', () => {
    assert.equal(REVIEWER_MANAGEMENT_BOUNDARY.applicationManagementRpc, false);
  });

  it('로그인한 사람은 검토자를 관리할 수 없다', () => {
    assert.equal(REVIEWER_MANAGEMENT_BOUNDARY.authenticatedCanManageReviewers, false);
  });

  it('서버 열쇠도 검토자를 관리할 수 없다', () => {
    // 자동화가 스스로 검토자를 만들면 사람의 승인 경계가 의미를 잃는다.
    assert.equal(REVIEWER_MANAGEMENT_BOUNDARY.serviceRoleCanManageReviewers, false);
  });

  it('로그인하지 않은 쪽과 화면도 검토자를 관리할 수 없다', () => {
    assert.equal(REVIEWER_MANAGEMENT_BOUNDARY.anonCanManageReviewers, false);
    assert.equal(REVIEWER_MANAGEMENT_BOUNDARY.clientCanManageReviewers, false);
  });

  it('가입했다고 검토자가 되지 않는다', () => {
    assert.equal(REVIEWER_MANAGEMENT_BOUNDARY.automaticReviewerPromotion, false);
  });

  it('검토자를 미리 넣어 두지 않는다', () => {
    assert.equal(REVIEWER_MANAGEMENT_BOUNDARY.seedReviewer, false);
  });

  it('켤 때는 실제 인증 사용자인지 확인하고 명시적 승인을 받는다', () => {
    assert.equal(REVIEWER_MANAGEMENT_BOUNDARY.activationRequiresExistingAuthUser, true);
    assert.equal(REVIEWER_MANAGEMENT_BOUNDARY.activationRequiresExplicitOperatorApproval, true);
  });

  it('뺄 때는 줄을 지우지 않고 꺼 둔다', () => {
    assert.equal(REVIEWER_MANAGEMENT_BOUNDARY.deactivationUsesIsActiveFalse, true);
  });

  it('고칠 수 있는 표는 검토자 명단 하나뿐이다', () => {
    assert.equal(REVIEWER_MANAGEMENT_BOUNDARY.managedTable, PUBLISHED_CONTENT_TABLES.reviewer);
  });

  it('첫 검토자 등록 순서가 세 단계로 적혀 있다', () => {
    assert.equal(REVIEWER_BOOTSTRAP_STEPS.length, 3);
    assert.ok(REVIEWER_BOOTSTRAP_STEPS[0]?.includes('인증 사용자'));
    assert.ok(REVIEWER_BOOTSTRAP_STEPS[1]?.includes('승인'));
  });

  it('인증 표를 가리키지 않는 것과 켤 때 확인하는 것을 구분해 적었다', () => {
    assert.ok(accessContract.REVIEWER_AUTH_USER_RULE.includes('auth.users'));
    assert.ok(accessContract.REVIEWER_AUTH_USER_RULE.includes('켜는 시점'));
  });

  it('명단이 변경 이력을 남기지 않는다는 한계를 적어 두었다', () => {
    assert.ok(accessContract.REVIEWER_REGISTRY_AUDIT_LIMITATION.includes('이력'));
  });

  it('검토자를 만들거나 켜고 끄는 함수를 내보내지 않는다', () => {
    // 이 파일이 내보내는 함수는 정확히 셋뿐이다.
    // 새 write helper가 조용히 늘어나면 여기서 걸린다.
    const exportedFunctions = Object.entries(accessContract)
      .filter(([, value]) => typeof value === 'function')
      .map(([name]) => name)
      .sort();

    assert.deepEqual(exportedFunctions, [
      'buildReviewQueueItem',
      'validatePublishedContentReviewPacket',
      'validateReviewQueueItem',
    ]);
  });
});

/* ================================================================== */
/* B. 읽기 권한                                                         */
/* ================================================================== */

describe('읽기 경계 · B. 읽기 권한', () => {
  it('앞으로 만들 읽기 함수는 둘이다', () => {
    assert.equal(FUTURE_READ_BOUNDARY.queueRpc, LIST_PUBLISHED_CONTENT_REVIEW_QUEUE_RPC);
    assert.equal(FUTURE_READ_BOUNDARY.packetRpc, GET_PUBLISHED_CONTENT_REVIEW_PACKET_RPC);
    assert.equal(LIST_PUBLISHED_CONTENT_REVIEW_QUEUE_RPC, 'list_published_content_review_queue');
    assert.equal(GET_PUBLISHED_CONTENT_REVIEW_PACKET_RPC, 'get_published_content_review_packet');
  });

  it('로그인한 사람만 부를 수 있다', () => {
    assert.equal(FUTURE_READ_BOUNDARY.authenticatedExecute, true);
  });

  it('서버 열쇠로는 읽을 수 없다', () => {
    // 승인과 같은 경계다. 읽기만 열어 두면 검토 전 글이 밖으로 나가는 길이 생긴다.
    assert.equal(FUTURE_READ_BOUNDARY.serviceRoleExecute, false);
  });

  it('로그인하지 않은 쪽과 모두에게 열린 권한은 없다', () => {
    assert.equal(FUTURE_READ_BOUNDARY.anonExecute, false);
    assert.equal(FUTURE_READ_BOUNDARY.publicExecute, false);
  });

  it('누가 부르는지는 인증 문맥에서 읽는다', () => {
    assert.equal(FUTURE_READ_BOUNDARY.identitySource, 'auth.uid()');
  });

  it('로그인만으로는 부족하고 명단에 켜져 있어야 한다', () => {
    assert.equal(FUTURE_READ_BOUNDARY.activeReviewerRequired, true);
  });

  it('표를 직접 읽게 하지 않는다', () => {
    assert.equal(FUTURE_READ_BOUNDARY.directTableRead, false);
  });

  it('화면에 서버 열쇠를 두지 않는다', () => {
    assert.equal(FUTURE_READ_BOUNDARY.serviceRoleClientUse, false);
  });

  it('쓰기 경계와 같은 신분 규칙을 쓴다', () => {
    // 읽기와 쓰기가 다른 신분 규칙을 쓰면 경계가 둘로 갈라진다.
    assert.equal(FUTURE_READ_BOUNDARY.identitySource, 'auth.uid()');
    assert.equal(FUTURE_READ_BOUNDARY.activeReviewerRequired, true);
    assert.equal(FUTURE_READ_BOUNDARY.serviceRoleExecute, false);
  });
});

/* ================================================================== */
/* C. 목록                                                              */
/* ================================================================== */

describe('읽기 경계 · C. 목록', () => {
  it('아직 결정이 없는 글만 나온다', () => {
    assert.equal(FUTURE_READ_BOUNDARY.queuePendingOnly, true);
  });

  it('진행 상태 칸을 만들지 않고 두 표에서 읽어 낸다', () => {
    assert.ok(accessContract.PENDING_DERIVATION.includes('진행 상태 칸을 두지 않는다'));
  });

  it('한 번에 가져올 수 있는 건수가 정해져 있다', () => {
    assert.equal(REVIEW_QUEUE_MAX_ITEMS, 50);
    assert.equal(FUTURE_READ_BOUNDARY.maxQueueItems, 50);
  });

  it('순서가 정해져 있다', () => {
    // 두 번째 기준이 없으면 같은 시각의 글 순서가 호출마다 달라질 수 있다.
    assert.deepEqual([...REVIEW_QUEUE_ORDER], ['created_at asc', 'candidate_hash asc']);
  });

  it('목록 한 줄의 항목은 여섯뿐이다', () => {
    assert.deepEqual(
      [...REVIEW_QUEUE_ITEM_FIELDS],
      [
        'candidateHash',
        'researchResultHash',
        'targetDomain',
        'referenceLabel',
        'passage',
        'candidateCreatedAt',
      ],
    );
  });

  it('적혀 있는 글에서 목록 한 줄을 만든다', () => {
    const item = buildReviewQueueItem(storedRow());
    assert.deepEqual(Object.keys(item).sort(), [...REVIEW_QUEUE_ITEM_FIELDS].sort());
    assert.equal(item.candidateHash, CANDIDATE_HASH);
    assert.equal(item.researchResultHash, RESEARCH_HASH);
    assert.equal(item.referenceLabel, '시편 1:1–3');
    assert.equal(item.candidateCreatedAt, CANDIDATE_CREATED_AT);
  });

  it('제대로 된 목록 한 줄은 통과한다', () => {
    const checked = validateReviewQueueItem(queueItem());
    assert.deepEqual(checked.errors, []);
    assert.equal(checked.valid, true);
  });

  it('연구 결과 전체는 목록에 올 수 없다', () => {
    const checked = validateReviewQueueItem(queueItem({ researchResult: researchResult() }));
    assert.equal(checked.valid, false);
    assert.ok(checked.errors.some((e) => e.includes('목록에 올 수 없는 항목입니다')));
  });

  it('근거 기록과 자료는 목록에 올 수 없다', () => {
    for (const field of ['researchProvenance', 'provenance', 'sources', 'evidenceSetHash']) {
      const checked = validateReviewQueueItem(queueItem({ [field]: 'x' }));
      assert.equal(checked.valid, false, field);
      assert.ok(
        checked.errors.some((e) => e.includes('목록에 올 수 없는 항목입니다')),
        field,
      );
    }
  });

  it('검토자 신분은 목록에 올 수 없다', () => {
    for (const field of ['reviewerUserId', 'currentReviewerId', 'email']) {
      const checked = validateReviewQueueItem(queueItem({ [field]: 'x' }));
      assert.equal(checked.valid, false, field);
      assert.ok(
        checked.errors.some((e) => e.includes('목록에 올 수 없는 항목입니다')),
        field,
      );
    }
  });

  it('사람의 이야기는 목록에 올 수 없다', () => {
    for (const field of ['situation', 'prayer', 'sessionId', 'deviceId']) {
      const checked = validateReviewQueueItem(queueItem({ [field]: 'x' }));
      assert.equal(checked.valid, false, field);
      assert.ok(
        checked.errors.some((e) => e.includes('목록에 올 수 없는 항목입니다')),
        field,
      );
    }
  });

  it('모양이 어긋난 값은 받지 않는다', () => {
    const cases: Array<[string, unknown]> = [
      ['candidateHash', 'pcand_짧음'],
      ['researchResultHash', 'rres_짧음'],
      ['targetDomain', '  '],
      ['referenceLabel', ''],
      ['passage', { book: 'Psalms', chapter: '1', startVerse: 1, endVerse: 3 }],
      ['candidateCreatedAt', '어제'],
    ];
    for (const [field, value] of cases) {
      const checked = validateReviewQueueItem(queueItem({ [field]: value }));
      assert.equal(checked.valid, false, field);
    }
  });

  it('빠진 항목이 있으면 받지 않는다', () => {
    const item = queueItem() as Record<string, unknown>;
    delete item.referenceLabel;
    const checked = validateReviewQueueItem(item);
    assert.equal(checked.valid, false);
    assert.ok(checked.errors.some((e) => e.includes('빠진 항목입니다')));
  });

  it('객체가 아니면 예외를 던지지 않고 막는다', () => {
    for (const value of [null, undefined, 'x', 3, []]) {
      const checked = validateReviewQueueItem(value);
      assert.equal(checked.valid, false);
    }
  });
});

/* ================================================================== */
/* D. 검토 꾸러미                                                       */
/* ================================================================== */

describe('읽기 경계 · D. 검토 꾸러미', () => {
  it('아직 결정이 없는 글에만 준다', () => {
    assert.equal(FUTURE_READ_BOUNDARY.packetPendingOnly, true);
  });

  it('꾸러미의 항목은 일곱뿐이다', () => {
    assert.deepEqual(
      [...REVIEW_PACKET_FIELDS],
      [
        'candidateHash',
        'candidate',
        'candidateCreatedAt',
        'researchResultHash',
        'researchResult',
        'researchProvenance',
        'researchResultCreatedAt',
      ],
    );
  });

  it('제대로 된 꾸러미는 통과한다', async () => {
    const checked = await validatePublishedContentReviewPacket(await packet());
    assert.deepEqual(checked.errors, []);
    assert.equal(checked.valid, true);
  });

  it('글 지문이 글 내용과 다르면 막는다', async () => {
    const other = await computePublishedContentCandidateHash(
      candidate({ referenceLabel: '시편 1:1–2' }),
    );
    const checked = await validatePublishedContentReviewPacket(
      await packet({ candidateHash: other }),
    );
    assert.equal(checked.valid, false);
  });

  it('연구 지문이 연구 내용과 다르면 막는다', async () => {
    const other = await computeResearchResultHash(
      researchResult({ researchQuestion: '다른 연구 질문입니다. 성경은 무엇을 말하는가?' }),
    );
    // 글 안의 지문도 함께 맞춰서, 지문이 서로 다른 것이 아니라
    // "다시 계산한 값과 다르다"는 것만 남긴다.
    const checked = await validatePublishedContentReviewPacket(
      await packet({
        researchResultHash: other,
        candidate: candidate({ researchResultHash: other }),
      }),
    );
    assert.equal(checked.valid, false);
  });

  it('글이 가리키는 연구와 꾸러미의 연구가 다르면 막는다', async () => {
    const checked = await validatePublishedContentReviewPacket(
      await packet({ candidate: candidate({ researchResultHash: `rres_${'c'.repeat(64)}` }) }),
    );
    assert.equal(checked.valid, false);
  });

  it('근거 기록이 없으면 막는다', async () => {
    const value = (await packet()) as Record<string, unknown>;
    delete value.researchProvenance;
    const checked = await validatePublishedContentReviewPacket(value);
    assert.equal(checked.valid, false);
    assert.ok(checked.errors.some((e) => e.includes('빠진 항목입니다')));
  });

  it('근거 기록이 비어 있으면 막는다', async () => {
    const checked = await validatePublishedContentReviewPacket(
      await packet({ researchProvenance: provenance({ sources: [] }) }),
    );
    assert.equal(checked.valid, false);
  });

  it('시각의 모양이 어긋나면 막는다', async () => {
    for (const field of ['candidateCreatedAt', 'researchResultCreatedAt']) {
      const checked = await validatePublishedContentReviewPacket(
        await packet({ [field]: '어제' }),
      );
      assert.equal(checked.valid, false, field);
      assert.ok(checked.errors.some((e) => e.includes('시각의 모양')), field);
    }
  });

  it('계약에 없는 항목이 있으면 막는다', async () => {
    const checked = await validatePublishedContentReviewPacket(
      await packet({ publishedAt: '2026-09-05T16:36:54.000Z' }),
    );
    assert.equal(checked.valid, false);
    assert.ok(checked.errors.some((e) => e.includes('검토 꾸러미에 없는 항목입니다')));
  });

  it('객체가 아니면 예외를 던지지 않고 막는다', async () => {
    for (const value of [null, undefined, 'x', 3, []]) {
      const checked = await validatePublishedContentReviewPacket(value);
      assert.equal(checked.valid, false);
    }
  });
});

/* ================================================================== */
/* E. 근거의 자리                                                       */
/* ================================================================== */

describe('읽기 경계 · E. 근거의 자리', () => {
  it('꾸러미에는 자료와 근거가 들어간다', async () => {
    // 사람이 "연구까지 되짚을 수 있는가"를 판단하려면 자료를 보아야 한다.
    const value = await packet();
    const prov = value.researchProvenance as ResearchResultProvenance;
    assert.ok(prov.sources.length > 0);
    assert.ok(prov.sourceUnresolvedQuestions.length > 0);

    const checked = await validatePublishedContentReviewPacket(value);
    assert.equal(checked.valid, true);
  });

  it('자료는 꾸러미에서 막지 않는다', () => {
    assert.equal((FORBIDDEN_PACKET_FIELDS as readonly string[]).includes('sources'), false);
  });

  it('자료는 목록에서 막는다', () => {
    assert.equal((FORBIDDEN_QUEUE_FIELDS as readonly string[]).includes('sources'), true);
  });

  it('검토자만 보는 근거라는 것을 적어 두었다', () => {
    assert.ok(accessContract.REVIEWER_ONLY_EVIDENCE_NOTE.includes('검토자만'));
    assert.ok(accessContract.REVIEWER_ONLY_EVIDENCE_NOTE.includes('사용자 화면'));
  });

  it('승인된 글에는 자료를 옮기지 않는다는 앞 계약이 그대로다', async () => {
    // 이 계약은 앞 계약의 금지 목록을 느슨하게 만들지 않는다.
    const { FORBIDDEN_CANDIDATE_FIELDS } = await import(
      '../../supabase/functions/_shared/published-content-contract.ts'
    );
    for (const field of ['sources', 'evidenceIds', 'url']) {
      assert.equal(
        (FORBIDDEN_CANDIDATE_FIELDS as readonly string[]).includes(field),
        true,
        field,
      );
    }
  });
});

/* ================================================================== */
/* F. 동시에 열었을 때                                                  */
/* ================================================================== */

describe('읽기 경계 · F. 동시에 열었을 때', () => {
  it('읽는 것은 예약이 아니다', () => {
    assert.equal(FUTURE_READ_BOUNDARY.readCreatesReservation, false);
  });

  it('읽는 동안 그 글을 붙잡지 않는다', () => {
    assert.equal(FUTURE_READ_BOUNDARY.readLocksCandidate, false);
  });

  it('최종 판단은 기존 승인 함수의 몫이다', () => {
    assert.equal(
      FUTURE_READ_BOUNDARY.finalWriteAuthority,
      REVIEW_PUBLISHED_CONTENT_CANDIDATE_RPC,
    );
  });

  it('두 사람이 같은 글을 열 수 있다는 것을 적어 두었다', () => {
    assert.ok(accessContract.REVIEW_READ_RACE_NOTE.includes('예약이 아니다'));
  });
});

/* ================================================================== */
/* G. 사람의 이야기                                                     */
/* ================================================================== */

describe('읽기 경계 · G. 사람의 이야기', () => {
  it('사용자의 상황과 기도는 꾸러미에 올 수 없다', async () => {
    for (const field of ['situation', 'rawSituation', 'prayer', 'prayerDraft']) {
      const checked = await validatePublishedContentReviewPacket(
        await packet({ [field]: '어떤 값' }),
      );
      assert.equal(checked.valid, false, field);
      assert.ok(
        checked.errors.some((e) => e.includes('검토 꾸러미에 올 수 없는 항목입니다')),
        field,
      );
    }
  });

  it('식별에 쓰일 값은 꾸러미에 올 수 없다', async () => {
    for (const field of ['userId', 'sessionId', 'deviceId', 'jwt', 'apiKey', 'email']) {
      const checked = await validatePublishedContentReviewPacket(
        await packet({ [field]: '어떤 값' }),
      );
      assert.equal(checked.valid, false, field);
      assert.ok(
        checked.errors.some((e) => e.includes('검토 꾸러미에 올 수 없는 항목입니다')),
        field,
      );
    }
  });

  it('검토자 신분은 꾸러미에 올 수 없다', async () => {
    for (const field of ['reviewerUserId', 'reviewerId', 'currentReviewerId']) {
      const checked = await validatePublishedContentReviewPacket(
        await packet({ [field]: '어떤 값' }),
      );
      assert.equal(checked.valid, false, field);
      assert.ok(
        checked.errors.some((e) => e.includes('검토 꾸러미에 올 수 없는 항목입니다')),
        field,
      );
    }
  });

  it('제대로 된 꾸러미에는 금지된 이름이 하나도 없다', async () => {
    const serialized = JSON.stringify(await packet()) ?? '';
    for (const field of FORBIDDEN_PACKET_FIELDS) {
      assert.equal(serialized.includes(`"${field}":`), false, field);
    }
  });
});

/* ================================================================== */
/* H. 읽는 길에서 쓰는 길로 넘어가지 않는다                             */
/* ================================================================== */

describe('읽기 경계 · H. 읽기와 쓰기', () => {
  it('꾸러미는 결정을 담지 않는다', async () => {
    for (const field of ['decision', 'checklist', 'rejectionReasons']) {
      const checked = await validatePublishedContentReviewPacket(
        await packet({ [field]: 'approve' }),
      );
      assert.equal(checked.valid, false, field);
      assert.ok(
        checked.errors.some((e) => e.includes('검토 꾸러미에 올 수 없는 항목입니다')),
        field,
      );
    }
  });

  it('승인을 기본값으로 두지 않는다는 것을 적어 두었다', () => {
    assert.ok(accessContract.NO_READ_TO_WRITE_ESCALATION.includes('기본값'));
  });

  it('결정을 만드는 함수를 내보내지 않는다', () => {
    for (const name of ['decision', 'approve', 'reject', 'review']) {
      const matched = Object.entries(accessContract).filter(
        ([key, value]) => typeof value === 'function' && key.toLowerCase().startsWith(name),
      );
      assert.deepEqual(matched, [], name);
    }
  });
});

/* ================================================================== */
/* I. 한계를 적어 두었는가                                              */
/* ================================================================== */

describe('읽기 경계 · I. 한계', () => {
  it('무엇을 지키는지 적어 두었다', () => {
    assert.ok(READ_BOUNDARY_LIMITATION.guarantees.includes('권한'));
  });

  it('무엇을 지키지 못하는지도 적어 두었다', () => {
    const text = READ_BOUNDARY_LIMITATION.doesNotGuarantee.join(' ');
    assert.ok(READ_BOUNDARY_LIMITATION.doesNotGuarantee.length >= 5);
    assert.ok(text.includes('관리자'));
    assert.ok(text.includes('빼앗겼을 때'));
    assert.ok(text.includes('물리적 증명'));
  });

  it('막을 수 없는 것을 막는다고 적지 않았다', () => {
    // "절대", "완전히" 같은 말로 보장 범위를 부풀리지 않는다.
    for (const line of CONTRACT_SOURCE.split('\n')) {
      if (!line.includes('절대') && !line.includes('완전히')) continue;
      assert.ok(
        line.includes('않는다') || line.includes('아니다') || line.includes('뜻이 아니다'),
        line,
      );
    }
  });
});

/* ================================================================== */
/* J. 순수 계약인가                                                     */
/* ================================================================== */

describe('읽기 경계 · J. 순수 계약', () => {
  it('바깥과 이야기하지 않는다', () => {
    for (const banned of [
      'Deno.env',
      'process.env',
      'fetch(',
      'createClient',
      'XMLHttpRequest',
      'WebSocket',
    ]) {
      assert.equal(CONTRACT_SOURCE.includes(banned), false, banned);
    }
  });

  it('부를 때마다 같은 답을 낸다', () => {
    for (const banned of ['Date.now', 'randomUUID', 'Math.random', 'new Date(']) {
      assert.equal(CONTRACT_SOURCE.includes(banned), false, banned);
    }
  });

  it('SQL을 적지 않는다', () => {
    for (const banned of ['create table', 'create function', 'security definer', 'select 1']) {
      assert.equal(CONTRACT_SOURCE.toLowerCase().includes(banned), false, banned);
    }
  });

  it('화면 코드와 모델을 가져오지 않는다', () => {
    // 어디서 가져오는지만 본다. 글자만 보면 export 안의 expo 같은 것에 걸린다.
    const specifiers = [...CONTRACT_SOURCE.matchAll(/from '([^']+)'/g)].map((m) => m[1] as string);
    assert.ok(specifiers.length > 0);

    for (const banned of ['react', 'expo', 'openai']) {
      assert.equal(
        specifiers.some((path) => path.toLowerCase().includes(banned)),
        false,
        banned,
      );
    }

    // 가져오는 곳은 모두 같은 저장소의 계약 파일이다.
    for (const path of specifiers) {
      assert.ok(path.startsWith('./'), path);
    }
  });

  it('지문을 새로 만들지 않는다', () => {
    // 지문 계산의 주인은 앞 계약들이다. 여기서 두 번째 구현을 만들면 언젠가 서로 달라진다.
    for (const banned of ['crypto', 'digest', 'SHA-256', 'stableStringify']) {
      assert.equal(CONTRACT_SOURCE.includes(banned), false, banned);
    }
  });

  it('이미 있는 검사기를 그대로 쓴다', () => {
    assert.ok(CONTRACT_SOURCE.includes('validateCandidateStoreInput'));
    assert.ok(CONTRACT_SOURCE.includes('validateResearchResultInsert'));
  });

  it('같은 타입을 다시 만들지 않는다', () => {
    // 글, 연구 결과, 근거 기록, 본문 위치는 모두 남의 타입을 가져다 쓴다.
    for (const name of [
      'PublishedContentCandidate',
      'BiblicalResearchResult',
      'ResearchResultProvenance',
      'PassageRef',
    ]) {
      assert.equal(CONTRACT_SOURCE.includes(`type ${name} =`), false, name);
      assert.ok(CONTRACT_SOURCE.includes(name), name);
    }
  });
});
