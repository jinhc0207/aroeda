/**
 * 게시 콘텐츠 보관소 migration · 계약 테스트
 *
 * 실행: npm test
 *
 * 왜 이 테스트가 필요한가
 *   승인 함수는 로그인한 사람에게 열린다. 우리 앱을 거치지 않고 직접 부를 수 있다.
 *   그래서 결정 종류·확인 항목·반려 이유를 DB가 스스로 알고 막아야 하고,
 *   그 값들이 SQL 안에 한 벌 더 적혀 있다.
 *
 *   값이 두 곳에 있으면 언젠가 갈라진다.
 *   갈라지는 쪽이 SQL이면, 사람이 확인하지 않은 글이 게시될 수 있다.
 *
 *   이 테스트가 그 갈라짐을 먼저 잡는다.
 *   TypeScript를 고쳐도, SQL을 고쳐도, 둘이 다르면 여기서 멈춘다.
 *
 * 이 테스트는 DB를 건드리지 않는다.
 *   migration을 적용하지 않고 글자로만 확인한다.
 *   그래서 "이 SQL이 실제로 돈다"는 것은 확인하지 못한다.
 *   문법과 실제 동작은 적용 전 별도 단계에서 확인해야 한다.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import {
  CANDIDATE_HASH_FORMAT,
  REJECTION_REASONS,
  REVIEW_CHECKS,
  REVIEW_DECISIONS,
} from '../../supabase/functions/_shared/published-content-contract.ts';
import { RESEARCH_RESULT_HASH_FORMAT } from '../../supabase/functions/_shared/research-result-store-contract.ts';
import {
  PUBLISHED_CONTENT_TABLES,
  REVIEW_PUBLISHED_CONTENT_CANDIDATE_RPC,
  STORE_PUBLISHED_CONTENT_CANDIDATE_RPC,
} from '../../supabase/functions/_shared/published-content-store-contract.ts';

const MIGRATION_PATH =
  '../../supabase/migrations/20260905163654_create_published_content_store.sql';
const SQL = readFileSync(new URL(MIGRATION_PATH, import.meta.url), 'utf8');

/** 설명 주석에는 예시가 적혀 있다. 동작을 볼 때는 주석을 뺀 것만 본다. */
const CODE = SQL.split('\n')
  .filter((line) => !/^\s*--/.test(line))
  .join('\n');

/**
 * SQL 안의 `array[...]` 목록 하나를 값 그대로 읽어 온다.
 *
 * 조각으로 찾지 않는다. 이름을 집어 그 괄호 안만 읽는다.
 * 그래야 주석에 같은 낱말이 있어도 헷갈리지 않는다.
 */
function readSqlArray(name: string): string[] {
  const pattern = new RegExp(`${name}\\s+constant\\s+text\\[\\]\\s*:=\\s*array\\[([\\s\\S]*?)\\]`);
  const match = CODE.match(pattern);
  assert.ok(match, `SQL에서 ${name} 목록을 찾지 못했습니다.`);

  return match![1]
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
    .map((item) => {
      assert.match(item, /^'[^']*'$/, `${name}의 값이 문자열이 아닙니다: ${item}`);
      return item.slice(1, -1);
    });
}

/** SQL의 정규식 조건 하나를 읽어 온다. */
function readSqlRegex(constraintName: string): string {
  const pattern = new RegExp(`constraint ${constraintName}\\s*\\n\\s*check \\([a-z_]+ ~ '([^']+)'\\)`);
  const match = CODE.match(pattern);
  assert.ok(match, `SQL에서 ${constraintName} 조건을 찾지 못했습니다.`);
  return match![1];
}

/* ================================================================== */
/* A. 두 곳에 적힌 값이 같은가                                          */
/* ================================================================== */

describe('게시 보관소 migration · A. SQL 사본이 계약과 같은가', () => {
  it('결정 종류가 같다', () => {
    assert.deepEqual(readSqlArray('v_allowed_decisions'), [...REVIEW_DECISIONS]);
  });

  it('확인 항목이 이름도 차례도 같다', () => {
    // 차례까지 맞춘다. 순서가 달라도 동작은 같지만,
    // 두 곳을 나란히 놓고 읽을 때 다르면 사람이 먼저 헷갈린다.
    assert.deepEqual(readSqlArray('v_required_checklist_keys'), [...REVIEW_CHECKS]);
  });

  it('반려 이유가 같다', () => {
    assert.deepEqual(readSqlArray('v_allowed_rejection_reasons'), [...REJECTION_REASONS]);
  });

  it('글 지문 모양이 같다', () => {
    // 조각으로 찾지 않고 조건에서 정규식을 그대로 꺼내 비교한다.
    assert.equal(
      readSqlRegex('published_content_candidate_hash_format'),
      CANDIDATE_HASH_FORMAT.source,
    );
  });

  it('연구 지문 모양이 같다', () => {
    assert.equal(
      readSqlRegex('published_content_candidate_research_hash_format'),
      RESEARCH_RESULT_HASH_FORMAT.source,
    );
  });

  it('승인 함수도 같은 글 지문 모양을 쓴다', () => {
    // 함수 안에서 다른 모양을 쓰면 표와 함수가 어긋난다.
    const inFunction = CODE.match(/p_candidate_hash !~ '([^']+)'/);
    assert.ok(inFunction);
    assert.equal(inFunction![1], CANDIDATE_HASH_FORMAT.source);
  });

  it('SQL에 적힌 목록을 실제로 검사에 쓴다', () => {
    // 목록만 적어 두고 정작 다른 값으로 검사하면 사본이 장식이 된다.
    assert.ok(CODE.includes('p_decision = any (v_allowed_decisions)'));
    assert.ok(CODE.includes('foreach v_key in array v_required_checklist_keys'));
    assert.ok(CODE.includes('v_reason = any (v_allowed_rejection_reasons)'));
  });
});

/* ================================================================== */
/* B. 무엇을 만드는가                                                   */
/* ================================================================== */

describe('게시 보관소 migration · B. 만드는 것', () => {
  it('표 네 개를 만든다', () => {
    const tables = [...CODE.matchAll(/create table (private\.[a-z_]+)/g)].map((m) => m[1]);
    assert.deepEqual(tables.sort(), [
      PUBLISHED_CONTENT_TABLES.published,
      PUBLISHED_CONTENT_TABLES.candidate,
      PUBLISHED_CONTENT_TABLES.review,
      PUBLISHED_CONTENT_TABLES.reviewer,
    ].sort());
  });

  it('부를 수 있는 함수는 둘뿐이다', () => {
    const rpcs = [...CODE.matchAll(/create or replace function (public\.[a-z_]+)/g)].map(
      (m) => m[1],
    );
    assert.deepEqual(rpcs.sort(), [
      `public.${REVIEW_PUBLISHED_CONTENT_CANDIDATE_RPC}`,
      `public.${STORE_PUBLISHED_CONTENT_CANDIDATE_RPC}`,
    ].sort());
  });

  it('게시만 따로 하는 함수를 만들지 않는다', () => {
    // 나누면 자동화가 승인을 건너뛰거나, 승인만 있고 글이 없는 상태가 생긴다.
    for (const banned of [
      'publish_published_content',
      'publish_candidate',
      'materialize_published_content',
      'approve_then_publish',
    ]) {
      assert.equal(CODE.includes(banned), false, banned);
    }
  });

  it('검토자를 관리하는 함수도 읽는 함수도 만들지 않는다', () => {
    for (const banned of [
      'activate_reviewer',
      'deactivate_reviewer',
      'add_published_content_reviewer',
      'get_published_content',
      'list_published_content',
    ]) {
      assert.equal(CODE.includes(banned), false, banned);
    }
  });

  it('기존 것을 지우거나 고치지 않는다', () => {
    assert.equal(/\bdrop\b/i.test(CODE), false);
    // 손대는 표는 이번에 만든 넷뿐이다.
    const altered = [...CODE.matchAll(/alter table (private\.[a-z_]+)/g)].map((m) => m[1]);
    for (const table of altered) {
      assert.ok(Object.values(PUBLISHED_CONTENT_TABLES).includes(table as never), table);
    }
    // 앞의 보관소들을 건드리지 않는다.
    for (const banned of ['research_result_id', 'biblical_research_handoff', 'prioritizer_decision']) {
      assert.equal(CODE.includes(banned), false, banned);
    }
  });

  it('줄을 넣어 두지 않는다', () => {
    // 함수 몸 밖에서 데이터를 만들지 않는다. 검토자도 넣지 않는다.
    // 'insert' 조각으로 보면 트리거 정의(before insert on ...)까지 걸린다.
    // 실제로 줄을 넣는 구문만 본다.
    const outsideFunctions = CODE.replace(/as \$\$[\s\S]*?\$\$;/g, '');
    assert.equal(/insert\s+into/i.test(outsideFunctions), false);
    assert.equal(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/.test(CODE), false);
  });
});

/* ================================================================== */
/* C. 표의 모양                                                        */
/* ================================================================== */

describe('게시 보관소 migration · C. 표', () => {
  const tableBody = (name: string) => {
    const match = CODE.match(new RegExp(`create table ${name} \\(([\\s\\S]*?)\\n\\);`));
    assert.ok(match, name);
    return match![1];
  };

  it('글의 지문이 줄의 이름이다', () => {
    assert.ok(tableBody(PUBLISHED_CONTENT_TABLES.candidate).includes('candidate_hash text primary key'));
    assert.ok(tableBody(PUBLISHED_CONTENT_TABLES.published).includes('candidate_hash text primary key'));
  });

  it('글은 실제로 남아 있는 연구에만 붙는다', () => {
    const body = tableBody(PUBLISHED_CONTENT_TABLES.candidate);
    assert.ok(body.includes('references private.research_result (result_hash)'));
    assert.ok(body.includes('on delete restrict'));
  });

  it('한 글에 결정은 하나뿐이다', () => {
    assert.ok(
      tableBody(PUBLISHED_CONTENT_TABLES.review).includes('candidate_hash text not null unique'),
    );
  });

  it('키가 없을 때 조건이 조용히 통과하지 않는다', () => {
    // ->> 만 쓰면 키가 없을 때 NULL이 되고, NULL 비교는 조건을 통과시킨다.
    // 그래서 존재 여부를 함께 본다.
    for (const [table, key] of [
      [PUBLISHED_CONTENT_TABLES.candidate, 'researchResultHash'],
      [PUBLISHED_CONTENT_TABLES.review, 'candidateHash'],
      [PUBLISHED_CONTENT_TABLES.review, 'reviewAuthority'],
      [PUBLISHED_CONTENT_TABLES.published, 'candidateHash'],
    ] as const) {
      const body = tableBody(table);
      assert.ok(body.includes(`jsonb_exists(`), table);
      assert.ok(body.includes(`'${key}'`), `${table} / ${key}`);
    }
  });

  it('사람 자격이 아닌 결정은 남을 수 없다', () => {
    const body = tableBody(PUBLISHED_CONTENT_TABLES.review);
    assert.ok(body.includes("review ->> 'reviewAuthority' = 'human'"));
  });

  it('게시된 글에 진행 상태와 검토자를 두지 않는다', () => {
    const body = tableBody(PUBLISHED_CONTENT_TABLES.published);
    for (const banned of ['status', 'reviewer', 'published_at', 'reviewed_at', 'decision']) {
      assert.equal(body.includes(banned), false, banned);
    }
  });

  it('검토자 명단은 인증 표를 가리키지 않고 기본이 꺼짐이다', () => {
    const body = tableBody(PUBLISHED_CONTENT_TABLES.reviewer);
    assert.ok(body.includes('is_active boolean not null default false'));
    assert.equal(CODE.includes('auth.users'), false);
    // 이름이나 메일 주소를 베껴 두지 않는다.
    for (const banned of ['email', 'name', 'display']) {
      assert.equal(body.includes(banned), false, banned);
    }
  });

  it('영역 이름 같은 값을 밖에 또 두지 않는다', () => {
    for (const banned of ['target_domain', 'reference_label', 'user_explanation', 'prayer_direction']) {
      assert.equal(CODE.includes(banned), false, banned);
    }
  });
});

/* ================================================================== */
/* D. 고쳐 쓰지 못한다                                                  */
/* ================================================================== */

describe('게시 보관소 migration · D. 불변', () => {
  const triggersOn = (table: string) =>
    [...CODE.matchAll(new RegExp(`create trigger ([a-z_]+)\\n(before [a-z ]+) on ${table}`, 'g'))]
      .map((m) => m[2].trim());

  it('세 표는 고치지도 지우지도 비우지도 못한다', () => {
    for (const table of [
      PUBLISHED_CONTENT_TABLES.candidate,
      PUBLISHED_CONTENT_TABLES.review,
      PUBLISHED_CONTENT_TABLES.published,
    ]) {
      const events = triggersOn(table);
      assert.ok(events.includes('before update or delete'), table);
      assert.ok(events.includes('before truncate'), table);
    }
  });

  it('검토자 명단은 고칠 수 있다', () => {
    // 권한을 주고 거두는 일이 있어야 한다.
    assert.deepEqual(triggersOn(PUBLISHED_CONTENT_TABLES.reviewer), []);
  });

  it('막는 함수는 하나를 함께 쓴다', () => {
    const uses = (CODE.match(/execute function private\.reject_published_content_mutation\(\)/g) ?? [])
      .length;
    assert.equal(uses, 6);
    assert.equal(
      (CODE.match(/create or replace function private\.reject_published_content_mutation/g) ?? [])
        .length,
      1,
    );
  });

  it('앞 보관소의 막는 함수를 건드리지 않는다', () => {
    assert.equal(CODE.includes('reject_research_result_mutation'), false);
  });

  it('오류 문구에 저장된 내용을 담지 않는다', () => {
    const fn = CODE.match(
      /create or replace function private\.reject_published_content_mutation[\s\S]*?\$\$;/,
    )![0];
    assert.equal(/new\.|old\./i.test(fn), false);
  });
});

/* ================================================================== */
/* E. 누가 무엇을 할 수 있는가                                          */
/* ================================================================== */

describe('게시 보관소 migration · E. 권한', () => {
  it('네 표 모두 직접 열 수 없다', () => {
    for (const table of Object.values(PUBLISHED_CONTENT_TABLES)) {
      assert.ok(CODE.includes(`revoke all on table ${table} from public;`), table);
      assert.ok(
        CODE.includes(`revoke all on table ${table} from anon, authenticated, service_role;`),
        table,
      );
    }
    // 표에 직접 권한을 주는 구문이 하나도 없다.
    assert.equal(/grant[^;]*on table/i.test(CODE), false);
  });

  it('글을 적어 두는 함수는 서버만 부른다', () => {
    const name = `public.${STORE_PUBLISHED_CONTENT_CANDIDATE_RPC}(text, text, jsonb)`;
    assert.ok(CODE.includes(`revoke all on function ${name} from public;`));
    assert.ok(CODE.includes('from anon, authenticated, service_role;'));
    assert.ok(CODE.includes(`grant execute on function ${name} to service_role;`));
  });

  it('승인 함수는 로그인한 사람만 부른다', () => {
    const name = `public.${REVIEW_PUBLISHED_CONTENT_CANDIDATE_RPC}(text, text, jsonb, text[])`;
    assert.ok(CODE.includes(`revoke all on function ${name} from public;`));
    assert.ok(CODE.includes(`grant execute on function ${name} to authenticated;`));
  });

  it('서버 열쇠로는 승인할 수 없다', () => {
    // 이것이 이 설계의 중심이다.
    const grants = [...CODE.matchAll(/grant execute on function ([^;]+) to ([a-z_]+);/g)].map(
      (m) => [m[1].trim(), m[2]] as const,
    );
    const reviewGrants = grants.filter(([fn]) =>
      fn.includes(REVIEW_PUBLISHED_CONTENT_CANDIDATE_RPC),
    );
    assert.deepEqual(
      reviewGrants.map(([, role]) => role),
      ['authenticated'],
    );
  });

  it('PUBLIC에서 회수하는 것을 빠뜨리지 않았다', () => {
    // 함수는 기본으로 PUBLIC 실행 권한이 생긴다.
    // 이것을 빠뜨리면 서버 열쇠가 그 길로 들어온다.
    const revokedFromPublic = (CODE.match(/revoke all on function [^;]+ from public;/g) ?? []).length;
    assert.equal(revokedFromPublic, 2);
  });

  it('실행 권한을 주는 곳은 두 곳뿐이다', () => {
    const grants = [...CODE.matchAll(/grant execute on function [^;]+ to ([a-z_]+);/g)].map(
      (m) => m[1],
    );
    assert.deepEqual(grants.sort(), ['authenticated', 'service_role']);
  });
});

/* ================================================================== */
/* F. 잠금과 정책                                                       */
/* ================================================================== */

describe('게시 보관소 migration · F. RLS', () => {
  it('네 표 모두 잠금을 켠다', () => {
    for (const table of Object.values(PUBLISHED_CONTENT_TABLES)) {
      assert.ok(CODE.includes(`alter table ${table} enable row level security;`), table);
    }
  });

  it('정책은 만들지 않는다', () => {
    assert.equal(/create policy/i.test(CODE), false);
  });

  it('force rls를 쓰지 않는다', () => {
    // 앞의 표들이 쓰지 않는다. 새로 도입할 이유가 없다.
    assert.equal(/force row level security/i.test(CODE), false);
  });
});

/* ================================================================== */
/* G. 검토자 신원                                                       */
/* ================================================================== */

describe('게시 보관소 migration · G. 누가 검토하는가', () => {
  const reviewFn = () =>
    CODE.match(
      new RegExp(
        `create or replace function public\\.${REVIEW_PUBLISHED_CONTENT_CANDIDATE_RPC}[\\s\\S]*?\\$\\$;`,
      ),
    )![0];

  it('검토자 번호를 요청에서 받지 않는다', () => {
    const signature = reviewFn().match(/\(([\s\S]*?)\)\s*\nreturns/)![1];
    assert.deepEqual(
      [...signature.matchAll(/(p_[a-z_]+)\s/g)].map((m) => m[1]),
      ['p_candidate_hash', 'p_decision', 'p_checklist', 'p_rejection_reasons'],
    );
    for (const banned of ['p_reviewer', 'p_authority', 'p_candidate ', 'p_content', 'p_status']) {
      assert.equal(signature.includes(banned), false, banned);
    }
  });

  it('인증이 아는 값을 읽는다', () => {
    assert.ok(reviewFn().includes('auth.uid()'));
  });

  it('명단에 있고 켜져 있어야 한다', () => {
    // 글자가 남아 있는 것과 실제로 막는 것은 다르다.
    // 조건문 전체를 집어서, 명단 조회가 그 조건 안에 있는지 본다.
    const guard = reviewFn().match(
      /if not exists \(\s*\n\s*select 1\s*\n\s*from private\.published_content_reviewer[\s\S]*?\n\s*\) then/,
    );
    assert.ok(guard, '검토자 명단을 확인하는 조건문을 찾지 못했습니다.');
    assert.ok(guard![0].includes('where user_id = v_reviewer_user_id'));
    assert.ok(guard![0].includes('and is_active'));
  });

  it('승인은 일곱 항목이 모두 참일 때만 성립한다', () => {
    // 목록을 도는 반복문이 있다는 것만으로는 부족하다.
    // 참인지 실제로 보는 식이 있어야 한다.
    assert.ok(reviewFn().includes("(p_checklist -> v_key) <> 'true'::jsonb"));
  });

  it('막는 검사를 꺼 둔 자리가 없다', () => {
    // 조건을 if false 로 바꿔 두면 글자는 남고 검사만 사라진다.
    // 실제 SQL에 이런 식이 있을 이유가 없다.
    assert.equal(/\bif\s+false\b/i.test(CODE), false);
    assert.equal(/\band\s+false\b/i.test(CODE), false);
    assert.equal(/\bor\s+true\b/i.test(CODE), false);
  });

  it('자격은 서버가 붙인다', () => {
    // 부르는 쪽이 "나는 사람이다"라고 적어 보내서 얻는 것이 아니다.
    assert.ok(reviewFn().includes("'reviewAuthority', 'human'"));
  });

  it('결정 기록을 서버가 만든다', () => {
    // 부르는 쪽이 통째로 보낸 것을 그대로 적지 않는다.
    const fn = reviewFn();
    assert.ok(fn.includes('v_review := jsonb_build_object('));
    assert.ok(fn.includes("'candidateHash', p_candidate_hash"));
  });
});

/* ================================================================== */
/* H. 승인과 게시                                                       */
/* ================================================================== */

describe('게시 보관소 migration · H. 승인과 게시', () => {
  const reviewFn = () =>
    CODE.match(
      new RegExp(
        `create or replace function public\\.${REVIEW_PUBLISHED_CONTENT_CANDIDATE_RPC}[\\s\\S]*?\\$\\$;`,
      ),
    )![0];

  it('같은 함수 안에서 결정과 게시를 함께 적는다', () => {
    const fn = reviewFn();
    assert.ok(fn.includes(`insert into ${PUBLISHED_CONTENT_TABLES.review}`));
    assert.ok(fn.includes(`insert into ${PUBLISHED_CONTENT_TABLES.published}`));
  });

  it('게시는 승인일 때만 한다', () => {
    const fn = reviewFn();
    const publishAt = fn.indexOf(`insert into ${PUBLISHED_CONTENT_TABLES.published}`);
    const guardAt = fn.lastIndexOf("if p_decision = 'approve' then", publishAt);
    assert.ok(guardAt > 0 && guardAt < publishAt);
  });

  it('실패를 삼키는 자리가 없다', () => {
    // exception을 잡아 두면 결정만 남고 글이 없는 상태가 생긴다.
    assert.equal(reviewFn().includes('exception when'), false);
  });

  it('게시할 글은 적혀 있는 것에서 만든다', () => {
    // 부르는 쪽이 보낸 것에서 만들지 않는다.
    const fn = reviewFn();
    assert.ok(fn.includes("v_candidate || jsonb_build_object('candidateHash', p_candidate_hash)"));
  });

  it('항목 이름을 SQL에 나열하지 않는다', () => {
    // 게시 콘텐츠는 검토 대상 글에 지문 하나를 더한 것이다.
    // 나열하면 계약이 바뀔 때 여기가 뒤처진다.
    for (const banned of [
      'situationTags',
      'emotionTags',
      'spiritualQuestionTags',
      'prayerModes',
      'pastoralFunction',
      'contextSummary',
      'theologicalInsight',
      'userExplanation',
      'prayerDirection',
      'misuseGuards',
      'referenceLabel',
      'targetDomain',
    ]) {
      // 따옴표까지 붙여 본다. 조각으로 보면 확인 항목 이름
      // misuseGuardsAdequate 같은 정당한 값이 걸린다.
      assert.equal(CODE.includes(`'${banned}'`), false, banned);
    }
  });
});

/* ================================================================== */
/* I. 게시되는 글이 승인된 그 글인가                                     */
/* ================================================================== */

describe('게시 보관소 migration · I. 게시 무결성', () => {
  const integrityFn = () =>
    CODE.match(
      /create or replace function private\.check_published_content_integrity[\s\S]*?\$\$;/,
    )![0];

  it('적기 전에 확인하는 방아쇠가 있다', () => {
    assert.ok(
      CODE.includes(
        `create trigger published_content_integrity\nbefore insert on ${PUBLISHED_CONTENT_TABLES.published}`,
      ),
    );
  });

  it('승인된 결정이 있어야 한다', () => {
    const fn = integrityFn();
    assert.ok(fn.includes(`from ${PUBLISHED_CONTENT_TABLES.review}`));
    assert.ok(fn.includes("v_decision is distinct from 'approve'"));
  });

  it('적혀 있는 글이 있어야 한다', () => {
    assert.ok(integrityFn().includes(`from ${PUBLISHED_CONTENT_TABLES.candidate}`));
  });

  it('지문을 뺀 나머지를 통째로 비교한다', () => {
    assert.ok(integrityFn().includes("(new.content - 'candidateHash') <> v_candidate"));
  });

  it('승인 여부를 따로 칸에 복제하지 않는다', () => {
    // decision을 표의 칸으로 또 두면 주인이 둘이 된다.
    // 함수 안의 지역 변수(v_decision)는 칸이 아니므로 표의 몸만 본다.
    const tableBodies = [...CODE.matchAll(/create table private\.[a-z_]+ \(([\s\S]*?)\n\);/g)]
      .map((m) => m[1])
      .join('\n');
    assert.equal(/^\s*decision\s/m.test(tableBodies), false);
    assert.equal(tableBodies.includes('reviewer_user_id uuid') , true);
  });
});

/* ================================================================== */
/* J. 다시 보낸 요청                                                    */
/* ================================================================== */

describe('게시 보관소 migration · J. 다시 보낸 요청', () => {
  const reviewFn = () =>
    CODE.match(
      new RegExp(
        `create or replace function public\\.${REVIEW_PUBLISHED_CONTENT_CANDIDATE_RPC}[\\s\\S]*?\\$\\$;`,
      ),
    )![0];

  it('같은 사람이 같은 결정을 보냈는지 본다', () => {
    const fn = reviewFn();
    assert.ok(fn.includes('v_existing_reviewer <> v_reviewer_user_id'));
    assert.ok(fn.includes('v_existing_review <> v_review'));
  });

  it('앞의 결과가 온전한지도 확인한다', () => {
    // 승인이었다면 글이 있어야 하고, 반려였다면 없어야 한다.
    const fn = reviewFn();
    assert.ok(fn.includes('v_published_content is null'));
    assert.ok(fn.includes("(v_published_content - 'candidateHash') <> v_candidate"));
  });

  it('어긋난 것을 조용히 고치지 않는다', () => {
    const fn = reviewFn();
    // 다시 보낸 요청이 앞의 실수를 대신 수리하지 않는다.
    assert.equal(/update private\./i.test(fn), false);
    assert.equal(/delete from private\./i.test(fn), false);
  });

  it('글을 적어 두는 함수도 덮어쓰지 않는다', () => {
    const storeFn = CODE.match(
      new RegExp(
        `create or replace function public\\.${STORE_PUBLISHED_CONTENT_CANDIDATE_RPC}[\\s\\S]*?\\$\\$;`,
      ),
    )![0];
    assert.ok(storeFn.includes('on conflict (candidate_hash) do nothing'));
    assert.equal(/do update/i.test(storeFn), false);
  });
});

/* ================================================================== */
/* K. 함수의 모양                                                       */
/* ================================================================== */

describe('게시 보관소 migration · K. 함수', () => {
  it('두 함수 모두 정해진 자리에서만 찾는다', () => {
    assert.equal((CODE.match(/security definer/g) ?? []).length, 2);
    assert.equal(
      (CODE.match(/set search_path = private, pg_catalog/g) ?? []).length,
      2,
    );
  });

  it('만들어 부르는 SQL이 없다', () => {
    for (const banned of ['execute format', 'quote_ident', 'quote_literal', '%I', '%s']) {
      assert.equal(CODE.includes(banned), false, banned);
    }
  });

  it('지문을 다시 계산하지 않는다', () => {
    // 지문의 주인은 애플리케이션 계약이다.
    for (const banned of ['digest', 'sha256', 'encode(', 'jsonb_object_agg']) {
      assert.equal(CODE.toLowerCase().includes(banned), false, banned);
    }
  });

  it('오류에 저장된 내용을 담지 않는다', () => {
    const raises = [...CODE.matchAll(/raise exception '([^']*)'/g)].map((m) => m[1]);
    assert.ok(raises.length > 0);
    for (const message of raises) {
      for (const banned of ['%', 'p_candidate', 'p_review', 'v_candidate', 'v_review', 'uid']) {
        assert.equal(message.includes(banned), false, `${message} / ${banned}`);
      }
    }
  });

  it('글의 뜻을 SQL에서 다시 검사하지 않는다', () => {
    // 태그 길이, 본문이 연구 후보인지 같은 판단은 애플리케이션의 몫이다.
    for (const banned of ['char_length', 'jsonb_array_length', 'RESEARCHABLE']) {
      assert.equal(CODE.includes(banned), false, banned);
    }
    // 'passage' 조각은 반려 이유 passage_context_problem 을 잡는다.
    // 본문 위치를 실제로 들여다보는 구문이 있는지로 본다.
    for (const banned of ["'passage'", "'additionalPassages'", "->> 'passage"]) {
      assert.equal(CODE.includes(banned), false, banned);
    }
  });
});
