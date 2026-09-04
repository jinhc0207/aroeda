/**
 * Biblical Researcher 실행 정책 · 테스트
 *
 * 실행: npm test
 *
 * 지키려는 것:
 *   정해진 값이 그대로 있다.
 *   같은 값의 주인이 둘이 되지 않는다.
 *   실패하면 다른 모델로 몰래 바꾸거나 다시 부르지 않는다.
 *   이 파일은 바깥과 닿지 않는다.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import {
  BIBLICAL_RESEARCH_API_FAMILY,
  BIBLICAL_RESEARCH_EXPECTED_MODEL_CALLS,
  BIBLICAL_RESEARCH_FAILURES,
  BIBLICAL_RESEARCH_FAIL_CLOSED_RULES,
  BIBLICAL_RESEARCH_MAX_OUTPUT_TOKENS,
  BIBLICAL_RESEARCH_MODEL,
  BIBLICAL_RESEARCH_MODEL_TIMEOUT_MS,
  BIBLICAL_RESEARCH_POLICY_REVISION_TRIGGERS,
  BIBLICAL_RESEARCH_REASONING_EFFORT,
  BIBLICAL_RESEARCH_REQUIRES_STRUCTURED_OUTPUT,
  BIBLICAL_RESEARCH_RETRY_COUNT,
  BIBLICAL_RESEARCH_STORE,
  BIBLICAL_RESEARCH_TOOLS,
  BIBLICAL_RESEARCH_TRUNCATION,
} from '../../supabase/functions/_shared/biblical-researcher-runtime-policy.ts';
import {
  BIBLICAL_RESEARCH_EXPECTED_MODEL_CALLS as PLAN_CALLS,
  BIBLICAL_RESEARCH_STORE as PLAN_STORE,
  BIBLICAL_RESEARCH_TOOLS as PLAN_TOOLS,
  buildBiblicalResearchExecutionPlan,
} from '../../supabase/functions/_shared/biblical-researcher-execution-contract.ts';
import { buildBiblicalResearchHandoff } from '../../supabase/functions/_shared/biblical-research-handoff.ts';
import { computeSourceId } from '../../supabase/functions/_shared/source-harvester.ts';
import { getActiveCoveredDomains } from '../../supabase/functions/_shared/research-prioritizer-edge.ts';
import { SOURCE_HARVEST_MODEL } from '../../supabase/functions/_shared/source-harvester-execution-contract.ts';
import { MODEL as ANALYZER_MODEL } from '../../supabase/functions/_shared/analyzer-contract.ts';

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
const stripComments = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '');

const POLICY = '../../supabase/functions/_shared/biblical-researcher-runtime-policy.ts';

/* 계획 하나를 실제로 만들어 본다. 값이 그대로 실려 나가는지 보기 위해서다.
   바깥과 닿지 않는다. 모델을 부르지 않는다. */
const SNAPSHOT = `snap_${'a'.repeat(64)}`;
const PSALM = { book: 'Psalms', chapter: 42, startVerse: 5, endVerse: 5 };
const fixtureUrl = (index: number) => `https://sources.example.org/aroeda/policy-${index}`;
const SOURCE_IDS = await Promise.all(
  Array.from({ length: 5 }, (_, index) => computeSourceId(fixtureUrl(index))),
);
const STATEMENT = '이 자료는 본문의 흐름과 그 신학적 자리를 함께 설명한다고 관찰되었다. 충분히 긴 문장이다.';
const SPECS = [
  { type: 'commentary', publisher: 'Fixture Academic Press', use: 'exegesis', access: 'full_text', refs: [{ ...PSALM }] },
  { type: 'biblical_theology', publisher: 'Fixture University Press', use: 'doctrinal_context', access: 'substantial_preview', refs: [] },
  { type: 'academic_article', publisher: 'Fixture Journal', use: 'exegesis', access: 'full_text', refs: [{ ...PSALM }] },
  { type: 'pastoral_resource', publisher: 'Fixture Seminary', use: 'pastoral_application', access: 'full_text', refs: [] },
  { type: 'professional_context', publisher: 'Fixture Public Health Agency', use: 'pastoral_safety', access: 'full_text', refs: [] },
];

const outcome = await buildBiblicalResearchHandoff({
  harvest: {
    targetDomain: 'financial_hardship',
    evidenceVersion: 4,
    prioritizerSnapshotId: SNAPSHOT,
    sources: SPECS.map((spec, index) => ({
      sourceId: SOURCE_IDS[index] as string,
      sourceType: spec.type,
      title: `연구 자료 ${index}`,
      authorOrOrganization: `연구자 ${index}`,
      publisherOrInstitution: spec.publisher,
      publicationYear: 2018 + index,
      url: fixtureUrl(index),
      accessedAt: '2026-09-02',
      accessLevel: spec.access,
      intendedUse: [spec.use],
      relevanceNote: '이 영역의 문맥을 확인하는 데 필요합니다.',
      evidenceClaims: [
        {
          evidenceId: `${SOURCE_IDS[index] as string}:e1`,
          intendedUse: spec.use,
          statement: `${STATEMENT} (${index})`,
          passageReferences: spec.refs,
        },
      ],
    })),
    rejectedSources: [
      { url: fixtureUrl(90), title: '익명 묵상글', rejectionReason: 'anonymous_or_unverifiable' },
    ],
    unresolvedSourceQuestions: ['더 볼 자료가 있는가'],
  } as never,
  activeCoveredDomains: getActiveCoveredDomains(),
});
assert.equal(outcome.ok, true, outcome.ok ? '' : outcome.errors.join(' / '));
if (!outcome.ok) throw new Error('handoff fixture failed');
const makePlan = () => buildBiblicalResearchExecutionPlan({ handoff: outcome.handoff });

/* ------------------------------------------------------------------ */

describe('실행 정책 · A. 정해진 값', () => {
  it('모델은 정해진 하나다', () => {
    assert.equal(BIBLICAL_RESEARCH_MODEL, 'gpt-5.6-sol');
  });

  it('생각하는 정도는 medium이다', () => {
    assert.equal(BIBLICAL_RESEARCH_REASONING_EFFORT, 'medium');
  });

  it('출력 한도는 16000이다', () => {
    assert.equal(BIBLICAL_RESEARCH_MAX_OUTPUT_TOKENS, 16_000);
  });

  it('모델 요청 시간 제한은 90초다', () => {
    assert.equal(BIBLICAL_RESEARCH_MODEL_TIMEOUT_MS, 90_000);
  });

  it('다시 부르지 않는다', () => {
    assert.equal(BIBLICAL_RESEARCH_RETRY_COUNT, 0);
  });

  it('답을 잘라 이어 붙이지 않는다', () => {
    assert.equal(BIBLICAL_RESEARCH_TRUNCATION, 'disabled');
  });

  it('대화를 저장하지 않는다', () => {
    assert.equal(BIBLICAL_RESEARCH_STORE, false);
  });

  it('형식이 정해진 답만 받는다', () => {
    assert.equal(BIBLICAL_RESEARCH_REQUIRES_STRUCTURED_OUTPUT, true);
  });
});

describe('실행 정책 · A2. 어느 API를 쓰는가', () => {
  it('Responses 계열로 고정돼 있다', () => {
    assert.equal(BIBLICAL_RESEARCH_API_FAMILY, 'responses');
  });

  it('다른 계열로 물러나는 길이 없다', () => {
    const code = stripComments(read(POLICY));
    for (const banned of [
      'chat.completions',
      'chatCompletions',
      'completions',
      'fallbackApi',
      'secondaryApi',
      'apiFallback',
    ]) {
      assert.equal(code.includes(banned), false, banned);
    }
    // 계열 값은 한 곳에만 있다.
    assert.equal((code.match(/'responses'/g) || []).length, 1);
  });

  it('계열만 정하고 요청은 만들지 않는다', () => {
    const code = stripComments(read(POLICY));
    for (const banned of ['/v1/', 'endpoint', 'url', 'baseUrl']) {
      assert.equal(code.includes(banned), false, banned);
    }
  });
});

describe('실행 정책 · B. 같은 값의 주인은 하나', () => {
  it('도구 없음과 요청 한 번은 실행 계약이 주인이다', () => {
    // 다시 정의하지 않고 그대로 가져다 쓴다.
    assert.equal(BIBLICAL_RESEARCH_EXPECTED_MODEL_CALLS, PLAN_CALLS);
    assert.equal(BIBLICAL_RESEARCH_TOOLS, PLAN_TOOLS);
    assert.equal(BIBLICAL_RESEARCH_EXPECTED_MODEL_CALLS, 1);
    assert.deepEqual([...BIBLICAL_RESEARCH_TOOLS], []);
  });

  it('정책 파일이 그 셋을 새로 만들지 않는다', () => {
    const code = stripComments(read(POLICY));

    for (const name of [
      'BIBLICAL_RESEARCH_EXPECTED_MODEL_CALLS',
      'BIBLICAL_RESEARCH_TOOLS',
      'BIBLICAL_RESEARCH_STORE',
    ]) {
      assert.equal(code.includes(`${name} = `), false, name);
      assert.equal(code.includes(`export const ${name}`), false, name);
    }

    // 가져와서 다시 내보내기만 한다.
    assert.ok(code.includes("from './biblical-researcher-execution-contract.ts'"));
    const reexport = code.split('export {')[1].split('};')[0];
    for (const name of [
      'BIBLICAL_RESEARCH_EXPECTED_MODEL_CALLS',
      'BIBLICAL_RESEARCH_STORE',
      'BIBLICAL_RESEARCH_TOOLS',
    ]) {
      assert.ok(reexport.includes(name), name);
    }
  });

  it('저장하지 않음의 주인은 실행 계약이다', () => {
    assert.equal(BIBLICAL_RESEARCH_STORE, PLAN_STORE);
    assert.equal(BIBLICAL_RESEARCH_STORE, false);

    // 실행 계약에 정의가 정확히 하나 있다.
    const plan = stripComments(
      read('../../supabase/functions/_shared/biblical-researcher-execution-contract.ts'),
    );
    assert.equal((plan.match(/export const BIBLICAL_RESEARCH_STORE = /g) || []).length, 1);

    // 계획이 실제로 그 값을 쓴다. 리터럴을 따로 적지 않는다.
    assert.ok(plan.includes('store: typeof BIBLICAL_RESEARCH_STORE;'));
    assert.ok(plan.includes('store: BIBLICAL_RESEARCH_STORE,'));
    assert.equal(plan.includes('store: false'), false);
  });

  it('만들어진 계획의 store가 정책 값과 같다', () => {
    assert.equal(makePlan().store, BIBLICAL_RESEARCH_STORE);
    assert.equal(makePlan().store, false);
  });

  it('실행 계약은 모델을 모른다', () => {
    const plan = stripComments(
      read('../../supabase/functions/_shared/biblical-researcher-execution-contract.ts'),
    );
    assert.equal(plan.includes('gpt-'), false);
    assert.equal(plan.includes('BIBLICAL_RESEARCH_MODEL'), false);
    assert.equal(plan.includes('biblical-researcher-runtime-policy'), false);
  });
});

describe('실행 정책 · C. 다른 모델로 몰래 바꾸지 않는다', () => {
  it('대체 모델 경로가 없다', () => {
    const code = stripComments(read(POLICY));
    for (const banned of [
      'fallbackModel',
      'fallbackModels',
      'secondaryModel',
      'retryModel',
      'FALLBACK',
      'SECONDARY',
    ]) {
      assert.equal(code.includes(banned), false, banned);
    }
  });

  it('다른 단계의 모델 이름이 없다', () => {
    const code = stripComments(read(POLICY));
    assert.equal(code.includes('terra'), false);
    assert.equal(code.includes('luna'), false);
    assert.equal(code.includes(SOURCE_HARVEST_MODEL), false);
    assert.equal(code.includes(ANALYZER_MODEL), false);

    // 다른 단계의 모델과 실제로 다른 값이다.
    assert.notEqual(BIBLICAL_RESEARCH_MODEL, SOURCE_HARVEST_MODEL);
    assert.notEqual(BIBLICAL_RESEARCH_MODEL, ANALYZER_MODEL);
  });

  it('모델 이름은 한 곳에만 있다', () => {
    const code = stripComments(read(POLICY));
    assert.equal((code.match(/gpt-5\.6-sol/g) || []).length, 1);
  });

  it('다른 단계의 시간 값을 옮겨 오지 않았다', () => {
    const code = stripComments(read(POLICY));
    for (const other of ['60_000', '75_000', '45_000', '120_000', '5_000']) {
      assert.equal(code.includes(other), false, other);
    }
  });
});

describe('실행 정책 · D. 바깥과 닿지 않는다', () => {
  it('네트워크·DB·환경변수를 모른다', () => {
    const code = stripComments(read(POLICY));
    for (const banned of [
      'fetch(',
      'Deno.env',
      'process.env',
      'createClient',
      '/rest/v1/',
      'api.openai.com',
      'AbortController',
      'JSON.parse',
    ]) {
      assert.equal(code.includes(banned), false, banned);
    }
  });

  it('요청을 만들지 않는다', () => {
    const code = stripComments(read(POLICY));
    for (const banned of ['method:', 'headers', 'body:', 'Request', 'Response', 'Deno.serve']) {
      assert.equal(code.includes(banned), false, banned);
    }
  });

  it('가져오는 것은 실행 계약 하나뿐이다', () => {
    const imports = [...read(POLICY).matchAll(/from '([^']+)'/g)].map((match) => match[1]);
    assert.deepEqual([...new Set(imports)], ['./biblical-researcher-execution-contract.ts']);
  });
});

describe('실행 정책 · E. 도구와 웹이 없다', () => {
  it('도구 이름이 하나도 없다', () => {
    const code = stripComments(read(POLICY));
    for (const banned of ['web_search', 'browser', 'file_search', 'computer', 'code_interpreter']) {
      assert.equal(code.includes(banned), false, banned);
    }
  });
});

describe('실행 정책 · F. 응답 형식을 복제하지 않는다', () => {
  it('형식 자체를 여기에 적지 않는다', () => {
    const code = stripComments(read(POLICY));
    assert.equal(code.includes('BIBLICAL_RESEARCH_SCHEMA'), false);
    assert.equal(code.includes("type: 'object'"), false);
    assert.equal(code.includes('additionalProperties'), false);
    assert.equal(code.includes('candidatePassages'), false);
    assert.equal(code.includes('sourceSupport'), false);
  });

  it('형식이 필요하다는 사실만 값으로 둔다', () => {
    assert.equal(BIBLICAL_RESEARCH_REQUIRES_STRUCTURED_OUTPUT, true);
  });
});

describe('실행 정책 · G. 실패의 종류', () => {
  it('정해진 아홉 가지뿐이고 모두 다르다', () => {
    assert.deepEqual([...BIBLICAL_RESEARCH_FAILURES], [
      'model_timeout',
      'model_transport_error',
      'model_non_success',
      'model_refusal',
      'model_incomplete',
      'model_output_missing',
      'model_output_invalid_json',
      'model_draft_invalid',
      'evidence_binding_failed',
    ]);
    assert.equal(new Set(BIBLICAL_RESEARCH_FAILURES).size, 9);
  });

  it('이름은 고정된 문자열이다', () => {
    for (const failure of BIBLICAL_RESEARCH_FAILURES) {
      assert.match(failure, /^[a-z_]+$/);
      assert.equal(/\d/.test(failure), false, failure);
    }
  });

  it('원본 오류나 상태 숫자를 담을 자리가 없다', () => {
    const code = stripComments(read(POLICY));
    for (const banned of ['status', 'statusCode', 'rawError', 'message:', 'stack']) {
      assert.equal(code.includes(banned), false, banned);
    }
  });

  it('실패마다 어느 경계인지 구분된다', () => {
    // 모델 요청 · 응답 읽기 · 초안 검사 · 근거 묶기 네 경계를 모두 덮는다.
    const failures = [...BIBLICAL_RESEARCH_FAILURES];
    assert.ok(failures.some((failure) => failure.startsWith('model_')));
    assert.ok(failures.includes('model_output_invalid_json'));
    assert.ok(failures.includes('model_draft_invalid'));
    assert.ok(failures.includes('evidence_binding_failed'));
  });
});

describe('실행 정책 · H. 실패하면 그대로 멈춘다', () => {
  it('하지 않을 일이 적혀 있다', () => {
    const rules = BIBLICAL_RESEARCH_FAIL_CLOSED_RULES.join(' ');

    assert.ok(rules.includes('일부만 돌려주지 않는다'));
    assert.ok(rules.includes('건져 쓰지 않는다'));
    assert.ok(rules.includes('같은 요청을 다시 부르지 않는다'));
    assert.ok(rules.includes('다른 모델로 바꾸어 다시 부르지 않는다'));
    assert.ok(rules.includes('생각하는 정도를 높여 다시 부르지 않는다'));
    assert.ok(rules.includes('근거에 묶지 못한 결과를 최종 결과로 돌려주지 않는다'));
  });

  it('다시 부르지 않는다는 값과 어긋나지 않는다', () => {
    assert.equal(BIBLICAL_RESEARCH_RETRY_COUNT, 0);
    assert.equal(BIBLICAL_RESEARCH_EXPECTED_MODEL_CALLS, 1);
  });

  it('언제 다시 볼지도 적어 두었다', () => {
    assert.ok(BIBLICAL_RESEARCH_POLICY_REVISION_TRIGGERS.length >= 3);
    const triggers = BIBLICAL_RESEARCH_POLICY_REVISION_TRIGGERS.join(' ');
    assert.ok(triggers.includes('끊긴다'));
    assert.ok(triggers.includes('high'));
  });
});

describe('실행 정책 · I. 다른 계약은 그대로다', () => {
  it('수집·판단 단계의 모델이 바뀌지 않았다', () => {
    assert.equal(SOURCE_HARVEST_MODEL, 'gpt-5.6-terra');
    assert.equal(ANALYZER_MODEL, 'gpt-5.6-luna');
  });

  it('근거 꾸러미와 묶기 계약을 건드리지 않았다', () => {
    for (const path of [
      '../../supabase/functions/_shared/biblical-research-handoff.ts',
      '../../supabase/functions/_shared/biblical-research-evidence-binding.ts',
    ]) {
      const code = read(path);
      assert.equal(code.includes('biblical-researcher-runtime-policy'), false, path);
      assert.equal(code.includes('gpt-'), false, path);
    }
  });

  it('아직 실행 계층이 없다', () => {
    const code = stripComments(read(POLICY));
    assert.equal(code.includes('handler'), false);
    assert.equal(code.includes('index.ts'), false);
  });
});
