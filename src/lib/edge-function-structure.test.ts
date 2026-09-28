/**
 * Edge Function 배포 구조 테스트
 *
 * 실행: npm test
 *
 * 확인하는 것:
 *   1. analyze-situation이 supabase/functions 바깥(src/)을 import하지 않는다.
 *   2. _shared에 Deno 전용 코드가 없다.
 *   3. 로컬 테스트 프로그램과 Edge Function이 같은 규칙 파일을 쓴다.
 *   4. 지시문과 응답 구조가 바뀌지 않았다.
 *
 * 이 파일은 supabase/functions 안에 두지 않는다. 배포 번들에 테스트 코드가 섞이지 않게 하기 위해서다.
 */

import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

import {
  INSTRUCTIONS as EDGE_INSTRUCTIONS,
  MODEL as EDGE_MODEL,
  SITUATION_ANALYSIS_SCHEMA as EDGE_SCHEMA,
} from '../../supabase/functions/_shared/analyzer-contract.ts';
import { INSTRUCTIONS, MODEL, SITUATION_ANALYSIS_SCHEMA } from './analyzer-contract.ts';
import { SITUATION_DOMAINS } from '../data/situation-domains.ts';
import { TAXONOMY } from '../data/analysis-taxonomy.ts';
import { SCRIPTURE_CARDS } from '../data/scripture-cards.ts';
import { getCoverage } from './scripture-coverage.ts';
import { MAX_SCORES, matchScriptureCards } from './scripture-matcher.ts';
import { runRecommendationGate } from './recommendation-gate.ts';
import { getCoverage as EDGE_getCoverage } from '../../supabase/functions/_shared/scripture-coverage.ts';
import { matchScriptureCards as EDGE_matchScriptureCards } from '../../supabase/functions/_shared/scripture-matcher.ts';
import { runRecommendationGate as EDGE_runRecommendationGate } from '../../supabase/functions/_shared/recommendation-gate.ts';
import { SCRIPTURE_CARDS as EDGE_SCRIPTURE_CARDS } from '../../supabase/functions/_shared/scripture-cards.ts';
import {
  createSupabaseQuotaChecker,
  parseQuotaResponse,
} from '../../supabase/functions/_shared/rate-limit.ts';
import { corsHeaders } from '../../supabase/functions/_shared/cors.ts';
import {
  COVERAGE_GAP_DOMAINS,
  COVERAGE_GAP_TIMEOUT_MS,
  createSupabaseCoverageGapRecorder,
  isCoverageGapDomain,
  recordCoverageGapIfNeeded,
} from '../../supabase/functions/_shared/coverage-gap.ts';
import { FALLBACK_DOMAIN } from '../data/situation-domains.ts';


const projectRoot = path.resolve(import.meta.dirname, '../..');
const functionsDir = path.join(projectRoot, 'supabase/functions');

/** _shared를 뺀 실제 Edge Function 폴더 목록 */
const functionDirs = () =>
  readdirSync(functionsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name !== '_shared')
    .map((entry) => entry.name);

const readSourceFiles = (dir: string) =>
  readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
    .map((entry) => ({
      name: entry.name,
      source: readFileSync(path.join(dir, entry.name), 'utf8'),
    }));

/** 주석을 뺀 본문 (설명 문장에 적힌 경로 때문에 잘못 걸리지 않도록) */
const stripComments = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '');

describe('Edge Function 배포 구조', () => {
  it('Edge Function 폴더 목록이 예상과 같다', () => {
    assert.deepEqual(functionDirs().sort(), [
      'analyze-situation',
      'biblical-researcher',
      'candidate-generator',
      'delete-my-data',
      'generate-prayer-guidance',
      'recommend-scripture',
      'research-prioritizer',
      'research-queue-refresh',
      'source-harvester',
    ]);
  });

  it('Edge Function은 supabase/functions 바깥을 import하지 않는다', () => {
    for (const file of functionDirs().flatMap((dir) =>
      readSourceFiles(path.join(functionsDir, dir)),
    )) {
      const code = stripComments(file.source);
      const imports = [...code.matchAll(/from\s+'([^']+)'/g)].map((match) => match[1]);
      for (const specifier of imports) {
        assert.equal(
          specifier.includes('src/'),
          false,
          `${file.name}이 ${specifier}를 import하고 있습니다.`,
        );
        assert.equal(
          specifier.startsWith('../../'),
          false,
          `${file.name}이 functions 폴더 밖(${specifier})을 참조합니다.`,
        );
      }
    }
  });

  it('_shared도 supabase/functions 바깥을 import하지 않는다', () => {
    for (const file of readSourceFiles(path.join(functionsDir, '_shared'))) {
      const code = stripComments(file.source);
      const imports = [...code.matchAll(/from\s+'([^']+)'/g)].map((match) => match[1]);
      for (const specifier of imports) {
        assert.equal(specifier.startsWith('.'), true, `${file.name}: ${specifier}`);
        assert.equal(specifier.includes('..'), false, `${file.name}: ${specifier}`);
      }
    }
  });

  it('_shared에 Deno 전용 API와 서버 전용 코드가 없다', () => {
    const banned = ['Deno.env', 'Deno.serve', 'process.env', "from 'openai'", 'createClient('];
    for (const file of readSourceFiles(path.join(functionsDir, '_shared'))) {
      const code = stripComments(file.source);
      for (const token of banned) {
        assert.equal(code.includes(token), false, `${file.name}에 ${token}가 있습니다.`);
      }
    }
  });

  it('Deno 전용 코드는 진입점(index.ts)에만 있다', () => {
    for (const name of functionDirs()) {
      const dir = path.join(functionsDir, name);
      const index = readFileSync(path.join(dir, 'index.ts'), 'utf8');
      const handler = stripComments(readFileSync(path.join(dir, 'handler.ts'), 'utf8'));

      assert.ok(index.includes('Deno.env.get'), `${name}/index.ts가 Deno.env로 키를 읽어야 합니다.`);
      assert.ok(index.includes('Deno.serve'), `${name}/index.ts`);
      assert.equal(handler.includes('Deno'), false, `${name}/handler.ts에 Deno 코드가 있습니다.`);
    }
  });
});

describe('Analyzer 규칙 동일성', () => {
  it('로컬 테스트 경로와 Edge Function 경로가 같은 값을 가리킨다', () => {
    assert.equal(INSTRUCTIONS, EDGE_INSTRUCTIONS);
    assert.equal(MODEL, EDGE_MODEL);
    assert.equal(SITUATION_ANALYSIS_SCHEMA, EDGE_SCHEMA);
  });

  it('지시문이 검증된 상태 그대로다', () => {
    // Scripture Card Expansion v2(2026-09-15)로 situationTags가 103→163개로 늘었고,
    // 실제 new-cards 평가 교정(2026-09-16)에서 결혼·재혼 결정 태그가 추가됐다. 이후 일반적인
    // 지혜 요청을 SC-051이 가로채던 smoke 회귀를 막기 위해 넓은 "무엇이 더 나은지 분별함"을
    // 제거한 뒤, 실제 full·smoke 평가에서 확인한 구체 상황 태그 16개를 추가해 최종 179개가 됐다.
    // 지시문에 그대로 나열되는 태그 목록이 길어졌다. Analyzer Tag Stability
    // Correction v3(2026-09-16)으로 실제 full 평가에서 확인한 영역 경계와 구체 태그 우선
    // 예시를 추가했다. 내부 테스트 표현 민감도 교정(2026-09-29)에서는 짧은 질병·메모체 관계
    // 문장과 반복적으로 흔들린 세 영역 경계를 추가했다. 실제 INSTRUCTIONS.length를 계산해
    // 갱신한 값이다.
    assert.equal(INSTRUCTIONS.length, 18306, '지시문 길이가 달라졌습니다.');
    for (const marker of [
      '[level]',
      '[자살 / 자해]',
      '[violence_to_others]',
      '[urgent_medical]',
      '[지속적 괴롭힘 / 학대 가능성]',
      '[Situation Domain]',
      '[Domain Priority]',
      'needs_choice',
      'needs_detail',
      '요즘 너무 힘들어요.',
      '휴대폰 배경화면 색을 무엇으로 할지 고민돼요.',
      '가짜 중심 영역을 만들지 않습니다',
      '안전 신호(safety)는 domainPriority와 상관없이',
      '하나님의 직접 메시지인지 아닌지 단정하지 않습니다',
      '[Minimum Sufficient Tagging]',
      'routing signal',
      '"관계에 대한 선택"은 사람 사이의 관계를 시작·유지·끝낼지 고민하는 경우에만 사용합니다.',
      '두 회사 중 어디로 이직할지 결정을 못 내리겠어요.',
      '"오래 기다린 좋은 결과를 받음"은 사용자가 기다림이 길었다는 사실이나 기간을 직접',
      '드디어 합격 소식을 들어서 너무 감사해요.',
      '몇 년째 병이 낫기를 기도했는데 아무 변화가 없어요.',
      '신앙에서 멀어졌다가 다시 돌아오고 싶어요.',
      '오늘은 별일 없이 평온한 하루를 보냈어요.',
      '아이의 성적과 진로 때문에 걱정이 커요.',
      '구직 중인데 계속 떨어져서 희망을 잃고 있어요.',
      '좋은 결과나 긍정적인 소식이 없으므로 "기쁜 소식"을 사용하지 않습니다.',
      '배우자와 양육 방식이 다름',
      '하나님께도 버림받은 것 같아요.',
      '숨긴 일 때문에 하나님 앞에 나가기 힘듦',
      '같은 상태를 "마음을 쉬고 싶음"으로 중복 표시하지 않습니다.',
      '같은 사실을 "소진"으로 중복 표시하지 않습니다.',
      '아이와 대화할 때 서로 화냄',
      '돈 걱정으로 잠을 못 잠',
      '지금 하는 일이 하나님이 원하시는 길인지 모르겠어요.',
      '오랫동안 기도를 멈췄는데 다시 시작하고 싶어요.',
      '친구에게 잘못한 일을 아직 사과하지 못했어요.',
      '가까운 사람에게 속아서 큰 손해를 봤어요.',
      '앞으로 어떤 방향으로 나아가야 할지 지혜가 필요해요.',
      '쉬는 날에도 죄책감이 들어 제대로 쉬지 못해요.',
      '병원비가 너무 많이 나와서 치료를 계속할 수 있을지 걱정돼요.',
      '이 문장만 주어졌다면 level은 normal, categories는 빈 배열입니다.',
      '복수하고 싶은 마음을 하나님께 내려놓고 싶어요.',
      '오래 기도했지만 상황이 그대로임',
      '창업과 안정적인 길 사이에서 고민함',
      '아이를 잃은 슬픔',
      '신앙생활이 습관만 남음',
      '좋아졌다가 다시 아파짐',
      '새 직장으로 옮긴 선택을 돌아봄',
      '사람마다 다른 조언을 해서 무엇을 따라야 할지 모르겠어요.',
      '연락할 사람이 없어 힘든 일을 혼자 견디고 있어요.',
      '연락할 사람이 없어 혼자 견딤',
      '하나님께서 정말 나와 함께 계신지 모르겠어요.',
      '"하나님과 따로 쉬고 싶음"도 추론하지 않습니다.',
      '아침에 일어나는 것부터 버거움',
      '수입이 줄어 교육비를 감당하기 어려움',
      '죄책감은 의심에 대한 감정입니다.',
      '분별은 사과와 책임이라는 구체적 관계 문제를 풀기 위한 수단입니다.',
      '감기가 오래가서 힘들다.',
      '동생과 말다툼 후 서로 연락안함. 먼저 사과할지 고민중',
      '부모님이 늘 다른 사람과 나를 비교하세요.',
      '뒤에서 험담을 당한 것을 알고 마음이 아파요.',
      '신뢰했던 사람이 뒤통수를 쳐서 배신감이 커요.',
      '메모체, 축약형, 구어체, 종결어미 생략, 띄어쓰기 차이는 정보 부족의 근거가 아닙니다.',
      '죽음이 가까워진 것 같아 가족과 무엇을 말해야 할지 모르겠어요.',
      '하나님도 사람들도 나를 떠난 것처럼 느껴져요.',
      '치료비와 통증을 함께 감당하기가 버거워요.',
      '"결혼이나 재혼 여부를 결정함"은 결혼 또는 재혼을 할지 직접 고민하는 경우에만 사용합니다.',
      '같은 사실을 더 구체적인 situationTag가 이미 표현하면',
      '같은 전환 불안을 다시 "두려운 일을 앞둠"이나',
      '같은 결정을 다시 "중요한 결정"으로 중복 표시하지 않습니다.',
      '같은 사실을 다시 "오래된 기도"나 "응답이 보이지 않음"으로 중복 표시하지 않습니다.',
      '"면접이나 시험 결과를 기다림"을 골랐다면 같은 사실을',
      '"가족에게 비교당함"을 골랐다면 "다른 사람과 비교"를',
      '"수입 변화"를 골랐다면 같은 사실을 "경제적 어려움"으로',
      '감정으로만 표현된 말을 emotionTags와 spiritualQuestionTags에 동시에 중복 표시하지 않습니다.',
      'spiritualQuestionTags에 "슬픔"을 다시 넣지 않습니다.',
    ]) {
      assert.ok(INSTRUCTIONS.includes(marker), `지시문에서 ${marker}가 사라졌습니다.`);
    }
  });

  it('모델과 응답 구조가 그대로다', () => {
    assert.equal(MODEL, 'gpt-5.6-luna');
    assert.deepEqual(SITUATION_ANALYSIS_SCHEMA.required, [
      'domainPriority',
      'primaryDomain',
      'domainChoiceCandidates',
      'secondaryDomains',
      'situationTags',
      'emotionTags',
      'spiritualQuestionTags',
      'prayerModes',
      'pastoralFunctions',
      'safety',
      'confidence',
    ]);
    // strict 모드에서는 모든 속성이 required여야 한다.
    assert.deepEqual(
      [...SITUATION_ANALYSIS_SCHEMA.required].sort(),
      Object.keys(SITUATION_ANALYSIS_SCHEMA.properties).sort(),
    );
    assert.equal(SITUATION_ANALYSIS_SCHEMA.additionalProperties, false);
  });

  it('영역 우선순위 필드는 단순한 schema 형태를 쓴다 (루트 oneOf/anyOf 없음)', () => {
    const schema = SITUATION_ANALYSIS_SCHEMA as unknown as Record<string, unknown>;
    for (const key of ['oneOf', 'anyOf', 'allOf']) assert.equal(key in schema, false, key);

    const { domainPriority, primaryDomain, domainChoiceCandidates } = SITUATION_ANALYSIS_SCHEMA.properties;
    assert.deepEqual(domainPriority, { type: 'string', enum: ['resolved', 'needs_choice', 'needs_detail'] });

    // nullable은 OpenAI Structured Outputs 문서의 형태: type 배열 + enum에 null 포함.
    assert.deepEqual(primaryDomain.type, ['string', 'null']);
    assert.equal(primaryDomain.enum.length, SITUATION_DOMAINS.length + 1);
    assert.ok((primaryDomain.enum as readonly unknown[]).includes(null));
    for (const domain of SITUATION_DOMAINS) assert.ok((primaryDomain.enum as readonly unknown[]).includes(domain), domain);

    // 선택 후보에는 other_uncovered가 들어갈 수 없다.
    assert.equal(domainChoiceCandidates.type, 'array');
    assert.equal(domainChoiceCandidates.items.type, 'string');
    assert.deepEqual(
      [...domainChoiceCandidates.items.enum].sort(),
      SITUATION_DOMAINS.filter((domain) => domain !== FALLBACK_DOMAIN).sort(),
    );
  });

  it('Domain과 Taxonomy 값이 그대로다', () => {
    // Scripture Card Expansion v2(2026-09-15): 31→51장. 새 카드는 emotionTags·spiritualQuestionTags·
    // prayerModes·pastoralFunction에 새 값을 추가하지 않았으므로 그 네 사전은 그대로다.
    // situationTags는 새 카드 분리를 위해 60개가 늘었고, 실제 평가에서 좁은 태그 1개를 더한 뒤
    // SC-051의 넓은 태그 1개를 제거하고 구체 상황 태그 16개를 추가해 최종 103→179이다.
    assert.equal(SITUATION_DOMAINS.length, 18);
    assert.equal(TAXONOMY.situationTags.length, 179);
    assert.equal(TAXONOMY.emotionTags.length, 32);
    assert.equal(TAXONOMY.spiritualQuestionTags.length, 43);
    assert.equal(TAXONOMY.prayerModes.length, 8);
    assert.equal(TAXONOMY.pastoralFunctions.length, 20);
    assert.equal(SCRIPTURE_CARDS.length, 51);
  });
});

describe('서버와 로컬이 같은 모듈을 쓴다', () => {
  it('Matcher / Gate / Coverage / Card 데이터가 같은 객체다', () => {
    assert.equal(matchScriptureCards, EDGE_matchScriptureCards);
    assert.equal(runRecommendationGate, EDGE_runRecommendationGate);
    assert.equal(getCoverage, EDGE_getCoverage);
    assert.equal(SCRIPTURE_CARDS, EDGE_SCRIPTURE_CARDS);
  });

  it('Matcher 배점이 그대로다', () => {
    assert.deepEqual({ ...MAX_SCORES }, {
      spiritualQuestion: 30,
      situation: 25,
      pastoralFunction: 20,
      emotion: 15,
      prayerMode: 10,
    });
  });
});

describe('사용량 제한 구조', () => {
  it('사용자용 Edge Function 두 개가 같은 rate-limit 모듈을 쓴다', () => {
    // research-prioritizer는 내부 전용이라 사용자 사용량 제한을 쓰지 않는다.
    for (const name of ['analyze-situation', 'recommend-scripture']) {
      const index = stripComments(readFileSync(path.join(functionsDir, name, 'index.ts'), 'utf8'));
      assert.ok(
        index.includes("from '../_shared/rate-limit.ts'"),
        `${name}/index.ts가 공용 rate-limit 모듈을 쓰지 않습니다.`,
      );
      assert.ok(
        index.includes('createSupabaseQuotaChecker'),
        `${name}/index.ts에 사용량 확인기가 없습니다.`,
      );
      assert.ok(index.includes('checkQuota'), `${name}/index.ts가 checkQuota를 넘기지 않습니다.`);
    }
  });

  it('사용량 상태 테이블과 RPC 마이그레이션이 있다', () => {
    const dir = path.join(projectRoot, 'supabase/migrations');
    const files = readdirSync(dir).filter((name) => name.endsWith('.sql'));
    const sql = files.map((name) => readFileSync(path.join(dir, name), 'utf8')).join('\n');

    assert.ok(sql.includes('private.openai_rate_limit_state'), '상태 테이블이 없습니다.');
    assert.ok(sql.includes('public.consume_openai_quota'), 'RPC가 없습니다.');
    assert.ok(sql.includes('auth.uid()'), '사용자 판별에 auth.uid()를 쓰지 않습니다.');
    assert.ok(sql.includes('grant execute on function public.consume_openai_quota() to authenticated'));
    assert.ok(sql.includes('enable row level security'));
    assert.ok(sql.includes('set search_path'), 'search_path를 고정하지 않았습니다.');

    // 사용자 상황이나 IP를 저장하지 않는다. (설명 주석은 빼고 실제 SQL만 본다)
    const sqlWithoutComments = sql
      .replace(/^\s*--.*$/gm, '')
      .toLowerCase();
    for (const banned of ['situation', 'ip_address', 'access_token', 'jwt', 'analysis_result']) {
      assert.equal(sqlWithoutComments.includes(banned), false, `${banned}를 저장하려 합니다.`);
    }

    // 저장하는 열은 사용자 id와 시간/횟수뿐이다.
    for (const column of ['user_id', 'hour_started_at', 'hour_count', 'day_started_at', 'day_count', 'updated_at']) {
      assert.ok(sql.includes(column), `${column} 열이 없습니다.`);
    }
  });

  it('DB 응답을 그대로 믿지 않는다', () => {
    assert.deepEqual(parseQuotaResponse({ allowed: true }), { status: 'allowed' });
    assert.deepEqual(parseQuotaResponse([{ allowed: true }]), { status: 'allowed' });
    assert.deepEqual(parseQuotaResponse({ allowed: false, retry_after_seconds: 90 }), {
      status: 'limited',
      retryAfterSeconds: 90,
    });
    // 모양이 이상하면 통과시키지 않는다.
    for (const value of [null, 'ok', {}, { allowed: 'yes' }, []]) {
      assert.deepEqual(parseQuotaResponse(value), { status: 'unavailable' });
    }
  });

  it('설정이 없거나 사용자 JWT가 없으면 통과시키지 않는다', async () => {
    let fetched = 0;
    const fetchImpl = (async () => {
      fetched += 1;
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch;

    const noConfig = createSupabaseQuotaChecker({ url: undefined, apiKey: 'key', fetchImpl });
    assert.deepEqual(
      await noConfig(new Request('http://x', { method: 'POST', headers: { authorization: 'Bearer x' } })),
      { status: 'unavailable' },
    );

    const checker = createSupabaseQuotaChecker({ url: 'https://x.supabase.co', apiKey: 'key', fetchImpl });
    assert.deepEqual(await checker(new Request('http://x', { method: 'POST' })), {
      status: 'unavailable',
    });

    assert.equal(fetched, 0, 'DB를 불렀습니다.');
  });

  it('요청의 사용자 JWT를 그대로 전달한다', async () => {
    let sentAuth: string | null = null;
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      sentAuth = (init.headers as Record<string, string>).authorization;
      return new Response(JSON.stringify({ allowed: true }), { status: 200 });
    }) as unknown as typeof fetch;

    const checker = createSupabaseQuotaChecker({ url: 'https://x.supabase.co', apiKey: 'key', fetchImpl });
    const decision = await checker(
      new Request('http://x', { method: 'POST', headers: { authorization: 'Bearer user-jwt' } }),
    );

    assert.deepEqual(decision, { status: 'allowed' });
    assert.equal(sentAuth, 'Bearer user-jwt');
  });

  it('Retry-After를 브라우저가 읽을 수 있게 노출한다', () => {
    assert.equal(corsHeaders['Access-Control-Expose-Headers'], 'Retry-After');
  });
});

describe('Retry-After 계산 규칙 (SQL)', () => {
  const migrationSql = () => {
    const dir = path.join(projectRoot, 'supabase/migrations');
    return readdirSync(dir)
      .filter((name) => name.endsWith('.sql'))
      .map((name) => readFileSync(path.join(dir, name), 'utf8'))
      .join('\n');
  };

  // 로컬에 Postgres가 없어 함수를 실행해볼 수 없다.
  // 대신 계산 규칙이 SQL에 그대로 남아 있는지 고정해 둔다.
  it('두 제한을 각각 판단한다 (한쪽이 다른 쪽을 가리지 않는다)', () => {
    const sql = migrationSql();
    assert.ok(sql.includes('hour_blocked := hour_used >= hour_limit'), 'hour 판단이 없습니다.');
    assert.ok(sql.includes('day_blocked := day_used >= day_limit'), 'day 판단이 없습니다.');
    assert.equal(
      sql.includes('elsif day_used >= day_limit'),
      false,
      'day 검사가 hour 검사에 가려집니다.',
    );
  });

  it('hour만 초과하면 hour window가 풀리는 시간을 쓴다', () => {
    const sql = migrationSql();
    assert.ok(sql.includes("hour_wait := ceil(extract(epoch from (hour_start + interval '1 hour' - now_ts)))"));
    assert.ok(sql.includes('if hour_blocked then\n      retry_after := greatest(retry_after, hour_wait);'));
  });

  it('day만 초과하면 day window가 풀리는 시간을 쓴다', () => {
    const sql = migrationSql();
    assert.ok(sql.includes("day_wait := ceil(extract(epoch from (day_start + interval '24 hours' - now_ts)))"));
    assert.ok(sql.includes('if day_blocked then\n      retry_after := greatest(retry_after, day_wait);'));
  });

  it('둘 다 초과하면 더 긴 대기시간을 쓴다', () => {
    const sql = migrationSql();
    // 두 조건이 각각 greatest로 누적되므로 둘 다 막히면 더 긴 값이 남는다.
    const blockedSection = sql.slice(sql.indexOf('if hour_blocked or day_blocked then'), sql.indexOf('else\n    allowed := true'));
    assert.ok(blockedSection.includes('greatest(retry_after, hour_wait)'));
    assert.ok(blockedSection.includes('greatest(retry_after, day_wait)'));
    assert.ok(blockedSection.includes('retry_after := greatest(1, retry_after)'), '최소 1초 보장이 없습니다.');
  });

  it('둘 다 여유가 있으면 허용하고 두 카운트를 올린다', () => {
    const sql = migrationSql();
    assert.ok(sql.includes('allowed := true;\n    hour_used := hour_used + 1;\n    day_used := day_used + 1;'));
  });

  it('제한값은 그대로 1시간 10회 / 24시간 30회다', () => {
    const sql = migrationSql();
    assert.ok(sql.includes('hour_limit constant integer := 10'));
    assert.ok(sql.includes('day_limit  constant integer := 30'));
  });
});

describe('Coverage Gap Collector', () => {
  /**
   * 통계 표를 만든 migration 하나만 읽는다.
   *
   * 예전에는 migrations 폴더의 모든 SQL을 이어 붙여서 봤다.
   * 그런데 "통계 표에 사용자 정보가 없다"를 확인할 때
   * 표 이름이 처음 나온 자리부터 이어 붙인 글의 맨 끝까지를 그 표의 것으로 보았다.
   *
   * 그래서 뒤에 오는 다른 migration이 통계와 아무 상관 없이
   * user_id나 auth.uid()를 쓰면 통계 표의 잘못으로 잡혔다.
   *
   * 파일 이름으로 찾지 않는다. 그 표를 실제로 만든 SQL이 있는 파일을 찾는다.
   * 이름은 바뀔 수 있지만 무엇을 만드는지는 바뀌지 않는다.
   */
  const migrationSql = () => {
    const dir = path.join(projectRoot, 'supabase/migrations');
    const files = readdirSync(dir)
      .filter((name) => name.endsWith('.sql'))
      .map((name) => readFileSync(path.join(dir, name), 'utf8'))
      .filter((sql) => /create table (if not exists )?private\.coverage_gap_daily/.test(sql));

    assert.equal(files.length, 1, '통계 표를 만든 migration이 하나가 아닙니다.');
    return files[0] as string;
  };

  const currentPolicyMigrationSql = () => {
    const dir = path.join(projectRoot, 'supabase/migrations');
    const files = readdirSync(dir)
      .filter((name) => name.endsWith('.sql'))
      .map((name) => readFileSync(path.join(dir, name), 'utf8'))
      .filter((sql) => sql.includes('create or replace function public.record_coverage_gap(p_primary_domain text)'));

    assert.equal(files.length, 1, '현재 Coverage Gap 기록 정책을 교체한 migration이 하나가 아닙니다.');
    return files[0] as string;
  };

  it('현재 기록 가능한 영역은 분류 밖 fallback 하나뿐이다', () => {
    assert.deepEqual(COVERAGE_GAP_DOMAINS, [FALLBACK_DOMAIN]);
    assert.equal(COVERAGE_GAP_DOMAINS.length, 1);

    for (const covered of ['fear_uncertainty', 'grief_loss', 'decision_guidance']) {
      assert.equal(isCoverageGapDomain(covered), false, `${covered}가 허용되었습니다.`);
    }
    assert.equal(isCoverageGapDomain('made_up'), false);
    assert.equal(isCoverageGapDomain(undefined), false);
  });

  it('no_coverage가 아니거나 허용되지 않은 영역이면 기록하지 않는다', async () => {
    const recorded: string[] = [];
    const recorder = async (domain: string) => {
      recorded.push(domain);
    };

    await recordCoverageGapIfNeeded({ route: 'recommend', primaryDomain: 'financial_hardship' }, recorder);
    await recordCoverageGapIfNeeded({ route: 'safety', primaryDomain: 'other_uncovered' }, recorder);
    await recordCoverageGapIfNeeded({ route: 'ambiguous', primaryDomain: 'burnout_exhaustion' }, recorder);
    await recordCoverageGapIfNeeded({ route: 'no_coverage', primaryDomain: 'fear_uncertainty' }, recorder);
    await recordCoverageGapIfNeeded({ route: 'no_coverage', primaryDomain: 'made_up' }, recorder);
    assert.deepEqual(recorded, []);

    await recordCoverageGapIfNeeded({ route: 'no_coverage', primaryDomain: 'chronic_illness' }, recorder);
    assert.deepEqual(recorded, []);

    await recordCoverageGapIfNeeded({ route: 'no_coverage', primaryDomain: 'other_uncovered' }, recorder);
    assert.deepEqual(recorded, ['other_uncovered']);
  });

  it('설정이 없으면 조용히 넘어가고 고정 메시지만 남긴다', async () => {
    const logs: string[] = [];
    let fetched = 0;
    const fetchImpl = (async () => {
      fetched += 1;
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch;

    const recorder = createSupabaseCoverageGapRecorder({
      url: undefined,
      serviceRoleKey: undefined,
      fetchImpl,
      log: (message) => logs.push(message),
    });

    await recorder('financial_hardship');
    assert.equal(fetched, 0);
    assert.deepEqual(logs, ['coverage_gap_write_failed']);
  });

  it('DB에 보내는 값은 영역 이름 하나뿐이다', async () => {
    let sentBody: string | null = null;
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      sentBody = init.body as string;
      return new Response('true', { status: 200 });
    }) as unknown as typeof fetch;

    const recorder = createSupabaseCoverageGapRecorder({
      url: 'https://x.supabase.co',
      serviceRoleKey: 'server-only-key',
      fetchImpl,
    });
    await recorder('other_uncovered');

    assert.deepEqual(JSON.parse(sentBody ?? '{}'), { p_primary_domain: 'other_uncovered' });
  });

  it('recommend-scripture만 collector를 연결한다', () => {
    const recommendIndex = stripComments(
      readFileSync(path.join(functionsDir, 'recommend-scripture/index.ts'), 'utf8'),
    );
    assert.ok(recommendIndex.includes('createSupabaseCoverageGapRecorder'));
    assert.ok(recommendIndex.includes('SUPABASE_SERVICE_ROLE_KEY'));
    assert.ok(recommendIndex.includes('recordCoverageGap'));

    const analyzeIndex = stripComments(
      readFileSync(path.join(functionsDir, 'analyze-situation/index.ts'), 'utf8'),
    );
    assert.equal(analyzeIndex.includes('recordCoverageGap'), false);
  });

  it('서버 전용 키가 앱 코드에 들어가지 않는다', () => {
    const appFiles = [
      'src/lib/supabase.ts',
      'src/lib/request-recommendation.ts',
      'src/app/index.tsx',
      'src/app/scripture.tsx',
      // 내 정보 삭제는 서버가 관리자 권한으로 한다. 앱은 그 권한을 갖지 않는다.
      'src/app/settings.tsx',
      'src/lib/request-account-deletion.ts',
    ];
    for (const file of appFiles) {
      // 설명 주석은 빼고 실제 코드만 본다.
      const code = stripComments(readFileSync(path.join(projectRoot, file), 'utf8'));
      assert.equal(code.includes('SERVICE_ROLE'), false, `${file}에 서버 전용 키가 있습니다.`);
      assert.equal(code.includes('service_role'), false, `${file}에 서버 전용 키가 있습니다.`);
      assert.equal(code.includes('record_coverage_gap'), false, `${file}가 통계 RPC를 부릅니다.`);
    }
  });

  it('통계 표 마이그레이션이 안전하게 정의되어 있다', () => {
    const sql = migrationSql();

    assert.ok(sql.includes('private.coverage_gap_daily'));
    assert.ok(sql.includes('primary key (bucket_date, primary_domain)'), '복합 기본키가 없습니다.');
    assert.ok(sql.includes('coverage_gap_domain_allowed'), '허용 영역 제약이 없습니다.');
    assert.ok(sql.includes("(now() at time zone 'Asia/Seoul')::date"), 'Asia/Seoul 기준이 아닙니다.');
    assert.ok(sql.includes('on conflict (bucket_date, primary_domain) do update'), '원자적 증가가 없습니다.');
    assert.ok(sql.includes('gap_count = c.gap_count + 1'));
    assert.ok(sql.includes('alter table private.coverage_gap_daily enable row level security'));

    // 표와 스키마는 service_role을 포함해 아무도 직접 접근하지 못한다.
    assert.ok(sql.includes('revoke all on schema private from public;'));
    assert.ok(sql.includes('revoke all on schema private from anon, authenticated, service_role;'));
    assert.ok(sql.includes('revoke all on table private.coverage_gap_daily from public;'));
    assert.ok(
      sql.includes('revoke all on table private.coverage_gap_daily from anon, authenticated, service_role;'),
    );

    // 함수 권한도 모두 회수한 뒤 service_role에만 준다.
    assert.ok(sql.includes('revoke all on function public.record_coverage_gap(text) from public;'));
    assert.ok(
      sql.includes('revoke all on function public.record_coverage_gap(text) from anon, authenticated, service_role;'),
    );
    assert.ok(sql.includes('grant execute on function public.record_coverage_gap(text) to service_role'));

    // 이미 있는 표나 함수를 조용히 덮어쓰지 않는다.
    assert.ok(sql.includes('create table private.coverage_gap_daily'));
    assert.equal(sql.includes('create table if not exists private.coverage_gap_daily'), false);
    assert.ok(sql.includes('create function public.record_coverage_gap(p_primary_domain text)'));
    assert.equal(sql.includes('create or replace function public.record_coverage_gap'), false);

    // 횟수는 1 이상만 저장된다.
    assert.ok(sql.includes('constraint coverage_gap_count_positive check (gap_count > 0)'));
    assert.ok(sql.includes('gap_count bigint not null,'), 'gap_count에 기본값 0이 남아 있습니다.');
    assert.equal(sql.includes('gap_count bigint not null default 0'), false);
    assert.equal(
      sql.includes('grant execute on function public.record_coverage_gap(text) to authenticated'),
      false,
      '앱 사용자에게 실행 권한이 있습니다.',
    );
    assert.ok(sql.includes('set search_path = private, pg_catalog'));

    // 사용자 정보를 저장하지 않는다.
    const sqlWithoutComments = sql.replace(/^\s*--.*$/gm, '').toLowerCase();
    for (const banned of ['user_id uuid', 'auth.uid()', 'situation', 'raw_text', 'ip_address', 'session_id', 'device_id']) {
      const section = sqlWithoutComments.slice(sqlWithoutComments.indexOf('coverage_gap_daily'));
      assert.equal(section.includes(banned), false, `${banned}가 통계에 있습니다.`);
    }
  });

  it('후속 migration은 과거 행을 보존하면서 앞으로 fallback만 기록한다', () => {
    const sql = currentPolicyMigrationSql();
    const body = stripComments(sql);

    assert.ok(body.includes("p_primary_domain is distinct from 'other_uncovered'"));
    assert.ok(body.includes("(now() at time zone 'Asia/Seoul')::date"));
    assert.ok(body.includes('on conflict (bucket_date, primary_domain) do update'));
    assert.ok(body.includes('gap_count = c.gap_count + 1'));
    assert.ok(body.includes('security definer'));
    assert.ok(body.includes('set search_path = private, pg_catalog'));
    assert.ok(body.includes('revoke all on function public.record_coverage_gap(text) from public;'));
    assert.ok(body.includes('from anon, authenticated, service_role;'));
    assert.ok(body.includes('grant execute on function public.record_coverage_gap(text) to service_role;'));
    assert.equal(body.includes('alter table private.coverage_gap_daily'), false, '과거 행의 CHECK 제약을 바꾸면 안 됩니다.');

    for (const formerlyUncovered of [
      'loneliness_isolation',
      'family_parenting_conflict',
      'burnout_exhaustion',
      'spiritual_dryness',
      'financial_hardship',
      'chronic_illness',
      'relationship_conflict_forgiveness',
    ]) {
      assert.equal(body.includes(formerlyUncovered), false, `${formerlyUncovered} 신규 기록이 다시 열렸습니다.`);
    }
  });
});

describe('Coverage Gap 기록 시간 제한', () => {
  const okFetch = (delayMs: number, status = 200) =>
    ((_url: string, init: RequestInit) =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(() => resolve(new Response('true', { status })), delayMs);
        init.signal?.addEventListener('abort', () => {
          clearTimeout(timer);
          reject(new Error('aborted'));
        });
      })) as unknown as typeof fetch;

  it('기본 제한 시간은 1.5초다', () => {
    assert.equal(COVERAGE_GAP_TIMEOUT_MS, 1500);
  });

  it('정상 응답이면 한 번 기록하고 로그를 남기지 않는다', async () => {
    const logs: string[] = [];
    let calls = 0;
    const fetchImpl = ((url: string, init: RequestInit) => {
      calls += 1;
      return okFetch(1)(url, init);
    }) as unknown as typeof fetch;

    const recorder = createSupabaseCoverageGapRecorder({
      url: 'https://x.supabase.co',
      serviceRoleKey: 'server-only-key',
      fetchImpl,
      log: (message) => logs.push(message),
      timeoutMs: 50,
    });

    await recorder('financial_hardship');
    assert.equal(calls, 1);
    assert.deepEqual(logs, []);
  });

  it('HTTP 실패면 그냥 넘어간다 (fail-open)', async () => {
    const logs: string[] = [];
    const recorder = createSupabaseCoverageGapRecorder({
      url: 'https://x.supabase.co',
      serviceRoleKey: 'server-only-key',
      fetchImpl: okFetch(1, 500),
      log: (message) => logs.push(message),
      timeoutMs: 50,
    });

    await recorder('burnout_exhaustion');
    assert.deepEqual(logs, ['coverage_gap_write_failed']);
  });

  it('fetch가 오류를 던져도 그냥 넘어간다', async () => {
    const logs: string[] = [];
    const recorder = createSupabaseCoverageGapRecorder({
      url: 'https://x.supabase.co',
      serviceRoleKey: 'server-only-key',
      fetchImpl: (async () => {
        throw new Error('network down');
      }) as unknown as typeof fetch,
      log: (message) => logs.push(message),
      timeoutMs: 50,
    });

    await recorder('spiritual_dryness');
    assert.deepEqual(logs, ['coverage_gap_write_failed']);
  });

  it('제한 시간을 넘기면 기다리지 않고 끝낸다', async () => {
    const logs: string[] = [];
    const recorder = createSupabaseCoverageGapRecorder({
      url: 'https://x.supabase.co',
      serviceRoleKey: 'server-only-key',
      // 응답이 2초 걸리지만 제한 시간은 30ms다.
      fetchImpl: okFetch(2000),
      log: (message) => logs.push(message),
      timeoutMs: 30,
    });

    const startedAt = Date.now();
    await recorder('chronic_illness');
    const elapsed = Date.now() - startedAt;

    assert.ok(elapsed < 1000, `너무 오래 기다렸습니다: ${elapsed}ms`);
    assert.deepEqual(logs, ['coverage_gap_write_failed']);
  });

  it('제한 시간이 지나면 실제 요청도 취소한다', async () => {
    let aborted = false;
    const fetchImpl = ((_url: string, init: RequestInit) =>
      new Promise((resolve) => {
        const timer = setTimeout(() => resolve(new Response('true', { status: 200 })), 2000);
        init.signal?.addEventListener('abort', () => {
          aborted = true;
          clearTimeout(timer);
        });
      })) as unknown as typeof fetch;

    const recorder = createSupabaseCoverageGapRecorder({
      url: 'https://x.supabase.co',
      serviceRoleKey: 'server-only-key',
      fetchImpl,
      timeoutMs: 20,
    });

    await recorder('loneliness_isolation');
    assert.equal(aborted, true, '요청이 취소되지 않았습니다.');
  });

  it('실패 로그에 민감한 값이 없다', async () => {
    const logs: string[] = [];
    const recorder = createSupabaseCoverageGapRecorder({
      url: 'https://x.supabase.co',
      serviceRoleKey: 'super-secret-service-role-key',
      fetchImpl: okFetch(2000),
      log: (message) => logs.push(message),
      timeoutMs: 20,
    });

    await recorder('other_uncovered');
    for (const message of logs) {
      assert.equal(message, 'coverage_gap_write_failed');
      assert.equal(message.includes('super-secret-service-role-key'), false);
      assert.equal(message.includes('other_uncovered'), false);
    }
  });
});

describe('Research Queue v1 (SQL)', () => {
  const queueSql = () =>
    readFileSync(
      path.join(projectRoot, 'supabase/migrations/20260828223535_content_research_queue.sql'),
      'utf8',
    );

  const withoutComments = () => queueSql().replace(/^\s*--.*$/gm, '');

  // 로컬에 Postgres가 없어 함수를 실행해볼 수 없다.
  // 대신 구조와 계산 규칙이 SQL에 그대로 있는지 고정해 둔다.
  it('표는 private 스키마에 있고 필요한 열만 가진다', () => {
    const sql = queueSql();
    assert.ok(sql.includes('create table private.content_research_queue'));
    assert.equal(sql.includes('create table if not exists private.content_research_queue'), false);

    for (const column of [
      'id uuid primary key',
      'target_domain text not null',
      'research_kind text not null',
      'status text not null',
      'first_detected_date date not null',
      'last_detected_date date not null',
      'total_gap_count bigint not null',
      'recent_7d_count bigint not null',
      'recent_30d_count bigint not null',
      'evidence_version bigint not null',
      'created_at timestamptz not null',
      'updated_at timestamptz not null',
    ]) {
      assert.ok(sql.includes(column), `${column} 열이 없습니다.`);
    }
  });

  it('사용자 정보를 저장하지 않는다', () => {
    const sql = withoutComments().toLowerCase();
    for (const banned of [
      'user_id',
      'auth.uid()',
      'auth.users',
      'situation',
      'raw_text',
      'jwt',
      'ip_address',
      'session_id',
      'device_id',
      'emotion',
      'spiritual_question',
      'prayer',
      'openai',
    ]) {
      assert.equal(sql.includes(banned), false, `${banned}가 Research Queue에 있습니다.`);
    }
  });

  it('연구 종류와 상태가 정해진 값만 허용된다', () => {
    const sql = queueSql();
    assert.ok(sql.includes("research_kind in ('domain_expansion', 'taxonomy_discovery')"));
    assert.ok(
      sql.includes("status in ('queued', 'ready', 'researching', 'blocked', 'completed')"),
    );
  });

  it('과거 확장 연구 7개는 domain_expansion, other_uncovered는 taxonomy_discovery다', () => {
    const sql = queueSql();
    const match = sql.slice(sql.indexOf('content_research_queue_domain_kind_match'));

    for (const domain of [
      'loneliness_isolation',
      'family_parenting_conflict',
      'burnout_exhaustion',
      'spiritual_dryness',
      'financial_hardship',
      'chronic_illness',
      'relationship_conflict_forgiveness',
    ]) {
      assert.ok(match.includes(`'${domain}'`), `${domain}이 domain_expansion 목록에 없습니다.`);
    }

    assert.ok(
      match.includes("research_kind = 'taxonomy_discovery' and target_domain = 'other_uncovered'"),
    );
    // other_uncovered가 domain_expansion 목록에 들어가면 안 된다.
    const expansionList = match.slice(match.indexOf('domain_expansion'), match.indexOf('taxonomy_discovery'));
    assert.equal(expansionList.includes('other_uncovered'), false);
  });

  it('같은 영역·같은 종류의 과제는 하나만 존재한다', () => {
    const sql = queueSql();
    assert.ok(sql.includes('unique (target_domain, research_kind)'), '중복 방지 제약이 없습니다.');
    assert.ok(sql.includes('on conflict (target_domain, research_kind) do update'), 'upsert가 없습니다.');
  });

  it('근거 수치를 coverage_gap_daily 집계에서 계산한다', () => {
    const sql = queueSql();
    assert.ok(sql.includes('from private.coverage_gap_daily g'));
    assert.ok(sql.includes('group by g.primary_domain'), '영역별로 모으지 않습니다.');
    assert.ok(sql.includes('min(g.bucket_date)'));
    assert.ok(sql.includes('max(g.bucket_date)'));
    assert.ok(sql.includes('sum(g.gap_count)'));
    assert.ok(
      sql.includes('filter (where g.bucket_date between today - 6 and today)'),
      '7일 집계가 없습니다.',
    );
    assert.ok(
      sql.includes('filter (where g.bucket_date between today - 29 and today)'),
      '30일 집계가 없습니다.',
    );
    assert.ok(sql.includes("(now() at time zone 'Asia/Seoul')::date"), 'Asia/Seoul 기준이 아닙니다.');
  });

  it('다시 실행하면 근거만 갱신하고 상태는 건드리지 않는다', () => {
    const sql = queueSql();
    const update = sql.slice(sql.indexOf('do update'), sql.indexOf('get diagnostics'));

    assert.ok(update.includes('first_detected_date = least('), '최초 발생일이 유지되지 않습니다.');
    assert.ok(update.includes('last_detected_date = greatest('));
    assert.ok(update.includes('total_gap_count = excluded.total_gap_count'));
    assert.ok(update.includes('recent_7d_count = excluded.recent_7d_count'));
    assert.ok(update.includes('recent_30d_count = excluded.recent_30d_count'));
    assert.ok(update.includes('evidence_version = q.evidence_version + 1'));
    assert.equal(update.includes('status ='), false, 'refresh가 상태를 바꿉니다.');
  });

  it('새 과제는 queued로 시작하고 자동으로 진행되지 않는다', () => {
    const sql = queueSql();
    assert.ok(sql.includes("status text not null default 'queued'"));
    const body = sql.slice(sql.indexOf('create function public.refresh_content_research_queue'));
    for (const auto of ["'ready'", "'researching'", "'completed'"]) {
      assert.equal(body.includes(`status = ${auto}`), false, `refresh가 상태를 ${auto}로 바꿉니다.`);
    }
  });

  it('refresh 함수는 인자가 없고 서버만 실행할 수 있다', () => {
    const sql = queueSql();
    assert.ok(sql.includes('create function public.refresh_content_research_queue()'));
    assert.equal(sql.includes('create or replace function public.refresh_content_research_queue'), false);
    assert.ok(sql.includes('security definer'));
    assert.ok(sql.includes('set search_path = private, pg_catalog'));
    assert.ok(sql.includes('revoke all on function public.refresh_content_research_queue() from public;'));
    assert.ok(
      sql.includes(
        'revoke all on function public.refresh_content_research_queue() from anon, authenticated, service_role;',
      ),
    );
    assert.ok(
      sql.includes('grant execute on function public.refresh_content_research_queue() to service_role'),
    );
    assert.equal(
      sql.includes('grant execute on function public.refresh_content_research_queue() to authenticated'),
      false,
    );
  });

  it('표에 RLS가 켜져 있고 직접 접근 권한이 없다', () => {
    const sql = queueSql();
    assert.ok(sql.includes('alter table private.content_research_queue enable row level security'));
    assert.ok(sql.includes('revoke all on table private.content_research_queue from public;'));
    assert.ok(
      sql.includes('revoke all on table private.content_research_queue from anon, authenticated, service_role;'),
    );
    assert.equal(sql.includes('create policy'), false, '사용자 policy가 있습니다.');
  });

  it('기존 Coverage Gap / Rate Limit 마이그레이션을 건드리지 않는다', () => {
    const sql = queueSql();
    assert.equal(sql.includes('alter table private.coverage_gap_daily'), false);
    assert.equal(sql.includes('drop '), false);
    assert.equal(sql.includes('record_coverage_gap'), false);
    assert.equal(sql.includes('consume_openai_quota'), false);
    // 읽기만 한다.
    assert.equal(sql.includes('insert into private.coverage_gap_daily'), false);
    assert.equal(sql.includes('update private.coverage_gap_daily'), false);
  });
});

describe('Research Queue v1 · 갱신 규칙 (SQL)', () => {
  const queueSql = () =>
    readFileSync(
      path.join(projectRoot, 'supabase/migrations/20260828223535_content_research_queue.sql'),
      'utf8',
    );

  it('근거가 실제로 달라졌을 때만 갱신한다', () => {
    const sql = queueSql();
    const where = sql.slice(sql.indexOf('do update'), sql.indexOf('get diagnostics'));

    assert.ok(where.includes('where q.total_gap_count is distinct from excluded.total_gap_count'));
    for (const field of ['recent_7d_count', 'recent_30d_count']) {
      assert.ok(
        where.includes(`or q.${field} is distinct from excluded.${field}`),
        `${field} 변화 확인이 없습니다.`,
      );
    }
    assert.ok(
      where.includes('or q.first_detected_date is distinct from least(q.first_detected_date, excluded.first_detected_date)'),
    );
    assert.ok(
      where.includes('or q.last_detected_date is distinct from greatest(q.last_detected_date, excluded.last_detected_date)'),
    );
  });

  it('같은 자료로 다시 실행하면 버전과 시각이 그대로다', () => {
    const sql = queueSql();
    const update = sql.slice(sql.indexOf('do update'), sql.indexOf('get diagnostics'));

    // 버전 증가와 시각 갱신이 WHERE 조건 안쪽에 있어야 한다.
    const versionAt = update.indexOf('evidence_version = q.evidence_version + 1');
    const updatedAt = update.indexOf('updated_at = now()');
    const whereAt = update.indexOf('where q.total_gap_count is distinct from');

    assert.ok(versionAt > -1 && updatedAt > -1 && whereAt > -1);
    assert.ok(versionAt < whereAt, 'evidence_version 증가가 조건 밖에 있습니다.');
    assert.ok(updatedAt < whereAt, 'updated_at 갱신이 조건 밖에 있습니다.');
  });

  it('7일/30일 집계에 오늘 이후 날짜가 들어가지 않는다', () => {
    const sql = queueSql();
    assert.ok(sql.includes('filter (where g.bucket_date between today - 6 and today)'));
    assert.ok(sql.includes('filter (where g.bucket_date between today - 29 and today)'));
    assert.equal(sql.includes('filter (where g.bucket_date >= today - 6)'), false);
    assert.equal(sql.includes('filter (where g.bucket_date >= today - 29)'), false);
  });

  it('other_uncovered는 처음부터 blocked, 나머지 7개는 queued로 만든다', () => {
    const sql = queueSql();
    const insert = sql.slice(sql.indexOf('insert into private.content_research_queue'), sql.indexOf('from private.coverage_gap_daily'));

    assert.ok(insert.includes('status,'), 'insert에 status를 넣지 않습니다.');
    assert.ok(
      insert.includes("when g.primary_domain = 'other_uncovered' then 'blocked'"),
      'other_uncovered가 blocked로 생성되지 않습니다.',
    );
    assert.ok(insert.includes("else 'queued'"), '과거 확장 연구 영역이 queued로 생성되지 않습니다.');
    assert.ok(
      insert.includes("when g.primary_domain = 'other_uncovered' then 'taxonomy_discovery'"),
    );
    assert.ok(insert.includes("else 'domain_expansion'"));
  });

  it('refresh는 status를 바꾸지 않는다 (blocked가 풀리지 않는다)', () => {
    const sql = queueSql();
    const update = sql.slice(sql.indexOf('do update'), sql.indexOf('get diagnostics'));
    assert.equal(update.includes('status ='), false, 'refresh가 상태를 바꿉니다.');
  });

  it('taxonomy_discovery를 영원히 막는 제약은 두지 않는다', () => {
    const sql = queueSql();
    // 나중에 별도 과정이 상태를 바꿀 수 있어야 한다.
    assert.equal(
      sql.includes("research_kind = 'taxonomy_discovery' and status = 'blocked'"),
      false,
      '상태를 영구 고정하는 제약이 있습니다.',
    );
  });
});

describe('Research Queue v1 · 미래 날짜 제외 보강 (SQL)', () => {
  const hardenPath = 'supabase/migrations/20260828223619_harden_content_research_queue_future_dates.sql';
  const hardenSql = () => readFileSync(path.join(projectRoot, hardenPath), 'utf8');

  it('후속 마이그레이션 파일이 있고 함수만 교체한다', () => {
    const sql = hardenSql();
    assert.ok(sql.includes('create or replace function public.refresh_content_research_queue()'));

    // 표, 제약, RLS, 표 권한은 건드리지 않는다.
    assert.equal(sql.includes('create table'), false);
    assert.equal(sql.includes('alter table'), false);
    assert.equal(sql.includes('drop '), false);
    assert.equal(sql.includes('revoke all on table'), false);
    assert.equal(sql.includes('create policy'), false);
  });

  it('미래 날짜 행을 모든 근거에서 제외한다', () => {
    const sql = hardenSql();
    const select = sql.slice(sql.indexOf('from private.coverage_gap_daily g'), sql.indexOf('group by g.primary_domain'));

    assert.ok(select.includes('where g.bucket_date <= today'), '미래 날짜 제외 조건이 없습니다.');
  });

  it('기존 갱신 규칙이 그대로 유지된다', () => {
    const sql = hardenSql();

    // 근거가 달라졌을 때만 갱신
    assert.ok(sql.includes('where q.total_gap_count is distinct from excluded.total_gap_count'));
    assert.ok(sql.includes('or q.recent_7d_count is distinct from excluded.recent_7d_count'));
    assert.ok(sql.includes('or q.recent_30d_count is distinct from excluded.recent_30d_count'));
    assert.ok(sql.includes('evidence_version = q.evidence_version + 1'));

    // 최초 생성 시 종류와 상태
    assert.ok(sql.includes("when g.primary_domain = 'other_uncovered' then 'taxonomy_discovery'"));
    assert.ok(sql.includes("else 'domain_expansion'"));
    assert.ok(sql.includes("when g.primary_domain = 'other_uncovered' then 'blocked'"));
    assert.ok(sql.includes("else 'queued'"));

    // 7일 / 30일 창
    assert.ok(sql.includes('filter (where g.bucket_date between today - 6 and today)'));
    assert.ok(sql.includes('filter (where g.bucket_date between today - 29 and today)'));
    assert.ok(sql.includes("(now() at time zone 'Asia/Seoul')::date"));

    // conflict 갱신에서 상태를 바꾸지 않는다.
    const update = sql.slice(sql.indexOf('do update'), sql.indexOf('get diagnostics'));
    assert.equal(update.includes('status ='), false);
  });

  it('보안 설정과 권한을 다시 명시한다', () => {
    const sql = hardenSql();

    assert.ok(sql.includes('security definer'));
    assert.ok(sql.includes('set search_path = private, pg_catalog'));
    assert.ok(sql.includes('revoke all on function public.refresh_content_research_queue() from public;'));
    assert.ok(
      sql.includes(
        'revoke all on function public.refresh_content_research_queue() from anon, authenticated, service_role;',
      ),
    );
    assert.ok(
      sql.includes('grant execute on function public.refresh_content_research_queue() to service_role'),
    );
    assert.equal(
      sql.includes('grant execute on function public.refresh_content_research_queue() to authenticated'),
      false,
    );
  });

  it('사용자 정보를 다루지 않는다', () => {
    const sql = hardenSql().replace(/^\s*--.*$/gm, '').toLowerCase();
    for (const banned of ['user_id', 'auth.uid()', 'auth.users', 'situation', 'jwt', 'ip_address', 'session_id', 'device_id']) {
      assert.equal(sql.includes(banned), false, `${banned}가 있습니다.`);
    }
  });

  it('마이그레이션 순서가 앞선 Queue 마이그레이션 뒤에 온다', () => {
    const files = readdirSync(path.join(projectRoot, 'supabase/migrations'))
      .filter((name) => name.endsWith('.sql'))
      .sort();

    const base = files.indexOf('20260828223535_content_research_queue.sql');
    const harden = files.indexOf('20260828223619_harden_content_research_queue_future_dates.sql');

    assert.ok(base > -1 && harden > -1);
    assert.ok(harden > base, '보강 마이그레이션이 원본보다 앞에 있습니다.');
  });
});

describe('Prioritizer 읽기 전용 RPC (SQL)', () => {
  const rpcPath = 'supabase/migrations/20260828231933_research_queue_prioritizer_read_rpc.sql';
  const rpcSql = () => readFileSync(path.join(projectRoot, rpcPath), 'utf8');
  const withoutComments = () => rpcSql().replace(/^\s*--.*$/gm, '');

  it('인자 없는 함수를 새로 만든다', () => {
    const sql = rpcSql();
    assert.ok(sql.includes('create function public.get_content_research_queue_for_prioritizer()'));
    assert.equal(sql.includes('create or replace function'), false, '기존 객체를 덮어씁니다.');
  });

  it('SECURITY DEFINER와 고정 search_path를 쓴다', () => {
    const sql = rpcSql();
    assert.ok(sql.includes('security definer'));
    assert.ok(sql.includes('set search_path = private, pg_catalog'));
    assert.ok(sql.includes('stable'), '읽기 전용 표시가 없습니다.');
  });

  it('읽기만 하고 아무것도 고치지 않는다', () => {
    const body = withoutComments().toLowerCase();

    assert.ok(body.includes('select'));
    assert.ok(body.includes('from private.content_research_queue'));
    for (const banned of ['insert into', 'update ', 'delete from', 'truncate', 'drop ', 'alter table']) {
      assert.equal(body.includes(banned), false, `${banned}가 있습니다.`);
    }
    assert.equal(body.includes('auth.uid()'), false);
  });

  it('필요한 9개 값만 돌려준다', () => {
    const sql = rpcSql();
    const returns = sql.slice(sql.indexOf('returns table ('), sql.indexOf(')\nlanguage sql'));

    for (const column of [
      'target_domain text',
      'research_kind text',
      'status text',
      'total_gap_count bigint',
      'recent_7d_count bigint',
      'recent_30d_count bigint',
      'first_detected_date date',
      'last_detected_date date',
      'evidence_version bigint',
    ]) {
      assert.ok(returns.includes(column), `${column}이 없습니다.`);
    }

    for (const banned of ['id ', 'created_at', 'updated_at']) {
      assert.equal(returns.includes(banned), false, `${banned}를 돌려줍니다.`);
    }
  });

  it('queued + domain_expansion만, 과거 확장 연구 7개만 돌려준다', () => {
    const sql = rpcSql();
    const where = sql.slice(sql.indexOf('where q.research_kind'), sql.indexOf('order by'));

    assert.ok(where.includes("q.research_kind = 'domain_expansion'"));
    assert.ok(where.includes("q.status = 'queued'"));
    assert.ok(where.includes('q.total_gap_count > 0'));
    assert.ok(where.includes('q.evidence_version >= 1'));

    for (const domain of [
      'loneliness_isolation',
      'family_parenting_conflict',
      'burnout_exhaustion',
      'spiritual_dryness',
      'financial_hardship',
      'chronic_illness',
      'relationship_conflict_forgiveness',
    ]) {
      assert.ok(where.includes(`'${domain}'`), `${domain}이 목록에 없습니다.`);
    }

    assert.equal(where.includes('other_uncovered'), false, 'other_uncovered가 나올 수 있습니다.');
    assert.equal(where.includes('taxonomy_discovery'), false, 'taxonomy_discovery가 나올 수 있습니다.');
  });

  it('결과 순서가 정해져 있다', () => {
    assert.ok(rpcSql().includes('order by q.target_domain asc'));
  });

  it('서버만 실행할 수 있다', () => {
    const sql = rpcSql();
    assert.ok(sql.includes('revoke all on function public.get_content_research_queue_for_prioritizer() from public;'));
    assert.ok(
      sql.includes(
        'revoke all on function public.get_content_research_queue_for_prioritizer() from anon, authenticated, service_role;',
      ),
    );
    assert.ok(
      sql.includes('grant execute on function public.get_content_research_queue_for_prioritizer() to service_role'),
    );
    assert.equal(
      sql.includes('grant execute on function public.get_content_research_queue_for_prioritizer() to authenticated'),
      false,
    );
  });

  it('표 자체의 권한은 건드리지 않는다', () => {
    const sql = rpcSql();
    assert.equal(sql.includes('grant select on table'), false, '표 직접 읽기 권한을 줍니다.');
    assert.equal(sql.includes('revoke all on table'), false);
    assert.equal(sql.includes('alter table'), false);
    assert.equal(sql.includes('create policy'), false);
    assert.equal(sql.includes('create table'), false);
  });

  it('다른 기능의 표나 함수를 건드리지 않는다', () => {
    const sql = rpcSql();
    for (const other of [
      'coverage_gap_daily',
      'record_coverage_gap',
      'openai_rate_limit_state',
      'consume_openai_quota',
      'refresh_content_research_queue',
    ]) {
      assert.equal(sql.includes(other), false, `${other}를 건드립니다.`);
    }
  });

  it('마이그레이션 순서가 Research Queue 뒤에 온다', () => {
    const files = readdirSync(path.join(projectRoot, 'supabase/migrations'))
      .filter((name) => name.endsWith('.sql'))
      .sort();

    assert.ok(
      files.indexOf('20260828231933_research_queue_prioritizer_read_rpc.sql') >
        files.indexOf('20260828223619_harden_content_research_queue_future_dates.sql'),
    );
  });
});

describe('research-prioritizer 구조', () => {
  const dir = () => path.join(functionsDir, 'research-prioritizer');
  const code = (file: string) => stripComments(readFileSync(path.join(dir(), file), 'utf8'));

  it('사용자용 사용량 제한을 쓰지 않는다', () => {
    for (const file of ['index.ts', 'handler.ts']) {
      assert.equal(code(file).includes('consume_openai_quota'), false, file);
      assert.equal(code(file).includes('checkQuota'), false, file);
    }
  });

  it('Queue를 읽기 전용 RPC로만 읽는다', () => {
    const index = code('index.ts');
    assert.ok(index.includes('get_content_research_queue_for_prioritizer'));
    assert.equal(index.includes('content_research_queue?'), false, '표를 직접 읽습니다.');
    assert.equal(index.includes('/rest/v1/content_research_queue'), false, '표를 직접 읽습니다.');
  });

  it('DB를 고치는 호출이 없다', () => {
    for (const file of ['index.ts', 'handler.ts']) {
      const source = code(file);
      for (const banned of ['refresh_content_research_queue', 'record_coverage_gap', 'insert into', 'delete from']) {
        assert.equal(source.includes(banned), false, `${file}에 ${banned}가 있습니다.`);
      }
    }
  });

  it('내부 전용 자격과 서버 전용 키만 서버에서 읽는다', () => {
    const index = code('index.ts');
    assert.ok(index.includes("Deno.env.get('RESEARCH_PRIORITIZER_TOKEN')"));
    assert.ok(index.includes("Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')"));
    assert.ok(index.includes("Deno.env.get('OPENAI_API_KEY')"));
    assert.equal(index.includes('EXPO_PUBLIC'), false);
    assert.equal(code('handler.ts').includes('Deno'), false, 'handler에 Deno 코드가 있습니다.');
  });
});
