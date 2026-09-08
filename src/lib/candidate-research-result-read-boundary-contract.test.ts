/**
 * 연구 결과 지문 읽기 경계 · 계약 테스트
 *
 * 실행: npm test
 *
 * 이 계약은 아직 아무것도 부르지 않는다. SQL도 DB도 없다.
 * 그래서 시험할 수 있는 것은 두 가지다.
 *
 *   하나. 순수 검사기가 실제로 그렇게 도는가.
 *   둘. 앞으로 만들 migration이 따라야 할 값이 계약에 적혀 있는가.
 *
 * 마지막 한 묶음(O)은 조금 다르다.
 * 읽어 온 값을 실제 orchestration 계약의 lineage 확인에 통과시켜서
 * "표에서 읽었더라도 지문 확인은 여전히 살아 있다"를 실행으로 증명한다.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import {
  AUTHORITATIVE_MEANING,
  AUTH_LAYER_SEPARATION,
  FORBIDDEN_FAILURE_RESULT_CONTENT,
  FORBIDDEN_READ_REQUEST_FIELDS,
  FORBIDDEN_READ_RETURN_FIELDS,
  FUTURE_READ_RPC_AUTHORIZATION,
  FUTURE_READ_RPC_SQL_INVARIANTS,
  GET_RESEARCH_RESULT_FOR_CANDIDATE_GENERATION_RPC,
  NO_ENUMERATION_INVARIANT,
  POST_READ_VERIFICATION,
  PRODUCTION_ACQUISITION,
  PROVIDER_COST_GATE,
  READ_BOUNDARY_DOES_NOT_INCLUDE,
  READ_BOUNDARY_HASH_FORMAT,
  READ_FAILURE_REASONS,
  READ_REQUEST_FIELDS,
  READ_RESULT_COLUMN,
  READ_RETURN_FIELDS,
  SQL_HASH_FORMAT_RULE,
  STRICT_REQUEST_SHAPE,
  buildOrchestrationInputFromRead,
  canProceedToProviderAfterRead,
  validateResearchResultReadRequest,
  type ResearchResultReadOutcome,
} from '../../supabase/functions/_shared/candidate-research-result-read-boundary-contract.ts';
import {
  RESEARCH_RESULT_HASH_FORMAT,
  computeResearchResultHash,
} from '../../supabase/functions/_shared/research-result-store-contract.ts';
import {
  verifyCandidateGenerationLineage,
} from '../../supabase/functions/_shared/published-content-candidate-generation-orchestration-contract.ts';
import { FORBIDDEN_MODEL_INPUT_FIELDS } from '../../supabase/functions/_shared/published-content-candidate-generation-contract.ts';

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
const stripComments = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '');

const CONTRACT = '../../supabase/functions/_shared/candidate-research-result-read-boundary-contract.ts';

/* ------------------------------------------------------------------ */
/* fixtures                                                            */
/* ------------------------------------------------------------------ */

const validResearchResult = () => ({
  targetDomain: 'financial_hardship',
  evidenceVersion: 4,
  prioritizerSnapshotId: `snap_${'b'.repeat(64)}`,
  researchQuestion: '성경은 이 삶의 문제를 어떤 본문에서 직접 다루는가?',
  domainBoundaries: { includedConcerns: ['생계 압박'], excludedOrAdjacentConcerns: [] },
  candidatePassages: [
    {
      reference: { book: 'Psalms', chapter: 56, startVerse: 3, endVerse: 4 },
      additionalReferences: [],
      canonicalContext: '이 본문이 놓인 원래 흐름에 대한 연구 메모입니다.',
      theologicalContribution: '이 본문이 이 영역에 주는 신학적 기여에 대한 메모입니다.',
      domainFit: '이 삶의 문제를 직접 다루기 때문입니다.',
      pastoralUse: ['위로'],
      misuseRisks: ['결과 보장으로 사용하지 않는다.'],
      distinctnessFromActiveCoverage: { distinct: true, nearestExistingDomain: 'x', explanation: 'y' },
      researchConfidence: 0.6,
      sourceSupport: {
        exegesisEvidenceIds: [],
        theologyEvidenceIds: [],
        pastoralEvidenceIds: [],
        safetyEvidenceIds: [],
        exegesisSourceIds: [],
        theologySourceIds: [],
        pastoralSourceIds: [],
        safetySourceIds: [],
      },
    },
  ],
  rejectedPassages: [],
  unresolvedQuestions: [],
  evidenceSetHash: `evset_${'c'.repeat(64)}`,
});

const WELL_FORMED_HASH = `rres_${'a'.repeat(64)}`;

/* ================================================================== */
/* A. 받는 것은 지문 하나뿐                                             */
/* ================================================================== */

describe('읽기 경계 · A. 받는 것', () => {
  it('받는 항목은 researchResultHash 하나뿐이다', () => {
    assert.deepEqual([...READ_REQUEST_FIELDS], ['researchResultHash']);
  });

  it('모양이 맞는 지문 하나를 받아들인다', () => {
    const outcome = validateResearchResultReadRequest({ researchResultHash: WELL_FORMED_HASH });
    assert.equal(outcome.ok, true);
    if (!outcome.ok) return;
    assert.deepEqual(outcome.request, { researchResultHash: WELL_FORMED_HASH });
  });

  it('받아들인 요청에는 지문 말고 아무것도 붙지 않는다', () => {
    const outcome = validateResearchResultReadRequest({ researchResultHash: WELL_FORMED_HASH });
    assert.equal(outcome.ok, true);
    if (!outcome.ok) return;
    assert.deepEqual(Object.keys(outcome.request), ['researchResultHash']);
  });

  it('요청의 모양이 정확히 하나로 못 박혀 있다', () => {
    assert.equal(STRICT_REQUEST_SHAPE.exactKeysOnly, true);
    assert.equal(STRICT_REQUEST_SHAPE.silentStrip, false);
    assert.equal(STRICT_REQUEST_SHAPE.acceptedKeyAuthority, 'READ_REQUEST_FIELDS');
  });
});

/* ================================================================== */
/* A2. 지문 말고 다른 것이 오면 거절한다                                 */
/* ================================================================== */

describe('읽기 경계 · A2. 덤으로 온 항목', () => {
  it('연구 결과를 함께 보내면 거절한다 — 버리고 통과시키지 않는다', () => {
    const outcome = validateResearchResultReadRequest({
      researchResultHash: WELL_FORMED_HASH,
      researchResult: validResearchResult(),
    });
    assert.equal(outcome.ok, false);
    if (outcome.ok) return;
    assert.equal(outcome.reason, 'unknown_field');
  });

  it('금지 목록에 있는 이름을 함께 보내면 거절한다', () => {
    for (const field of FORBIDDEN_READ_REQUEST_FIELDS) {
      const outcome = validateResearchResultReadRequest({
        researchResultHash: WELL_FORMED_HASH,
        [field]: 'anything',
      });
      assert.equal(outcome.ok, false, field);
      if (outcome.ok) return;
      assert.equal(outcome.reason, 'unknown_field', field);
    }
  });

  it('금지 목록에 없는 처음 보는 이름도 똑같이 거절한다', () => {
    for (const field of ['anythingElse', 'debug', 'x', '__proto__x', 'RESEARCHRESULTHASH']) {
      const outcome = validateResearchResultReadRequest({
        researchResultHash: WELL_FORMED_HASH,
        [field]: 1,
      });
      assert.equal(outcome.ok, false, field);
      if (outcome.ok) return;
      assert.equal(outcome.reason, 'unknown_field', field);
    }
  });

  it('덤이 여러 개여도 거절한다', () => {
    const outcome = validateResearchResultReadRequest({
      researchResultHash: WELL_FORMED_HASH,
      researchResult: validResearchResult(),
      limit: 50,
      offset: 0,
      whatever: true,
    });
    assert.equal(outcome.ok, false);
    if (outcome.ok) return;
    assert.equal(outcome.reason, 'unknown_field');
  });

  it('거절은 지문 모양을 보기 전에 일어난다', () => {
    // 지문도 틀리고 덤도 있으면, 먼저 보는 쪽(요청 모양)이 답이 된다.
    const outcome = validateResearchResultReadRequest({
      researchResultHash: 'not-a-hash',
      researchResult: validResearchResult(),
    });
    assert.equal(outcome.ok, false);
    if (outcome.ok) return;
    assert.equal(outcome.reason, 'unknown_field');
  });

  it('거절되면 모델을 부르지 않는다', () => {
    const outcome: ResearchResultReadOutcome = { ok: false, reason: 'unknown_field' };
    assert.equal(canProceedToProviderAfterRead(outcome), false);
  });

  it('거절되면 orchestrator에게 넘길 것이 없다', () => {
    const outcome: ResearchResultReadOutcome = { ok: false, reason: 'unknown_field' };
    assert.equal(buildOrchestrationInputFromRead(outcome), null);
  });

  it('막는 기준은 받기로 한 이름 하나다', () => {
    // 금지 목록이 막는 것이 아니다. 금지 목록에 없는 이름도 막힌다는 것을 위에서 보였다.
    assert.equal(STRICT_REQUEST_SHAPE.forbiddenListIsDocumentationOnly, true);
    assert.equal(STRICT_REQUEST_SHAPE.extraKeyFailureReason, 'unknown_field');
  });
});

/* ================================================================== */
/* B. 연구 결과 전체를 받지 않는다                                       */
/* ================================================================== */

describe('읽기 경계 · B. 부르는 쪽이 보낸 연구 결과', () => {
  it('금지 입력 목록에 researchResult가 있다', () => {
    assert.ok(FORBIDDEN_READ_REQUEST_FIELDS.includes('researchResult'));
  });

  it('여러 건을 훑는 데 쓰이는 입력이 전부 금지 목록에 있다', () => {
    for (const field of ['filter', 'limit', 'offset', 'sort', 'hashes']) {
      assert.ok(FORBIDDEN_READ_REQUEST_FIELDS.includes(field as never), field);
    }
  });

  it('연구 결과 안의 값을 밖에서 따로 받지 않는다', () => {
    for (const field of ['targetDomain', 'researchQuestion', 'candidatePassages', 'provenance']) {
      assert.ok(FORBIDDEN_READ_REQUEST_FIELDS.includes(field as never), field);
    }
  });

  it('받는 항목과 금지 항목이 겹치지 않는다', () => {
    for (const field of READ_REQUEST_FIELDS) {
      assert.equal(FORBIDDEN_READ_REQUEST_FIELDS.includes(field as never), false, field);
    }
  });
});

/* ================================================================== */
/* C. 지문 모양의 주인                                                  */
/* ================================================================== */

describe('읽기 경계 · C. 지문 모양', () => {
  it('연구 보관소 계약의 정규식을 그대로 가리킨다', () => {
    assert.equal(READ_BOUNDARY_HASH_FORMAT, RESEARCH_RESULT_HASH_FORMAT);
  });

  it('정규식을 새로 적지 않았다', () => {
    const code = stripComments(read(CONTRACT));
    assert.equal(code.includes('rres_'), false);
    assert.equal(code.includes('[0-9a-f]{64}'), false);
  });

  it('SQL 쪽 검사는 사본이지 주인이 아니라고 못 박았다', () => {
    assert.equal(SQL_HASH_FORMAT_RULE.classification, 'SECURITY_CRITICAL_ENFORCEMENT_MIRROR');
    assert.equal(SQL_HASH_FORMAT_RULE.sqlSideIsCopyNotOwner, true);
    assert.equal(SQL_HASH_FORMAT_RULE.driftTestRequiredAtMigration, true);
  });
});

/* ================================================================== */
/* D. 정확히 한 건                                                      */
/* ================================================================== */

describe('읽기 경계 · D. 찾는 방식', () => {
  it('정확히 같은 지문으로만 찾는다', () => {
    assert.equal(FUTURE_READ_RPC_SQL_INVARIANTS.exactEqualityOnly, true);
    assert.equal(FUTURE_READ_RPC_SQL_INVARIANTS.lookupPredicate, 'result_hash = <parameter>');
  });

  it('최대 한 줄이다', () => {
    assert.equal(FUTURE_READ_RPC_SQL_INVARIANTS.maximumRows, 1);
  });

  it('표 이름을 온전히 적는다', () => {
    assert.equal(FUTURE_READ_RPC_SQL_INVARIANTS.fullyQualifiedTableReference, 'private.research_result');
  });

  it('부르는 쪽이 이름을 정하는 SQL을 만들지 않는다', () => {
    assert.equal(FUTURE_READ_RPC_SQL_INVARIANTS.dynamicSql, false);
    assert.equal(FUTURE_READ_RPC_SQL_INVARIANTS.callerControlledIdentifier, false);
  });
});

/* ================================================================== */
/* E. 훑을 수 없다                                                      */
/* ================================================================== */

describe('읽기 경계 · E. 둘러보기 금지', () => {
  it('지문 하나로 정확히 찾는 것만 허용한다', () => {
    assert.equal(NO_ENUMERATION_INVARIANT.exactHashLookupOnly, true);
  });

  it('훑는 방법이 전부 막혀 있다', () => {
    const banned = [
      'listAll',
      'latest',
      'offset',
      'limit',
      'domainFilter',
      'dateFilter',
      'prefixMatch',
      'containsMatch',
      'likeMatch',
      'ilikeMatch',
      'arrayLookup',
      'countQuery',
    ] as const;

    for (const key of banned) {
      assert.equal(NO_ENUMERATION_INVARIANT[key], false, key);
    }
  });

  it('훑는 일이 하지 않는 일 목록에 적혀 있다', () => {
    for (const item of ['목록 보기', '검색', '앞자리만 맞는 지문으로 찾기', '여러 지문을 한 번에 찾기']) {
      assert.ok(READ_BOUNDARY_DOES_NOT_INCLUDE.includes(item as never), item);
    }
  });
});

/* ================================================================== */
/* F/G/H/I. 권한                                                        */
/* ================================================================== */

describe('읽기 경계 · F. 서버만 부른다', () => {
  it('service_role만 실행할 수 있다', () => {
    assert.equal(FUTURE_READ_RPC_AUTHORIZATION.serviceRoleExecute, true);
    assert.equal(FUTURE_READ_RPC_SQL_INVARIANTS.grantExecuteTo, 'service_role');
  });
});

describe('읽기 경계 · G. 나머지는 부를 수 없다', () => {
  it('로그인한 사람도, 익명도, 아무나도 부를 수 없다', () => {
    assert.equal(FUTURE_READ_RPC_AUTHORIZATION.authenticatedExecute, false);
    assert.equal(FUTURE_READ_RPC_AUTHORIZATION.anonExecute, false);
    assert.equal(FUTURE_READ_RPC_AUTHORIZATION.publicExecute, false);
  });

  it('회수 문장이 계약에 적혀 있다', () => {
    assert.equal(FUTURE_READ_RPC_SQL_INVARIANTS.revokeFromPublic, true);
    assert.equal(FUTURE_READ_RPC_SQL_INVARIANTS.revokeFromAnonAuthenticatedServiceRole, true);
  });
});

describe('읽기 경계 · H. 표를 직접 열지 않는다', () => {
  it('표를 직접 읽는 권한을 주지 않는다', () => {
    assert.equal(FUTURE_READ_RPC_AUTHORIZATION.directTableSelectGrant, false);
    assert.equal(FUTURE_READ_RPC_SQL_INVARIANTS.tablePrivilegeGrant, false);
  });

  it('private 스키마의 권한을 완화하지 않는다', () => {
    assert.equal(FUTURE_READ_RPC_AUTHORIZATION.privateSchemaPrivilegeRelaxed, false);
  });
});

describe('읽기 경계 · I. SECURITY DEFINER', () => {
  it('남의 권한을 빌리는 함수여야 한다', () => {
    assert.equal(FUTURE_READ_RPC_SQL_INVARIANTS.securityDefiner, true);
  });

  it('search_path를 못 박았다', () => {
    assert.equal(FUTURE_READ_RPC_SQL_INVARIANTS.searchPath, 'private, pg_catalog');
  });

  it('읽기만 하는 함수라고 표시한다', () => {
    assert.equal(FUTURE_READ_RPC_SQL_INVARIANTS.volatility, 'stable');
  });

  it('같은 이름의 함수를 덮어쓰지 못하게 한다', () => {
    assert.equal(FUTURE_READ_RPC_SQL_INVARIANTS.createOrReplaceForbidden, true);
  });
});

/* ================================================================== */
/* J. 고치지 않는다                                                     */
/* ================================================================== */

describe('읽기 경계 · J. 고치기 금지', () => {
  it('적고 고치고 지우는 일이 전부 금지다', () => {
    assert.equal(FUTURE_READ_RPC_SQL_INVARIANTS.insertAllowed, false);
    assert.equal(FUTURE_READ_RPC_SQL_INVARIANTS.updateAllowed, false);
    assert.equal(FUTURE_READ_RPC_SQL_INVARIANTS.deleteAllowed, false);
  });

  it('곁다리 효과가 없다', () => {
    assert.equal(FUTURE_READ_RPC_SQL_INVARIANTS.sideEffects, false);
  });

  it('만들기·고치기·지우기가 하지 않는 일 목록에 있다', () => {
    for (const item of ['연구 결과를 만드는 일', '연구 결과를 고치는 일', '연구 결과를 지우는 일']) {
      assert.ok(READ_BOUNDARY_DOES_NOT_INCLUDE.includes(item as never), item);
    }
  });
});

/* ================================================================== */
/* K. 돌려주는 것                                                       */
/* ================================================================== */

describe('읽기 경계 · K. 돌려주는 것', () => {
  it('표의 result 칸 하나만 읽는다', () => {
    assert.equal(READ_RESULT_COLUMN, 'result');
    assert.deepEqual([...READ_RETURN_FIELDS], ['researchResult']);
  });

  it('줄 번호와 시각과 근거 기록을 돌려주지 않는다', () => {
    for (const field of ['research_result_id', 'researchResultId', 'created_at', 'createdAt', 'provenance']) {
      assert.ok(FORBIDDEN_READ_RETURN_FIELDS.includes(field as never), field);
    }
  });

  it('근거 기록을 뺀 것은 짐작이 아니라 기존 계약을 따른 것이다', () => {
    // Candidate Generation 계약이 provenance를 모델에게 보이면 안 된다고 이미 못 박았다.
    assert.ok(FORBIDDEN_MODEL_INPUT_FIELDS.includes('provenance' as never));
    assert.ok(FORBIDDEN_READ_RETURN_FIELDS.includes('provenance'));
  });

  it('값이 돌아왔다는 것의 뜻이 적혀 있다', () => {
    assert.ok(AUTHORITATIVE_MEANING.includes('실제로 있다'));
  });

  it('성공 결과에는 지문과 연구 결과만 있다', () => {
    const outcome: ResearchResultReadOutcome = {
      ok: true,
      researchResultHash: WELL_FORMED_HASH,
      researchResult: validResearchResult() as never,
    };
    assert.deepEqual(Object.keys(outcome).sort(), ['ok', 'researchResult', 'researchResultHash']);
  });
});

/* ================================================================== */
/* L. 없을 때                                                           */
/* ================================================================== */

describe('읽기 경계 · L. 그런 연구가 없을 때', () => {
  it('모델을 부르지 않는다', () => {
    const outcome: ResearchResultReadOutcome = { ok: false, reason: 'not_found' };
    assert.equal(canProceedToProviderAfterRead(outcome), false);
  });

  it('orchestrator에게 넘길 것이 없다', () => {
    const outcome: ResearchResultReadOutcome = { ok: false, reason: 'not_found' };
    assert.equal(buildOrchestrationInputFromRead(outcome), null);
  });

  it('읽어 오지 못한 경우도 마찬가지다', () => {
    const outcome: ResearchResultReadOutcome = { ok: false, reason: 'read_unavailable' };
    assert.equal(canProceedToProviderAfterRead(outcome), false);
    assert.equal(buildOrchestrationInputFromRead(outcome), null);
  });

  it('실패 결과에 연구 내용이나 DB 사정을 담지 않는다', () => {
    for (const field of ['researchResult', 'provenance', 'sqlState', 'sqlMessage', 'serviceRoleKey', 'operatorToken']) {
      assert.ok(FORBIDDEN_FAILURE_RESULT_CONTENT.includes(field as never), field);
    }
  });

  it('실패 결과에는 까닭 하나만 있다', () => {
    const outcome: ResearchResultReadOutcome = { ok: false, reason: 'not_found' };
    assert.deepEqual(Object.keys(outcome).sort(), ['ok', 'reason']);
  });
});

/* ================================================================== */
/* M. 지문 모양이 틀렸을 때                                             */
/* ================================================================== */

describe('읽기 경계 · M. 모양이 틀린 지문', () => {
  it('DB에 가기 전에 막힌다', () => {
    for (const bad of [
      'rres_short',
      `rres_${'A'.repeat(64)}`,
      `evset_${'a'.repeat(64)}`,
      `pcand_${'a'.repeat(64)}`,
      '',
      `rres_${'a'.repeat(63)}`,
      `rres_${'a'.repeat(65)}`,
    ]) {
      const outcome = validateResearchResultReadRequest({ researchResultHash: bad });
      assert.equal(outcome.ok, false, bad);
      if (outcome.ok) return;
      assert.equal(outcome.reason, 'hash_format_invalid');
    }
  });

  it('지문이 문자열이 아니거나 아예 없어도 같은 답이다', () => {
    for (const bad of [{}, { researchResultHash: 42 }, { researchResultHash: null }, null, 'string', []]) {
      const outcome = validateResearchResultReadRequest(bad);
      assert.equal(outcome.ok, false);
      if (outcome.ok) return;
      assert.equal(outcome.reason, 'hash_format_invalid');
    }
  });

  it('모양이 틀리면 모델을 부르지 않는다', () => {
    const outcome: ResearchResultReadOutcome = { ok: false, reason: 'hash_format_invalid' };
    assert.equal(canProceedToProviderAfterRead(outcome), false);
    assert.equal(buildOrchestrationInputFromRead(outcome), null);
  });

  it('까닭은 넷뿐이다', () => {
    assert.deepEqual(
      [...READ_FAILURE_REASONS],
      ['unknown_field', 'hash_format_invalid', 'not_found', 'read_unavailable'],
    );
  });
});

/* ================================================================== */
/* N. 읽은 것을 orchestrator에게 넘긴다                                 */
/* ================================================================== */

describe('읽기 경계 · N. orchestrator로 잇기', () => {
  it('성공하면 기존 orchestrator 입력 모양 그대로 나온다', async () => {
    const researchResult = validResearchResult();
    const hash = await computeResearchResultHash(researchResult as never);

    const outcome: ResearchResultReadOutcome = {
      ok: true,
      researchResultHash: hash,
      researchResult: researchResult as never,
    };

    const input = buildOrchestrationInputFromRead(outcome);
    assert.notEqual(input, null);
    if (input === null) return;

    assert.deepEqual(Object.keys(input).sort(), ['researchResult', 'researchResultHash']);
    assert.equal(input.researchResultHash, hash);
    assert.deepEqual(input.researchResult, researchResult);
  });

  it('성공하면 모델을 불러도 된다', async () => {
    const researchResult = validResearchResult();
    const hash = await computeResearchResultHash(researchResult as never);

    assert.equal(
      canProceedToProviderAfterRead({
        ok: true,
        researchResultHash: hash,
        researchResult: researchResult as never,
      }),
      true,
    );
  });

  it('넘길 때 지문을 다시 계산하지 않는다', () => {
    const code = stripComments(read(CONTRACT));
    assert.equal(code.includes('computeResearchResultHash'), false);
  });
});

/* ================================================================== */
/* O. 읽은 뒤에도 지문 확인은 살아 있다                                  */
/* ================================================================== */

describe('읽기 경계 · O. 읽은 다음에도 확인한다', () => {
  it('읽어 온 값이 실제 lineage 확인을 그대로 통과한다', async () => {
    const researchResult = validResearchResult();
    const hash = await computeResearchResultHash(researchResult as never);

    const input = buildOrchestrationInputFromRead({
      ok: true,
      researchResultHash: hash,
      researchResult: researchResult as never,
    });
    assert.notEqual(input, null);
    if (input === null) return;

    // 계약을 흉내 내지 않는다. 실제 orchestration 계약의 확인 함수를 그대로 부른다.
    const lineage = await verifyCandidateGenerationLineage(input);
    assert.equal(lineage.ok, true);
  });

  it('읽어 온 값과 지문이 어긋나면 lineage가 잡아낸다', async () => {
    // 표에서 읽었다는 사실만으로 안심하지 않는다는 것을 실행으로 보인다.
    const researchResult = validResearchResult();
    const wrongHash = `rres_${'0'.repeat(64)}`;

    const input = buildOrchestrationInputFromRead({
      ok: true,
      researchResultHash: wrongHash,
      researchResult: researchResult as never,
    });
    assert.notEqual(input, null);
    if (input === null) return;

    const lineage = await verifyCandidateGenerationLineage(input);
    assert.equal(lineage.ok, false);
    if (lineage.ok) return;
    assert.equal(lineage.reason, 'hash_mismatch');
  });

  it('읽기가 지문 확인을 대신하지 않는다고 못 박았다', () => {
    assert.equal(POST_READ_VERIFICATION.canonicalLineageVerificationStillRequired, true);
    assert.equal(POST_READ_VERIFICATION.readReplacesLineage, false);
    assert.equal(POST_READ_VERIFICATION.readProves, 'stored_existence');
    assert.equal(POST_READ_VERIFICATION.lineageProves, 'payload_matches_supplied_hash');
  });

  it('lineage 확인의 주인은 여전히 orchestration 계약이다', () => {
    assert.ok(POST_READ_VERIFICATION.lineageAuthority.includes('verifyCandidateGenerationLineage'));
    const code = stripComments(read(CONTRACT));
    // 확인 로직을 여기서 다시 구현하지 않았다.
    assert.equal(code.includes('canonicalHash'), false);
  });
});

/* ================================================================== */
/* P. 운영에서 부르는 쪽의 payload는 권위가 아니다                       */
/* ================================================================== */

describe('읽기 경계 · P. 운영에서 무엇이 권위인가', () => {
  it('요청이 실어 나르는 것은 지문 하나다', () => {
    assert.deepEqual([...PRODUCTION_ACQUISITION.requestBusinessPayload], ['researchResultHash']);
  });

  it('부르는 쪽이 보낸 연구 결과는 권위가 아니다', () => {
    assert.equal(PRODUCTION_ACQUISITION.callerSuppliedResearchResultIsAuthority, false);
    assert.equal(PRODUCTION_ACQUISITION.acquisitionSource, 'authoritative_db_read');
  });

  it('운영자 인증과 보관 사실을 구분한다', () => {
    assert.equal(AUTH_LAYER_SEPARATION.operatorTokenProves, '누가 불렀는가');
    assert.equal(AUTH_LAYER_SEPARATION.operatorTokenDoesNotProve, '보낸 값이 보관소에 실제로 있는가');
    assert.ok(AUTH_LAYER_SEPARATION.storedExistenceProvenBy.includes('읽기 함수'));
  });
});

/* ================================================================== */
/* Q. 돈이 나가기 전에 막는다 / migration 필요                           */
/* ================================================================== */

describe('읽기 경계 · Q. 비용과 migration', () => {
  it('읽기가 성공하기 전에는 모델을 부르지 않는다', () => {
    assert.equal(PROVIDER_COST_GATE.readMustSucceedBeforeProvider, true);
    assert.equal(PROVIDER_COST_GATE.orchestratorInvokedBeforeReadSuccess, false);
  });

  it('어떤 실패에서도 모델 호출 횟수가 0이다', () => {
    assert.equal(PROVIDER_COST_GATE.providerAttemptsOnInvalidHash, 0);
    assert.equal(PROVIDER_COST_GATE.providerAttemptsOnNotFound, 0);
    assert.equal(PROVIDER_COST_GATE.providerAttemptsOnReadUnavailable, 0);
  });

  it('읽기가 실패하면 글을 만들지도 적지도 않는다', () => {
    assert.equal(PROVIDER_COST_GATE.candidateBuiltOnReadFailure, false);
    assert.equal(PROVIDER_COST_GATE.candidateStoredOnReadFailure, false);
  });

  it('Edge 통합에는 migration이 필요하다고 못 박았다', () => {
    assert.equal(PRODUCTION_ACQUISITION.migrationRequiredForEdgeIntegration, true);
  });

  it('앞으로 만들 함수의 이름이 정해져 있다', () => {
    assert.equal(
      GET_RESEARCH_RESULT_FOR_CANDIDATE_GENERATION_RPC,
      'get_biblical_research_result_for_candidate_generation',
    );
  });
});

/* ================================================================== */
/* R. 이 계약은 아무것도 부르지 않는다                                   */
/* ================================================================== */

describe('읽기 경계 · R. 부르지 않는다', () => {
  it('네트워크·DB·환경변수·Edge를 부르지 않는다', () => {
    const code = stripComments(read(CONTRACT));
    for (const banned of [
      'fetch(',
      'Deno.env',
      'Deno.serve',
      'createClient(',
      '.rpc(',
      'XMLHttpRequest',
      'console.',
    ]) {
      assert.equal(code.includes(banned), false, banned);
    }
  });

  it('SQL을 쓰지 않는다', () => {
    const code = stripComments(read(CONTRACT));
    for (const banned of ['select ', 'SELECT ', 'insert into', 'grant execute on', 'create function']) {
      assert.equal(code.includes(banned), false, banned);
    }
  });

  it('하지 않는 일이 계약에 적혀 있다', () => {
    const code = read(CONTRACT);
    assert.ok(code.includes('READ_BOUNDARY_CONTRACT_DOES_NOT_INCLUDE'));
  });
});

/* ================================================================== */
/* S. 기존 authority를 복제하지 않는다                                   */
/* ================================================================== */

describe('읽기 경계 · S. 새 authority를 만들지 않는다', () => {
  it('해시 알고리즘을 다시 구현하지 않는다', () => {
    const code = stripComments(read(CONTRACT));
    assert.equal(code.includes('SHA-256'), false);
    assert.equal(code.includes('digest('), false);
    assert.equal(code.includes('TextEncoder'), false);
  });

  it('연구 결과나 Candidate의 항목을 다시 나열하지 않는다', () => {
    const code = stripComments(read(CONTRACT));
    for (const banned of [
      'candidatePassages:',
      'situationTags',
      'emotionTags',
      'theologicalInsight',
      'userExplanation',
      'evidenceSetHash',
    ]) {
      assert.equal(code.includes(banned), false, banned);
    }
  });

  it('모델 이름·시간 제한·주소·HTTP 상태를 적지 않는다', () => {
    const code = stripComments(read(CONTRACT));
    for (const banned of ['gpt-', '60000', '90000', 'api.openai.com', '401', '403', '404', '500']) {
      assert.equal(code.includes(banned), false, banned);
    }
  });

  it('인증 토큰의 이름을 적지 않는다', () => {
    const code = stripComments(read(CONTRACT));
    for (const banned of ['x-internal-token', 'authorization', 'Bearer', 'OPENAI_API_KEY', 'SERVICE_ROLE_KEY']) {
      assert.equal(code.includes(banned), false, banned);
    }
  });

  it('기존 계약에서 가져다 쓴다', () => {
    const code = read(CONTRACT);
    for (const required of [
      'RESEARCH_RESULT_HASH_FORMAT',
      'BiblicalResearchResult',
      'CandidateGenerationOrchestrationInput',
    ]) {
      assert.ok(code.includes(required), required);
    }
  });
});
