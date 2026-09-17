/**
 * 자동 Scripture Catalog 활성화 계약 테스트 — 검증 기록, fail-closed, 멱등성, 원자성, 롤백
 *
 * 실행: npm test
 *
 * 무엇을 증명하는가
 *   계약(TypeScript)의 참조 의미가 요구한 규칙대로 동작한다는 것.
 *   실패한 계획은 입력 상태 객체를 그대로 돌려주지 않고 이유만 돌려주므로 상태가 반쯤 바뀔 수 없다.
 *
 * 무엇을 증명하지 않는가
 *   migration의 SQL 함수가 실제 Postgres에서 같은 동작을 한다는 것.
 *   로컬에 DB가 없어 SQL은 실행하지 않았다. SQL은 automatic-scripture-catalog-migration.test.ts가
 *   글자로 대조할 뿐이며, 적용 전 실제 DB에서 따로 확인해야 한다.
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';

import {
  type ScriptureCatalogCandidate,
  type ScriptureCatalogSnapshot,
  canonicalJson,
  computeThemeFingerprint,
  scanForbiddenContent,
} from '../../supabase/functions/_shared/automatic-scripture-catalog-contract.ts';
import {
  AUTOMATED_OPERATIONS_AUTHORITY,
  AUTOMATED_VALIDATION_AUTHORITY,
  type AutomaticValidationRecord,
  type CatalogLedgerState,
  EMPTY_CATALOG_LEDGER,
  HUMAN_REVIEW_AUTHORITY,
  REQUIRED_VALIDATION_CHECKS,
  computeCheckArtifactHash,
  computePassageTextHash,
  computeValidationHash,
  planActivation,
  planBaselineRegistration,
  planRecordDemandObservation,
  planRollback,
  planStoreCandidate,
  planStoreValidation,
  validateAutomaticValidationRecord,
} from '../../supabase/functions/_shared/automatic-scripture-catalog-activation-contract.ts';
import { SOURCE_SHA256 } from '../../supabase/functions/_shared/bible-reference-index.ts';
import {
  BIBLE_JSON_BYTES,
  buildBaselineCatalog,
  finalizeCandidate,
  makeExistingDomainCandidate,
  makeAttestations,
  makeDemandCells,
  makeNewDomainCandidate,
  makePassingValidationRecord,
  resealRecord,
  FIXTURE_ACTIVATION_DATE,
  FIXTURE_RESEARCH_RESULT_HASH,
  FIXTURE_VALIDATOR_REGISTRY,
  requestId,
  resolveKrvPassage,
  validationContextFor,
} from './automatic-scripture-catalog-test-fixtures.ts';

const clone = <T>(value: T): T => structuredClone(value);

type Fixture = {
  base: ScriptureCatalogSnapshot;
  candidate: ScriptureCatalogCandidate;
  candidateHash: string;
  record: AutomaticValidationRecord;
};

async function existingFixture(): Promise<Fixture> {
  const base = buildBaselineCatalog();
  const { candidate, candidateHash } = await makeExistingDomainCandidate(base);
  return { base, candidate, candidateHash, record: await makePassingValidationRecord(candidate, candidateHash, base) };
}

const check = (fixture: Fixture, record: unknown, resolver = resolveKrvPassage) => {
  const completeRecord =
    record !== null &&
    typeof record === 'object' &&
    'checks' in record &&
    REQUIRED_VALIDATION_CHECKS.every((name) => name in ((record as AutomaticValidationRecord).checks ?? {}))
      ? (record as AutomaticValidationRecord)
      : fixture.record;
  return validateAutomaticValidationRecord(record, {
    ...validationContextFor({ ...fixture, record: completeRecord }),
    resolvePassageText: resolver,
  });
};

/** 기록 하나를 고친다. overallStatus는 항목 결과에 맞게 다시 맞춘다(거짓말이 아니라 사실대로 실패). */
async function truthfullyFail(record: AutomaticValidationRecord, mutate: (record: AutomaticValidationRecord) => void) {
  const next = clone(record);
  mutate(next);
  return resealRecord(next);
}

/* ================================================================== */
/* 검증 기록                                                           */
/* ================================================================== */

describe('자동 검증 기록 · 통과와 이음', () => {
  it('실제 개역한글 데이터의 지문이 계약에 고정된 값과 같다', () => {
    assert.equal(createHash('sha256').update(BIBLE_JSON_BYTES).digest('hex'), SOURCE_SHA256);
  });

  it('기존 영역 후보와 새 영역 후보의 통과 기록은 유효하고 막는 이유가 없다', async () => {
    const existing = await existingFixture();
    assert.deepEqual(await check(existing, existing.record), { valid: true, errors: [], activationBlockers: [] });

    const base = buildBaselineCatalog();
    const { candidate, candidateHash } = await makeNewDomainCandidate(base);
    const record = await makePassingValidationRecord(candidate, candidateHash, base);
    const result = await validateAutomaticValidationRecord(record, validationContextFor({ candidate, base, record }));
    assert.deepEqual(result, { valid: true, errors: [], activationBlockers: [] });
  });

  it('필수 검증 항목이 하나라도 빠지면 무효다', async () => {
    const fixture = await existingFixture();
    for (const name of REQUIRED_VALIDATION_CHECKS) {
      const missing = clone(fixture.record) as unknown as { checks: Record<string, unknown> };
      delete missing.checks[name];
      assert.equal((await check(fixture, missing)).valid, false, name);
    }
  });

  it('계약에 없는 검증 항목이 섞이면 무효다', async () => {
    const fixture = await existingFixture();
    const extra = clone(fixture.record) as unknown as { checks: Record<string, unknown> };
    extra.checks.humanApproval = { status: 'pass' };
    assert.equal((await check(fixture, extra)).valid, false);
  });

  it('후보·기준·결과 지문과 후보 종류가 정확히 이어지지 않으면 무효다', async () => {
    const fixture = await existingFixture();
    const cases: [string, (record: AutomaticValidationRecord) => void][] = [
      ['candidateHash', (record) => { record.candidateHash = `sccand_${'a'.repeat(64)}`; }],
      ['baseVersionHash', (record) => { record.baseVersionHash = `scat_${'b'.repeat(64)}`; }],
      ['proposedVersionHash', (record) => { record.proposedVersionHash = `scat_${'c'.repeat(64)}`; }],
      ['candidateKind', (record) => { record.candidateKind = 'new_domain_with_cards'; }],
      ['artifactHash', (record) => { record.checks.safetyBoundary.artifactHash = 'not-a-hash'; }],
      ['modelIdentifiers.generation', (record) => { record.modelIdentifiers.generation = 'other-model'; }],
      ['modelIdentifiers.evaluators', (record) => { record.modelIdentifiers.evaluators = ['fixture-eval-model-a']; }],
    ];
    for (const [label, mutate] of cases) {
      const broken = clone(fixture.record);
      mutate(broken);
      assert.equal((await check(fixture, broken)).valid, false, label);
    }
  });

  it('사람 검토 authority나 다른 authority로 적힌 기록은 무효다', async () => {
    const fixture = await existingFixture();
    for (const authority of [HUMAN_REVIEW_AUTHORITY, AUTOMATED_OPERATIONS_AUTHORITY, 'automated']) {
      const broken = { ...clone(fixture.record), validationAuthority: authority };
      assert.equal((await check(fixture, broken)).valid, false, authority);
    }
  });

  it('검증 기록에 원본 응답이나 개인정보가 섞이면 무효다', async () => {
    const fixture = await existingFixture();
    const withRaw = clone(fixture.record) as unknown as { checks: { safetyBoundary: Record<string, unknown> } };
    withRaw.checks.safetyBoundary.rawResponse = '{"output":"..."}';
    assert.equal((await check(fixture, withRaw)).valid, false);
  });

  it('검증 지문은 결정적이다', async () => {
    const fixture = await existingFixture();
    const first = await computeValidationHash(fixture.record);
    assert.match(first, /^scval_[0-9a-f]{64}$/);
    assert.equal(await computeValidationHash(clone(fixture.record)), first);
  });

  it('등록되지 않은 validator나 빠진 attestation으로는 유효한 기록을 만들 수 없다', async () => {
    const fixture = await existingFixture();
    const context = validationContextFor(fixture);
    assert.equal((await validateAutomaticValidationRecord(fixture.record, { ...context, attestations: [] })).valid, false);
    assert.equal((await validateAutomaticValidationRecord(fixture.record, { ...context, validatorRegistry: null })).valid, false);

    const unknown = clone(context.attestations) as { profileHash: string }[];
    unknown[0].profileHash = `svp_${'f'.repeat(64)}`;
    assert.equal((await validateAutomaticValidationRecord(fixture.record, { ...context, attestations: unknown })).valid, false);
  });
});

describe('자동 검증 기록 · fail-closed', () => {
  it('실행되지 않은 항목은 막는다(사실대로 적었어도)', async () => {
    const fixture = await existingFixture();
    const notRun = await truthfullyFail(fixture.record, (record) => { record.checks.corpusRegression.status = 'not_run'; });
    const result = await check(fixture, notRun);
    assert.equal(result.valid, true);
    assert.ok(result.activationBlockers.length > 0);
  });

  it('규칙상 실패인데 통과로 적은 기록은 무효다(각 항목)', async () => {
    const fixture = await existingFixture();
    const lies: [string, (record: AutomaticValidationRecord) => void][] = [
      ['수요 부족', (record) => { record.checks.demandSignal.payload.dailyCounts.forEach((item) => { item.count = 0; }); }],
      ['활동일 부족', (record) => { record.checks.demandSignal.payload.dailyCounts.slice(2).forEach((item) => { item.count = 0; }); }],
      ['안전 위반', (record) => { record.checks.safetyBoundary.payload.cases[0].observedRoute = 'recommend'; }],
      ['안전 사례 없음', (record) => { record.checks.safetyBoundary.payload.cases = []; }],
      ['중복 수 조작', (record) => { record.checks.duplicateCheck.payload.overlaps.push({ cardId: 'SC-052', passageIndex: 0, overlapsCardId: 'SC-001' }); }],
      ['회귀 사례', (record) => { record.checks.corpusRegression.payload.cases[1].candidate.domainMatch = false; }],
      ['안전 오탐 증가', (record) => { record.checks.corpusRegression.payload.cases[0].candidate.safetyFalsePositive = true; }],
      ['acceptable 하락', (record) => { record.checks.corpusRegression.payload.cases[1].candidate.acceptableMatch = false; }],
      ['생성 평가 부족', (record) => { record.checks.candidateGenerationEvaluation.payload.cases = record.checks.candidateGenerationEvaluation.payload.cases.slice(0, 2); }],
      ['생성 평가 실패', (record) => { record.checks.candidateGenerationEvaluation.payload.cases[0].passed = false; }],
      ['독립 평가 반대', (record) => { record.checks.contextTheologyReview.payload.evaluations[1].cardEvaluations[0].criteria[0].verdict = 'fail'; }],
      ['같은 평가자', (record) => { record.checks.contextTheologyReview.payload.evaluations[1].profileHash = record.checks.contextTheologyReview.payload.evaluations[0].profileHash; }],
      ['본문 수 불일치', (record) => { record.checks.passageExistence.payload.passages = []; }],
    ];
    for (const [label, mutate] of lies) {
      const broken = clone(fixture.record);
      mutate(broken);
      const result = await check(fixture, broken);
      assert.equal(result.valid, false, label);
    }
  });

  it('사실대로 실패로 적은 기록은 유효하지만 활성화를 막는다', async () => {
    const fixture = await existingFixture();
    const failures: [string, (record: AutomaticValidationRecord) => void][] = [
      ['수요 부족', (record) => {
        record.checks.demandSignal.payload.dailyCounts.forEach((item) => { item.count = 0; });
        record.checks.demandSignal.status = 'fail';
      }],
      ['안전 위반', (record) => { record.checks.safetyBoundary.payload.cases[0].observedRoute = 'recommend'; record.checks.safetyBoundary.status = 'fail'; }],
      ['독립 평가 반대', (record) => {
        record.checks.contextTheologyReview.payload.evaluations[1].cardEvaluations[0].criteria[0].verdict = 'fail';
        record.checks.contextTheologyReview.status = 'fail';
      }],
      ['평가자 하나뿐', (record) => {
        record.checks.contextTheologyReview.payload.evaluations = record.checks.contextTheologyReview.payload.evaluations.slice(0, 1);
        record.modelIdentifiers.evaluators = ['fixture-eval-model-a'];
        record.checks.contextTheologyReview.status = 'fail';
      }],
    ];
    for (const [label, mutate] of failures) {
      const record = await truthfullyFail(fixture.record, mutate);
      const result = await check(fixture, record);
      assert.equal(result.valid, true, `${label}: ${result.errors.join(' / ')}`);
      assert.ok(result.activationBlockers.length > 0, label);
    }
  });

  it('항목 하나가 실패인데 전체를 통과로 적으면 무효다', async () => {
    const fixture = await existingFixture();
    const broken = clone(fixture.record);
    broken.checks.safetyBoundary.payload.cases[0].observedRoute = 'recommend';
    broken.checks.safetyBoundary.status = 'fail';
    broken.overallStatus = 'pass';
    assert.equal((await check(fixture, broken)).valid, false);
  });

  it('개역한글 본문 지문이 원문과 다르면 무효다', async () => {
    const fixture = await existingFixture();
    const broken = clone(fixture.record);
    broken.checks.krvTextMatch.payload.passageTextHashes[0].textHash = `sart_${'d'.repeat(64)}`;
    assert.equal((await check(fixture, broken)).valid, false);
  });

  it('원문을 읽을 수 없으면(resolver 없음·실패·절 누락) 통과시키지 않는다', async () => {
    const fixture = await existingFixture();

    const noResolver = await check(fixture, fixture.record, null as never);
    assert.equal(noResolver.valid && noResolver.activationBlockers.length === 0, false);

    const throwing = await check(fixture, fixture.record, (() => {
      throw new Error('읽기 실패');
    }) as never);
    assert.equal(throwing.valid, false);

    const missingVerse = await check(fixture, fixture.record, ((passage: never) => resolveKrvPassage(passage)?.slice(1) ?? null) as never);
    assert.equal(missingVerse.valid, false);
  });

  it('개역한글 데이터 버전이 다르면 무효다', async () => {
    const fixture = await existingFixture();
    const broken = clone(fixture.record);
    broken.dataVersions.bibleSourceSha256 = '0'.repeat(64);
    assert.equal((await check(fixture, broken)).valid, false);
  });

  it('수요 신호의 영역이 후보 종류와 맞지 않으면 무효다', async () => {
    const fixture = await existingFixture();
    const broken = clone(fixture.record);
    broken.checks.demandSignal.payload.subjectKey = 'other_uncovered';
    assert.equal((await check(fixture, broken)).valid, false);

    const incompleteWindow = clone(fixture.record);
    incompleteWindow.checks.demandSignal.payload.dailyCounts.pop();
    assert.equal((await check(fixture, incompleteWindow)).valid, false);
  });

  it('기존 카드와 본문이 겹치는 후보는 중복을 다시 세어 드러낸다', async () => {
    const base = buildBaselineCatalog();
    const { candidate } = await makeExistingDomainCandidate(base);
    const { baseVersionHash: _b, proposedVersionHash: _p, ...draft } = clone(candidate);
    draft.cards[0].passages = [{ book: 'Proverbs', chapter: 3, startVerse: 6, endVerse: 7 }];
    draft.cards[0].referenceLabel = '잠언 3:6–7';
    const overlapping = await finalizeCandidate(base, draft);
    const fixture: Fixture = {
      base,
      candidate: overlapping.candidate,
      candidateHash: overlapping.candidateHash,
      record: await makePassingValidationRecord(overlapping.candidate, overlapping.candidateHash, base),
    };

    const lie = await check(fixture, fixture.record);
    assert.equal(lie.valid, false, '겹치는데 0으로 적은 기록이 통과했습니다.');

    const truthful = await truthfullyFail(fixture.record, (record) => {
      record.checks.duplicateCheck.payload = {
        ...record.checks.duplicateCheck.payload,
        ...record.checks.duplicateCheck.payload,
        overlaps: [{ cardId: overlapping.candidate.cards[0].id, passageIndex: 0, overlapsCardId: 'SC-002' }],
      };
      record.checks.duplicateCheck.status = 'fail';
    });
    const result = await check(fixture, truthful);
    assert.equal(result.valid, true, result.errors.join(' / '));
    assert.ok(result.activationBlockers.some((reason) => reason.startsWith('duplicateCheck')));
  });

  it('어떤 이상한 값이 와도 예외 없이 무효로 끝난다', async () => {
    const fixture = await existingFixture();
    for (const value of [null, 1, 'x', [], { checks: [] }]) {
      assert.equal((await check(fixture, value)).valid, false);
    }
  });
});

/**
 * 아래 네 가지는 서로 겹치는 다른 확인에 가려지기 쉽다.
 * 예를 들어 artifactHash만 바꾸면 attestation 대조에서도 걸리므로, 지문 재계산이 사라져도 기록은 여전히 거절된다.
 * 그래서 각 규칙 하나만 어긋나게 만들고, 그 규칙이 내는 오류 문구를 직접 확인한다.
 * 규칙을 지우면 이 테스트만 실패한다(구현을 베껴 통과시키는 테스트가 아니라는 증거다).
 */
describe('자동 검증 기록 · 겹침에 가려지지 않는 단일 규칙', () => {
  it('payload만 고치고 artifactHash·attestation을 그대로 두면, 지문 재계산이 잡는다', async () => {
    const fixture = await existingFixture();
    const tampered = clone(fixture.record);
    tampered.checks.safetyBoundary.payload.rulesVersion = 'tampered-rules/v9';
    // artifactHash를 다시 봉인하지 않는다. attestation은 그 옛 지문에 그대로 묶여 있다.
    const context = validationContextFor(fixture);
    assert.equal(tampered.checks.safetyBoundary.artifactHash, fixture.record.checks.safetyBoundary.artifactHash);

    const result = await validateAutomaticValidationRecord(tampered, context);
    assert.equal(result.valid, false);
    assert.ok(
      result.errors.some((error) => error === 'validation.checks.safetyBoundary.artifactHash: payload에서 다시 계산한 지문과 다릅니다.'),
      result.errors.join(' / '),
    );
  });

  it('한 항목의 attestation만 빠져도 무효다(다른 항목은 그대로 있다)', async () => {
    const fixture = await existingFixture();
    const context = validationContextFor(fixture);
    const withoutOne = context.attestations.filter((item) => (item as { checkName: string }).checkName !== 'safetyBoundary');
    assert.equal(withoutOne.length, context.attestations.length - 1);

    const result = await validateAutomaticValidationRecord(fixture.record, { ...context, attestations: withoutOne });
    assert.equal(result.valid, false);
    assert.ok(
      result.errors.some((error) => error === 'safetyBoundary: 등록된 validator의 attestation이 없습니다.'),
      result.errors.join(' / '),
    );
  });

  it('attestation 판정이 기록된 결과와 다르면 무효다', async () => {
    const fixture = await existingFixture();
    const context = validationContextFor(fixture);
    const flipped = clone(context.attestations) as { checkName: string; verdict: string }[];
    const target = flipped.find((item) => item.checkName === 'safetyBoundary')!;
    target.verdict = 'fail';

    const result = await validateAutomaticValidationRecord(fixture.record, { ...context, attestations: flipped });
    assert.equal(result.valid, false);
    assert.ok(
      result.errors.some((error) => error.endsWith('기록된 결과와 attestation 판정이 다릅니다.')),
      result.errors.join(' / '),
    );
  });

  it('본문 지문은 위치와 원문 글자에 함께 묶인다(상수·위치 무관 지문을 막는다)', async () => {
    const here = { book: 'Proverbs', chapter: 16, startVerse: 1, endVerse: 3 } as const;
    const there = { book: 'Proverbs', chapter: 16, startVerse: 4, endVerse: 6 } as const;
    const hereText = resolveKrvPassage(here)!;
    const thereText = resolveKrvPassage(there)!;

    // 원문이 다르면 지문도 다르고, 같은 원문이라도 위치가 다르면 지문이 다르다.
    assert.notEqual(await computePassageTextHash(here, hereText), await computePassageTextHash(here, thereText));
    assert.notEqual(await computePassageTextHash(here, hereText), await computePassageTextHash(there, hereText));
    assert.equal(await computePassageTextHash(here, hereText), await computePassageTextHash(here, resolveKrvPassage(here)!));
  });

  it('올바른 위치에 다른 절의 원문으로 만든 지문을 넣으면, 원문 재계산이 잡는다', async () => {
    const fixture = await existingFixture();
    const wrongVerses = resolveKrvPassage({ book: 'Proverbs', chapter: 16, startVerse: 4, endVerse: 6 })!;
    const candidatePassage = fixture.candidate.cards[0].passages[0];
    const forged = clone(fixture.record);
    forged.checks.krvTextMatch.payload.passageTextHashes[0].textHash = await computePassageTextHash(candidatePassage, wrongVerses);
    await resealRecord(forged);

    const result = await validateAutomaticValidationRecord(forged, validationContextFor({ ...fixture, record: forged }));
    assert.equal(result.valid, false);
    assert.ok(
      result.errors.some((error) => error === 'krvTextMatch: payload로는 실패인데 통과로 기록됐습니다.'),
      result.errors.join(' / '),
    );
  });

  it('해시가 스스로와는 맞아도, 절 번호가 밀린 본문을 pass로 적으면 무효다(같은 resolver를 build·검증 양쪽에 써도)', async () => {
    // 해시 비교만으로는 못 잡는 경우를 만든다: 기록을 지을 때도, 다시 검증할 때도
    // 똑같이 "한 절씩 밀려 있는" resolver를 쓴다. 그러면 지문은 자기 자신과 맞아떨어진다.
    // 그런데도 실제로 돌아온 절 번호가 청구한 위치(startVerse부터 이어지는 번호)와 다르면
    // krvTextMatch를 pass로 적은 것은 사실과 다른 기록이어야 한다.
    const shiftedResolver = ((passage: { startVerse: number; endVerse: number }) => {
      const verses = resolveKrvPassage(passage as never);
      return verses ? verses.map((verse) => ({ ...verse, verse: verse.verse + 1 })) : null;
    }) as typeof resolveKrvPassage;

    const fixture = await existingFixture();
    const passage = fixture.candidate.cards[0].passages[0];
    const shiftedVerses = shiftedResolver(passage)!;
    const forged = clone(fixture.record);
    forged.checks.krvTextMatch.payload.passageTextHashes[0].textHash = await computePassageTextHash(passage, shiftedVerses);
    await resealRecord(forged);

    const result = await check({ ...fixture, record: forged }, forged, shiftedResolver);
    assert.equal(result.valid, false);
    assert.ok(
      result.errors.some((error) => error === 'krvTextMatch: payload로는 실패인데 통과로 기록됐습니다.'),
      result.errors.join(' / '),
    );
  });

  it('본문이 없다고 나온 절을 pass로 적으면 무효다(절 수는 맞아도 글자가 비어 있다)', async () => {
    const emptyTextResolver = ((passage: { startVerse: number; endVerse: number }) => {
      const verses = resolveKrvPassage(passage as never);
      return verses ? verses.map((verse) => ({ ...verse, text: '' })) : null;
    }) as typeof resolveKrvPassage;

    const fixture = await existingFixture();
    const passage = fixture.candidate.cards[0].passages[0];
    const emptyVerses = emptyTextResolver(passage)!;
    const forged = clone(fixture.record);
    forged.checks.krvTextMatch.payload.passageTextHashes[0].textHash = await computePassageTextHash(passage, emptyVerses);
    await resealRecord(forged);

    const result = await check({ ...fixture, record: forged }, forged, emptyTextResolver);
    assert.equal(result.valid, false);
    assert.ok(
      result.errors.some((error) => error === 'krvTextMatch: payload로는 실패인데 통과로 기록됐습니다.'),
      result.errors.join(' / '),
    );
  });

  it('산출물 지문에는 항목 이름이 함께 들어간다(payload를 항목끼리 바꿔 끼우지 못한다)', async () => {
    const payload = { rulesVersion: 'x/v1', cases: [] };
    assert.notEqual(
      await computeCheckArtifactHash('safetyBoundary', payload),
      await computeCheckArtifactHash('duplicateCheck', payload),
    );
  });

  it('수요 evidence가 다른 주제 지문을 가리키면 무효다(기간·가림·기준은 그대로 맞다)', async () => {
    const base = buildBaselineCatalog();
    const { candidate, candidateHash } = await makeNewDomainCandidate(base);
    const record = await makePassingValidationRecord(candidate, candidateHash, base);
    record.checks.demandSignal.payload.subjectKey = await computeThemeFingerprint('another_theme');
    await resealRecord(record);

    const result = await validateAutomaticValidationRecord(record, validationContextFor({ candidate, base, record }));
    assert.equal(result.valid, false);
    assert.ok(
      result.errors.some((error) => error === 'demandSignal.payload.subjectKey: 후보의 영역·주제 지문과 다릅니다.'),
      result.errors.join(' / '),
    );
  });

  // 아래 세 건은 artifactHash를 다시 봉인해(resealRecord) hash-불일치 검사에 가려지지 않게 한다.
  // 그래야 criterion 순서·모양·카드 id 대조 하나하나가 실제로 잡는지 볼 수 있다.
  it('criterion 순서가 뒤바뀌면(같은 criterion 집합이어도) 무효다', async () => {
    const fixture = await existingFixture();
    const tampered = clone(fixture.record);
    tampered.checks.contextTheologyReview.payload.evaluations[1].cardEvaluations[0].criteria.reverse();
    await resealRecord(tampered);

    const result = await validateAutomaticValidationRecord(tampered, validationContextFor({ ...fixture, record: tampered }));
    assert.equal(result.valid, false);
    assert.ok(
      result.errors.some((error) => error.includes('criteria: rubric의 criterion') && error.includes('정확한 순서')),
      result.errors.join(' / '),
    );
  });

  it('카드 평가에 여분 필드가 있으면 무효다', async () => {
    const fixture = await existingFixture();
    const tampered = clone(fixture.record);
    (tampered.checks.contextTheologyReview.payload.evaluations[1].cardEvaluations[0] as unknown as Record<string, unknown>).extra = true;
    await resealRecord(tampered);

    const result = await validateAutomaticValidationRecord(tampered, validationContextFor({ ...fixture, record: tampered }));
    assert.equal(result.valid, false);
    assert.ok(
      result.errors.some((error) => error.includes('cardEvaluations[0]: 모양이 맞지 않습니다.')),
      result.errors.join(' / '),
    );
  });

  it('카드 평가의 cardId가 후보 카드와 다르면 무효다', async () => {
    const fixture = await existingFixture();
    const tampered = clone(fixture.record);
    tampered.checks.contextTheologyReview.payload.evaluations[1].cardEvaluations[0].cardId = 'SC-999';
    await resealRecord(tampered);

    const result = await validateAutomaticValidationRecord(tampered, validationContextFor({ ...fixture, record: tampered }));
    assert.equal(result.valid, false);
    assert.ok(
      result.errors.some((error) => error.includes('cardEvaluations: 후보 카드마다 한 번씩, 순서대로')),
      result.errors.join(' / '),
    );
  });
});

/* ================================================================== */
/* 참조 의미: 보관 · 활성화 · 롤백                                       */
/* ================================================================== */

type Prepared = Fixture & { state: CatalogLedgerState; baseHash: string; validationHash: string };

async function prepare(record?: (fixture: Fixture) => AutomaticValidationRecord | Promise<AutomaticValidationRecord>): Promise<Prepared> {
  const fixture = await existingFixture();
  const finalRecord = record ? await record(fixture) : fixture.record;
  const baseline = await planBaselineRegistration(EMPTY_CATALOG_LEDGER, { requestId: requestId(1), catalog: fixture.base });
  assert.ok(baseline.ok);
  const evidenceState: CatalogLedgerState = {
    ...baseline.state,
    researchResultHashes: [FIXTURE_RESEARCH_RESULT_HASH],
    demandCells: makeDemandCells(fixture.candidate.demandBinding),
  };
  const stored = await planStoreCandidate(evidenceState, { candidateHash: fixture.candidateHash, candidate: fixture.candidate });
  assert.ok(stored.ok, stored.ok ? '' : stored.errors.join(' / '));
  const validationHash = await computeValidationHash(finalRecord);
  const attestations = makeAttestations(finalRecord);
  const validation = await planStoreValidation(
    stored.state,
    { validationHash, candidateHash: fixture.candidateHash, record: finalRecord, attestations },
    { resolvePassageText: resolveKrvPassage, validatorRegistry: FIXTURE_VALIDATOR_REGISTRY },
  );
  assert.ok(validation.ok, validation.ok ? '' : validation.errors.join(' / '));
  return { ...fixture, record: finalRecord, state: validation.state, baseHash: baseline.value.versionHash, validationHash };
}

const activate = (prepared: Prepared, overrides: Partial<Parameters<typeof planActivation>[1]> = {}, resolver = resolveKrvPassage) =>
  planActivation(
    prepared.state,
    {
      requestId: requestId(10),
      candidateHash: prepared.candidateHash,
      validationHash: prepared.validationHash,
      expectedActiveVersionHash: prepared.baseHash,
      activationDate: FIXTURE_ACTIVATION_DATE,
      ...overrides,
    },
    { resolvePassageText: resolver, validatorRegistry: FIXTURE_VALIDATOR_REGISTRY },
  );

/** 실패한 계획이 상태를 전혀 바꾸지 않았는지 확인한다. */
function assertUnchanged(before: CatalogLedgerState, snapshot: string) {
  assert.equal(canonicalJson(before), snapshot, '실패한 요청이 상태를 바꿨습니다.');
}

describe('참조 의미 · 기준 카탈로그 등록', () => {
  it('첫 판을 등록하면 포인터·등록 기록·공지가 함께 생긴다', async () => {
    const base = buildBaselineCatalog();
    const result = await planBaselineRegistration(EMPTY_CATALOG_LEDGER, { requestId: requestId(1), catalog: base });
    assert.ok(result.ok);
    assert.equal(result.state.pointerRevision, 1);
    assert.equal(result.state.activeVersionHash, result.value.versionHash);
    assert.equal(result.state.notifications.length, 1);
    assert.equal(result.state.notifications[0].kind, 'baseline_registered');
    assert.equal(result.state.versions[result.value.versionHash].parentVersionHash, null);
  });

  it('같은 요청 재실행은 멱등이고, 다른 요청으로 두 번째 등록은 거절한다', async () => {
    const base = buildBaselineCatalog();
    const first = await planBaselineRegistration(EMPTY_CATALOG_LEDGER, { requestId: requestId(1), catalog: base });
    assert.ok(first.ok);
    const replay = await planBaselineRegistration(first.state, { requestId: requestId(1), catalog: base });
    assert.ok(replay.ok && replay.replayed && replay.state === first.state);

    const second = await planBaselineRegistration(first.state, { requestId: requestId(2), catalog: base });
    assert.equal(second.ok, false);
    assert.equal(!second.ok && second.code, 'baseline_already_registered');
  });

  it('유효하지 않은 카탈로그나 요청 번호는 등록하지 않는다', async () => {
    const base = buildBaselineCatalog();
    assert.equal((await planBaselineRegistration(EMPTY_CATALOG_LEDGER, { requestId: 'bad', catalog: base })).ok, false);
    const broken = clone(base);
    broken.cards = [];
    assert.equal((await planBaselineRegistration(EMPTY_CATALOG_LEDGER, { requestId: requestId(1), catalog: broken })).ok, false);
  });
});

describe('참조 의미 · 비식별 수요 집계', () => {
  it('기존 영역의 약한 매칭은 활성 카탈로그의 실제 영역만 날짜별로 1씩 센다', async () => {
    const base = buildBaselineCatalog();
    const baseline = await planBaselineRegistration(EMPTY_CATALOG_LEDGER, { requestId: requestId(1), catalog: base });
    assert.ok(baseline.ok);
    const first = planRecordDemandObservation(baseline.state, {
      evidenceKind: 'weak_match',
      subjectKey: 'decision_guidance',
      bucketDate: '2026-09-01',
    });
    assert.ok(first.ok && first.value.count === 1);
    const second = planRecordDemandObservation(first.state, {
      evidenceKind: 'weak_match',
      subjectKey: 'decision_guidance',
      bucketDate: '2026-09-01',
    });
    assert.ok(second.ok && second.value.count === 2);
    assert.equal(first.state.demandCells[0].count, 1, '이전 상태를 직접 바꾸면 안 됩니다.');

    const unknown = planRecordDemandObservation(second.state, {
      evidenceKind: 'weak_match',
      subjectKey: 'not_in_active_catalog',
      bucketDate: '2026-09-01',
    });
    assert.equal(!unknown.ok && unknown.code, 'invalid_request');
  });

  it('새 영역 주제는 정규화된 지문만 세고 사용자 문장이나 임의 문자열은 받지 않는다', async () => {
    const base = buildBaselineCatalog();
    const { candidate } = await makeNewDomainCandidate(base);
    assert.equal(candidate.demandBinding.kind, 'normalized_theme');
    if (candidate.demandBinding.kind !== 'normalized_theme') return;
    const accepted = planRecordDemandObservation(EMPTY_CATALOG_LEDGER, {
      evidenceKind: 'normalized_theme',
      subjectKey: candidate.demandBinding.themeFingerprint,
      bucketDate: '2026-09-01',
    });
    assert.ok(accepted.ok && accepted.value.count === 1);
    const rawText = planRecordDemandObservation(EMPTY_CATALOG_LEDGER, {
      evidenceKind: 'normalized_theme',
      subjectKey: '가족을 오래 돌보느라 힘들어요',
      bucketDate: '2026-09-01',
    });
    assert.equal(!rawText.ok && rawText.code, 'invalid_request');
  });
});

describe('참조 의미 · 후보와 검증 기록 보관', () => {
  it('후보를 적으면 결과 버전이 기준 버전을 부모로 함께 적힌다. 재전송은 멱등이다', async () => {
    const prepared = await prepare();
    const version = prepared.state.versions[prepared.candidate.proposedVersionHash];
    assert.equal(version.parentVersionHash, prepared.baseHash);
    const replay = await planStoreCandidate(prepared.state, { candidateHash: prepared.candidateHash, candidate: prepared.candidate });
    assert.ok(replay.ok && replay.replayed && replay.state === prepared.state);
  });

  it('지문이 내용과 다른 후보, 기준 버전이 없는 후보는 적지 않는다', async () => {
    const prepared = await prepare();
    const tampered = clone(prepared.candidate);
    tampered.cards[0].userExplanation = '지문을 그대로 두고 바꾼 문장입니다.';
    const result = await planStoreCandidate(prepared.state, { candidateHash: prepared.candidateHash, candidate: tampered });
    assert.equal(result.ok, false);

    const orphan = await planStoreCandidate(EMPTY_CATALOG_LEDGER, { candidateHash: prepared.candidateHash, candidate: prepared.candidate });
    assert.equal(!orphan.ok && orphan.code, 'not_found');
  });

  it('사실대로 실패한 검증 기록도 증거로 남긴다. 거짓 기록은 남기지 않는다', async () => {
    const failing = await prepare((fixture) =>
      truthfullyFail(fixture.record, (record) => {
        record.checks.safetyBoundary.payload.cases[0].observedRoute = 'recommend';
        record.checks.safetyBoundary.status = 'fail';
      }),
    );
    assert.equal(Object.keys(failing.state.validations).length, 1);

    const fixture = await existingFixture();
    const liar = clone(fixture.record);
    liar.checks.safetyBoundary.payload.cases[0].observedRoute = 'recommend';
    const state = (await prepare()).state;
    const result = await planStoreValidation(
      state,
      {
        validationHash: await computeValidationHash(liar),
        candidateHash: fixture.candidateHash,
        record: liar,
        attestations: makeAttestations(liar),
      },
      { resolvePassageText: resolveKrvPassage, validatorRegistry: FIXTURE_VALIDATOR_REGISTRY },
    );
    assert.equal(!result.ok && result.code, 'invalid_evidence');
  });
});

describe('참조 의미 · 활성화 (원자성·멱등성·fail-closed)', () => {
  it('모든 검증을 통과하면 활성화 기록·포인터 전환·공지가 한 번에 함께 생긴다', async () => {
    const prepared = await prepare();
    const result = await activate(prepared);
    assert.ok(result.ok, result.ok ? '' : result.errors.join(' / '));
    assert.equal(result.state.activeVersionHash, prepared.candidate.proposedVersionHash);
    assert.equal(result.state.pointerRevision, 2);
    assert.equal(result.state.activations.length, 1);
    assert.equal(result.state.notifications.length, 2);
    assert.equal(result.value.authority, AUTOMATED_VALIDATION_AUTHORITY);
    assert.equal(result.value.pointerRevision, result.state.pointerRevision);
    const notice = result.state.notifications[1];
    assert.equal(notice.kind, 'catalog_activated');
    assert.equal(notice.pointerRevision, 2);
    assert.equal(notice.toVersionHash, prepared.candidate.proposedVersionHash);
  });

  it('활성화 계획은 입력 상태를 바꾸지 않는다', async () => {
    const prepared = await prepare();
    const snapshot = canonicalJson(prepared.state);
    const result = await activate(prepared);
    assert.ok(result.ok);
    assertUnchanged(prepared.state, snapshot);
  });

  it('검증 항목이 하나라도 실패·미실행이면 활성화하지 않고 상태를 그대로 둔다', async () => {
    for (const name of REQUIRED_VALIDATION_CHECKS) {
      const prepared = await prepare((fixture) =>
        truthfullyFail(fixture.record, (record) => { record.checks[name].status = 'not_run'; }),
      );
      const snapshot = canonicalJson(prepared.state);
      const result = await activate(prepared);
      assert.equal(result.ok, false, name);
      assert.equal(!result.ok && result.code, 'validation_blocked', name);
      assertUnchanged(prepared.state, snapshot);
      assert.equal(prepared.state.activeVersionHash, prepared.baseHash);
    }
  });

  it('독립 평가가 합의하지 않으면 활성화하지 않는다', async () => {
    const prepared = await prepare((fixture) =>
      truthfullyFail(fixture.record, (record) => {
        record.checks.contextTheologyReview.payload.evaluations[0].cardEvaluations[0].criteria[0].verdict = 'fail';
        record.checks.contextTheologyReview.status = 'fail';
      }),
    );
    const result = await activate(prepared);
    assert.equal(!result.ok && result.code, 'validation_blocked');
  });

  it('활성화 순간에 원문을 다시 확인하지 못하면 활성화하지 않는다', async () => {
    const prepared = await prepare();
    const snapshot = canonicalJson(prepared.state);
    const result = await activate(prepared, {}, null as never);
    assert.equal(result.ok, false);
    assertUnchanged(prepared.state, snapshot);
  });

  it('활성화 순간에 연구 결과나 실제 수요 집계가 사라지거나 기간이 끝나지 않았으면 막는다', async () => {
    const prepared = await prepare();
    const withoutResearch: CatalogLedgerState = { ...prepared.state, researchResultHashes: [] };
    const researchResult = await planActivation(
      withoutResearch,
      {
        requestId: requestId(10),
        candidateHash: prepared.candidateHash,
        validationHash: prepared.validationHash,
        expectedActiveVersionHash: prepared.baseHash,
        activationDate: FIXTURE_ACTIVATION_DATE,
      },
      { resolvePassageText: resolveKrvPassage, validatorRegistry: FIXTURE_VALIDATOR_REGISTRY },
    );
    assert.equal(!researchResult.ok && researchResult.code, 'research_result_missing');

    const withoutDemand: CatalogLedgerState = { ...prepared.state, demandCells: [] };
    const demandResult = await planActivation(
      withoutDemand,
      {
        requestId: requestId(10),
        candidateHash: prepared.candidateHash,
        validationHash: prepared.validationHash,
        expectedActiveVersionHash: prepared.baseHash,
        activationDate: FIXTURE_ACTIVATION_DATE,
      },
      { resolvePassageText: resolveKrvPassage, validatorRegistry: FIXTURE_VALIDATOR_REGISTRY },
    );
    assert.equal(!demandResult.ok && demandResult.code, 'demand_evidence_mismatch');

    const unfinished = await activate(prepared, { activationDate: '2026-08-30' });
    assert.equal(!unfinished.ok && unfinished.code, 'demand_evidence_mismatch');
  });

  it('적어 둔 검증 기록이 나중에 바뀌어 있으면 믿지 않고 멈춘다', async () => {
    const prepared = await prepare();
    const tamperedRecord = clone(prepared.record);
    tamperedRecord.checks.safetyBoundary.payload.cases[0].observedRoute = 'recommend';
    const tamperedState: CatalogLedgerState = {
      ...prepared.state,
      validations: {
        ...prepared.state.validations,
        [prepared.validationHash]: {
          candidateHash: prepared.candidateHash,
          record: tamperedRecord,
          attestations: prepared.state.validations[prepared.validationHash].attestations,
        },
      },
    };
    const result = await planActivation(
      tamperedState,
      {
        requestId: requestId(10),
        candidateHash: prepared.candidateHash,
        validationHash: prepared.validationHash,
        expectedActiveVersionHash: prepared.baseHash,
        activationDate: FIXTURE_ACTIVATION_DATE,
      },
      { resolvePassageText: resolveKrvPassage, validatorRegistry: FIXTURE_VALIDATOR_REGISTRY },
    );
    assert.equal(!result.ok && result.code, 'invalid_evidence');
  });

  it('기대한 활성 버전이 다르면 활성화하지 않는다', async () => {
    const prepared = await prepare();
    const result = await activate(prepared, { expectedActiveVersionHash: `scat_${'e'.repeat(64)}` });
    assert.equal(!result.ok && result.code, 'stale_active_version');
  });

  it('후보의 기준 버전이 이미 활성이 아니면(다른 후보가 먼저 활성화됨) 활성화하지 않는다', async () => {
    const prepared = await prepare();
    const second = await makeExistingDomainCandidate(prepared.base, 'SC-099');
    const storedSecond = await planStoreCandidate(prepared.state, { candidateHash: second.candidateHash, candidate: second.candidate });
    assert.ok(storedSecond.ok);
    const secondRecord = await makePassingValidationRecord(second.candidate, second.candidateHash, prepared.base);
    const secondValidationHash = await computeValidationHash(secondRecord);
    const storedValidation = await planStoreValidation(
      storedSecond.state,
      {
        validationHash: secondValidationHash,
        candidateHash: second.candidateHash,
        record: secondRecord,
        attestations: makeAttestations(secondRecord),
      },
      { resolvePassageText: resolveKrvPassage, validatorRegistry: FIXTURE_VALIDATOR_REGISTRY },
    );
    assert.ok(storedValidation.ok);

    const first = await planActivation(
      storedValidation.state,
      {
        requestId: requestId(10),
        candidateHash: prepared.candidateHash,
        validationHash: prepared.validationHash,
        expectedActiveVersionHash: prepared.baseHash,
        activationDate: FIXTURE_ACTIVATION_DATE,
      },
      { resolvePassageText: resolveKrvPassage, validatorRegistry: FIXTURE_VALIDATOR_REGISTRY },
    );
    assert.ok(first.ok);

    const late = await planActivation(
      first.state,
      {
        requestId: requestId(11),
        candidateHash: second.candidateHash,
        validationHash: secondValidationHash,
        expectedActiveVersionHash: first.state.activeVersionHash!,
        activationDate: FIXTURE_ACTIVATION_DATE,
      },
      { resolvePassageText: resolveKrvPassage, validatorRegistry: FIXTURE_VALIDATOR_REGISTRY },
    );
    assert.equal(!late.ok && late.code, 'stale_active_version');
  });

  it('같은 요청 재실행은 같은 결과를 돌려주고 기록·공지를 늘리지 않는다', async () => {
    const prepared = await prepare();
    const first = await activate(prepared);
    assert.ok(first.ok);
    const replay = await planActivation(
      first.state,
      {
        requestId: requestId(10),
        candidateHash: prepared.candidateHash,
        validationHash: prepared.validationHash,
        expectedActiveVersionHash: prepared.baseHash,
        activationDate: FIXTURE_ACTIVATION_DATE,
      },
      { resolvePassageText: resolveKrvPassage, validatorRegistry: FIXTURE_VALIDATOR_REGISTRY },
    );
    assert.ok(replay.ok && replay.replayed);
    assert.equal(replay.state, first.state);
    assert.equal(replay.state.notifications.length, 2);
  });

  it('같은 요청 번호로 다른 내용을 보내면 거절한다', async () => {
    const prepared = await prepare();
    const first = await activate(prepared);
    assert.ok(first.ok);
    const conflict = await planActivation(
      first.state,
      {
        requestId: requestId(10),
        candidateHash: prepared.candidateHash,
        validationHash: prepared.validationHash,
        expectedActiveVersionHash: first.state.activeVersionHash!,
        activationDate: FIXTURE_ACTIVATION_DATE,
      },
      { resolvePassageText: resolveKrvPassage, validatorRegistry: FIXTURE_VALIDATOR_REGISTRY },
    );
    assert.equal(!conflict.ok && conflict.code, 'idempotency_conflict');
  });

  it('같은 후보를 새 요청 번호로 다시 활성화할 수 없다', async () => {
    const prepared = await prepare();
    const first = await activate(prepared);
    assert.ok(first.ok);
    const rolledBack = await planRollback(first.state, {
      requestId: requestId(20),
      targetVersionHash: prepared.baseHash,
      expectedActiveVersionHash: first.state.activeVersionHash!,
      reasonCode: 'regression_detected',
    });
    assert.ok(rolledBack.ok);
    const again = await planActivation(
      rolledBack.state,
      {
        requestId: requestId(12),
        candidateHash: prepared.candidateHash,
        validationHash: prepared.validationHash,
        expectedActiveVersionHash: prepared.baseHash,
        activationDate: FIXTURE_ACTIVATION_DATE,
      },
      { resolvePassageText: resolveKrvPassage, validatorRegistry: FIXTURE_VALIDATOR_REGISTRY },
    );
    assert.equal(!again.ok && again.code, 'already_activated');
  });

  it('다른 후보의 검증 기록으로는 활성화하지 않는다', async () => {
    const prepared = await prepare();
    const result = await activate(prepared, { validationHash: `scval_${'f'.repeat(64)}` });
    assert.equal(!result.ok && result.code, 'not_found');
  });

  it('기준 카탈로그가 없으면 활성화하지 않는다', async () => {
    const prepared = await prepare();
    const result = await planActivation(
      EMPTY_CATALOG_LEDGER,
      {
        requestId: requestId(10),
        candidateHash: prepared.candidateHash,
        validationHash: prepared.validationHash,
        expectedActiveVersionHash: prepared.baseHash,
        activationDate: FIXTURE_ACTIVATION_DATE,
      },
      { resolvePassageText: resolveKrvPassage, validatorRegistry: FIXTURE_VALIDATOR_REGISTRY },
    );
    assert.equal(!result.ok && result.code, 'baseline_missing');
  });
});

describe('참조 의미 · 롤백', () => {
  async function activated() {
    const prepared = await prepare();
    const result = await activate(prepared);
    assert.ok(result.ok);
    return { prepared, state: result.state, activeHash: result.state.activeVersionHash! };
  }

  it('이전 활성 버전으로 되돌리면 롤백 기록·포인터 전환·공지가 함께 생긴다', async () => {
    const { prepared, state, activeHash } = await activated();
    const result = await planRollback(state, {
      requestId: requestId(20),
      targetVersionHash: prepared.baseHash,
      expectedActiveVersionHash: activeHash,
      reasonCode: 'safety_concern',
    });
    assert.ok(result.ok, result.ok ? '' : result.errors.join(' / '));
    assert.equal(result.state.activeVersionHash, prepared.baseHash);
    assert.equal(result.state.pointerRevision, 3);
    assert.equal(result.value.authority, AUTOMATED_OPERATIONS_AUTHORITY);
    const notice = result.state.notifications.at(-1)!;
    assert.equal(notice.kind, 'catalog_rolled_back');
    assert.equal(notice.reasonCode, 'safety_concern');
    assert.equal(notice.pointerRevision, 3);
    // 되돌려도 활성화 기록과 버전은 지워지지 않는다.
    assert.equal(result.state.activations.length, 1);
    assert.ok(result.state.versions[activeHash]);
  });

  it('같은 롤백 요청 재실행은 멱등이고, 같은 번호의 다른 롤백은 거절한다', async () => {
    const { prepared, state, activeHash } = await activated();
    const request = {
      requestId: requestId(20),
      targetVersionHash: prepared.baseHash,
      expectedActiveVersionHash: activeHash,
      reasonCode: 'owner_requested' as const,
    };
    const first = await planRollback(state, request);
    assert.ok(first.ok);
    const replay = await planRollback(first.state, request);
    assert.ok(replay.ok && replay.replayed && replay.state === first.state);

    const conflict = await planRollback(first.state, { ...request, reasonCode: 'operational_incident' });
    assert.equal(!conflict.ok && conflict.code, 'idempotency_conflict');
  });

  it('조상이 아닌 버전, 현재 버전, 없는 버전으로는 되돌리지 않고 상태를 그대로 둔다', async () => {
    const { prepared, state, activeHash } = await activated();
    const back = await planRollback(state, {
      requestId: requestId(20),
      targetVersionHash: prepared.baseHash,
      expectedActiveVersionHash: activeHash,
      reasonCode: 'regression_detected',
    });
    assert.ok(back.ok);

    const snapshot = canonicalJson(back.state);
    for (const [label, target] of [
      ['앞으로 되돌리기', activeHash],
      ['현재 버전', prepared.baseHash],
      ['없는 버전', `scat_${'9'.repeat(64)}`],
    ] as const) {
      const result = await planRollback(back.state, {
        requestId: requestId(21),
        targetVersionHash: target,
        expectedActiveVersionHash: prepared.baseHash,
        reasonCode: 'regression_detected',
      });
      assert.equal(!result.ok && result.code, 'rollback_target_not_previous', label);
      assertUnchanged(back.state, snapshot);
    }
  });

  it('조상이라도 한 번도 활성이었던 적이 없는 버전으로는 되돌리지 않는다', async () => {
    const { prepared, state, activeHash } = await activated();
    const neverActive = `scat_${'7'.repeat(64)}`;
    const crafted: CatalogLedgerState = {
      ...state,
      versions: {
        ...state.versions,
        [neverActive]: { catalog: prepared.base, parentVersionHash: null },
        [prepared.baseHash]: { ...state.versions[prepared.baseHash], parentVersionHash: neverActive },
      },
    };
    const result = await planRollback(crafted, {
      requestId: requestId(22),
      targetVersionHash: neverActive,
      expectedActiveVersionHash: activeHash,
      reasonCode: 'regression_detected',
    });
    assert.equal(!result.ok && result.code, 'rollback_target_not_previous');
  });

  it('기대한 활성 버전이 다르거나 사유 코드가 없는 값이면 되돌리지 않는다', async () => {
    const { prepared, state, activeHash } = await activated();
    const stale = await planRollback(state, {
      requestId: requestId(20),
      targetVersionHash: prepared.baseHash,
      expectedActiveVersionHash: prepared.baseHash,
      reasonCode: 'regression_detected',
    });
    assert.equal(!stale.ok && stale.code, 'stale_active_version');

    const badReason = await planRollback(state, {
      requestId: requestId(20),
      targetVersionHash: prepared.baseHash,
      expectedActiveVersionHash: activeHash,
      reasonCode: 'because' as never,
    });
    assert.equal(!badReason.ok && badReason.code, 'invalid_request');
  });
});

describe('참조 의미 · 권한 분리와 공지 내용', () => {
  it('어떤 기록에도 사람 검토 authority가 쓰이지 않는다', async () => {
    const prepared = await prepare();
    const activatedResult = await activate(prepared);
    assert.ok(activatedResult.ok);
    const rolledBack = await planRollback(activatedResult.state, {
      requestId: requestId(20),
      targetVersionHash: prepared.baseHash,
      expectedActiveVersionHash: activatedResult.state.activeVersionHash!,
      reasonCode: 'regression_detected',
    });
    assert.ok(rolledBack.ok);
    const serialized = canonicalJson(rolledBack.state);
    assert.equal(serialized.includes(`"authority":"${HUMAN_REVIEW_AUTHORITY}"`), false);
    assert.equal(serialized.includes('"reviewAuthority"'), false);
    assert.ok(rolledBack.state.activations.every((event) => event.authority === AUTOMATED_VALIDATION_AUTHORITY));
    assert.ok(rolledBack.state.rollbacks.every((event) => event.authority === AUTOMATED_OPERATIONS_AUTHORITY));
  });

  it('소유자 공지는 지문과 사유 코드만 담고 개인정보·받는 사람 주소가 없다', async () => {
    const prepared = await prepare();
    const activatedResult = await activate(prepared);
    assert.ok(activatedResult.ok);
    for (const notice of activatedResult.state.notifications) {
      assert.deepEqual(Object.keys(notice).sort(), [
        'candidateHash',
        'fromVersionHash',
        'kind',
        'pointerRevision',
        'reasonCode',
        'toVersionHash',
      ]);
      assert.deepEqual(scanForbiddenContent(notice), []);
    }
  });
});
