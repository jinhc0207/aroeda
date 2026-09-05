/**
 * 게시 콘텐츠 계약 · 테스트
 *
 * 실행: npm test
 *
 * 지키려는 것 다섯 가지.
 *
 *   1. 연구 결과만으로 게시할 수 없다. 사람의 승인이 반드시 있어야 한다.
 *   2. 승인한 뒤 글을 고치면 그 승인은 더 이상 쓸 수 없다.
 *   3. 연구가 후보로 올리지 않은 본문을 편집 단계에서 끼워 넣을 수 없다.
 *   4. 새 태그는 사람의 판단으로 들어올 수 있지만, 새 영역 이름은 안 된다.
 *   5. 사용자 이야기와 자료 정보는 이 계층에 오지 않는다.
 *
 * fixture는 실제 함수로 만든다.
 *   연구 지문도, 글 지문도 계약의 함수로 계산한다.
 *   손으로 적은 값을 쓰면 "시험에서만 맞는 값"이 생긴다.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import {
  CANDIDATE_FIELDS,
  CANDIDATE_HASH_FORMAT,
  FORBIDDEN_CANDIDATE_FIELDS,
  REJECTION_REASONS,
  REVIEW_AUTHORITIES,
  REVIEW_CHECKS,
  REVIEW_DECISIONS,
  computePublishedContentCandidateHash,
  publishReviewedContent,
  validatePublishedContentCandidate,
  validatePublishedContentReview,
  type PublishedContentCandidate,
  type PublishedContentReview,
} from '../../supabase/functions/_shared/published-content-contract.ts';
import { computeResearchResultHash } from '../../supabase/functions/_shared/research-result-store-contract.ts';
import type {
  BiblicalResearchResult,
  CandidatePassage,
  SourceSupport,
} from '../../supabase/functions/_shared/biblical-researcher.ts';
import { RESEARCHABLE_DOMAINS } from '../../supabase/functions/_shared/research-prioritizer-contract.ts';
import { TAXONOMY } from '../../supabase/functions/_shared/analysis-taxonomy.ts';

const CONTRACT_PATH = '../../supabase/functions/_shared/published-content-contract.ts';
const CONTRACT_SOURCE = readFileSync(new URL(CONTRACT_PATH, import.meta.url), 'utf8');

/* ------------------------------------------------------------------ */
/* fixture                                                             */
/* ------------------------------------------------------------------ */

const DOMAIN = 'financial_hardship';
const SNAPSHOT = `snap_${'a'.repeat(64)}`;

const support = (): SourceSupport => ({
  exegesisEvidenceIds: ['src-1:e1'],
  theologyEvidenceIds: ['src-2:e1'],
  pastoralEvidenceIds: [],
  safetyEvidenceIds: [],
  exegesisSourceIds: ['src-1'],
  theologySourceIds: ['src-2'],
  pastoralSourceIds: [],
  safetySourceIds: [],
});

const passageOf = (chapter: number) => ({
  book: 'Psalms',
  chapter,
  startVerse: 1,
  endVerse: 3,
});

const candidatePassage = (chapter: number, extra: number[] = []): CandidatePassage => ({
  reference: passageOf(chapter),
  additionalReferences: extra.map((c) => passageOf(c)),
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

const RESEARCH: BiblicalResearchResult = {
  targetDomain: DOMAIN,
  evidenceVersion: 4,
  prioritizerSnapshotId: SNAPSHOT,
  researchQuestion: '성경은 이 삶의 문제를 어떤 본문에서 직접 다루는가?',
  domainBoundaries: {
    includedConcerns: ['생계 압박'],
    excludedOrAdjacentConcerns: ['일반적인 미래 불안'],
  },
  candidatePassages: [candidatePassage(1), candidatePassage(2, [3]), candidatePassage(4)],
  rejectedPassages: [],
  unresolvedQuestions: [],
  evidenceSetHash: `evset_${'a'.repeat(64)}`,
};

const RESEARCH_HASH = await computeResearchResultHash(RESEARCH);

const candidate = (
  overrides: Partial<PublishedContentCandidate> = {},
): PublishedContentCandidate => ({
  researchResultHash: RESEARCH_HASH,
  targetDomain: DOMAIN,
  passage: passageOf(1),
  additionalPassages: [],
  referenceLabel: '시편 1:1–3',
  situationTags: ['생계가 흔들림', '수입이 끊김'],
  emotionTags: ['막막함', '불안'],
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

const checklist = (overrides: Partial<Record<string, boolean>> = {}) =>
  Object.fromEntries(
    REVIEW_CHECKS.map((check) => [check, overrides[check] ?? true]),
  ) as PublishedContentReview['checklist'];

const review = async (
  target: PublishedContentCandidate,
  overrides: Partial<PublishedContentReview> = {},
): Promise<PublishedContentReview> => ({
  candidateHash: await computePublishedContentCandidateHash(target),
  reviewAuthority: 'human',
  decision: 'approve',
  checklist: checklist(),
  rejectionReasons: [],
  ...overrides,
});

const publish = async (
  target: PublishedContentCandidate,
  reviewOverrides: Partial<PublishedContentReview> = {},
  researchOverride?: BiblicalResearchResult,
) =>
  publishReviewedContent({
    candidate: target,
    researchResult: researchOverride ?? RESEARCH,
    review: await review(target, reviewOverrides),
  });

/* ================================================================== */
/* A. 정상 흐름                                                        */
/* ================================================================== */

describe('게시 콘텐츠 · A. 사람이 승인하면 게시된다', () => {
  it('연구 · 글 · 승인이 모두 맞으면 게시 콘텐츠가 만들어진다', async () => {
    const target = candidate();
    const outcome = await publish(target);

    assert.equal(outcome.ok, true, outcome.ok ? '' : outcome.errors.join(' / '));
    if (!outcome.ok) return;

    // 사람이 승인한 글이 그대로 남는다.
    assert.equal(outcome.content.userExplanation, target.userExplanation);
    assert.equal(outcome.content.prayerDirection, target.prayerDirection);
    assert.deepEqual(outcome.content.misuseGuards, target.misuseGuards);
    assert.equal(outcome.content.researchResultHash, RESEARCH_HASH);
    assert.match(outcome.content.candidateHash, CANDIDATE_HASH_FORMAT);
  });

  it('게시 콘텐츠에 카드 번호와 진행 상태를 넣지 않는다', async () => {
    const outcome = await publish(candidate());
    assert.equal(outcome.ok, true);
    if (!outcome.ok) return;

    const keys = Object.keys(outcome.content);
    for (const banned of ['id', 'cardId', 'scriptureCardId', 'status', 'publishedAt', 'reviewedAt']) {
      assert.equal(keys.includes(banned), false, banned);
    }
  });

  it('게시 콘텐츠에 검토 기록과 자료 정보가 섞이지 않는다', async () => {
    const outcome = await publish(candidate());
    assert.equal(outcome.ok, true);
    if (!outcome.ok) return;

    const serialized = JSON.stringify(outcome.content);
    // 검토 항목과 반려 이유는 검토 기록의 것이다. 글에 베껴 두지 않는다.
    for (const banned of ['checklist', 'decision', 'reviewAuthority', 'rejectionReasons']) {
      assert.equal(serialized.includes(banned), false, banned);
    }
    // 자료와 근거의 주인은 연구 보관소다.
    for (const banned of ['sources', 'sourceId', 'evidenceId', 'url', 'evidenceSetHash']) {
      assert.equal(serialized.includes(banned), false, banned);
    }
  });
});

/* ================================================================== */
/* B. 연구와의 연결                                                     */
/* ================================================================== */

describe('게시 콘텐츠 · B. 연구와 이어져 있는가', () => {
  it('연구 지문이 다르면 게시하지 않는다', async () => {
    const outcome = await publish(candidate({ researchResultHash: `rres_${'b'.repeat(64)}` }));
    assert.equal(outcome.ok, false);
    if (outcome.ok) return;
    assert.ok(outcome.errors.some((e) => e.includes('실제 연구와 다릅니다')));
  });

  it('영역이 연구와 다르면 게시하지 않는다', async () => {
    const other = RESEARCHABLE_DOMAINS.find((d) => d !== DOMAIN) as string;
    const outcome = await publish(candidate({ targetDomain: other }));
    assert.equal(outcome.ok, false);
    if (outcome.ok) return;
    assert.ok(outcome.errors.some((e) => e.includes('영역이 다릅니다')));
  });

  it('연구가 후보로 올리지 않은 본문은 게시하지 않는다', async () => {
    // 편집 단계에서 다른 본문을 슬쩍 끼워 넣을 수 없다.
    const outcome = await publish(candidate({ passage: passageOf(99) }));
    assert.equal(outcome.ok, false);
    if (outcome.ok) return;
    assert.ok(outcome.errors.some((e) => e.includes('후보로 올린 본문이 아닙니다')));
  });

  it('덧붙인 본문이 연구와 다르면 게시하지 않는다', async () => {
    // 연구는 2장에 3장을 덧붙였다. 그 조합만 쓸 수 있다.
    for (const wrong of [[], [passageOf(5)], [passageOf(3), passageOf(5)]]) {
      const outcome = await publish(
        candidate({ passage: passageOf(2), additionalPassages: wrong }),
      );
      assert.equal(outcome.ok, false, JSON.stringify(wrong));
    }

    // 연구가 실제로 올린 조합은 통과한다.
    const right = await publish(
      candidate({ passage: passageOf(2), additionalPassages: [passageOf(3)] }),
    );
    assert.equal(right.ok, true, right.ok ? '' : right.errors.join(' / '));
  });

  it('본문을 대신 고쳐 주지 않는다', async () => {
    const outcome = await publish(candidate({ passage: passageOf(99) }));
    assert.equal(outcome.ok, false);
    // 가장 가까운 본문으로 바꿔서 통과시키는 길이 없다.
    assert.equal(CONTRACT_SOURCE.includes('closest'), false);
    assert.equal(CONTRACT_SOURCE.includes('fallbackPassage'), false);
  });
});

/* ================================================================== */
/* C. 사람의 승인 없이는 게시되지 않는다                                 */
/* ================================================================== */

describe('게시 콘텐츠 · C. 사람의 승인', () => {
  it('검토 기록이 없으면 게시하지 않는다', async () => {
    for (const missing of [undefined, null, {}, 'approve']) {
      const outcome = await publishReviewedContent({
        candidate: candidate(),
        researchResult: RESEARCH,
        review: missing,
      });
      assert.equal(outcome.ok, false, JSON.stringify(missing));
    }
  });

  it('반려된 글은 게시하지 않는다', async () => {
    const outcome = await publish(candidate(), {
      decision: 'reject',
      rejectionReasons: ['theological_problem'],
    });
    assert.equal(outcome.ok, false);
    if (outcome.ok) return;
    assert.ok(outcome.errors.some((e) => e.includes('승인된 글이 아닙니다')));
  });

  it('사람이 아닌 것이 승인할 수 없다', async () => {
    // 자리를 만들어 두면 언젠가 그 자리로 들어온다. 아예 두지 않는다.
    assert.deepEqual([...REVIEW_AUTHORITIES], ['human']);

    for (const authority of ['ai', 'model', 'automatic', 'system', 'bot', '']) {
      const outcome = await publish(candidate(), {
        reviewAuthority: authority as never,
      });
      assert.equal(outcome.ok, false, authority);
    }
  });

  it('확인 항목 하나라도 아니면 승인이 성립하지 않는다', async () => {
    for (const check of REVIEW_CHECKS) {
      const outcome = await publish(candidate(), {
        checklist: checklist({ [check]: false }),
      });
      assert.equal(outcome.ok, false, check);
      if (outcome.ok) continue;
      assert.ok(
        outcome.errors.some((e) => e.includes(check)),
        check,
      );
    }
  });

  it('확인 항목은 일곱 개이고 조용히 줄지 않는다', () => {
    assert.deepEqual(
      [...REVIEW_CHECKS],
      [
        'researchTraceability',
        'canonicalContext',
        'theologicalFaithfulness',
        'pastoralSafety',
        'misuseGuardsAdequate',
        'userFacingClarity',
        'taggingFit',
      ],
    );
  });

  it('승인과 반려 두 가지뿐이고 대기 상태를 두지 않는다', () => {
    // 글은 있는데 결정이 없으면 그것이 곧 아직 안 본 것이다.
    assert.deepEqual([...REVIEW_DECISIONS], ['approve', 'reject']);
    assert.equal(CONTRACT_SOURCE.includes("'pending'"), false);
  });

  it('반려하려면 정해진 이유가 있어야 한다', async () => {
    const target = candidate();

    const noReason = validatePublishedContentReview(
      await review(target, { decision: 'reject', rejectionReasons: [] }),
    );
    assert.equal(noReason.valid, false);

    const madeUp = validatePublishedContentReview(
      await review(target, { decision: 'reject', rejectionReasons: ['그냥' as never] }),
    );
    assert.equal(madeUp.valid, false);

    const proper = validatePublishedContentReview(
      await review(target, { decision: 'reject', rejectionReasons: ['needs_more_research'] }),
    );
    assert.equal(proper.valid, true, proper.errors.join(' / '));
  });

  it('승인인데 반려 이유가 적혀 있으면 성립하지 않는다', async () => {
    const outcome = await publish(candidate(), {
      rejectionReasons: ['theological_problem'],
    });
    assert.equal(outcome.ok, false);
  });

  it('반려 이유 목록이 조용히 줄지 않는다', () => {
    assert.equal(REJECTION_REASONS.length, 8);
    assert.ok(REJECTION_REASONS.includes('pastoral_safety_problem'));
    assert.ok(REJECTION_REASONS.includes('needs_more_research'));
  });
});

/* ================================================================== */
/* D. 승인 뒤에 글을 고치면 그 승인은 무효다                             */
/* ================================================================== */

describe('게시 콘텐츠 · D. 승인 뒤 수정', () => {
  it('한 글자만 고쳐도 지문이 달라진다', async () => {
    const base = candidate();
    const baseHash = await computePublishedContentCandidateHash(base);

    const changes: Partial<PublishedContentCandidate>[] = [
      { userExplanation: `${base.userExplanation} ` },
      { prayerDirection: base.prayerDirection.replace('짧게', '자세히') },
      { misuseGuards: ['형편이 곧 나아진다는 약속으로 읽지 않습니다.'] },
      { situationTags: [...base.situationTags, '빚이 늘어남'] },
      { referenceLabel: '시편 1:1-3' },
      { contextSummary: `${base.contextSummary}.` },
    ];

    for (const change of changes) {
      const changed = await computePublishedContentCandidateHash(candidate(change));
      assert.notEqual(changed, baseHash, JSON.stringify(change));
    }
  });

  it('예전 승인을 고친 글에 다시 쓸 수 없다', async () => {
    // 이것이 이 계약의 핵심이다.
    // 승인받은 뒤 문구를 바꿔 놓고 그 승인을 그대로 쓰는 일을 막는다.
    const approvedText = candidate();
    const oldApproval = await review(approvedText);

    const edited = candidate({
      userExplanation: '승인 뒤에 조용히 바꾼 설명입니다. 사람은 이 글을 보지 않았습니다.',
    });

    const outcome = await publishReviewedContent({
      candidate: edited,
      researchResult: RESEARCH,
      review: oldApproval,
    });

    assert.equal(outcome.ok, false);
    if (outcome.ok) return;
    assert.ok(outcome.errors.some((e) => e.includes('사람이 검토한 글과 지금 글이 다릅니다')));
  });

  it('검토 기록의 지문을 손으로 맞춰 넣어도 통하지 않는다', async () => {
    const edited = candidate({ prayerDirection: '바뀐 기도 방향입니다.' });
    const outcome = await publish(candidate(), {
      candidateHash: await computePublishedContentCandidateHash(edited),
    });
    assert.equal(outcome.ok, false);
  });
});

/* ================================================================== */
/* E. 지문 자체의 성질                                                  */
/* ================================================================== */

describe('게시 콘텐츠 · E. 지문', () => {
  it('같은 글이면 항상 같은 지문이 나온다', async () => {
    const a = await computePublishedContentCandidateHash(candidate());
    const b = await computePublishedContentCandidateHash(candidate());
    assert.equal(a, b);
    assert.match(a, CANDIDATE_HASH_FORMAT);
  });

  it('항목을 적은 순서가 달라도 같은 지문이 나온다', async () => {
    const normal = candidate();
    const reordered = Object.fromEntries(
      Object.entries(normal).reverse(),
    ) as unknown as PublishedContentCandidate;

    assert.notEqual(JSON.stringify(normal), JSON.stringify(reordered));
    assert.equal(
      await computePublishedContentCandidateHash(reordered),
      await computePublishedContentCandidateHash(normal),
    );
  });

  it('목록의 차례가 바뀌면 다른 글로 본다', async () => {
    // 오용을 막는 문구의 순서에도 뜻이 있다.
    const base = candidate({ situationTags: ['가', '나'] });
    const swapped = candidate({ situationTags: ['나', '가'] });
    assert.notEqual(
      await computePublishedContentCandidateHash(swapped),
      await computePublishedContentCandidateHash(base),
    );
  });

  it('다른 지문들과 앞머리가 겹치지 않는다', async () => {
    const hash = await computePublishedContentCandidateHash(candidate());
    assert.ok(hash.startsWith('pcand_'));
    assert.equal(hash.startsWith('rres_'), false);
    assert.equal(hash.startsWith('evset_'), false);
    assert.equal(hash.startsWith('snap_'), false);
    // 방식이 바뀌면 알 수 있도록 판본을 지문 계산에 넣는다.
    assert.ok(CONTRACT_SOURCE.includes("CANDIDATE_HASH_VERSION = 'v1|published-content-candidate'"));
  });
});

/* ================================================================== */
/* F. 태그는 늘 수 있고, 영역은 늘 수 없다                               */
/* ================================================================== */

describe('게시 콘텐츠 · F. 태그와 영역', () => {
  it('지금 카드에 없는 태그도 사람이 승인하면 쓸 수 있다', async () => {
    // 이 앱의 태그 사전은 지금 있는 카드에서 자동으로 모은 것이다.
    // "사전에 있는 값만"이라고 하면, 새 영역의 카드는 새 말을 못 쓰게 된다.
    const fresh = '집세를 내지 못할까 두려움';
    assert.equal(TAXONOMY.situationTags.includes(fresh), false, '이미 있는 태그라 시험이 무의미하다');

    const outcome = await publish(candidate({ situationTags: [fresh] }));
    assert.equal(outcome.ok, true, outcome.ok ? '' : outcome.errors.join(' / '));
  });

  it('새 영역 이름은 만들 수 없다', async () => {
    for (const made of ['housing_insecurity', 'other_uncovered', 'grief_loss', '']) {
      const checked = validatePublishedContentCandidate(candidate({ targetDomain: made }));
      assert.equal(checked.valid, false, made);
    }
  });

  it('연구 가능한 일곱 영역만 쓸 수 있다', () => {
    assert.equal(RESEARCHABLE_DOMAINS.length, 7);
    assert.equal(RESEARCHABLE_DOMAINS.includes('other_uncovered'), false);
    // 목록을 여기서 다시 적지 않고 가져다 쓴다.
    assert.ok(CONTRACT_SOURCE.includes('RESEARCHABLE_DOMAINS'));
    assert.equal(CONTRACT_SOURCE.includes("'financial_hardship'"), false);
  });

  it('태그 목록은 모양만 본다', async () => {
    const bad: Partial<PublishedContentCandidate>[] = [
      { situationTags: [] },
      { situationTags: ['같음', '같음'] },
      { situationTags: ['   '] },
      { emotionTags: [123 as never] },
      { prayerModes: Array.from({ length: 9 }, (_, i) => `모드${i}`) },
      { pastoralFunction: ['가'.repeat(41)] },
    ];
    for (const change of bad) {
      const checked = validatePublishedContentCandidate(candidate(change));
      assert.equal(checked.valid, false, JSON.stringify(change));
    }
  });
});

/* ================================================================== */
/* G. 이 계층에 오면 안 되는 것                                          */
/* ================================================================== */

describe('게시 콘텐츠 · G. 넘어오면 안 되는 것', () => {
  it('사용자 이야기와 자격은 받지 않는다', async () => {
    for (const field of ['situation', 'rawSituation', 'prayer', 'prayerDraft', 'userId', 'sessionId', 'token']) {
      const checked = validatePublishedContentCandidate({
        ...candidate(),
        [field]: '무엇이든',
      });
      assert.equal(checked.valid, false, field);
      assert.ok(checked.errors.some((e) => e.includes(field)), field);
    }
  });

  it('자료와 근거 정보는 받지 않는다', async () => {
    for (const field of ['sources', 'sourceId', 'sourceIds', 'evidenceId', 'evidenceIds', 'url', 'rawResponse']) {
      const checked = validatePublishedContentCandidate({
        ...candidate(),
        [field]: '무엇이든',
      });
      assert.equal(checked.valid, false, field);
    }
  });

  it('진행 상태와 카드 번호는 받지 않는다', async () => {
    for (const field of ['status', 'reviewedAt', 'publishedAt', 'reviewerId', 'scriptureCardId', 'cardId']) {
      const checked = validatePublishedContentCandidate({
        ...candidate(),
        [field]: '무엇이든',
      });
      assert.equal(checked.valid, false, field);
    }
  });

  it('깊이 숨겨 넣어도 걸린다', () => {
    const checked = validatePublishedContentCandidate({
      ...candidate(),
      passage: { ...passageOf(1), sourceId: 'src_x' },
    });
    assert.equal(checked.valid, false);
    assert.ok(checked.errors.some((e) => e.includes('sourceId')));
  });

  it('막는 항목 목록이 조용히 줄지 않는다', () => {
    for (const must of ['situation', 'prayer', 'userId', 'sources', 'url', 'evidenceIds', 'status', 'scriptureCardId']) {
      assert.ok((FORBIDDEN_CANDIDATE_FIELDS as readonly string[]).includes(must), must);
    }
  });

  it('검토 대상 항목은 정해진 것뿐이다', () => {
    assert.equal(CANDIDATE_FIELDS.length, 15);
    const checked = validatePublishedContentCandidate({ ...candidate(), 메모: '덧붙임' });
    assert.equal(checked.valid, false);
  });
});

/* ================================================================== */
/* H. 연구에서 곧바로 게시하는 길이 없다                                 */
/* ================================================================== */

describe('게시 콘텐츠 · H. 곧바로 게시하는 길', () => {
  it('연구 결과만 받아 게시하는 함수가 없다', () => {
    // 게시 콘텐츠를 만드는 길은 publishReviewedContent 하나뿐이고,
    // 그 함수는 검토 기록을 반드시 받는다.
    // 이름 안에 'Published'가 들어간 검사 함수까지 걸리지 않도록,
    // 이름이 publish로 시작하는 것(= 게시하는 행위)만 본다.
    const exported = [...CONTRACT_SOURCE.matchAll(/^export (?:async )?function (\w+)/gm)].map(
      (m) => m[1],
    );
    const makers = exported.filter((name) => name.startsWith('publish'));
    assert.deepEqual(makers, ['publishReviewedContent']);

    // 그리고 그 함수는 검토 기록을 반드시 받는다.
    assert.equal(CONTRACT_SOURCE.includes('PublishOutcome'), true);

    const signature = CONTRACT_SOURCE.match(
      /export async function publishReviewedContent\(input: \{([\s\S]*?)\}\)/,
    );
    assert.ok(signature);
    assert.ok(signature![1].includes('review:'));
    assert.ok(signature![1].includes('candidate:'));
  });

  it('모델이 승인하는 자리를 두지 않았다', () => {
    for (const banned of ["'ai'", "'model'", "'automatic'", "'system'", 'autoApprove', 'selfPublish']) {
      assert.equal(CONTRACT_SOURCE.includes(banned), false, banned);
    }
  });

  it('글을 대신 써 주는 자리를 두지 않았다', () => {
    for (const banned of ['generateUserExplanation', 'generatePrayerDirection', 'buildCandidate', 'openai', 'OpenAI']) {
      assert.equal(CONTRACT_SOURCE.includes(banned), false, banned);
    }
  });

  it('바깥을 부르거나 시각·난수를 쓰지 않는다', () => {
    for (const banned of [
      'Deno.env',
      'process.env',
      'fetch(',
      'createClient',
      'Date.now',
      'randomUUID',
      'new Date(',
    ]) {
      assert.equal(CONTRACT_SOURCE.includes(banned), false, banned);
    }

    // 'expo'는 export 안에도 들어 있다. 조각으로 보지 않고 무엇을 가져오는지로 본다.
    const imports = [...CONTRACT_SOURCE.matchAll(/from '([^']+)'/g)].map((m) => m[1]);
    for (const path of imports) {
      assert.ok(path.startsWith('./'), path);
    }
    assert.equal(imports.some((path) => /react|expo|supabase-js/.test(path)), false);

    // 지문 계산에 쓰는 Web Crypto는 허용된다.
    assert.ok(CONTRACT_SOURCE.includes("crypto.subtle.digest('SHA-256'"));
  });
});

/* ================================================================== */
/* I. 이상한 값에도 멈추지 않는다                                        */
/* ================================================================== */

describe('게시 콘텐츠 · I. 이상한 값', () => {
  it('어떤 모양이 와도 예외를 던지지 않는다', async () => {
    for (const weird of [null, undefined, 0, '', [], {}, { candidate: 1 }]) {
      const checked = validatePublishedContentCandidate(weird);
      assert.equal(checked.valid, false, JSON.stringify(weird));

      const reviewed = validatePublishedContentReview(weird);
      assert.equal(reviewed.valid, false, JSON.stringify(weird));

      const outcome = await publishReviewedContent({
        candidate: weird,
        researchResult: RESEARCH,
        review: weird,
      });
      assert.equal(outcome.ok, false, JSON.stringify(weird));
    }
  });

  it('어긋난 것을 조용히 고쳐서 통과시키지 않는다', () => {
    for (const banned of ['delete candidate', 'candidate.targetDomain =', 'candidate.passage =']) {
      assert.equal(CONTRACT_SOURCE.includes(banned), false, banned);
    }
  });
});
