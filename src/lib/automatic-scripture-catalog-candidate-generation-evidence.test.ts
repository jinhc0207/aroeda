import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import {
  type ScriptureCatalogCandidate,
  computeCatalogCandidateHash,
} from '../../supabase/functions/_shared/automatic-scripture-catalog-contract.ts';
import { buildCurrentAnalysisSnapshotEnvironment } from '../../supabase/functions/_shared/automatic-scripture-catalog-analysis-environment.ts';
import {
  CANDIDATE_GENERATION_CASE_AUTHOR_PROFILE,
  type CandidateGenerationEvidence,
  buildCandidateGenerationEvidenceAdapter,
  computeCandidateGenerationCaseAuthorProfileHash,
  computeCandidateGenerationEvidenceArtifactHash,
  sealCandidateGenerationEvidence,
  validateCandidateGenerationEvidence,
} from '../../supabase/functions/_shared/automatic-scripture-catalog-candidate-generation-evidence.ts';
import {
  buildCaseAuthorResponseFormat,
  computeCaseAuthorInstructionsHash,
  computeCaseAuthorSchemaHash,
} from '../../supabase/functions/_shared/automatic-scripture-catalog-case-author-contract.ts';
import { computeArtifactHash } from '../../supabase/functions/_shared/automatic-scripture-catalog-contract.ts';
import {
  CANDIDATE_GENERATION_ANALYSIS_REQUEST_OVERRIDES,
  buildCandidateGenerationAnalysisRequest,
  computeCandidateGenerationAnalysisRequestHash,
  projectAnalysisRequestForHash,
} from '../../supabase/functions/_shared/automatic-scripture-catalog-generation-analysis-request.ts';
import { buildCaseAuthorRequest } from '../../supabase/functions/_shared/automatic-scripture-catalog-case-author.ts';
import type { SituationAnalysis } from '../../supabase/functions/_shared/situation-analysis.ts';
import {
  buildBaselineCatalog,
  finalizeCandidate,
  makeExistingDomainCandidate,
  makeNewDomainCandidate,
} from './automatic-scripture-catalog-test-fixtures.ts';

const analysis = (): SituationAnalysis => ({
  domainPriority: 'resolved',
  primaryDomain: 'decision_guidance',
  domainChoiceCandidates: [],
  secondaryDomains: [],
  situationTags: ['오래된 기도'],
  emotionTags: ['걱정'],
  spiritualQuestionTags: ['지혜'],
  prayerModes: ['간구'],
  pastoralFunctions: ['인도'],
  safety: { level: 'normal', categories: [] },
  confidence: 0.91,
});

async function productionModelCandidate(cardId = 'SC-052') {
  const base = buildBaselineCatalog();
  const { candidate: fixture } = await makeExistingDomainCandidate(base, cardId);
  const { baseVersionHash: _base, proposedVersionHash: _proposed, ...draft } = fixture;
  draft.cards[0].situationTags = ['오래된 기도'];
  draft.generation = {
    method: 'automated',
    modelId: 'gpt-5.6-sol',
    promptVersion: 'aroeda-published-content-candidate/v1',
  };
  const built = await finalizeCandidate(base, draft);
  return { base, ...built };
}

async function validEvidence() {
  const built = await productionModelCandidate();
  const card = built.candidate.cards[0];
  const environment = await buildCurrentAnalysisSnapshotEnvironment(built.candidate.baseVersionHash);
  const evidence = await sealCandidateGenerationEvidence({
    candidate: built.candidate,
    environment,
    cases: ['결정을 앞두고 오래 기도했지만 아직 마음이 복잡해요.', '중요한 선택 앞에서 지혜를 구하고 있어요.', '앞으로 갈 길을 정할 때 흔들리지 않도록 도움받고 싶어요.'].map(
      (text, index) => ({
        caseId: `GEN-${card.id}-${String(index + 1).padStart(2, '0')}`,
        cardId: card.id,
        text,
        analysis: analysis(),
      }),
    ),
  });
  return { ...built, evidence };
}

async function reseal(evidence: CandidateGenerationEvidence): Promise<CandidateGenerationEvidence> {
  const { artifactHash: _old, ...withoutHash } = evidence;
  return { ...withoutHash, artifactHash: await computeCandidateGenerationEvidenceArtifactHash(withoutHash) };
}

describe('후보 생성 사례 증거 v1', () => {
  it('후보·연구·현재 환경·Astra profile·카드별 3건을 하나의 재계산 지문으로 검증한다', async () => {
    const { base, candidate, evidence } = await validEvidence();
    assert.deepEqual(await validateCandidateGenerationEvidence(evidence, candidate, base), { valid: true, errors: [] });
    assert.equal(evidence.candidateHash, await computeCatalogCandidateHash(candidate));
    assert.equal(evidence.cases.length, 3);
  });

  it('실제 후보 catalog Gate로 세 사례를 재생해 해당 카드 선택 여부만 판정한다', async () => {
    const { base, candidate, evidence } = await validEvidence();
    const built = await buildCandidateGenerationEvidenceAdapter(evidence, candidate, base);
    if (!built.ok) throw new Error(built.errors.join(' / '));
    assert.equal(built.ok, true);
    const payload = await built.evaluateCandidateGeneration(candidate);
    assert.equal(payload.evidenceArtifactHash, evidence.artifactHash);
    assert.deepEqual(payload.cases.map((item) => item.caseId), ['GEN-SC-052-01', 'GEN-SC-052-02', 'GEN-SC-052-03']);
    assert.equal(payload.cases.every((item) => item.cardId === 'SC-052' && item.passed), true);
  });

  it('후보 생성 모델과 같은 Sol 계열이 사례를 쓰는 자기 채점을 거절한다', async () => {
    const { base, candidate, evidence } = await validEvidence();
    evidence.caseAuthorProfile = {
      ...evidence.caseAuthorProfile,
      modelId: 'gpt-5.6-terra',
      independenceGroup: 'openai-gpt-5-6',
    };
    evidence.caseAuthorProfileHash = await computeCandidateGenerationCaseAuthorProfileHash(evidence.caseAuthorProfile);
    const result = await validateCandidateGenerationEvidence(await reseal(evidence), candidate, base);
    assert.equal(result.valid, false);
    assert.equal(result.errors.some((item) => item.includes('등록된 Astra')), true);
    assert.equal(result.errors.some((item) => item.includes('독립된 모델 계열')), true);
  });

  it('Astra라는 모델명만 같고 profile 계약이 임의로 바뀐 경우를 거절한다', async () => {
    const { base, candidate, evidence } = await validEvidence();
    evidence.caseAuthorProfile.promptVersion = 'arbitrary-prompt/v9';
    evidence.caseAuthorProfileHash = await computeCandidateGenerationCaseAuthorProfileHash(evidence.caseAuthorProfile);
    const result = await validateCandidateGenerationEvidence(await reseal(evidence), candidate, base);
    assert.equal(result.valid, false);
    assert.equal(result.errors.some((item) => item.includes('등록된 Astra 사례 작성 profile')), true);
  });

  it('profileHash를 임의 값으로 쓰고 최상위 지문만 다시 맞춰도 거절한다', async () => {
    const { base, candidate, evidence } = await validEvidence();
    evidence.caseAuthorProfileHash = `sart_${'1'.repeat(64)}`;
    const result = await validateCandidateGenerationEvidence(await reseal(evidence), candidate, base);
    assert.equal(result.valid, false);
    assert.equal(result.errors.some((item) => item.includes('profile에서 다시 계산')), true);
  });

  it('다른 후보 지문에 붙인 증거를 최상위 지문까지 다시 봉인해도 거절한다', async () => {
    const { base, candidate, evidence } = await validEvidence();
    evidence.candidateHash = `sccand_${'2'.repeat(64)}`;
    const result = await validateCandidateGenerationEvidence(await reseal(evidence), candidate, base);
    assert.equal(result.valid, false);
    assert.equal(result.errors.some((item) => item.includes('후보에서 다시 계산')), true);
  });

  it('연구 결과·기준 버전·제안 버전 중 하나라도 후보와 다르면 거절한다', async () => {
    for (const field of ['sourceResearchResultHash', 'baseVersionHash', 'proposedVersionHash'] as const) {
      const { base, candidate, evidence } = await validEvidence();
      evidence[field] = `${field === 'sourceResearchResultHash' ? 'rres' : 'scat'}_${'3'.repeat(64)}`;
      const result = await validateCandidateGenerationEvidence(await reseal(evidence), candidate, base);
      assert.equal(result.valid, false, field);
      assert.equal(result.errors.some((item) => item.includes(`evidence.${field}: 후보와 다릅니다.`)), true, field);
    }
  });

  it('사례를 바꾸고 artifactHash를 갱신하지 않으면 내용 재계산으로 거절한다', async () => {
    const { base, candidate, evidence } = await validEvidence();
    evidence.cases[0].text = '내용을 바꿨지만 지문은 그대로 둔 합성 문장입니다.';
    const result = await validateCandidateGenerationEvidence(evidence, candidate, base);
    assert.equal(result.valid, false);
    assert.equal(result.errors.some((item) => item.includes('내용에서 다시 계산')), true);
  });

  it('카드별 사례가 3건보다 적거나 많으면 거절한다', async () => {
    for (const mode of ['few', 'extra'] as const) {
      const { base, candidate, evidence } = await validEvidence();
      if (mode === 'few') evidence.cases.pop();
      else evidence.cases.push({ ...structuredClone(evidence.cases[2]), caseId: 'GEN-SC-052-04', text: '네 번째 사례입니다.' });
      const result = await validateCandidateGenerationEvidence(await reseal(evidence), candidate, base);
      assert.equal(result.valid, false, mode);
      assert.equal(result.errors.some((item) => item.includes('카드마다 정확히 3건')), true, mode);
    }
  });

  it('사례 id 순서를 바꾸거나 text를 중복하면 거절한다', async () => {
    const { base, candidate, evidence } = await validEvidence();
    [evidence.cases[0], evidence.cases[1]] = [evidence.cases[1], evidence.cases[0]];
    evidence.cases[2].text = evidence.cases[1].text;
    const result = await validateCandidateGenerationEvidence(await reseal(evidence), candidate, base);
    assert.equal(result.valid, false);
    assert.equal(result.errors.some((item) => item.includes("'GEN-SC-052-01'이어야")), true);
    assert.equal(result.errors.some((item) => item.includes('text가 중복')), true);
  });

  it('합성 문장에 카드 id·영역 id·성경 표기를 직접 넣으면 거절한다', async () => {
    for (const text of ['SC-052가 필요해요.', 'decision_guidance 상황입니다.', '잠언 16:1–3을 주세요.']) {
      const { base, candidate, evidence } = await validEvidence();
      evidence.cases[0].text = text;
      const result = await validateCandidateGenerationEvidence(await reseal(evidence), candidate, base);
      assert.equal(result.valid, false, text);
      assert.equal(result.errors.some((item) => item.includes('직접 포함할 수 없습니다')), true, text);
    }
  });

  it('analysis와 safety 내부의 계약 밖 필드를 거절한다', async () => {
    const { base, candidate, evidence } = await validEvidence();
    (evidence.cases[0].analysis as unknown as Record<string, unknown>).rawResponse = 'provider output';
    (evidence.cases[1].analysis.safety as unknown as Record<string, unknown>).sessionId = 'session-value';
    const result = await validateCandidateGenerationEvidence(await reseal(evidence), candidate, base);
    assert.equal(result.valid, false);
    assert.equal(result.errors.some((item) => item.includes('rawResponse')), true);
    assert.equal(result.errors.some((item) => item.includes('sessionId')), true);
  });

  it('위험·영역 선택·대상 영역 불일치 분석을 각각 거절한다', async () => {
    const mutations = [
      (item: SituationAnalysis) => { item.safety = { level: 'caution', categories: ['abuse'] }; },
      (item: SituationAnalysis) => {
        item.domainPriority = 'needs_choice';
        item.primaryDomain = null;
        item.domainChoiceCandidates = ['decision_guidance', 'fear_uncertainty'];
      },
      (item: SituationAnalysis) => { item.primaryDomain = 'fear_uncertainty'; },
    ];
    for (const mutate of mutations) {
      const { base, candidate, evidence } = await validEvidence();
      mutate(evidence.cases[0].analysis);
      const result = await validateCandidateGenerationEvidence(await reseal(evidence), candidate, base);
      assert.equal(result.valid, false);
    }
  });

  it('현재 Analyzer 환경과 다른 증거를 자체 일관되게 다시 봉인해도 거절한다', async () => {
    const { base, candidate, evidence } = await validEvidence();
    evidence.environment.analyzerInstructionsHash = `sart_${'4'.repeat(64)}`;
    const result = await validateCandidateGenerationEvidence(await reseal(evidence), candidate, base);
    assert.equal(result.valid, false);
    assert.equal(result.errors.some((item) => item.includes('현재 Analyzer 환경')), true);
  });

  it('현재 정적 domain manifest로 분석할 수 없는 새 영역 후보는 증거 생성 여부와 무관하게 닫힌다', async () => {
    const base = buildBaselineCatalog();
    const { candidate } = await makeNewDomainCandidate(base);
    const result = await validateCandidateGenerationEvidence({}, candidate, base);
    assert.deepEqual(result, {
      valid: false,
      errors: ['candidate: 동적 Analyzer domain manifest가 없어서 새 영역 생성 사례를 검증할 수 없습니다.'],
    });
  });

  it('호출자가 build 뒤 원본을 바꾸거나 반환 payload를 바꿔도 다음 결과는 변하지 않는다', async () => {
    const { base, candidate, evidence } = await validEvidence();
    const built = await buildCandidateGenerationEvidenceAdapter(evidence, candidate, base);
    if (!built.ok) throw new Error(built.errors.join(' / '));
    const runtimeCandidate = structuredClone(candidate);
    evidence.cases[0].analysis.primaryDomain = 'fear_uncertainty';
    candidate.cards[0].situationTags = [];
    base.cards.splice(0, base.cards.length);
    const first = await built.evaluateCandidateGeneration(runtimeCandidate);
    first.cases[0].passed = false;
    first.cases.reverse();
    const second = await built.evaluateCandidateGeneration(runtimeCandidate);
    assert.deepEqual(second.cases.map((item) => item.caseId), ['GEN-SC-052-01', 'GEN-SC-052-02', 'GEN-SC-052-03']);
    assert.equal(second.cases.every((item) => item.passed), true);
  });

  it('build 때와 다른 후보로 adapter를 실행하면 증거 재사용을 거절한다', async () => {
    const { base, candidate, evidence } = await validEvidence();
    const built = await buildCandidateGenerationEvidenceAdapter(evidence, candidate, base);
    if (!built.ok) throw new Error(built.errors.join(' / '));
    const { candidate: otherFixture } = await makeExistingDomainCandidate(base, 'SC-053');
    const { baseVersionHash: _base, proposedVersionHash: _proposed, ...draft } = otherFixture;
    draft.generation = structuredClone(candidate.generation);
    const other = await finalizeCandidate(base, draft);
    await assert.rejects(
      () => built.evaluateCandidateGeneration(other.candidate),
      /실행 후보가 증거에 결속된 후보와 다릅니다/,
    );
  });

  it('현재 생성 모델이 아닌 후보는 모델 계열을 아는 경우에도 거절한다', async () => {
    const { base, candidate, evidence } = await validEvidence();
    const { baseVersionHash: _base, proposedVersionHash: _proposed, ...draft } = candidate;
    draft.generation.modelId = 'gpt-5.6-terra';
    const changed = await finalizeCandidate(base, draft);
    const result = await validateCandidateGenerationEvidence(evidence, changed.candidate, base);
    assert.equal(result.valid, false);
    assert.equal(result.errors.some((item) => item.includes('현재 자동 후보 생성 모델')), true);
  });

  it('등록 profile 상수는 Astra와 openai-gpt-6 그룹을 고정하고 지시문 지문을 함께 든다', async () => {
    assert.deepEqual(CANDIDATE_GENERATION_CASE_AUTHOR_PROFILE, {
      contractVersion: 'scripture-catalog-candidate-generation-case-author-profile/v1',
      profileId: 'aroeda-candidate-generation-case-author-astra',
      profileVersion: 'v1',
      modelId: 'gpt-6-astra',
      independenceGroup: 'openai-gpt-6',
      promptVersion: 'aroeda-candidate-generation-case-author/v1',
      instructionsHash: await computeCaseAuthorInstructionsHash(),
      schemaVersion: 'aroeda-candidate-generation-case-author-schema/v1',
    });
  });

  describe('사례 저작 설정의 결속', () => {
    it('봉인한 schemaHash는 실제 요청에 실린 text.format의 지문과 같다', async () => {
      const { base, candidate, evidence } = await validEvidence();
      const spec = await buildCaseAuthorRequest(candidate, base);
      const sentFormat = (spec.body.text as { format: unknown }).format;
      assert.equal(evidence.caseAuthorRequest.schemaHash, await computeArtifactHash(sentFormat));
      assert.deepEqual(sentFormat, buildCaseAuthorResponseFormat(candidate.cards.map((card) => card.id)));
    });

    it('카드 구성이 다른 후보는 schemaHash가 서로 다르다', async () => {
      assert.notEqual(
        await computeCaseAuthorSchemaHash(['SC-052']),
        await computeCaseAuthorSchemaHash(['SC-052', 'SC-053']),
      );
    });

    it('지시문만 바뀐 설정으로 봉인한 증거를 거절한다', async () => {
      const { base, candidate, evidence } = await validEvidence();
      // 이전 지시문으로 봉인해 둔 증거를 흉내낸다. 하위·최상위 지문은 전부 다시 맞춘다.
      evidence.caseAuthorProfile = {
        ...evidence.caseAuthorProfile,
        instructionsHash: await computeArtifactHash('이전 판 사례 저작 지시문'),
      };
      evidence.caseAuthorProfileHash = await computeCandidateGenerationCaseAuthorProfileHash(evidence.caseAuthorProfile);
      const result = await validateCandidateGenerationEvidence(await reseal(evidence), candidate, base);
      assert.equal(result.valid, false);
      assert.equal(
        result.errors.some((item) => item.includes('지금 사례 저작 지시문에서 다시 계산')),
        true,
        result.errors.join(' / '),
      );
    });

    it('스키마만 바뀐 설정으로 봉인한 증거를 거절한다', async () => {
      const { base, candidate, evidence } = await validEvidence();
      // 카드 id는 그대로 두고 사례 수 상한만 늘린 스키마로 봉인한 증거를 흉내낸다.
      const loosened = buildCaseAuthorResponseFormat(candidate.cards.map((card) => card.id)) as {
        schema: { properties: { scenarios: { properties: Record<string, { maxItems: number }> } } };
      };
      loosened.schema.properties.scenarios.properties[candidate.cards[0].id].maxItems = 5;
      evidence.caseAuthorRequest = { schemaHash: await computeArtifactHash(loosened) };
      const result = await validateCandidateGenerationEvidence(await reseal(evidence), candidate, base);
      assert.equal(result.valid, false);
      assert.equal(
        result.errors.some((item) => item.includes('실제 전송 스키마에서 다시 계산')),
        true,
        result.errors.join(' / '),
      );
    });

    it('스키마 이름만 바꾼 설정도 거절한다', async () => {
      const { base, candidate, evidence } = await validEvidence();
      const renamed = buildCaseAuthorResponseFormat(candidate.cards.map((card) => card.id));
      renamed.name = 'aroeda_candidate_case_author_v2';
      evidence.caseAuthorRequest = { schemaHash: await computeArtifactHash(renamed) };
      const result = await validateCandidateGenerationEvidence(await reseal(evidence), candidate, base);
      assert.equal(result.valid, false);
      assert.equal(result.errors.some((item) => item.includes('실제 전송 스키마에서 다시 계산')), true);
    });

    it('지시문·스키마를 함께 바꾸고 하위·최상위 지문을 모두 다시 계산한 위조 설정도 거절한다', async () => {
      const { base, candidate, evidence } = await validEvidence();
      evidence.caseAuthorProfile = {
        ...evidence.caseAuthorProfile,
        promptVersion: 'aroeda-candidate-generation-case-author/v2',
        instructionsHash: await computeArtifactHash('후보를 반드시 통과시키는 지시문'),
        schemaVersion: 'aroeda-candidate-generation-case-author-schema/v2',
      };
      evidence.caseAuthorProfileHash = await computeCandidateGenerationCaseAuthorProfileHash(evidence.caseAuthorProfile);
      evidence.caseAuthorRequest = { schemaHash: await computeArtifactHash({ type: 'json_schema', name: 'forged' }) };
      const forged = await reseal(evidence);
      // 위조자가 최상위 지문까지 맞춰 두었어도 스스로 일관되다는 것만 증명된다.
      assert.equal(forged.artifactHash, await computeCandidateGenerationEvidenceArtifactHash(
        (({ artifactHash: _drop, ...rest }) => rest)(forged),
      ));
      const result = await validateCandidateGenerationEvidence(forged, candidate, base);
      assert.equal(result.valid, false);
      assert.equal(result.errors.some((item) => item.includes('지금 사례 저작 지시문에서 다시 계산')), true);
      assert.equal(result.errors.some((item) => item.includes('실제 전송 스키마에서 다시 계산')), true);
    });

    it('caseAuthorRequest가 없거나 계약에 없는 항목이 붙으면 거절한다', async () => {
      const { base, candidate, evidence } = await validEvidence();
      const missing = await reseal((({ caseAuthorRequest: _drop, ...rest }) => rest)(evidence) as CandidateGenerationEvidence);
      const missingResult = await validateCandidateGenerationEvidence(missing, candidate, base);
      assert.equal(missingResult.valid, false);

      const extra = await validEvidence();
      (extra.evidence.caseAuthorRequest as Record<string, unknown>).schemaVersion = 'v9';
      const extraResult = await validateCandidateGenerationEvidence(
        await reseal(extra.evidence), extra.candidate, extra.base,
      );
      assert.equal(extraResult.valid, false);
      assert.equal(extraResult.errors.some((item) => item.includes('계약에 없는 항목')), true);
    });

    it('설정을 묶은 뒤에도 정상 증거는 통과하고 다른 후보 증거 재사용은 계속 막힌다', async () => {
      const { base, candidate, evidence } = await validEvidence();
      assert.deepEqual(await validateCandidateGenerationEvidence(evidence, candidate, base), { valid: true, errors: [] });

      const other = await productionModelCandidate('SC-053');
      assert.notEqual(other.candidate.cards[0].id, candidate.cards[0].id);
      const crossed = await validateCandidateGenerationEvidence(evidence, other.candidate, other.base);
      assert.equal(crossed.valid, false);
      assert.equal(crossed.errors.some((item) => item.includes('후보에서 다시 계산')), true);

      const adapter = await buildCandidateGenerationEvidenceAdapter(evidence, candidate, base);
      if (!adapter.ok) throw new Error(adapter.errors.join(' / '));
      await assert.rejects(
        () => adapter.evaluateCandidateGeneration(other.candidate),
        /증거에 결속된 후보와 다릅니다/,
      );
    });
  });

  describe('생성용 Analyzer 요청 설정의 결속', () => {
    /** 실제 설정을 한 군데만 바꾼 본문의 지문. 원본 상수는 건드리지 않는다. */
    async function hashWithOverride(patch: Record<string, unknown>): Promise<string> {
      const body = { ...buildCandidateGenerationAnalysisRequest('임의의 문장'), ...patch };
      return computeArtifactHash(projectAnalysisRequestForHash(body));
    }

    it('봉인한 지문은 지금 요청 생성 함수의 지문과 같다', async () => {
      const { evidence } = await validEvidence();
      assert.equal(evidence.analysisRequest.requestHash, await computeCandidateGenerationAnalysisRequestHash());
    });

    it('문장이 달라도 설정 지문은 같다', async () => {
      const first = projectAnalysisRequestForHash(buildCandidateGenerationAnalysisRequest('첫 번째 상황 문장입니다.'));
      const second = projectAnalysisRequestForHash(buildCandidateGenerationAnalysisRequest('전혀 다른 두 번째 문장입니다.'));
      assert.equal(await computeArtifactHash(first), await computeArtifactHash(second));
      assert.equal('input' in first, false, 'input은 지문에서 빠져야 한다');
      // 모델·지시문·Structured Output 설정과 추가 설정이 모두 들어 있어야 한다.
      assert.deepEqual(Object.keys(first).sort(), [
        'background', 'instructions', 'max_output_tokens', 'model', 'store', 'stream', 'text', 'tools', 'truncation',
      ]);
    });

    it('문장을 바꾸면 증거 최상위 지문은 달라진다', async () => {
      const { evidence } = await validEvidence();
      const changed = structuredClone(evidence);
      changed.cases[0].text = '같은 뜻이지만 표현을 바꾼 문장이에요.';
      const resealed = await reseal(changed);
      assert.equal(resealed.analysisRequest.requestHash, evidence.analysisRequest.requestHash);
      assert.notEqual(resealed.artifactHash, evidence.artifactHash);
    });

    for (const [name, patch] of [
      ['max_output_tokens', { max_output_tokens: 4_096 }],
      ['tools', { tools: [{ type: 'web_search' }] }],
      ['stream', { stream: true }],
      ['background', { background: true }],
      ['truncation', { truncation: 'auto' }],
      ['store', { store: true }],
      ['model', { model: 'gpt-5.6-sol' }],
    ] as const) {
      it(`${name}를 바꾼 설정으로 봉인한 증거를 거절한다`, async () => {
        const { base, candidate, evidence } = await validEvidence();
        evidence.analysisRequest = { requestHash: await hashWithOverride(patch) };
        // 저장된 설정 지문과 최상위 지문을 함께 다시 계산해도 통과하면 안 된다.
        const forged = await reseal(evidence);
        assert.equal(
          forged.artifactHash,
          await computeCandidateGenerationEvidenceArtifactHash(
            (({ artifactHash: _drop, ...rest }) => rest)(forged),
          ),
        );
        const result = await validateCandidateGenerationEvidence(forged, candidate, base);
        assert.equal(result.valid, false);
        assert.equal(
          result.errors.some((item) => item.includes('지금 생성용 Analyzer 요청 설정에서 다시 계산')),
          true,
          result.errors.join(' / '),
        );
      });
    }

    it('추가 설정 다섯 가지가 실제로 지문에 들어간다', async () => {
      const current = await computeCandidateGenerationAnalysisRequestHash();
      for (const key of Object.keys(CANDIDATE_GENERATION_ANALYSIS_REQUEST_OVERRIDES)) {
        const body = buildCandidateGenerationAnalysisRequest('임의의 문장');
        delete (body as Record<string, unknown>)[key];
        const withoutKey = await computeArtifactHash(projectAnalysisRequestForHash(body));
        assert.notEqual(withoutKey, current, `${key}가 지문에 없으면 안 된다`);
      }
    });

    it('설정 지문 누락·잘못된 타입·계약 밖 필드를 거절한다', async () => {
      const missing = await validEvidence();
      const dropped = await reseal(
        (({ analysisRequest: _drop, ...rest }) => rest)(missing.evidence) as CandidateGenerationEvidence,
      );
      const missingResult = await validateCandidateGenerationEvidence(dropped, missing.candidate, missing.base);
      assert.equal(missingResult.valid, false);
      assert.equal(missingResult.errors.some((item) => item.includes('analysisRequest')), true);

      for (const bad of [null, 'sart_abc', 42, [], { requestHash: 42 }] as const) {
        const built = await validEvidence();
        (built.evidence as unknown as Record<string, unknown>).analysisRequest = bad;
        const result = await validateCandidateGenerationEvidence(
          await reseal(built.evidence), built.candidate, built.base,
        );
        assert.equal(result.valid, false, JSON.stringify(bad));
      }

      const extra = await validEvidence();
      (extra.evidence.analysisRequest as Record<string, unknown>).maxOutputTokens = 8_192;
      const extraResult = await validateCandidateGenerationEvidence(
        await reseal(extra.evidence), extra.candidate, extra.base,
      );
      assert.equal(extraResult.valid, false);
      assert.equal(extraResult.errors.some((item) => item.includes('계약에 없는 항목')), true);
    });

    it('증거에 키·인증 헤더·원본 응답·토큰 사용량이 들어가지 않는다', async () => {
      const { evidence } = await validEvidence();
      const serialized = JSON.stringify(evidence);
      for (const marker of ['authorization', 'Bearer', 'apiKey', 'api_key', 'usage', 'rawResponse', 'output_text']) {
        assert.equal(serialized.includes(marker), false, marker);
      }
    });

    it('설정을 묶은 뒤에도 후보 결속과 저작 지시문·스키마 결속이 유지된다', async () => {
      const { base, candidate, evidence } = await validEvidence();
      assert.deepEqual(await validateCandidateGenerationEvidence(evidence, candidate, base), { valid: true, errors: [] });
      const other = await productionModelCandidate('SC-053');
      const crossed = await validateCandidateGenerationEvidence(evidence, other.candidate, other.base);
      assert.equal(crossed.valid, false);
      assert.equal(crossed.errors.some((item) => item.includes('후보에서 다시 계산')), true);

      const tampered = structuredClone(evidence);
      tampered.caseAuthorProfile.instructionsHash = await computeArtifactHash('이전 판 지시문');
      tampered.caseAuthorProfileHash = await computeCandidateGenerationCaseAuthorProfileHash(tampered.caseAuthorProfile);
      const instructionsResult = await validateCandidateGenerationEvidence(await reseal(tampered), candidate, base);
      assert.equal(instructionsResult.valid, false);
      assert.equal(
        instructionsResult.errors.some((item) => item.includes('지금 사례 저작 지시문에서 다시 계산')),
        true,
      );
    });
  });

  it('계약과 adapter는 파일·네트워크·환경변수·시계를 읽지 않는다', () => {
    const source = readFileSync(
      new URL('../../supabase/functions/_shared/automatic-scripture-catalog-candidate-generation-evidence.ts', import.meta.url),
      'utf8',
    );
    for (const marker of ['node:fs', 'readFile', 'writeFile', 'fetch(', 'Deno.', 'process.env', 'Date.now', 'new Date']) {
      assert.equal(source.includes(marker), false, marker);
    }
  });
});
