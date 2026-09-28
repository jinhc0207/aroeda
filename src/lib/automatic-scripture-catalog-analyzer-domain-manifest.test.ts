import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import {
  buildBaselineCatalog,
  finalizeCandidate,
  makeNewDomainCandidate,
} from './automatic-scripture-catalog-test-fixtures.ts';
import {
  STATIC_ANALYZER_DOMAIN_MANIFEST,
  analyzerDomainIds,
  buildCatalogAnalyzerDomainManifest,
  buildCandidateAnalyzerDomainManifest,
  projectAnalyzerDomainManifestForHash,
} from '../../supabase/functions/_shared/automatic-scripture-catalog-analyzer-domain-manifest.ts';
import {
  INSTRUCTIONS,
  SITUATION_ANALYSIS_SCHEMA,
  buildAnalyzerInstructions,
  buildSituationAnalysisSchema,
} from '../../supabase/functions/_shared/analyzer-contract.ts';
import {
  buildCandidateGenerationAnalysisEnvironment,
  buildCurrentAnalysisSnapshotEnvironment,
} from '../../supabase/functions/_shared/automatic-scripture-catalog-analysis-environment.ts';
import {
  buildCandidateGenerationAnalysisRequest,
  computeCandidateGenerationAnalysisRequestHash,
} from '../../supabase/functions/_shared/automatic-scripture-catalog-generation-analysis-request.ts';
import {
  sealCandidateGenerationEvidence,
  validateCandidateGenerationEvidence,
} from '../../supabase/functions/_shared/automatic-scripture-catalog-candidate-generation-evidence.ts';
import {
  createCandidateGenerationEvidenceRunner,
  runCandidateGenerationEvidence,
} from '../../supabase/functions/_shared/automatic-scripture-catalog-generation-runner.ts';
import {
  validateSituationAnalysis,
  validateSituationAnalysisForDomains,
  type SituationAnalysis,
} from '../../supabase/functions/_shared/situation-analysis.ts';
import {
  canonicalJson,
  validateCatalogCandidate,
} from '../../supabase/functions/_shared/automatic-scripture-catalog-contract.ts';
import { MODEL } from '../../supabase/functions/_shared/analyzer-contract.ts';

const KEY = 'fixture-credential-not-real';
const TEXTS = [
  '오랫동안 가족을 돌보느라 제 마음을 살필 여유가 없어요.',
  '돌봄이 계속되면서 지쳤지만 맡은 사람을 외면할 수도 없어요.',
  '가족을 보살피는 긴 시간 속에서 힘과 위로가 필요해요.',
];

const response = (value: unknown, model = 'gpt-6-astra') => ({
  status: 'completed', model, error: null,
  output: [{ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: JSON.stringify(value) }] }],
});

async function fixture() {
  const base = buildBaselineCatalog();
  const { candidate: source } = await makeNewDomainCandidate(base);
  const { baseVersionHash: _base, proposedVersionHash: _proposed, ...draft } = source;
  draft.generation = {
    method: 'automated',
    modelId: 'gpt-5.6-sol',
    promptVersion: 'aroeda-published-content-candidate/v1',
  };
  return { base, ...(await finalizeCandidate(base, draft)) };
}

const analysis = (domain: string): SituationAnalysis<string> => ({
  domainPriority: 'resolved',
  primaryDomain: domain,
  domainChoiceCandidates: [],
  secondaryDomains: [],
  situationTags: ['시험용 상황'],
  emotionTags: ['지침'],
  spiritualQuestionTags: ['위로'],
  prayerModes: ['간구'],
  pastoralFunctions: ['위로'],
  safety: { level: 'normal', categories: [] },
  confidence: 0.92,
});

const scenarios = (cardIds: readonly string[]) => ({
  scenarios: Object.fromEntries(cardIds.map((id, cardIndex) => [
    id,
    TEXTS.map((text, textIndex) => `${text} ${cardIndex + 1}-${textIndex + 1}`),
  ])),
});

describe('자동 Scripture Catalog · 동적 Analyzer domain manifest', () => {
  it('내부 테스트에서 확인한 축약형·짧은 질병 문장을 표면 문구 때문에 needs_detail로 보내지 않는다', () => {
    const instructions = buildAnalyzerInstructions(STATIC_ANALYZER_DOMAIN_MANIFEST);
    assert.equal(
      instructions.includes(['"감기가 오래가서 힘들다."', '→ primaryDomain = chronic_illness'].join('\n')),
      true,
    );
    assert.equal(
      instructions.includes([
        '"부모님이 늘 다른 사람과 나를 비교하세요."',
        '→ primaryDomain = comparison_identity',
        '금지: family_parenting_conflict',
      ].join('\n')),
      true,
    );
    assert.equal(
      instructions.includes([
        '"동생과 말다툼 후 서로 연락안함. 먼저 사과할지 고민중"',
        '→ primaryDomain = relationship_conflict_forgiveness',
      ].join('\n')),
      true,
    );
    assert.equal(
      instructions.includes([
        '"신뢰했던 사람이 뒤통수를 쳐서 배신감이 커요."',
        '→ primaryDomain = relationship_conflict_forgiveness',
        '금지: injustice_mistreatment',
      ].join('\n')),
      true,
    );
    assert.equal(
      instructions.includes([
        '"뒤에서 험담을 당한 것을 알고 마음이 아파요."',
        '→ primaryDomain = injustice_mistreatment',
        '금지: relationship_conflict_forgiveness',
      ].join('\n')),
      true,
    );
    assert.match(instructions, /메모체, 축약형, 구어체, 종결어미 생략, 띄어쓰기 차이는 정보 부족의 근거가 아닙니다/);
  });

  it('운영 정적 지시문·schema·manifest 지문 투영은 기존 값과 동일하다', () => {
    assert.equal(buildAnalyzerInstructions(STATIC_ANALYZER_DOMAIN_MANIFEST), INSTRUCTIONS);
    assert.deepEqual(buildSituationAnalysisSchema(STATIC_ANALYZER_DOMAIN_MANIFEST), SITUATION_ANALYSIS_SCHEMA);
    assert.deepEqual(projectAnalyzerDomainManifestForHash(STATIC_ANALYZER_DOMAIN_MANIFEST), {
      domains: analyzerDomainIds(STATIC_ANALYZER_DOMAIN_MANIFEST),
      fallbackDomain: 'other_uncovered',
    });
  });

  it('새 영역과 새 상황 태그는 prompt·schema·validator 한 manifest에 함께 결속된다', async () => {
    const { base, candidate } = await fixture();
    const manifest = await buildCandidateAnalyzerDomainManifest(candidate, base);
    assert.equal(analyzerDomainIds(manifest).includes(candidate.targetDomainId), true);
    assert.match(buildAnalyzerInstructions(manifest), /caregiving_strain: 시험용 새 영역 설명입니다\./);
    assert.equal(manifest.situationTags.includes('시험용 상황'), true);
    assert.match(buildAnalyzerInstructions(manifest), /situationTags: .*시험용 상황/);
    const schema = buildSituationAnalysisSchema(manifest);
    assert.equal(schema.properties.primaryDomain.enum.includes(candidate.targetDomainId), true);
    assert.equal(schema.properties.domainChoiceCandidates.items.enum.includes(candidate.targetDomainId), true);
    assert.equal(schema.properties.situationTags.items.enum.includes('시험용 상황'), true);
    assert.equal(validateSituationAnalysis(analysis(candidate.targetDomainId)).valid, false);
    assert.equal(
      validateSituationAnalysisForDomains(
        analysis(candidate.targetDomainId),
        analyzerDomainIds(manifest),
        manifest.fallbackDomain.id,
      ).valid,
      false,
    );
    assert.deepEqual(
      validateSituationAnalysisForDomains(
        analysis(candidate.targetDomainId),
        analyzerDomainIds(manifest),
        manifest.fallbackDomain.id,
        manifest.situationTags,
      ),
      { valid: true, errors: [] },
    );
  });

  it('활성 카탈로그만으로도 후보 경로와 같은 manifest를 결정적으로 만든다', async () => {
    const { base, candidate } = await fixture();
    const checked = await validateCatalogCandidate(candidate, base);
    assert.equal(checked.valid, true);
    if (!checked.proposedCatalog) throw new Error('proposed catalog expected');
    assert.deepEqual(
      buildCatalogAnalyzerDomainManifest(checked.proposedCatalog),
      await buildCandidateAnalyzerDomainManifest(candidate, base),
    );
  });

  it('새 영역 요청·환경 지문은 정적 값과 다르고 같은 후보에서는 결정적이다', async () => {
    const { base, candidate } = await fixture();
    const first = await buildCandidateAnalyzerDomainManifest(candidate, base);
    const second = await buildCandidateAnalyzerDomainManifest(candidate, base);
    assert.equal(canonicalJson(first), canonicalJson(second));
    assert.notEqual(
      await computeCandidateGenerationAnalysisRequestHash(first),
      await computeCandidateGenerationAnalysisRequestHash(),
    );
    assert.notDeepEqual(
      await buildCandidateGenerationAnalysisEnvironment(candidate, base),
      await buildCurrentAnalysisSnapshotEnvironment(candidate.baseVersionHash),
    );
  });

  it('동적 manifest로 봉인한 새 영역 증거는 통과하고 정적 지문으로 봉인하면 거절한다', async () => {
    const { base, candidate } = await fixture();
    const manifest = await buildCandidateAnalyzerDomainManifest(candidate, base);
    const cases = candidate.cards.flatMap((card, cardIndex) => TEXTS.map((text, textIndex) => ({
      caseId: `GEN-${card.id}-${String(textIndex + 1).padStart(2, '0')}`,
      cardId: card.id,
      text: `${text} ${cardIndex + 1}-${textIndex + 1}`,
      analysis: analysis(candidate.targetDomainId),
    })));
    const dynamic = await sealCandidateGenerationEvidence({
      candidate,
      environment: await buildCandidateGenerationAnalysisEnvironment(candidate, base),
      cases,
      analyzerDomainManifest: manifest,
    });
    assert.deepEqual(await validateCandidateGenerationEvidence(dynamic, candidate, base), { valid: true, errors: [] });

    const stale = await sealCandidateGenerationEvidence({
      candidate,
      environment: await buildCurrentAnalysisSnapshotEnvironment(candidate.baseVersionHash),
      cases,
    });
    const staleCheck = await validateCandidateGenerationEvidence(stale, candidate, base);
    assert.equal(staleCheck.valid, false);
    assert.equal(staleCheck.errors.some((error) => error.includes('analysisRequest.requestHash')), true);
    assert.equal(staleCheck.errors.some((error) => error.includes('현재 Analyzer 환경')), true);
  });

  it('실행기는 같은 manifest를 9개 분석에 전달하고 새 영역 증거를 완성한다', async () => {
    const { base, candidate } = await fixture();
    const seen: string[][] = [];
    const result = await runCandidateGenerationEvidence(candidate, base, {
      author: async () => response(scenarios(candidate.cards.map((card) => card.id))),
      analyze: async (_text, _deadline, manifest) => {
        seen.push(analyzerDomainIds(manifest));
        return analysis(candidate.targetDomainId);
      },
    });
    assert.equal(result.status, 'completed');
    assert.equal(seen.length, 9);
    assert.equal(seen.every((ids) => ids.includes(candidate.targetDomainId)), true);
    if (result.status !== 'completed') throw new Error('completed expected');
    assert.deepEqual(await validateCandidateGenerationEvidence(result.evidence, candidate, base), { valid: true, errors: [] });
  });

  it('실제 transport factory도 새 영역 prompt·schema를 보내고 1+9회 뒤 완성한다', async () => {
    const { base, candidate } = await fixture();
    const sent: Record<string, unknown>[] = [];
    const runner = createCandidateGenerationEvidenceRunner({
      apiKey: KEY,
      fetchImpl: (async (_url, init) => {
        const body = JSON.parse(init?.body as string) as Record<string, unknown>;
        sent.push(body);
        return new Response(JSON.stringify(
          body.model === 'gpt-6-astra'
            ? response(scenarios(candidate.cards.map((card) => card.id)))
            : response(analysis(candidate.targetDomainId), MODEL),
        ));
      }) as typeof fetch,
    });
    const result = await runner(candidate, base);
    assert.equal(result.status, 'completed');
    assert.equal(sent.length, 10);
    const manifest = await buildCandidateAnalyzerDomainManifest(candidate, base);
    for (const body of sent.slice(1)) {
      assert.deepEqual(body, buildCandidateGenerationAnalysisRequest(body.input as string, manifest));
      assert.match(body.instructions as string, /caregiving_strain: 시험용 새 영역 설명입니다\./);
      assert.match(body.instructions as string, /situationTags: .*시험용 상황/);
    }
  });

  it('잘못된 후보로 manifest를 만들지 않고 모듈은 외부 상태를 읽지 않는다', async () => {
    const { base, candidate } = await fixture();
    candidate.proposedVersionHash = 'invalid';
    await assert.rejects(buildCandidateAnalyzerDomainManifest(candidate, base), /invalid catalog candidate/);
    const source = readFileSync(
      new URL('../../supabase/functions/_shared/automatic-scripture-catalog-analyzer-domain-manifest.ts', import.meta.url),
      'utf8',
    );
    assert.doesNotMatch(source, /\bfetch\s*\(|Deno\.env|process\.env|Date\.now|performance\.now|node:fs/);
  });
});
