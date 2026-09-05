/**
 * 검토자 읽기 함수 migration · 계약 테스트
 *
 * 실행: npm test
 *
 * 여기서는 DB를 부르지 않는다. SQL 파일의 글자만 본다.
 *
 * 보려는 것 여섯 가지.
 *
 *   1. 읽기도 승인과 같은 신분 경계를 쓴다. 서버 열쇠로는 부를 수 없다.
 *   2. 자격 확인이 글 조회보다 먼저 온다.
 *   3. 목록은 아직 결정이 없는 글만, 정해진 순서로, 정해진 건수만 준다.
 *   4. 두 함수가 돌려주는 항목이 TypeScript 계약과 정확히 같다.
 *   5. 연구 근거는 꾸러미에만 있고 목록에는 없다.
 *   6. 아무것도 고치지 않고, 붙잡지 않고, 지문을 다시 계산하지 않는다.
 *
 * 값을 여기 다시 적지 않는다.
 * 건수도 순서도 항목 이름도 실제 계약에서 가져와 SQL과 대조한다.
 * 두 벌을 손으로 적어 두면 언젠가 서로 달라진다.
 */

import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import {
  GET_PUBLISHED_CONTENT_REVIEW_PACKET_RPC,
  LIST_PUBLISHED_CONTENT_REVIEW_QUEUE_RPC,
  REVIEW_PACKET_FIELDS,
  REVIEW_QUEUE_ITEM_FIELDS,
  REVIEW_QUEUE_MAX_ITEMS,
  REVIEW_QUEUE_ORDER,
} from '../../supabase/functions/_shared/published-content-review-access-contract.ts';
import { PUBLISHED_CONTENT_TABLES } from '../../supabase/functions/_shared/published-content-store-contract.ts';

/* ------------------------------------------------------------------ */
/* migration 파일 찾기                                                  */
/* ------------------------------------------------------------------ */

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/**
 * 이 두 함수를 실제로 만든 migration 하나를 찾는다.
 *
 * 파일 이름으로 찾지 않는다. 이름은 바뀔 수 있지만 무엇을 만드는지는 바뀌지 않는다.
 * 하나가 아니면 그 자리에서 실패한다.
 */
const migrationSql = (): string => {
  const dir = path.join(projectRoot, 'supabase/migrations');
  const files = readdirSync(dir)
    .filter((name) => name.endsWith('.sql'))
    .map((name) => readFileSync(path.join(dir, name), 'utf8'))
    .filter((sql) =>
      sql.includes(`create function public.${LIST_PUBLISHED_CONTENT_REVIEW_QUEUE_RPC}`),
    );

  assert.equal(files.length, 1, '읽기 함수를 만든 migration이 하나가 아닙니다.');
  return files[0] as string;
};

const SQL = migrationSql();

/** 설명글에 적힌 단어 때문에 잘못 걸리지 않도록, 실제로 실행되는 부분만 본다. */
const executable = SQL.split('\n')
  .filter((line) => !line.trim().startsWith('--'))
  .join('\n');

/**
 * 함수 하나의 본문만 잘라 온다.
 *
 * 본문 밖의 revoke/grant/comment까지 함께 보면
 * "고치는 구문이 없다" 같은 검사가 엉뚱한 곳을 보게 된다.
 */
const functionBody = (name: string): string => {
  const start = executable.indexOf(`create function public.${name}`);
  assert.notEqual(start, -1, `${name} 를 찾지 못했습니다.`);

  const bodyStart = executable.indexOf('as $$', start);
  assert.notEqual(bodyStart, -1, `${name} 의 본문 시작을 찾지 못했습니다.`);

  const bodyEnd = executable.indexOf('\n$$;', bodyStart);
  assert.notEqual(bodyEnd, -1, `${name} 의 본문 끝을 찾지 못했습니다.`);

  return executable.slice(bodyStart + 'as $$'.length, bodyEnd);
};

/** 함수 선언부(본문 앞)만 잘라 온다. 반환형과 성질을 볼 자리다. */
const functionHeader = (name: string): string => {
  const start = executable.indexOf(`create function public.${name}`);
  assert.notEqual(start, -1, name);
  const bodyStart = executable.indexOf('as $$', start);
  return executable.slice(start, bodyStart);
};

const QUEUE = LIST_PUBLISHED_CONTENT_REVIEW_QUEUE_RPC;
const PACKET = GET_PUBLISHED_CONTENT_REVIEW_PACKET_RPC;

const QUEUE_BODY = functionBody(QUEUE);
const PACKET_BODY = functionBody(PACKET);

/** jsonb_build_object(...) 안의 키 이름을 순서대로 읽는다. */
const jsonKeys = (body: string): string[] => {
  const start = body.indexOf('jsonb_build_object(');
  assert.notEqual(start, -1, 'jsonb_build_object 를 찾지 못했습니다.');

  // 괄호 짝을 세어 그 호출이 끝나는 자리를 찾는다.
  let depth = 0;
  let end = -1;
  for (let i = start + 'jsonb_build_object'.length; i < body.length; i += 1) {
    if (body[i] === '(') depth += 1;
    if (body[i] === ')') {
      depth -= 1;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  assert.notEqual(end, -1, 'jsonb_build_object 의 끝을 찾지 못했습니다.');

  // 인자 목록을 맨 바깥 쉼표에서만 나눈다.
  // 그냥 따옴표만 찾으면 값 쪽의 c.candidate ->> 'targetDomain' 까지 키로 센다.
  const inner = body.slice(body.indexOf('(', start) + 1, end);
  const parts: string[] = [];
  let nesting = 0;
  let current = '';
  for (const ch of inner) {
    if (ch === '(') nesting += 1;
    if (ch === ')') nesting -= 1;
    if (ch === ',' && nesting === 0) {
      parts.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  parts.push(current);

  // 키와 값이 번갈아 온다. 짝수 자리가 키다.
  return parts
    .filter((_, index) => index % 2 === 0)
    .map((part) => {
      const matched = /^\s*'([^']+)'\s*$/.exec(part);
      assert.notEqual(matched, null, `키가 아닌 값이 키 자리에 있습니다: ${part}`);
      return (matched as RegExpExecArray)[1] as string;
    });
};

/* ================================================================== */
/* A. migration 범위                                                    */
/* ================================================================== */

describe('읽기 함수 migration · A. 범위', () => {
  it('새로 만드는 함수는 둘뿐이다', () => {
    assert.equal((executable.match(/create function /g) ?? []).length, 2);
    assert.equal(executable.includes(`create function public.${QUEUE}()`), true);
    assert.equal(executable.includes(`create function public.${PACKET}(`), true);
  });

  it('기존 함수를 덮어쓰지 않는다', () => {
    // create or replace 였다면 예상치 못한 같은 이름의 함수를 조용히 지웠을 것이다.
    assert.equal(/create or replace/i.test(executable), false);
  });

  it('도우미 함수를 만들지 않는다', () => {
    assert.equal(executable.includes('create function private.'), false);
  });

  it('표와 인덱스와 정책과 방아쇠를 만들지 않는다', () => {
    for (const banned of [
      'create table',
      'create index',
      'create unique index',
      'create policy',
      'create trigger',
      'create type',
      'create view',
    ]) {
      assert.equal(executable.includes(banned), false, banned);
    }
  });

  it('기존 표를 고치지 않는다', () => {
    for (const banned of ['alter table', 'drop ', 'enable row level security']) {
      assert.equal(executable.includes(banned), false, banned);
    }
  });

  it('아무 줄도 미리 넣어 두지 않는다', () => {
    assert.equal(executable.includes('insert into'), false);
  });

  it('표에 직접 권한을 주지 않는다', () => {
    // 표를 열어 주면 읽기 함수를 둔 의미가 사라진다.
    assert.equal(/grant\s+select/i.test(executable), false);
    assert.equal(/grant[^;]*on\s+table/i.test(executable), false);
  });

  it('기존 쓰기 함수를 건드리지 않는다', () => {
    for (const name of [
      'review_published_content_candidate',
      'store_published_content_candidate',
      'store_biblical_research_result',
    ]) {
      assert.equal(executable.includes(`function public.${name}`), false, name);
    }
  });
});

/* ================================================================== */
/* B. 함수의 모양                                                       */
/* ================================================================== */

describe('읽기 함수 migration · B. 모양', () => {
  it('목록 함수는 인자를 받지 않는다', () => {
    assert.ok(functionHeader(QUEUE).includes(`${QUEUE}()`));
  });

  it('꾸러미 함수는 글 지문 하나만 받는다', () => {
    const header = functionHeader(PACKET);
    const args = header.slice(header.indexOf('('), header.indexOf(')') + 1);
    assert.equal(args.replace(/\s+/g, ' ').trim(), '( p_candidate_hash text )');
  });

  it('두 함수 모두 jsonb를 돌려준다', () => {
    for (const name of [QUEUE, PACKET]) {
      assert.ok(functionHeader(name).includes('returns jsonb'), name);
    }
  });

  it('두 함수 모두 남의 권한으로 읽는다', () => {
    for (const name of [QUEUE, PACKET]) {
      assert.ok(functionHeader(name).includes('security definer'), name);
    }
  });

  it('두 함수 모두 읽기만 한다고 밝힌다', () => {
    for (const name of [QUEUE, PACKET]) {
      const header = functionHeader(name);
      assert.ok(header.includes('stable'), name);
      assert.equal(header.includes('immutable'), false, name);
    }
  });

  it('두 함수 모두 찾는 자리가 고정되어 있다', () => {
    for (const name of [QUEUE, PACKET]) {
      assert.ok(functionHeader(name).includes('set search_path = private, pg_catalog'), name);
    }
  });

  it('설명글의 서명이 실제 함수와 같다', () => {
    assert.ok(executable.includes(`comment on function public.${QUEUE}() is`));
    assert.ok(executable.includes(`comment on function public.${PACKET}(text) is`));
  });
});

/* ================================================================== */
/* C. 권한                                                              */
/* ================================================================== */

describe('읽기 함수 migration · C. 권한', () => {
  const signature = (name: string) => (name === QUEUE ? `${name}()` : `${name}(text)`);

  it('아무에게나 열린 권한을 회수한다', () => {
    for (const name of [QUEUE, PACKET]) {
      assert.ok(
        executable.includes(`revoke all on function public.${signature(name)} from public;`),
        name,
      );
    }
  });

  it('세 역할에서 모두 회수한다', () => {
    for (const name of [QUEUE, PACKET]) {
      const revoke = executable
        .slice(executable.indexOf(`revoke all on function public.${signature(name)}\n`))
        .slice(0, 200);
      for (const role of ['anon', 'authenticated', 'service_role']) {
        assert.ok(revoke.includes(role), `${name} / ${role}`);
      }
    }
  });

  it('로그인한 사람에게만 실행 권한을 준다', () => {
    for (const name of [QUEUE, PACKET]) {
      assert.ok(
        executable.includes(
          `grant execute on function public.${signature(name)} to authenticated;`,
        ),
        name,
      );
    }
  });

  it('서버 열쇠에는 실행 권한을 주지 않는다', () => {
    // 이것이 이 설계의 중심이다. 자동화가 검토 전 글을 읽을 수 없어야 한다.
    // 받는 쪽만 본다. 함수 이름의 public. 접두사까지 세면 엉뚱한 곳에 걸린다.
    const grantees = [...executable.matchAll(/grant execute on function [^;]+ to ([^;]+);/g)].map(
      (m) => (m[1] as string).trim(),
    );
    assert.equal(grantees.length, 2);
    for (const grantee of grantees) {
      assert.equal(grantee, 'authenticated');
    }
  });
});

/* ================================================================== */
/* D. 자격 확인                                                         */
/* ================================================================== */

describe('읽기 함수 migration · D. 자격 확인', () => {
  it('두 함수 모두 인증이 아는 값으로 사람을 알아본다', () => {
    for (const [name, body] of [
      [QUEUE, QUEUE_BODY],
      [PACKET, PACKET_BODY],
    ] as const) {
      assert.ok(body.includes('v_reviewer_user_id := auth.uid();'), name);
    }
  });

  it('두 함수 모두 명단에 켜져 있는지 확인한다', () => {
    const table = PUBLISHED_CONTENT_TABLES.reviewer;
    for (const [name, body] of [
      [QUEUE, QUEUE_BODY],
      [PACKET, PACKET_BODY],
    ] as const) {
      assert.ok(body.includes(`from ${table}`), name);
      assert.ok(body.includes('where user_id = v_reviewer_user_id'), name);
      assert.ok(body.includes('and is_active'), name);
    }
  });

  it('두 함수의 자격 확인이 글자까지 같다', () => {
    // 한쪽만 느슨해지는 일을 막는다.
    const authBlock = (body: string) => {
      const start = body.indexOf('v_reviewer_user_id := auth.uid();');
      const end = body.indexOf("errcode = 'insufficient_privilege';", start + 1);
      assert.notEqual(start, -1);
      assert.notEqual(end, -1);
      return body.slice(start, end).replace(/\s+/g, ' ').trim();
    };
    assert.equal(authBlock(QUEUE_BODY), authBlock(PACKET_BODY));
  });

  it('자격 확인이 글 조회보다 먼저 온다', () => {
    // 순서가 반대면 명단에 없는 사람이 오류 종류로 글의 존재를 알아낼 수 있다.
    for (const [name, body] of [
      [QUEUE, QUEUE_BODY],
      [PACKET, PACKET_BODY],
    ] as const) {
      const authAt = body.indexOf('v_reviewer_user_id := auth.uid();');
      const allowlistAt = body.indexOf(PUBLISHED_CONTENT_TABLES.reviewer);
      const candidateAt = body.indexOf(PUBLISHED_CONTENT_TABLES.candidate);
      assert.ok(authAt >= 0 && allowlistAt > authAt, name);
      assert.ok(candidateAt > allowlistAt, name);
    }
  });

  it('막는 검사를 꺼 둔 자리가 없다', () => {
    assert.equal(/\bif\s+false\b/i.test(executable), false);
    assert.equal(/\band\s+false\b/i.test(executable), false);
    assert.equal(/\bor\s+true\b/i.test(executable), false);
  });

  it('왜 안 되는지 알려주지 않는다', () => {
    // 명단에 없는 것과 꺼져 있는 것을 구분해 알리지 않는다.
    for (const [name, body] of [
      [QUEUE, QUEUE_BODY],
      [PACKET, PACKET_BODY],
    ] as const) {
      const messages = [...body.matchAll(/raise exception '([^']*)'/g)].map((m) => m[1] as string);
      assert.ok(messages.length > 0, name);
      for (const message of messages) {
        assert.equal(message, '검토할 수 없습니다.', name);
      }
    }
  });

  it('오류에 저장된 값을 담지 않는다', () => {
    for (const [name, body] of [
      [QUEUE, QUEUE_BODY],
      [PACKET, PACKET_BODY],
    ] as const) {
      for (const marker of ['%', '||', 'p_candidate_hash ||', 'v_reviewer_user_id ||']) {
        const raises = [...body.matchAll(/raise exception[^;]+;/g)].map((m) => m[0] as string);
        for (const raise of raises) {
          assert.equal(raise.includes(marker), false, `${name} / ${marker}`);
        }
      }
    }
  });
});

/* ================================================================== */
/* E. 목록                                                              */
/* ================================================================== */

describe('읽기 함수 migration · E. 목록', () => {
  it('결정 줄이 없는 글만 고른다', () => {
    assert.ok(QUEUE_BODY.includes('where not exists ('));
    assert.ok(QUEUE_BODY.includes(`from ${PUBLISHED_CONTENT_TABLES.review} r`));
    assert.ok(QUEUE_BODY.includes('where r.candidate_hash = c.candidate_hash'));
  });

  it('결정의 내용을 보고 판단하지 않는다', () => {
    // 줄이 있다는 것 자체가 끝났다는 뜻이다.
    assert.equal(QUEUE_BODY.includes("review ->> 'decision'"), false);
    assert.equal(QUEUE_BODY.includes("->> 'decision'"), false);
    assert.equal(/\bstatus\b/.test(QUEUE_BODY), false);
  });

  it('한 번에 가져오는 건수가 계약과 같다', () => {
    assert.ok(QUEUE_BODY.includes(`limit ${REVIEW_QUEUE_MAX_ITEMS}`));
  });

  it('부르는 쪽이 건수를 정하지 않는다', () => {
    assert.ok(functionHeader(QUEUE).includes(`${QUEUE}()`));
    assert.equal(/limit\s+p_/.test(QUEUE_BODY), false);
  });

  it('순서가 계약과 같다', () => {
    const expected = REVIEW_QUEUE_ORDER.map((key) => `c.${key}`).join(', ');
    assert.ok(QUEUE_BODY.includes(`order by ${expected}`), expected);
  });

  it('건수를 자른 뒤에 묶는다', () => {
    // 전부 묶은 뒤에 자르면 50건이라는 약속이 의미를 잃는다.
    //
    // "limit이 어딘가에 있다"로는 부족하다. 하위 질의 밖으로 옮겨도 그건 통과한다.
    // 그래서 하위 질의의 괄호 범위를 실제로 재고, 그 안에 있는지 본다.
    const fromAt = QUEUE_BODY.indexOf('from (');
    assert.notEqual(fromAt, -1, '고르는 하위 질의를 찾지 못했습니다.');

    const open = QUEUE_BODY.indexOf('(', fromAt);
    let nesting = 0;
    let close = -1;
    for (let i = open; i < QUEUE_BODY.length; i += 1) {
      if (QUEUE_BODY[i] === '(') nesting += 1;
      if (QUEUE_BODY[i] === ')') {
        nesting -= 1;
        if (nesting === 0) {
          close = i;
          break;
        }
      }
    }
    assert.notEqual(close, -1, '하위 질의의 끝을 찾지 못했습니다.');

    const subquery = QUEUE_BODY.slice(open, close);
    const expectedOrder = REVIEW_QUEUE_ORDER.map((key) => `c.${key}`).join(', ');
    assert.ok(
      subquery.includes(`limit ${REVIEW_QUEUE_MAX_ITEMS}`),
      '자르는 일이 고르는 하위 질의 안에 있어야 합니다.',
    );
    assert.ok(
      subquery.includes(`order by ${expectedOrder}`),
      '순서 정하는 일도 고르는 하위 질의 안에 있어야 합니다.',
    );

    // 하위 질의 밖에는 자르는 구문이 없어야 한다.
    const outside = QUEUE_BODY.slice(0, open) + QUEUE_BODY.slice(close);
    assert.equal(/\blimit\b/.test(outside), false, '하위 질의 밖에서 자르고 있습니다.');

    // 묶는 쪽은 하위 질의 밖이고, 거기에도 같은 순서를 둔다.
    // 안에서만 정렬하면 배열의 순서는 보장되지 않는다.
    const aggAt = QUEUE_BODY.indexOf('jsonb_agg(');
    assert.ok(aggAt >= 0 && aggAt < open, '묶는 부분이 고르는 부분을 감싸야 합니다.');

    const aggCall = QUEUE_BODY.slice(aggAt, QUEUE_BODY.indexOf('\n', aggAt));
    const expectedAggOrder = REVIEW_QUEUE_ORDER.map((key) => `q.${key}`).join(', ');
    assert.ok(aggCall.includes(`order by ${expectedAggOrder}`), aggCall);
  });

  it('남은 글이 없으면 빈 목록이다', () => {
    assert.ok(QUEUE_BODY.includes("'[]'::jsonb"));
    assert.ok(QUEUE_BODY.includes('coalesce('));
  });

  it('돌려주는 항목이 계약과 정확히 같다', () => {
    assert.deepEqual(jsonKeys(QUEUE_BODY), [...REVIEW_QUEUE_ITEM_FIELDS]);
  });

  it('두 지문은 표의 칸에서 가져온다', () => {
    assert.ok(QUEUE_BODY.includes("'candidateHash', c.candidate_hash"));
    assert.ok(QUEUE_BODY.includes("'researchResultHash', c.research_result_hash"));
    // 글 안의 값을 지문의 주인으로 쓰지 않는다.
    assert.equal(QUEUE_BODY.includes("'researchResultHash', c.candidate"), false);
  });

  it('본문 위치를 글자로 바꾸지 않는다', () => {
    // ->> 를 쓰면 객체가 글자가 되어 받는 쪽 검사기가 막는다.
    assert.ok(QUEUE_BODY.includes("'passage', c.candidate -> 'passage'"));
    assert.equal(QUEUE_BODY.includes("c.candidate ->> 'passage'"), false);
  });

  it('글자인 값에는 ->> 를 쓴다', () => {
    assert.ok(QUEUE_BODY.includes("c.candidate ->> 'targetDomain'"));
    assert.ok(QUEUE_BODY.includes("c.candidate ->> 'referenceLabel'"));
  });
});

/* ================================================================== */
/* F. 목록에 담기지 않는 것                                             */
/* ================================================================== */

describe('읽기 함수 migration · F. 목록의 경계', () => {
  it('글 전체를 담지 않는다', () => {
    assert.equal(QUEUE_BODY.includes("'candidate', c.candidate"), false);
  });

  it('연구와 근거를 담지 않는다', () => {
    // 연구 표를 아예 보지 않는다.
    for (const banned of ['private.research_result', 'rr.result', 'rr.provenance', 'sources']) {
      assert.equal(QUEUE_BODY.includes(banned), false, banned);
    }

    // 돌려주는 항목에도 없다.
    // 글자만 보면 researchResultHash 안의 researchResult에 걸리므로 키 목록으로 본다.
    const keys = jsonKeys(QUEUE_BODY);
    for (const banned of ['researchResult', 'researchProvenance', 'provenance', 'sources']) {
      assert.equal(keys.includes(banned), false, banned);
    }
  });

  it('사람이 읽을 글과 오용 방지 문구를 담지 않는다', () => {
    for (const banned of [
      'contextSummary',
      'theologicalInsight',
      'userExplanation',
      'prayerDirection',
      'misuseGuards',
    ]) {
      assert.equal(QUEUE_BODY.includes(banned), false, banned);
    }
  });

  it('검토자 신분을 담지 않는다', () => {
    // 자격을 확인하는 데만 쓰고 돌려주지 않는다.
    const keys = jsonKeys(QUEUE_BODY);
    for (const banned of ['reviewerUserId', 'reviewerId', 'currentReviewerId', 'email']) {
      assert.equal(keys.includes(banned), false, banned);
    }
    assert.equal(QUEUE_BODY.includes("'reviewerUserId'"), false);
  });

  it('사람의 이야기를 담지 않는다', () => {
    for (const banned of ['situation', 'rawSituation', 'prayerDraft', 'sessionId', 'deviceId']) {
      assert.equal(QUEUE_BODY.includes(banned), false, banned);
    }
  });
});

/* ================================================================== */
/* G. 꾸러미                                                            */
/* ================================================================== */

describe('읽기 함수 migration · G. 꾸러미', () => {
  it('아직 결정이 없는 글에만 준다', () => {
    assert.ok(PACKET_BODY.includes('and not exists ('));
    assert.ok(PACKET_BODY.includes(`from ${PUBLISHED_CONTENT_TABLES.review} r`));
    assert.ok(PACKET_BODY.includes('where r.candidate_hash = c.candidate_hash'));
  });

  it('승인인지 반려인지 보지 않는다', () => {
    assert.equal(PACKET_BODY.includes("->> 'decision'"), false);
    assert.equal(PACKET_BODY.includes("'approve'"), false);
    assert.equal(PACKET_BODY.includes("'reject'"), false);
  });

  it('글을 지문으로 찾는다', () => {
    assert.ok(PACKET_BODY.includes('where c.candidate_hash = p_candidate_hash'));
  });

  it('지문의 모양을 여기서 다시 확인하지 않는다', () => {
    // 그 규칙의 주인은 계약과 글 표의 조건이다. 세 번째 사본을 두지 않는다.
    assert.equal(PACKET_BODY.includes('pcand_'), false);
    assert.equal(PACKET_BODY.includes('~'), false);
  });

  it('연구를 표의 칸으로 잇는다', () => {
    assert.ok(PACKET_BODY.includes('on rr.result_hash = c.research_result_hash'));
  });

  it('글 안에 적힌 연구 지문으로 잇지 않는다', () => {
    assert.equal(PACKET_BODY.includes("c.candidate ->> 'researchResultHash'"), false);
    assert.equal(PACKET_BODY.includes("candidate ->> 'researchResultHash'"), false);
  });

  it('돌려주는 항목이 계약과 정확히 같다', () => {
    assert.deepEqual(jsonKeys(PACKET_BODY), [...REVIEW_PACKET_FIELDS]);
  });

  it('항목마다 어느 칸에서 오는지 정해져 있다', () => {
    for (const pair of [
      "'candidateHash', c.candidate_hash",
      "'candidate', c.candidate",
      "'candidateCreatedAt', c.created_at",
      "'researchResultHash', c.research_result_hash",
      "'researchResult', rr.result",
      "'researchProvenance', rr.provenance",
      "'researchResultCreatedAt', rr.created_at",
    ]) {
      assert.ok(PACKET_BODY.includes(pair), pair);
    }
  });

  it('연구 줄의 내부 번호를 돌려주지 않는다', () => {
    assert.equal(PACKET_BODY.includes('research_result_id'), false);
  });

  it('검토자 신분을 돌려주지 않는다', () => {
    const keys = jsonKeys(PACKET_BODY);
    for (const banned of ['reviewerUserId', 'reviewerId', 'currentReviewerId', 'email']) {
      assert.equal(keys.includes(banned), false, banned);
    }
    assert.equal(PACKET_BODY.includes('r.reviewer_user_id'), false);
    assert.equal(PACKET_BODY.includes("'reviewerUserId'"), false);
  });

  it('찾지 못한 이유를 구분해 알리지 않는다', () => {
    // 글이 없다 / 이미 결정났다 / 연구가 없다 가 하나로 모여야 한다.
    assert.ok(PACKET_BODY.includes('if v_packet is null then'));
    const raises = [...PACKET_BODY.matchAll(/raise exception '([^']*)'/g)].map(
      (m) => m[1] as string,
    );
    assert.equal(new Set(raises).size, 1);
  });
});

/* ================================================================== */
/* H. 아무것도 고치지 않는다                                            */
/* ================================================================== */

describe('읽기 함수 migration · H. 읽기만 한다', () => {
  it('고치는 구문이 없다', () => {
    for (const [name, body] of [
      [QUEUE, QUEUE_BODY],
      [PACKET, PACKET_BODY],
    ] as const) {
      for (const banned of [
        'insert into',
        'update ',
        'delete from',
        'truncate',
        'merge ',
        'create ',
        'alter ',
        'drop ',
      ]) {
        assert.equal(body.includes(banned), false, `${name} / ${banned}`);
      }
    }
  });

  it('줄을 붙잡지 않는다', () => {
    for (const [name, body] of [
      [QUEUE, QUEUE_BODY],
      [PACKET, PACKET_BODY],
    ] as const) {
      for (const banned of ['for update', 'for share', 'pg_advisory', 'lock ']) {
        assert.equal(body.includes(banned), false, `${name} / ${banned}`);
      }
    }
  });

  it('읽었다는 표시를 남기지 않는다', () => {
    for (const banned of ['reservation', 'lease', 'claimed', 'locked_by', 'assigned_to']) {
      assert.equal(executable.includes(banned), false, banned);
    }
  });

  it('그때그때 만드는 SQL이 없다', () => {
    for (const [name, body] of [
      [QUEUE, QUEUE_BODY],
      [PACKET, PACKET_BODY],
    ] as const) {
      for (const banned of ['execute ', 'format(', 'quote_ident', 'quote_literal']) {
        assert.equal(body.includes(banned), false, `${name} / ${banned}`);
      }
    }
  });

  it('지문을 다시 계산하지 않는다', () => {
    // 지문 계산의 주인은 애플리케이션 계약이다. 여기 두 번째 구현을 만들지 않는다.
    for (const banned of ['digest', 'pgcrypto', 'sha256', 'sha-256', 'encode(', 'crypto']) {
      assert.equal(executable.toLowerCase().includes(banned), false, banned);
    }
  });

  it('찾는 자리에 public이나 auth를 넣지 않는다', () => {
    const paths = [...executable.matchAll(/set search_path = ([^\n]+)/g)].map(
      (m) => (m[1] as string).trim(),
    );
    assert.equal(paths.length, 2);
    for (const p of paths) {
      assert.equal(p, 'private, pg_catalog');
    }
  });

  it('표를 부를 때 자리를 함께 적는다', () => {
    for (const [name, body] of [
      [QUEUE, QUEUE_BODY],
      [PACKET, PACKET_BODY],
    ] as const) {
      const froms = [...body.matchAll(/(?:from|join)\s+([a-z_.]+)/g)].map((m) => m[1] as string);
      const tables = froms.filter((t) => t.includes('_'));
      assert.ok(tables.length > 0, name);
      for (const table of tables) {
        assert.ok(table.startsWith('private.'), `${name} / ${table}`);
      }
    }
  });
});
