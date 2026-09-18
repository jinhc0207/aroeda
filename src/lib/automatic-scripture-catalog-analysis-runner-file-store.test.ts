/**
 * 자동 Scripture Catalog — 분석 실행기 로컬 파일 저장소 테스트
 *
 * 실행: npm run test:logic
 *
 * 무엇을 증명하는가
 *   읽기는 "파일 없음→null / 정상 JSON→파싱값 / 그 밖의 모든 비정상(symlink·디렉터리·
 *   손상 JSON·크기 초과·기타 읽기 오류)→FileStoreError"만 돌려준다는 것. 쓰기는
 *   임시 파일(0600)에 전체를 쓰고 sync한 뒤 rename으로만 대상을 바꾸며, 실패하면
 *   대상 파일을 건드리지 않고 임시 파일을 best-effort로 지운다는 것. 저장 형식은
 *   key 순서에 흔들리지 않는 결정적 pretty JSON이라는 것.
 *
 * 무엇을 증명하지 않는가
 *   체크포인트·스냅샷 계약 검증(이 파일은 unknown JSON만 다룬다). 실제 OpenAI·DB 호출
 *   (이 파일에 없다).
 *
 * 파일 시스템 테스트는 각자 고유한 임시 디렉터리를 만들고 끝나면 지운다.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import {
  FileStoreError,
  preflightJsonFileTarget,
  readJsonFile,
  stablePrettyJson,
  writeJsonFileAtomic,
} from '../../scripts/automatic-scripture-catalog-analysis-runner-file-store.ts';

async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'aroeda-analysis-file-store-'));
  try {
    await run(dir);
  } finally {
    // 테스트 중 디렉터리 권한을 잠갔을 수 있으니, 지우기 전에 항상 되돌린다.
    await chmod(dir, 0o700).catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }
}

const isRoot = (): boolean => typeof process.getuid === 'function' && process.getuid() === 0;

async function assertFileStoreErrorCode(promise: Promise<unknown>, code: string): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof FileStoreError, '오류는 FileStoreError여야 합니다.');
    assert.equal(error.code, code);
    return true;
  });
}

describe('automatic-scripture-catalog-analysis-runner-file-store · 읽기', () => {
  it('1) 파일이 없으면 null을 돌려준다', async () => {
    await withTempDir(async (dir) => {
      const result = await readJsonFile(join(dir, 'no-such-file.json'));
      assert.equal(result, null);
    });
  });

  it('2) 정상 JSON을 파싱한 값으로 돌려준다', async () => {
    await withTempDir(async (dir) => {
      const path = join(dir, 'checkpoint.json');
      const value = { a: 1, b: ['x', 'y'], c: { nested: true } };
      await writeJsonFileAtomic(path, value);
      const result = await readJsonFile(path);
      assert.deepEqual(result, value);
    });
  });

  it('3) 손상된 JSON은 거절한다(FileStoreError: invalid_json)', async () => {
    await withTempDir(async (dir) => {
      const path = join(dir, 'broken.json');
      await writeFile(path, '{ this is not valid json', 'utf8');
      await assertFileStoreErrorCode(readJsonFile(path), 'invalid_json');
    });
  });

  it('4) 크기 상한을 넘으면 거절한다(FileStoreError: too_large)', async () => {
    await withTempDir(async (dir) => {
      const path = join(dir, 'big.json');
      await writeFile(path, JSON.stringify({ value: 'x'.repeat(1000) }), 'utf8');
      await assertFileStoreErrorCode(readJsonFile(path, { maxBytes: 10 }), 'too_large');
    });
  });

  it('5) symlink는 거절한다(FileStoreError: symlink_rejected)', async () => {
    await withTempDir(async (dir) => {
      const realPath = join(dir, 'real.json');
      await writeJsonFileAtomic(realPath, { ok: true });
      const linkPath = join(dir, 'link.json');
      await symlink(realPath, linkPath);
      await assertFileStoreErrorCode(readJsonFile(linkPath), 'symlink_rejected');
    });
  });

  it('6) 디렉터리는 거절한다(FileStoreError: not_regular_file)', async () => {
    await withTempDir(async (dir) => {
      const subDir = join(dir, 'a-directory.json');
      await mkdir(subDir);
      await assertFileStoreErrorCode(readJsonFile(subDir), 'not_regular_file');
    });
  });

  it('6-1) stat과 read 사이에 파일이 커지는 경쟁 상황도 방어한다(읽은 뒤 다시 크기를 확인 — 소스로 직접 확인)', () => {
    // stat() 시점의 크기만 믿으면, 그 직후 다른 프로세스가 파일을 키워도 통과해 버릴 수
    // 있다(TOCTOU). 이 경쟁은 단일 프로세스 단위 테스트로 결정적으로 재현할 수 없으므로,
    // 이 프로젝트의 기존 관례(예: final_snapshot_invalid 소스 패턴 테스트)를 따라 실제
    // 방어 코드가 있는지 소스에서 직접 확인한다.
    const source = readFileSync(
      new URL('../../scripts/automatic-scripture-catalog-analysis-runner-file-store.ts', import.meta.url),
      'utf8',
    );
    assert.ok(source.includes("if (buffer.length > maxBytes) throw new FileStoreError('too_large');"));
  });
});

describe('automatic-scripture-catalog-analysis-runner-file-store · 원자적 쓰기', () => {
  it('7) 저장된 파일의 권한은 0600이다', async () => {
    await withTempDir(async (dir) => {
      const path = join(dir, 'checkpoint.json');
      await writeJsonFileAtomic(path, { ok: true });
      const info = await stat(path);
      assert.equal(info.mode & 0o777, 0o600);
    });
  });

  it('8) 저장이 끝나면 임시 파일이 디렉터리에 남지 않는다(임시 파일→rename 순서)', async () => {
    await withTempDir(async (dir) => {
      const path = join(dir, 'checkpoint.json');
      await writeJsonFileAtomic(path, { ok: true });
      const entries = await readdir(dir);
      assert.deepEqual(entries, ['checkpoint.json']);
    });
  });

  it('9) 대상 디렉터리가 없으면 자동으로 만들지 않고 거절한다(FileStoreError: parent_directory_missing)', async () => {
    await withTempDir(async (dir) => {
      const path = join(dir, 'no-such-subdir', 'checkpoint.json');
      await assertFileStoreErrorCode(writeJsonFileAtomic(path, { ok: true }), 'parent_directory_missing');
      const entries = await readdir(dir);
      assert.deepEqual(entries, [], '상위 디렉터리를 임의로 만들면 안 됩니다.');
    });
  });

  it('10) 쓰기 실패 시 기존 정상 파일을 그대로 둔다(디렉터리 쓰기 권한 없음)', async (t) => {
    if (isRoot()) {
      t.skip('root로 실행 중에는 디렉터리 권한이 무시되어 이 시나리오를 재현할 수 없습니다.');
      return;
    }
    await withTempDir(async (dir) => {
      const path = join(dir, 'checkpoint.json');
      const original = { version: 1, results: ['EVAL-001'] };
      await writeJsonFileAtomic(path, original);

      await chmod(dir, 0o500);
      try {
        await assertFileStoreErrorCode(writeJsonFileAtomic(path, { version: 2, results: [] }), 'write_failed');
      } finally {
        await chmod(dir, 0o700);
      }

      const stillOriginal = await readJsonFile(path);
      assert.deepEqual(stillOriginal, original, '실패한 쓰기가 기존 정상 파일을 건드리면 안 됩니다.');
    });
  });

  it('11) rename이 실패하면(대상이 디렉터리) 임시 파일을 best-effort로 지운다', async () => {
    await withTempDir(async (dir) => {
      const path = join(dir, 'target-is-a-directory.json');
      await mkdir(path);

      await assertFileStoreErrorCode(writeJsonFileAtomic(path, { ok: true }), 'write_failed');

      const entries = await readdir(dir);
      assert.deepEqual(entries, ['target-is-a-directory.json'], '실패 후 임시 파일이 남아 있으면 안 됩니다.');
    });
  });

  it('12) 같은 값을 다른 key 순서로 여러 번 저장해도 파일 내용은 글자 그대로 같다', async () => {
    await withTempDir(async (dir) => {
      const path = join(dir, 'checkpoint.json');
      await writeJsonFileAtomic(path, { b: 2, a: 1, c: { z: 1, y: 2 } });
      const first = await readFile(path, 'utf8');
      await writeJsonFileAtomic(path, { a: 1, c: { y: 2, z: 1 }, b: 2 });
      const second = await readFile(path, 'utf8');
      assert.equal(first, second);
    });
  });
});

describe('automatic-scripture-catalog-analysis-runner-file-store · 직렬화 오류 정규화', () => {
  it('[재현] BigInt는 원본 TypeError 없이 FileStoreError(write_failed)로 수렴한다', async () => {
    await withTempDir(async (dir) => {
      const path = join(dir, 'checkpoint.json');
      await assert.rejects(writeJsonFileAtomic(path, { bad: 1n }), (error: unknown) => {
        assert.ok(error instanceof FileStoreError);
        assert.equal(error.code, 'write_failed');
        assert.equal(error.message.includes('BigInt'), false, '원본 TypeError 문구가 섞이면 안 됩니다.');
        assert.equal((error as Error).constructor.name, 'FileStoreError', '원본 TypeError가 그대로 새면 안 됩니다.');
        return true;
      });
    });
  });

  it('순환 참조는 FileStoreError(write_failed)로 수렴한다', async () => {
    await withTempDir(async (dir) => {
      const path = join(dir, 'checkpoint.json');
      const circular: Record<string, unknown> = { a: 1 };
      circular.self = circular;
      await assertFileStoreErrorCode(writeJsonFileAtomic(path, circular), 'write_failed');
    });
  });

  it('top-level undefined는(문자열이 아닌 결과) FileStoreError(write_failed)로 수렴한다', async () => {
    await withTempDir(async (dir) => {
      const path = join(dir, 'checkpoint.json');
      await assertFileStoreErrorCode(writeJsonFileAtomic(path, undefined), 'write_failed');
    });
  });

  it('직렬화가 실패하면 임시 파일을 전혀 만들지 않는다', async () => {
    await withTempDir(async (dir) => {
      const path = join(dir, 'checkpoint.json');
      await assertFileStoreErrorCode(writeJsonFileAtomic(path, { bad: 1n }), 'write_failed');
      const entries = await readdir(dir);
      assert.deepEqual(entries, []);
    });
  });

  it('직렬화 실패는 기존에 저장돼 있던 정상 파일을 건드리지 않는다', async () => {
    await withTempDir(async (dir) => {
      const path = join(dir, 'checkpoint.json');
      const original = { version: 1 };
      await writeJsonFileAtomic(path, original);
      await assertFileStoreErrorCode(writeJsonFileAtomic(path, { bad: 1n }), 'write_failed');
      const stillOriginal = await readJsonFile(path);
      assert.deepEqual(stillOriginal, original);
    });
  });
});

describe('automatic-scripture-catalog-analysis-runner-file-store · 쓰기 전 미리보기(preflight)', () => {
  it('부모 디렉터리·쓰기 권한이 정상이면 아무 것도 남기지 않고 성공한다', async () => {
    await withTempDir(async (dir) => {
      const path = join(dir, 'checkpoint.json');
      await preflightJsonFileTarget(path);
      const entries = await readdir(dir);
      assert.deepEqual(entries, [], 'probe 파일이 남아 있으면 안 됩니다.');
    });
  });

  it('[재현] 부모 디렉터리가 없으면 FileStoreError(parent_directory_missing)를 던진다(analyze를 부르기 전에 미리 잡아낸다)', async () => {
    await withTempDir(async (dir) => {
      const path = join(dir, 'no-such-subdir', 'checkpoint.json');
      await assertFileStoreErrorCode(preflightJsonFileTarget(path), 'parent_directory_missing');
    });
  });

  it('대상 경로 자체가 디렉터리면 거절한다(FileStoreError: not_regular_file)', async () => {
    await withTempDir(async (dir) => {
      const path = join(dir, 'a-directory.json');
      await mkdir(path);
      await assertFileStoreErrorCode(preflightJsonFileTarget(path), 'not_regular_file');
    });
  });

  it('디렉터리에 쓰기 권한이 없으면 거절한다(FileStoreError: write_failed)', async (t) => {
    if (isRoot()) {
      t.skip('root로 실행 중에는 디렉터리 권한이 무시되어 이 시나리오를 재현할 수 없습니다.');
      return;
    }
    await withTempDir(async (dir) => {
      const path = join(dir, 'checkpoint.json');
      await chmod(dir, 0o500);
      try {
        await assertFileStoreErrorCode(preflightJsonFileTarget(path), 'write_failed');
      } finally {
        await chmod(dir, 0o700);
      }
    });
  });

  it('기존 대상 파일이 있어도 그 내용을 건드리지 않는다', async () => {
    await withTempDir(async (dir) => {
      const path = join(dir, 'checkpoint.json');
      const original = { version: 1, results: ['EVAL-001'] };
      await writeJsonFileAtomic(path, original);
      await preflightJsonFileTarget(path);
      const stillOriginal = await readJsonFile(path);
      assert.deepEqual(stillOriginal, original);
      const entries = await readdir(dir);
      assert.deepEqual(entries, ['checkpoint.json'], 'probe 파일이 남아 있으면 안 됩니다.');
    });
  });
});

describe('automatic-scripture-catalog-analysis-runner-file-store · stablePrettyJson', () => {
  it('13) key를 알파벳 순으로 정렬하고 2칸 들여쓰기로 낸다', () => {
    const text = stablePrettyJson({ b: 1, a: 2 });
    assert.equal(text, '{\n  "a": 2,\n  "b": 1\n}');
  });

  it('14) 중첩 객체의 key도 재귀적으로 정렬한다', () => {
    const text = stablePrettyJson({ z: { two: 2, one: 1 }, a: 1 });
    assert.equal(text, '{\n  "a": 1,\n  "z": {\n    "one": 1,\n    "two": 2\n  }\n}');
  });

  it('15) 배열 순서는 그대로 유지한다(재정렬하지 않는다)', () => {
    const text = stablePrettyJson({ list: ['third', 'first', 'second'] });
    assert.equal(text, '{\n  "list": [\n    "third",\n    "first",\n    "second"\n  ]\n}');
  });

  it('16) key 순서가 다른 동등한 객체는 같은 문자열을 만든다', () => {
    const first = stablePrettyJson({ a: 1, b: { x: 1, y: 2 } });
    const second = stablePrettyJson({ b: { y: 2, x: 1 }, a: 1 });
    assert.equal(first, second);
  });
});
