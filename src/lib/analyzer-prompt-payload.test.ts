/**
 * scripts/analyzer-prompt.ts의 OpenAI 요청 payload 회귀 테스트
 *
 * 실제 네트워크 호출은 하지 않는다. client 인자에 가짜 OpenAI 클라이언트(responses.create를
 * 흉내 낸 객체)를 넣어 analyzeSituation이 실제로 어떤 payload를 만드는지만 확인한다.
 *
 * temperature/top_p를 보내지 않는지 확인하는 회귀 테스트다 — 이 모델(gpt-5.6-luna)에
 * 실제로 temperature: 0을 보냈더니 "400 Unsupported parameter: 'temperature' is not
 * supported with this model."이 났다(2026-09-16). 그래서 temperature: 0을 뺐고, 다시
 * 넣지 않도록 여기서 고정한다. 로컬 평가 경로(analyzer-prompt.ts)와 Edge Function
 * 경로(edge-analyzer.ts의 buildOpenAIPayload, handler.test.ts에서 검증)가 같은
 * model·store·instructions·Structured Output schema를 쓰는지도 맞춰본다.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { INSTRUCTIONS, MODEL, analyzeSituation } from '../../scripts/analyzer-prompt.ts';

const fakeAnalysisJson = JSON.stringify({
  domainPriority: 'resolved',
  primaryDomain: 'grief_loss',
  domainChoiceCandidates: [],
  secondaryDomains: [],
  situationTags: ['사별'],
  emotionTags: ['슬픔'],
  spiritualQuestionTags: ['슬픔'],
  prayerModes: ['탄식'],
  pastoralFunctions: ['위로'],
  safety: { level: 'normal', categories: [] },
  confidence: 0.8,
});

function createFakeClient() {
  let capturedPayload: Record<string, unknown> | null = null;
  const client = {
    responses: {
      create: async (payload: Record<string, unknown>) => {
        capturedPayload = payload;
        return {
          output_text: fakeAnalysisJson,
          usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
        };
      },
    },
  };
  return { client, getPayload: () => capturedPayload };
}

describe('analyzer-prompt · OpenAI 요청 payload', () => {
  it('model·store·instructions·input·Structured Output schema를 그대로 보내고, 이 모델이 지원하지 않는 temperature·top_p는 보내지 않는다', async () => {
    const { client, getPayload } = createFakeClient();

    await analyzeSituation(client as unknown as Parameters<typeof analyzeSituation>[0], '어머니가 돌아가셨어요.');

    const payload = getPayload();
    assert.ok(payload, 'client.responses.create가 호출되지 않았습니다.');
    assert.equal(payload!.model, MODEL);
    assert.equal(payload!.store, false);
    assert.equal(payload!.instructions, INSTRUCTIONS);
    assert.equal(payload!.input, '어머니가 돌아가셨어요.');
    assert.equal('max_output_tokens' in payload!, false, 'max_output_tokens를 넣지 않습니다.');
    assert.equal('temperature' in payload!, false, 'temperature를 넣지 않습니다(이 모델은 지원하지 않는다).');
    assert.equal('top_p' in payload!, false, 'top_p를 넣지 않습니다.');

    const format = (payload!.text as { format: Record<string, unknown> }).format;
    assert.equal(format.type, 'json_schema');
    assert.equal(format.strict, true);
    assert.equal(format.name, 'situation_analysis');
  });
});
