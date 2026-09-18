/**
 * 자동 Scripture Catalog — 분석 실행기 로컬 파일 저장소 (v1)
 *
 * 무엇을 위한 것인가
 *   `automatic-scripture-catalog-analysis-snapshot-runner.ts`의 `loadCheckpoint`/
 *   `saveCheckpoint`, 그리고 최종 `FrozenAnalysisSnapshot`을 실제로 로컬 디스크에
 *   원자적으로 읽고 쓰는 경계다. 이 파일은 어떤 값을 저장할지(체크포인트 계약,
 *   스냅샷 계약)는 전혀 모른다 — `unknown` JSON 값 하나를 안전하게 읽고 쓰는
 *   범용 저장소일 뿐이다. 체크포인트인지 최종 스냅샷인지는 호출자(CLI)가 정한다.
 *
 * 읽기 계약
 *   - 파일이 없으면 `null`을 돌려준다(체크포인트가 아직 없다는 정상 상태).
 *   - 유효한 JSON이면 파싱한 `unknown`을 돌려준다 — 계약 검증은 이 파일의 일이
 *     아니다(runner의 순수 validator가 한다).
 *   - JSON이 손상됐거나, 대상이 디렉터리거나, symlink거나, 크기 상한을 넘거나,
 *     그 밖의 읽기 오류가 나면 `FileStoreError`를 던진다. 그 오류의 `message`는
 *     항상 고정된 일반 문구다 — 실제 경로나 OS 원본 오류 문구를 담지 않는다.
 *   - 대상이 symlink면 무조건 거절한다(`open`에 `O_NOFOLLOW`를 써서, symlink를
 *     따라가기 전에 OS 수준에서 막는다 — TOCTOU 경쟁 없이 안전하다).
 *
 * 원자적 쓰기 계약(체크포인트·최종 스냅샷 공통)
 *   1. 값을 저장 형식(`stablePrettyJson`)으로 직렬화한다 — BigInt·순환 참조처럼
 *      직렬화할 수 없는 값이나 top-level `undefined`처럼 문자열이 아닌 결과가
 *      나오면, 원본 값이나 원본 예외 문구를 밖으로 내지 않고 `FileStoreError
 *      ('write_failed')`로 수렴한다. 이 단계에서 실패하면 아직 어떤 파일도
 *      만들지 않는다.
 *   2. 대상과 같은 디렉터리에 임시 파일을 만든다(`O_EXCL`로 이름 충돌 시 실패).
 *   3. 임시 파일 권한은 `0600`.
 *   4. 전체 JSON을 한 번에 기록한다(부분 기록 없음).
 *   5. 파일을 `fsync`한다.
 *   6. 같은 디렉터리 안에서 `rename`한다 — POSIX에서 같은 파일시스템 안의
 *      rename은 원자적이며, 대상이 이미 있어도 통째로 교체된다(부분 덮어쓰기가
 *      아니다). rename은 대상이 symlink여도 그 symlink 자체를 교체할 뿐 따라가지
 *      않으므로, 쓰기 경로는 symlink를 통해 다른 곳에 쓰지 않는다.
 *   7. 가능하면 디렉터리도 `fsync`한다(best-effort — 실패해도 무시한다).
 *   8. 위 어느 단계에서 실패하든 임시 파일을 best-effort로 지운다.
 *   9. 대상 디렉터리는 명시적으로 이미 있어야 한다 — 임의로 만들지 않는다.
 *
 * 쓰기 전 미리보기(preflight) — `preflightJsonFileTarget`
 *   실제로 쓰기 전에 "이 경로에 나중에 쓸 수 있는가"만 확인한다: 부모 디렉터리가
 *   실제 디렉터리인지, 대상 자체가 디렉터리는 아닌지, 같은 디렉터리에 0600
 *   probe 파일을 `O_EXCL|O_NOFOLLOW`로 만들 수 있는지(만들면 sync·close 후
 *   곧바로 best-effort로 지운다). 기존 대상 파일은 건드리지 않는다. 유료
 *   analyze 호출을 시작하기 전에 호출자가 checkpoint·snapshot 경로를 먼저
 *   확인해 둘 수 있게 하기 위한 것이다.
 *
 * 이 파일이 하지 않는 일
 *   체크포인트·스냅샷 계약을 검증하지 않는다. 어떤 경로를 쓸지 정하지 않는다
 *   (호출자 인자로만 받는다). 네트워크·OpenAI·DB를 부르지 않는다.
 */

import { randomBytes } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { open, rename, stat, unlink, type FileHandle } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

/** 읽기 대상 JSON 파일의 크기 상한(바이트). 손상되거나 악의적으로 부풀려진 파일을 통째로 메모리에 올리지 않기 위한 안전망이다. */
export const DEFAULT_MAX_JSON_FILE_BYTES = 20 * 1024 * 1024;

export type FileStoreErrorCode =
  | 'symlink_rejected'
  | 'not_regular_file'
  | 'too_large'
  | 'invalid_json'
  | 'read_failed'
  | 'parent_directory_missing'
  | 'write_failed';

/**
 * 이 모듈이 던지는 유일한 오류 타입. `message`는 항상 `code`에서만 나오는 고정 문구다 —
 * 실제 파일 경로나 OS가 준 원본 오류 문구(`error.message`, `errno` 상세)를 담지 않는다.
 */
export class FileStoreError extends Error {
  readonly code: FileStoreErrorCode;
  constructor(code: FileStoreErrorCode) {
    super(`file_store_error:${code}`);
    this.name = 'FileStoreError';
    this.code = code;
  }
}

function isErrnoException(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error && 'code' in value;
}

async function closeQuietly(handle: FileHandle): Promise<void> {
  try {
    await handle.close();
  } catch {
    // 닫기 실패는 무시한다 — 이미 오류 처리 중이거나 정상 종료 경로다.
  }
}

export type ReadJsonFileOptions = {
  /** 테스트에서 큰 파일을 만들지 않고 상한 초과 경로를 재현하기 위한 오버라이드. 생략하면 DEFAULT_MAX_JSON_FILE_BYTES. */
  maxBytes?: number;
};

/**
 * 파일이 없으면 `null`. 있으면 파싱한 `unknown`. 그 밖의 모든 경우(symlink·디렉터리·
 * 손상된 JSON·크기 초과·기타 읽기 오류)는 `FileStoreError`를 던진다 — 예외를 삼키지
 * 않는다. 오류 원문(OS 메시지·경로)은 절대 담지 않는다.
 */
export async function readJsonFile(path: string, options: ReadJsonFileOptions = {}): Promise<unknown> {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_JSON_FILE_BYTES;

  let handle: FileHandle;
  try {
    // O_NOFOLLOW: 마지막 경로 구성요소가 symlink면 따라가지 않고 즉시 ELOOP로 실패한다 —
    // "먼저 확인하고 나중에 연다" 방식의 경쟁 조건이 없다.
    handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  } catch (error) {
    if (isErrnoException(error) && error.code === 'ENOENT') return null;
    if (isErrnoException(error) && error.code === 'ELOOP') throw new FileStoreError('symlink_rejected');
    throw new FileStoreError('read_failed');
  }

  try {
    const info = await handle.stat();
    // 디렉터리는 O_RDONLY로 열리는 플랫폼도 있으므로, 읽기 전에 반드시 일반 파일인지 확인한다.
    if (!info.isFile()) throw new FileStoreError('not_regular_file');
    if (info.size > maxBytes) throw new FileStoreError('too_large');

    const buffer = await handle.readFile();
    // stat과 readFile 사이에 파일이 커졌을 수 있다(TOCTOU) — 실제로 읽은 바이트 수도 다시 확인한다.
    if (buffer.length > maxBytes) throw new FileStoreError('too_large');
    try {
      return JSON.parse(buffer.toString('utf8'));
    } catch {
      throw new FileStoreError('invalid_json');
    }
  } catch (error) {
    if (error instanceof FileStoreError) throw error;
    throw new FileStoreError('read_failed');
  } finally {
    await closeQuietly(handle);
  }
}

/**
 * 사람이 다시 읽을 수 있는 결정적 JSON 형식. 객체 key는 재귀적으로 정렬하고(배열 순서는
 * 뜻이 있으므로 그대로 둔다) 2칸 들여쓰기로 낸다. 같은 값이면 언제 호출해도 글자 그대로
 * 같은 문자열이 나온다 — diff나 재실행 결과 비교에 안정적이다. 지문 계산에 쓰는
 * `canonicalJson`(공백 없는 압축 형식)과는 다른, 저장 전용 표시 형식이다.
 */
export function stablePrettyJson(value: unknown): string {
  const sortKeysReplacer = (_key: string, val: unknown): unknown => {
    if (val !== null && typeof val === 'object' && !Array.isArray(val)) {
      const sorted: Record<string, unknown> = {};
      for (const key of Object.keys(val as Record<string, unknown>).sort()) {
        sorted[key] = (val as Record<string, unknown>)[key];
      }
      return sorted;
    }
    return val;
  };
  return JSON.stringify(value, sortKeysReplacer, 2);
}

function makeTempPath(targetPath: string): string {
  const dir = dirname(targetPath);
  const suffix = randomBytes(8).toString('hex');
  return join(dir, `.${basename(targetPath)}.${suffix}.tmp`);
}

/**
 * `value`를 `path`에 원자적으로 저장한다. 대상 디렉터리는 이미 있어야 한다(자동으로
 * 만들지 않는다). 실패하면 `FileStoreError`를 던지고, 그 시점까지 대상 경로에 있던
 * 파일(있었다면)은 그대로 남는다 — rename 전에는 대상 경로를 전혀 건드리지 않기
 * 때문이다. 실패 시 만들어졌던 임시 파일은 best-effort로 지운다.
 */
export async function writeJsonFileAtomic(path: string, value: unknown): Promise<void> {
  const dir = dirname(path);

  let dirInfo;
  try {
    dirInfo = await stat(dir);
  } catch {
    throw new FileStoreError('parent_directory_missing');
  }
  if (!dirInfo.isDirectory()) throw new FileStoreError('parent_directory_missing');

  // stablePrettyJson(JSON.stringify)은 BigInt·순환 참조에 원본 예외(TypeError)를 던지고,
  // top-level undefined·함수·symbol에는 예외 없이 `undefined`(문자열이 아님)를 돌려준다 —
  // 두 경우 모두 이 공개 경계에서 원래 값이나 원본 오류 문구를 밖으로 내보내지 않고
  // `FileStoreError('write_failed')`로 수렴시킨다. 아직 어떤 파일도 만들지 않았으므로
  // 정리할 임시 파일도 없다.
  let content: string;
  try {
    const serialized = stablePrettyJson(value);
    if (typeof serialized !== 'string') throw new Error('serialized value is not a string');
    content = serialized;
  } catch {
    throw new FileStoreError('write_failed');
  }

  const tempPath = makeTempPath(path);

  let handle: FileHandle;
  try {
    // O_EXCL: 이름이 우연히 충돌해도 기존 파일을 덮어쓰지 않고 실패한다.
    // O_NOFOLLOW: 방어적으로 symlink를 따라가지 않는다(임시 이름은 난수라 실제로 거의 의미
    // 없지만, 공짜로 넣을 수 있는 안전장치다).
    handle = await open(
      tempPath,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
      0o600,
    );
  } catch {
    throw new FileStoreError('write_failed');
  }

  try {
    await handle.writeFile(content, 'utf8');
    await handle.sync();
  } catch {
    await closeQuietly(handle);
    await unlink(tempPath).catch(() => {});
    throw new FileStoreError('write_failed');
  }
  await closeQuietly(handle);

  try {
    // rename은 대상이 있어도 원자적으로 통째로 교체한다(부분 덮어쓰기가 아니다). 대상이
    // symlink여도 그 symlink 자체를 교체할 뿐 따라가지 않으므로, 다른 곳에 쓰지 않는다.
    await rename(tempPath, path);
  } catch {
    await unlink(tempPath).catch(() => {});
    throw new FileStoreError('write_failed');
  }

  try {
    // 디렉터리 fsync는 일부 파일시스템에서만 뜻이 있다 — best-effort이며 실패해도 무시한다.
    const dirHandle = await open(dir, 'r');
    await dirHandle.sync().catch(() => {});
    await closeQuietly(dirHandle);
  } catch {
    // 디렉터리를 다시 열 수 없어도 무시한다 — rename은 이미 끝났다.
  }
}

/**
 * 대상 파일에는 아무 것도 쓰지 않고, 같은 디렉터리에 빈 probe 파일을 잠깐 생성·삭제해
 * 이 경로에 나중에 `writeJsonFileAtomic`이 성공할 수 있는지만 미리 확인한다(preflight). 호출자(CLI)가 이 함수로 checkpoint·snapshot 경로를 먼저 확인해
 * 두면, "유료 analyze 호출 뒤에야 저장이 실패한다"는 상황을 analyze를 부르기 전에 막을 수
 * 있다.
 *
 * 확인 내용
 *   - 부모 디렉터리가 실제로 존재하는 디렉터리인지
 *   - 대상 경로 자체가 이미 디렉터리면 거절
 *   - 같은 디렉터리에 난수 이름의 0600 probe 파일을 `O_EXCL | O_NOFOLLOW`로 만들 수 있는지
 *     (디렉터리 쓰기 권한을 실제로 시험한다) — 만든 뒤 sync·close하고 곧바로 best-effort로
 *     지운다. 기존 대상 파일은 이 함수가 열거나 바꾸지 않는다 — 전혀 건드리지 않는다.
 *
 * 실패하면 `FileStoreError`를 던진다(경로·OS 원문 없음). 성공하면 아무 것도 돌려주지
 * 않는다 — 이 확인과 실제 `writeJsonFileAtomic` 호출 사이에 디렉터리 상태가 바뀌면(다른
 * 프로세스가 지우는 등) 실제 저장이 그때 다시 실패할 수 있다는 뜻이다(TOCTOU는 근본적으로
 * 없앨 수 없다) — 그래도 흔한 실수(오타난 경로, 없는 디렉터리, 읽기 전용 디렉터리)는
 * 비용을 쓰기 전에 잡아낸다.
 */
export async function preflightJsonFileTarget(path: string): Promise<void> {
  const dir = dirname(path);

  let dirInfo;
  try {
    dirInfo = await stat(dir);
  } catch {
    throw new FileStoreError('parent_directory_missing');
  }
  if (!dirInfo.isDirectory()) throw new FileStoreError('parent_directory_missing');

  let targetInfo;
  try {
    targetInfo = await stat(path);
  } catch {
    targetInfo = null; // 없어도 된다 — 첫 저장일 수 있다.
  }
  if (targetInfo !== null && targetInfo.isDirectory()) throw new FileStoreError('not_regular_file');

  const probePath = makeTempPath(path);
  let handle: FileHandle;
  try {
    handle = await open(
      probePath,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
      0o600,
    );
  } catch {
    throw new FileStoreError('write_failed');
  }

  try {
    await handle.sync();
  } catch {
    await closeQuietly(handle);
    await unlink(probePath).catch(() => {});
    throw new FileStoreError('write_failed');
  }
  await closeQuietly(handle);
  await unlink(probePath).catch(() => {});
}
