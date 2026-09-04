/**
 * Situation Analyzer 호출 도구 (로컬 테스트 전용)
 *
 * 지시문과 응답 구조는 src/lib/analyzer-contract.ts 한 곳에만 둔다.
 * Supabase Edge Function도 같은 파일을 사용한다.
 * 이 파일은 앱에 포함되지 않는다.
 * API Key는 저장하지 않고 실행할 때 환경변수로만 받는다.
 */

import OpenAI from 'openai';

import {
  MODEL,
  INSTRUCTIONS,
  SITUATION_ANALYSIS_SCHEMA,
} from '../src/lib/analyzer-contract.ts';
import { validateSituationAnalysis, type SituationAnalysis } from '../src/lib/situation-analysis.ts';

export { MODEL, INSTRUCTIONS, SITUATION_ANALYSIS_SCHEMA };

export type Usage = { input: number; output: number; total: number };

export type AnalyzeOutcome = {
  analysis: SituationAnalysis | null;
  errors: string[];
  usage: Usage;
};

/** 키가 없으면 안내만 하고 종료한다. 키를 파일에 저장하지 않는다. */
export function createClient(): OpenAI {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey || apiKey.trim() === '') {
    console.error('OPENAI_API_KEY가 설정되지 않았습니다.');
    process.exit(1);
  }
  return new OpenAI({ apiKey });
}

/** 문장 하나를 분석한다. 규격을 어긴 응답은 고치지 않고 실패로 돌려준다. */
export async function analyzeSituation(client: OpenAI, userText: string): Promise<AnalyzeOutcome> {
  const response = await client.responses.create({
    model: MODEL,
    store: false,
    instructions: INSTRUCTIONS,
    input: userText,
    text: {
      format: {
        type: 'json_schema',
        name: 'situation_analysis',
        strict: true,
        schema: SITUATION_ANALYSIS_SCHEMA as unknown as Record<string, unknown>,
      },
    },
  });

  const usage: Usage = {
    input: response.usage?.input_tokens ?? 0,
    output: response.usage?.output_tokens ?? 0,
    total: response.usage?.total_tokens ?? 0,
  };

  const rawText = response.output_text;
  if (!rawText) {
    return { analysis: null, errors: ['모델이 빈 응답을 보냈습니다.'], usage };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    return { analysis: null, errors: ['응답을 JSON으로 읽을 수 없습니다.'], usage };
  }

  const validation = validateSituationAnalysis(parsed);
  if (!validation.valid) {
    return { analysis: null, errors: validation.errors, usage };
  }

  return { analysis: parsed as SituationAnalysis, errors: [], usage };
}

export const emptyUsage = (): Usage => ({ input: 0, output: 0, total: 0 });

export function addUsage(total: Usage, one: Usage) {
  total.input += one.input;
  total.output += one.output;
  total.total += one.total;
}

export const line = (char = '─') => console.log(char.repeat(60));
