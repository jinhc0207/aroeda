/**
 * 자동 Scripture Catalog 계약 테스트 — 카탈로그 한 판과 후보 한 건
 *
 * 실행: npm test
 *
 * 확인하는 것: 카탈로그·후보의 모양, 결정적 지문, 영역 표시 이름, 성경 표기의 결정적 생성,
 * 후보 종류별 규칙과 수요 연결, 연구 결과 지문 필수, 번호 충돌, 닫힌 태그 사전,
 * 바꿀 수 없는 설정 키와 개인정보 차단, 현재 정적 카드 51장이 기준 카탈로그로 그대로 옮겨지는지.
 * 확인하지 않는 것: 카드 글의 신학적 품질. 그것은 자동 검증 기록의 독립 평가가 맡는다.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  CARD_ID_FORMAT,
  CATALOG_VERSION_HASH_FORMAT,
  MIN_CARDS_FOR_NEW_DOMAIN,
  PERSONAL_DATA_KEYS,
  PROTECTED_CONFIGURATION_KEYS,
  type ScriptureCatalogCandidate,
  applyCandidateToCatalog,
  canonicalJson,
  computeCatalogCandidateHash,
  computeCatalogVersionHash,
  computeThemeFingerprint,
  formatCatalogReferenceLabel,
  scanForbiddenContent,
  validateCatalogCandidate,
  validateCatalogDomain,
  validateCatalogSnapshot,
} from '../../supabase/functions/_shared/automatic-scripture-catalog-contract.ts';
import { SCRIPTURE_CARDS } from '../../supabase/functions/_shared/scripture-cards.ts';
import { CARD_COVERED_DOMAINS } from '../../supabase/functions/_shared/situation-domains.ts';
import {
  APP_DOMAIN_LABELS,
  buildBaselineCatalog,
  finalizeCandidate,
  makeExistingDomainCandidate,
  makeNewDomainCandidate,
} from './automatic-scripture-catalog-test-fixtures.ts';

const clone = <T>(value: T): T => structuredClone(value);

/** 초안을 고친 뒤 base 기준으로 지문까지 다시 맞춘 후보를 만든다(지문 불일치가 아닌 규칙 위반만 보려고). */
async function refinalize(mutate: (candidate: ScriptureCatalogCandidate) => void | Promise<void>, kind: 'existing' | 'new' = 'existing') {
  const base = buildBaselineCatalog();
  const { candidate } = kind === 'existing' ? await makeExistingDomainCandidate(base) : await makeNewDomainCandidate(base);
  const draft = clone(candidate);
  await mutate(draft);
  const { baseVersionHash: _b, proposedVersionHash: _p, ...rest } = draft;
  const rebuilt = await finalizeCandidate(base, rest);
  return { base, ...rebuilt };
}

const errorsOf = async (candidate: unknown, base = buildBaselineCatalog()) => (await validateCatalogCandidate(candidate, base)).errors.join(' / ');

describe('자동 카탈로그 계약 · 기준 카탈로그', () => {
  it('현재 정적 카드 51장과 영역 17개가 앱의 실제 표시 이름과 함께 유효한 기준 카탈로그가 된다', () => {
    const base = buildBaselineCatalog();
    assert.deepEqual(validateCatalogSnapshot(base), { valid: true, errors: [] });
    assert.equal(base.cards.length, SCRIPTURE_CARDS.length);
    assert.equal(base.cards.length, 51);
    assert.deepEqual(
      base.domains.map((domain) => domain.id),
      [...CARD_COVERED_DOMAINS].sort(),
    );
    for (const domain of base.domains) assert.equal(domain.displayName, APP_DOMAIN_LABELS[domain.id]);
  });

  it('기준 카탈로그의 카드 내용은 정적 카드와 한 글자도 다르지 않다', () => {
    const base = buildBaselineCatalog();
    for (const source of SCRIPTURE_CARDS) {
      const card = base.cards.find((item) => item.id === source.id)!;
      assert.equal(card.domainId, source.domains[0]);
      assert.equal(card.referenceLabel, source.referenceLabel);
      assert.deepEqual(card.passages, source.passages ?? [source.passage]);
      assert.deepEqual(card.situationTags, source.situationTags);
      assert.equal(card.userExplanation, source.userExplanation);
      assert.deepEqual(card.misuseGuards, source.misuseGuards);
    }
  });

  it('지문은 결정적이고 키 순서에 흔들리지 않으며 표시 이름도 지문에 포함된다', async () => {
    const base = buildBaselineCatalog();
    const hash = await computeCatalogVersionHash(base);
    assert.match(hash, CATALOG_VERSION_HASH_FORMAT);
    assert.equal(await computeCatalogVersionHash(buildBaselineCatalog()), hash);

    const shuffledKeys = { cards: base.cards, domains: base.domains, contractVersion: base.contractVersion };
    assert.equal(canonicalJson(shuffledKeys), canonicalJson(base));

    const changedCard = clone(base);
    changedCard.cards[0].userExplanation += ' ';
    assert.notEqual(await computeCatalogVersionHash(changedCard), hash);

    const renamed = clone(base);
    renamed.domains[0].displayName = '다른 표시 이름';
    assert.notEqual(await computeCatalogVersionHash(renamed), hash);
  });

  it('JSON이 아닌 값으로는 지문을 만들지 않는다', () => {
    assert.throws(() => canonicalJson({ a: undefined }));
    assert.throws(() => canonicalJson({ a: Number.NaN }));
    assert.throws(() => canonicalJson({ a: () => 1 }));
  });

  it('영역·카드가 id 오름차순이 아니면 거절한다(같은 내용의 다른 지문을 막는다)', () => {
    const base = buildBaselineCatalog();
    const swapped = clone(base);
    [swapped.cards[0], swapped.cards[1]] = [swapped.cards[1], swapped.cards[0]];
    assert.equal(validateCatalogSnapshot(swapped).valid, false);

    const domainsSwapped = clone(base);
    [domainsSwapped.domains[0], domainsSwapped.domains[1]] = [domainsSwapped.domains[1], domainsSwapped.domains[0]];
    assert.equal(validateCatalogSnapshot(domainsSwapped).valid, false);
  });

  it('없는 본문, 없는 영역, 카드 없는 영역, other_uncovered 영역을 거절한다', () => {
    const base = buildBaselineCatalog();

    const badPassage = clone(base);
    badPassage.cards[0].passages = [{ book: 'Psalms', chapter: 151, startVerse: 1, endVerse: 1 }];
    assert.equal(validateCatalogSnapshot(badPassage).valid, false);

    const orphanCard = clone(base);
    orphanCard.cards[0].domainId = 'not_a_domain';
    assert.equal(validateCatalogSnapshot(orphanCard).valid, false);

    const emptyDomain = clone(base);
    emptyDomain.domains.push({ id: 'zz_empty_domain', displayName: '카드 없는 영역', description: '카드가 없는 영역' });
    assert.equal(validateCatalogSnapshot(emptyDomain).valid, false);

    const fallback = clone(base);
    fallback.domains.push({ id: 'other_uncovered', displayName: '대체 영역', description: '대체 영역' });
    assert.equal(validateCatalogSnapshot(fallback).valid, false);
  });

  it('계약에 없는 카드 항목을 거절한다', () => {
    const base = buildBaselineCatalog();
    const extra = clone(base) as unknown as { cards: Record<string, unknown>[] };
    extra.cards[0].priority = 1;
    assert.equal(validateCatalogSnapshot(extra).valid, false);
  });
});

describe('자동 카탈로그 계약 · 영역 표시 이름', () => {
  const domain = (displayName: unknown) => ({ id: 'caregiving_strain', displayName, description: '설명' });

  it('앱의 17개 표시 이름은 모두 규칙 안에 들어간다', () => {
    for (const [id, displayName] of Object.entries(APP_DOMAIN_LABELS)) {
      assert.deepEqual(validateCatalogDomain({ id, displayName, description: '설명' }).errors, [], id);
    }
  });

  it('내부 id·영문·숫자·밑줄·빈 이름·앞뒤 공백·두 칸 띄어쓰기·너무 긴 이름을 거절한다', () => {
    const rejected = [
      undefined,
      '',
      '가',
      'caregiving_strain',
      'Caregiving',
      '돌봄 strain',
      '돌봄2',
      '돌봄_무게',
      ' 돌봄의 무게',
      '돌봄의 무게 ',
      '돌봄의  무게',
      '돌봄의\t무게',
      '가'.repeat(25),
    ];
    for (const displayName of rejected) {
      const result = validateCatalogDomain(domain(displayName));
      assert.equal(result.valid, false, JSON.stringify(displayName));
      assert.ok(result.errors.some((error) => error.includes('displayName')), JSON.stringify(displayName));
    }
  });

  it('카탈로그 안에서 표시 이름이 겹치면 거절한다', () => {
    const base = buildBaselineCatalog();
    const duplicated = clone(base);
    duplicated.domains[1].displayName = duplicated.domains[0].displayName;
    const result = validateCatalogSnapshot(duplicated);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((error) => error.includes('표시 이름')));
  });

  it('새 영역이 기존 영역의 표시 이름을 쓰면 거절한다', async () => {
    const reused = await refinalize((draft) => {
      draft.newDomain = { ...draft.newDomain!, displayName: APP_DOMAIN_LABELS.grief_loss };
    }, 'new');
    assert.match(await errorsOf(reused.candidate, reused.base), /이미 다른 영역이 쓰는 표시 이름/);
  });
});

describe('자동 카탈로그 계약 · 성경 표기 결정적 생성', () => {
  it('현재 카드 51장의 라벨이 모두 계산 결과와 글자까지 같다', () => {
    for (const card of SCRIPTURE_CARDS) {
      assert.equal(formatCatalogReferenceLabel(card.passages ?? [card.passage]), card.referenceLabel, card.id);
    }
  });

  it('한 위치와 장을 넘어 붙은 위치는 기존 표기 함수 결과를 쓴다', () => {
    assert.equal(formatCatalogReferenceLabel([{ book: 'Psalms', chapter: 56, startVerse: 3, endVerse: 4 }]), '시편 56:3–4');
    assert.equal(
      formatCatalogReferenceLabel([
        { book: '1John', chapter: 1, startVerse: 8, endVerse: 10 },
        { book: '1John', chapter: 2, startVerse: 1, endVerse: 2 },
      ]),
      '요한일서 1:8–2:2',
    );
  });

  it('떨어진 위치는 같은 장 쉼표, 다른 장 세미콜론, 다른 책 세미콜론+책 이름으로 잇는다', () => {
    assert.equal(
      formatCatalogReferenceLabel([
        { book: 'Proverbs', chapter: 18, startVerse: 13, endVerse: 13 },
        { book: 'Proverbs', chapter: 18, startVerse: 17, endVerse: 17 },
      ]),
      '잠언 18:13, 17',
    );
    assert.equal(
      formatCatalogReferenceLabel([
        { book: 'Proverbs', chapter: 3, startVerse: 5, endVerse: 6 },
        { book: 'Proverbs', chapter: 16, startVerse: 3, endVerse: 3 },
      ]),
      '잠언 3:5–6; 16:3',
    );
    assert.equal(
      formatCatalogReferenceLabel([
        { book: 'Psalms', chapter: 23, startVerse: 1, endVerse: 1 },
        { book: 'John', chapter: 10, startVerse: 11, endVerse: 11 },
      ]),
      '시편 23:1; 요한복음 10:11',
    );
  });

  it('정경 순서가 아니거나, 겹치거나, 같은 장에서 붙어 있거나, 없는 위치면 표기를 만들지 않는다', () => {
    const cases = [
      [],
      [{ book: 'John', chapter: 10, startVerse: 11, endVerse: 11 }, { book: 'Psalms', chapter: 23, startVerse: 1, endVerse: 1 }],
      [{ book: 'Proverbs', chapter: 18, startVerse: 17, endVerse: 17 }, { book: 'Proverbs', chapter: 18, startVerse: 13, endVerse: 13 }],
      [{ book: 'Proverbs', chapter: 18, startVerse: 13, endVerse: 15 }, { book: 'Proverbs', chapter: 18, startVerse: 15, endVerse: 17 }],
      [{ book: 'Proverbs', chapter: 18, startVerse: 13, endVerse: 13 }, { book: 'Proverbs', chapter: 18, startVerse: 14, endVerse: 14 }],
      [{ book: 'Psalms', chapter: 151, startVerse: 1, endVerse: 1 }],
    ];
    for (const passages of cases) assert.equal(formatCatalogReferenceLabel(passages), null, JSON.stringify(passages));
  });

  it('장절과 무관한 라벨, 공백·대시만 다른 라벨을 가진 후보를 거절한다', async () => {
    for (const label of ['요한복음 3:16', '잠언 16:1-3', '잠언 16:1–3 ', '잠언16:1–3', 'Proverbs 16:1–3']) {
      const relabeled = await refinalize((draft) => {
        draft.cards[0].referenceLabel = label;
      });
      assert.equal((await validateCatalogCandidate(relabeled.candidate, relabeled.base)).valid, false, label);
    }
  });

  it('붙어 있는 두 위치를 쪼개 적은 카드를 거절한다(한 위치로 합쳐야 한다)', async () => {
    const split = await refinalize((draft) => {
      draft.cards[0].passages = [
        { book: 'Proverbs', chapter: 16, startVerse: 1, endVerse: 1 },
        { book: 'Proverbs', chapter: 16, startVerse: 2, endVerse: 3 },
      ];
      draft.cards[0].referenceLabel = '잠언 16:1, 2–3';
    });
    assert.match(await errorsOf(split.candidate, split.base), /정경 순서로 떨어져 있어야/);
  });
});

describe('자동 카탈로그 계약 · 바꿀 수 없는 설정과 개인정보', () => {
  it('안전 규칙·개인정보 정책·모델·사용량 한도 키는 어느 깊이에서도 거절한다', () => {
    for (const key of ['safety', 'safetyRules', 'privacyPolicy', 'model', 'openaiModel', 'quota', 'rateLimit', 'instructions']) {
      assert.ok((PROTECTED_CONFIGURATION_KEYS as readonly string[]).includes(key), key);
      const errors = scanForbiddenContent({ nested: { deeper: [{ [key]: 'x' }] } });
      assert.ok(errors.length > 0, `${key}가 막히지 않았습니다.`);
    }
    assert.ok(scanForbiddenContent({ OpenAIModel: 'gpt' }).length > 0, '대소문자를 바꿔도 막아야 합니다.');
  });

  it('사용자 원문·식별자·인증 값·모델 원본 응답 키를 거절한다', () => {
    for (const key of ['situation', 'userText', 'userId', 'sessionId', 'deviceId', 'ipAddress', 'jwt', 'accessToken', 'openaiResponse', 'rawResponse']) {
      assert.ok((PERSONAL_DATA_KEYS as readonly string[]).includes(key), key);
      assert.ok(scanForbiddenContent({ a: { [key]: 'x' } }).length > 0, `${key}가 막히지 않았습니다.`);
    }
  });

  it('값이 토큰·메일·IP·비밀 키·UUID처럼 생기면 거절한다', () => {
    const samples = [
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnop',
      'owner@example.com',
      '192.168.0.10',
      'sk-abcdefghijklmnopqrstuvwxyz',
      '123e4567-e89b-42d3-a456-426614174000',
    ];
    for (const sample of samples) assert.ok(scanForbiddenContent({ note: sample }).length > 0, sample);
  });

  it('평범한 카드 문장과 태그는 막지 않는다', () => {
    assert.deepEqual(scanForbiddenContent(buildBaselineCatalog()), []);
  });

  it('카탈로그 안에 금지 키가 들어오면 카탈로그 자체를 거절한다', () => {
    const base = buildBaselineCatalog() as unknown as Record<string, unknown>;
    assert.equal(validateCatalogSnapshot({ ...base, quota: { day: 1 } }).valid, false);
  });
});

describe('자동 카탈로그 계약 · 후보', () => {
  it('기존 영역 카드 후보가 유효하고, 결과 카탈로그와 두 지문이 정확히 이어진다', async () => {
    const base = buildBaselineCatalog();
    const { candidate, candidateHash, proposedCatalog } = await makeExistingDomainCandidate(base);
    const check = await validateCatalogCandidate(candidate, base);
    assert.deepEqual(check.errors, []);
    assert.deepEqual(check.proposedCatalog, proposedCatalog);
    assert.equal(candidate.baseVersionHash, await computeCatalogVersionHash(base));
    assert.equal(candidate.proposedVersionHash, await computeCatalogVersionHash(proposedCatalog));
    assert.equal(candidateHash, await computeCatalogCandidateHash(candidate));
    assert.equal(proposedCatalog.cards.length, 52);
    assert.equal(proposedCatalog.domains.length, 17);
  });

  it('새 영역 후보가 유효하고 표시 이름을 가진 영역 하나와 카드 3장이 더해진다', async () => {
    const base = buildBaselineCatalog();
    const { candidate, proposedCatalog } = await makeNewDomainCandidate(base);
    assert.deepEqual((await validateCatalogCandidate(candidate, base)).errors, []);
    assert.equal(proposedCatalog.domains.length, 18);
    assert.equal(proposedCatalog.cards.length, 54);
    assert.equal(candidate.cards.length, MIN_CARDS_FOR_NEW_DOMAIN);
    assert.equal(proposedCatalog.domains.find((domain) => domain.id === 'caregiving_strain')!.displayName, '오래 돌보는 무게');
  });

  it('후보를 합쳐도 기준 카탈로그는 바뀌지 않는다', async () => {
    const base = buildBaselineCatalog();
    const before = canonicalJson(base);
    const { candidate } = await makeNewDomainCandidate(base);
    applyCandidateToCatalog(base, candidate);
    assert.equal(canonicalJson(base), before);
  });

  it('기준 지문이나 결과 지문이 내용과 다르면 거절한다', async () => {
    const base = buildBaselineCatalog();
    const { candidate } = await makeExistingDomainCandidate(base);
    assert.equal((await validateCatalogCandidate({ ...clone(candidate), baseVersionHash: `scat_${'0'.repeat(64)}` }, base)).valid, false);
    assert.equal((await validateCatalogCandidate({ ...clone(candidate), proposedVersionHash: `scat_${'1'.repeat(64)}` }, base)).valid, false);
    const editedCard = clone(candidate);
    editedCard.cards[0].prayerDirection = '지문을 맞추지 않고 바꾼 문장입니다.';
    assert.equal((await validateCatalogCandidate(editedCard, base)).valid, false);
  });

  it('연구 결과 지문은 두 종류 모두 필수이고 모양이 맞아야 한다', async () => {
    for (const kind of ['existing', 'new'] as const) {
      for (const hash of [null, '', 'rres_short', `pcand_${'1'.repeat(64)}`]) {
        const broken = await refinalize((draft) => {
          (draft as { sourceResearchResultHash: unknown }).sourceResearchResultHash = hash;
        }, kind);
        assert.match(await errorsOf(broken.candidate, broken.base), /연구 결과 지문이 반드시/, `${kind} ${hash}`);
      }
    }
  });

  it('기존 영역 후보는 대상 영역의 weak_match에만 묶인다', async () => {
    const otherDomain = await refinalize((draft) => {
      draft.demandBinding = { kind: 'weak_match', domainId: 'grief_loss' };
    });
    assert.match(await errorsOf(otherDomain.candidate, otherDomain.base), /대상 영역과 같아야/);

    const themed = await refinalize(async (draft) => {
      draft.demandBinding = { kind: 'normalized_theme', themeKey: 'decision_help', themeFingerprint: await computeThemeFingerprint('decision_help') };
    });
    assert.match(await errorsOf(themed.candidate, themed.base), /weak_match 집계에만/);
  });

  it('새 영역 후보는 normalized_theme에만 묶이고, 주제 지문은 주제 이름에서 다시 계산한다', async () => {
    const weak = await refinalize((draft) => {
      draft.demandBinding = { kind: 'weak_match', domainId: 'caregiving_strain' };
    }, 'new');
    assert.equal((await validateCatalogCandidate(weak.candidate, weak.base)).valid, false);

    const otherUncovered = await refinalize((draft) => {
      draft.demandBinding = { kind: 'weak_match', domainId: 'other_uncovered' };
    }, 'new');
    assert.equal((await validateCatalogCandidate(otherUncovered.candidate, otherUncovered.base)).valid, false);

    const forged = await refinalize((draft) => {
      draft.demandBinding = { kind: 'normalized_theme', themeKey: 'caregiving_strain', themeFingerprint: `sthm_${'a'.repeat(64)}` };
    }, 'new');
    assert.match(await errorsOf(forged.candidate, forged.base), /주제 이름에서 계산한 지문과 다릅니다/);

    const badKey = await refinalize(async (draft) => {
      draft.demandBinding = { kind: 'normalized_theme', themeKey: '돌봄 요청', themeFingerprint: await computeThemeFingerprint('돌봄 요청') };
    }, 'new');
    assert.match(await errorsOf(badKey.candidate, badKey.base), /정규화 주제 이름 모양/);
  });

  it('기존 영역 후보가 없는 영역을 가리키거나 newDomain을 가지면 거절한다', async () => {
    const missingDomain = await refinalize((draft) => {
      draft.targetDomainId = 'caregiving_strain';
      draft.cards[0].domainId = 'caregiving_strain';
      draft.demandBinding = { kind: 'weak_match', domainId: 'caregiving_strain' };
    });
    assert.equal((await validateCatalogCandidate(missingDomain.candidate, missingDomain.base)).valid, false);

    const base = buildBaselineCatalog();
    const { candidate } = await makeExistingDomainCandidate(base);
    const withDomain = { ...clone(candidate), newDomain: { id: 'decision_guidance', displayName: '결정', description: 'x' } };
    assert.equal((await validateCatalogCandidate(withDomain, base)).valid, false);
  });

  it('새 영역 후보가 기존 영역 이름을 쓰거나, 카드가 3장 미만이거나, other_uncovered면 거절한다', async () => {
    const reused = await refinalize((draft) => {
      draft.targetDomainId = 'grief_loss';
      draft.newDomain = { id: 'grief_loss', displayName: '이미 있는 영역', description: '이미 있는 영역' };
      for (const card of draft.cards) card.domainId = 'grief_loss';
    }, 'new');
    assert.equal((await validateCatalogCandidate(reused.candidate, reused.base)).valid, false);

    const tooFew = await refinalize((draft) => {
      draft.cards = draft.cards.slice(0, 2);
    }, 'new');
    assert.equal((await validateCatalogCandidate(tooFew.candidate, tooFew.base)).valid, false);

    const fallback = await refinalize((draft) => {
      draft.targetDomainId = 'other_uncovered';
      draft.newDomain = { id: 'other_uncovered', displayName: '대체 영역', description: '대체 영역' };
      for (const card of draft.cards) card.domainId = 'other_uncovered';
    }, 'new');
    assert.equal((await validateCatalogCandidate(fallback.candidate, fallback.base)).valid, false);
  });

  it('기존 카드 번호를 다시 쓰거나 후보 안에서 번호가 겹치면 거절한다', async () => {
    const base = buildBaselineCatalog();
    const existingId = await makeExistingDomainCandidate(base, 'SC-002');
    assert.equal((await validateCatalogCandidate(existingId.candidate, base)).valid, false);
    assert.match('SC-002', CARD_ID_FORMAT);

    const duplicate = await refinalize((draft) => {
      for (const card of draft.cards) card.id = 'SC-060';
    }, 'new');
    assert.equal((await validateCatalogCandidate(duplicate.candidate, duplicate.base)).valid, false);
  });

  it('감정·신앙질문·기도방식·목회기능 태그는 기준 사전에 없는 새 값을 들여올 수 없다', async () => {
    for (const field of ['emotionTags', 'spiritualQuestionTags', 'prayerModes', 'pastoralFunction'] as const) {
      const invented = await refinalize((draft) => {
        draft.cards[0][field] = ['사전에 없는 새 값'];
      });
      assert.equal((await validateCatalogCandidate(invented.candidate, invented.base)).valid, false, field);
    }
    const newSituation = await refinalize((draft) => {
      draft.cards[0].situationTags = ['새로운 구체 상황'];
    });
    assert.equal((await validateCatalogCandidate(newSituation.candidate, newSituation.base)).valid, true);
  });

  it('생성 기록은 자동 방식·모델 식별자·생성 규칙 버전을 반드시 가진다', async () => {
    const base = buildBaselineCatalog();
    const { candidate } = await makeExistingDomainCandidate(base);
    for (const generation of [
      { method: 'human', modelId: 'm', promptVersion: 'p' },
      { method: 'automated', modelId: '', promptVersion: 'p' },
      { method: 'automated', modelId: 'm' },
    ]) {
      const broken = { ...clone(candidate), generation } as unknown;
      assert.equal((await validateCatalogCandidate(broken, base)).valid, false, JSON.stringify(generation));
    }
  });

  it('후보에 운영 설정이나 개인정보가 섞이면 거절한다', async () => {
    const base = buildBaselineCatalog();
    const { candidate } = await makeExistingDomainCandidate(base);
    assert.equal((await validateCatalogCandidate({ ...clone(candidate), model: 'gpt-override' } as unknown, base)).valid, false);
    const withUserText = clone(candidate);
    withUserText.cards[0].contextSummary = '연락처 owner@example.com 으로 알려 주세요.';
    assert.equal((await validateCatalogCandidate(withUserText, base)).valid, false);
  });

  it('어떤 이상한 값이 와도 예외 없이 거절한다', async () => {
    const base = buildBaselineCatalog();
    for (const value of [null, 1, 'x', [], { cards: 'x' }]) {
      const check = await validateCatalogCandidate(value, base);
      assert.equal(check.valid, false);
      assert.equal(check.proposedCatalog, null);
    }
  });
});
