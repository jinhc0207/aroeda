/**
 * End-to-End 테스트 (로컬 전용) — Scripture Card 51장 균형 평가 코퍼스 기반
 *
 * 실행:
 *   node scripts/test-openai-recommendation-e2e.ts
 *     → 모드를 지정하지 않으면 사용법만 출력한다. OpenAI를 호출하지 않는다.
 *
 *   node scripts/test-openai-recommendation-e2e.ts --mode=smoke
 *     → SMOKE_CASES(17개, 17개 영역 각 1개)를 실제로 호출한다.
 *   node scripts/test-openai-recommendation-e2e.ts --mode=new-cards
 *     → NEW_CARD_SMOKE_CASES(20개, SC-032~SC-051 각 1개)를 실제로 호출한다.
 *   node scripts/test-openai-recommendation-e2e.ts --mode=full
 *     → EVALUATION_CASES(153개) 전부를 실제로 호출한다.
 *
 *   아무 모드에나 --dry-run을 더하면 선택된 사례의 id·문장·기대값만 출력하고
 *   OpenAI를 0회 호출한다 (예: --mode=full --dry-run).
 *
 *   OPENAI_API_KEY=... node scripts/test-openai-recommendation-e2e.ts --mode=smoke
 *
 * 이 프로그램은 API Key, 사용자 문장, 모델 원본 응답을 파일에 저장하지 않는다.
 * 모든 출력은 콘솔(stdout)뿐이다. 결과를 파일로 남기고 싶으면 사용자가 직접 tee를 붙인다.
 *
 * 흐름:
 *   scripts/scripture-recommendation-evaluation-cases.ts의 사례
 *   → OpenAI Situation Analyzer (scripts/analyzer-prompt.ts)
 *   → validateSituationAnalysis (src/lib/situation-analysis.ts, analyzer-prompt.ts 내부에서 이미 실행)
 *   → Recommendation Gate (src/lib/recommendation-gate.ts)
 *   → 아래 7개 항목을 각각 나눠 집계하고, 실패한 사례는 항목별로 ID를 따로 출력한다.
 *     1. 응답 구조 검증 성공률  2. 안전 오탐 수  3. primary domain 일치율
 *     4. preferred 카드 1위 일치율  5. acceptable 카드 일치율
 *     6. 예상하지 않은 domain_choice·ambiguous·no_coverage 수  7. 토큰 사용량(input/output/total)
 *
 * 분석 규칙, Matcher 배점, Gate 판단은 여기서 다시 구현하지 않는다. 그대로 가져다 쓴다.
 */

import {
  MODEL,
  addUsage,
  analyzeSituation,
  createClient,
  emptyUsage,
  line,
} from './analyzer-prompt.ts';
import {
  EVALUATION_CASES,
  NEW_CARD_SMOKE_CASES,
  SMOKE_CASES,
  type EvaluationCase,
} from './scripture-recommendation-evaluation-cases.ts';
import { runRecommendationGate, type GateResult } from '../src/lib/recommendation-gate.ts';
import type { SituationAnalysis } from '../src/lib/situation-analysis.ts';

type Mode = 'smoke' | 'new-cards' | 'full';

const MODE_CASES: Record<Mode, readonly EvaluationCase[]> = {
  smoke: SMOKE_CASES,
  'new-cards': NEW_CARD_SMOKE_CASES,
  full: EVALUATION_CASES,
};

const MODE_COUNTS: Record<Mode, number> = { smoke: 17, 'new-cards': 20, full: 153 };

function parseArgs(argv: string[]): { mode: Mode | null; dryRun: boolean } {
  let mode: Mode | null = null;
  let dryRun = false;
  for (const arg of argv) {
    if (arg === '--dry-run') {
      dryRun = true;
      continue;
    }
    const match = arg.match(/^--mode=(smoke|new-cards|full)$/);
    if (match) {
      mode = match[1] as Mode;
    }
  }
  return { mode, dryRun };
}

function printUsage() {
  console.log('사용법: node scripts/test-openai-recommendation-e2e.ts --mode=<smoke|new-cards|full> [--dry-run]');
  console.log('');
  console.log('  --mode=smoke      SMOKE_CASES 17건 (17개 영역 각 1건)');
  console.log('  --mode=new-cards  NEW_CARD_SMOKE_CASES 20건 (SC-032~SC-051 각 1건)');
  console.log('  --mode=full       EVALUATION_CASES 153건 전체');
  console.log('  --dry-run         선택된 사례의 id·문장·기대값만 출력한다. OpenAI를 호출하지 않는다.');
  console.log('');
  console.log('모드를 지정하지 않으면 이 사용법만 출력하고 종료한다. OpenAI를 호출하지 않는다.');
  console.log('실제 호출에는 OPENAI_API_KEY 환경변수가 필요하다.');
}

function printDryRun(mode: Mode, cases: readonly EvaluationCase[]) {
  console.log(`[dry-run] --mode=${mode} · 사례 ${cases.length}개 (OpenAI 호출 0회)`);
  line();
  for (const item of cases) {
    console.log(`[${item.id}] domain=${item.domain} rank=${item.rank} cluster=${item.cluster}`);
    console.log(`  원문: ${item.text}`);
    console.log(`  expectedPrimaryDomain: ${item.expectedPrimaryDomain}`);
    console.log(`  expectedRoute: ${item.expectedRoute}`);
    console.log(`  preferredCardId: ${item.preferredCardId}`);
    console.log(`  acceptableCardIds: ${item.acceptableCardIds.join(', ')}`);
    console.log(`  smoke=${item.smoke} isNewCardSmoke=${item.isNewCardSmoke}`);
  }
  line('=');
  console.log(`[dry-run] 총 ${cases.length}건 출력, OpenAI 호출 0회.`);
}

type CaseOutcome = {
  evalCase: EvaluationCase;
  analysis: SituationAnalysis | null;
  gate: GateResult | null;
  structureValid: boolean;
  domainMatch: boolean | null;
  preferredMatch: boolean | null;
  acceptableMatch: boolean | null;
  safetyFalsePositive: boolean;
  unexpectedRoute: boolean;
};

function printAnalysis(analysis: SituationAnalysis) {
  console.log(`    primaryDomain: ${analysis.primaryDomain}`);
  console.log(`    situationTags: ${analysis.situationTags.join(', ') || '(없음)'}`);
  console.log(`    emotionTags: ${analysis.emotionTags.join(', ') || '(없음)'}`);
  console.log(`    spiritualQuestionTags: ${analysis.spiritualQuestionTags.join(', ') || '(없음)'}`);
  console.log(`    prayerModes: ${analysis.prayerModes.join(', ') || '(없음)'}`);
  console.log(`    pastoralFunctions: ${analysis.pastoralFunctions.join(', ') || '(없음)'}`);
  console.log(
    `    safety: ${analysis.safety.level}${
      analysis.safety.categories.length > 0 ? ` (${analysis.safety.categories.join(', ')})` : ''
    }`,
  );
}

async function runCase(
  client: Parameters<typeof analyzeSituation>[0],
  evalCase: EvaluationCase,
  totalUsage: ReturnType<typeof emptyUsage>,
): Promise<CaseOutcome> {
  console.log(`[${evalCase.id}] domain=${evalCase.domain} preferred=${evalCase.preferredCardId}`);
  console.log(`  원문: ${evalCase.text}`);

  const empty: CaseOutcome = {
    evalCase,
    analysis: null,
    gate: null,
    structureValid: false,
    domainMatch: null,
    preferredMatch: null,
    acceptableMatch: null,
    safetyFalsePositive: false,
    unexpectedRoute: false,
  };

  let result: Awaited<ReturnType<typeof analyzeSituation>>;
  try {
    result = await analyzeSituation(client, evalCase.text);
  } catch (error) {
    console.log(`  요청 실패: ${error instanceof Error ? error.message : String(error)}`);
    return empty;
  }

  addUsage(totalUsage, result.usage);

  if (!result.analysis) {
    console.log('  검증 실패 (결과를 임의로 고치지 않습니다)');
    for (const error of result.errors) console.log(`    - ${error}`);
    return empty;
  }

  const analysis = result.analysis;
  printAnalysis(analysis);

  const gate = runRecommendationGate(analysis);
  console.log(`  [Gate] route: ${gate.route} / selectedCardId: ${gate.selectedCardId ?? '(없음)'}`);

  const domainMatch = analysis.primaryDomain === evalCase.expectedPrimaryDomain;
  const safetyFalsePositive = gate.route === 'safety';
  const unexpectedRoute = !safetyFalsePositive && gate.route !== 'recommend';
  const preferredMatch = gate.route === 'recommend' && gate.selectedCardId === evalCase.preferredCardId;
  const acceptableMatch =
    gate.route === 'recommend' &&
    gate.selectedCardId !== null &&
    evalCase.acceptableCardIds.includes(gate.selectedCardId);

  console.log(`  domain 일치: ${domainMatch ? '일치' : '불일치'} (기대 ${evalCase.expectedPrimaryDomain})`);
  console.log(`  preferred 일치: ${preferredMatch ? '일치' : '불일치'} (기대 ${evalCase.preferredCardId})`);
  console.log(
    `  acceptable 일치: ${acceptableMatch ? '일치' : '불일치'} (허용 ${evalCase.acceptableCardIds.join(', ')})`,
  );
  if (safetyFalsePositive) console.log('  *** 안전 오탐: 이 사례는 안전 경계 문장이 아닙니다 ***');
  if (unexpectedRoute) console.log(`  *** 예상하지 않은 route: ${gate.route} ***`);

  return {
    evalCase,
    analysis,
    gate,
    structureValid: true,
    domainMatch,
    preferredMatch,
    acceptableMatch,
    safetyFalsePositive,
    unexpectedRoute,
  };
}

function printReport(mode: Mode, outcomes: CaseOutcome[], totalUsage: ReturnType<typeof emptyUsage>) {
  const total = outcomes.length;
  const structureFailed = outcomes.filter((item) => !item.structureValid);
  const safetyFalsePositives = outcomes.filter((item) => item.safetyFalsePositive);
  const unexpectedRoutes = outcomes.filter((item) => item.unexpectedRoute);

  const validOutcomes = outcomes.filter((item) => item.structureValid);
  const domainMismatches = validOutcomes.filter((item) => item.domainMatch === false);
  const preferredMismatches = validOutcomes.filter((item) => item.preferredMatch === false);
  const acceptableMismatches = validOutcomes.filter((item) => item.acceptableMatch === false);

  const structureValidCount = total - structureFailed.length;
  const domainMatchCount = validOutcomes.length - domainMismatches.length;
  const preferredMatchCount = validOutcomes.length - preferredMismatches.length;
  const acceptableMatchCount = validOutcomes.length - acceptableMismatches.length;

  const pct = (count: number, denom: number) => (denom > 0 ? `${((count / denom) * 100).toFixed(1)}%` : '(대상 없음)');
  const idsOf = (items: CaseOutcome[]) => (items.length > 0 ? items.map((item) => item.evalCase.id).join(', ') : '(없음)');

  line('=');
  console.log(`--mode=${mode} 결과 요약 (사례 ${total}개) — 아래 7개 항목을 나눠 집계한다`);
  line();
  console.log(`1. 응답 구조 검증 성공률: ${structureValidCount} / ${total} (${pct(structureValidCount, total)})`);
  console.log(`2. 안전 오탐 수: ${safetyFalsePositives.length} / ${total}`);
  console.log(
    `3. primary domain 일치율: ${domainMatchCount} / ${validOutcomes.length} (${pct(domainMatchCount, validOutcomes.length)})`,
  );
  console.log(
    `4. preferred 카드 1위 일치율: ${preferredMatchCount} / ${validOutcomes.length} (${pct(preferredMatchCount, validOutcomes.length)})`,
  );
  console.log(
    `5. acceptable 카드 일치율: ${acceptableMatchCount} / ${validOutcomes.length} (${pct(acceptableMatchCount, validOutcomes.length)})`,
  );
  console.log(`6. 예상하지 않은 domain_choice·ambiguous·no_coverage 수: ${unexpectedRoutes.length} / ${total}`);
  console.log('7. OpenAI 토큰 사용량:');
  console.log(`   - input tokens: ${totalUsage.input}`);
  console.log(`   - output tokens: ${totalUsage.output}`);
  console.log(`   - total tokens: ${totalUsage.total}`);

  line();
  console.log('실패 ID 분류 (총계만이 아니라 어떤 사례인지 각각 밝힌다)');
  console.log(`  구조 검증 실패: ${idsOf(structureFailed)}`);
  console.log(`  안전 오탐: ${idsOf(safetyFalsePositives)}`);
  console.log(`  primary domain 불일치: ${idsOf(domainMismatches)}`);
  console.log(`  preferred 불일치: ${idsOf(preferredMismatches)}`);
  console.log(`  acceptable 불일치: ${idsOf(acceptableMismatches)}`);

  const routeGroups: Record<'domain_choice' | 'ambiguous' | 'no_coverage', CaseOutcome[]> = {
    domain_choice: [],
    ambiguous: [],
    no_coverage: [],
  };
  for (const item of unexpectedRoutes) {
    const route = item.gate?.route;
    if (route === 'domain_choice' || route === 'ambiguous' || route === 'no_coverage') {
      routeGroups[route].push(item);
    }
  }
  console.log(`  예상 밖 route — domain_choice: ${idsOf(routeGroups.domain_choice)}`);
  console.log(`  예상 밖 route — ambiguous: ${idsOf(routeGroups.ambiguous)}`);
  console.log(`  예상 밖 route — no_coverage: ${idsOf(routeGroups.no_coverage)}`);
}

async function main() {
  const { mode, dryRun } = parseArgs(process.argv.slice(2));

  if (!mode) {
    printUsage();
    return;
  }

  const cases = MODE_CASES[mode];
  if (cases.length !== MODE_COUNTS[mode]) {
    throw new Error(`--mode=${mode}는 ${MODE_COUNTS[mode]}건이어야 하는데 실제로 ${cases.length}건입니다.`);
  }

  if (dryRun) {
    printDryRun(mode, cases);
    return;
  }

  const client = createClient();
  const totalUsage = emptyUsage();
  const outcomes: CaseOutcome[] = [];

  console.log(`모델: ${MODEL} / store: false / --mode=${mode} / 사례 ${cases.length}개`);

  for (const evalCase of cases) {
    line();
    outcomes.push(await runCase(client, evalCase, totalUsage));
  }

  printReport(mode, outcomes, totalUsage);
}

main().catch((error) => {
  console.error(`실행 중 오류: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
