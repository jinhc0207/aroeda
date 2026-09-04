/**
 * Situation Domain + Coverage 테스트 (로컬 전용)
 *
 * 실행 (터미널에서 직접):
 *   OPENAI_API_KEY=... npm run test:openai:domains
 *
 * A1 + C1~C7 총 8개만 보낸다.
 * 확인하는 것은 두 가지뿐이다.
 *   1. 모델이 사용자의 핵심 상황을 primaryDomain으로 잘 고르는가
 *   2. 지금 카드 DB가 그 상황을 다룰 수 있는가 (coverage)
 *
 * Matcher 점수가 높아도 coverage가 false면 "추천 가능"으로 해석하지 않는다.
 * threshold와 Recommendation Gate는 아직 만들지 않는다.
 */

import {
  MODEL,
  addUsage,
  analyzeSituation,
  createClient,
  emptyUsage,
  line,
} from './analyzer-prompt.ts';
import type { SituationDomain } from '../src/data/situation-domains.ts';
import { getCoverage } from '../src/lib/scripture-coverage.ts';
import { matchScriptureCards, type CardScore } from '../src/lib/scripture-matcher.ts';

type DomainCase = {
  id: string;
  text: string;
  /** 이 중 하나면 통과 */
  allowedPrimaryDomains: SituationDomain[];
  expectedCovered: boolean;
  note?: string;
};

const DOMAIN_CASES: DomainCase[] = [
  {
    id: 'A1',
    text: '다음 달에 두 회사 중 어디로 옮길지 결정해야 하는데 어떤 선택을 해야 할지 모르겠어요.',
    allowedPrimaryDomains: ['decision_guidance', 'wisdom_discernment'],
    expectedCovered: true,
    note: '두 domain 모두 합리적인 해석이다. 하나의 정답을 강제하지 않는다. 다른 하나가 secondaryDomains에 들어가도 된다.',
  },
  {
    id: 'C1',
    text: '요즘 사람들을 만나도 외롭고 제 이야기를 할 사람이 없는 것 같아요.',
    allowedPrimaryDomains: ['loneliness_isolation'],
    expectedCovered: false,
  },
  {
    id: 'C2',
    text: '아이와 계속 부딪히는데 어떻게 대화해야 할지 모르겠어요.',
    allowedPrimaryDomains: ['family_parenting_conflict'],
    expectedCovered: false,
  },
  {
    id: 'C3',
    text: '회사 일을 할 의욕이 완전히 사라졌어요. 그냥 모든 게 지칩니다.',
    allowedPrimaryDomains: ['burnout_exhaustion'],
    expectedCovered: false,
  },
  {
    id: 'C4',
    text: '하나님이 멀게 느껴지고 기도를 해도 아무 느낌이 없습니다.',
    allowedPrimaryDomains: ['spiritual_dryness'],
    expectedCovered: false,
  },
  {
    id: 'C5',
    text: '갑자기 경제적으로 너무 어려워져서 생활비가 걱정됩니다.',
    allowedPrimaryDomains: ['financial_hardship'],
    expectedCovered: false,
  },
  {
    id: 'C6',
    text: '병원에서 만성질환 진단을 받았어요. 앞으로 이 병과 어떻게 살아가야 할지 막막합니다.',
    allowedPrimaryDomains: ['chronic_illness'],
    expectedCovered: false,
  },
  {
    id: 'C7',
    text: '교회 사람과 크게 갈등이 생겼는데 용서와 관계 회복을 어떻게 해야 할지 모르겠습니다.',
    allowedPrimaryDomains: ['relationship_conflict_forgiveness'],
    expectedCovered: false,
  },
];

const formatTags = (label: string, tags: string[]) =>
  `    ${label}: ${tags.length > 0 ? tags.join(', ') : '(없음)'}`;

const formatScore = (score: CardScore | undefined) =>
  score ? `${score.cardId} ${score.totalScore}점` : '(없음)';

async function main() {
  const client = createClient();
  const totalUsage = emptyUsage();

  let domainMatched = 0;
  let coverageMatched = 0;
  let wronglyCovered = 0;
  let failed = 0;

  console.log(`모델: ${MODEL} / store: false / 사례 ${DOMAIN_CASES.length}개`);

  for (const domainCase of DOMAIN_CASES) {
    line();
    console.log(`[${domainCase.id}]`);
    console.log(`  원문: ${domainCase.text}`);
    if (domainCase.note) console.log(`  메모: ${domainCase.note}`);

    let result: Awaited<ReturnType<typeof analyzeSituation>>;
    try {
      result = await analyzeSituation(client, domainCase.text);
    } catch (error) {
      failed += 1;
      console.log(`  요청 실패: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }

    addUsage(totalUsage, result.usage);

    if (!result.analysis) {
      failed += 1;
      console.log('  검증 실패 (결과를 임의로 고치지 않습니다)');
      for (const error of result.errors) console.log(`    - ${error}`);
      continue;
    }

    const analysis = result.analysis;

    console.log(`  primaryDomain: ${analysis.primaryDomain}`);
    console.log(
      `  secondaryDomains: ${
        analysis.secondaryDomains.length > 0 ? analysis.secondaryDomains.join(', ') : '(없음)'
      }`,
    );
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

    const coverage = getCoverage(analysis.primaryDomain);
    console.log(
      `  Coverage: covered=${coverage.covered} / cardIds=[${coverage.cardIds.join(', ')}]`,
    );

    const match = matchScriptureCards(analysis);
    const top3 = match.scores.slice(0, 3);
    console.log('  Matcher top 3');
    top3.forEach((score, index) => {
      console.log(`    ${index + 1}위 ${formatScore(score)}`);
    });

    if (!coverage.covered) {
      console.log('  *** NO COVERAGE ***');
      console.log('  위 Matcher 점수가 높아도 지금 카드로 다룰 수 있는 상황이 아닙니다.');
      console.log('  이 결과를 "추천 가능"으로 해석하지 않습니다.');
    }

    const domainOk = domainCase.allowedPrimaryDomains.includes(analysis.primaryDomain);
    const coverageOk = coverage.covered === domainCase.expectedCovered;
    if (domainOk) domainMatched += 1;
    if (coverageOk) coverageMatched += 1;
    if (domainCase.id.startsWith('C') && coverage.covered) wronglyCovered += 1;

    console.log(`  Domain 기대값: ${domainCase.allowedPrimaryDomains.join(' 또는 ')}`);
    console.log(`  Domain 판정: ${domainOk ? '일치' : '불일치'}`);
    console.log(`  Coverage 기대값: ${domainCase.expectedCovered}`);
    console.log(`  Coverage 판정: ${coverageOk ? '일치' : '불일치'}`);
  }

  line('=');
  console.log(`Domain 일치: ${domainMatched} / ${DOMAIN_CASES.length}`);
  console.log(`Coverage 일치: ${coverageMatched} / ${DOMAIN_CASES.length}`);
  console.log(`C1~C7 중 covered=true로 잘못 판정된 개수: ${wronglyCovered}`);
  if (failed > 0) console.log(`요청 오류 또는 규격 검증 실패: ${failed}건`);
  console.log('OpenAI 사용량:');
  console.log(`  - input tokens: ${totalUsage.input}`);
  console.log(`  - output tokens: ${totalUsage.output}`);
  console.log(`  - total tokens: ${totalUsage.total}`);
}

main().catch((error) => {
  console.error(`실행 중 오류: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
