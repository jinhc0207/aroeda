/**
 * 연구 단계로 넘기는 꾸러미 · 테스트
 *
 * 실행: npm test
 *
 * 왜 필요한가:
 *   toResearchSources()는 ResearchSource 계약을 지키려고 근거를 떼어 낸다.
 *   그 함수를 그대로 쓰면 연구 단계가 자료 신원만 받는다.
 *   그래서 근거가 살아서 넘어가는 꾸러미를 따로 만들었다.
 *
 * 이 시험이 지키려는 것:
 *   근거가 사라지지 않는다.
 *   근거가 다른 자료에 잘못 붙지 않는다.
 *   꾸러미의 지문이 자료 목록만이 아니라 근거 내용까지 묶는다.
 *   사용자 정보가 들어갈 자리가 없다.
 *
 * 실제 DB·OpenAI·웹 호출은 하지 않는다.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import {
  EVIDENCE_SET_HASH_VERSION,
  HANDOFF_FIELDS,
  HANDOFF_SOURCE_FIELDS,
  buildBiblicalResearchHandoff,
  computeBiblicalResearchEvidenceSetHash,
  validateBiblicalResearchHandoff,
  type BiblicalResearchEvidenceSource,
  type BiblicalResearchHandoff,
} from '../../supabase/functions/_shared/biblical-research-handoff.ts';
import {
  buildSourceHarvestBrief,
  computeSourceId,
  type SourceHarvestResult,
} from '../../supabase/functions/_shared/source-harvester.ts';
import { RESEARCH_SOURCE_FIELDS } from '../../supabase/functions/_shared/research-source.ts';
import {
  EVIDENCE_STATEMENT_MAX,
  EVIDENCE_STATEMENT_MIN,
} from '../../supabase/functions/_shared/source-harvest-contract.ts';
import { getActiveCoveredDomains } from '../../supabase/functions/_shared/research-prioritizer-edge.ts';

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
const stripComments = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '');

const HANDOFF = '../../supabase/functions/_shared/biblical-research-handoff.ts';

const activeCovered = getActiveCoveredDomains();
const SNAPSHOT = `snap_${'a'.repeat(64)}`;
const STATEMENT = '이 주석은 본문의 반복되는 자기 권면을 절망의 부정이 아니라 신뢰 회복의 움직임으로 읽는다.';
const PSALM = { book: 'Psalms', chapter: 42, startVerse: 5, endVerse: 5 };

const url = (index: number) => `https://sources.example.org/aroeda/fixture-${index}`;

// 자료 id는 주소에서 서버가 만든다. 시험에서도 지어내지 않고 같은 함수로 만든다.
const SOURCE_IDS = await Promise.all(
  Array.from({ length: 6 }, (_, index) => computeSourceId(url(index))),
);
const sourceId = (index: number) => SOURCE_IDS[index] as string;

type Spec = { sourceType: string; publisher: string; uses: string[]; access: string };

const SPECS: Spec[] = [
  { sourceType: 'commentary', publisher: 'Fixture Academic Press', uses: ['exegesis'], access: 'full_text' },
  {
    sourceType: 'biblical_theology',
    publisher: 'Fixture University Press',
    uses: ['biblical_theology', 'doctrinal_context'],
    access: 'substantial_preview',
  },
  { sourceType: 'academic_article', publisher: 'Fixture Journal', uses: ['exegesis'], access: 'full_text' },
  {
    sourceType: 'pastoral_resource',
    publisher: 'Fixture Seminary',
    uses: ['pastoral_application'],
    access: 'full_text',
  },
  {
    sourceType: 'scholarly_institution',
    publisher: 'Fixture Institute',
    uses: ['exegesis', 'real_world_context'],
    access: 'full_text',
  },
];

const claimFor = (index: number, claimIndex = 0, overrides: Record<string, unknown> = {}) => {
  const spec = SPECS[index % SPECS.length];
  const use = spec.uses[0];
  return {
    evidenceId: `${sourceId(index)}:e${claimIndex + 1}`,
    intendedUse: use,
    statement: `${STATEMENT} (${index}-${claimIndex})`,
    passageReferences: use === 'exegesis' ? [{ ...PSALM }] : [],
    ...overrides,
  };
};

const harvestSource = (index: number, overrides: Record<string, unknown> = {}) => {
  const spec = SPECS[index % SPECS.length];
  return {
    sourceId: sourceId(index),
    sourceType: spec.sourceType,
    title: `연구 자료 ${index}`,
    authorOrOrganization: `연구자 ${index}`,
    publisherOrInstitution: spec.publisher,
    publicationYear: 2018 + index,
    url: url(index),
    accessedAt: '2026-09-02',
    accessLevel: spec.access,
    intendedUse: [...spec.uses],
    relevanceNote: '이 영역의 문맥을 확인하는 데 필요합니다.',
    evidenceClaims: [claimFor(index)],
    ...overrides,
  };
};

const harvest = (overrides: Record<string, unknown> = {}): SourceHarvestResult =>
  ({
    targetDomain: 'financial_hardship',
    evidenceVersion: 4,
    prioritizerSnapshotId: SNAPSHOT,
    sources: SPECS.map((_, index) => harvestSource(index)),
    rejectedSources: [
      { url: url(90), title: '익명 묵상글', rejectionReason: 'anonymous_or_unverifiable' },
    ],
    unresolvedSourceQuestions: ['이 영역의 최근 연구가 더 있는가', '학회 자료를 더 볼 수 있는가'],
    ...overrides,
  }) as unknown as SourceHarvestResult;

const build = (overrides: Record<string, unknown> = {}) =>
  buildBiblicalResearchHandoff({ harvest: harvest(overrides), activeCoveredDomains: activeCovered });

/** 자료 하나만 바꾼 사본 */
const withSource = (index: number, patch: Record<string, unknown>) => {
  const base = harvest();
  const sources = base.sources.map((entry, position) =>
    position === index ? { ...entry, ...patch } : entry,
  );
  return build({ sources });
};

/* ------------------------------------------------------------------ */

describe('꾸러미 · A. 기본', () => {
  it('올바른 수집 결과는 꾸러미가 된다', async () => {
    const outcome = await build();
    assert.equal(outcome.ok, true, outcome.ok ? '' : outcome.errors.join(' / '));
  });

  it('꾸러미에는 네 가지만 있다', async () => {
    const outcome = await build();
    if (!outcome.ok) return;
    assert.deepEqual(Object.keys(outcome.handoff).sort(), [
      'brief',
      'evidenceSetHash',
      'sourceUnresolvedQuestions',
      'sources',
    ]);
  });

  it('의뢰서의 다섯 값이 그대로 있다', async () => {
    const outcome = await build();
    if (!outcome.ok) return;

    const brief = buildSourceHarvestBrief({
      targetDomain: 'financial_hardship',
      evidenceVersion: 4,
      prioritizerSnapshotId: SNAPSHOT,
      activeCoveredDomains: activeCovered,
    });
    assert.deepEqual(outcome.handoff.brief, brief);
    assert.equal(outcome.handoff.brief.domainDescription.length > 0, true);
  });

  it('근거가 그대로 넘어간다', async () => {
    const outcome = await build();
    if (!outcome.ok) return;

    for (const [index, source] of outcome.handoff.sources.entries()) {
      assert.equal(source.evidenceClaims.length, 1, String(index));
      assert.equal(source.evidenceClaims[0].statement, claimFor(index).statement);
      assert.deepEqual(source.evidenceClaims[0].passageReferences, claimFor(index).passageReferences);
      assert.equal(source.evidenceClaims[0].intendedUse, claimFor(index).intendedUse);
    }
  });

  it('수집 단계 메모는 빠진다', async () => {
    const outcome = await build();
    if (!outcome.ok) return;

    for (const source of outcome.handoff.sources) {
      assert.equal('relevanceNote' in source, false);
    }
    assert.equal(JSON.stringify(outcome.handoff).includes('relevanceNote'), false);
  });

  it('자료의 항목은 ResearchSource 그대로에 근거만 더한 것이다', async () => {
    const outcome = await build();
    if (!outcome.ok) return;

    assert.deepEqual(Object.keys(outcome.handoff.sources[0]).sort(), [
      ...RESEARCH_SOURCE_FIELDS,
      'evidenceClaims',
    ].sort());
  });

  it('채택하지 않은 자료는 넘기지 않는다', async () => {
    const outcome = await build();
    if (!outcome.ok) return;

    assert.equal('rejectedSources' in outcome.handoff, false);
    assert.equal(JSON.stringify(outcome.handoff).includes('anonymous_or_unverifiable'), false);
    assert.equal(JSON.stringify(outcome.handoff).includes('익명 묵상글'), false);
  });

  it('남은 물음은 순서까지 그대로 넘어간다', async () => {
    const outcome = await build();
    if (!outcome.ok) return;

    assert.deepEqual(outcome.handoff.sourceUnresolvedQuestions, [
      '이 영역의 최근 연구가 더 있는가',
      '학회 자료를 더 볼 수 있는가',
    ]);
  });
});

describe('꾸러미 · B. 근거의 주인', () => {
  it('자료 id가 그대로다', async () => {
    const outcome = await build();
    if (!outcome.ok) return;

    for (const [index, source] of outcome.handoff.sources.entries()) {
      assert.equal(source.sourceId, sourceId(index));
      assert.equal(source.url, url(index));
    }
  });

  it('근거 번호가 그 자료의 것이고 순서가 맞다', async () => {
    const outcome = await build();
    if (!outcome.ok) return;

    for (const source of outcome.handoff.sources) {
      for (const [claimIndex, claim] of source.evidenceClaims.entries()) {
        assert.equal(claim.evidenceId, `${source.sourceId}:e${claimIndex + 1}`);
      }
    }
  });

  it('꾸러미 전체에서 번호가 겹치지 않는다', async () => {
    const outcome = await build();
    if (!outcome.ok) return;

    const ids = outcome.handoff.sources.flatMap((source) =>
      source.evidenceClaims.map((claim) => claim.evidenceId),
    );
    assert.equal(new Set(ids).size, ids.length);
  });

  it('근거를 자리 맞춰 다시 잇지 않는다', () => {
    // 배열 위치로 이어 붙이면 다른 자료의 근거가 섞일 수 있다.
    // 각 자료가 이미 들고 있는 것을 그대로 옮긴다.
    const code = stripComments(read(HANDOFF));
    assert.ok(code.includes('const { relevanceNote, ...rest } = entry;'));
    assert.equal(code.includes('toResearchSources'), false);
    // 자료 목록과 근거 목록을 따로 만들어 index로 맞추는 자리가 없다.
    assert.equal(/sources\[index\]\.evidenceClaims|claims\[index\]/.test(code), false);
  });

  it('문장을 고치지 않는다', () => {
    const code = stripComments(read(HANDOFF));
    for (const banned of ['.slice(0,', '.substring(', '.trim()', 'summariz', 'rewrite']) {
      assert.equal(code.includes(banned), false, banned);
    }
  });
});

describe('꾸러미 · C. 어긋나면 만들지 않는다', () => {
  it('자료 id가 주소와 맞지 않으면 거절한다', async () => {
    const outcome = await withSource(0, { sourceId: `src_${'f'.repeat(64)}` });
    assert.equal(outcome.ok, false);
  });

  it('번호 모양이 틀리면 거절한다', async () => {
    const outcome = await withSource(0, {
      evidenceClaims: [claimFor(0, 0, { evidenceId: 'made-up' })],
    });
    assert.equal(outcome.ok, false);
  });

  it('다른 자료의 번호를 붙이면 거절한다', async () => {
    const outcome = await withSource(0, {
      evidenceClaims: [claimFor(0, 0, { evidenceId: `${sourceId(1)}:e1` })],
    });
    assert.equal(outcome.ok, false);
  });

  it('그 자료가 갖지 않은 용도의 근거는 거절한다', async () => {
    const outcome = await withSource(3, {
      evidenceClaims: [claimFor(3, 0, { intendedUse: 'exegesis', passageReferences: [{ ...PSALM }] })],
    });
    assert.equal(outcome.ok, false);
    if (outcome.ok) return;
    // 새 규칙이 아니라 기존 검사기의 사유로 걸린다.
    assert.ok(outcome.errors.some((error) => error.includes('evidence_use_not_in_source')));
  });

  it('성경에 없는 본문 위치는 거절한다', async () => {
    const outcome = await withSource(0, {
      evidenceClaims: [
        claimFor(0, 0, { passageReferences: [{ book: 'Psalmss', chapter: 42, startVerse: 5, endVerse: 5 }] }),
      ],
    });
    assert.equal(outcome.ok, false);
    if (outcome.ok) return;
    assert.ok(outcome.errors.some((error) => error.includes('evidence_passages_invalid')));
  });

  it('문장이 너무 짧거나 길면 거절한다', async () => {
    for (const statement of ['ㄱ'.repeat(EVIDENCE_STATEMENT_MIN - 1), 'ㄱ'.repeat(EVIDENCE_STATEMENT_MAX + 1)]) {
      const outcome = await withSource(0, { evidenceClaims: [claimFor(0, 0, { statement })] });
      assert.equal(outcome.ok, false, String(statement.length));
    }
  });

  it('근거가 없으면 거절한다', async () => {
    const outcome = await withSource(0, { evidenceClaims: [] });
    assert.equal(outcome.ok, false);
  });

  it('영역·근거 판본·판단 시점이 어긋나면 거절한다', async () => {
    assert.equal((await build({ targetDomain: 'grief_loss' })).ok, false);
    assert.equal((await build({ evidenceVersion: 0 })).ok, false);
    assert.equal((await build({ prioritizerSnapshotId: '' })).ok, false);
  });

  it('품질 기준을 못 채우면 거절한다', async () => {
    // 채택 자료가 최소 수에 못 미친다.
    const outcome = await build({ sources: [harvestSource(0)] });
    assert.equal(outcome.ok, false);
  });

  it('하나라도 어긋나면 일부만 넘기지 않는다', async () => {
    const outcome = await withSource(2, { evidenceClaims: [] });
    assert.equal(outcome.ok, false);
    if (outcome.ok) return;
    assert.equal('handoff' in outcome, false);
  });

  it('깊은 검사를 새로 만들지 않고 기존 검사기를 쓴다', () => {
    const code = stripComments(read(HANDOFF));
    assert.ok(code.includes('checkVerificationDraftSource('));
    assert.ok(code.includes('validateSourceHarvestResult('));
    // 규칙을 여기서 다시 적지 않는다.
    assert.equal(/EVIDENCE_STATEMENT_MAX|checkBibleReference|INTENDED_USES/.test(code), false);
  });
});

describe('꾸러미 · D. 지문', () => {
  const hashOf = async (overrides: Record<string, unknown> = {}) => {
    const outcome = await build(overrides);
    assert.equal(outcome.ok, true, outcome.ok ? '' : outcome.errors.join(' / '));
    if (!outcome.ok) throw new Error('handoff failed');
    return outcome.handoff.evidenceSetHash;
  };

  it('모양이 정해져 있다', async () => {
    assert.match(await hashOf(), /^evset_[0-9a-f]{64}$/);
  });

  it('판본 표시가 붙는다', () => {
    assert.equal(EVIDENCE_SET_HASH_VERSION, 'v1|biblical-research-evidence');
    assert.ok(stripComments(read(HANDOFF)).includes('EVIDENCE_SET_HASH_VERSION'));
  });

  it('같은 꾸러미면 같은 지문이다', async () => {
    assert.equal(await hashOf(), await hashOf());
  });

  it('자료 순서만 다르면 같은 지문이다', async () => {
    const base = harvest();
    const reversed = await build({ sources: [...base.sources].reverse() });
    assert.equal(reversed.ok, true);
    if (!reversed.ok) return;
    assert.equal(reversed.handoff.evidenceSetHash, await hashOf());
  });

  it('활성 영역 순서만 다르면 같은 지문이다', async () => {
    const outcome = await buildBiblicalResearchHandoff({
      harvest: harvest(),
      activeCoveredDomains: [...activeCovered].reverse(),
    });
    assert.equal(outcome.ok, true);
    if (!outcome.ok) return;
    assert.equal(outcome.handoff.evidenceSetHash, await hashOf());
  });

  it('근거 문장이 한 글자만 달라도 다른 지문이다', async () => {
    const changed = await withSource(0, {
      evidenceClaims: [claimFor(0, 0, { statement: `${claimFor(0).statement}.` })],
    });
    assert.equal(changed.ok, true);
    if (!changed.ok) return;
    assert.notEqual(changed.handoff.evidenceSetHash, await hashOf());
  });

  it('본문 위치가 달라지면 다른 지문이다', async () => {
    const changed = await withSource(0, {
      evidenceClaims: [
        claimFor(0, 0, { passageReferences: [{ book: 'Psalms', chapter: 42, startVerse: 6, endVerse: 6 }] }),
      ],
    });
    assert.equal(changed.ok, true);
    if (!changed.ok) return;
    assert.notEqual(changed.handoff.evidenceSetHash, await hashOf());
  });

  it('자료가 달라지면 다른 지문이다', async () => {
    const changed = await withSource(0, { title: '다른 제목' });
    assert.equal(changed.ok, true);
    if (!changed.ok) return;
    assert.notEqual(changed.handoff.evidenceSetHash, await hashOf());
  });

  it('영역·근거 판본·판단 시점이 달라지면 다른 지문이다', async () => {
    const base = await hashOf();
    assert.notEqual(await hashOf({ evidenceVersion: 5 }), base);
    assert.notEqual(await hashOf({ prioritizerSnapshotId: `snap_${'b'.repeat(64)}` }), base);

    // 영역이 바뀌면 설명도 함께 바뀐다.
    const other = await hashOf({ targetDomain: 'spiritual_dryness' });
    assert.notEqual(other, base);
  });

  it('남은 물음이 달라지면 다른 지문이다', async () => {
    const base = await hashOf();
    assert.notEqual(await hashOf({ unresolvedSourceQuestions: ['다른 물음'] }), base);
    assert.notEqual(await hashOf({ unresolvedSourceQuestions: [] }), base);
    // 순서에 뜻이 있을 수 있으므로 정렬하지 않는다. 순서가 바뀌면 다른 지문이다.
    assert.notEqual(
      await hashOf({
        unresolvedSourceQuestions: ['학회 자료를 더 볼 수 있는가', '이 영역의 최근 연구가 더 있는가'],
      }),
      base,
    );
  });

  it('자료 목록만 묶지 않는다', async () => {
    // 같은 자료에 다른 근거를 붙이면 반드시 다른 지문이 나와야 한다.
    const changed = await withSource(1, {
      evidenceClaims: [claimFor(1, 0, { statement: `${'ㄱ'.repeat(40)} 다른 관찰` })],
    });
    assert.equal(changed.ok, true);
    if (!changed.ok) return;
    assert.notEqual(changed.handoff.evidenceSetHash, await hashOf());
  });

  it('지문을 따로 계산해도 같은 값이 나온다', async () => {
    const outcome = await build();
    if (!outcome.ok) return;

    const again = await computeBiblicalResearchEvidenceSetHash({
      brief: outcome.handoff.brief,
      sources: outcome.handoff.sources,
      sourceUnresolvedQuestions: outcome.handoff.sourceUnresolvedQuestions,
    });
    assert.equal(again, outcome.handoff.evidenceSetHash);
  });

  it('객체 키 순서에 기대지 않는다', () => {
    const code = stripComments(read(HANDOFF));
    // 인자 타입도 '}'로 끝나므로 경계를 다음 함수 선언까지로 잡는다.
    const body = code
      .split('function canonicalize(')[1]
      .split('export async function computeBiblicalResearchEvidenceSetHash')[0];

    // 자리를 정한 배열만 넘긴다. 객체를 넘기면 항목이 적힌 순서에 결과가 달린다.
    assert.ok(body.includes('const canonical: unknown[] = ['));
    assert.ok(body.includes('return JSON.stringify(canonical);'));
    assert.equal(/JSON\.stringify\(\s*\{/.test(body), false);
    assert.ok(body.includes('.sort('));
  });

  it('값을 이어 붙이지 않는다', () => {
    // 사람이 쓴 글에 이음 글자가 들어오면 경계가 무너진다.
    const body = stripComments(read(HANDOFF))
      .split('function canonicalize(')[1]
      .split('export async function computeBiblicalResearchEvidenceSetHash')[0];

    assert.equal(/\.join\(/.test(body), false);
    for (const separator of ['\\u001f', '\\u001e', '\\u001d']) {
      assert.equal(body.includes(separator), false, separator);
    }
  });
});

describe('꾸러미 · D2. 경계가 무너지지 않는다', () => {
  const UNIT = '\u001f';
  const RECORD = '\u001e';
  const GROUP = '\u001d';

  const hashOf = async (overrides: Record<string, unknown> = {}) => {
    const outcome = await build(overrides);
    assert.equal(outcome.ok, true, outcome.ok ? '' : outcome.errors.join(' / '));
    if (!outcome.ok) throw new Error('handoff failed');
    return outcome.handoff.evidenceSetHash;
  };

  it('A. 남은 물음을 이어 붙인 것과 나눠 적은 것은 다르다', async () => {
    const joined = await hashOf({ unresolvedSourceQuestions: [`A${UNIT}B`] });
    const split = await hashOf({ unresolvedSourceQuestions: ['A', 'B'] });
    assert.notEqual(joined, split);

    // 다른 이음 글자로도 마찬가지다.
    for (const separator of [RECORD, GROUP, ',', '', '|']) {
      assert.notEqual(
        await hashOf({ unresolvedSourceQuestions: [`A${separator}B`] }),
        await hashOf({ unresolvedSourceQuestions: ['A', 'B'] }),
        JSON.stringify(separator),
      );
    }
  });

  it('B. 근거 문장에 이음 글자가 들어가도 섞이지 않는다', async () => {
    const base = 'ㄱ'.repeat(30);
    const withSeparator = await hashOf();

    for (const separator of [UNIT, RECORD, GROUP]) {
      const a = await (async () => {
        const outcome = await withSource(0, {
          evidenceClaims: [claimFor(0, 0, { statement: `${base}${separator}${base}` })],
        });
        assert.equal(outcome.ok, true);
        if (!outcome.ok) throw new Error('failed');
        return outcome.handoff.evidenceSetHash;
      })();

      const b = await (async () => {
        const outcome = await withSource(0, {
          evidenceClaims: [claimFor(0, 0, { statement: `${base}${base}` })],
        });
        assert.equal(outcome.ok, true);
        if (!outcome.ok) throw new Error('failed');
        return outcome.handoff.evidenceSetHash;
      })();

      assert.notEqual(a, b, separator);
      assert.notEqual(a, withSeparator, separator);
    }
  });

  it('C. 제목과 저자의 경계가 지켜진다', async () => {
    // 이어 붙이던 방식에서는 이 둘이 같은 글이 되어 같은 지문이 나왔다.
    const first = await (async () => {
      const outcome = await withSource(0, { title: '가나', authorOrOrganization: '다' });
      if (!outcome.ok) throw new Error(outcome.errors.join(' / '));
      return outcome.handoff.evidenceSetHash;
    })();

    const second = await (async () => {
      const outcome = await withSource(0, { title: '가', authorOrOrganization: '나다' });
      if (!outcome.ok) throw new Error(outcome.errors.join(' / '));
      return outcome.handoff.evidenceSetHash;
    })();

    assert.notEqual(first, second);
  });

  it('C. 발행처와 주소의 경계도 지켜진다', async () => {
    const first = await (async () => {
      const outcome = await withSource(1, { publisherOrInstitution: `A${UNIT}B` });
      if (!outcome.ok) throw new Error(outcome.errors.join(' / '));
      return outcome.handoff.evidenceSetHash;
    })();

    const second = await (async () => {
      const outcome = await withSource(1, { publisherOrInstitution: 'AB' });
      if (!outcome.ok) throw new Error(outcome.errors.join(' / '));
      return outcome.handoff.evidenceSetHash;
    })();

    assert.notEqual(first, second);
  });

  it('용도 목록의 경계가 지켜진다', async () => {
    // 두 용도를 이어 붙인 이름 하나와, 용도 둘은 달라야 한다.
    const base = await hashOf();
    const outcome = await withSource(1, { intendedUse: ['biblical_theology'] });
    assert.equal(outcome.ok, true);
    if (!outcome.ok) return;
    assert.notEqual(outcome.handoff.evidenceSetHash, base);
  });
});

describe('꾸러미 · E. 근거가 사라지지 않는다', () => {
  it('모든 자료에 근거가 있다', async () => {
    const outcome = await build();
    if (!outcome.ok) return;

    for (const source of outcome.handoff.sources) {
      assert.ok(source.evidenceClaims.length >= 1, source.sourceId);
    }
  });

  it('근거 총 개수가 들어온 것과 같다', async () => {
    const input = harvest();
    const expected = input.sources.reduce((sum, source) => sum + source.evidenceClaims.length, 0);

    const outcome = await build();
    if (!outcome.ok) return;

    const actual = outcome.handoff.sources.reduce(
      (sum, source) => sum + source.evidenceClaims.length,
      0,
    );
    assert.equal(actual, expected);
  });

  it('근거가 여러 개인 자료도 그대로 넘어간다', async () => {
    const outcome = await withSource(0, {
      evidenceClaims: [claimFor(0, 0), claimFor(0, 1), claimFor(0, 2)],
    });
    assert.equal(outcome.ok, true, outcome.ok ? '' : outcome.errors.join(' / '));
    if (!outcome.ok) return;

    const first = outcome.handoff.sources.find((source) => source.sourceId === sourceId(0));
    assert.equal(first?.evidenceClaims.length, 3);
    assert.deepEqual(
      first?.evidenceClaims.map((claim) => claim.evidenceId),
      [`${sourceId(0)}:e1`, `${sourceId(0)}:e2`, `${sourceId(0)}:e3`],
    );
  });

  it('연구 단계가 쓰던 변환 함수를 쓰지 않는다', () => {
    // 그 함수는 근거를 떼어 낸다.
    const code = stripComments(read(HANDOFF));
    assert.equal(code.includes('toResearchSources'), false);

    // 그 함수 자체는 그대로 남아 있다.
    const harvester = read('../../supabase/functions/_shared/source-harvester.ts');
    assert.ok(harvester.includes('export function toResearchSources'));
  });
});

describe('꾸러미 · F. 사용자 정보가 들어갈 자리가 없다', () => {
  it('꾸러미 어디에도 사용자 정보가 없다', async () => {
    const outcome = await build();
    if (!outcome.ok) return;

    const dumped = JSON.stringify(outcome.handoff);
    for (const banned of [
      'situation',
      'userId',
      'user_id',
      'sessionId',
      'deviceId',
      // 영역 이름 waiting_unanswered_prayer와 섞이지 않게 기도문 항목 이름으로 본다.
      'prayerText',
      'prayer_text',
      'severity',
      'diagnosis',
      'decisionId',
      'recoveryId',
    ]) {
      assert.equal(dumped.includes(banned), false, banned);
    }
  });

  it('그런 값을 받을 자리가 아예 없다', () => {
    const code = stripComments(read(HANDOFF));
    for (const banned of [
      'userSituation',
      'userId',
      'sessionId',
      'deviceId',
      'prayerText',
      'decisionId',
      'recoveryId',
      'prioritizerReason',
      'prioritizerScore',
      'confidence',
    ]) {
      assert.equal(code.includes(banned), false, banned);
    }
  });

  it('부르는 쪽이 넘기는 것은 둘뿐이다', () => {
    const code = stripComments(read(HANDOFF));
    const signature = code.split('export async function buildBiblicalResearchHandoff(input: {')[1]
      .split('})')[0];
    assert.deepEqual(
      [...signature.matchAll(/^\s{2}([a-zA-Z]+):/gm)].map((match) => match[1]),
      ['harvest', 'activeCoveredDomains'],
    );
    // 영역 설명과 지문을 밖에서 받지 않는다.
    assert.equal(signature.includes('domainDescription'), false);
    assert.equal(signature.includes('evidenceSetHash'), false);
    assert.equal(signature.includes('brief'), false);
  });
});

describe('꾸러미 · G. 바깥과 닿지 않는다', () => {
  it('네트워크·DB·환경변수를 모른다', () => {
    const code = stripComments(read(HANDOFF));
    for (const banned of [
      'fetch(',
      'Deno.env',
      'process.env',
      '/rest/v1/',
      'createClient',
      'openai',
      'OpenAI',
      'api.openai.com',
    ]) {
      assert.equal(code.includes(banned), false, banned);
    }
  });

  it('가져오는 것은 기존 계약뿐이다', () => {
    const imports = [...read(HANDOFF).matchAll(/from '([^']+)'/g)].map((match) => match[1]);
    assert.deepEqual([...new Set(imports)].sort(), [
      './biblical-researcher.ts',
      './research-source.ts',
      './source-harvester.ts',
      './verification-draft-source.ts',
    ]);
  });

  it('되돌아가는 의존이 생기지 않았다', () => {
    // 연구 단계와 수집 단계 어느 쪽도 이 파일을 알지 못한다.
    for (const path of [
      '../../supabase/functions/_shared/biblical-researcher.ts',
      '../../supabase/functions/_shared/biblical-research-contract.ts',
      '../../supabase/functions/_shared/source-harvester.ts',
      '../../supabase/functions/_shared/research-source.ts',
    ]) {
      assert.equal(read(path).includes('biblical-research-handoff'), false, path);
    }
  });
});

describe('꾸러미 · 기존 계약은 그대로다', () => {
  it('연구 단계가 자료 목록을 직접 들고 있지 않다', () => {
    // 연구 결과에는 자료 목록이 없다. 근거 번호와 자료 id만 가리킨다.
    for (const path of [
      '../../supabase/functions/_shared/biblical-researcher.ts',
      '../../supabase/functions/_shared/biblical-research-contract.ts',
      '../../supabase/functions/_shared/research-source.ts',
    ]) {
      assert.equal(read(path).includes('evidenceClaims'), false, path);
    }

    // 지문은 연구 결과가 들고 있지만 서버가 붙인다. 꾸러미가 그 주인이다.
    const researcher = read('../../supabase/functions/_shared/biblical-researcher.ts');
    assert.ok(researcher.includes('서버가 붙인다. 모델이 만들 수 없다'));
    assert.equal(read('../../supabase/functions/_shared/research-source.ts').includes('evidenceSetHash'), false);
  });

  it('연구 단계 실행을 만들지 않았다', () => {
    const code = stripComments(read(HANDOFF));
    for (const banned of ['model', 'timeout', 'max_output_tokens', 'instructions', 'schema']) {
      assert.equal(code.includes(banned), false, banned);
    }
  });

  it('수집 단계 근거 규칙이 그대로다', () => {
    const contract = read('../../supabase/functions/_shared/source-harvest-contract.ts');
    assert.ok(contract.includes('export const EVIDENCE_CLAIM_MIN = 1;'));
    assert.ok(contract.includes('export const EVIDENCE_CLAIM_MAX = 4;'));
    assert.ok(contract.includes('export const EVIDENCE_STATEMENT_MIN = 20;'));
    assert.ok(contract.includes('export const EVIDENCE_STATEMENT_MAX = 360;'));
  });

  it('서버가 뜻의 정확함을 보증하지 않는다는 한계가 적혀 있다', () => {
    const code = read(HANDOFF);
    assert.ok(code.includes('서버가 보증하지 않는 것'));
    assert.ok(code.includes('근거 문장이 원문의 뜻을 옳게 옮겼는지'));
  });
});

/* ================================================================== */
/* 보관해 둔 꾸러미를 다시 확인하기                                      */
/* ================================================================== */

/** 표에서 나온 것처럼, 이름 없는 값으로 되돌린 사본 하나 */
const stored = async (): Promise<Record<string, unknown>> => {
  const outcome = await build();
  assert.equal(outcome.ok, true);
  if (!outcome.ok) throw new Error('fixture failed');
  return JSON.parse(JSON.stringify(outcome.handoff));
};

/** 한 곳만 바꾼 사본으로 확인한다 */
const afterChange = async (mutate: (value: Record<string, unknown>) => void) => {
  const value = await stored();
  mutate(value);
  return await validateBiblicalResearchHandoff(value);
};

describe('꾸러미 다시 확인 · A. 올바른 꾸러미', () => {
  it('만든 그대로면 통과한다', async () => {
    const checked = await validateBiblicalResearchHandoff(await stored());
    assert.equal(checked.valid, true, checked.valid ? '' : checked.errors.join(' / '));
  });

  it('받은 그 값을 그대로 돌려준다', async () => {
    const value = await stored();
    const checked = await validateBiblicalResearchHandoff(value);
    assert.equal(checked.valid, true);
    if (!checked.valid) return;
    // 새로 만들지 않는다. 같은 객체다.
    assert.equal(checked.handoff as unknown, value);
  });

  it('항목 목록이 타입과 어긋나지 않는다', async () => {
    const value = await stored();
    assert.deepEqual([...HANDOFF_FIELDS].sort(), Object.keys(value).sort());

    const source = (value.sources as Record<string, unknown>[])[0] as Record<string, unknown>;
    assert.deepEqual([...HANDOFF_SOURCE_FIELDS].sort(), Object.keys(source).sort());
  });
});

describe('꾸러미 다시 확인 · B. 모양이 아닌 것', () => {
  it('객체가 아니면 거절한다', async () => {
    for (const bad of [null, undefined, [], '문자열', 42, true, () => {}]) {
      const checked = await validateBiblicalResearchHandoff(bad);
      assert.equal(checked.valid, false, String(bad));
    }
  });

  it('빈 객체는 거절한다', async () => {
    assert.equal((await validateBiblicalResearchHandoff({})).valid, false);
  });

  it('항목이 빠지면 거절한다', async () => {
    for (const field of HANDOFF_FIELDS) {
      const checked = await afterChange((value) => {
        delete value[field];
      });
      assert.equal(checked.valid, false, field);
    }
  });

  it('없던 항목이 더 붙으면 거절한다', async () => {
    const checked = await afterChange((value) => {
      value.rejectedSources = [];
    });
    assert.equal(checked.valid, false);
  });

  it('자료에 수집 단계 메모가 남아 있으면 거절한다', async () => {
    const checked = await afterChange((value) => {
      const source = (value.sources as Record<string, unknown>[])[0] as Record<string, unknown>;
      source.relevanceNote = '이 자료를 고른 이유';
    });
    assert.equal(checked.valid, false);
  });

  it('각 자리의 종류가 다르면 거절한다', async () => {
    for (const [field, bad] of [
      ['brief', []],
      ['sources', {}],
      ['sourceUnresolvedQuestions', '문자열'],
      ['sourceUnresolvedQuestions', [1, 2]],
      ['evidenceSetHash', 42],
    ] as const) {
      const checked = await afterChange((value) => {
        value[field] = bad as unknown;
      });
      assert.equal(checked.valid, false, `${field}`);
    }
  });
});

describe('꾸러미 다시 확인 · C. 의뢰서는 서버가 다시 만든다', () => {
  it('영역 설명을 바꾸면 거절한다', async () => {
    const checked = await afterChange((value) => {
      (value.brief as Record<string, unknown>).domainDescription = '내가 적어 넣은 설명';
    });
    assert.equal(checked.valid, false);
  });

  it('연구 대상이 아닌 영역이면 거절한다', async () => {
    const checked = await afterChange((value) => {
      (value.brief as Record<string, unknown>).targetDomain = 'other_uncovered';
    });
    assert.equal(checked.valid, false);
  });

  it('의뢰서에 없던 항목이 붙으면 거절한다', async () => {
    const checked = await afterChange((value) => {
      (value.brief as Record<string, unknown>).extra = true;
    });
    assert.equal(checked.valid, false);
  });

  it('지문은 같지만 의뢰서가 서버가 만드는 모양이 아니면 거절한다', async () => {
    // 활성 영역은 지문을 셀 때 중복을 없애고 정렬한다.
    // 그래서 순서를 바꾸거나 같은 이름을 더 넣어도 지문은 그대로다.
    // 그것까지 통과시키면 의뢰서가 서버가 만든 것이 아니어도 지나간다.
    for (const mutate of [
      (covered: string[]) => [...covered].reverse(),
      (covered: string[]) => [...covered, covered[0] as string],
    ]) {
      const value = await stored();
      const brief = value.brief as Record<string, unknown>;
      const before = value.evidenceSetHash as string;
      brief.activeCoveredDomains = mutate(brief.activeCoveredDomains as string[]);

      // 지문은 정말 그대로여야 이 시험이 뜻을 갖는다.
      const handoff = value as unknown as BiblicalResearchHandoff;
      const recomputed = await computeBiblicalResearchEvidenceSetHash({
        brief: handoff.brief,
        sources: handoff.sources,
        sourceUnresolvedQuestions: handoff.sourceUnresolvedQuestions,
      });
      assert.equal(recomputed, before);

      assert.equal((await validateBiblicalResearchHandoff(value)).valid, false);
    }
  });

  it('의뢰서 항목이 빠지면 거절한다', async () => {
    const checked = await afterChange((value) => {
      delete (value.brief as Record<string, unknown>).activeCoveredDomains;
    });
    assert.equal(checked.valid, false);
  });
});

describe('꾸러미 다시 확인 · D. 자료와 근거', () => {
  const firstSource = (value: Record<string, unknown>) =>
    (value.sources as Record<string, unknown>[])[0] as Record<string, unknown>;

  it('자료 id가 주소에서 만든 값과 다르면 거절한다', async () => {
    const checked = await afterChange((value) => {
      firstSource(value).sourceId = 'src_' + 'f'.repeat(64);
    });
    assert.equal(checked.valid, false);
  });

  it('근거 번호가 그 자료의 것이 아니면 거절한다', async () => {
    const checked = await afterChange((value) => {
      const source = firstSource(value);
      const claims = source.evidenceClaims as Record<string, unknown>[];
      (claims[0] as Record<string, unknown>).evidenceId = `${sourceId(1)}:e1`;
    });
    assert.equal(checked.valid, false);
  });

  it('근거 번호의 차례가 어긋나면 거절한다', async () => {
    const checked = await afterChange((value) => {
      const source = firstSource(value);
      const claims = source.evidenceClaims as Record<string, unknown>[];
      (claims[0] as Record<string, unknown>).evidenceId = `${source.sourceId}:e2`;
    });
    assert.equal(checked.valid, false);
  });

  it('근거가 하나도 없으면 거절한다', async () => {
    const checked = await afterChange((value) => {
      firstSource(value).evidenceClaims = [];
    });
    assert.equal(checked.valid, false);
  });

  it('근거의 용도가 그 자료의 용도에 없으면 거절한다', async () => {
    const checked = await afterChange((value) => {
      const claims = firstSource(value).evidenceClaims as Record<string, unknown>[];
      (claims[0] as Record<string, unknown>).intendedUse = 'pastoral_safety';
    });
    assert.equal(checked.valid, false);
  });

  it('근거 문장이 너무 짧으면 거절한다', async () => {
    const checked = await afterChange((value) => {
      const claims = firstSource(value).evidenceClaims as Record<string, unknown>[];
      (claims[0] as Record<string, unknown>).statement = '짧다';
    });
    assert.equal(checked.valid, false);
  });

  it('성경에 없는 본문 위치면 거절한다', async () => {
    const checked = await afterChange((value) => {
      const claims = firstSource(value).evidenceClaims as Record<string, unknown>[];
      (claims[0] as Record<string, unknown>).passageReferences = [
        { book: 'Psalms', chapter: 999, startVerse: 1, endVerse: 1 },
      ];
    });
    assert.equal(checked.valid, false);
  });

  it('주해 근거에 본문 위치가 없으면 거절한다', async () => {
    const checked = await afterChange((value) => {
      const claims = firstSource(value).evidenceClaims as Record<string, unknown>[];
      (claims[0] as Record<string, unknown>).passageReferences = [];
    });
    assert.equal(checked.valid, false);
  });

  it('자료에 없던 항목이 붙으면 거절한다', async () => {
    const checked = await afterChange((value) => {
      firstSource(value).extra = true;
    });
    assert.equal(checked.valid, false);
  });

  it('자료 수가 정해진 범위를 벗어나면 거절한다', async () => {
    const checked = await afterChange((value) => {
      value.sources = [(value.sources as unknown[])[0]];
    });
    assert.equal(checked.valid, false);
  });

  it('사용자 정보가 어느 깊이에 있든 거절한다', async () => {
    const checked = await afterChange((value) => {
      const claims = firstSource(value).evidenceClaims as Record<string, unknown>[];
      (claims[0] as Record<string, unknown>).rawSituation = '요즘 생계가 어렵습니다';
    });
    assert.equal(checked.valid, false);
  });
});

describe('꾸러미 다시 확인 · D2. 지문까지 맞춰 놓아도 규칙은 산다', () => {
  /**
   * 앞의 시험들은 내용을 바꾸면 지문이 어긋나서 잡힌다.
   * 그러면 "지문만 보고 있는 것 아닌가"를 가릴 수 없다.
   *
   * 여기서는 내용을 바꾼 뒤 지문까지 그 내용으로 다시 계산해서 넣는다.
   * 지문은 맞는데도 거절해야, 자료와 근거의 규칙이 실제로 살아 있는 것이다.
   */
  const resealed = async (mutate: (value: Record<string, unknown>) => void) => {
    const value = await stored();
    mutate(value);

    const handoff = value as unknown as BiblicalResearchHandoff;
    value.evidenceSetHash = await computeBiblicalResearchEvidenceSetHash({
      brief: handoff.brief,
      sources: handoff.sources,
      sourceUnresolvedQuestions: handoff.sourceUnresolvedQuestions,
    });

    return value;
  };

  const firstSource = (value: Record<string, unknown>) =>
    (value.sources as Record<string, unknown>[])[0] as Record<string, unknown>;
  const firstClaim = (value: Record<string, unknown>) =>
    (firstSource(value).evidenceClaims as Record<string, unknown>[])[0] as Record<string, unknown>;

  const cases: [string, (value: Record<string, unknown>) => void][] = [
    ['근거 문장이 너무 짧다', (value) => {
      firstClaim(value).statement = '짧다';
    }],
    ['근거 용도가 그 자료의 것이 아니다', (value) => {
      firstClaim(value).intendedUse = 'pastoral_safety';
    }],
    ['주해 근거에 본문 위치가 없다', (value) => {
      firstClaim(value).passageReferences = [];
    }],
    ['성경에 없는 본문 위치다', (value) => {
      firstClaim(value).passageReferences = [
        { book: 'Psalms', chapter: 999, startVerse: 1, endVerse: 1 },
      ];
    }],
    ['근거 번호가 다른 자료의 것이다', (value) => {
      firstClaim(value).evidenceId = `${sourceId(1)}:e1`;
    }],
    ['근거 번호의 차례가 어긋난다', (value) => {
      firstClaim(value).evidenceId = `${firstSource(value).sourceId as string}:e2`;
    }],
    ['자료 id가 주소에서 만든 값이 아니다', (value) => {
      const source = firstSource(value);
      const forged = `src_${'f'.repeat(64)}`;
      const claims = source.evidenceClaims as Record<string, unknown>[];
      claims.forEach((claim, index) => {
        (claim as Record<string, unknown>).evidenceId = `${forged}:e${index + 1}`;
      });
      source.sourceId = forged;
    }],
    ['자료 수가 모자란다', (value) => {
      value.sources = [(value.sources as unknown[])[0]];
    }],
    ['근거가 하나도 없다', (value) => {
      firstSource(value).evidenceClaims = [];
    }],
    ['확인 수준이 올바르지 않다', (value) => {
      firstSource(value).accessLevel = 'metadata_only';
    }],
    ['사용자 정보가 섞여 들어왔다', (value) => {
      firstClaim(value).rawSituation = '요즘 생계가 어렵습니다';
    }],
  ];

  for (const [label, mutate] of cases) {
    it(`지문이 맞아도 거절한다 — ${label}`, async () => {
      const value = await resealed(mutate);

      // 지문이 정말 맞는지 먼저 확인한다. 그래야 이 시험이 뜻을 갖는다.
      const handoff = value as unknown as BiblicalResearchHandoff;
      const recomputed = await computeBiblicalResearchEvidenceSetHash({
        brief: handoff.brief,
        sources: handoff.sources,
        sourceUnresolvedQuestions: handoff.sourceUnresolvedQuestions,
      });
      assert.equal(recomputed, value.evidenceSetHash, label);

      assert.equal((await validateBiblicalResearchHandoff(value)).valid, false, label);
    });
  }
});

describe('꾸러미 다시 확인 · D3. 모양이 어긋나도 터지지 않는다', () => {
  /**
   * 표에서 나온 값은 이름 없는 값이다. 어떤 모양이든 올 수 있다.
   *
   * 그때 오류로 끝나면 그 위층은 "확인에 실패했다"와
   * "코드가 터졌다"를 구분할 수 없게 된다.
   * 어떤 값이 와도 답은 "쓸 수 없다" 하나여야 한다.
   */
  const first = (value: Record<string, unknown>) =>
    (value.sources as Record<string, unknown>[])[0] as Record<string, unknown>;
  const claim = (value: Record<string, unknown>) =>
    (first(value).evidenceClaims as Record<string, unknown>[])[0] as Record<string, unknown>;

  const cases: [string, (value: Record<string, unknown>) => void][] = [
    ['근거 목록이 없다', (value) => {
      delete first(value).evidenceClaims;
    }],
    ['근거 목록이 객체다', (value) => {
      first(value).evidenceClaims = {};
    }],
    ['근거 목록이 문자열이다', (value) => {
      first(value).evidenceClaims = '문자열';
    }],
    ['용도가 숫자다', (value) => {
      first(value).intendedUse = 42;
    }],
    ['본문 위치가 객체다', (value) => {
      claim(value).passageReferences = {};
    }],
    ['본문 위치가 빈 값이다', (value) => {
      claim(value).passageReferences = null;
    }],
    ['본문 위치가 문자열이다', (value) => {
      claim(value).passageReferences = '문자열';
    }],
    ['제목이 없다', (value) => {
      delete first(value).title;
    }],
    ['자료 id가 없다', (value) => {
      delete first(value).sourceId;
    }],
    ['자료가 빈 값이다', (value) => {
      (value.sources as unknown[])[0] = null;
    }],
    ['근거 한 조각이 문자열이다', (value) => {
      (first(value).evidenceClaims as unknown[])[0] = '문자열';
    }],
    ['자료 목록이 빈 값이다', (value) => {
      value.sources = null;
    }],
  ];

  for (const [label, mutate] of cases) {
    it(`터지지 않고 거절한다 — ${label}`, async () => {
      const value = await stored();
      mutate(value);

      // 오류로 끝나면 이 자리에서 시험이 실패한다.
      const checked = await validateBiblicalResearchHandoff(value);
      assert.equal(checked.valid, false, label);
    });
  }

  it('자료 한 건의 어느 자리에 무엇이 들어와도 터지지 않는다', async () => {
    const hostile: unknown[] = [
      undefined, null, 0, -1, 1.5, true, false, '', '문자열', [], {}, [null], [{}], { a: 1 },
    ];

    const base = await stored();
    // 자료 한 건 안의 모든 자리를 모은다.
    const paths: string[][] = [];
    const walk = (node: unknown, path: string[]) => {
      paths.push(path);
      if (Array.isArray(node)) node.forEach((child, index) => walk(child, [...path, String(index)]));
      else if (node !== null && typeof node === 'object') {
        for (const key of Object.keys(node)) walk((node as Record<string, unknown>)[key], [...path, key]);
      }
    };
    walk((base.sources as unknown[])[0], []);
    assert.ok(paths.length > 15, `자리가 너무 적습니다 (${paths.length})`);

    for (const path of paths) {
      for (const bad of hostile) {
        const value = await stored();
        let node = (value.sources as Record<string, unknown>[])[0] as Record<string, unknown>;

        if (path.length === 0) {
          (value.sources as unknown[])[0] = bad;
        } else {
          for (const key of path.slice(0, -1)) node = node[key] as Record<string, unknown>;
          const last = path[path.length - 1] as string;
          if (bad === undefined) delete node[last];
          else node[last] = bad;
        }

        // 터지면 여기서 시험이 실패한다. 답은 언제나 "쓸 수 없다" 하나다.
        const checked = await validateBiblicalResearchHandoff(value);
        assert.equal(checked.valid, false, `${path.join('.')} = ${JSON.stringify(bad) ?? 'undefined'}`);
      }
    }
  });

  it('앞의 검사가 이미 거절했으면 더 내려가지 않는다', async () => {
    // 모양부터 어긋난 값을 깊은 검사에 내려보내지 않는다.
    // 내려보내면 오류가 나고, 그것을 붙잡아 답을 만들게 된다.
    // 만드는 쪽도 같은 자리에서 멈춘다.
    const value = await stored();
    delete ((value.sources as Record<string, unknown>[])[0] as Record<string, unknown>)
      .evidenceClaims;

    const checked = await validateBiblicalResearchHandoff(value);
    assert.equal(checked.valid, false);
    if (checked.valid) return;

    // 붙잡아 만든 사유가 섞여 있으면 깊은 검사까지 내려간 것이다.
    assert.equal(
      checked.errors.some((error) => error.includes('자료의 모양이 약속과 다릅니다')),
      false,
      checked.errors.join(' / '),
    );
    assert.ok(checked.errors.length > 0);
  });

  it('오류 문구를 옮겨 담지 않는다', async () => {
    const value = await stored();
    ((value.sources as Record<string, unknown>[])[0] as Record<string, unknown>).intendedUse = 42;

    const checked = await validateBiblicalResearchHandoff(value);
    assert.equal(checked.valid, false);
    if (checked.valid) return;
    for (const error of checked.errors) {
      for (const banned of ['TypeError', 'is not', 'undefined', 'Cannot read', 'at ', '.map']) {
        assert.equal(error.includes(banned), false, `${banned} :: ${error}`);
      }
    }
  });
});

describe('꾸러미 다시 확인 · E. 지문을 다시 계산한다', () => {
  it('적혀 있는 지문을 그대로 믿지 않는다', async () => {
    const checked = await afterChange((value) => {
      const hash = value.evidenceSetHash as string;
      // 한 글자만 바꾼다.
      value.evidenceSetHash = hash.slice(0, -1) + (hash.endsWith('a') ? 'b' : 'a');
    });
    assert.equal(checked.valid, false);
  });

  it('지문의 모양이 다르면 거절한다', async () => {
    for (const bad of [
      '',
      'evset_',
      'a'.repeat(64),
      `evset_${'A'.repeat(64)}`,
      `evset_${'a'.repeat(63)}`,
      `hash_${'a'.repeat(64)}`,
    ]) {
      const checked = await afterChange((value) => {
        value.evidenceSetHash = bad;
      });
      assert.equal(checked.valid, false, bad);
    }
  });

  it('지문이 묶는 값을 바꾸면 거절한다', async () => {
    const mutations: [string, (value: Record<string, unknown>) => void][] = [
      ['brief.evidenceVersion', (value) => {
        (value.brief as Record<string, unknown>).evidenceVersion = 5;
      }],
      ['brief.prioritizerSnapshotId', (value) => {
        (value.brief as Record<string, unknown>).prioritizerSnapshotId = `snap_${'b'.repeat(64)}`;
      }],
      ['source.title', (value) => {
        ((value.sources as Record<string, unknown>[])[0] as Record<string, unknown>).title =
          '다른 제목';
      }],
      ['source.publisherOrInstitution', (value) => {
        ((value.sources as Record<string, unknown>[])[0] as Record<string, unknown>)
          .publisherOrInstitution = 'Another Academic Press';
      }],
      ['source.publicationYear', (value) => {
        ((value.sources as Record<string, unknown>[])[0] as Record<string, unknown>)
          .publicationYear = 2001;
      }],
      ['evidence.statement', (value) => {
        const claims = ((value.sources as Record<string, unknown>[])[0] as Record<string, unknown>)
          .evidenceClaims as Record<string, unknown>[];
        (claims[0] as Record<string, unknown>).statement =
          `${STATEMENT} 그리고 여기에 없던 문장을 덧붙였습니다.`;
      }],
      ['sourceUnresolvedQuestions', (value) => {
        value.sourceUnresolvedQuestions = ['다른 물음으로 바꾸었습니다'];
      }],
      ['sourceUnresolvedQuestions 순서', (value) => {
        value.sourceUnresolvedQuestions = [
          ...(value.sourceUnresolvedQuestions as string[]),
        ].reverse();
      }],
    ];

    for (const [label, mutate] of mutations) {
      const checked = await afterChange(mutate);
      assert.equal(checked.valid, false, label);
    }
  });

  it('지문을 만들 때 쓴 그 함수로 다시 센다', async () => {
    const value = await stored();
    const handoff = value as unknown as BiblicalResearchHandoff;
    const recomputed = await computeBiblicalResearchEvidenceSetHash({
      brief: handoff.brief,
      sources: handoff.sources,
      sourceUnresolvedQuestions: handoff.sourceUnresolvedQuestions,
    });
    assert.equal(recomputed, handoff.evidenceSetHash);
  });
});

describe('꾸러미 다시 확인 · F. 고치지 않는다', () => {
  it('공백을 다듬거나 정렬하거나 채우지 않는다', async () => {
    const code = stripComments(read(HANDOFF));
    const body = code.split('export async function validateBiblicalResearchHandoff')[1] ?? '';
    // 값을 바꾸는 일을 하지 않는다.
    for (const banned of ['.trim()', '.sort(', 'toLowerCase', 'toUpperCase', '??=', '||=', '??']) {
      assert.equal(body.includes(banned), false, banned);
    }
    // 받은 꾸러미의 어느 자리에도 값을 써 넣지 않는다.
    assert.equal(/\bvalue\.[a-zA-Z]+ =/.test(body), false);
    assert.equal(/handoff\.[a-zA-Z]+ =/.test(body), false);
  });

  it('어긋난 꾸러미를 고쳐서 통과시키지 않는다', async () => {
    const checked = await afterChange((value) => {
      const source = (value.sources as Record<string, unknown>[])[0] as Record<string, unknown>;
      source.title = `  ${source.title as string}  `;
    });
    // 제목이 바뀌었으므로 지문이 맞지 않는다. 다듬어서 맞추지 않는다.
    assert.equal(checked.valid, false);
  });

  it('지금 카드가 다루는 영역과 견주지 않는다', () => {
    const code = stripComments(read(HANDOFF));
    for (const banned of [
      'getActiveCoveredDomains',
      'computeActiveCoveredHash',
      'activeCoveredHash',
      'currentActiveCoveredHash',
      'consumeBiblicalResearchHandoff',
      'biblical-research-handoff-store',
    ]) {
      assert.equal(code.includes(banned), false, banned);
    }
  });

  it('바깥과 닿지 않는다', () => {
    const code = stripComments(read(HANDOFF));
    for (const banned of ['fetch(', 'Deno.env', 'process.env', 'createClient', 'console.']) {
      assert.equal(code.includes(banned), false, banned);
    }
  });

  it('새 규칙을 여기에 적지 않는다', () => {
    const code = stripComments(read(HANDOFF));
    // 자료와 근거의 규칙은 이미 있는 검사기가 본다.
    assert.ok(code.includes('validateSourceHarvestResult('));
    assert.ok(code.includes('checkVerificationDraftSource('));
    assert.ok(code.includes('buildSourceHarvestBrief('));
    assert.ok(code.includes('computeBiblicalResearchEvidenceSetHash('));
    // 지문 계산 방식을 다시 적지 않는다.
    assert.equal((code.match(/crypto\.subtle/g) || []).length, 1);
    assert.equal((code.match(/function canonicalize/g) || []).length, 1);
  });
});

describe('꾸러미 다시 확인 · G. 만드는 쪽이 바뀌지 않았다', () => {
  it('만든 꾸러미는 언제나 다시 확인을 통과한다', async () => {
    const outcome = await build();
    assert.equal(outcome.ok, true);
    if (!outcome.ok) return;
    const checked = await validateBiblicalResearchHandoff(outcome.handoff);
    assert.equal(checked.valid, true, checked.valid ? '' : checked.errors.join(' / '));
  });

  it('보관소를 알지 못한다', () => {
    const code = stripComments(read(HANDOFF));
    assert.equal(code.includes('handoffId'), false);
    assert.equal(code.includes('p_handoff'), false);
  });
});
