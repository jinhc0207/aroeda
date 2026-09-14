/**
 * 영역 선택 해석 순수 테스트
 *
 * 실행: npm test
 *
 * 네트워크·DB·OpenAI 호출이 없다. 분석 결과 모양만 바꿔 넣어 확인한다.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { isChoosableDomain, resolveAnalysisForChosenDomain } from '../../supabase/functions/_shared/domain-choice-resolution.ts';
import { validateSituationAnalysis, type SituationAnalysis } from '../../supabase/functions/_shared/situation-analysis.ts';

const TAGS = {
  situationTags: ['생활비 부족', '두려운 일을 앞둠'],
  emotionTags: ['불안'],
  spiritualQuestionTags: ['신뢰'],
  prayerModes: ['간구'],
  pastoralFunctions: ['위로'],
};

const needsChoice: SituationAnalysis = {
  domainPriority: 'needs_choice',
  primaryDomain: null,
  domainChoiceCandidates: ['financial_hardship', 'fear_uncertainty'],
  secondaryDomains: [],
  ...TAGS,
  safety: { level: 'normal', categories: [] },
  confidence: 0.7,
};

const resolved: SituationAnalysis = {
  domainPriority: 'resolved',
  primaryDomain: 'financial_hardship',
  domainChoiceCandidates: [],
  secondaryDomains: ['fear_uncertainty', 'burnout_exhaustion'],
  ...TAGS,
  safety: { level: 'normal', categories: [] },
  confidence: 0.9,
};

const unchangedParts = (analysis: SituationAnalysis) => ({
  situationTags: analysis.situationTags,
  emotionTags: analysis.emotionTags,
  spiritualQuestionTags: analysis.spiritualQuestionTags,
  prayerModes: analysis.prayerModes,
  pastoralFunctions: analysis.pastoralFunctions,
  safety: analysis.safety,
  confidence: analysis.confidence,
});

describe('영역 선택 해석 · needs_choice', () => {
  it('첫 후보를 고르면 그 영역이 primary, 나머지 후보가 secondary다', () => {
    const result = resolveAnalysisForChosenDomain(needsChoice, 'financial_hardship');
    assert.ok(result);
    assert.equal(result.domainPriority, 'resolved');
    assert.equal(result.primaryDomain, 'financial_hardship');
    assert.deepEqual(result.domainChoiceCandidates, []);
    assert.deepEqual(result.secondaryDomains, ['fear_uncertainty']);
    assert.equal(validateSituationAnalysis(result).valid, true);
  });

  it('둘째 후보를 고르면 첫 후보가 secondary로 간다', () => {
    const result = resolveAnalysisForChosenDomain(needsChoice, 'fear_uncertainty');
    assert.ok(result);
    assert.equal(result.primaryDomain, 'fear_uncertainty');
    assert.deepEqual(result.secondaryDomains, ['financial_hardship']);
    assert.deepEqual(result.domainChoiceCandidates, []);
    assert.equal(validateSituationAnalysis(result).valid, true);
  });

  it('후보 밖 영역은 거절한다 (분석에 없는 영역을 끼워 넣지 않는다)', () => {
    assert.equal(resolveAnalysisForChosenDomain(needsChoice, 'grief_loss'), null);
  });

  it('other_uncovered는 고를 수 없다', () => {
    assert.equal(resolveAnalysisForChosenDomain(needsChoice, 'other_uncovered'), null);
    assert.equal(isChoosableDomain('other_uncovered'), false);
  });

  it('잘못된 타입과 모르는 값은 거절한다', () => {
    for (const bad of [undefined, null, 42, true, {}, [], ['financial_hardship'], '', '재정', 'FINANCIAL_HARDSHIP', ' financial_hardship']) {
      assert.equal(resolveAnalysisForChosenDomain(needsChoice, bad), null, JSON.stringify(bad));
      assert.equal(isChoosableDomain(bad), false, JSON.stringify(bad));
    }
  });

  it('태그·safety·confidence를 바꾸지 않고, 입력 분석도 바꾸지 않는다', () => {
    const before = structuredClone(needsChoice);
    for (const domain of needsChoice.domainChoiceCandidates) {
      const result = resolveAnalysisForChosenDomain(needsChoice, domain);
      assert.ok(result);
      assert.deepEqual(unchangedParts(result), unchangedParts(needsChoice));
    }
    assert.deepEqual(needsChoice, before);
  });

  it('안전 신호가 있어도 그대로 남긴다 (영역 선택이 안전을 지우지 않는다)', () => {
    const risky: SituationAnalysis = { ...needsChoice, safety: { level: 'urgent', categories: ['suicide'] } };
    const result = resolveAnalysisForChosenDomain(risky, 'fear_uncertainty');
    assert.ok(result);
    assert.deepEqual(result.safety, { level: 'urgent', categories: ['suicide'] });
  });
});

describe('영역 선택 해석 · resolved (재분석 차이 허용)', () => {
  it('현재 primary를 다시 고르면 그대로 유지된다', () => {
    const result = resolveAnalysisForChosenDomain(resolved, 'financial_hardship');
    assert.ok(result);
    assert.equal(result.primaryDomain, 'financial_hardship');
    assert.deepEqual(result.secondaryDomains, ['fear_uncertainty', 'burnout_exhaustion']);
    assert.deepEqual(result.domainChoiceCandidates, []);
    assert.equal(validateSituationAnalysis(result).valid, true);
  });

  it('secondary를 고르면 그 영역이 primary가 되고 기존 primary는 secondary로 간다', () => {
    const result = resolveAnalysisForChosenDomain(resolved, 'fear_uncertainty');
    assert.ok(result);
    assert.equal(result.domainPriority, 'resolved');
    assert.equal(result.primaryDomain, 'fear_uncertainty');
    assert.deepEqual(result.secondaryDomains, ['financial_hardship', 'burnout_exhaustion']);
    assert.equal(validateSituationAnalysis(result).valid, true);
  });

  it('secondary는 중복 없이 보존되고 고른 영역은 secondary에 남지 않는다', () => {
    const result = resolveAnalysisForChosenDomain(resolved, 'burnout_exhaustion');
    assert.ok(result);
    assert.equal(result.primaryDomain, 'burnout_exhaustion');
    assert.deepEqual(result.secondaryDomains, ['financial_hardship', 'fear_uncertainty']);
    assert.equal(new Set(result.secondaryDomains).size, result.secondaryDomains.length);
    assert.equal(result.secondaryDomains.includes('burnout_exhaustion'), false);
  });

  it('분석 어디에도 없는 영역은 거절한다', () => {
    assert.equal(resolveAnalysisForChosenDomain(resolved, 'grief_loss'), null);
    assert.equal(resolveAnalysisForChosenDomain(resolved, 'other_uncovered'), null);
  });

  it('태그·safety·confidence를 바꾸지 않는다', () => {
    const result = resolveAnalysisForChosenDomain(resolved, 'fear_uncertainty');
    assert.ok(result);
    assert.deepEqual(unchangedParts(result), unchangedParts(resolved));
  });

  it('resolved인데 primary가 null인 검증되지 않은 입력은 거절한다', () => {
    assert.equal(
      resolveAnalysisForChosenDomain({ ...resolved, primaryDomain: null, secondaryDomains: ['fear_uncertainty'] }, 'fear_uncertainty'),
      null,
    );
  });
});
