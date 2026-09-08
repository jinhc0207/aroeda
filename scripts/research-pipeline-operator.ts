/**
 * Research Pipeline Local Operator (CLI)
 *
 * aroeda production research pipeline을 한 단계씩만 실행하는 실행기.
 * 실제 로직은 src/lib/research-pipeline-operator.ts에 있다. 여기서는
 * 실제 network(fetch)와 실제 macOS Keychain 조회만 이어 붙인다.
 *
 * 사용:
 *   npm run research:operator -- prioritize
 *   npm run research:operator -- prioritize --execute
 *   npm run research:operator -- harvest --decision-id <id> --target-domain <domain> \
 *     --evidence-version <n> --snapshot-id <snap_...>
 *   npm run research:operator -- research <handoffId>
 *   npm run research:operator -- candidate <researchResultHash>
 *
 * --execute 없이 실행하면 network 0, credential 조회 0이다.
 *
 * stdout에는 안전한 상태값과 식별자만 낸다. 토큰, Authorization 헤더, 원본 응답,
 * 연구 결과 본문은 절대 내지 않는다.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import {
  parseArgs,
  runStage,
  type CredentialSpec,
  type Transport,
  type SecretReader,
} from '../src/lib/research-pipeline-operator.ts';

const execFileAsync = promisify(execFile);

/**
 * macOS Keychain에서 secret을 읽는다.
 * argument array만 쓴다(shell 보간 없음). 값은 절대 로그하지 않는다.
 * 실패 이유(없음/거부/기타)는 구분하지 않고 전부 null로 취급한다.
 */
const readFromKeychain: SecretReader = async (spec: CredentialSpec): Promise<string | null> => {
  try {
    const { stdout } = await execFileAsync('security', [
      'find-generic-password',
      '-s',
      spec.service,
      '-a',
      spec.account,
      '-w',
    ]);
    const value = stdout.trim();
    return value.length > 0 ? value : null;
  } catch {
    return null;
  }
};

/** 실제 HTTP 전송. 정확히 한 번만 부른다(retry 없음). redirect는 따라가지 않는다. */
const httpTransport: Transport = async (request) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), request.timeoutMs);
  try {
    const response = await fetch(request.url, {
      method: request.method,
      headers: request.headers,
      body: request.body,
      redirect: 'manual',
      signal: controller.signal,
    });
    let json: unknown = null;
    try {
      json = await response.json();
    } catch {
      json = null;
    }
    return { status: response.status, json };
  } finally {
    clearTimeout(timer);
  }
};

function printUsage(): void {
  console.log(
    [
      'usage:',
      '  research:operator -- refresh',
      '  research:operator -- prioritize [--execute]',
      '  research:operator -- harvest --decision-id <id> --target-domain <domain> --evidence-version <n> --snapshot-id <snap_...> [--execute]',
      '  research:operator -- research <handoffId> [--execute]',
      '  research:operator -- candidate <researchResultHash> [--execute]',
      '',
      '한 번의 실행은 정확히 한 단계만 수행한다. --execute 없이는 network를 만들지 않는다.',
    ].join('\n'),
  );
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const parsed = parseArgs(argv);

  if (!parsed.ok) {
    printUsage();
    console.log(JSON.stringify({ ok: false, error: parsed.error }));
    return 1;
  }

  const outcome = await runStage(parsed, { transport: httpTransport, secretReader: readFromKeychain });
  console.log(JSON.stringify(outcome));
  return outcome.ok ? 0 : 1;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch(() => {
    // 예상 못한 실패도 원본 오류를 stdout/stderr에 그대로 내지 않는다.
    console.log(JSON.stringify({ ok: false, code: 'INTERNAL_ERROR' }));
    process.exitCode = 1;
  });
