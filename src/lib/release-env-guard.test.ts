/**
 * 빌드 전 공개 환경변수 점검 · 계약 테스트
 *
 * 실행: npm test
 *
 * 어떻게 시험하는가:
 *   글자를 읽어서 짐작하지 않는다. 실제로 그 파일을 별도 프로세스로 돌린다.
 *   가짜 환경변수만 넣어 주고, 나온 종료 코드와 출력만 본다.
 *   EAS Build가 하는 일과 같은 방식이다.
 *
 * 사용자의 진짜 .env.local 값은 절대 쓰지 않는다.
 * 아래 fixture는 형식만 흉내 낸 가짜다. 실제 어디에도 통하지 않는다.
 *
 * 지키려는 것:
 *   값이 없으면 빌드가 선다.
 *   예시 값이면 빌드가 선다.
 *   서버 전용 key가 앱 자리에 오면 빌드가 선다.
 *   그리고 어떤 경우에도 값이 출력에 남지 않는다.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

const GUARD_PATH = fileURLToPath(new URL('../../scripts/check-public-env.mjs', import.meta.url));
const PACKAGE_JSON_PATH = fileURLToPath(new URL('../../package.json', import.meta.url));

const GUARD_SOURCE = readFileSync(GUARD_PATH, 'utf8');

/** 주석은 설명일 뿐 동작이 아니다. 동작을 볼 때는 주석을 걷어내고 본다. */
const GUARD_CODE = GUARD_SOURCE.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '');
const PACKAGE_JSON = JSON.parse(readFileSync(PACKAGE_JSON_PATH, 'utf8')) as {
  scripts: Record<string, string>;
};

/** 형식만 흉내 낸 가짜 값. 진짜 주소도 진짜 key도 아니다. */
const FAKE_URL = 'https://abcdefghijklmnopqrst.supabase.co';
const FAKE_KEY = 'sb_publishable_FIXTUREONLYnotarealkey0123456789';

/**
 * 격리된 환경변수만 주고 점검 파일을 실제로 실행한다.
 *
 * 이 테스트를 돌리는 컴퓨터의 진짜 환경변수가 새어 들어가면
 * 시험이 통과했는지 우연히 통과했는지 알 수 없게 된다.
 * 그래서 여기 적은 값 말고는 아무것도 넘기지 않는다.
 */
function runGuard(env: Record<string, string>) {
  const result = spawnSync(process.execPath, [GUARD_PATH], {
    // Expo가 NODE_ENV를 반드시 있는 값으로 선언해 두어서 타입만 맞춰 준다.
    // 실제로 넘기는 값은 위에서 적은 것뿐이다. 진짜 환경변수는 넘어가지 않는다.
    env: env as NodeJS.ProcessEnv,
    encoding: 'utf8',
  });
  return {
    code: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    output: `${result.stdout ?? ''}${result.stderr ?? ''}`,
  };
}

const bothValid = () => ({
  EXPO_PUBLIC_SUPABASE_URL: FAKE_URL,
  EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY: FAKE_KEY,
});

/* ================================================================== */
/* A. 값이 갖춰지면 지나간다                                            */
/* ================================================================== */

describe('빌드 환경 점검 · A. 정상 설정', () => {
  it('두 값이 모두 정상이면 통과한다', () => {
    const run = runGuard(bothValid());
    assert.equal(run.code, 0);
    assert.equal(run.stderr, '');
    assert.match(run.stdout, /Required public environment variables are configured/);
  });

  it('통과했을 때도 주소와 key가 출력에 남지 않는다', () => {
    const run = runGuard(bothValid());
    assert.equal(run.output.includes(FAKE_URL), false);
    assert.equal(run.output.includes(FAKE_KEY), false);
    // 주소 일부나 key 일부도 남기지 않는다.
    assert.equal(run.output.includes('abcdefghijklmnopqrst'), false);
    assert.equal(run.output.includes('FIXTUREONLY'), false);
  });

  it('앞뒤 빈 칸이 있어도 정상 값으로 본다', () => {
    const run = runGuard({
      EXPO_PUBLIC_SUPABASE_URL: `  ${FAKE_URL}  `,
      EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY: ` ${FAKE_KEY} `,
    });
    assert.equal(run.code, 0);
  });
});

/* ================================================================== */
/* B. 값이 없으면 선다                                                  */
/* ================================================================== */

describe('빌드 환경 점검 · B. 값 없음', () => {
  it('주소가 없으면 멈춘다', () => {
    const run = runGuard({ EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY: FAKE_KEY });
    assert.equal(run.code, 1);
    assert.match(run.stderr, /Missing required variable: EXPO_PUBLIC_SUPABASE_URL/);
  });

  it('key가 없으면 멈춘다', () => {
    const run = runGuard({ EXPO_PUBLIC_SUPABASE_URL: FAKE_URL });
    assert.equal(run.code, 1);
    assert.match(run.stderr, /Missing required variable: EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY/);
  });

  it('둘 다 없으면 멈추고 두 이름을 모두 알려준다', () => {
    const run = runGuard({});
    assert.equal(run.code, 1);
    assert.match(run.stderr, /Missing required variable: EXPO_PUBLIC_SUPABASE_URL/);
    assert.match(run.stderr, /Missing required variable: EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY/);
  });

  it('빈 문자열은 없는 것으로 본다', () => {
    const run = runGuard({
      EXPO_PUBLIC_SUPABASE_URL: '',
      EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY: '',
    });
    assert.equal(run.code, 1);
    assert.match(run.stderr, /Missing required variable: EXPO_PUBLIC_SUPABASE_URL/);
    assert.match(run.stderr, /Missing required variable: EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY/);
  });

  it('주소가 빈 칸뿐이면 없는 것으로 본다', () => {
    const run = runGuard({
      EXPO_PUBLIC_SUPABASE_URL: '   ',
      EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY: FAKE_KEY,
    });
    assert.equal(run.code, 1);
    assert.match(run.stderr, /Missing required variable: EXPO_PUBLIC_SUPABASE_URL/);
  });

  it('key가 빈 칸뿐이면 없는 것으로 본다', () => {
    const run = runGuard({
      EXPO_PUBLIC_SUPABASE_URL: FAKE_URL,
      EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY: '\t \n ',
    });
    assert.equal(run.code, 1);
    assert.match(run.stderr, /Missing required variable: EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY/);
  });

  it("설정 도구가 넣은 'undefined' / 'null' 글자도 없는 것으로 본다", () => {
    const run = runGuard({
      EXPO_PUBLIC_SUPABASE_URL: 'undefined',
      EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY: 'null',
    });
    assert.equal(run.code, 1);
    assert.match(run.stderr, /Missing required variable: EXPO_PUBLIC_SUPABASE_URL/);
    assert.match(run.stderr, /Missing required variable: EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY/);
  });
});

/* ================================================================== */
/* C. 주소가 잘못되면 선다                                              */
/* ================================================================== */

describe('빌드 환경 점검 · C. 주소', () => {
  const withUrl = (url: string) =>
    runGuard({
      EXPO_PUBLIC_SUPABASE_URL: url,
      EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY: FAKE_KEY,
    });

  it('주소 형식이 아니면 멈춘다', () => {
    const run = withUrl('not-a-url');
    assert.equal(run.code, 1);
    assert.match(run.stderr, /Invalid or placeholder value: EXPO_PUBLIC_SUPABASE_URL/);
  });

  it('http 는 받지 않는다', () => {
    const run = withUrl('http://abcdefghijklmnopqrst.supabase.co');
    assert.equal(run.code, 1);
    assert.match(run.stderr, /Invalid or placeholder value: EXPO_PUBLIC_SUPABASE_URL/);
  });

  it('주소에 아이디·비밀번호가 들어 있으면 멈춘다', () => {
    const run = withUrl('https://user:pass@abcdefghijklmnopqrst.supabase.co');
    assert.equal(run.code, 1);
    assert.match(run.stderr, /Invalid or placeholder value: EXPO_PUBLIC_SUPABASE_URL/);
    // 비밀번호가 출력에 남지 않는다.
    assert.equal(run.output.includes('pass'), false);
  });

  it('주소 뒤에 경로가 붙으면 멈춘다', () => {
    const run = withUrl('https://abcdefghijklmnopqrst.supabase.co/rest/v1');
    assert.equal(run.code, 1);
  });

  it('호스트 이름이 온전하지 않으면 멈춘다', () => {
    const run = withUrl('https://localhost');
    assert.equal(run.code, 1);
  });

  it('끝에 / 하나가 붙은 정상 주소는 받는다', () => {
    const run = withUrl(`${FAKE_URL}/`);
    assert.equal(run.code, 0);
  });

  it('supabase.co 가 아닌 회사 도메인도 막지 않는다', () => {
    // 나중에 회사 도메인을 연결해도 이 점검이 정상 설정을 거부하면 안 된다.
    const run = withUrl('https://db.aroeda.app');
    assert.equal(run.code, 0);
  });
});

/* ================================================================== */
/* D. 예시 값이면 선다                                                  */
/* ================================================================== */

describe('빌드 환경 점검 · D. 예시 값', () => {
  it('.env.example 의 주소가 그대로 오면 멈춘다', () => {
    // 한글 호스트는 new URL() 이 xn-- 로 바꿔 버린다.
    // 예시 값 검사가 주소 해석보다 먼저 돌지 않으면 이 경우를 놓친다.
    const run = runGuard({
      EXPO_PUBLIC_SUPABASE_URL: 'https://프로젝트주소.supabase.co',
      EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY: FAKE_KEY,
    });
    assert.equal(run.code, 1);
    assert.match(run.stderr, /Invalid or placeholder value: EXPO_PUBLIC_SUPABASE_URL/);
  });

  it('.env.example 의 key가 그대로 오면 멈춘다', () => {
    const run = runGuard({
      EXPO_PUBLIC_SUPABASE_URL: FAKE_URL,
      EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_...',
    });
    assert.equal(run.code, 1);
    assert.match(run.stderr, /Invalid or placeholder value: EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY/);
  });

  it('흔한 예시 표현들을 모두 잡는다', () => {
    for (const url of [
      'https://your-project.supabase.co',
      'https://YOUR_PROJECT.supabase.co',
      'https://example.supabase.co',
      'https://placeholder.supabase.co',
      'https://<project>.supabase.co',
    ]) {
      const run = runGuard({
        EXPO_PUBLIC_SUPABASE_URL: url,
        EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY: FAKE_KEY,
      });
      assert.equal(run.code, 1, url);
    }
  });

  it('.env.example 파일이 실제로 이 점검에 걸린다', () => {
    // 예시 파일의 값이 바뀌어도 점검이 계속 잡는지 확인한다.
    const example = readFileSync(fileURLToPath(new URL('../../.env.example', import.meta.url)), 'utf8');
    const pick = (name: string) => {
      const line = example.split(/\r?\n/).find((l) => l.startsWith(`${name}=`));
      assert.ok(line, name);
      return line!.slice(name.length + 1);
    };
    const run = runGuard({
      EXPO_PUBLIC_SUPABASE_URL: pick('EXPO_PUBLIC_SUPABASE_URL'),
      EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY: pick('EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY'),
    });
    assert.equal(run.code, 1);
    assert.match(run.stderr, /EXPO_PUBLIC_SUPABASE_URL/);
    assert.match(run.stderr, /EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY/);
  });
});

/* ================================================================== */
/* E. 서버 전용 key가 앱 자리에 오면 선다                               */
/* ================================================================== */

describe('빌드 환경 점검 · E. 서버 비밀값 차단', () => {
  it('sb_secret_ key를 앱 자리에 넣으면 멈춘다', () => {
    const run = runGuard({
      EXPO_PUBLIC_SUPABASE_URL: FAKE_URL,
      EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY: 'sb_secret_LEAKCANARY0000000000',
    });
    assert.equal(run.code, 1);
    assert.match(run.stderr, /Invalid or placeholder value: EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY/);
    // 멈추는 것만으로는 부족하다. 무엇을 잘못했는지 정확히 말해 주어야 한다.
    // 이 실수는 데이터베이스 전체가 열리는 실수라서, 형식이 틀렸다는 말로 끝내면 안 된다.
    assert.match(run.stderr, /서버 전용 key가 들어 있습니다/);
  });

  it('서버 key를 막을 때도 그 값이 출력에 남지 않는다', () => {
    // 여기서 값이 새면, 막으려던 비밀값을 빌드 기록에 직접 적어 넣는 셈이 된다.
    const run = runGuard({
      EXPO_PUBLIC_SUPABASE_URL: FAKE_URL,
      EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY: 'sb_secret_LEAKCANARY0000000000',
    });
    assert.equal(run.output.includes('LEAKCANARY'), false);
    assert.equal(run.output.includes('sb_secret_LEAKCANARY0000000000'), false);
  });

  it('옛 형식 JWT key는 받지 않는다', () => {
    // 옛 형식은 공개용과 서버용이 똑같이 생겨서 구분할 수 없다.
    const run = runGuard({
      EXPO_PUBLIC_SUPABASE_URL: FAKE_URL,
      EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY: 'eyJhbGciOiJIUzI1NiJ9.LEAKCANARY.signature',
    });
    assert.equal(run.code, 1);
    assert.equal(run.output.includes('LEAKCANARY'), false);
    // 형식이 틀렸다가 아니라, 옛 형식이라 새 key가 필요하다고 말해 준다.
    assert.match(run.stderr, /옛 형식 key입니다/);
  });

  it('publishable 형식이 아닌 key는 받지 않는다', () => {
    const run = runGuard({
      EXPO_PUBLIC_SUPABASE_URL: FAKE_URL,
      EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY: 'randomstring1234567890',
    });
    assert.equal(run.code, 1);
    assert.match(run.stderr, /sb_publishable_ 로 시작해야 합니다/);
  });

  it('앞부분만 있고 내용이 없는 key는 받지 않는다', () => {
    const run = runGuard({
      EXPO_PUBLIC_SUPABASE_URL: FAKE_URL,
      EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_',
    });
    assert.equal(run.code, 1);
  });

  it('서버 전용 비밀값을 요구하지 않는다', () => {
    // 두 공개 값만 있으면 통과해야 한다. 서버 비밀값은 앱 빌드에 필요 없다.
    // 아래 환경에는 서버 비밀값이 하나도 없다. 그래도 통과해야 한다.
    const run = runGuard(bothValid());
    assert.equal(run.code, 0);
  });

  it('반드시 있어야 하는 값은 공개 값 둘뿐이다', () => {
    // 이름이 주석에 적혀 있는 것과 실제로 읽는 것은 다르다.
    // 그래서 글자가 아니라 "환경변수를 꺼내는 자리"만 본다.
    const reads = GUARD_CODE.match(/process\.env[.[]?[A-Za-z_'"[\]]*/g) ?? [];
    assert.deepEqual(reads, ['process.env']);

    // 꺼낸 환경변수에서 찾는 이름은 REQUIRED 목록 둘뿐이다.
    const required = GUARD_CODE.match(/^const REQUIRED = \[([^\]]*)\]/m);
    assert.ok(required);
    assert.deepEqual(
      required![1].split(',').map((s) => s.trim().replace(/^'|'$/g, '')),
      ['EXPO_PUBLIC_SUPABASE_URL', 'EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY'],
    );
  });
});

/* ================================================================== */
/* F. 값이 절대 밖으로 나가지 않는다                                    */
/* ================================================================== */

describe('빌드 환경 점검 · F. 값 유출 없음', () => {
  it('실패해도 값을 그대로 찍지 않는다', () => {
    const canaryUrl = 'https://LEAKCANARYHOST.supabase.co/leakpath';
    const canaryKey = 'sb_publishable_LEAKCANARYKEY';
    const run = runGuard({
      EXPO_PUBLIC_SUPABASE_URL: canaryUrl,
      EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY: canaryKey,
    });
    assert.equal(run.code, 1);
    assert.equal(run.output.includes('LEAKCANARY'), false);
    assert.equal(run.output.includes(canaryUrl), false);
    assert.equal(run.output.includes(canaryKey), false);
  });

  it('한쪽이 틀려도 다른 쪽 값을 꺼내지 않는다', () => {
    const run = runGuard({
      EXPO_PUBLIC_SUPABASE_URL: 'not-a-url',
      EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY: FAKE_KEY,
    });
    assert.equal(run.code, 1);
    assert.equal(run.output.includes(FAKE_KEY), false);
    assert.equal(run.output.includes('FIXTUREONLY'), false);
  });

  it('점검 파일이 값을 문장에 끼워 넣는 자리를 두지 않는다', () => {
    // 값을 담은 변수를 메시지에 넣으면 여기서 걸린다.
    for (const banned of ['${value}', '${raw}', '${parsed', '${env[']) {
      assert.equal(GUARD_SOURCE.includes(banned), false, banned);
    }
    // 값을 가려서 보여주는 것도 하지 않는다. 가린 값도 흔적이다.
    for (const banned of ['slice(0, 4)', 'substring(0,', 'mask', '.length}']) {
      assert.equal(GUARD_SOURCE.includes(banned), false, banned);
    }
  });

  it('바깥 꾸러미를 쓰지 않는다', () => {
    // 이 파일은 패키지를 내려받기 전에 돌기 때문에 아무 꾸러미도 없다.
    assert.equal(/^import\s/m.test(GUARD_SOURCE), false);
    assert.equal(GUARD_SOURCE.includes('require('), false);
  });
});

/* ================================================================== */
/* G. EAS 빌드에 실제로 연결돼 있다                                     */
/* ================================================================== */

describe('빌드 환경 점검 · G. 빌드 연결', () => {
  it('EAS 빌드가 부르는 자리에 정확히 연결돼 있다', () => {
    assert.equal(
      PACKAGE_JSON.scripts['eas-build-pre-install'],
      'node scripts/check-public-env.mjs',
    );
  });

  it('손으로 확인하는 명령도 있다', () => {
    assert.equal(PACKAGE_JSON.scripts['check:public-env'], 'node scripts/check-public-env.mjs');
  });

  it('두 명령이 같은 파일을 가리킨다', () => {
    assert.equal(
      PACKAGE_JSON.scripts['eas-build-pre-install'],
      PACKAGE_JSON.scripts['check:public-env'],
    );
  });

  it('기존 명령이 그대로 남아 있다', () => {
    assert.equal(PACKAGE_JSON.scripts.start, 'expo start');
    // 화면 테스트가 생기면서 test가 둘로 나뉘었다.
    // 나뉘었을 뿐 기존 Node 명령은 글자 하나 바뀌지 않아야 한다.
    assert.equal(
      PACKAGE_JSON.scripts['test:logic'],
      'node --test "src/lib/*.test.ts" "supabase/functions/**/*.test.ts"',
    );
    assert.equal(PACKAGE_JSON.scripts.test, 'npm run test:logic && npm run test:ui');
    assert.equal(PACKAGE_JSON.scripts.ios, 'expo start --ios');
    assert.equal(PACKAGE_JSON.scripts.android, 'expo start --android');
    assert.equal(PACKAGE_JSON.scripts.web, 'expo start --web');
    assert.equal(PACKAGE_JSON.scripts.lint, 'expo lint');
  });

  it('로컬 개발 흐름에 이 점검을 끼워 넣지 않는다', () => {
    // npm start 와 npm test 는 지금처럼 Expo가 .env.local 을 읽는 흐름 그대로 둔다.
    assert.equal(PACKAGE_JSON.scripts.start.includes('check-public-env'), false);
    assert.equal(PACKAGE_JSON.scripts.test.includes('check-public-env'), false);
    assert.equal('prestart' in PACKAGE_JSON.scripts, false);
    assert.equal('pretest' in PACKAGE_JSON.scripts, false);
  });
});
