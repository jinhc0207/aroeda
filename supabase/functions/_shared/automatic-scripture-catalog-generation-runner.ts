/**
 * 한 후보의 사례 저작 → 순차 분석 → 증거 봉인.
 *
 * 하나의 시간 예산
 *   저작 1회와 분석 최대 15회(후보당 카드 5장 × 카드당 3사례)가 **같은 마감 시각 하나**를
 *   나눠 쓴다. 단계가 바뀐다고 예산이 초기화되지 않는다. 기본·최대 120초이며 호출자와
 *   테스트는 더 짧게만 정할 수 있다.
 *
 * 취소와 늦은 완료
 *   마감이나 호출자 취소가 나면 진행 중인 요청에 취소 신호를 보내고 다음 호출을 시작하지
 *   않는다. 의존 함수가 취소를 무시하고 영원히 붙잡고 있어도 실행기 자체는 정해진 시간에
 *   실패를 반환한다. 경주에서 진 작업이 뒤늦게 끝나더라도 그 결과로 분석을 더 부르거나
 *   증거를 성공으로 반환하지 않는다(deadline 모듈의 빗장 참고).
 *
 *   취소는 이미 제공자에 도달한 작업과 그 과금을 되돌리지 않는다. 우리가 그 결과를 쓰지
 *   않는다는 것만 보장한다.
 *
 * 실패 처리
 *   고정된 reason과, 분석 단계라면 코드가 부여한 caseId만 돌려준다. 원본 오류·제공자 응답·
 *   API 키·사례 문장·부분 증거는 어느 경로로도 나가지 않는다. 자동 재시도와 부분 결과
 *   재개는 없다 — 다시 실행하면 후보 전체를 새로 처리한다.
 */
import { type ScriptureCatalogCandidate, type ScriptureCatalogSnapshot } from './automatic-scripture-catalog-contract.ts';
import {
  buildCaseAuthorRequest, interpretCaseAuthorResponse, type CaseAuthorSpec,
} from './automatic-scripture-catalog-case-author.ts';
import {
  type RunDeadline, type RunDeadlineOptions, createCandidateGenerationRunDeadline,
} from './automatic-scripture-catalog-generation-deadline.ts';
import {
  type CandidateGenerationEvidence, type CandidateGenerationEvidenceCase,
  sealCandidateGenerationEvidence, validateCandidateGenerationEvidence,
} from './automatic-scripture-catalog-candidate-generation-evidence.ts';
import { buildCandidateGenerationAnalysisEnvironment } from './automatic-scripture-catalog-analysis-environment.ts';
import {
  analyzerDomainIds,
  buildCandidateAnalyzerDomainManifest,
  type AnalyzerDomainManifest,
} from './automatic-scripture-catalog-analyzer-domain-manifest.ts';
import { validateFrozenSituationAnalysisShape } from './automatic-scripture-catalog-analysis-snapshot-contract.ts';
import { validateSituationAnalysisForDomains, type SituationAnalysis } from './situation-analysis.ts';
import { createCandidateGenerationTransport, type GenerationTransportConfig } from './automatic-scripture-catalog-generation-transport.ts';

export type CandidateGenerationRunFailure =
  | 'input_invalid' | 'configuration_error'
  | 'author_failed' | 'author_response_invalid' | 'analyze_failed' | 'analysis_invalid' | 'evidence_invalid'
  | 'run_deadline_exceeded' | 'run_cancelled';

export type CandidateGenerationRunResult =
  | { status: 'completed'; evidence: CandidateGenerationEvidence }
  | { status: 'failed'; reason: CandidateGenerationRunFailure; caseId?: string };

export type CandidateGenerationDependencies = {
  author: (spec: CaseAuthorSpec, deadline: RunDeadline) => Promise<unknown>;
  analyze: (text: string, deadline: RunDeadline, manifest: AnalyzerDomainManifest) => Promise<unknown>;
};

/** budgetMs 기본·최대 120초, signal은 호출자 취소, now는 테스트용 단조 시계. */
export type CandidateGenerationRunOptions = RunDeadlineOptions;

export async function runCandidateGenerationEvidence(
  candidate: ScriptureCatalogCandidate,
  baseCatalog: ScriptureCatalogSnapshot,
  deps: CandidateGenerationDependencies,
  options: CandidateGenerationRunOptions = {},
): Promise<CandidateGenerationRunResult> {
  let deadline: RunDeadline;
  try {
    deadline = createCandidateGenerationRunDeadline(options);
  } catch {
    return { status: 'failed', reason: 'configuration_error' };
  }

  /**
   * 마감·취소로 끝났으면 그 이유를, 아니면 주어진 기본 이유를 쓴다.
   *
   * 먼저 `done()`으로 단조 시계를 다시 본다. 요청 타이머가 전체 마감 타이머보다 먼저
   * 울렸더라도, 시계상 예산이 끝났다면 원인은 author_failed/analyze_failed가 아니라
   * 전체 마감이다. 타이머 실행 순서나 소수점 절삭이 원인을 바꾸지 못하게 한다.
   */
  const fail = (
    reason: CandidateGenerationRunFailure,
    caseId?: string,
  ): CandidateGenerationRunResult => {
    deadline.done();
    const stopped = deadline.failureReason();
    const finalReason = stopped ?? reason;
    return caseId === undefined
      ? { status: 'failed', reason: finalReason }
      : { status: 'failed', reason: finalReason, caseId };
  };

  try {
    let spec: CaseAuthorSpec;
    let manifest: AnalyzerDomainManifest;
    let isolated: ScriptureCatalogCandidate;
    let base: ScriptureCatalogSnapshot;
    try {
      isolated = structuredClone(candidate);
      base = structuredClone(baseCatalog);
      spec = await buildCaseAuthorRequest(isolated, base);
      manifest = await buildCandidateAnalyzerDomainManifest(isolated, base);
    } catch {
      return { status: 'failed', reason: 'input_invalid' };
    }

    // 이미 마감·취소되었으면 의존 함수를 한 번도 부르지 않는다.
    if (deadline.done()) return fail('run_deadline_exceeded');
    let raw: unknown;
    try { raw = await deadline.race(deps.author(structuredClone(spec), deadline)); }
    catch { return fail('author_failed'); }
    if (deadline.done()) return fail('run_deadline_exceeded');

    let plan;
    try { plan = interpretCaseAuthorResponse(raw, isolated, base); }
    catch { return fail('author_response_invalid'); }

    const cases: CandidateGenerationEvidenceCase[] = [];
    for (const item of plan) {
      // 예산이 남아 있을 때만 다음 분석을 시작한다.
      if (deadline.done()) return fail('run_deadline_exceeded', item.caseId);
      let analysis: unknown;
      try { analysis = structuredClone(await deadline.race(deps.analyze(item.text, deadline, manifest))); }
      catch { return fail('analyze_failed', item.caseId); }
      try {
        const checked = validateSituationAnalysisForDomains(
          analysis,
          analyzerDomainIds(manifest),
          manifest.fallbackDomain.id,
          manifest.situationTags,
        );
        if (validateFrozenSituationAnalysisShape(analysis, 'analysis').length > 0 || !checked.valid) {
          return fail('analysis_invalid', item.caseId);
        }
        const valid = analysis as SituationAnalysis<string>;
        const card = isolated.cards.find(card => card.id === item.cardId)!;
        if (valid.safety.level !== 'normal' || valid.domainPriority !== 'resolved' || valid.primaryDomain !== card.domainId) {
          return fail('analysis_invalid', item.caseId);
        }
        cases.push({ ...item, analysis: valid });
      } catch { return fail('analysis_invalid', item.caseId); }
    }

    // 늦게 끝난 작업이 성공을 되살리지 못하도록 봉인 전에 한 번 더 본다.
    if (deadline.done()) return fail('run_deadline_exceeded');
    try {
      const evidence = await sealCandidateGenerationEvidence({
        candidate: isolated,
        environment: await buildCandidateGenerationAnalysisEnvironment(isolated, base),
        cases,
        analyzerDomainManifest: manifest,
      });
      if (!(await validateCandidateGenerationEvidence(evidence, isolated, base)).valid) {
        return fail('evidence_invalid');
      }
      if (deadline.done()) return fail('run_deadline_exceeded');
      return { status: 'completed', evidence };
    } catch { return fail('evidence_invalid'); }
  } finally {
    deadline.dispose();
  }
}

/** 호출해야만 통신한다. import/생성만으로는 API·DB 호출이 없고 저장도 이 실행기의 책임이 아니다. */
export function createCandidateGenerationEvidenceRunner(config: GenerationTransportConfig) {
  const deps = createCandidateGenerationTransport(config);
  return (
    candidate: ScriptureCatalogCandidate,
    base: ScriptureCatalogSnapshot,
    options?: CandidateGenerationRunOptions,
  ) => runCandidateGenerationEvidence(candidate, base, deps, options);
}
