/**
 * 검토자를 세우고 내리는 일에 대한 운영 계약.
 *
 * 표도 함수도 이미 production에 있다. 검토자만 없다.
 * 명단이 비어 있어서 지금은 아무도 검토할 수 없고, 그 상태가 정상이다.
 *
 * 이 파일은 "그러면 첫 사람을 어떻게 세우는가"를 정한다.
 * 세우지는 않는다. 여기에는 SQL도, DB 연결도, 화면도 없다.
 *
 * 왜 이렇게까지 조심하는가.
 *
 * 지금 구조에서 명단에 켜진 사람 한 명은 다음 셋을 한꺼번에 갖는다.
 *   검토할 글 목록을 본다.
 *   글 한 건의 연구와 근거를 전부 본다.
 *   그 글을 승인하거나 반려한다. 승인하면 그 순간 게시된다.
 *
 * 읽기 권한만 주는 줄이 따로 있지 않다.
 * 그래서 "일단 켜 두고 나중에 보자"가 성립하지 않는다.
 * 켜는 일은 매번 사람이 알고 승인해야 한다.
 */

import {
  PUBLISHED_CONTENT_TABLES,
  REVIEW_PUBLISHED_CONTENT_CANDIDATE_RPC,
  STORE_PUBLISHED_CONTENT_CANDIDATE_RPC,
} from './published-content-store-contract.ts';
import {
  GET_PUBLISHED_CONTENT_REVIEW_PACKET_RPC,
  LIST_PUBLISHED_CONTENT_REVIEW_QUEUE_RPC,
  REVIEWER_MANAGEMENT_BOUNDARY,
} from './published-content-review-access-contract.ts';

/* ------------------------------------------------------------------ */
/* 1. 켜는 일이 무엇을 주는가                                           */
/* ------------------------------------------------------------------ */

/**
 * 명단에 켜진 사람이 실제로 할 수 있는 일.
 *
 * 세 함수가 모두 같은 명단을 본다. 그래서 하나를 켜면 셋이 함께 열린다.
 * 이것이 "읽기 권한만 잠깐 준다"가 불가능한 이유다.
 */
export const REVIEWER_EFFECTIVE_SCOPE = {
  /** 검토할 글 목록을 볼 수 있다. */
  canReadReviewQueue: true,
  /** 글 한 건의 연구와 근거를 볼 수 있다. */
  canReadReviewPacket: true,
  /** 승인하거나 반려할 수 있다. 승인하면 그 자리에서 게시된다. */
  canSubmitFinalReview: true,

  /** 다른 검토자를 세우거나 내릴 수는 없다. */
  canManageReviewers: false,
  /** 검토 대상 글을 적어 둘 수는 없다. 그것은 자동화의 일이다. */
  canStoreCandidate: false,
  /** 연구 결과를 적어 둘 수는 없다. */
  canStoreResearchResult: false,
  /** 표를 직접 열어 볼 수는 없다. 읽기도 함수를 통해서만 한다. */
  canReadPrivateTablesDirectly: false,

  /** 위 셋을 여는 함수들. 모두 같은 명단을 본다. */
  grantedRpcs: [
    LIST_PUBLISHED_CONTENT_REVIEW_QUEUE_RPC,
    GET_PUBLISHED_CONTENT_REVIEW_PACKET_RPC,
    REVIEW_PUBLISHED_CONTENT_CANDIDATE_RPC,
  ],
} as const;

/**
 * 자동화(서버 열쇠)가 할 수 있는 일과 없는 일.
 *
 * 글을 만들어 두는 일까지가 자동화의 몫이다. 그 뒤부터는 사람의 몫이다.
 * 이 경계는 이미 production에 있고, 이 계약이 그것을 뒤집지 않는다.
 */
export const SERVICE_ROLE_SCOPE = {
  canStoreResearchResult: true,
  canStoreCandidate: true,

  canReadReviewQueue: false,
  canReadReviewPacket: false,
  canSubmitFinalReview: false,
  canManageReviewers: false,

  grantedRpcs: [STORE_PUBLISHED_CONTENT_CANDIDATE_RPC],
} as const;

/* ------------------------------------------------------------------ */
/* 2. 누가, 어떤 조건으로 켜는가                                        */
/* ------------------------------------------------------------------ */

/**
 * 검토자를 세우고 내리는 일이 지켜야 할 것.
 *
 * 앞 계약이 정한 것(운영자만 한다, 애플리케이션 기능이 아니다)은 그대로 두고,
 * 여기서는 "실제로 할 때" 필요한 것을 더한다.
 */
export const REVIEWER_OPERATIONS_BOUNDARY = {
  /** 켜고 끄는 일은 이 표 한 곳에서만 일어난다. */
  managedTable: PUBLISHED_CONTENT_TABLES.reviewer,

  /** 어느 프로젝트에 쓰는지 그때그때 확인한다. */
  projectIdentityCheckRequired: true,

  /** 한 번 받은 승인을 다음 사람에게 다시 쓰지 않는다. */
  approvalReusableAcrossOperations: false,

  /** 승인은 무엇을, 누구에게, 어느 프로젝트에서 하는지까지 좁혀서 받는다. */
  approvalScope: ['operation', 'targetUserId', 'projectRef'],

  /** 한 번에 한 사람만 다룬다. 실수의 범위를 작게 둔다. */
  singleReviewerPerOperation: true,
  bulkOperations: false,

  /** 켤 때는 그 번호가 실제 인증 사용자여야 한다. */
  activationRequiresExistingAuthUser: true,

  /**
   * 끌 때는 인증 사용자가 남아 있지 않아도 된다.
   *
   * 계정이 사라졌는데 명단만 켜진 채로 남는 일이 생길 수 있다.
   * 그때 운영자가 그 줄을 닫을 수 없으면 곤란하다.
   */
  deactivationRequiresExistingAuthUser: false,

  /** 끌 때 줄을 지우지 않는다. */
  deactivationUsesDelete: false,

  /** 상태를 보지 않고 무조건 덮어쓰지 않는다. */
  blindUpsert: false,

  /** 처음 적힌 시각을 나중에 고쳐 쓰지 않는다. */
  createdAtMutation: false,
  createdAtSource: 'db_default',

  /** 명단이 아는 것은 사람의 번호와 켜짐 여부뿐이다. */
  identityField: 'user_id',
  identitySource: 'auth.uid()',
  profileFieldsStored: [] as readonly string[],

  /** 검토자는 데이터베이스 역할이 아니다. 역할을 만들거나 주지 않는다. */
  postgresRoleGranted: false,

  /** 지금 켜져 있는지만 알 수 있고, 언제 누가 켰는지는 남지 않는다. */
  currentStateOnly: true,
  fullManagementHistoryRetained: false,

  /** 사라진 계정의 줄을 자동으로 정리하는 일을 만들지 않는다. */
  automaticStaleCleanup: false,
} as const;

/**
 * 저절로 검토자가 되는 길은 없다.
 *
 * 아래는 흔히 쓰이는 방법들이고, 여기서는 전부 쓰지 않는다.
 * 하나라도 열어 두면 "사람이 승인해야 게시된다"는 규칙이 그 길로 새어 나간다.
 */
export const AUTOMATIC_BOOTSTRAP_PATHS = {
  firstSignupBecomesReviewer: false,
  projectOwnerBecomesReviewer: false,
  serviceRoleBecomesReviewer: false,
  firstLoginBecomesReviewer: false,
  environmentVariableReviewer: false,
  seedMigrationReviewer: false,
  hardcodedUuidReviewer: false,
} as const;

/**
 * 첫 사람을 세우는 순서.
 *
 * 지금 명단이 비어 있다. 잠긴 문을 열어 두는 것보다 잠긴 채로 두는 편이 안전하다.
 * 그래서 첫 사람도 아래를 다 지나야 한다.
 */
export const REVIEWER_BOOTSTRAP_PREREQUISITES = [
  '작업 대상이 아뢰다의 production 프로젝트가 맞는지 확인한다.',
  '지금 명단에 누가 있는지 읽어 본다.',
  '세우려는 번호가 실제 인증 사용자로 있는지 확인한다.',
  '그 번호 하나를 정확히 확정한다.',
  '무엇을 누구에게 하는지 알리고 사용자의 명시적 승인을 받는다.',
  '운영자 권한으로 그 한 줄만 바꾼다.',
] as const;

/* ------------------------------------------------------------------ */
/* 3. 켜고 끄는 일이 바꾸지 않는 것                                     */
/* ------------------------------------------------------------------ */

/**
 * 켜는 일이 바꾸는 것은 명단 한 줄의 켜짐 여부뿐이다.
 *
 * 아래는 전부 건드리지 않는다.
 * 권한을 넓히는 다른 방법을 함께 쓰면, 나중에 무엇 때문에 열렸는지 알 수 없게 된다.
 */
export const ACTIVATION_DOES_NOT_CHANGE = [
  '인증 쪽의 역할',
  'JWT에 담기는 값',
  '표의 직접 권한',
  '함수의 실행 권한',
  'RLS 정책',
  '서버 열쇠의 권한',
  '검토 대상 글과 연구와 결정의 내용',
] as const;

/** 끄는 일도 마찬가지다. 지난 결정과 게시된 글은 그대로 둔다. */
export const DEACTIVATION_DOES_NOT_CHANGE = [
  '이미 내려진 결정',
  '이미 게시된 글',
  '인증 쪽의 사용자 계정',
  '명단 줄이 처음 적힌 시각',
] as const;

/**
 * 계정이 사라졌는데 명단이 켜진 채로 남아 있다면.
 *
 * 명단은 인증 표를 가리키지 않는다(FK 없음). 일부러 그렇게 했다.
 * 사람이 떠나도 "누가 승인했는가"는 남아야 하기 때문이다.
 *
 * 그 대가로, 계정이 사라져도 명단 줄은 남는다.
 * 그런 줄을 발견하면 운영자가 꺼 둔다. 자동으로 지우는 일은 만들지 않는다.
 */
export const STALE_ACTIVE_REVIEWER_NOTE =
  '인증 계정이 사라져도 명단 줄은 남는다. 발견하면 운영자가 끈다. 자동으로 지우지 않는다.';

/**
 * 이 계약이 지키는 것과 지키지 못하는 것.
 *
 * 지키지 못하는 것을 적어 두지 않으면 지킨다고 착각하게 된다.
 */
export const REVIEWER_OPERATIONS_LIMITATION = {
  guarantees:
    '정상 애플리케이션 경로에서 검토자를 세우고 내리는 일을 운영자의 명시적 승인 아래에만 둔다.',
  doesNotGuarantee: [
    '프로젝트 관리자 권한을 가진 사람이 명단을 직접 고치는 것',
    'postgres 소유자 권한으로 하는 일',
    '인증 관리 권한으로 다른 사람인 척하는 것',
    '검토자 계정 자체를 빼앗겼을 때',
    '화면 앞에 있는 사람이 그 계정의 주인이라는 물리적 증명',
  ],
} as const;

/* ------------------------------------------------------------------ */
/* 4. 지금 그 사람이 어떤 상태인가                                      */
/* ------------------------------------------------------------------ */

/**
 * 명단에서 본 상태 셋.
 *
 *   missing    줄이 없다
 *   inactive   줄은 있고 꺼져 있다
 *   active     줄이 있고 켜져 있다
 *
 * 셋을 구분하는 이유가 있다.
 * 없는 사람을 새로 넣는 것과, 있던 사람을 다시 켜는 것은 다른 일이다.
 * 운영자가 그 둘을 구분해서 알고 실행해야 한다.
 */
export const REVIEWER_REGISTRY_STATES = ['missing', 'inactive', 'active'] as const;
export type ReviewerRegistryState = (typeof REVIEWER_REGISTRY_STATES)[number];

/** 켜는 일의 결과. */
export const ACTIVATION_ACTIONS = [
  'hold',
  /** 줄이 없다. 켜진 줄 하나를 새로 넣는다. */
  'insert_active',
  /** 꺼진 줄이 있다. 그 줄을 켠다. 새 줄을 만들지 않는다. */
  'set_active_true',
  /** 이미 켜져 있다. 아무것도 하지 않는다. */
  'already_active',
] as const;
export type ActivationAction = (typeof ACTIVATION_ACTIONS)[number];

/** 끄는 일의 결과. */
export const DEACTIVATION_ACTIONS = [
  'hold',
  /** 켜져 있다. 끈다. 지우지 않는다. */
  'set_active_false',
  /** 이미 꺼져 있다. 아무것도 하지 않는다. */
  'already_inactive',
  /** 줄이 없다. 만들었다가 끄지 않는다. */
  'not_registered',
] as const;
export type DeactivationAction = (typeof DEACTIVATION_ACTIONS)[number];

/**
 * 멈추는 이유.
 *
 * 이것은 운영자가 보는 값이다. 서비스를 쓰는 사람에게 가는 말이 아니다.
 * 그래서 왜 멈췄는지 그대로 적는다.
 */
export const OPERATION_HOLD_REASONS = [
  'project_not_confirmed',
  'approval_missing',
  'auth_user_missing',
  'target_user_id_invalid',
] as const;
export type OperationHoldReason = (typeof OPERATION_HOLD_REASONS)[number];

/**
 * 판단에 필요한 값.
 *
 * 전부 이미 확인한 사실이다. 여기서 DB를 부르거나 인증에 묻지 않는다.
 * 확인하는 일은 바깥에서 하고, 이 함수는 그 결과로 무엇을 해야 하는지만 정한다.
 *
 * 목록이 아니라 번호 하나를 받는다. 한 번에 한 사람이다.
 */
export type ReviewerOperationInput = {
  /** 인증이 아는 그 사람의 번호. 메일 주소가 아니다. */
  targetUserId: string;
  registryState: ReviewerRegistryState;
  /** 그 번호가 실제 인증 사용자로 있는지. 켤 때만 본다. */
  authUserExists: boolean;
  /** 이번 일에 대해 사용자에게 받은 승인. 지난 승인을 다시 쓰지 않는다. */
  explicitApprovalGiven: boolean;
  /** 지금 다루는 곳이 그 production 프로젝트가 맞는지. */
  projectIdentityConfirmed: boolean;
};

export type ReviewerOperationPlan<TAction extends string> = {
  action: TAction;
  targetUserId: string;
  /** 실제로 바꿀 줄의 수. 0 또는 1이다. */
  writeCount: 0 | 1;
  /** 처음 적힌 시각은 어떤 경우에도 고치지 않는다. */
  mutatesCreatedAt: false;
  holdReasons: OperationHoldReason[];
};

export type ReviewerActivationPlan = ReviewerOperationPlan<ActivationAction>;
export type ReviewerDeactivationPlan = ReviewerOperationPlan<DeactivationAction>;

/* ------------------------------------------------------------------ */
/* 5. 무엇을 해야 하는지 정한다                                         */
/* ------------------------------------------------------------------ */

/** 인증이 쓰는 번호의 모양. 메일 주소나 이름을 넣지 못하게 한다. */
const USER_ID_FORMAT = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/** 켜고 끄는 일에 공통으로 필요한 것. 못 갖췄으면 이유를 모아 돌려준다. */
const commonHoldReasons = (input: ReviewerOperationInput): OperationHoldReason[] => {
  const reasons: OperationHoldReason[] = [];

  if (typeof input.targetUserId !== 'string' || !USER_ID_FORMAT.test(input.targetUserId)) {
    reasons.push('target_user_id_invalid');
  }
  if (input.projectIdentityConfirmed !== true) {
    reasons.push('project_not_confirmed');
  }
  if (input.explicitApprovalGiven !== true) {
    reasons.push('approval_missing');
  }

  return reasons;
};

/**
 * 검토자를 켤 때 무엇을 해야 하는지 정한다.
 *
 * SQL을 만들지 않는다. 주소도, 열쇠도, 접속 정보도 돌려주지 않는다.
 * "무엇을 할 일인가"만 돌려준다. 실제로 하는 일은 사람이 한다.
 *
 * 못 갖춘 것이 하나라도 있으면 멈춘다.
 * 이미 켜져 있더라도 멈춘다. 프로젝트가 맞는지 모르는 채로 읽은 상태는
 * 그 사람의 상태라고 믿을 수 없기 때문이다.
 */
export function planReviewerActivation(input: ReviewerOperationInput): ReviewerActivationPlan {
  const holdReasons = commonHoldReasons(input);

  // 켤 때는 그 번호가 실제 사람이어야 한다. 없는 사람 앞으로 권한을 열지 않는다.
  if (input.authUserExists !== true) {
    holdReasons.push('auth_user_missing');
  }

  if (holdReasons.length > 0) {
    return {
      action: 'hold',
      targetUserId: input.targetUserId,
      writeCount: 0,
      mutatesCreatedAt: false,
      holdReasons,
    };
  }

  // 상태마다 할 일이 다르다. 하나로 뭉뚱그려 덮어쓰지 않는다.
  if (input.registryState === 'active') {
    return {
      action: 'already_active',
      targetUserId: input.targetUserId,
      writeCount: 0,
      mutatesCreatedAt: false,
      holdReasons: [],
    };
  }

  return {
    action: input.registryState === 'missing' ? 'insert_active' : 'set_active_true',
    targetUserId: input.targetUserId,
    writeCount: 1,
    mutatesCreatedAt: false,
    holdReasons: [],
  };
}

/**
 * 검토자를 끌 때 무엇을 해야 하는지 정한다.
 *
 * 켤 때와 다른 점이 하나 있다. 인증 사용자가 남아 있는지 보지 않는다.
 *
 * 계정이 이미 사라졌는데 명단만 켜져 있는 경우가 있을 수 있다.
 * 그럴 때 "그 사람이 없어서 끌 수 없다"가 되면 열린 문을 닫을 방법이 없어진다.
 * 닫는 일은 언제나 할 수 있어야 한다.
 *
 * 줄을 지우지 않는다. 지난 결정에 남은 검토자 번호를 확인할 곳이 사라진다.
 */
export function planReviewerDeactivation(input: ReviewerOperationInput): ReviewerDeactivationPlan {
  const holdReasons = commonHoldReasons(input);

  if (holdReasons.length > 0) {
    return {
      action: 'hold',
      targetUserId: input.targetUserId,
      writeCount: 0,
      mutatesCreatedAt: false,
      holdReasons,
    };
  }

  if (input.registryState === 'missing') {
    return {
      action: 'not_registered',
      targetUserId: input.targetUserId,
      writeCount: 0,
      mutatesCreatedAt: false,
      holdReasons: [],
    };
  }

  if (input.registryState === 'inactive') {
    return {
      action: 'already_inactive',
      targetUserId: input.targetUserId,
      writeCount: 0,
      mutatesCreatedAt: false,
      holdReasons: [],
    };
  }

  return {
    action: 'set_active_false',
    targetUserId: input.targetUserId,
    writeCount: 1,
    mutatesCreatedAt: false,
    holdReasons: [],
  };
}

/**
 * 앞 계약이 정한 것과 어긋나지 않는지 한자리에서 확인할 수 있게 모아 둔다.
 *
 * 두 계약이 서로 다른 말을 하기 시작하면 어느 쪽이 맞는지 알 수 없게 된다.
 */
export const INHERITED_MANAGEMENT_AUTHORITY = REVIEWER_MANAGEMENT_BOUNDARY;
