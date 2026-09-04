/**
 * Situation Analyzer + Scripture Matcher 스트레스 테스트 (로컬 전용)
 *
 * 실행 (터미널에서 직접):
 *   OPENAI_API_KEY=... npm run test:openai:stress
 *
 * 28개 사례를 각각 따로 OpenAI에 보내고, 분석 결과를 기존 매칭 엔진에 넣어
 * 점수 분포를 관찰한다. 지시문과 응답 구조는 scripts/analyzer-prompt.ts를 그대로 쓴다.
 *
 * 이 프로그램은 threshold(몇 점 이하면 추천하지 않는다)를 만들지 않는다.
 * GROUP A와 GROUP C의 1위 점수 분포를 사람이 보고 나중에 정하기 위한 자료를 모은다.
 */

import {
  MODEL,
  addUsage,
  analyzeSituation,
  createClient,
  emptyUsage,
  line,
} from './analyzer-prompt.ts';
import { matchScriptureCards, type CardScore } from '../src/lib/scripture-matcher.ts';
import type { SituationAnalysis } from '../src/lib/situation-analysis.ts';
import { STRESS_CASES, type StressCase } from './stress-cases.ts';

type CaseOutcome = {
  stressCase: StressCase;
  analysis: SituationAnalysis | null;
  top3: CardScore[];
  topScore: number;
  gap: number;
  /** 판정이 있는 그룹에서만 사용한다. GROUP C는 항상 null. */
  passed: boolean | null;
  errors: string[];
};

const formatTags = (label: string, tags: string[]) =>
  `    ${label}: ${tags.length > 0 ? tags.join(', ') : '(없음)'}`;

const formatScore = (score: CardScore | undefined) =>
  score ? `${score.cardId} ${score.totalScore}점` : '(없음)';

const round1 = (value: number) => Math.round(value * 10) / 10;

function printAnalysis(analysis: SituationAnalysis) {
  console.log('  Situation Analysis');
  console.log(formatTags('situationTags', analysis.situationTags));
  console.log(formatTags('emotionTags', analysis.emotionTags));
  console.log(formatTags('spiritualQuestionTags', analysis.spiritualQuestionTags));
  console.log(formatTags('prayerModes', analysis.prayerModes));
  console.log(formatTags('pastoralFunctions', analysis.pastoralFunctions));
  console.log(
    `    safety: ${analysis.safety.level}${
      analysis.safety.categories.length > 0 ? ` (${analysis.safety.categories.join(', ')})` : ''
    }`,
  );
  console.log(`    confidence: ${analysis.confidence}`);
}

function checkSafety(stressCase: StressCase, analysis: SituationAnalysis): string[] {
  const expected = stressCase.expectedSafety;
  if (!expected) return [];

  const problems: string[] = [];
  const { level, categories } = analysis.safety;

  if (!expected.allowedLevels.includes(level)) {
    problems.push(`level이 ${expected.allowedLevels.join(' 또는 ')}이 아닙니다 (실제: ${level}).`);
  }
  for (const group of expected.requiredCategoryGroups) {
    if (!group.some((category) => categories.includes(category))) {
      problems.push(`category에 ${group.join(' 또는 ')} 중 하나가 없습니다.`);
    }
  }
  for (const category of expected.forbiddenCategories ?? []) {
    if (categories.includes(category)) {
      problems.push(`${category}는 이 상황에서 사용하면 안 됩니다.`);
    }
  }
  return problems;
}

async function runCase(
  client: Parameters<typeof analyzeSituation>[0],
  stressCase: StressCase,
  totalUsage: ReturnType<typeof emptyUsage>,
): Promise<CaseOutcome> {
  console.log(`[${stressCase.id}] ${stressCase.group}그룹 · ${stressCase.expectationType}`);
  console.log(`  원문: ${stressCase.text}`);
  if (stressCase.note) console.log(`  메모: ${stressCase.note}`);

  const empty: CaseOutcome = {
    stressCase,
    analysis: null,
    top3: [],
    topScore: 0,
    gap: 0,
    passed: stressCase.expectationType === 'no_clear_match' ? null : false,
    errors: [],
  };

  let result: Awaited<ReturnType<typeof analyzeSituation>>;
  try {
    result = await analyzeSituation(client, stressCase.text);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.log(`  요청 실패: ${message}`);
    return { ...empty, errors: [message] };
  }

  addUsage(totalUsage, result.usage);

  if (!result.analysis) {
    console.log('  검증 실패 (결과를 임의로 고치지 않습니다)');
    for (const error of result.errors) console.log(`    - ${error}`);
    return { ...empty, errors: result.errors };
  }

  const analysis = result.analysis;
  printAnalysis(analysis);

  const match = matchScriptureCards(analysis);
  const top3 = match.scores.slice(0, 3);
  const topScore = top3[0]?.totalScore ?? 0;
  const secondScore = top3[1]?.totalScore ?? 0;
  const gap = round1(topScore - secondScore);

  console.log('  Matcher top 3');
  top3.forEach((score, index) => {
    console.log(
      `    ${index + 1}위 ${formatScore(score)}` +
        ` (상황 ${score.situationScore} / 감정 ${score.emotionScore} / 신앙질문 ${score.spiritualQuestionScore}` +
        ` / 기도유형 ${score.prayerModeScore} / 목회기능 ${score.pastoralFunctionScore})`,
    );
  });
  console.log(`  1위-2위 점수 차이: ${gap}점`);
  if (match.isTie) {
    console.log(`  동점: ${match.topCards.map((card) => card.cardId).join(', ')}`);
  }

  let passed: boolean | null = null;

  switch (stressCase.expectationType) {
    case 'exact_card': {
      const expected = stressCase.expectedCards?.[0];
      passed = top3[0]?.cardId === expected;
      console.log(`  기대 카드: ${expected}`);
      console.log(`  판정: ${passed ? '일치' : '불일치'}`);
      break;
    }
    case 'candidate_set': {
      const expected = stressCase.expectedCards ?? [];
      const top3Ids = top3.map((score) => score.cardId);
      const found = expected.filter((cardId) => top3Ids.includes(cardId));
      passed = found.length > 0;
      console.log(`  후보 카드: ${expected.join(', ')}`);
      console.log(
        `  top 3 안에 들어온 후보: ${found.length > 0 ? found.join(', ') : '없음'}` +
          ` (${found.length} / ${expected.length})`,
      );
      console.log('  참고: 1위 하나만이 정답이라고 보지 않습니다.');
      break;
    }
    case 'no_clear_match': {
      passed = null;
      console.log('  판정: REVIEW REQUIRED (정답을 정하지 않고 점수 분포만 관찰합니다)');
      console.log('  사람이 확인할 것: 사용자가 말하지 않은 상황·감정을 모델이 만들어냈는지');
      break;
    }
    case 'safety_route': {
      const problems = checkSafety(stressCase, analysis);
      passed = problems.length === 0;
      console.log('  *** SAFETY ROUTE 우선 ***');
      console.log('  위 Matcher 점수는 일반 말씀 추천 결과로 해석하지 않습니다.');
      console.log(`  안전 판정: ${passed ? '일치' : '불일치'}`);
      for (const problem of problems) console.log(`    - ${problem}`);
      break;
    }
  }

  return { stressCase, analysis, top3, topScore, gap, passed, errors: [] };
}

function summarizeScores(label: string, outcomes: CaseOutcome[]) {
  const scores = outcomes.filter((item) => item.analysis).map((item) => item.topScore);
  if (scores.length === 0) {
    console.log(`${label}: 계산할 결과가 없습니다.`);
    return;
  }
  const average = round1(scores.reduce((sum, value) => sum + value, 0) / scores.length);
  console.log(
    `${label}: 평균 1위 점수 ${average}점 / 최저 ${Math.min(...scores)}점 / 최고 ${Math.max(...scores)}점` +
      ` (사례 ${scores.length}개)`,
  );
}

async function main() {
  const client = createClient();
  const totalUsage = emptyUsage();
  const outcomes: CaseOutcome[] = [];

  console.log(`모델: ${MODEL} / store: false / 사례 ${STRESS_CASES.length}개`);
  console.log('threshold는 정하지 않습니다. 점수 분포를 관찰하기 위한 실행입니다.');

  for (const stressCase of STRESS_CASES) {
    line();
    outcomes.push(await runCase(client, stressCase, totalUsage));
  }

  const inGroup = (group: string) => outcomes.filter((item) => item.stressCase.group === group);

  line('=');
  console.log('요약');
  line();

  const groupA = inGroup('A');
  const matchedA = groupA.filter((item) => item.passed === true).length;
  console.log(`GROUP A · exact card 일치: ${matchedA} / ${groupA.length}`);
  for (const item of groupA) {
    console.log(
      `  ${item.stressCase.id}: ${formatScore(item.top3[0])}` +
        ` / 기대 ${item.stressCase.expectedCards?.[0]} / ${item.passed ? '일치' : '불일치'}`,
    );
  }

  line();
  const groupB = inGroup('B');
  console.log('GROUP B · top 3 결과');
  for (const item of groupB) {
    const expected = item.stressCase.expectedCards ?? [];
    const top3Ids = item.top3.map((score) => score.cardId);
    const found = expected.filter((cardId) => top3Ids.includes(cardId));
    console.log(
      `  ${item.stressCase.id}: top3 [${top3Ids.join(', ')}]` +
        ` / 후보 [${expected.join(', ')}]` +
        ` / 포함 ${found.length}개`,
    );
  }

  line();
  const groupC = inGroup('C');
  console.log('GROUP C · 관찰용 (판정 없음)');
  for (const item of groupC) {
    const second = item.top3[1];
    console.log(
      `  ${item.stressCase.id}: 1위 ${formatScore(item.top3[0])}` +
        ` / 2위 ${formatScore(second)}` +
        ` / 차이 ${item.gap}점` +
        ` / confidence ${item.analysis ? item.analysis.confidence : '-'}`,
    );
  }

  line();
  const groupD = inGroup('D');
  const matchedD = groupD.filter((item) => item.passed === true).length;
  console.log(`GROUP D · 안전 기준 일치: ${matchedD} / ${groupD.length}`);
  for (const item of groupD) {
    const safety = item.analysis?.safety;
    console.log(
      `  ${item.stressCase.id}: ${safety ? safety.level : '-'}` +
        `${safety && safety.categories.length > 0 ? ` (${safety.categories.join(', ')})` : ''}` +
        ` / ${item.passed ? '일치' : '불일치'}`,
    );
  }

  line();
  console.log('1위 점수 분포 (threshold를 정하기 위한 참고자료)');
  summarizeScores('  GROUP A', groupA);
  summarizeScores('  GROUP C', groupC);

  line();
  console.log('OpenAI 사용량:');
  console.log(`  - input tokens: ${totalUsage.input}`);
  console.log(`  - output tokens: ${totalUsage.output}`);
  console.log(`  - total tokens: ${totalUsage.total}`);

  const failedRequests = outcomes.filter((item) => item.errors.length > 0).length;
  if (failedRequests > 0) {
    console.log(`요청 오류 또는 규격 검증 실패: ${failedRequests}건`);
  }
}

main().catch((error) => {
  console.error(`실행 중 오류: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
