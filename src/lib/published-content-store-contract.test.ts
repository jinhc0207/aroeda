/**
 * 게시 콘텐츠 보관과 사람의 검토 · 쓰기 경계 테스트
 *
 * 실행: npm test
 *
 * 지키려는 것 다섯 가지.
 *
 *   1. 서버 열쇠로는 승인할 수 없다.
 *   2. 검토자 번호와 자격을 요청에서 받지 않는다.
 *   3. 한 글에 최종 결정은 하나뿐이고, 반려를 승인으로 뒤집지 않는다.
 *   4. 같은 사람이 같은 결정을 다시 보낸 경우에만 다시 적지 않는다.
 *   5. 승인과 게시는 같은 묶음에서 끝난다. 게시만 따로 하는 함수가 없다.
 *
 * 여기서 검사하는 것 중 상당수는 "앞으로 만들 표가 지켜야 할 약속"이다.
 * 지금 그 표는 존재하지 않는다. 약속이 조용히 바뀌지 않게 못을 박는 것이다.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import {
  CANDIDATE_STORE_INPUT_FIELDS,
  FORBIDDEN_REVIEW_INPUT_FIELDS,
  FUTURE_WRITE_BOUNDARY,
  PUBLISHED_CONTENT_TABLES,
  REVIEW_PUBLISHED_CONTENT_CANDIDATE_RPC,
  REVIEW_WRITE_INPUT_FIELDS,
  STORE_PUBLISHED_CONTENT_CANDIDATE_RPC,
  isExactReviewRetry,
  validateCandidateStoreInput,
  validateReviewWriteInput,
  type ReviewWriteInput,
} from '../../supabase/functions/_shared/published-content-store-contract.ts';
import {
  REVIEW_CHECKS,
  computePublishedContentCandidateHash,
  type PublishedContentCandidate,
  type PublishedContentReview,
} from '../../supabase/functions/_shared/published-content-contract.ts';

const STORE_PATH = '../../supabase/functions/_shared/published-content-store-contract.ts';
const STORE_SOURCE = readFileSync(new URL(STORE_PATH, import.meta.url), 'utf8');

/* ------------------------------------------------------------------ */
/* fixture                                                             */
/* ------------------------------------------------------------------ */

const RESEARCH_HASH = `rres_${'a'.repeat(64)}`;

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

const storeInput = async (overrides: Record<string, unknown> = {}) => {
  const merged = {
    candidate: candidate(),
    researchResultHash: RESEARCH_HASH,
    ...overrides,
  } as Record<string, unknown>;

  // 지문은 마지막에 실린 글에서 계산한다.
  // 기본값에서 미리 계산해 두면, 글을 바꾼 시험이
  // 정작 보려던 규칙이 아니라 지문 검사에 걸려서 통과해 버린다.
  if (!('candidateHash' in overrides)) {
    merged.candidateHash = await computePublishedContentCandidateHash(
      merged.candidate as PublishedContentCandidate,
    );
  }

  return merged;
};

const checklist = (overrides: Record<string, boolean> = {}) =>
  Object.fromEntries(
    REVIEW_CHECKS.map((check) => [check, overrides[check] ?? true]),
  ) as ReviewWriteInput['checklist'];

const reviewInput = async (overrides: Record<string, unknown> = {}) => ({
  candidateHash: await computePublishedContentCandidateHash(candidate()),
  decision: 'approve',
  checklist: checklist(),
  rejectionReasons: [],
  ...overrides,
});

/* ================================================================== */
/* A. 검토 대상 적어 두기                                               */
/* ================================================================== */

describe('쓰기 경계 · A. 검토 대상 적어 두기', () => {
  it('제대로 된 값은 적을 수 있다', async () => {
    const checked = await validateCandidateStoreInput(await storeInput());
    assert.deepEqual(checked.errors, []);
    assert.equal(checked.valid, true);
  });

  it('넘기는 항목은 셋뿐이다', () => {
    assert.deepEqual(
      [...CANDIDATE_STORE_INPUT_FIELDS],
      ['candidateHash', 'researchResultHash', 'candidate'],
    );
  });

  it('지문이 글과 맞지 않으면 적지 않는다', async () => {
    const checked = await validateCandidateStoreInput(
      await storeInput({ candidateHash: `pcand_${'b'.repeat(64)}` }),
    );
    assert.equal(checked.valid, false);
    assert.ok(checked.errors.some((e) => e.includes('지문이 내용과 맞지 않습니다')));
  });

  it('밖에 적은 연구 지문과 글 안의 것이 다르면 적지 않는다', async () => {
    // 두 값이 어긋난 상태를 만들 수 없어야 한다.
    const checked = await validateCandidateStoreInput(
      await storeInput({ researchResultHash: `rres_${'c'.repeat(64)}` }),
    );
    assert.equal(checked.valid, false);
    assert.ok(checked.errors.some((e) => e.includes('밖에 적은 값이 다릅니다')));
  });

  it('연구 지문 모양이 틀리면 적지 않는다', async () => {
    for (const bad of ['', 'rres_짧음', `pcand_${'a'.repeat(64)}`, `rres_${'a'.repeat(63)}`]) {
      const target = candidate({ researchResultHash: bad });
      const checked = await validateCandidateStoreInput({
        candidateHash: await computePublishedContentCandidateHash(target),
        researchResultHash: bad,
        candidate: target,
      });
      assert.equal(checked.valid, false, bad);
    }
  });

  it('모르는 항목을 넣으면 적지 않는다', async () => {
    for (const extra of ['targetDomain', 'createdAt', 'status', 'reviewerUserId']) {
      const checked = await validateCandidateStoreInput(await storeInput({ [extra]: 'x' }));
      assert.equal(checked.valid, false, extra);
    }
  });

  it('글 자체 검사를 여기서 새로 만들지 않는다', async () => {
    // 앞 계약의 검사기를 그대로 쓴다. 두 벌이 되면 언젠가 갈라진다.
    assert.ok(STORE_SOURCE.includes('validatePublishedContentCandidate('));
    assert.ok(STORE_SOURCE.includes('computePublishedContentCandidateHash('));

    // 잘못된 글은 앞 계약 검사기에 걸린다.
    const broken = await validateCandidateStoreInput(
      await storeInput({ candidate: candidate({ targetDomain: 'made_up_domain' }) }),
    );
    assert.equal(broken.valid, false);
  });

  it('연구 결과가 실제 있는지는 여기서 보지 않는다', () => {
    // 그것은 표의 이음(FK)이 할 일이다. 순수 계약이 DB를 부르지 않는다.
    assert.equal(FUTURE_WRITE_BOUNDARY.candidateResearchForeignKey, 'private.research_result(result_hash)');
    assert.equal(STORE_SOURCE.includes('select '), false);
    assert.equal(STORE_SOURCE.includes('rpc('), false);
  });
});

/* ================================================================== */
/* B. 사람이 보내는 값                                                  */
/* ================================================================== */

describe('쓰기 경계 · B. 검토 요청', () => {
  it('제대로 된 요청은 통과한다', async () => {
    const checked = validateReviewWriteInput(await reviewInput());
    assert.deepEqual(checked.errors, []);
    assert.equal(checked.valid, true);
  });

  it('보낼 수 있는 항목은 넷뿐이다', () => {
    assert.deepEqual(
      [...REVIEW_WRITE_INPUT_FIELDS],
      ['candidateHash', 'decision', 'checklist', 'rejectionReasons'],
    );
  });

  it('검토자 번호를 요청에 담을 수 없다', async () => {
    // 담을 수 있으면 그 말을 믿는 구조가 된다. 그러면 경계가 없는 것과 같다.
    for (const field of ['reviewerId', 'reviewerUserId']) {
      const checked = validateReviewWriteInput(await reviewInput({ [field]: 'someone' }));
      assert.equal(checked.valid, false, field);
      assert.ok(checked.errors.some((e) => e.includes(field)), field);
    }
  });

  it('자격을 스스로 선언할 수 없다', async () => {
    // "나는 사람이다"라고 적어 보내서 얻는 권한이 아니다.
    for (const field of ['reviewAuthority', 'authority']) {
      const checked = validateReviewWriteInput(await reviewInput({ [field]: 'human' }));
      assert.equal(checked.valid, false, field);
    }
  });

  it('승인하는 순간에 글을 다시 보낼 수 없다', async () => {
    // 다시 보내게 하면 사람이 읽은 글과 승인된 글이 달라질 수 있다.
    for (const field of ['candidate', 'content', 'publishedContent', 'userExplanation', 'passage']) {
      const checked = validateReviewWriteInput(await reviewInput({ [field]: '무엇이든' }));
      assert.equal(checked.valid, false, field);
    }
  });

  it('모르는 항목을 넣으면 받지 않는다', async () => {
    const checked = validateReviewWriteInput(await reviewInput({ 메모: '덧붙임' }));
    assert.equal(checked.valid, false);
  });

  it('확인 항목 하나라도 아니면 승인이 성립하지 않는다', async () => {
    for (const check of REVIEW_CHECKS) {
      const checked = validateReviewWriteInput(
        await reviewInput({ checklist: checklist({ [check]: false }) }),
      );
      assert.equal(checked.valid, false, check);
    }
  });

  it('반려에는 정해진 이유가 있어야 한다', async () => {
    const empty = validateReviewWriteInput(
      await reviewInput({ decision: 'reject', rejectionReasons: [] }),
    );
    assert.equal(empty.valid, false);

    const madeUp = validateReviewWriteInput(
      await reviewInput({ decision: 'reject', rejectionReasons: ['그냥'] }),
    );
    assert.equal(madeUp.valid, false);

    const proper = validateReviewWriteInput(
      await reviewInput({ decision: 'reject', rejectionReasons: ['needs_more_research'] }),
    );
    assert.equal(proper.valid, true, proper.errors.join(' / '));
  });

  it('결정 종류와 확인 항목을 새로 만들지 않는다', () => {
    // 앞 계약의 것을 가져다 쓴다.
    assert.ok(STORE_SOURCE.includes('REVIEW_DECISIONS'));
    assert.ok(STORE_SOURCE.includes('REVIEW_CHECKS'));
    assert.ok(STORE_SOURCE.includes('REJECTION_REASONS'));
    // 목록을 여기서 다시 늘어놓지 않는다.
    assert.equal(STORE_SOURCE.includes("'theologicalFaithfulness'"), false);
    assert.equal(STORE_SOURCE.includes("'needs_more_research'"), false);
  });

  it('막는 항목 목록이 조용히 줄지 않는다', () => {
    for (const must of ['reviewerId', 'reviewerUserId', 'reviewAuthority', 'candidate', 'status']) {
      assert.ok((FORBIDDEN_REVIEW_INPUT_FIELDS as readonly string[]).includes(must), must);
    }
  });
});

/* ================================================================== */
/* C. 권한 분리                                                        */
/* ================================================================== */

describe('쓰기 경계 · C. 누가 무엇을 할 수 있는가', () => {
  it('글을 적어 두는 일은 서버가 해도 된다', () => {
    assert.equal(FUTURE_WRITE_BOUNDARY.candidateStoreExecute, 'service_role');
  });

  it('승인은 로그인한 사람만 부를 수 있다', () => {
    assert.equal(FUTURE_WRITE_BOUNDARY.reviewExecute, 'authenticated');
    assert.equal(FUTURE_WRITE_BOUNDARY.reviewAnonExecute, false);
  });

  it('서버 열쇠로는 승인할 수 없다', () => {
    // 이것이 이 설계의 중심이다.
    assert.equal(FUTURE_WRITE_BOUNDARY.reviewServiceRoleExecute, false);
  });

  it('검토자 번호는 인증 문맥에서 읽는다', () => {
    assert.equal(FUTURE_WRITE_BOUNDARY.reviewIdentitySource, 'auth.uid()');
  });

  it('로그인만으로는 부족하고 명단에 있어야 한다', () => {
    assert.equal(FUTURE_WRITE_BOUNDARY.reviewerAllowlistRequired, true);
    assert.equal(PUBLISHED_CONTENT_TABLES.reviewer, 'private.published_content_reviewer');
  });

  it('표를 직접 열지 않는다', () => {
    assert.equal(FUTURE_WRITE_BOUNDARY.directTableWrites, false);
  });

  it('부를 수 있는 함수는 둘뿐이다', () => {
    assert.equal(STORE_PUBLISHED_CONTENT_CANDIDATE_RPC, 'store_published_content_candidate');
    assert.equal(REVIEW_PUBLISHED_CONTENT_CANDIDATE_RPC, 'review_published_content_candidate');
  });

  it('아직 구현이 아니라는 것을 문서에 남겼다', () => {
    // 이 값들이 참이라고 해서 DB가 그렇게 되어 있다는 뜻이 아니다.
    assert.ok(STORE_SOURCE.includes('아직 구현이 아니다'));
    assert.ok(STORE_SOURCE.includes('표도 함수도 아직 없다'));
  });

  it('보장하지 못하는 것을 과장하지 않는다', () => {
    // 사람이 실제로 눌렀다는 증명이 아니다.
    assert.ok(STORE_SOURCE.includes('보장하지 못하는 것'));
    assert.ok(STORE_SOURCE.includes('증명하지는 못한다'));
    // 줄 단위로 본다. "…고 적지 않는다"처럼 그 표현을 쓰지 말라고 적어 둔 줄까지
    // 조각으로 걸리면, 정확히 반대를 말하는 문장이 위반으로 잡힌다.
    const claimLines = STORE_SOURCE.split('\n').filter(
      (line) => !line.includes('적지 않는다') && !line.includes('보장하지 못하는'),
    );
    for (const overstated of ['절대 승인할 수 없다', '위조 불가', 'tamper-proof', '불가능하다']) {
      assert.equal(
        claimLines.some((line) => line.includes(overstated)),
        false,
        overstated,
      );
    }
  });
});

/* ================================================================== */
/* D. 결정의 일생                                                       */
/* ================================================================== */

describe('쓰기 경계 · D. 한 글에 결정은 하나', () => {
  it('한 글의 최종 결정은 하나뿐이다', () => {
    assert.equal(FUTURE_WRITE_BOUNDARY.oneFinalReviewPerCandidateHash, true);
  });

  it('반려를 나중에 승인으로 바꾸지 않는다', () => {
    // 고칠 것이 있으면 글을 고치고, 새 지문으로 다시 검토받는다.
    assert.equal(FUTURE_WRITE_BOUNDARY.rejectCanBecomeApprove, false);
  });

  it('글을 고치면 새 지문이 되어 새 검토 대상이 된다', async () => {
    const before = await computePublishedContentCandidateHash(candidate());
    const after = await computePublishedContentCandidateHash(
      candidate({ userExplanation: '고친 설명입니다.' }),
    );
    assert.notEqual(after, before);
  });

  it('검토 기록과 글은 고치지 않고, 검토자 명단만 켜고 끈다', () => {
    assert.deepEqual([...FUTURE_WRITE_BOUNDARY.mutableObjects], [
      'private.published_content_reviewer',
    ]);
    assert.deepEqual([...FUTURE_WRITE_BOUNDARY.immutableObjects], [
      'private.published_content_candidate',
      'private.published_content_review',
      'private.published_content',
    ]);
  });
});

/* ================================================================== */
/* E. 같은 요청이 두 번 왔을 때                                         */
/* ================================================================== */

describe('쓰기 경계 · E. 다시 보낸 요청', () => {
  const REVIEWER = '11111111-2222-4333-8444-555555555555';

  const existing = async (
    overrides: Partial<PublishedContentReview> = {},
  ): Promise<{ reviewerUserId: string; review: PublishedContentReview }> => ({
    reviewerUserId: REVIEWER,
    review: {
      candidateHash: await computePublishedContentCandidateHash(candidate()),
      reviewAuthority: 'human',
      decision: 'approve',
      checklist: checklist(),
      rejectionReasons: [],
      ...overrides,
    },
  });

  const incoming = async (
    reviewerUserId: string,
    overrides: Partial<ReviewWriteInput> = {},
  ) => ({
    reviewerUserId,
    input: (await reviewInput(overrides as Record<string, unknown>)) as ReviewWriteInput,
  });

  it('같은 사람이 같은 결정을 다시 보내면 같은 것으로 본다', async () => {
    assert.equal(isExactReviewRetry(await existing(), await incoming(REVIEWER)), true);
  });

  it('다른 사람이 같은 내용을 보내도 같은 것이 아니다', async () => {
    // 앞사람의 검토를 자기 것으로 성공 처리하면 누가 판단했는지 흐려진다.
    const other = '99999999-8888-4777-8666-555555555555';
    assert.equal(isExactReviewRetry(await existing(), await incoming(other)), false);
  });

  it('결정이 다르면 같은 것이 아니다', async () => {
    assert.equal(
      isExactReviewRetry(
        await existing(),
        await incoming(REVIEWER, {
          decision: 'reject',
          rejectionReasons: ['theological_problem'],
        }),
      ),
      false,
    );
  });

  it('확인 항목이 하나라도 다르면 같은 것이 아니다', async () => {
    for (const check of REVIEW_CHECKS) {
      assert.equal(
        isExactReviewRetry(
          await existing(),
          await incoming(REVIEWER, { checklist: checklist({ [check]: false }) }),
        ),
        false,
        check,
      );
    }
  });

  it('반려 이유가 다르면 같은 것이 아니다', async () => {
    const rejected = await existing({
      decision: 'reject',
      rejectionReasons: ['theological_problem'],
    });
    assert.equal(
      isExactReviewRetry(
        rejected,
        await incoming(REVIEWER, {
          decision: 'reject',
          rejectionReasons: ['tagging_problem'],
        }),
      ),
      false,
    );
    assert.equal(
      isExactReviewRetry(
        rejected,
        await incoming(REVIEWER, {
          decision: 'reject',
          rejectionReasons: ['theological_problem', 'tagging_problem'],
        }),
      ),
      false,
    );
  });

  it('다른 글에 대한 결정은 같은 것이 아니다', async () => {
    const otherHash = await computePublishedContentCandidateHash(
      candidate({ prayerDirection: '다른 기도 방향입니다.' }),
    );
    assert.equal(
      isExactReviewRetry(await existing(), await incoming(REVIEWER, { candidateHash: otherHash })),
      false,
    );
  });

  it('같은 것일 때만 다시 적지 않는다', () => {
    assert.equal(FUTURE_WRITE_BOUNDARY.exactRetryOnly, true);
  });
});

/* ================================================================== */
/* F. 승인과 게시는 한 묶음                                             */
/* ================================================================== */

describe('쓰기 경계 · F. 승인과 게시', () => {
  it('승인이 성립하는 그 묶음에서 게시까지 끝낸다', () => {
    assert.equal(FUTURE_WRITE_BOUNDARY.approveMaterializesPublishedAtomically, true);
  });

  it('게시만 따로 하는 함수를 두지 않는다', () => {
    assert.equal(FUTURE_WRITE_BOUNDARY.separatePublishRpc, false);
    // 그런 이름의 함수 상수를 만들지 않았다.
    for (const banned of ['publish_published_content', 'approve_then_publish', 'materialize_published']) {
      assert.equal(STORE_SOURCE.includes(banned), false, banned);
    }
  });

  it('게시할 글은 이미 적혀 있는 것에서 가져온다', () => {
    assert.equal(FUTURE_WRITE_BOUNDARY.publishedContentSource, 'stored_candidate');
  });

  it('왜 나누지 않는지 이유를 남겼다', () => {
    // 나누면 자동화가 승인을 건너뛰거나, 승인만 있고 글이 없는 상태가 생긴다.
    assert.ok(STORE_SOURCE.includes('승인은 됐는데 글이 없다'));
    assert.ok(STORE_SOURCE.includes('없던 일이 된다'));
  });
});

/* ================================================================== */
/* G. 이 계층에 오면 안 되는 것                                          */
/* ================================================================== */

describe('쓰기 경계 · G. 개인정보', () => {
  it('사용자의 이야기와 기도는 이 설계에 없다', () => {
    const code = STORE_SOURCE.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '');
    for (const banned of [
      "'situation'",
      "'prayerDraft'",
      "'sessionId'",
      "'deviceId'",
      "'apiKey'",
    ]) {
      assert.equal(code.includes(banned), false, banned);
    }
  });

  it('검토자 번호는 승인된 글 안에 들어가지 않는다', () => {
    // 검토자 번호는 감사 기록의 값이지 글의 일부가 아니다.
    const rowType = STORE_SOURCE.match(/export type PublishedContentRow = \{([\s\S]*?)\n\};/)![1];
    assert.equal(rowType.includes('reviewerUserId'), false);
    assert.equal(rowType.includes('reviewer'), false);

    // 검토 기록에는 남는다. 둘은 다른 종류의 값이다.
    const reviewRow = STORE_SOURCE.match(/export type ReviewStoreRow = \{([\s\S]*?)\n\};/)![1];
    assert.ok(reviewRow.includes('reviewerUserId'));
  });

  it('그 차이를 설명해 두었다', () => {
    assert.ok(STORE_SOURCE.includes('서비스를 쓰는 사람의 이야기이고'));
  });
});

/* ================================================================== */
/* H. 순수 계약                                                        */
/* ================================================================== */

describe('쓰기 경계 · H. 순수 계약', () => {
  it('바깥을 부르거나 시각·난수를 만들지 않는다', () => {
    for (const banned of [
      'Deno.env',
      'process.env',
      'fetch(',
      'createClient',
      'Date.now',
      'randomUUID',
      'new Date(',
    ]) {
      assert.equal(STORE_SOURCE.includes(banned), false, banned);
    }
  });

  it('지문을 새로 계산하지 않는다', () => {
    // 지문의 주인은 앞 계약 하나뿐이다.
    const code = STORE_SOURCE.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '');
    assert.equal(code.includes('crypto.subtle'), false);
    assert.equal(code.includes('SHA-256'), false);
    assert.equal(code.includes('stableStringify'), false);
  });

  it('가져오는 곳은 _shared 안뿐이다', () => {
    const imports = [...STORE_SOURCE.matchAll(/from '([^']+)'/g)].map((m) => m[1]);
    for (const path of imports) assert.ok(path.startsWith('./'), path);
    assert.equal(imports.some((p) => /react|expo|supabase-js/.test(p)), false);
  });

  it('SQL을 쓰거나 실행하지 않는다', () => {
    const code = STORE_SOURCE.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '');
    for (const banned of ['create table', 'insert into', 'security definer', 'grant ']) {
      assert.equal(code.toLowerCase().includes(banned), false, banned);
    }
  });
});

/* ================================================================== */
/* I. 이상한 값에도 멈추지 않는다                                        */
/* ================================================================== */

describe('쓰기 경계 · I. 이상한 값', () => {
  it('어떤 모양이 와도 예외를 던지지 않는다', async () => {
    for (const weird of [null, undefined, 0, '', [], {}, { candidate: 1 }]) {
      const stored = await validateCandidateStoreInput(weird);
      assert.equal(stored.valid, false, JSON.stringify(weird));

      const reviewed = validateReviewWriteInput(weird);
      assert.equal(reviewed.valid, false, JSON.stringify(weird));
    }
  });
});
