/**
 * OpenAI Situation Analyzer 로컬 테스트 프로그램
 *
 * 실행 (터미널에서 직접):
 *   OPENAI_API_KEY=... npm run test:openai
 *
 * 이 파일은 앱에 포함되지 않는다. 개발자가 Mac에서 직접 실행해 보는 용도다.
 * API Key는 코드나 파일에 저장하지 않고 실행할 때 환경변수로만 받는다.
 *
 * 하는 일:
 *   1. 한국어 문장 8개를 각각 따로 OpenAI에 보낸다.
 *   2. Structured Outputs로 아뢰다 표준 태그 구조만 받도록 강제한다.
 *   3. 받은 결과를 validateSituationAnalysis로 다시 검증한다.
 *   4. 검증을 통과한 결과를 기존 매칭 엔진에 넣어 1위 카드를 계산한다.
 *
 * 지시문과 응답 구조는 scripts/analyzer-prompt.ts에 함께 두었다.
 */

import {
  MODEL,
  addUsage,
  analyzeSituation,
  createClient,
  emptyUsage,
  line,
} from './analyzer-prompt.ts';
import { matchScriptureCards } from '../src/lib/scripture-matcher.ts';

type TestCase = {
  no: number;
  userText: string;
  expectedCardId: string;
};

const TEST_CASES: TestCase[] = [
  {
    no: 1,
    userText: '내년에 이사를 해야 하는데 어디로 가야 할지 벌써부터 마음이 무거워요.',
    expectedCardId: 'SC-002',
  },
  {
    no: 2,
    userText: '오늘 아들이 바라던 학교에 합격했어요. 너무 기쁘고 하나님께 감사하고 싶어요.',
    expectedCardId: 'SC-004',
  },
  {
    no: 3,
    userText: '몇 년째 기도하고 있는데 아무것도 달라지지 않아요. 이제 기도하는 것도 지쳤어요.',
    expectedCardId: 'SC-003',
  },
  {
    no: 4,
    userText: '친구들은 다 잘되는 것 같은데 저만 뒤처지는 것 같아서 속상해요.',
    expectedCardId: 'SC-007',
  },
  {
    no: 5,
    // 이전 문장("직장 상사가 사람들 앞에서 반복적으로 저를 모욕합니다...")은 반복적 모욕이라
    // 안전 확인이 일반 카드 추천보다 먼저인 상황이다. 이 스크립트는 Matcher 카드 확인용으로
    // 남고(Gate·안전 계약을 검사하지 않는다), 그 목적에 맞게 안전 경계가 아닌 문장으로 바꿨다
    // (검수 수정, 2026-09-16). 기대 카드는 SC-008을 그대로 유지한다.
    userText: '제가 하지 않은 일 때문에 부당하게 책임을 뒤집어썼어요.',
    expectedCardId: 'SC-008',
  },
  {
    no: 6,
    userText: '어머니가 돌아가신 뒤 계속 생각나고 너무 보고 싶어요.',
    expectedCardId: 'SC-009',
  },
  {
    no: 7,
    userText: '하나님께 죄송하다고 했는데 또 같은 죄를 지었어요.',
    expectedCardId: 'SC-006',
  },
  {
    no: 8,
    userText: '오늘은 특별한 일은 없어요. 그냥 하나님과 조용히 이야기하고 싶어요.',
    expectedCardId: 'SC-005',
  },
];

const formatTags = (label: string, tags: string[]) =>
  `  ${label}: ${tags.length > 0 ? tags.join(', ') : '(없음)'}`;

async function main() {
  const client = createClient();

  let matched = 0;
  let failed = 0;
  const totalUsage = emptyUsage();

  console.log(`모델: ${MODEL} / store: false / 테스트 문장 ${TEST_CASES.length}개`);

  for (const testCase of TEST_CASES) {
    line();
    console.log(`CASE ${testCase.no}`);
    console.log(`원문: ${testCase.userText}`);

    let result: Awaited<ReturnType<typeof analyzeSituation>>;
    try {
      result = await analyzeSituation(client, testCase.userText);
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
    console.log('Situation Analysis');
    console.log(formatTags('situationTags', analysis.situationTags));
    console.log(formatTags('emotionTags', analysis.emotionTags));
    console.log(formatTags('spiritualQuestionTags', analysis.spiritualQuestionTags));
    console.log(formatTags('prayerModes', analysis.prayerModes));
    console.log(formatTags('pastoralFunctions', analysis.pastoralFunctions));
    console.log(
      `  safety: ${analysis.safety.level}${
        analysis.safety.categories.length > 0 ? ` (${analysis.safety.categories.join(', ')})` : ''
      }`,
    );

    const match = matchScriptureCards(analysis);
    const top = match.topCards[0];
    const isMatch = top?.cardId === testCase.expectedCardId;
    if (isMatch) matched += 1;

    console.log(
      `선택된 Scripture Card: ${top ? top.cardId : '(없음)'}${
        match.isTie ? ` (동점: ${match.topCards.map((card) => card.cardId).join(', ')})` : ''
      }`,
    );
    console.log(`점수: ${match.topScore}점 / 100점`);
    console.log(`예상 카드: ${testCase.expectedCardId}`);
    console.log(`결과: ${isMatch ? '일치' : '불일치'}`);
    console.log(`confidence: ${analysis.confidence}`);
  }

  line('=');
  console.log(`일치: ${matched} / ${TEST_CASES.length}`);
  if (failed > 0) console.log(`실패(요청 오류 또는 검증 실패): ${failed}건`);
  console.log('OpenAI 사용량:');
  console.log(`  - input tokens: ${totalUsage.input}`);
  console.log(`  - output tokens: ${totalUsage.output}`);
  console.log(`  - total tokens: ${totalUsage.total}`);
}

main().catch((error) => {
  console.error(`실행 중 오류: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
