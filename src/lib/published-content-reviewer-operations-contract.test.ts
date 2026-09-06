/**
 * 검토자를 세우고 내리는 일 · 운영 계약 테스트
 *
 * 실행: npm test
 *
 * 지키려는 것 일곱 가지.
 *
 *   1. 검토자를 켜고 끄는 일은 운영자만, 매번 승인을 받아 한 사람씩 한다.
 *   2. 켜는 일은 읽기와 최종 승인 권한을 한꺼번에 준다는 것을 분명히 적는다.
 *   3. 저절로 검토자가 되는 길이 하나도 없다.
 *   4. 없는 사람을 넣는 것과 있던 사람을 다시 켜는 것을 구분한다.
 *   5. 끌 때는 줄을 지우지 않고 끄기만 한다.
 *   6. 켤 때는 인증 사용자가 있어야 하고, 끌 때는 없어도 된다.
 *   7. 계획은 계획일 뿐이다. SQL도 주소도 열쇠도 만들지 않는다.
 *
 * 값을 여기 다시 적지 않는다. 앞 계약에서 가져와 대조한다.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import * as operations from '../../supabase/functions/_shared/published-content-reviewer-operations-contract.ts';
import {
  ACTIVATION_ACTIONS,
  AUTOMATIC_BOOTSTRAP_PATHS,
  DEACTIVATION_ACTIONS,
  OPERATION_HOLD_REASONS,
  REVIEWER_BOOTSTRAP_PREREQUISITES,
  REVIEWER_EFFECTIVE_SCOPE,
  REVIEWER_OPERATIONS_BOUNDARY,
  REVIEWER_OPERATIONS_LIMITATION,
  REVIEWER_REGISTRY_STATES,
  SERVICE_ROLE_SCOPE,
  planReviewerActivation,
  planReviewerDeactivation,
  type ReviewerOperationInput,
  type ReviewerRegistryState,
} from '../../supabase/functions/_shared/published-content-reviewer-operations-contract.ts';
import {
  GET_PUBLISHED_CONTENT_REVIEW_PACKET_RPC,
  LIST_PUBLISHED_CONTENT_REVIEW_QUEUE_RPC,
  REVIEWER_MANAGEMENT_BOUNDARY,
} from '../../supabase/functions/_shared/published-content-review-access-contract.ts';
import {
  PUBLISHED_CONTENT_TABLES,
  REVIEW_PUBLISHED_CONTENT_CANDIDATE_RPC,
  STORE_PUBLISHED_CONTENT_CANDIDATE_RPC,
} from '../../supabase/functions/_shared/published-content-store-contract.ts';

const CONTRACT_PATH =
  '../../supabase/functions/_shared/published-content-reviewer-operations-contract.ts';
const CONTRACT_SOURCE = readFileSync(new URL(CONTRACT_PATH, import.meta.url), 'utf8');

/* ------------------------------------------------------------------ */
/* fixture                                                             */
/* ------------------------------------------------------------------ */

const USER_ID = '3f2a1c04-9b77-4d2e-8a51-6c0e7b93d418';

const input = (overrides: Partial<ReviewerOperationInput> = {}): ReviewerOperationInput => ({
  targetUserId: USER_ID,
  registryState: 'missing',
  authUserExists: true,
  explicitApprovalGiven: true,
  projectIdentityConfirmed: true,
  ...overrides,
});

/* ================================================================== */
/* A. 누가 켜고 끄는가                                                  */
/* ================================================================== */

describe('검토자 운영 · A. 관리 권한', () => {
  it('앞 계약이 정한 관리 권한과 어긋나지 않는다', () => {
    // 두 계약이 서로 다른 말을 하면 어느 쪽이 맞는지 알 수 없게 된다.
    assert.equal(operations.INHERITED_MANAGEMENT_AUTHORITY, REVIEWER_MANAGEMENT_BOUNDARY);
    assert.equal(REVIEWER_MANAGEMENT_BOUNDARY.reviewerManagementMode, 'operator_only');
    assert.equal(REVIEWER_MANAGEMENT_BOUNDARY.applicationManagementRpc, false);
    assert.equal(REVIEWER_MANAGEMENT_BOUNDARY.serviceRoleCanManageReviewers, false);
    assert.equal(REVIEWER_MANAGEMENT_BOUNDARY.authenticatedCanManageReviewers, false);
    assert.equal(REVIEWER_MANAGEMENT_BOUNDARY.anonCanManageReviewers, false);
    assert.equal(REVIEWER_MANAGEMENT_BOUNDARY.clientCanManageReviewers, false);
    assert.equal(REVIEWER_MANAGEMENT_BOUNDARY.automaticReviewerPromotion, false);
    assert.equal(REVIEWER_MANAGEMENT_BOUNDARY.seedReviewer, false);
  });

  it('고치는 표는 검토자 명단 하나뿐이다', () => {
    assert.equal(REVIEWER_OPERATIONS_BOUNDARY.managedTable, PUBLISHED_CONTENT_TABLES.reviewer);
  });

  it('어느 프로젝트인지 그때그때 확인한다', () => {
    assert.equal(REVIEWER_OPERATIONS_BOUNDARY.projectIdentityCheckRequired, true);
  });

  it('지난 승인을 다음 사람에게 다시 쓰지 않는다', () => {
    assert.equal(REVIEWER_OPERATIONS_BOUNDARY.approvalReusableAcrossOperations, false);
    assert.deepEqual(
      [...REVIEWER_OPERATIONS_BOUNDARY.approvalScope],
      ['operation', 'targetUserId', 'projectRef'],
    );
  });

  it('한 번에 한 사람만 다룬다', () => {
    assert.equal(REVIEWER_OPERATIONS_BOUNDARY.singleReviewerPerOperation, true);
    assert.equal(REVIEWER_OPERATIONS_BOUNDARY.bulkOperations, false);
  });

  it('검토자는 데이터베이스 역할이 아니다', () => {
    assert.equal(REVIEWER_OPERATIONS_BOUNDARY.postgresRoleGranted, false);
    // 역할을 만들거나 주는 말이 계약에 없다.
    assert.equal(/create role|grant role/i.test(CONTRACT_SOURCE), false);
  });

  it('첫 사람을 세우는 순서가 적혀 있다', () => {
    assert.equal(REVIEWER_BOOTSTRAP_PREREQUISITES.length, 6);
    const text = REVIEWER_BOOTSTRAP_PREREQUISITES.join(' ');
    assert.ok(text.includes('production'));
    assert.ok(text.includes('인증 사용자'));
    assert.ok(text.includes('승인'));
  });

  it('저절로 검토자가 되는 길이 하나도 없다', () => {
    const values = Object.values(AUTOMATIC_BOOTSTRAP_PATHS);
    assert.equal(values.length, 7);
    for (const [name, value] of Object.entries(AUTOMATIC_BOOTSTRAP_PATHS)) {
      assert.equal(value, false, name);
    }
  });
});

/* ================================================================== */
/* B. 켜는 일이 무엇을 주는가                                           */
/* ================================================================== */

describe('검토자 운영 · B. 켜진 사람의 권한', () => {
  it('켜진 사람은 목록과 꾸러미를 읽고 최종 결정까지 한다', () => {
    // 읽기만 주는 줄이 따로 없다. 그래서 "일단 켜 두고 나중에"가 성립하지 않는다.
    assert.equal(REVIEWER_EFFECTIVE_SCOPE.canReadReviewQueue, true);
    assert.equal(REVIEWER_EFFECTIVE_SCOPE.canReadReviewPacket, true);
    assert.equal(REVIEWER_EFFECTIVE_SCOPE.canSubmitFinalReview, true);
  });

  it('켜진 사람이 열게 되는 함수 셋이 실제 이름과 같다', () => {
    assert.deepEqual(
      [...REVIEWER_EFFECTIVE_SCOPE.grantedRpcs],
      [
        LIST_PUBLISHED_CONTENT_REVIEW_QUEUE_RPC,
        GET_PUBLISHED_CONTENT_REVIEW_PACKET_RPC,
        REVIEW_PUBLISHED_CONTENT_CANDIDATE_RPC,
      ],
    );

    // 위 비교만으로는 부족하다. 양쪽이 같은 값을 가져다 쓰기 때문에
    // 그 값이 바뀌면 둘 다 함께 바뀌어 검사가 통과해 버린다.
    // 그래서 실제 production에 있는 이름을 여기에 못 박는다.
    assert.deepEqual(
      [...REVIEWER_EFFECTIVE_SCOPE.grantedRpcs],
      [
        'list_published_content_review_queue',
        'get_published_content_review_packet',
        'review_published_content_candidate',
      ],
    );
  });

  it('켜진 사람도 다른 검토자를 세우지 못한다', () => {
    assert.equal(REVIEWER_EFFECTIVE_SCOPE.canManageReviewers, false);
  });

  it('켜진 사람은 글이나 연구를 적어 넣지 못한다', () => {
    assert.equal(REVIEWER_EFFECTIVE_SCOPE.canStoreCandidate, false);
    assert.equal(REVIEWER_EFFECTIVE_SCOPE.canStoreResearchResult, false);
  });

  it('켜진 사람도 표를 직접 열지 못한다', () => {
    assert.equal(REVIEWER_EFFECTIVE_SCOPE.canReadPrivateTablesDirectly, false);
  });

  it('자동화는 적어 두기까지만 한다', () => {
    assert.equal(SERVICE_ROLE_SCOPE.canStoreResearchResult, true);
    assert.equal(SERVICE_ROLE_SCOPE.canStoreCandidate, true);
    assert.deepEqual([...SERVICE_ROLE_SCOPE.grantedRpcs], [STORE_PUBLISHED_CONTENT_CANDIDATE_RPC]);
  });

  it('자동화는 읽지도 승인하지도 못한다', () => {
    assert.equal(SERVICE_ROLE_SCOPE.canReadReviewQueue, false);
    assert.equal(SERVICE_ROLE_SCOPE.canReadReviewPacket, false);
    assert.equal(SERVICE_ROLE_SCOPE.canSubmitFinalReview, false);
    assert.equal(SERVICE_ROLE_SCOPE.canManageReviewers, false);
  });

  it('사람과 자동화가 할 수 있는 일이 겹치지 않는다', () => {
    // 하나가 다른 하나의 일을 대신할 수 있으면 경계가 무너진다.
    assert.notEqual(REVIEWER_EFFECTIVE_SCOPE.canSubmitFinalReview, SERVICE_ROLE_SCOPE.canSubmitFinalReview);
    assert.notEqual(REVIEWER_EFFECTIVE_SCOPE.canStoreCandidate, SERVICE_ROLE_SCOPE.canStoreCandidate);
  });
});

/* ================================================================== */
/* C. 사람을 무엇으로 알아보는가                                        */
/* ================================================================== */

describe('검토자 운영 · C. 사람의 번호', () => {
  it('명단이 아는 것은 번호 하나뿐이다', () => {
    assert.equal(REVIEWER_OPERATIONS_BOUNDARY.identityField, 'user_id');
    assert.equal(REVIEWER_OPERATIONS_BOUNDARY.identitySource, 'auth.uid()');
  });

  it('메일 주소나 이름을 명단에 적어 두지 않는다', () => {
    assert.deepEqual([...REVIEWER_OPERATIONS_BOUNDARY.profileFieldsStored], []);
    for (const field of ['email', 'displayName', 'username', 'fullName']) {
      assert.equal(CONTRACT_SOURCE.includes(`${field}:`), false, field);
    }
  });

  it('번호 모양이 아니면 멈춘다', () => {
    // 메일 주소를 잘못 넣는 일을 여기서 막는다.
    for (const bad of ['jinhc0207@example.com', '', '   ', 'reviewer-1', USER_ID.slice(0, 20)]) {
      const plan = planReviewerActivation(input({ targetUserId: bad }));
      assert.equal(plan.action, 'hold', bad);
      assert.ok(plan.holdReasons.includes('target_user_id_invalid'), bad);
    }
  });

  it('멈추는 이유는 정해진 넷뿐이다', () => {
    assert.deepEqual(
      [...OPERATION_HOLD_REASONS],
      ['project_not_confirmed', 'approval_missing', 'auth_user_missing', 'target_user_id_invalid'],
    );
  });
});

/* ================================================================== */
/* D. 켜기                                                              */
/* ================================================================== */

describe('검토자 운영 · D. 켜기', () => {
  it('상태는 셋뿐이다', () => {
    assert.deepEqual([...REVIEWER_REGISTRY_STATES], ['missing', 'inactive', 'active']);
  });

  it('줄이 없으면 켜진 줄 하나를 새로 넣는다', () => {
    const plan = planReviewerActivation(input({ registryState: 'missing' }));
    assert.equal(plan.action, 'insert_active');
    assert.equal(plan.writeCount, 1);
    assert.deepEqual(plan.holdReasons, []);
    assert.equal(plan.targetUserId, USER_ID);
  });

  it('꺼진 줄이 있으면 그 줄을 켠다', () => {
    const plan = planReviewerActivation(input({ registryState: 'inactive' }));
    assert.equal(plan.action, 'set_active_true');
    assert.equal(plan.writeCount, 1);
  });

  it('없는 사람을 넣는 것과 다시 켜는 것을 구분한다', () => {
    // 하나로 뭉뚱그려 덮어쓰면 운영자가 무엇을 하는지 모르고 실행하게 된다.
    const fresh = planReviewerActivation(input({ registryState: 'missing' }));
    const again = planReviewerActivation(input({ registryState: 'inactive' }));
    assert.notEqual(fresh.action, again.action);
    assert.equal(REVIEWER_OPERATIONS_BOUNDARY.blindUpsert, false);
  });

  it('이미 켜져 있으면 아무것도 하지 않는다', () => {
    const plan = planReviewerActivation(input({ registryState: 'active' }));
    assert.equal(plan.action, 'already_active');
    assert.equal(plan.writeCount, 0);
  });

  it('같은 값을 두 번 넣어도 결과가 같다', () => {
    const first = planReviewerActivation(input({ registryState: 'active' }));
    const second = planReviewerActivation(input({ registryState: 'active' }));
    assert.deepEqual(first, second);
  });

  it('인증 사용자가 없으면 켜지 않는다', () => {
    for (const state of REVIEWER_REGISTRY_STATES) {
      const plan = planReviewerActivation(input({ registryState: state, authUserExists: false }));
      assert.equal(plan.action, 'hold', state);
      assert.equal(plan.writeCount, 0, state);
      assert.ok(plan.holdReasons.includes('auth_user_missing'), state);
    }
    assert.equal(REVIEWER_OPERATIONS_BOUNDARY.activationRequiresExistingAuthUser, true);
  });

  it('승인이 없으면 켜지 않는다', () => {
    const plan = planReviewerActivation(input({ explicitApprovalGiven: false }));
    assert.equal(plan.action, 'hold');
    assert.ok(plan.holdReasons.includes('approval_missing'));
  });

  it('프로젝트를 확인하지 않았으면 켜지 않는다', () => {
    const plan = planReviewerActivation(input({ projectIdentityConfirmed: false }));
    assert.equal(plan.action, 'hold');
    assert.ok(plan.holdReasons.includes('project_not_confirmed'));
  });

  it('못 갖춘 것이 여럿이면 모두 알려준다', () => {
    const plan = planReviewerActivation(
      input({ authUserExists: false, explicitApprovalGiven: false, projectIdentityConfirmed: false }),
    );
    assert.equal(plan.action, 'hold');
    assert.equal(plan.holdReasons.length, 3);
  });

  it('이미 켜져 있어도 못 갖춘 것이 있으면 멈춘다', () => {
    // 프로젝트가 맞는지 모르는 채로 읽은 상태는 그 사람의 상태라고 믿을 수 없다.
    const plan = planReviewerActivation(
      input({ registryState: 'active', projectIdentityConfirmed: false }),
    );
    assert.equal(plan.action, 'hold');
  });
});

/* ================================================================== */
/* E. 끄기                                                              */
/* ================================================================== */

describe('검토자 운영 · E. 끄기', () => {
  it('켜져 있으면 끈다', () => {
    const plan = planReviewerDeactivation(input({ registryState: 'active' }));
    assert.equal(plan.action, 'set_active_false');
    assert.equal(plan.writeCount, 1);
  });

  it('이미 꺼져 있으면 아무것도 하지 않는다', () => {
    const plan = planReviewerDeactivation(input({ registryState: 'inactive' }));
    assert.equal(plan.action, 'already_inactive');
    assert.equal(plan.writeCount, 0);
  });

  it('줄이 없으면 만들었다가 끄지 않는다', () => {
    const plan = planReviewerDeactivation(input({ registryState: 'missing' }));
    assert.equal(plan.action, 'not_registered');
    assert.equal(plan.writeCount, 0);
  });

  it('인증 사용자가 없어도 끌 수 있다', () => {
    // 계정이 사라졌는데 명단만 켜져 있으면, 그 문을 닫을 방법이 있어야 한다.
    const plan = planReviewerDeactivation(input({ registryState: 'active', authUserExists: false }));
    assert.equal(plan.action, 'set_active_false');
    assert.equal(plan.writeCount, 1);
    assert.deepEqual(plan.holdReasons, []);
    assert.equal(REVIEWER_OPERATIONS_BOUNDARY.deactivationRequiresExistingAuthUser, false);
  });

  it('켜는 일과 끄는 일의 인증 조건이 다르다', () => {
    // 이 차이가 이 계약의 핵심 중 하나다.
    const withoutUser = input({ registryState: 'active', authUserExists: false });
    assert.equal(planReviewerActivation(withoutUser).action, 'hold');
    assert.equal(planReviewerDeactivation(withoutUser).action, 'set_active_false');
  });

  it('승인이 없으면 끄지 않는다', () => {
    const plan = planReviewerDeactivation(
      input({ registryState: 'active', explicitApprovalGiven: false }),
    );
    assert.equal(plan.action, 'hold');
    assert.ok(plan.holdReasons.includes('approval_missing'));
  });

  it('프로젝트를 확인하지 않았으면 끄지 않는다', () => {
    const plan = planReviewerDeactivation(
      input({ registryState: 'active', projectIdentityConfirmed: false }),
    );
    assert.equal(plan.action, 'hold');
    assert.ok(plan.holdReasons.includes('project_not_confirmed'));
  });

  it('끄는 일에 인증 사용자 없음이 이유로 붙지 않는다', () => {
    const plan = planReviewerDeactivation(
      input({ registryState: 'active', authUserExists: false, explicitApprovalGiven: false }),
    );
    assert.equal(plan.holdReasons.includes('auth_user_missing'), false);
  });
});

/* ================================================================== */
/* F. 지우지 않는다                                                     */
/* ================================================================== */

describe('검토자 운영 · F. 지우지 않기', () => {
  it('끄는 일의 결과에 지우는 것이 없다', () => {
    assert.deepEqual(
      [...DEACTIVATION_ACTIONS],
      ['hold', 'set_active_false', 'already_inactive', 'not_registered'],
    );
    assert.equal(REVIEWER_OPERATIONS_BOUNDARY.deactivationUsesDelete, false);
  });

  it('어떤 결과에도 지우거나 없애는 말이 없다', () => {
    for (const action of [...ACTIVATION_ACTIONS, ...DEACTIVATION_ACTIONS]) {
      for (const banned of ['delete', 'remove', 'drop', 'purge', 'truncate']) {
        assert.equal(action.includes(banned), false, `${action} / ${banned}`);
      }
    }
  });

  it('어떤 계획도 지우는 일을 내놓지 않는다', () => {
    const states: ReviewerRegistryState[] = [...REVIEWER_REGISTRY_STATES];
    for (const state of states) {
      for (const authUserExists of [true, false]) {
        for (const plan of [
          planReviewerActivation(input({ registryState: state, authUserExists })),
          planReviewerDeactivation(input({ registryState: state, authUserExists })),
        ]) {
          const serialized = JSON.stringify(plan);
          for (const banned of ['delete', 'remove', 'drop']) {
            assert.equal(serialized.includes(banned), false, `${state} / ${banned}`);
          }
        }
      }
    }
  });

  it('끄는 일이 지난 결정과 게시된 글을 건드리지 않는다', () => {
    const text = operations.DEACTIVATION_DOES_NOT_CHANGE.join(' ');
    assert.ok(text.includes('이미 내려진 결정'));
    assert.ok(text.includes('이미 게시된 글'));
    assert.ok(text.includes('처음 적힌 시각'));
  });

  it('사라진 계정의 줄을 자동으로 정리하지 않는다', () => {
    assert.equal(REVIEWER_OPERATIONS_BOUNDARY.automaticStaleCleanup, false);
    assert.ok(operations.STALE_ACTIVE_REVIEWER_NOTE.includes('자동으로 지우지 않는다'));
  });
});

/* ================================================================== */
/* G. 처음 적힌 시각                                                    */
/* ================================================================== */

describe('검토자 운영 · G. 시각', () => {
  it('처음 적힌 시각은 표가 붙인다', () => {
    assert.equal(REVIEWER_OPERATIONS_BOUNDARY.createdAtSource, 'db_default');
  });

  it('어떤 계획도 그 시각을 고치지 않는다', () => {
    assert.equal(REVIEWER_OPERATIONS_BOUNDARY.createdAtMutation, false);
    for (const state of REVIEWER_REGISTRY_STATES) {
      assert.equal(planReviewerActivation(input({ registryState: state })).mutatesCreatedAt, false);
      assert.equal(planReviewerDeactivation(input({ registryState: state })).mutatesCreatedAt, false);
    }
  });

  it('다시 켜도 그 시각을 새로 쓰지 않는다', () => {
    const plan = planReviewerActivation(input({ registryState: 'inactive' }));
    assert.equal(plan.action, 'set_active_true');
    assert.equal(plan.mutatesCreatedAt, false);
  });
});

/* ================================================================== */
/* H. 켜고 끄는 일이 바꾸지 않는 것                                     */
/* ================================================================== */

describe('검토자 운영 · H. 바꾸지 않는 것', () => {
  it('켜는 일은 명단 한 줄 말고 아무것도 바꾸지 않는다', () => {
    const text = operations.ACTIVATION_DOES_NOT_CHANGE.join(' ');
    for (const item of ['인증 쪽의 역할', 'JWT', '표의 직접 권한', '함수의 실행 권한', 'RLS']) {
      assert.ok(text.includes(item), item);
    }
  });

  it('어떤 계획도 인증 쪽을 바꾸지 않는다', () => {
    for (const banned of [
      'createAuthUser',
      'deleteAuthUser',
      'modifyAuthUser',
      'setClaims',
      'setRole',
    ]) {
      assert.equal(CONTRACT_SOURCE.includes(banned), false, banned);
    }
  });

  it('계획은 한 줄만 바꾼다', () => {
    for (const state of REVIEWER_REGISTRY_STATES) {
      for (const plan of [
        planReviewerActivation(input({ registryState: state })),
        planReviewerDeactivation(input({ registryState: state })),
      ]) {
        assert.ok(plan.writeCount === 0 || plan.writeCount === 1, state);
      }
    }
  });
});

/* ================================================================== */
/* I. 계획은 계획일 뿐이다                                              */
/* ================================================================== */

describe('검토자 운영 · I. 계획의 경계', () => {
  it('계획에 SQL도 주소도 열쇠도 없다', () => {
    for (const state of REVIEWER_REGISTRY_STATES) {
      const serialized =
        JSON.stringify(planReviewerActivation(input({ registryState: state }))) +
        JSON.stringify(planReviewerDeactivation(input({ registryState: state })));
      for (const banned of [
        'insert into',
        'update ',
        'select ',
        'http',
        'postgres://',
        'service_role',
        'apikey',
        'Bearer',
      ]) {
        assert.equal(serialized.toLowerCase().includes(banned.toLowerCase()), false, banned);
      }
    }
  });

  it('계획이 돌려주는 항목은 다섯뿐이다', () => {
    const plan = planReviewerActivation(input());
    assert.deepEqual(Object.keys(plan).sort(), [
      'action',
      'holdReasons',
      'mutatesCreatedAt',
      'targetUserId',
      'writeCount',
    ]);
  });

  it('여러 사람을 한꺼번에 받지 않는다', () => {
    // 입력에 목록이 있으면 한 번의 승인으로 여러 사람이 열릴 수 있다.
    for (const banned of ['userIds', 'targetUserIds', 'reviewers:']) {
      assert.equal(CONTRACT_SOURCE.includes(banned), false, banned);
    }

    // 받는 값의 정의만 본다. 계약 전체에서 대괄호를 찾으면
    // profileFieldsStored 같은 정당한 목록에도 걸린다.
    const start = CONTRACT_SOURCE.indexOf('export type ReviewerOperationInput = {');
    assert.notEqual(start, -1);
    const block = CONTRACT_SOURCE.slice(start, CONTRACT_SOURCE.indexOf('};', start));
    assert.equal(block.includes('[]'), false, block);
    assert.equal(block.includes('Array<'), false, block);

    assert.equal(typeof planReviewerActivation(input()).targetUserId, 'string');

    // 목록을 억지로 넣어도 번호 모양이 아니라서 멈춘다.
    const forced = planReviewerActivation(
      input({ targetUserId: [USER_ID, USER_ID] as unknown as string }),
    );
    assert.equal(forced.action, 'hold');
  });

  it('바깥과 이야기하지 않는다', () => {
    for (const banned of [
      'Deno.env',
      'process.env',
      'fetch(',
      'createClient',
      'readFileSync',
      'XMLHttpRequest',
    ]) {
      assert.equal(CONTRACT_SOURCE.includes(banned), false, banned);
    }
  });

  it('부를 때마다 같은 답을 낸다', () => {
    for (const banned of ['Date.now', 'randomUUID', 'Math.random', 'new Date(', 'crypto']) {
      assert.equal(CONTRACT_SOURCE.includes(banned), false, banned);
    }
    assert.deepEqual(planReviewerActivation(input()), planReviewerActivation(input()));
  });

  it('SQL을 적지 않는다', () => {
    for (const banned of ['create table', 'create function', 'insert into', 'update set']) {
      assert.equal(CONTRACT_SOURCE.toLowerCase().includes(banned), false, banned);
    }
  });

  it('화면 코드와 모델을 가져오지 않는다', () => {
    // 어디서 가져오는지만 본다. 글자만 보면 export 안의 expo 같은 것에 걸린다.
    const specifiers = [...CONTRACT_SOURCE.matchAll(/from '([^']+)'/g)].map((m) => m[1] as string);
    assert.ok(specifiers.length > 0);
    for (const banned of ['react', 'expo', 'openai']) {
      assert.equal(
        specifiers.some((path) => path.toLowerCase().includes(banned)),
        false,
        banned,
      );
    }
    for (const path of specifiers) {
      assert.ok(path.startsWith('./'), path);
    }
  });

  it('검토자를 실제로 켜고 끄는 함수를 내보내지 않는다', () => {
    // 내보내는 함수는 계획을 세우는 둘뿐이다.
    const exportedFunctions = Object.entries(operations)
      .filter(([, value]) => typeof value === 'function')
      .map(([name]) => name)
      .sort();
    assert.deepEqual(exportedFunctions, ['planReviewerActivation', 'planReviewerDeactivation']);
  });
});

/* ================================================================== */
/* J. 한계                                                              */
/* ================================================================== */

describe('검토자 운영 · J. 한계', () => {
  it('명단이 변경 이력을 남기지 않는다는 것을 적었다', () => {
    assert.equal(REVIEWER_OPERATIONS_BOUNDARY.currentStateOnly, true);
    assert.equal(REVIEWER_OPERATIONS_BOUNDARY.fullManagementHistoryRetained, false);
  });

  it('무엇을 지키고 무엇을 못 지키는지 적었다', () => {
    assert.ok(REVIEWER_OPERATIONS_LIMITATION.guarantees.includes('승인'));
    const text = REVIEWER_OPERATIONS_LIMITATION.doesNotGuarantee.join(' ');
    assert.ok(REVIEWER_OPERATIONS_LIMITATION.doesNotGuarantee.length >= 5);
    assert.ok(text.includes('관리자'));
    assert.ok(text.includes('빼앗겼을 때'));
    assert.ok(text.includes('물리적 증명'));
  });

  it('막을 수 없는 것을 막는다고 적지 않았다', () => {
    for (const line of CONTRACT_SOURCE.split('\n')) {
      if (!line.includes('절대') && !line.includes('완전히')) continue;
      assert.ok(
        line.includes('않는다') || line.includes('아니다') || line.includes('뜻이 아니다'),
        line,
      );
    }
  });
});
