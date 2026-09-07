/**
 * 모델을 어떻게 부를지 정한 값 · 테스트
 *
 * 실행: npm test
 *
 * 지키려는 것 다섯 가지.
 *
 *   1. 값이 정확히 그 값이다. 별칭도, 기본값에 맡기는 것도 없다.
 *   2. 앞 계약이 "정해야 한다"고 한 셋이 실제로 정해졌다.
 *   3. 다시 부르기·갈아타기·고치기 규칙을 여기서 새로 정하지 않는다.
 *   4. 답의 모양을 여기 적지 않는다.
 *   5. 실제로 부르는 코드도, 열쇠를 찾는 일도 없다.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import {
  CANDIDATE_GENERATION_RUNTIME_CONFIG,
  RUNTIME_CONFIG_DOES_NOT_INCLUDE,
  SAMPLING_POLICY,
  SCHEMA_IS_DERIVED_FROM_CONTRACT,
} from '../../supabase/functions/_shared/published-content-candidate-generation-runtime-config.ts';
import { TRANSPORT_RUNTIME_CONFIG_POLICY } from '../../supabase/functions/_shared/published-content-candidate-generation-transport-contract.ts';
import { MODEL_SYNTHESIS_FIELDS } from '../../supabase/functions/_shared/published-content-candidate-generation-contract.ts';
import {
  CANDIDATE_PROSE_FIELDS,
  CANDIDATE_TAG_FIELDS,
  MISUSE_GUARD_LIST_MAX,
  MISUSE_GUARD_TEXT_MAX,
  PROSE_MAX,
  TAG_LIST_MAX,
  TAG_TEXT_MAX,
} from '../../supabase/functions/_shared/published-content-contract.ts';

const CONFIG_PATH =
  '../../supabase/functions/_shared/published-content-candidate-generation-runtime-config.ts';
const CONFIG_SOURCE = readFileSync(new URL(CONFIG_PATH, import.meta.url), 'utf8');

const config = CANDIDATE_GENERATION_RUNTIME_CONFIG;

/* ================================================================== */
/* A. 정확한 값                                                         */
/* ================================================================== */

describe('부르는 방식 · A. 정한 값', () => {
  it('어디에 어떤 방식으로 부르는지 정했다', () => {
    assert.equal(config.provider, 'openai');
    assert.equal(config.api, 'responses');
  });

  it('예전 방식을 쓰지 않는다', () => {
    assert.notEqual(config.api, 'chat_completions');
    assert.equal(CONFIG_SOURCE.includes('chat.completions'), false);
  });

  it('모델이 정확히 하나로 정해져 있다', () => {
    assert.equal(config.model, 'gpt-5.6-sol');
  });

  it('별칭을 쓰지 않는다', () => {
    // 별칭은 언젠가 다른 모델을 가리킬 수 있다.
    // 그러면 아무도 바꾸지 않았는데 글의 성격이 달라진다.
    assert.notEqual(config.model, 'gpt-5.6');
    assert.notEqual(config.model, 'gpt-5');
    assert.ok(config.model.endsWith('-sol'), config.model);
  });

  it('생각하는 정도가 가운데다', () => {
    assert.equal(config.reasoningEffort, 'medium');
    for (const other of ['none', 'low', 'high', 'xhigh', 'max']) {
      assert.notEqual(config.reasoningEffort, other, other);
    }
  });

  it('기다리는 시간이 정해져 있다', () => {
    assert.equal(config.timeoutMs, 60_000);
  });

  it('최대 출력량이 정해져 있다', () => {
    assert.equal(config.maxOutputTokens, 8_192);
  });

  it('형식이 정해진 답만 받는다', () => {
    assert.equal(config.structuredOutput.type, 'json_schema');
    assert.equal(config.structuredOutput.strict, true);
    assert.equal(config.structuredOutput.schemaName, 'aroeda_candidate_generation_v1');
  });

  it('느슨한 형식을 쓰지 않는다', () => {
    assert.notEqual(config.structuredOutput.type, 'json_object');
    assert.notEqual(config.structuredOutput.type, 'text');
  });

  it('남기지 않고, 나눠 받지 않고, 맡겨 두지 않는다', () => {
    assert.equal(config.store, false);
    assert.equal(config.stream, false);
    assert.equal(config.background, false);
  });

  it('앞부분을 조용히 버리지 않는다', () => {
    assert.equal(config.truncation, 'disabled');
    assert.notEqual(config.truncation, 'auto');
  });

  it('처리 방식을 프로젝트 설정에 맡기지 않는다', () => {
    assert.equal(config.serviceTier, 'default');
    for (const other of ['auto', 'flex', 'priority', 'fast', 'ultrafast']) {
      assert.notEqual(config.serviceTier, other, other);
    }
  });

  it('도구를 주지 않는다', () => {
    assert.equal(config.toolsAllowed, false);
  });

  it('정한 항목이 이것뿐이다', () => {
    // 목록을 못 박아 두면 값 하나가 조용히 늘어나는 일을 막을 수 있다.
    assert.deepEqual(Object.keys(config).sort(), [
      'api',
      'automaticJsonRepair',
      'automaticRetries',
      'background',
      'fallbackModelAllowed',
      'maxOutputTokens',
      'model',
      'provider',
      'reasoningEffort',
      'serviceTier',
      'store',
      'stream',
      'structuredOutput',
      'timeoutMs',
      'toolsAllowed',
      'truncation',
    ]);
  });
});

/* ================================================================== */
/* B. 앞 계약이 요구한 것                                               */
/* ================================================================== */

describe('부르는 방식 · B. 계약이 요구한 것', () => {
  it('정해야 한다고 한 셋이 실제로 정해졌다', () => {
    assert.equal(TRANSPORT_RUNTIME_CONFIG_POLICY.modelMustBeExplicitlyConfigured, true);
    assert.equal(TRANSPORT_RUNTIME_CONFIG_POLICY.timeoutMustBeExplicitlyConfigured, true);
    assert.equal(TRANSPORT_RUNTIME_CONFIG_POLICY.outputBudgetMustBeExplicitlyConfigured, true);

    assert.notEqual(config.model, null);
    assert.notEqual(config.timeoutMs, null);
    assert.notEqual(config.maxOutputTokens, null);
  });

  it('계약 쪽 기본값은 여전히 비어 있다', () => {
    // 값은 여기서 정한다. 계약에는 기본값을 두지 않는다.
    assert.equal(TRANSPORT_RUNTIME_CONFIG_POLICY.defaultModel, null);
    assert.equal(TRANSPORT_RUNTIME_CONFIG_POLICY.defaultTimeoutMs, null);
    assert.equal(TRANSPORT_RUNTIME_CONFIG_POLICY.defaultOutputBudget, null);
  });

  it('다시 부르기·갈아타기·고치기는 계약의 값을 그대로 쓴다', () => {
    assert.equal(config.automaticRetries, TRANSPORT_RUNTIME_CONFIG_POLICY.automaticRetries);
    assert.equal(config.fallbackModelAllowed, TRANSPORT_RUNTIME_CONFIG_POLICY.fallbackModelAllowed);
    assert.equal(config.automaticJsonRepair, TRANSPORT_RUNTIME_CONFIG_POLICY.automaticJsonRepair);

    assert.equal(config.automaticRetries, 0);
    assert.equal(config.fallbackModelAllowed, false);
    assert.equal(config.automaticJsonRepair, false);
  });

  it('남기지 않는다는 규칙이 두 곳에서 같다', () => {
    assert.equal(config.store, TRANSPORT_RUNTIME_CONFIG_POLICY.rawModelOutputPersisted);
    assert.equal(config.store, false);
  });

  it('값을 베끼지 않고 가져다 쓴다', () => {
    // 두 곳에 적어 두면 언젠가 한쪽만 바뀐다.
    assert.ok(CONFIG_SOURCE.includes('TRANSPORT_RUNTIME_CONFIG_POLICY.automaticRetries'));
    assert.ok(CONFIG_SOURCE.includes('TRANSPORT_RUNTIME_CONFIG_POLICY.fallbackModelAllowed'));
    assert.ok(CONFIG_SOURCE.includes('TRANSPORT_RUNTIME_CONFIG_POLICY.automaticJsonRepair'));
    assert.ok(CONFIG_SOURCE.includes('TRANSPORT_RUNTIME_CONFIG_POLICY.rawModelOutputPersisted'));
  });
});

/* ================================================================== */
/* C. 출력량이 모자라지 않는가                                          */
/* ================================================================== */

/**
 * 여기서 확인하는 것과 확인하지 않는 것을 나눠 둔다.
 *
 * 확인하는 것.
 *   보이는 답의 길이에 끝이 있다.
 *   길이가 열려 있는 항목이 없다.
 *   예산이 8,192로 정해져 있다.
 *
 * 확인하지 않는 것.
 *   그 예산이 충분한가.
 *
 * 글자 수를 세어 토큰 예산이 넉넉하다고 말할 수 없다.
 * 한글 한 글자가 토큰 하나 안에 들어간다는 보장이 없기 때문이다.
 * 두 숫자는 단위가 다르고, 견주어서 안전하다는 결론을 낼 수 없다.
 *
 * 실제로 모자란지는 돌려 봐야 안다.
 * 모자라면 조용히 잘리지 않고 끊긴 답으로 끝난다. 그것이 지금의 안전장치다.
 */
describe('부르는 방식 · C. 출력량', () => {
  /** 계약이 허락하는 가장 긴 답의 글자수. 값만 센 것이다. */
  const maxVisibleChars =
    CANDIDATE_PROSE_FIELDS.length * PROSE_MAX +
    CANDIDATE_TAG_FIELDS.length * TAG_LIST_MAX * TAG_TEXT_MAX +
    MISUSE_GUARD_LIST_MAX * MISUSE_GUARD_TEXT_MAX;

  it('보이는 답의 길이에 끝이 있다', () => {
    // 끝이 없으면 얼마를 잡아도 모자랄 수 있다.
    assert.ok(Number.isFinite(maxVisibleChars));
    assert.ok(maxVisibleChars > 0);
    assert.equal(maxVisibleChars, 5_200);
  });

  it('예산이 0보다 크고 정해진 값이다', () => {
    assert.ok(config.maxOutputTokens > 0);
    assert.equal(config.maxOutputTokens, 8_192);
  });

  it('길이가 열려 있는 항목이 없다', () => {
    // 위의 상한은 모든 항목에 제한이 있을 때만 뜻을 갖는다.
    // 제한 없는 항목이 하나라도 생기면 그 상한은 더 이상 상한이 아니다.
    //
    // 모델이 쓰는 열 항목이 길이가 정해진 세 부류로 모두 덮이는지 본다.
    //   산문 넷, 태그 다섯, 오용을 막는 문구 하나.
    const bounded = [...CANDIDATE_PROSE_FIELDS, ...CANDIDATE_TAG_FIELDS, 'misuseGuards'];

    assert.deepEqual([...MODEL_SYNTHESIS_FIELDS].sort(), bounded.sort());

    for (const limit of [PROSE_MAX, TAG_LIST_MAX, TAG_TEXT_MAX, MISUSE_GUARD_LIST_MAX, MISUSE_GUARD_TEXT_MAX]) {
      assert.ok(Number.isFinite(limit) && limit > 0, String(limit));
    }
  });


  it('예산은 보이는 답과 생각하는 부분을 함께 센다는 것을 적었다', () => {
    assert.ok(CONFIG_SOURCE.includes('속으로 생각하는 부분을 함께 센다'));
  });

  it('모자라면 끊긴 답을 살려 쓰지 않는다', () => {
    assert.ok(CONFIG_SOURCE.includes('끊긴 답은 살려 쓰지 않고 버린다'));
  });
});

/* ================================================================== */
/* D. 정하지 않은 것                                                    */
/* ================================================================== */

describe('부르는 방식 · D. 정하지 않은 것', () => {
  it('표본 설정을 건드리지 않는다', () => {
    assert.equal(SAMPLING_POLICY.overridden, false);
    assert.equal('temperature' in config, false);
    assert.equal('topP' in config, false);
    assert.equal('top_p' in config, false);
  });

  it('표본 설정 값을 적어 두지 않았다', () => {
    for (const banned of ['temperature:', 'top_p:', 'topP:', 'topK:', 'seed:']) {
      assert.equal(CONFIG_SOURCE.includes(banned), false, banned);
    }
  });

  it('왜 건드리지 않는지 적어 두었다', () => {
    assert.ok(SAMPLING_POLICY.reason.includes('사람의 검토'));
  });

  it('답의 모양을 여기 적지 않는다', () => {
    // 여기 적으면 계약과 두 벌이 된다.
    for (const banned of [
      'properties',
      'additionalProperties',
      'required:',
      'anyOf',
      'oneOf',
      'allOf',
      '$schema',
    ]) {
      assert.equal(CONFIG_SOURCE.includes(banned), false, banned);
    }
    assert.ok(SCHEMA_IS_DERIVED_FROM_CONTRACT.includes('생성 계약에서 만든다'));
  });

  it('계약의 항목 이름을 여기 옮겨 적지 않는다', () => {
    for (const banned of [
      'selectedPassageIndex',
      'situationTags',
      'userExplanation',
      'prayerDirection',
      'misuseGuards',
      'needs_more_research',
      'researchResultHash',
    ]) {
      assert.equal(CONFIG_SOURCE.includes(banned), false, banned);
    }
  });

  it('여기서 하지 않는 일을 적어 두었다', () => {
    assert.ok(RUNTIME_CONFIG_DOES_NOT_INCLUDE.length >= 4);
    const text = RUNTIME_CONFIG_DOES_NOT_INCLUDE.join(' ');
    assert.ok(text.includes('열쇠'));
    assert.ok(text.includes('schema'));
  });
});

/* ================================================================== */
/* E. 부르는 코드가 아니다                                              */
/* ================================================================== */

describe('부르는 방식 · E. 경계', () => {
  it('모델을 부르지 않는다', () => {
    for (const banned of [
      'import OpenAI',
      'new OpenAI',
      'responses.create',
      'chat.completions',
      'api.openai.com',
      'Authorization',
    ]) {
      assert.equal(CONFIG_SOURCE.includes(banned), false, banned);
    }
  });

  it('열쇠를 찾지 않는다', () => {
    for (const banned of ['OPENAI_API_KEY', 'apiKey', 'Deno.env', 'process.env', 'secret']) {
      assert.equal(CONFIG_SOURCE.includes(banned), false, banned);
    }
  });

  it('바깥을 부르거나 표를 열지 않는다', () => {
    for (const banned of [
      'fetch(',
      'createClient',
      'supabase',
      'service_role',
      'AbortController',
      'setTimeout',
    ]) {
      assert.equal(CONFIG_SOURCE.includes(banned), false, banned);
    }
  });

  it('부를 때마다 같은 값이다', () => {
    for (const banned of ['Date.now', 'Math.random', 'randomUUID', 'new Date(']) {
      assert.equal(CONFIG_SOURCE.includes(banned), false, banned);
    }
  });

  it('가져오는 곳이 같은 저장소의 계약 하나뿐이다', () => {
    const specifiers = [...CONFIG_SOURCE.matchAll(/from '([^']+)'/g)].map((m) => m[1] as string);
    assert.deepEqual(specifiers, [
      './published-content-candidate-generation-transport-contract.ts',
    ]);
  });
});
