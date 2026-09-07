/**
 * 제공자에게 넘길 답의 모양 · 테스트
 *
 * 실행: npm test
 *
 * 지키려는 것 다섯 가지.
 *
 *   1. 제공자가 받아 주는 모양이다. 맨 바깥이 객체이고, 둘 중 하나는 그 안에 있다.
 *   2. 씌운 한 겹이 우리 계약으로 새어 들어가지 않는다.
 *   3. 항목 이름과 낱말을 여기서 새로 정하지 않는다. 계약에서 가져온다.
 *   4. 태그를 기존 사전으로 가두지 않는다.
 *   5. 모양이 맞다고 뜻이 맞는 것은 아니다. 최종 판단은 계약 검사기가 한다.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import {
  CANDIDATE_GENERATION_STRUCTURED_OUTPUT_ENVELOPE_KEY,
  CANDIDATE_GENERATION_STRUCTURED_OUTPUT_SCHEMA,
  PROVIDER_ENVELOPE_NOTE,
  SCHEMA_IS_STRUCTURAL_ONLY,
} from '../../supabase/functions/_shared/published-content-candidate-generation-structured-output-schema.ts';
import {
  DEFER_RESPONSE_FIELDS,
  GENERATE_RESPONSE_FIELDS,
  GENERATION_DECISIONS,
  GENERATION_DEFER_REASONS,
  MODEL_DRAFT_FIELDS,
  buildCandidateModelGenerationInput,
  validateCandidateModelGenerationResponse,
  type CandidateModelGenerationInput,
} from '../../supabase/functions/_shared/published-content-candidate-generation-contract.ts';
import {
  CANDIDATE_FIELDS,
  CANDIDATE_PROSE_FIELDS,
  CANDIDATE_TAG_FIELDS,
} from '../../supabase/functions/_shared/published-content-contract.ts';
import { CANDIDATE_GENERATION_RUNTIME_CONFIG } from '../../supabase/functions/_shared/published-content-candidate-generation-runtime-config.ts';

const SCHEMA_PATH =
  '../../supabase/functions/_shared/published-content-candidate-generation-structured-output-schema.ts';
const SCHEMA_SOURCE = readFileSync(new URL(SCHEMA_PATH, import.meta.url), 'utf8');

const schema = CANDIDATE_GENERATION_STRUCTURED_OUTPUT_SCHEMA as Record<string, unknown>;
const ENVELOPE = CANDIDATE_GENERATION_STRUCTURED_OUTPUT_ENVELOPE_KEY;

/* ------------------------------------------------------------------ */
/* 모양을 훑는 도우미                                                   */
/* ------------------------------------------------------------------ */

type Node = Record<string, unknown>;

const isObjectNode = (node: unknown): node is Node =>
  typeof node === 'object' && node !== null && !Array.isArray(node);

/** 모양 안의 모든 마디를 훑는다. 낱말 검사와 required 검사에 함께 쓴다. */
const walk = (node: unknown, visit: (node: Node) => void): void => {
  if (Array.isArray(node)) {
    for (const item of node) walk(item, visit);
    return;
  }
  if (!isObjectNode(node)) return;

  visit(node);
  for (const value of Object.values(node)) walk(value, visit);
};

const responseNode = () => (schema.properties as Node)[ENVELOPE] as Node;
const branches = () => responseNode().anyOf as Node[];

const branchByDecision = (decision: string): Node => {
  const found = branches().find((branch) => {
    const properties = branch.properties as Node;
    const decisionNode = properties.decision as Node;
    return (decisionNode.enum as string[])[0] === decision;
  });
  assert.notEqual(found, undefined, decision);
  return found as Node;
};

/* ------------------------------------------------------------------ */
/* fixture                                                             */
/* ------------------------------------------------------------------ */

const PSALM_56 = { book: 'Psalms', chapter: 56, startVerse: 3, endVerse: 4 };

const researchResult = () => ({
  targetDomain: 'financial_hardship',
  evidenceVersion: 4,
  prioritizerSnapshotId: `snap_${'b'.repeat(64)}`,
  researchQuestion: '성경은 이 삶의 문제를 어떤 본문에서 직접 다루는가?',
  domainBoundaries: { includedConcerns: ['생계 압박'], excludedOrAdjacentConcerns: [] },
  candidatePassages: [
    {
      reference: PSALM_56,
      additionalReferences: [],
      canonicalContext: '이 본문이 놓인 원래 흐름에 대한 연구 메모입니다.',
      theologicalContribution: '이 본문이 이 영역에 주는 신학적 기여에 대한 메모입니다.',
      domainFit: '이 삶의 문제를 직접 다루기 때문입니다.',
      pastoralUse: ['위로'],
      misuseRisks: ['결과 보장으로 사용하지 않는다.'],
      distinctnessFromActiveCoverage: { distinct: true, nearestExistingDomain: 'x', explanation: 'y' },
      researchConfidence: 0.6,
      sourceSupport: {
        exegesisEvidenceIds: [], theologyEvidenceIds: [], pastoralEvidenceIds: [], safetyEvidenceIds: [],
        exegesisSourceIds: [], theologySourceIds: [], pastoralSourceIds: [], safetySourceIds: [],
      },
    },
  ],
  rejectedPassages: [],
  unresolvedQuestions: [],
  evidenceSetHash: `evset_${'c'.repeat(64)}`,
});

const INPUT = buildCandidateModelGenerationInput(researchResult()) as CandidateModelGenerationInput;

const draft = (over: Record<string, unknown> = {}) => ({
  selectedPassageIndex: 0,
  situationTags: ['생계가 흔들림'],
  emotionTags: ['막막함'],
  spiritualQuestionTags: ['하나님의 돌보심'],
  prayerModes: ['간구'],
  pastoralFunction: ['위로'],
  contextSummary: '이 본문이 놓인 흐름을 짧게 정리한 내부 설명입니다.',
  theologicalInsight: '이 본문이 붙드는 신학적 중심을 한 문장으로 적은 것입니다.',
  userExplanation: '지금 형편이 막막할 때 이 말씀이 무엇을 말하는지 쉬운 말로 설명합니다.',
  prayerDirection: '이 말씀을 붙들고 무엇을 아뢸 수 있는지 방향을 짧게 안내합니다.',
  misuseGuards: ['형편이 곧 나아진다는 약속으로 읽지 않는다.'],
  ...over,
});

/* ================================================================== */
/* A. 맨 바깥                                                           */
/* ================================================================== */

describe('답의 모양 · A. 맨 바깥', () => {
  it('맨 바깥이 객체다', () => {
    assert.equal(schema.type, 'object');
  });

  it('맨 바깥에 둘 중 하나가 오지 않는다', () => {
    // 제공자가 받아 주지 않는 모양이다. 그래서 한 겹을 씌웠다.
    assert.equal('anyOf' in schema, false);
  });

  it('맨 바깥의 자리는 하나뿐이다', () => {
    assert.deepEqual(Object.keys(schema.properties as Node), [ENVELOPE]);
  });

  it('그 하나가 반드시 있어야 한다', () => {
    assert.deepEqual(schema.required, [ENVELOPE]);
  });

  it('맨 바깥에 다른 것을 넣을 수 없다', () => {
    assert.equal(schema.additionalProperties, false);
  });

  it('둘 중 하나 고르기는 한 겹 안에서 일어난다', () => {
    assert.ok(Array.isArray(responseNode().anyOf));
    assert.equal(branches().length, 2);
  });
});

/* ================================================================== */
/* B. 모든 마디의 규칙                                                  */
/* ================================================================== */

describe('답의 모양 · B. 마디마다', () => {
  it('모든 객체가 다른 항목을 받지 않는다', () => {
    walk(schema, (node) => {
      if (node.type !== 'object') return;
      assert.equal(node.additionalProperties, false, JSON.stringify(Object.keys(node.properties as Node)));
    });
  });

  it('적어 둔 항목은 모두 반드시 있어야 한다', () => {
    walk(schema, (node) => {
      if (node.type !== 'object') return;
      const keys = Object.keys(node.properties as Node).sort();
      const required = [...(node.required as string[])].sort();
      assert.deepEqual(required, keys);
    });
  });

  it('쓰지 않기로 한 낱말이 없다', () => {
    // 제공자가 받아 주지 않거나, 모양을 복잡하게 만드는 것들이다.
    const banned = ['allOf', 'oneOf', 'not', 'if', 'then', 'else', '$schema', 'dependentRequired', 'dependentSchemas'];

    walk(schema, (node) => {
      for (const keyword of banned) {
        assert.equal(keyword in node, false, `${keyword} in ${JSON.stringify(Object.keys(node))}`);
      }
    });
  });

  it('쓰는 낱말이 정해진 것뿐이다', () => {
    const allowed = new Set(['type', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'anyOf', 'description']);

    walk(schema, (node) => {
      // properties 아래의 항목 이름은 낱말이 아니라 우리 항목 이름이다.
      if (node.type === 'object' || 'anyOf' in node || 'items' in node || 'enum' in node || 'type' in node) {
        for (const key of Object.keys(node)) {
          if (allowed.has(key)) continue;
          // properties 안쪽 객체는 이 검사 대상이 아니다.
          assert.ok(false, `모르는 낱말: ${key}`);
        }
      }
    });
  });

  it('둘 중 하나 고르기가 맨 바깥 말고 한 곳에만 있다', () => {
    let count = 0;
    walk(schema, (node) => {
      if ('anyOf' in node) count += 1;
    });
    assert.equal(count, 1);
  });
});

/* ================================================================== */
/* C. 쓸 수 있을 때의 갈래                                              */
/* ================================================================== */

describe('답의 모양 · C. 쓸 수 있을 때', () => {
  const [GENERATE] = GENERATION_DECISIONS;
  const branch = () => branchByDecision(GENERATE as string);

  it('항목이 계약과 정확히 같다', () => {
    assert.deepEqual(Object.keys(branch().properties as Node).sort(), [...GENERATE_RESPONSE_FIELDS].sort());
  });

  it('모두 반드시 있어야 한다', () => {
    assert.deepEqual([...(branch().required as string[])].sort(), [...GENERATE_RESPONSE_FIELDS].sort());
  });

  it('다른 항목을 받지 않는다', () => {
    assert.equal(branch().additionalProperties, false);
  });

  it('가려내는 값이 계약의 낱말이다', () => {
    const decision = (branch().properties as Node).decision as Node;
    assert.deepEqual(decision.enum, [GENERATE]);
    assert.equal(decision.type, 'string');
  });

  it('보류 이유가 들어갈 자리가 없다', () => {
    assert.equal('reason' in (branch().properties as Node), false);
  });
});

/* ================================================================== */
/* D. 못 쓰겠을 때의 갈래                                               */
/* ================================================================== */

describe('답의 모양 · D. 못 쓰겠을 때', () => {
  const [, DEFER] = GENERATION_DECISIONS;
  const branch = () => branchByDecision(DEFER as string);

  it('항목이 계약과 정확히 같다', () => {
    assert.deepEqual(Object.keys(branch().properties as Node).sort(), [...DEFER_RESPONSE_FIELDS].sort());
  });

  it('모두 반드시 있어야 한다', () => {
    assert.deepEqual([...(branch().required as string[])].sort(), [...DEFER_RESPONSE_FIELDS].sort());
  });

  it('다른 항목을 받지 않는다', () => {
    assert.equal(branch().additionalProperties, false);
  });

  it('가려내는 값이 계약의 낱말이다', () => {
    const decision = (branch().properties as Node).decision as Node;
    assert.deepEqual(decision.enum, [DEFER]);
  });

  it('보류 이유가 계약의 목록 그대로다', () => {
    const reason = (branch().properties as Node).reason as Node;
    assert.deepEqual(reason.enum, [...GENERATION_DEFER_REASONS]);
    assert.equal(reason.type, 'string');
  });

  it('초안이 들어갈 자리가 없다', () => {
    assert.equal('draft' in (branch().properties as Node), false);
  });

  it('두 갈래의 가려내는 값이 겹치지 않는다', () => {
    const values = branches().map((b) => (((b.properties as Node).decision as Node).enum as string[])[0]);
    assert.equal(new Set(values).size, 2);
    assert.deepEqual([...values].sort(), [...GENERATION_DECISIONS].sort());
  });
});

/* ================================================================== */
/* E. 초안의 모양                                                       */
/* ================================================================== */

describe('답의 모양 · E. 초안', () => {
  const [GENERATE] = GENERATION_DECISIONS;
  const draftNode = () => (branchByDecision(GENERATE as string).properties as Node).draft as Node;

  it('항목이 계약과 정확히 같다', () => {
    assert.deepEqual(Object.keys(draftNode().properties as Node).sort(), [...MODEL_DRAFT_FIELDS].sort());
  });

  it('빠진 항목도 더 붙은 항목도 없다', () => {
    const inSchema = new Set(Object.keys(draftNode().properties as Node));
    const inContract = new Set<string>(MODEL_DRAFT_FIELDS);

    assert.deepEqual([...inContract].filter((f) => !inSchema.has(f)), []);
    assert.deepEqual([...inSchema].filter((f) => !inContract.has(f)), []);
  });

  it('다른 길로 세어도 같은 항목이 나온다', () => {
    // 위의 비교는 양쪽이 같은 목록을 보므로, 그 목록이 바뀌면 함께 바뀐다.
    // 그래서 다른 곳에서 온 것으로 한 번 더 맞춰 본다.
    //
    // 모델이 쓰는 열 항목은 글의 계약에서 온다(태그 다섯, 산문 넷, 오용 방지 하나).
    // 거기에 몇 번째를 고르는 값 하나를 더하면 열하나가 된다.
    const fromContentContract = [
      ...CANDIDATE_TAG_FIELDS,
      ...CANDIDATE_PROSE_FIELDS,
      'misuseGuards',
      'selectedPassageIndex',
    ];

    assert.equal(fromContentContract.length, 11);
    assert.deepEqual(
      Object.keys(draftNode().properties as Node).sort(),
      [...fromContentContract].sort(),
    );
  });

  it('모두 반드시 있어야 하고 다른 것을 받지 않는다', () => {
    assert.deepEqual([...(draftNode().required as string[])].sort(), [...MODEL_DRAFT_FIELDS].sort());
    assert.equal(draftNode().additionalProperties, false);
  });

  it('태그는 글자 목록이다', () => {
    for (const field of CANDIDATE_TAG_FIELDS) {
      const node = (draftNode().properties as Node)[field] as Node;
      assert.equal(node.type, 'array', field);
      assert.equal((node.items as Node).type, 'string', field);
    }
  });

  it('산문은 글자다', () => {
    for (const field of CANDIDATE_PROSE_FIELDS) {
      const node = (draftNode().properties as Node)[field] as Node;
      assert.equal(node.type, 'string', field);
    }
  });

  it('오용을 막는 문구는 글자 목록이다', () => {
    const node = (draftNode().properties as Node).misuseGuards as Node;
    assert.equal(node.type, 'array');
    assert.equal((node.items as Node).type, 'string');
  });

  it('고른 번호는 정수다', () => {
    const node = (draftNode().properties as Node).selectedPassageIndex as Node;
    assert.equal(node.type, 'integer');
  });

  it('종류를 정하지 않은 항목이 없다', () => {
    for (const [field, node] of Object.entries(draftNode().properties as Node)) {
      assert.ok('type' in (node as Node), field);
    }
  });
});

/* ================================================================== */
/* F. 태그를 가두지 않는다                                              */
/* ================================================================== */

describe('답의 모양 · F. 태그', () => {
  const [GENERATE] = GENERATION_DECISIONS;

  it('태그에 낱말 목록을 붙이지 않는다', () => {
    // 지금 있는 카드에서 모은 사전으로 가두면 새 영역의 글이 새 말을 못 쓴다.
    const draftNode = (branchByDecision(GENERATE as string).properties as Node).draft as Node;

    for (const field of CANDIDATE_TAG_FIELDS) {
      const node = (draftNode.properties as Node)[field] as Node;
      assert.equal('enum' in node, false, field);
      assert.equal('enum' in (node.items as Node), false, field);
    }
  });

  it('상황 분석기의 사전을 가져오지 않는다', () => {
    for (const banned of ['analysis-taxonomy', 'SITUATION_TAGS', 'EMOTION_TAGS', 'TAXONOMY', 'isKnownTag']) {
      assert.equal(SCHEMA_SOURCE.includes(banned), false, banned);
    }
  });

  it('낱말 목록은 가려내는 값과 보류 이유에만 있다', () => {
    let enums = 0;
    walk(schema, (node) => {
      if ('enum' in node) enums += 1;
    });
    // 쓸 수 있을 때의 decision, 못 쓰겠을 때의 decision, 그리고 reason.
    assert.equal(enums, 3);
  });
});

/* ================================================================== */
/* G. 씌운 한 겹                                                        */
/* ================================================================== */

describe('답의 모양 · G. 한 겹', () => {
  it('한 겹의 이름이 정해져 있다', () => {
    assert.equal(ENVELOPE, 'response');
  });

  it('왜 씌웠는지 적어 두었다', () => {
    assert.equal(PROVIDER_ENVELOPE_NOTE.providerEnvelopeRequired, true);
    assert.ok(PROVIDER_ENVELOPE_NOTE.reason.includes('맨 바깥이 객체'));
  });

  it('우리 계약의 항목이 아니다', () => {
    assert.equal(PROVIDER_ENVELOPE_NOTE.belongsToApplicationContract, false);
    assert.equal(PROVIDER_ENVELOPE_NOTE.applicationResponseChanged, false);
  });

  it('우리 쪽 어느 계약에도 새어 들어가지 않았다', () => {
    // 이 이름이 글이나 대답의 항목이 되면 계약이 조용히 바뀐 것이다.
    assert.equal((CANDIDATE_FIELDS as readonly string[]).includes(ENVELOPE), false);
    assert.equal((MODEL_DRAFT_FIELDS as readonly string[]).includes(ENVELOPE), false);
    assert.equal((GENERATE_RESPONSE_FIELDS as readonly string[]).includes(ENVELOPE), false);
    assert.equal((DEFER_RESPONSE_FIELDS as readonly string[]).includes(ENVELOPE), false);
  });

  it('받은 뒤 한 겹을 벗기고 검사기에 넘긴다는 것을 적어 두었다', () => {
    assert.equal(PROVIDER_ENVELOPE_NOTE.adapterMustUnwrapBeforeValidating, true);
  });
});

/* ================================================================== */
/* H. 모양이 맞다고 뜻이 맞는 것은 아니다                               */
/* ================================================================== */

describe('답의 모양 · H. 최종 판단', () => {
  it('한 겹을 벗기면 쓸 수 있는 대답이 통과한다', () => {
    const envelope = { [ENVELOPE]: { decision: 'generate', draft: draft() } };
    const checked = validateCandidateModelGenerationResponse(envelope[ENVELOPE], INPUT);

    assert.deepEqual(checked.errors, []);
    assert.equal(checked.valid, true);
  });

  it('한 겹을 벗기면 못 쓰겠다는 대답도 통과한다', () => {
    const envelope = { [ENVELOPE]: { decision: 'defer', reason: 'needs_more_research' } };
    const checked = validateCandidateModelGenerationResponse(envelope[ENVELOPE], INPUT);

    assert.deepEqual(checked.errors, []);
    assert.equal(checked.valid, true);
  });

  it('한 겹을 씌운 채로는 검사기가 받지 않는다', () => {
    // 어댑터가 반드시 벗겨야 한다는 뜻이다.
    const envelope = { [ENVELOPE]: { decision: 'defer', reason: 'needs_more_research' } };
    assert.equal(validateCandidateModelGenerationResponse(envelope, INPUT).valid, false);
  });

  it('모양은 맞는데 뜻이 어긋나는 대답은 검사기가 막는다', () => {
    // 본문 후보가 하나뿐이므로 5번은 없는 번호다.
    // 모양만 보면 정수라 통과하지만 검사기가 막는다.
    const response = { decision: 'generate', draft: draft({ selectedPassageIndex: 5 }) };

    assert.equal(typeof response.draft.selectedPassageIndex, 'number');
    assert.equal(validateCandidateModelGenerationResponse(response, INPUT).valid, false);
  });

  it('모양은 얇게 두고 판단은 검사기에 남긴다', () => {
    assert.equal(SCHEMA_IS_STRUCTURAL_ONLY.classification, 'provider_enforcement_mirror');
    assert.equal(SCHEMA_IS_STRUCTURAL_ONLY.replacesApplicationValidator, false);
    assert.equal(SCHEMA_IS_STRUCTURAL_ONLY.enforcesLengthBounds, false);
    assert.equal(SCHEMA_IS_STRUCTURAL_ONLY.enforcesSelectedPassageRange, false);
    assert.equal(SCHEMA_IS_STRUCTURAL_ONLY.enforcesTagVocabulary, false);
    assert.equal(
      SCHEMA_IS_STRUCTURAL_ONLY.semanticAuthority,
      'validateCandidateModelGenerationResponse',
    );
  });

  it('길이 제한을 여기로 옮겨 오지 않았다', () => {
    walk(schema, (node) => {
      for (const keyword of ['maxLength', 'minLength', 'maxItems', 'minItems', 'minimum', 'maximum']) {
        assert.equal(keyword in node, false, keyword);
      }
    });
  });
});

/* ================================================================== */
/* I. 규칙의 주인이 아니다                                              */
/* ================================================================== */

describe('답의 모양 · I. 권위', () => {
  it('항목 이름을 여기 손으로 적지 않았다', () => {
    for (const field of MODEL_DRAFT_FIELDS) {
      if (field === 'misuseGuards') continue; // 종류를 가르는 데 한 번 쓴다.
      assert.equal(SCHEMA_SOURCE.includes(`'${field}'`), false, field);
    }
  });

  it('결정 종류와 보류 이유를 여기서 다시 정하지 않았다', () => {
    for (const value of [...GENERATION_DECISIONS, ...GENERATION_DEFER_REASONS]) {
      assert.equal(SCHEMA_SOURCE.includes(`'${value}'`), false, value);
    }
  });

  it('모양의 이름과 엄격함은 다른 곳이 주인이다', () => {
    assert.equal(SCHEMA_SOURCE.includes('aroeda_candidate_generation_v1'), false);
    assert.equal(SCHEMA_SOURCE.includes('json_schema'), false);
    assert.equal(SCHEMA_SOURCE.includes('strict'), false);

    // 그 주인은 부르는 방식을 정한 곳이다.
    assert.equal(CANDIDATE_GENERATION_RUNTIME_CONFIG.structuredOutput.schemaName, 'aroeda_candidate_generation_v1');
    assert.equal(CANDIDATE_GENERATION_RUNTIME_CONFIG.structuredOutput.strict, true);
  });

  it('계약에서 가져다 쓴다', () => {
    for (const name of [
      'MODEL_DRAFT_FIELDS',
      'GENERATE_RESPONSE_FIELDS',
      'DEFER_RESPONSE_FIELDS',
      'GENERATION_DECISIONS',
      'GENERATION_DEFER_REASONS',
      'CANDIDATE_TAG_FIELDS',
      'CANDIDATE_PROSE_FIELDS',
    ]) {
      assert.ok(SCHEMA_SOURCE.includes(name), name);
    }
  });

  it('가져오는 곳이 모두 같은 저장소의 계약이다', () => {
    const specifiers = [...SCHEMA_SOURCE.matchAll(/from '([^']+)'/g)].map((m) => m[1] as string);
    assert.ok(specifiers.length > 0);
    for (const path of specifiers) {
      assert.ok(path.startsWith('./'), path);
    }
  });
});

/* ================================================================== */
/* J. 이 파일이 하지 않는 일                                            */
/* ================================================================== */

describe('답의 모양 · J. 경계', () => {
  it('모델을 부르지 않는다', () => {
    for (const banned of [
      'import OpenAI',
      'new OpenAI',
      'responses.create',
      'responses.parse',
      'chat.completions',
      'openai/helpers',
      'zodTextFormat',
      'zodResponseFormat',
      'api.openai.com',
      'Authorization',
    ]) {
      assert.equal(SCHEMA_SOURCE.includes(banned), false, banned);
    }
  });

  it('열쇠도 바깥도 표도 없다', () => {
    for (const banned of [
      'OPENAI_API_KEY',
      'apiKey',
      'fetch(',
      'Deno.env',
      'process.env',
      'createClient',
      'supabase',
      'service_role',
    ]) {
      assert.equal(SCHEMA_SOURCE.includes(banned), false, banned);
    }
  });

  it('부를 때마다 같은 모양이다', () => {
    for (const banned of ['Date.now', 'Math.random', 'randomUUID', 'new Date(']) {
      assert.equal(SCHEMA_SOURCE.includes(banned), false, banned);
    }
    assert.deepEqual(
      JSON.parse(JSON.stringify(CANDIDATE_GENERATION_STRUCTURED_OUTPUT_SCHEMA)),
      JSON.parse(JSON.stringify(CANDIDATE_GENERATION_STRUCTURED_OUTPUT_SCHEMA)),
    );
  });
});
