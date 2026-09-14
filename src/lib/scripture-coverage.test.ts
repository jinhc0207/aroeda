/**
 * Situation Domain / Coverage 테스트
 *
 * 실행: npm test
 *
 * 아직 추천 여부를 결정하는 로직(Recommendation Gate)은 없다.
 * 지금 카드 DB가 해당 상황을 다룰 수 있는지만 확인한다.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { SCRIPTURE_CARDS } from '../data/scripture-cards.ts';
import {
  COVERED_DOMAINS,
  DOMAIN_DESCRIPTIONS,
  FALLBACK_DOMAIN,
  SITUATION_DOMAINS,
  UNCOVERED_DOMAINS,
  isSituationDomain,
} from '../data/situation-domains.ts';
import { coveredDomainsInCards, getCoverage } from './scripture-coverage.ts';
import { MOCK_ANALYSIS_CASES } from './situation-analysis.mock.ts';
import { validateSituationAnalysis } from './situation-analysis.ts';

describe('Situation Domain 사전', () => {
  it('domain 값에 중복이 없다', () => {
    assert.equal(new Set(SITUATION_DOMAINS).size, SITUATION_DOMAINS.length);
    assert.equal(SITUATION_DOMAINS.length, COVERED_DOMAINS.length + UNCOVERED_DOMAINS.length + 1);
  });

  it('covered와 uncovered가 겹치지 않는다', () => {
    const covered = new Set<string>(COVERED_DOMAINS);
    for (const domain of UNCOVERED_DOMAINS) {
      assert.equal(covered.has(domain), false, `${domain}이 양쪽에 있습니다.`);
    }
    assert.equal(covered.has(FALLBACK_DOMAIN), false);
  });

  it('모든 domain에 설명이 있다', () => {
    for (const domain of SITUATION_DOMAINS) {
      assert.ok(DOMAIN_DESCRIPTIONS[domain]?.length > 0, `${domain} 설명이 없습니다.`);
    }
  });

  it('표준 domain만 인정한다', () => {
    assert.equal(isSituationDomain('grief_loss'), true);
    assert.equal(isSituationDomain('other_uncovered'), true);
    assert.equal(isSituationDomain('made_up_domain'), false);
    assert.equal(isSituationDomain(undefined), false);
  });
});

describe('Scripture Card domain', () => {
  it('51개 카드 모두 domain을 가진다', () => {
    assert.equal(SCRIPTURE_CARDS.length, 51);
    for (const card of SCRIPTURE_CARDS) {
      assert.ok(Array.isArray(card.domains), `${card.id}에 domains가 없습니다.`);
      assert.equal(card.domains.length, 1, `${card.id}는 V1에서 domain 하나만 가집니다.`);
      assert.ok(isSituationDomain(card.domains[0]), `${card.id}의 domain이 표준이 아닙니다.`);
    }
  });

  it('카드의 domain은 표준 domain 목록에만 존재한다', () => {
    const covered = new Set<string>(SITUATION_DOMAINS.filter((domain) => domain !== FALLBACK_DOMAIN));
    for (const card of SCRIPTURE_CARDS) {
      for (const domain of card.domains) {
        assert.ok(covered.has(domain), `${card.id}의 ${domain}이 covered 목록에 없습니다.`);
      }
    }
  });

  it('covered domain이 모두 카드 3장씩 연결되어 있다', () => {
    // Scripture Card Expansion v2(2026-09-15): 카드가 1장뿐이던 10개 영역에 정확히 2장씩 추가해,
    // 이제 COVERED_DOMAINS(원래 10개)와 UNCOVERED_DOMAINS(이전 확장 7개) 17개 모두 카드 3장이다.
    const inCards = coveredDomainsInCards();
    assert.equal(inCards.length, SITUATION_DOMAINS.length - 1);
    for (const domain of COVERED_DOMAINS) {
      const result = getCoverage(domain);
      assert.equal(result.covered, true, `${domain}을 다루는 카드가 없습니다.`);
      assert.equal(result.cardIds.length, 3, `${domain}에 카드 3개가 연결되어야 합니다.`);
    }
    for (const domain of UNCOVERED_DOMAINS) {
      const result = getCoverage(domain);
      assert.equal(result.covered, true, `${domain} 확장 카드가 없습니다.`);
      assert.equal(result.cardIds.length, 3, `${domain}에 확장 카드 3개가 연결되어야 합니다.`);
    }
  });
});

describe('Coverage 확인 (T1~T13)', () => {
  // Scripture Card Expansion v2(2026-09-15) 이전에는 카드가 하나뿐이던 영역이다.
  // 이제 원래 카드를 포함해 3장이 연결된다. 기존 카드가 여전히 그 안에 있는지만 본다.
  const coveredCases: { id: string; domain: string; cardId: string }[] = [
    { id: 'T1', domain: 'fear_uncertainty', cardId: 'SC-001' },
    { id: 'T2', domain: 'decision_guidance', cardId: 'SC-002' },
    { id: 'T3', domain: 'grief_loss', cardId: 'SC-009' },
    { id: 'T4', domain: 'repentance_guilt', cardId: 'SC-006' },
    { id: 'T5', domain: 'wisdom_discernment', cardId: 'SC-010' },
  ];

  for (const testCase of coveredCases) {
    it(`${testCase.id} · ${testCase.domain} → covered / ${testCase.cardId} 포함 3장`, () => {
      const result = getCoverage(testCase.domain);
      assert.equal(result.covered, true);
      assert.equal(result.cardIds.length, 3);
      assert.ok(result.cardIds.includes(testCase.cardId));
      assert.equal(result.primaryDomain, testCase.domain);
    });
  }

  const expandedCases: { id: string; domain: string; cardId: string }[] = [
    { id: 'T6', domain: 'loneliness_isolation', cardId: 'SC-011' },
    { id: 'T7', domain: 'family_parenting_conflict', cardId: 'SC-012' },
    { id: 'T8', domain: 'burnout_exhaustion', cardId: 'SC-013' },
    { id: 'T9', domain: 'spiritual_dryness', cardId: 'SC-014' },
    { id: 'T10', domain: 'financial_hardship', cardId: 'SC-015' },
    { id: 'T11', domain: 'chronic_illness', cardId: 'SC-016' },
    { id: 'T12', domain: 'relationship_conflict_forgiveness', cardId: 'SC-017' },
  ];

  for (const testCase of expandedCases) {
    it(`${testCase.id} · ${testCase.domain} → expanded card ${testCase.cardId}`, () => {
      const result = getCoverage(testCase.domain);
      assert.equal(result.covered, true);
      assert.equal(result.cardIds.length, 3);
      assert.ok(result.cardIds.includes(testCase.cardId));
    });
  }

  const uncoveredCases: { id: string; domain: string }[] = [
    { id: 'T13', domain: 'other_uncovered' },
  ];

  for (const testCase of uncoveredCases) {
    it(`${testCase.id} · ${testCase.domain} → covered false`, () => {
      const result = getCoverage(testCase.domain);
      assert.equal(result.covered, false);
      assert.deepEqual(result.cardIds, []);
    });
  }

  it('표준이 아닌 domain은 카드를 찾지 않는다', () => {
    const result = getCoverage('made_up_domain');
    assert.equal(result.covered, false);
    assert.equal(result.primaryDomain, null);
    assert.deepEqual(result.cardIds, []);
  });
});

describe('Situation Analysis의 domain 검증', () => {
  const base = () => ({
    domainPriority: 'resolved' as const,
    primaryDomain: 'grief_loss' as const,
    domainChoiceCandidates: [],
    secondaryDomains: [],
    situationTags: ['사별'],
    emotionTags: ['슬픔'],
    spiritualQuestionTags: ['슬픔'],
    prayerModes: ['탄식'],
    pastoralFunctions: ['위로'],
    safety: { level: 'normal' as const, categories: [] },
    confidence: 0.8,
  });

  it('표준 domain은 통과한다', () => {
    const result = validateSituationAnalysis(base());
    assert.equal(result.valid, true, result.errors.join(' / '));
  });

  it('잘못된 primaryDomain은 실패한다', () => {
    const result = validateSituationAnalysis({ ...base(), primaryDomain: 'made_up_domain' });
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((error) => error.includes('primaryDomain')));
  });

  it('잘못된 secondaryDomains는 실패한다', () => {
    const result = validateSituationAnalysis({ ...base(), secondaryDomains: ['made_up_domain'] });
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((error) => error.includes('secondaryDomains')));
  });

  it('secondaryDomains에 primaryDomain이 또 들어가면 실패한다', () => {
    const result = validateSituationAnalysis({ ...base(), secondaryDomains: ['grief_loss'] });
    assert.equal(result.valid, false);
  });

  it('primaryDomain이 없으면 실패한다', () => {
    const { primaryDomain, ...withoutPrimary } = base();
    void primaryDomain;
    const result = validateSituationAnalysis(withoutPrimary);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((error) => error.includes('primaryDomain')));
  });

  it('secondaryDomains가 없으면 실패한다', () => {
    const { secondaryDomains, ...withoutSecondary } = base();
    void secondaryDomains;
    const result = validateSituationAnalysis(withoutSecondary);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((error) => error.includes('secondaryDomains')));
  });

  it('secondaryDomains는 빈 배열이어도 된다', () => {
    const result = validateSituationAnalysis({ ...base(), secondaryDomains: [] });
    assert.equal(result.valid, true, result.errors.join(' / '));
  });

  it('실제로 함께 있는 상황은 secondaryDomains에 넣을 수 있다', () => {
    const result = validateSituationAnalysis({
      ...base(),
      primaryDomain: 'gratitude_joy',
      secondaryDomains: ['fear_uncertainty'],
    });
    assert.equal(result.valid, true, result.errors.join(' / '));
  });
});

describe('기존 Mock 8개의 domain', () => {
  const expected: Record<string, string> = {
    'SC-002': 'decision_guidance',
    'SC-004': 'gratitude_joy',
    'SC-003': 'waiting_unanswered_prayer',
    'SC-007': 'comparison_identity',
    'SC-008': 'injustice_mistreatment',
    'SC-009': 'grief_loss',
    'SC-006': 'repentance_guilt',
    'SC-005': 'quiet_communion',
  };

  for (const mockCase of MOCK_ANALYSIS_CASES) {
    it(`${mockCase.name} → ${expected[mockCase.expectedCardId]}`, () => {
      assert.equal(mockCase.analysis.primaryDomain, expected[mockCase.expectedCardId]);
      assert.deepEqual(mockCase.analysis.secondaryDomains, []);

      const coverage = getCoverage(mockCase.analysis.primaryDomain);
      assert.equal(coverage.covered, true);
      // Scripture Card Expansion v2 이후 이 영역들은 카드 3장을 갖는다.
      // 기존 mock이 가리키던 카드가 여전히 그 안에 있는지만 본다.
      assert.equal(coverage.cardIds.length, 3);
      assert.ok(coverage.cardIds.includes(mockCase.expectedCardId));
    });
  }
});
