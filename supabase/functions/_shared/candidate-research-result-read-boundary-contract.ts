/**
 * 연구 결과를 지문 하나로 꺼내 오는 길 · 계약
 *
 * 왜 이것이 필요한가
 *   Candidate Generator는 모델에게 보여줄 연구 결과가 필요하다.
 *   지금 local 계약은 "부르는 쪽이 이미 들고 있다"고 가정한다.
 *
 *   그 가정을 운영에 그대로 쓰면 한 가지가 무너진다.
 *
 *   부르는 쪽이 연구 결과를 통째로 보내면, 그 값이 정말 우리 Researcher가
 *   만들어 보관한 것인지 모델을 부르기 전에는 확인할 방법이 없다.
 *   지문을 맞춰 보는 것은 "보낸 내용과 보낸 지문이 서로 맞는가"만 증명한다.
 *   "그 연구가 실제로 있었는가"는 증명하지 않는다.
 *
 *   실제로 그것을 붙잡는 자리는 글을 적어 둘 때의 이음(FK)뿐인데,
 *   그 자리는 모델을 부르고 난 다음이다.
 *
 *     지문 확인 → 모델 호출(돈이 나감) → 조립 → 적어 두기(여기서 처음 걸림)
 *
 *   즉 지어낸 연구 하나마다 유료 호출 한 번이 먼저 나간다.
 *   저장은 막히니 잘못된 글이 남지는 않는다. 그러나 돈은 이미 나갔다.
 *
 *   이 파일은 그 순서를 바꾸기 위한 길 하나를 정한다.
 *
 *     지문으로 읽기(없으면 여기서 끝) → 지문 확인 → 모델 호출
 *
 * 이 파일이 하는 일과 하지 않는 일
 *   여기에는 SQL도, DB 연결도, 요청 처리도 없다.
 *   타입과 약속과 순수 검사기뿐이다.
 *
 *   다음 단계에서 만들 migration이 이 약속을 따라야 하고,
 *   그때 실제 SQL과 여기 적힌 값을 대조한다.
 *
 * 표를 여는 것이 아니다
 *   private.research_result는 만들 때부터 닫혀 있다.
 *   스키마를 쓸 권한도, 표를 읽을 권한도 service_role에게 없다.
 *
 *   그 정책을 그대로 둔다. 표를 열지 않는다.
 *   아주 좁은 함수 하나만 연다. 앞서 Prioritizer 읽기 함수를 만들 때와 같은 방식이다.
 */

import type { BiblicalResearchResult } from './biblical-researcher.ts';
import { RESEARCH_RESULT_HASH_FORMAT } from './research-result-store-contract.ts';
import type { CandidateGenerationOrchestrationInput } from './published-content-candidate-generation-orchestration-contract.ts';

/* ------------------------------------------------------------------ */
/* 1. 이 길이 하는 일 하나                                              */
/* ------------------------------------------------------------------ */

/**
 * 읽는 함수의 이름. 아직 만들지 않았다.
 *
 * 이름의 모양은 이미 있는 읽기 함수를 따른다.
 *   get_content_research_queue_for_prioritizer — 무엇을, 누구를 위해
 *
 * 누구를 위한 것인지 이름에 적는 이유가 있다.
 * 나중에 다른 쪽이 같은 값을 읽고 싶어지면 이 함수를 조용히 가져다 쓰는 대신
 * 그때 다시 판단하고 따로 열게 하려는 것이다.
 */
export const GET_RESEARCH_RESULT_FOR_CANDIDATE_GENERATION_RPC =
  'get_biblical_research_result_for_candidate_generation';

/**
 * 이 길의 목적은 정확히 하나다.
 *
 * "이미 보관되어 있는 연구 결과 한 건을 정확한 지문 하나로 가져온다."
 *
 * 그 외에는 아무것도 하지 않는다.
 */
export const READ_BOUNDARY_PURPOSE =
  '보관된 연구 결과 한 건을 정확한 지문 하나로 가져온다.';

/**
 * 이 길이 하지 않는 일.
 *
 * 적어 두지 않으면 나중에 "이왕 여는 김에" 하나씩 붙는다.
 * 붙고 나면 되돌리기 어렵다. 그래서 먼저 적는다.
 */
export const READ_BOUNDARY_DOES_NOT_INCLUDE = [
  '연구 결과를 만드는 일',
  '연구 결과를 고치는 일',
  '연구 결과를 지우는 일',
  '목록 보기',
  '검색',
  '앞자리만 맞는 지문으로 찾기',
  '여러 지문을 한 번에 찾기',
  '최근 것 가져오기',
  '영역으로 찾기',
  '비슷한 것 찾기',
  '글(Candidate)을 만드는 일',
  '모델을 부르는 일',
  '근거 기록(provenance)을 고치는 일',
] as const;

/* ------------------------------------------------------------------ */
/* 2. 무엇을 받는가                                                     */
/* ------------------------------------------------------------------ */

/**
 * 받는 것은 지문 하나뿐이다.
 *
 * 연구 결과 전체를 받지 않는다.
 * 받으면 그 순간 "부르는 쪽이 보낸 내용"이 다시 판단의 근거가 되고,
 * 이 길을 만든 이유가 사라진다.
 */
export type ResearchResultReadRequest = {
  researchResultHash: string;
};

/** 받는 항목은 이것 하나뿐이다. 늘리지 않는다. */
export const READ_REQUEST_FIELDS = ['researchResultHash'] as const;

/**
 * 받지 않는 것들.
 *
 * 앞의 넷은 연구 결과 안에 있는 값이다. 밖에서 따로 받으면
 * 보관된 것과 어긋난 값으로 찾게 된다.
 *
 * 뒤의 다섯은 여러 건을 훑는 데 쓰이는 값이다.
 * 하나라도 받기 시작하면 이 길은 더 이상 한 건짜리 길이 아니다.
 *
 * 이 목록의 역할에 대해.
 *   막는 일을 이 목록이 하는 것이 아니다.
 *   실제로 막는 것은 검사기이고, 그 기준은 READ_REQUEST_FIELDS 하나다.
 *   지문 말고 무엇이 오든 거부되므로 이 목록에 없는 이름도 똑같이 막힌다.
 *
 *   그러면 이 목록은 왜 남는가.
 *   "이런 것을 받고 싶어질 수 있다. 그런데 받지 않기로 했다"를 적어 두는 자리다.
 *   나중에 누군가 limit을 받고 싶어졌을 때, 그것이 빠뜨린 것이 아니라
 *   일부러 뺀 것임을 알 수 있어야 한다.
 *
 *   따라서 이것은 두 번째 주인이 아니라 기록이다.
 *   시험은 이 목록이 아니라 검사기의 실제 동작으로 확인한다.
 */
export const FORBIDDEN_READ_REQUEST_FIELDS = [
  'researchResult',
  'targetDomain',
  'researchQuestion',
  'candidatePassages',
  'provenance',
  'filter',
  'limit',
  'offset',
  'sort',
  'hashes',
] as const;

/**
 * 요청의 모양은 정확히 하나다.
 *
 * 지문 하나만 있는 요청만 통과한다.
 * 그 위에 무엇이 하나라도 더 있으면 통과하지 못한다.
 *
 * 조용히 버리고 통과시키지 않는다. 거절한다.
 * 버리고 통과시키면 부르는 쪽은 자기가 잘못 부르고 있다는 것을 영영 모른다.
 */
export const STRICT_REQUEST_SHAPE = {
  acceptedKeyAuthority: 'READ_REQUEST_FIELDS',
  exactKeysOnly: true,
  extraKeyRejected: true,
  unknownKeyRejected: true,
  silentStrip: false,
  forbiddenListIsDocumentationOnly: true,
  extraKeyFailureReason: 'unknown_field',
} as const;

/* ------------------------------------------------------------------ */
/* 3. 지문의 주인                                                       */
/* ------------------------------------------------------------------ */

/**
 * 지문 모양의 주인은 연구 보관소 계약 하나뿐이다.
 *
 * 여기서 정규식을 새로 적지 않는다. 가져다 쓴다.
 * 두 곳에 적어 두면 언젠가 둘이 달라지고, 그때 어느 쪽이 맞는지 알 수 없다.
 */
export const READ_BOUNDARY_HASH_FORMAT = RESEARCH_RESULT_HASH_FORMAT;

/**
 * SQL에도 같은 모양의 검사가 필요할 수 있다.
 *
 * 그것은 사본이지 두 번째 주인이 아니다.
 * 사본은 원본과 어긋날 수 있으므로, 어긋났는지 확인하는 시험을
 * migration을 만들 때 함께 만들어야 한다.
 *
 * 지금 적어 두지 않으면 그때 잊는다.
 */
export const SQL_HASH_FORMAT_RULE = {
  classification: 'SECURITY_CRITICAL_ENFORCEMENT_MIRROR',
  canonicalAuthority: 'research-result-store-contract.ts · RESEARCH_RESULT_HASH_FORMAT',
  sqlSideIsCopyNotOwner: true,
  driftTestRequiredAtMigration: true,
  reason:
    'SQL 쪽 검사는 TypeScript 계약의 사본이다. 사본이 원본과 달라지면 한쪽이 통과시키는 값을 다른 쪽이 막는다. migration 단계에서 두 값을 대조하는 시험을 함께 만든다.',
} as const;

/* ------------------------------------------------------------------ */
/* 4. 누가 부를 수 있는가                                               */
/* ------------------------------------------------------------------ */

/**
 * 앞으로 만들 함수의 권한.
 *
 * 서버만 부를 수 있다. 로그인한 사람도 부를 수 없다.
 * 사람이 읽어야 할 자리는 이미 따로 있다(검토 꾸러미). 그 길과 섞지 않는다.
 *
 * 표 자체의 권한은 손대지 않는다.
 * 함수를 여는 것과 표를 여는 것은 다른 일이다.
 * 표를 열면 그 순간부터 무엇을 어떻게 읽을지 부르는 쪽이 정한다.
 */
export const FUTURE_READ_RPC_AUTHORIZATION = {
  rpc: GET_RESEARCH_RESULT_FOR_CANDIDATE_GENERATION_RPC,

  /** 서버 열쇠만 부를 수 있다. */
  serviceRoleExecute: true,

  /** 로그인한 사람은 부를 수 없다. */
  authenticatedExecute: false,

  /** 로그인하지 않은 쪽도 부를 수 없다. */
  anonExecute: false,

  /** 아무에게나 열지 않는다. */
  publicExecute: false,

  /** 표를 직접 읽는 권한은 계속 주지 않는다. */
  directTableSelectGrant: false,

  /** private 스키마의 권한도 그대로 둔다. 완화하지 않는다. */
  privateSchemaPrivilegeRelaxed: false,
} as const;

/**
 * Edge의 운영자 인증과 DB의 서버 권한은 다른 층이다.
 *
 * 요청이 올바른 내부 토큰을 들고 왔다는 것은 "누가 불렀는가"를 말한다.
 * 그것만으로 "그 사람이 보낸 값이 우리 보관소에 있는 것"이 되지는 않는다.
 *
 * 이 길이 필요한 이유가 바로 그 차이다. 둘을 섞지 않는다.
 */
export const AUTH_LAYER_SEPARATION = {
  operatorTokenProves: '누가 불렀는가',
  operatorTokenDoesNotProve: '보낸 값이 보관소에 실제로 있는가',
  serviceRoleExecuteProves: '이 함수를 부를 자격이 있는가',
  storedExistenceProvenBy: '이 읽기 함수가 값을 돌려주었다는 사실',
} as const;

/* ------------------------------------------------------------------ */
/* 5. SQL이 지켜야 할 것                                                */
/* ------------------------------------------------------------------ */

/**
 * 앞으로 만들 migration이 반드시 만족해야 할 것들.
 *
 * 이미 있는 읽기 함수(get_content_research_queue_for_prioritizer)가
 * 지키고 있는 것을 그대로 따른다. 더 느슨하게 하지 않는다.
 *
 * createOrReplaceForbidden에 대해.
 *   앞선 읽기 함수는 create or replace를 쓰지 않았다.
 *   같은 이름의 함수가 이미 있으면 덮어쓰지 말고 실패해야 하기 때문이다.
 *   덮어쓰기가 가능하면 권한이 붙은 함수의 속을 조용히 바꿀 수 있다.
 */
export const FUTURE_READ_RPC_SQL_INVARIANTS = {
  securityDefiner: true,
  volatility: 'stable',
  searchPath: 'private, pg_catalog',
  createOrReplaceForbidden: true,
  fullyQualifiedTableReference: 'private.research_result',
  lookupPredicate: 'result_hash = <parameter>',
  exactEqualityOnly: true,
  maximumRows: 1,
  dynamicSql: false,
  callerControlledIdentifier: false,
  insertAllowed: false,
  updateAllowed: false,
  deleteAllowed: false,
  sideEffects: false,
  tablePrivilegeGrant: false,
  revokeFromPublic: true,
  revokeFromAnonAuthenticatedServiceRole: true,
  grantExecuteTo: 'service_role',
} as const;

/* ------------------------------------------------------------------ */
/* 6. 무엇을 돌려주는가                                                 */
/* ------------------------------------------------------------------ */

/**
 * 표에는 칸이 다섯이다.
 *
 *   research_result_id   줄 번호
 *   created_at           보관한 시각
 *   result_hash          지문
 *   result               연구 결과 전체        ← 이것만 돌려준다
 *   provenance           근거 기록
 *
 * result 하나만 돌려준다.
 *
 * 줄 번호와 시각은 보관에 대한 기록이지 연구 내용이 아니다.
 * 모델에게 보여줄 것을 고르는 데 쓰이지 않는다.
 *
 * 근거 기록(provenance)을 돌려주지 않는 이유는 짐작이 아니다.
 * Candidate Generation 계약이 provenance를 모델에게 보이면 안 되는 항목으로
 * 이미 못 박아 두었다(FORBIDDEN_MODEL_INPUT_FIELDS).
 * 그러니 이 길이 그것을 실어 나를 이유가 없다.
 * 사람이 근거를 보아야 하는 자리는 검토 꾸러미다. 그 길이 따로 있다.
 */
export const READ_RESULT_COLUMN = 'result' as const;

/** 돌려주는 것. */
export const READ_RETURN_FIELDS = ['researchResult'] as const;

/** 돌려주지 않는 것. */
export const FORBIDDEN_READ_RETURN_FIELDS = [
  'research_result_id',
  'researchResultId',
  'created_at',
  'createdAt',
  'provenance',
  'result_hash',
] as const;

/**
 * 값을 돌려주었다는 것의 뜻.
 *
 * "이 지문에 해당하는 연구 결과가 private.research_result에 실제로 있다."
 *
 * 이것이 모델을 부르기 전에 세우는 유일한 닻이다.
 */
export const AUTHORITATIVE_MEANING =
  '값이 돌아왔다면 그 지문의 연구 결과가 보관소에 실제로 있다는 뜻이다.';

/* ------------------------------------------------------------------ */
/* 7. 결과의 모양                                                       */
/* ------------------------------------------------------------------ */

/**
 * 읽기의 결과.
 *
 * 까닭을 넷으로 나눈다.
 *
 *   unknown_field        지문 말고 다른 것이 함께 왔다. DB에 가기 전에 안다.
 *   hash_format_invalid  지문의 모양이 틀렸다. DB에 가기 전에 안다.
 *   not_found            모양은 맞는데 그런 연구가 없다.
 *   read_unavailable     읽어 오지 못했다.
 *
 * 나누는 이유.
 *   앞의 셋은 부르는 쪽이 잘못 부른 것이고, 마지막은 그렇지 않다.
 *   하나로 뭉치면 운영에서 무엇을 고쳐야 할지 알 수 없다.
 *
 * 나누어도 새는 것이 없는 이유.
 *   지문은 256비트다. 훑어서 맞힐 수 있는 값이 아니다.
 *   "그 지문이 없다"는 답은 부르는 쪽이 이미 들고 있던 값에 대한 답이지,
 *   보관소 안을 알려 주는 답이 아니다.
 *
 * 이 넷을 HTTP 응답으로 어떻게 보여줄지는 여기서 정하지 않는다.
 * 그것은 Edge 통합의 몫이다. 여기 것은 안쪽의 뜻이다.
 */
export type ResearchResultReadOutcome =
  | { ok: true; researchResultHash: string; researchResult: BiblicalResearchResult }
  | { ok: false; reason: 'unknown_field' }
  | { ok: false; reason: 'hash_format_invalid' }
  | { ok: false; reason: 'not_found' }
  | { ok: false; reason: 'read_unavailable' };

/** 실패의 까닭들. 검사하는 차례대로 적는다. */
export const READ_FAILURE_REASONS = [
  'unknown_field',
  'hash_format_invalid',
  'not_found',
  'read_unavailable',
] as const;

/**
 * 실패한 결과에 담지 않는 것.
 *
 * 실패는 까닭 하나만 남긴다.
 * 연구 내용을 되돌려 주지 않고, DB가 뭐라고 했는지 옮기지 않는다.
 */
export const FORBIDDEN_FAILURE_RESULT_CONTENT = [
  'researchResult',
  'provenance',
  'sqlState',
  'sqlMessage',
  'serviceRoleKey',
  'operatorToken',
  'connectionString',
] as const;

/* ------------------------------------------------------------------ */
/* 8. 훑을 수 없다                                                      */
/* ------------------------------------------------------------------ */

/**
 * 이 길로 보관소 안을 둘러볼 수 없어야 한다.
 *
 * 지문 하나를 정확히 아는 사람만 그 한 건을 가져간다.
 * 무엇이 들어 있는지 묻는 방법이 없다.
 */
export const NO_ENUMERATION_INVARIANT = {
  exactHashLookupOnly: true,
  listAll: false,
  latest: false,
  offset: false,
  limit: false,
  domainFilter: false,
  dateFilter: false,
  prefixMatch: false,
  containsMatch: false,
  likeMatch: false,
  ilikeMatch: false,
  arrayLookup: false,
  countQuery: false,
} as const;

/* ------------------------------------------------------------------ */
/* 9. 돈이 나가기 전에 막는다                                           */
/* ------------------------------------------------------------------ */

/**
 * 읽기가 성공하기 전에는 모델을 부르지 않는다.
 *
 * 이것이 이 길을 만드는 이유 그 자체다.
 * 순서가 뒤집히면 길만 생기고 얻는 것은 없다.
 *
 * 이 계약은 모델을 부르지 않는다. 다만 통합 단계가 지켜야 할 순서를 못 박는다.
 */
export const PROVIDER_COST_GATE = {
  readMustSucceedBeforeProvider: true,
  providerAttemptsOnInvalidHash: 0,
  providerAttemptsOnNotFound: 0,
  providerAttemptsOnReadUnavailable: 0,
  orchestratorInvokedBeforeReadSuccess: false,
  candidateBuiltOnReadFailure: false,
  candidateStoredOnReadFailure: false,
} as const;

/* ------------------------------------------------------------------ */
/* 10. 읽은 다음                                                        */
/* ------------------------------------------------------------------ */

/**
 * 표에서 읽어 왔다고 해서 지문 확인을 건너뛰지 않는다.
 *
 * 읽기가 증명하는 것은 "있다"이고,
 * 지문 확인이 증명하는 것은 "가져온 것이 그 지문의 것이 맞다"이다.
 * 둘은 다른 것을 본다.
 *
 * 그래서 읽은 뒤에도 기존 orchestrator의 lineage 확인을 그대로 통과시킨다.
 * 그 확인의 주인은 계속 orchestration 계약이다. 여기서 대신하지 않는다.
 */
export const POST_READ_VERIFICATION = {
  canonicalLineageVerificationStillRequired: true,
  lineageAuthority:
    'published-content-candidate-generation-orchestration-contract.ts · verifyCandidateGenerationLineage',
  readProves: 'stored_existence',
  lineageProves: 'payload_matches_supplied_hash',
  readReplacesLineage: false,
} as const;

/**
 * 운영에서 요청이 실어 나를 것.
 *
 * 지문 하나다. 연구 결과 전체를 실어 나르지 않는다.
 *
 * HTTP 요청의 모양이나 처리기는 여기서 만들지 않는다.
 * 다만 운영 경로에서 부르는 쪽이 보낸 연구 결과는
 * 더 이상 판단의 근거가 아니라는 것을 못 박는다.
 */
export const PRODUCTION_ACQUISITION = {
  requestBusinessPayload: ['researchResultHash'],
  callerSuppliedResearchResultIsAuthority: false,
  acquisitionSource: 'authoritative_db_read',
  migrationRequiredForEdgeIntegration: true,
} as const;

/* ------------------------------------------------------------------ */
/* 11. 검사기 — 여기서 실제로 도는 것은 이것뿐이다                       */
/* ------------------------------------------------------------------ */

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * 부르기 전에 요청을 본다.
 *
 * 두 가지를 차례로 본다.
 *
 *   하나. 지문 말고 다른 것이 함께 오지 않았는가.
 *   둘.  지문의 모양이 맞는가.
 *
 * 왜 지문만 뽑아 쓰지 않는가.
 *   지문만 골라 쓰고 나머지를 조용히 버리면, 보낸 쪽은 자기가 보낸 것이
 *   쓰였다고 믿는다. 연구 결과 전체를 함께 보낸 경우가 특히 그렇다.
 *   그 값은 버려졌는데 성공했다고 답하면, 부르는 쪽은 자기 payload가
 *   반영된 줄 알고 계속 그렇게 부른다.
 *
 *   "받지 않는다"는 것은 "무시한다"가 아니라 "거절한다"여야 한다.
 *   그래야 잘못 부르고 있다는 사실이 처음 부를 때 드러난다.
 *
 * 무엇을 기준으로 거절하는가.
 *   금지 목록에 있는 이름만 막는 것이 아니다. 그러면 목록에 없는 새 이름은
 *   그냥 지나간다. 받기로 한 이름(READ_REQUEST_FIELDS)에 없으면 전부 막는다.
 *
 *   이 방식은 이미 자료 검사기(verification-draft-source.ts)가 쓰고 있다.
 *   거기서 쓰는 까닭 이름(unknown_field)도 그대로 쓴다. 새로 짓지 않는다.
 *
 * 여기서 모양만 본다. 그런 연구가 있는지는 보지 않는다.
 * 그것은 표만 아는 일이다.
 */
export function validateResearchResultReadRequest(
  value: unknown,
):
  | { ok: true; request: ResearchResultReadRequest }
  | { ok: false; reason: 'unknown_field' }
  | { ok: false; reason: 'hash_format_invalid' } {
  if (!isPlainObject(value)) {
    return { ok: false, reason: 'hash_format_invalid' };
  }

  // 받기로 한 이름에 없는 것이 하나라도 있으면 거기서 끝이다.
  for (const key of Object.keys(value)) {
    if (!(READ_REQUEST_FIELDS as readonly string[]).includes(key)) {
      return { ok: false, reason: 'unknown_field' };
    }
  }

  const hash = value.researchResultHash;

  if (typeof hash !== 'string' || !READ_BOUNDARY_HASH_FORMAT.test(hash)) {
    return { ok: false, reason: 'hash_format_invalid' };
  }

  return { ok: true, request: { researchResultHash: hash } };
}

/**
 * 모델을 불러도 되는가.
 *
 * 읽기가 성공했을 때만 그렇다.
 * 까닭이 무엇이든 실패는 전부 같은 답이다 — 부르지 않는다.
 */
export function canProceedToProviderAfterRead(outcome: ResearchResultReadOutcome): boolean {
  return outcome.ok === true;
}

/**
 * 읽어 온 것을 기존 orchestrator가 받는 모양으로 넘긴다.
 *
 * 새 모양을 만들지 않는다. 이미 있는 입력 타입 그대로다.
 * 그래서 orchestrator를 고칠 일이 없다.
 *
 * 지문은 읽기 결과가 들고 있던 것을 그대로 쓴다.
 * 여기서 다시 계산하지 않는다. 계산의 주인은 연구 보관소 계약이고,
 * 맞는지 확인하는 자리는 orchestrator의 lineage 확인이다.
 */
export function buildOrchestrationInputFromRead(
  outcome: ResearchResultReadOutcome,
): CandidateGenerationOrchestrationInput | null {
  if (!outcome.ok) return null;

  return {
    researchResultHash: outcome.researchResultHash,
    researchResult: outcome.researchResult,
  };
}

/* ------------------------------------------------------------------ */
/* 12. 이 계약이 하지 않는 일                                           */
/* ------------------------------------------------------------------ */

export const READ_BOUNDARY_CONTRACT_DOES_NOT_INCLUDE = [
  'SQL migration',
  'RPC 구현',
  '실제 DB 호출',
  'Supabase client를 만드는 일',
  'Edge Function과 요청 처리',
  'HTTP 상태와 응답 모양',
  '운영자 인증 방식',
  '비밀값을 읽는 일',
  '모델 호출',
  '배포',
] as const;
