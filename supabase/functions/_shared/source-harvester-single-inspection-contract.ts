/**
 * 주소 하나씩 확인하기 계약 · 순수 로직
 *
 * 왜 만드는가:
 *   지금은 한 번의 모델 요청에 남은 주소를 전부 주고 "서로 다른 N개를 열어라"라고 맡긴다.
 *   production에서 여섯 번을 보았지만 모델이 실제로 연 주소는 2~4개에서 멈췄다.
 *   도구 예산을 18로 주어도 매번 4번만 썼다.
 *   요청서에 적을 수 있는 것은 "최대 몇 번"이지 "최소 몇 번"이 아니기 때문이다.
 *
 *   그래서 몇 개를 열지를 모델의 판단에 맡기지 않고 서버가 정한다.
 *   주소 하나마다 요청 하나를 만들고, 그 요청이 고를 수 있는 주소를 그 하나로 묶는다.
 *   실제로 그 주소를 연 기록이 있는 요청만 성공으로 센다.
 *
 * 이 파일이 하는 일:
 *   어떤 주소를 몇 개나 확인할지 계획을 세우고, 요청 하나의 본문을 만든다.
 *
 * 이 파일이 하지 않는 일:
 *   DB 접근, 네트워크, 환경변수 읽기, 병렬 실행, 응답 읽기, 결과 모으기.
 *
 * 누가 쓰는가:
 *   source-harvester-parallel-recovery-execution.ts가 여기의 계획 세우기,
 *   동시에 보낼 수 있는 수, 시간 제한, 요청서 만들기를 그대로 쓴다.
 *   이 파일 자체는 요청을 보내지도, 답을 읽지도, 결과를 모으지도 않는다.
 *
 * 지금 돌아가는 서버의 두 번째 요청이 이 길을 쓴다.
 *
 * 적용 범위:
 *   이어서 확인하는 요청(Request B)뿐이다.
 *   처음 시작하는 요청(Request A)은 production에서 검증된 경로 그대로 둔다.
 *
 * 규칙은 새로 쓰지 않는다:
 *   주소 정리   → source-harvester.ts의 normalizeSourceUrl
 *   응답 구조   → source-harvester-execution-contract.ts의 buildSourceHarvestDraftSchema
 *   모델·도구·출력 → source-harvester-execution-contract.ts의 상수
 */

import { RESEARCH_CONSTITUTION } from './biblical-research-contract.ts';
import { normalizeSourceUrl, type SourceHarvestBrief } from './source-harvester.ts';
import {
  RESPONSE_INCLUDE,
  SOURCE_HARVEST_MODEL,
  UNTRUSTED_WEB_CONTENT_RULE,
  VERIFICATION_MAX_OUTPUT_TOKENS,
  WEB_SEARCH_TOOL,
  buildSourceHarvestDraftSchema,
} from './source-harvester-execution-contract.ts';

/* ------------------------------------------------------------------ */
/* 숫자                                                                 */
/* ------------------------------------------------------------------ */

/**
 * 필요한 수보다 더 만들 요청의 최대 개수(여유분).
 *
 * 요청 하나가 실패해도 전체가 무너지지 않게 한다.
 * 지금 구조에서는 한 번의 요청이 덜 열면 실행 전체가 끝났다.
 */
export const SINGLE_INSPECTION_SPARE_MAX = 4;

/** 동시에 보낼 수 있는 요청 수. 이보다 많으면 나누어 보낸다. */
export const SINGLE_INSPECTION_MAX_CONCURRENCY = 8;

/** 요청 하나를 기다리는 시간. 주소 하나만 보므로 짧게 잡는다. */
export const SINGLE_INSPECTION_TIMEOUT_MS = 45_000;

/**
 * 요청 하나가 쓸 수 있는 도구 횟수의 상한.
 *
 * 4번을 다 써야 성공인 것이 아니다.
 * 성공 여부는 맡은 주소를 실제로 열었는가로만 정한다.
 */
export const SINGLE_INSPECTION_MAX_TOOL_CALLS = 4;

/* ------------------------------------------------------------------ */
/* 확인 작업 하나                                                        */
/* ------------------------------------------------------------------ */

/**
 * 확인 작업 하나. 주소 하나만 담당한다.
 *
 * index는 남은 주소 목록에서의 자리다.
 * 결과를 모을 때는 끝난 순서가 아니라 이 번호 순서를 쓴다.
 * 그래야 같은 입력이면 언제나 같은 결과가 나온다.
 */
export type SingleInspectionTask = {
  index: number;
  targetUrl: string;
};

export type SingleInspectionPlan = {
  tasks: SingleInspectionTask[];
  /** 이 중 몇 개가 성공해야 이어서 진행할 수 있는가 */
  requiredSuccessCount: number;
  /** 필요한 수보다 더 만든 요청 수 */
  spareCount: number;
};

/** 계획을 세울 수 없는 이유. 조용히 목표를 낮추지 않는다. */
export type SingleInspectionPlanError =
  /** 확인할 주소가 없다 */
  | 'no_remaining_urls'
  /** 필요한 수가 1 이상의 정수가 아니다 */
  | 'invalid_required_count'
  /** 남은 주소가 필요한 수보다 적다 */
  | 'remaining_shorter_than_required'
  /** 주소 목록의 모양이 잘못됐다 (정리되지 않았거나 받을 수 없는 주소) */
  | 'invalid_url_list'
  /** 같은 주소가 두 번 있다 */
  | 'duplicate_url';

/**
 * 결과를 모을 때 쓰는 순서.
 *
 * 요청이 끝난 순서나 모델이 매긴 점수를 쓰지 않는다.
 * 남은 주소 목록의 원래 순서를 그대로 쓴다.
 */
export const SINGLE_INSPECTION_AGGREGATION_ORDER = 'task_index' as const;

/* ------------------------------------------------------------------ */
/* 계획 세우기                                                          */
/* ------------------------------------------------------------------ */

/**
 * 남은 주소에서 확인 작업을 몇 개 만들지 정한다.
 *
 * 필요한 수만큼만 만들지 않고 여유분을 더 만든다.
 * 그래야 몇 개가 실패해도 나머지로 목표를 채울 수 있다.
 *
 * 주소는 남은 목록 앞에서부터 순서대로 배정한다.
 * 정렬하지 않고, 무작위로 고르지 않고, 점수로 고르지 않는다.
 *
 * 잘못된 입력을 조용히 고치지 않는다. 하나라도 어긋나면 이유와 함께 멈춘다.
 */
export function planSingleUrlRecoveryInspections(input: {
  remainingUrls: readonly string[];
  requiredAdditionalInspections: number;
}): { ok: true; plan: SingleInspectionPlan } | { ok: false; reason: SingleInspectionPlanError } {
  const { remainingUrls, requiredAdditionalInspections: required } = input;

  if (!Array.isArray(remainingUrls) || remainingUrls.length === 0) {
    return { ok: false, reason: 'no_remaining_urls' };
  }
  if (typeof required !== 'number' || !Number.isSafeInteger(required) || required <= 0) {
    return { ok: false, reason: 'invalid_required_count' };
  }

  // 주소를 정리하는 규칙은 새로 만들지 않는다. 이미 정리된 모양이어야 한다.
  const seen = new Set<string>();
  for (const url of remainingUrls) {
    if (typeof url !== 'string') return { ok: false, reason: 'invalid_url_list' };
    if (normalizeSourceUrl(url) !== url) return { ok: false, reason: 'invalid_url_list' };
    if (seen.has(url)) return { ok: false, reason: 'duplicate_url' };
    seen.add(url);
  }

  if (remainingUrls.length < required) {
    return { ok: false, reason: 'remaining_shorter_than_required' };
  }

  // 여유분은 필요한 수만큼, 다만 정해진 상한을 넘지 않는다.
  const spare = Math.min(required, SINGLE_INSPECTION_SPARE_MAX);
  const plannedTaskCount = Math.min(remainingUrls.length, required + spare);

  // 남은 주소가 모자라 필요한 수조차 채울 수 없다면 여기서 멈춘다. (위에서 이미 걸러지지만 이중 확인)
  if (plannedTaskCount < required) {
    return { ok: false, reason: 'remaining_shorter_than_required' };
  }

  const tasks: SingleInspectionTask[] = [];
  for (let index = 0; index < plannedTaskCount; index += 1) {
    tasks.push({ index, targetUrl: remainingUrls[index] });
  }

  return {
    ok: true,
    plan: {
      tasks,
      requiredSuccessCount: required,
      spareCount: plannedTaskCount - required,
    },
  };
}

/**
 * 계획한 요청들을 몇 번에 나누어 보내야 하는가.
 * 동시에 보낼 수 있는 수를 넘으면 나누어 보낸다.
 */
export function countInspectionWaves(taskCount: number): number {
  if (!Number.isSafeInteger(taskCount) || taskCount <= 0) return 0;
  return Math.ceil(taskCount / SINGLE_INSPECTION_MAX_CONCURRENCY);
}

/* ------------------------------------------------------------------ */
/* 성공의 뜻                                                            */
/* ------------------------------------------------------------------ */

/**
 * 확인 작업 하나가 성공했다고 볼 수 있는 조건.
 *
 * 오직 실제 도구 사용 기록에서 맡은 주소를 열었을 때뿐이다.
 * 모델이 문장으로 "확인했다"고 쓰는 것, 인용을 붙이는 것,
 * 도구를 반드시 쓰라고 요청서에 적어 둔 것은 모두 근거가 아니다.
 *
 * 실제로 확인하는 곳은 source-harvester-parallel-recovery-execution.ts다.
 * 그쪽이 답과 도구 사용 기록을 보고 이 뜻대로 판정한다. 여기에는 뜻만 적어 둔다.
 */
export const SINGLE_INSPECTION_SUCCESS_RULE = {
  /** open_page 또는 find_in_page 기록에 맡은 주소가 있어야 한다 */
  requiresActualOpenOrFind: true,
  /** 검색만 한 경우는 성공이 아니다 */
  searchOnlyCountsAsSuccess: false,
  /** 답변에 인용만 붙인 경우도 성공이 아니다 */
  citationOnlyCountsAsSuccess: false,
  /** 도구를 반드시 쓰게 한 설정 자체는 근거가 아니다 */
  toolChoiceRequiredCountsAsSuccess: false,
  /** 맡은 주소가 아닌 주소를 열었다면 그 작업은 실패다 */
  failsOnOutOfScopeOpen: true,
  /** 검색 결과 목록에 다른 주소가 보이는 것만으로는 실패가 아니다 */
  failsOnOutOfScopeSearchResult: false,
} as const;

/**
 * 한 작업이 실패해도 요청 전체가 실패하지는 않는다.
 *
 * 작업들은 서로 독립이다. 성공한 수가 필요한 수에 이르면 이어서 진행한다.
 * 모자라면 지금과 같은 이유(insufficient_recovery_inspection)로 멈춘다.
 * 새 표를 만들지 않고, 다시 부르지 않고, 세 번째 요청도 없다.
 *
 * 여유분으로 만든 작업이 성공했다면 그것도 실제로 확인한 근거다.
 * 필요한 수를 넘겼다는 이유로 그 확인을 거짓으로 취급하지 않는다.
 *
 * 어떤 성공 결과를 최종 자료에 넣을지는 실행 본체가 정한다.
 * 기존 개수 상한(ACCEPTED_MAX, REJECTED_SOURCE_MAX)에서 첫 번째 요청이 이미 쓴 만큼을 뺀 자리에
 * 작업 번호 순서대로 담는다. 자리가 차서 담지 못한 것도 확인한 사실 자체는 지우지 않는다.
 */
export const SINGLE_INSPECTION_FAILURE_RULE = {
  taskFailureFailsWholeRequest: false,
  retriesPerTask: 0,
  createsNewTicketOnFailure: false,
  addsThirdRequest: false,
} as const;

/* ------------------------------------------------------------------ */
/* 요청서                                                               */
/* ------------------------------------------------------------------ */

/**
 * 주소 하나를 확인하라는 지시문.
 *
 * 다른 주소는 알려 주지 않는다. 이 요청이 아는 주소는 자기 것 하나뿐이다.
 * 그래야 다른 주소를 기웃거릴 자리가 없고, 무엇을 했는지도 분명해진다.
 */
export function buildSingleInspectionInstructions(input: {
  targetDomain: string;
  domainDescription: string;
  targetUrl: string;
}): string {
  return `당신은 아뢰다의 Source Harvester입니다. 이번에는 주소 하나만 확인합니다.

연구 대상 영역: ${input.targetDomain}
영역 설명: ${input.domainDescription}

확인할 주소: ${input.targetUrl}

이것은 새 자료를 찾는 단계가 아닙니다.
위 주소 하나만 다룹니다. 다른 주소를 찾거나 채택하지 마십시오.

[먼저 그 페이지를 여십시오]

무엇을 적기 전에 위 주소를 실제로 열어 내용이나 초록을 확인하십시오.
검색 결과에 나온 요약문은 확인이 아닙니다.
페이지를 열지 못했다면 그 자료를 sources에 넣지 마십시오.
그때는 rejectedSources에 이유와 함께 남기십시오.

절대 하지 않는 일:

- 위 주소가 아닌 다른 주소를 열거나 적지 않는다.
- 검색 결과 요약만 보고 자료를 승인하지 않는다.
- 성경 본문을 고르거나 해석하지 않는다.
- 자료의 내용을 그대로 옮겨 적거나 길게 인용하지 않는다.
- sourceId나 확인 날짜를 적지 않는다. 그 값은 서버가 만듭니다.

[최종 JSON]

url에는 위에 적힌 주소 문자열을 그대로 넣으십시오.
주소를 다시 쓰거나, 고치거나, 다른 주소로 바꾸지 마십시오.

이 자료가 연구 근거가 될 만하면 sources에 한 건으로 적고,
그렇지 않으면 rejectedSources에 이유와 함께 적으십시오.
둘 다 비워 두는 것도 가능합니다. 억지로 채우지 마십시오.

[확인해야 하는 정보]

페이지를 실제로 확인한 뒤 제목, 저자 또는 작성 기관, 발행처 또는 소속 기관, 출판 연도를 적으십시오.
확인되지 않은 것을 추측해서 적지 마십시오.
출판 연도를 확인하지 못했으면 null로 두십시오.

[내용을 어디까지 확인했는가]

- full_text: 주요 본문을 확인했다
- substantial_preview: 연구에 필요한 부분을 실제로 확인했다
- abstract_only: 초록까지만 확인했다

초록만 확인했더라도 그 초록 페이지를 실제로 열어야 합니다.

[자료의 역할]

의료·법률·재정·상담 자료는 현실의 안전과 전문적 도움의 경계를 확인하는 용도입니다.
성경 해석의 근거로 쓰지 마십시오.
목회 보조자료도 성경 해석의 핵심 근거가 될 수 없습니다.

${UNTRUSTED_WEB_CONTENT_RULE}

[아뢰다 원칙]

${RESEARCH_CONSTITUTION.join('\n')}`;
}

/**
 * 주소 하나를 확인하는 요청 본문.
 *
 * 이 요청이 아는 것은 영역·근거 판본·판단 시점 id와 자기 주소 하나뿐이다.
 * 표 번호, 앞서 쓴 초안, 이미 확인한 주소, 남은 주소 전체, 다른 작업의 주소는 들어가지 않는다.
 *
 * tool_choice를 required로 두는 것은 "도구를 아예 쓰지 않고 답만 쓰는" 경우를 줄이기 위해서다.
 * 이것이 성공의 근거가 되지는 않는다. 성공은 실제로 그 주소를 연 기록으로만 정한다.
 */
export function buildSingleInspectionPayload(input: {
  brief: SourceHarvestBrief;
  targetUrl: string;
}): Record<string, unknown> {
  const { brief, targetUrl } = input;

  return {
    model: SOURCE_HARVEST_MODEL,
    store: false,
    instructions: buildSingleInspectionInstructions({
      targetDomain: brief.targetDomain,
      domainDescription: brief.domainDescription,
      targetUrl,
    }),
    input: JSON.stringify({
      targetDomain: brief.targetDomain,
      evidenceVersion: brief.evidenceVersion,
      prioritizerSnapshotId: brief.prioritizerSnapshotId,
      targetUrl,
    }),
    tools: [{ ...WEB_SEARCH_TOOL }],
    // 도구를 아예 쓰지 않는 답을 줄인다. 어떤 도구를 몇 번 쓸지는 여전히 모델이 정한다.
    tool_choice: 'required',
    max_tool_calls: SINGLE_INSPECTION_MAX_TOOL_CALLS,
    max_output_tokens: VERIFICATION_MAX_OUTPUT_TOKENS,
    include: [...RESPONSE_INCLUDE],
    text: {
      format: {
        type: 'json_schema',
        name: 'source_harvest_draft',
        strict: true,
        // 고를 수 있는 주소는 이 하나뿐이다.
        schema: buildSourceHarvestDraftSchema([targetUrl]),
      },
    },
  };
}
