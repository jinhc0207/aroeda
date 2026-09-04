/**
 * 빌드 전 공개 환경변수 점검
 *
 * 왜 필요한가:
 *   아뢰다 앱은 Supabase 주소와 publishable key 두 값이 있어야 서버와 이야기할 수 있다.
 *   이 값이 빠진 채로 앱이 만들어지면 앱은 그냥 만들어진다. 아무도 안 막는다.
 *   그리고 사용자가 앱을 열었을 때 "지금은 말씀을 찾지 못했어요" 라는
 *   서버 장애와 똑같이 생긴 메시지만 보게 된다. 원인을 알 길이 없다.
 *
 *   그래서 앱이 만들어지기 전에, 빌드가 시작되자마자 여기서 멈춘다.
 *   잘못된 앱이 손에 들어오는 것보다 빌드가 실패하는 편이 낫다.
 *
 * 언제 도는가:
 *   EAS Build가 package.json의 eas-build-pre-install 을 보고
 *   패키지를 내려받기 전에 이 파일을 실행한다.
 *   손으로 확인하려면 npm run check:public-env 이다.
 *
 *   npm start / npm test 에는 붙이지 않는다.
 *   로컬 Expo 개발은 지금처럼 Expo가 .env.local을 읽는 흐름 그대로 둔다.
 *
 * 무엇을 읽는가:
 *   process.env 뿐이다. 파일을 읽지 않는다.
 *   EAS Build가 넣어 주는 환경변수를 그대로 본다.
 *
 * 값을 절대 출력하지 않는다:
 *   빌드 기록은 나중에 다시 볼 수 있고 남에게 보일 수도 있다.
 *   그래서 틀렸다는 사실과 "어느 이름"이 틀렸는지만 말한다.
 *   값도, 값의 일부도, 가린 값도, 길이도 남기지 않는다.
 *
 * 바깥 꾸러미를 쓰지 않는다. Node에 원래 있는 기능만 쓴다.
 * 이 파일은 패키지를 내려받기 전에 돌기 때문에, 그때는 아무 꾸러미도 없다.
 */

const PREFIX = '[Aroeda build config]';

/**
 * 앱이 빌드될 때 반드시 있어야 하는 값은 이 둘뿐이다.
 *
 * 서버 전용 비밀값(OPENAI_API_KEY, service_role key, Supabase secret key)은
 * 여기 넣지 않는다. 그 값들은 앱 빌드에 필요하지 않고,
 * 앱 안에 들어가서도 안 된다.
 */
const REQUIRED = ['EXPO_PUBLIC_SUPABASE_URL', 'EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY'];

/**
 * 예시 파일에서 그대로 복사해 온 티가 나는 값들.
 *
 * .env.example 에 적어 둔 안내용 값이 실제 빌드까지 흘러가는 일이 흔하다.
 * 그런 값은 형식만 맞고 내용은 가짜라서, 앱은 만들어지지만 서버에 닿지 못한다.
 *
 * 진짜 Supabase 주소와 key는 무작위 영문·숫자다.
 * 아래 조각들이 우연히 들어갈 일은 사실상 없다.
 */
const PLACEHOLDER_PARTS = [
  '프로젝트주소',
  'your-project',
  'your_',
  'yourproject',
  'example',
  'placeholder',
  'changeme',
  'change-me',
  '...',
  '<',
  '>',
];

/** 서버에서만 써야 하는 key가 앱 자리에 들어온 경우. */
const SERVER_SECRET_PREFIXES = ['sb_secret_', 'sb_service_role_', 'service_role'];

/** 지금 이 프로젝트가 쓰는 공개 key 형식. */
const PUBLISHABLE_PREFIX = 'sb_publishable_';

/**
 * 값이 아예 없는 것과 같은 경우인지 본다.
 *
 * 빈 칸만 있는 값, 그리고 설정 도구가 빈 값을 'null' / 'undefined' 라는
 * 글자로 넣어 버린 경우까지 없는 것으로 친다.
 */
function isMissing(raw) {
  if (raw === undefined || raw === null) return true;
  const value = String(raw).trim();
  if (value === '') return true;
  const lowered = value.toLowerCase();
  return lowered === 'null' || lowered === 'undefined';
}

function looksLikePlaceholder(value) {
  const lowered = value.toLowerCase();
  return PLACEHOLDER_PARTS.some((part) => lowered.includes(part.toLowerCase()));
}

/**
 * Supabase 주소가 쓸 수 있는 형태인지 본다.
 *
 * 여기서 일부러 느슨하게 둔 부분이 있다.
 * 호스트 이름을 .supabase.co 로 못박지 않는다.
 * Supabase는 나중에 회사 도메인을 연결할 수 있고,
 * 그때 이 검사가 정상 설정을 막아서는 안 된다.
 *
 * 대신 실제로 앱을 망가뜨리는 것만 정확히 막는다.
 *   http 로 보내면 앱이 연결하지 못한다.
 *   주소 안에 아이디·비밀번호가 들어 있으면 잘못 붙여넣은 것이다.
 *   주소 뒤에 경로나 물음표가 붙으면 Supabase 클라이언트가 엉뚱한 곳을 부른다.
 *
 * 반환값은 틀린 이유 하나 또는 null 이다. 값 자체는 담지 않는다.
 */
function checkUrl(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return '주소 형식이 아닙니다';
  }

  if (parsed.protocol !== 'https:') return 'https 로 시작해야 합니다';
  if (!parsed.hostname) return '호스트 이름이 없습니다';
  if (parsed.username || parsed.password) return '주소에 아이디·비밀번호가 들어 있습니다';
  if (!parsed.hostname.includes('.')) return '호스트 이름이 온전하지 않습니다';
  if (parsed.pathname !== '/' && parsed.pathname !== '') return '주소 뒤에 경로가 붙어 있습니다';
  if (parsed.search || parsed.hash) return '주소 뒤에 물음표나 # 가 붙어 있습니다';

  return null;
}

/**
 * 앱에 넣는 key가 공개용 key가 맞는지 본다.
 *
 * 가장 위험한 실수는 서버 전용 key를 여기 넣는 것이다.
 * 그 key는 앱 번들 안에 그대로 들어가고, 앱을 뜯으면 누구나 꺼낼 수 있다.
 * 그러면 그 사람은 우리 데이터베이스 전체를 마음대로 할 수 있게 된다.
 * 그래서 조금이라도 서버 key처럼 보이면 빌드를 세운다.
 *
 * 옛 형식(eyJ 로 시작하는 JWT)도 받지 않는다.
 * 옛 형식에서는 공개용 key와 서버용 key가 생긴 게 똑같아서
 * 둘을 구분할 방법이 없다. 구분할 수 없으면 통과시키지 않는다.
 * 이 프로젝트는 이미 새 형식(sb_publishable_)을 쓰고 있으므로 문제되지 않는다.
 */
function checkPublishableKey(value) {
  const lowered = value.toLowerCase();

  if (SERVER_SECRET_PREFIXES.some((prefix) => lowered.startsWith(prefix))) {
    return '서버 전용 key가 들어 있습니다. 앱에는 publishable key만 넣습니다';
  }
  if (lowered.startsWith('eyj')) {
    return '옛 형식 key입니다. 새 publishable key를 넣어 주세요';
  }
  if (!value.startsWith(PUBLISHABLE_PREFIX)) {
    return `${PUBLISHABLE_PREFIX} 로 시작해야 합니다`;
  }
  if (value.length <= PUBLISHABLE_PREFIX.length) {
    return '앞부분만 있고 내용이 없습니다';
  }

  return null;
}

/**
 * 두 값을 모두 살펴보고 잘못된 것들의 "이름"만 모은다.
 *
 * 하나가 틀렸다고 거기서 멈추지 않는다.
 * 빌드를 여러 번 돌리게 하지 않으려면 한 번에 다 알려 주는 편이 낫다.
 */
function collectProblems(env) {
  const problems = [];

  for (const name of REQUIRED) {
    const raw = env[name];

    if (isMissing(raw)) {
      problems.push({ name, kind: 'missing' });
      continue;
    }

    const value = String(raw).trim();

    // 예시 값 검사는 반드시 주소를 해석하기 전에 한다.
    // new URL() 은 한글 호스트를 xn-- 로 바꿔 버려서,
    // 해석한 뒤에 보면 '프로젝트주소' 같은 글자가 사라져 있다.
    if (looksLikePlaceholder(value)) {
      problems.push({ name, kind: 'placeholder', reason: '예시 값이 그대로 들어 있습니다' });
      continue;
    }

    const reason =
      name === 'EXPO_PUBLIC_SUPABASE_URL' ? checkUrl(value) : checkPublishableKey(value);

    if (reason) problems.push({ name, kind: 'invalid', reason });
  }

  return problems;
}

function main() {
  const problems = collectProblems(process.env);

  if (problems.length === 0) {
    console.log(`${PREFIX} Required public environment variables are configured.`);
    process.exit(0);
  }

  // 아래 어디에서도 값을 쓰지 않는다. 이름과 이유만 쓴다.
  for (const problem of problems) {
    if (problem.kind === 'missing') {
      console.error(`${PREFIX} Missing required variable: ${problem.name}`);
    } else {
      console.error(`${PREFIX} Invalid or placeholder value: ${problem.name} — ${problem.reason}`);
    }
  }

  console.error('');
  console.error(`${PREFIX} 앱을 만들려면 아래 두 값이 필요합니다.`);
  for (const name of REQUIRED) console.error(`  ${name}`);
  console.error(`${PREFIX} EAS 프로젝트의 환경변수 설정에서 값을 확인해 주세요.`);

  process.exit(1);
}

main();
