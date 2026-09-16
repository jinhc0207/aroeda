/**
 * 자동 Scripture Catalog Foundation v1 검수 결함 회귀 테스트
 *
 * 실행: npm test
 *
 * 각 사례는 검수에서 지적된 결함을 그대로 재현한다. 수정 전 코드에서는 결함 입력이 통과했으므로
 * 이 테스트들이 실패했고, 수정 후에는 결함 입력이 거절되어 통과한다.
 * 변형(mutation) 코드는 수정 전·후 스키마 모두에서 같은 결함을 만들도록 일반화했다.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import * as catalogContract from '../../supabase/functions/_shared/automatic-scripture-catalog-contract.ts';
import * as activationContract from '../../supabase/functions/_shared/automatic-scripture-catalog-activation-contract.ts';
import * as fixtures from './automatic-scripture-catalog-test-fixtures.ts';

const { validateCatalogCandidate, validateCatalogSnapshot, computeArtifactHash } = catalogContract;
const { validateAutomaticValidationRecord, REQUIRED_VALIDATION_CHECKS } = activationContract;

const clone = <T>(value: T): T => structuredClone(value);
type AnyRecord = Record<string, any>;

/** 검증 문맥. 수정 후에는 등록된 validator profile과 attestation이 함께 들어간다. */
function contextFor(fixture: AnyRecord): AnyRecord {
  return (fixtures as AnyRecord).validationContextFor?.(fixture) ?? {
    candidate: fixture.candidate,
    baseCatalog: fixture.base,
    resolvePassageText: fixtures.resolveKrvPassage,
  };
}

/** payload가 있는 스키마(수정 후)라면 artifactHash를 payload에서 다시 봉인한다. 수정 전에는 아무것도 하지 않는다. */
async function reseal(record: AnyRecord) {
  for (const name of REQUIRED_VALIDATION_CHECKS) {
    const check = record.checks[name];
    if (check && 'payload' in check) check.artifactHash = await computeArtifactHash({ checkName: name, payload: check.payload });
  }
  const statuses = REQUIRED_VALIDATION_CHECKS.map((name) => record.checks[name]?.status);
  record.overallStatus = statuses.every((status) => status === 'pass') ? 'pass' : 'fail';
}

async function passingFixture(kind: 'existing' | 'new'): Promise<AnyRecord> {
  const base = fixtures.buildBaselineCatalog();
  const made: AnyRecord = kind === 'existing' ? await fixtures.makeExistingDomainCandidate(base) : await fixtures.makeNewDomainCandidate(base);
  const record = await fixtures.makePassingValidationRecord(made.candidate, made.candidateHash, base);
  return { base, ...made, record };
}

const activatable = (result: AnyRecord) => result.valid === true && result.activationBlockers.length === 0;

describe('결함 1 · other_uncovered 전체 횟수를 새 영역 수요 근거로 쓰면 안 된다', () => {
  it('새 영역 후보에 coverage_gap_daily other_uncovered 합계를 수요로 넣으면 활성화할 수 없다', async () => {
    const fixture = await passingFixture('new');
    const record = clone(fixture.record) as AnyRecord;
    const demand = record.checks.demandSignal;
    const legacy = {
      source: 'coverage_gap_daily',
      signalDomainId: 'other_uncovered',
      windowStartDate: '2026-08-01',
      windowEndDate: '2026-08-30',
      occurrenceCount: 42,
      activeDayCount: 18,
    };
    if ('payload' in demand) demand.payload = legacy;
    else Object.assign(demand, legacy);
    await reseal(record);

    const result = await validateAutomaticValidationRecord(record, { ...contextFor(fixture), candidate: fixture.candidate } as never);
    assert.equal(activatable(result), false, 'other_uncovered 전체 합계가 새 영역 수요로 인정됐습니다.');
  });
});

describe('결함 2 · artifactHash와 독립성', () => {
  it('어떤 검증 항목이든 artifactHash를 다른 유효한 sart_ 값으로 바꾸면 무효다', async () => {
    const fixture = await passingFixture('existing');
    for (const name of REQUIRED_VALIDATION_CHECKS) {
      const record = clone(fixture.record) as AnyRecord;
      record.checks[name].artifactHash = `sart_${'a'.repeat(64)}`;
      const result = await validateAutomaticValidationRecord(record, contextFor(fixture) as never);
      assert.equal(result.valid, false, `${name}: 임의의 sart_ 지문이 통과했습니다.`);
    }
  });

  it('등록되지 않은 평가자·독립 그룹 문자열만 서로 달라도 독립 평가로 인정하지 않는다', async () => {
    const fixture = await passingFixture('existing');
    const record = clone(fixture.record) as AnyRecord;
    let counter = 0;
    const replaceIdentities = (node: unknown) => {
      if (Array.isArray(node)) return node.forEach(replaceIdentities);
      if (node && typeof node === 'object') {
        for (const [key, value] of Object.entries(node as AnyRecord)) {
          counter += 1;
          if (key === 'evaluatorId' || key === 'independenceGroup') (node as AnyRecord)[key] = `unregistered-${key}-${counter}`;
          else if (key === 'profileHash') (node as AnyRecord)[key] = `svp_${counter.toString(16).padStart(64, '0')}`;
          else replaceIdentities(value);
        }
      }
    };
    replaceIdentities(record.checks.contextTheologyReview);
    await reseal(record);

    const result = await validateAutomaticValidationRecord(record, contextFor(fixture) as never);
    assert.equal(activatable(result), false, '등록되지 않은 평가자 문자열이 독립 평가로 인정됐습니다.');
  });
});

describe('결함 3 · 영역 사용자 표시 이름', () => {
  it('검증된 한국어 표시 이름이 없는 영역은 카탈로그에 들어갈 수 없다', () => {
    const base = clone(fixtures.buildBaselineCatalog()) as AnyRecord;
    for (const domain of base.domains) delete domain.displayName;
    assert.equal(validateCatalogSnapshot(base).valid, false, '표시 이름 없는 영역이 통과했습니다.');
  });

  it('내부 domain id를 표시 이름으로 쓰면 거절한다', () => {
    const base = clone(fixtures.buildBaselineCatalog()) as AnyRecord;
    base.domains[0].displayName = base.domains[0].id;
    assert.equal(validateCatalogSnapshot(base).valid, false, '내부 id가 표시 이름으로 통과했습니다.');
  });
});

describe('결함 4 · referenceLabel은 passages에서 결정적으로 나와야 한다', () => {
  it('장절과 무관한 라벨을 넣은 후보를 거절한다', async () => {
    const base = fixtures.buildBaselineCatalog();
    const { candidate } = await fixtures.makeExistingDomainCandidate(base);
    const { baseVersionHash: _b, proposedVersionHash: _p, ...draft } = clone(candidate) as AnyRecord;
    draft.cards[0].referenceLabel = '요한복음 3:16';
    const relabeled = await fixtures.finalizeCandidate(base, draft as never);
    const result = await validateCatalogCandidate(relabeled.candidate, base);
    assert.equal(result.valid, false, '잠언 16:1–3 본문에 요한복음 3:16 라벨이 통과했습니다.');
  });
});

describe('결함 5 · sourceResearchResultHash 필수', () => {
  for (const kind of ['existing', 'new'] as const) {
    it(`${kind === 'existing' ? '기존 영역' : '새 영역'} 후보에 연구 결과 지문이 없으면 거절한다`, async () => {
      const base = fixtures.buildBaselineCatalog();
      const made = kind === 'existing' ? await fixtures.makeExistingDomainCandidate(base) : await fixtures.makeNewDomainCandidate(base);
      const { baseVersionHash: _b, proposedVersionHash: _p, ...draft } = clone(made.candidate) as AnyRecord;
      draft.sourceResearchResultHash = null;
      const withoutResearch = await fixtures.finalizeCandidate(base, draft as never);
      const result = await validateCatalogCandidate(withoutResearch.candidate, base);
      assert.equal(result.valid, false, '연구 결과 없는 후보가 통과했습니다.');
    });
  }
});

describe('결함 5·6 · SQL 저장 경계', () => {
  const sql = readFileSync(
    new URL('../../supabase/migrations/20260915120000_create_automatic_scripture_catalog.sql', import.meta.url),
    'utf8',
  )
    .split('\n')
    .filter((line) => !/^\s*--/.test(line))
    .join('\n');

  it('후보 표가 실제 research_result에 외래 키로 묶인다', () => {
    assert.match(sql, /source_research_result_hash text not null\s+references private\.research_result \(result_hash\)/);
  });

  it('검증 항목마다 등록된 validator profile의 불변 attestation을 따로 저장하고 활성화가 그것을 요구한다', () => {
    assert.match(sql, /create table private\.scripture_catalog_validator_profile \(/);
    assert.match(sql, /create table private\.scripture_catalog_validation_attestation \(/);
    assert.ok(sql.includes('from private.scripture_catalog_validation_attestation'), '활성화가 attestation을 보지 않습니다.');
  });
});
