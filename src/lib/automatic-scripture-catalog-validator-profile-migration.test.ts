/**
 * 실제 validator profile 등록 migration 검증.
 *
 * SQL manifest를 직접 읽어 TypeScript 단일 원본과 profile 내용·지문을 대조한다.
 * migration이 profile 네 줄을 넣는 일 밖에 하지 않는지도 함께 확인한다.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import { computeValidatorProfileHash } from '../../supabase/functions/_shared/automatic-scripture-catalog-activation-contract.ts';
import type { ValidatorProfile } from '../../supabase/functions/_shared/automatic-scripture-catalog-activation-contract.ts';
import {
  AROEDA_VALIDATOR_REGISTRY,
  ASTRA_MODEL_ID,
  SOL_MODEL_ID,
  THEOLOGY_RUBRIC_VERSION,
  checkValidatorRegistryPolicy,
} from '../../supabase/functions/_shared/automatic-scripture-catalog-validator-registry.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../..');
const migrationRelativePath = 'supabase/migrations/20260916011019_register_automatic_scripture_catalog_validator_profiles.sql';
const migrationPath = path.join(repoRoot, migrationRelativePath);
const sql = readFileSync(migrationPath, 'utf8');

type ManifestEntry = { profileHash: string; profile: ValidatorProfile };

function readManifest(): ManifestEntry[] {
  const match = sql.match(/\$profiles\$\s*([\s\S]*?)\s*\$profiles\$::jsonb/);
  assert.ok(match, 'migration에 $profiles$ JSON manifest가 없습니다.');
  return JSON.parse(match[1]) as ManifestEntry[];
}

const plain = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

describe('자동 카탈로그 validator profile migration · manifest', () => {
  it('코드의 실제 registry 네 profile과 내용·순서가 정확히 같다', async () => {
    const expected = await Promise.all(
      AROEDA_VALIDATOR_REGISTRY.profiles.map(async (profile) => ({
        profileHash: await computeValidatorProfileHash(profile),
        profile: plain(profile),
      })),
    );
    assert.deepEqual(readManifest(), expected);
  });

  it('manifest의 각 profileHash는 profile에서 다시 계산한 값과 같다', async () => {
    for (const entry of readManifest()) {
      assert.equal(entry.profileHash, await computeValidatorProfileHash(entry.profile), entry.profile.profileId);
    }
  });

  it('등록할 registry는 fail-closed 정책 검사를 통과한다', () => {
    assert.deepEqual(checkValidatorRegistryPolicy().errors, []);
  });

  it('모델 평가자는 Sol과 Astra뿐이고 같은 rubric 버전을 쓴다', () => {
    const evaluators = readManifest().map((entry) => entry.profile).filter((profile) => profile.validatorKind === 'model_evaluator');
    assert.deepEqual(
      evaluators.map((profile) => profile.modelId).sort(),
      [ASTRA_MODEL_ID, SOL_MODEL_ID].sort(),
    );
    assert.ok(evaluators.every((profile) => profile.rubricVersion === THEOLOGY_RUBRIC_VERSION));
    assert.equal(new Set(evaluators.map((profile) => profile.independenceGroup)).size, 2);
  });
});

describe('자동 카탈로그 validator profile migration · SQL 경계', () => {
  it('검토된 private profile 표에 정확히 한 번 INSERT한다', () => {
    assert.equal((sql.match(/insert\s+into\s+private\.scripture_catalog_validator_profile\b/gi) ?? []).length, 1);
    assert.equal(readManifest().length, 4);
  });

  it('열 값은 profile JSON에서 파생하고 별도 복사본을 두지 않는다', () => {
    assert.match(sql, /entry\s*#>>\s*'\{profile,validatorKind\}'/);
    assert.match(sql, /entry\s*#>>\s*'\{profile,independenceGroup\}'/);
    assert.match(sql, /jsonb_array_elements_text\(entry\s*#>\s*'\{profile,authorizedChecks\}'\)/);
  });

  it('기존 행·스키마·함수·권한을 바꾸지 않는다', () => {
    const withoutComments = sql.replace(/--[^\n]*/g, '');
    for (const banned of [
      /\bupdate\b/i,
      /\bdelete\b/i,
      /\btruncate\b/i,
      /\balter\s+table\b/i,
      /\bdrop\b/i,
      /\bcreate\s+(?:or\s+replace\s+)?function\b/i,
      /\bgrant\b/i,
      /\brevoke\b/i,
      /\bsecurity\s+definer\b/i,
      /\bon\s+conflict\b/i,
    ]) {
      assert.doesNotMatch(withoutComments, banned, banned.source);
    }
  });

  it('runtime RPC·외부 호출·비밀 값이 없다', () => {
    for (const banned of [
      'create function',
      'http_post',
      'net.http',
      'OPENAI_API_KEY',
      'SUPABASE_SERVICE_ROLE_KEY',
      'service_role',
      'sk-',
    ]) {
      assert.equal(sql.includes(banned), false, banned);
    }
  });

  it('foundation migration 뒤의 별도 migration이다', () => {
    assert.ok(migrationRelativePath.includes('20260916011019_'));
    assert.ok('20260916011019' > '20260915120000');
  });
});
