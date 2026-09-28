/**
 * Supabase Edge Function 인증 설정 회귀 테스트
 *
 * 실제 Supabase를 호출하지 않는다. 저장소의 함수 목록과 config.toml을 대조하고,
 * JWT 검증을 끈 내부 함수가 공용 내부 토큰 검사를 반드시 쓰는지 확인한다.
 */

import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

const projectRoot = path.resolve(import.meta.dirname, '../..');
const functionsDir = path.join(projectRoot, 'supabase/functions');
const configPath = path.join(projectRoot, 'supabase/config.toml');

const EXPECTED_AUTH = {
  'analyze-situation': true,
  'biblical-researcher': false,
  'candidate-generator': false,
  'delete-my-data': true,
  'generate-prayer-guidance': true,
  'recommend-scripture': true,
  'research-prioritizer': false,
  'research-queue-refresh': false,
  'source-harvester': false,
} as const;

function functionDirectories(): string[] {
  return readdirSync(functionsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name !== '_shared')
    .map((entry) => entry.name)
    .sort();
}

function readFunctionAuthConfig(): Record<string, boolean> {
  const source = readFileSync(configPath, 'utf8');
  const entries = [...source.matchAll(
    /^\[functions\.([^\]]+)\]\s*\nverify_jwt\s*=\s*(true|false)\s*$/gm,
  )].map((match) => [match[1], match[2] === 'true'] as const);

  return Object.fromEntries(entries);
}

describe('Supabase Edge Function 인증 설정', () => {
  it('모든 함수의 verify_jwt 설정을 빠짐없이 명시한다', () => {
    assert.deepEqual(functionDirectories(), Object.keys(EXPECTED_AUTH).sort());
    assert.deepEqual(readFunctionAuthConfig(), EXPECTED_AUTH);
  });

  it('사용자 앱이 직접 호출하는 함수는 JWT 검증을 유지한다', () => {
    const configured = readFunctionAuthConfig();
    for (const name of [
      'analyze-situation',
      'delete-my-data',
      'generate-prayer-guidance',
      'recommend-scripture',
    ]) {
      assert.equal(configured[name], true, `${name}의 JWT 검증이 꺼져 있습니다.`);
    }
  });

  it('JWT 검증을 끈 함수는 모두 공용 내부 토큰 검사를 사용한다', () => {
    const configured = readFunctionAuthConfig();
    const internalFunctions = Object.entries(configured)
      .filter(([, verifyJwt]) => !verifyJwt)
      .map(([name]) => name)
      .sort();

    assert.deepEqual(internalFunctions, [
      'biblical-researcher',
      'candidate-generator',
      'research-prioritizer',
      'research-queue-refresh',
      'source-harvester',
    ]);

    for (const name of internalFunctions) {
      const index = readFileSync(path.join(functionsDir, name, 'index.ts'), 'utf8');
      assert.match(
        index,
        /import\s*\{\s*isAuthorizedInternalRequest\s*\}\s*from\s*['"]\.\.\/_shared\/internal-auth\.ts['"]/,
        `${name}이 공용 내부 토큰 검사를 import하지 않습니다.`,
      );
      assert.match(
        index,
        /isAuthorizedInternalRequest\s*\(/,
        `${name}이 공용 내부 토큰 검사를 호출하지 않습니다.`,
      );
    }
  });
});
