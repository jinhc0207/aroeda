/**
 * 연구 근거를 남기는가 · 테스트
 *
 * 실행: npm test
 *
 * 왜 필요한가:
 *   최종 결과에 자료의 신원(제목·저자·주소)만 있고 내용이 하나도 없었다.
 *   그대로 두면 다음 단계(성경 연구)가 제목만 보고 "이 자료는 이렇게 말한다"를
 *   지어내야 한다. 그래서 실제로 연 페이지에서 관찰한 것을 짧게 남기게 했다.
 *
 * 이것이 무엇이 아닌지도 함께 고정한다.
 *   서버는 이 문장이 원문의 뜻을 옳게 옮겼는지 검증하지 않는다. 대조할 원문이 없다.
 *   서버가 보증하는 것은 모양과 경계와 묶임까지다.
 *
 * 실제 웹 검색과 OpenAI 호출은 하지 않는다.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import {
  EVIDENCE_CLAIM_DRAFT_SCHEMA,
  EVIDENCE_CLAIM_MAX,
  EVIDENCE_CLAIM_MIN,
  EVIDENCE_DRAFT_FIELDS,
  EVIDENCE_PASSAGE_MAX,
  EVIDENCE_STATEMENT_MAX,
  EVIDENCE_STATEMENT_MIN,
  INTENDED_USES,
  PASSAGE_REFERENCE_SCHEMA,
  SOURCE_HARVEST_SCHEMA,
  VERIFICATION_DRAFT_SOURCE_FIELDS,
} from '../../supabase/functions/_shared/source-harvest-contract.ts';
import {
  buildSourceHarvestDraftSchema,
  buildDiscoveryPayload,
  buildVerificationPayload,
} from '../../supabase/functions/_shared/source-harvester-execution-contract.ts';
import {
  checkVerificationDraftSource,
} from '../../supabase/functions/_shared/verification-draft-source.ts';
import {
  materializeHarvestResult,
  validateHarvestDraft,
  type SourceHarvestDraftResult,
  type VerifiedSourceDraft,
} from '../../supabase/functions/_shared/source-harvester-execution.ts';
import {
  buildSourceHarvestBrief,
  validateSourceHarvestResult,
} from '../../supabase/functions/_shared/source-harvester.ts';
import { getActiveCoveredDomains } from '../../supabase/functions/_shared/research-prioritizer-edge.ts';

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
const stripComments = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '');

const CONTRACT = '../../supabase/functions/_shared/source-harvester-execution-contract.ts';
const EXECUTION = '../../supabase/functions/_shared/source-harvester-execution.ts';

const url = (index: number) => `https://sources.example.org/aroeda/fixture-${index}`;
const urls = (count: number) => Array.from({ length: count }, (_, index) => url(index));

const brief = () =>
  buildSourceHarvestBrief({
    targetDomain: 'financial_hardship',
    evidenceVersion: 4,
    prioritizerSnapshotId: `snap_${'a'.repeat(64)}`,
    activeCoveredDomains: getActiveCoveredDomains(),
  });

const PSALM = { book: 'Psalms', chapter: 42, startVerse: 5, endVerse: 5 };
const STATEMENT = '이 주석은 본문의 반복되는 자기 권면을 절망의 부정이 아니라 신뢰 회복의 움직임으로 읽는다.';

const claim = (overrides: Record<string, unknown> = {}) => ({
  intendedUse: 'exegesis',
  statement: STATEMENT,
  passageReferences: [{ ...PSALM }],
  ...overrides,
});

/** 규칙을 모두 지킨 자료 한 건 */
const source = (overrides: Record<string, unknown> = {}) => ({
  sourceType: 'commentary',
  title: '재정 어려움 본문 주석',
  authorOrOrganization: '연구자',
  publisherOrInstitution: 'Fixture Academic Press',
  publicationYear: 2015,
  url: url(0),
  accessLevel: 'full_text',
  intendedUse: ['exegesis'],
  relevanceNote: '이 영역의 문맥을 확인하는 데 필요합니다.',
  evidenceClaims: [claim()],
  ...overrides,
});

const issuesOf = (overrides: Record<string, unknown> = {}) =>
  checkVerificationDraftSource(source(overrides));

/* ------------------------------------------------------------------ */

describe('연구 근거 · A. 응답 구조', () => {
  it('자료 한 건에 근거 자리가 있다', () => {
    const item = buildSourceHarvestDraftSchema(urls(2)).properties as Record<string, never>;
    const sourceItem = (item.sources as unknown as { items: { properties: Record<string, unknown>; required: string[] } })
      .items;

    assert.ok('evidenceClaims' in sourceItem.properties);
    assert.ok(sourceItem.required.includes('evidenceClaims'));
    assert.deepEqual(sourceItem.required, [...VERIFICATION_DRAFT_SOURCE_FIELDS]);
  });

  it('근거 한 조각의 항목은 정확히 셋이고 그 밖은 막는다', () => {
    const claims = evidenceSchema();
    assert.deepEqual(Object.keys(claims.items.properties).sort(), [...EVIDENCE_DRAFT_FIELDS].sort());
    assert.deepEqual(claims.items.required, [...EVIDENCE_DRAFT_FIELDS]);
    assert.equal(claims.items.additionalProperties, false);
    // 번호는 서버가 붙인다. 응답 구조에 자리가 없다.
    assert.equal('evidenceId' in claims.items.properties, false);
  });

  it('개수와 길이 상한이 계약과 같다', () => {
    const claims = evidenceSchema();
    assert.equal(claims.maxItems, EVIDENCE_CLAIM_MAX);
    assert.equal(claims.items.properties.statement.maxLength, EVIDENCE_STATEMENT_MAX);
    assert.equal(claims.items.properties.passageReferences.maxItems, EVIDENCE_PASSAGE_MAX);
  });

  it('용도 목록은 canonical 목록을 그대로 쓴다', () => {
    const claims = evidenceSchema();
    assert.deepEqual(claims.items.properties.intendedUse.enum, [...INTENDED_USES]);

    // 목록을 손으로 다시 적지 않았다.
    const contract = stripComments(read(CONTRACT));
    assert.ok(contract.includes('enum: [...INTENDED_USES]'));
  });

  it('본문 위치는 네 값으로 적는다', () => {
    const passage = evidenceSchema().items.properties.passageReferences.items!;
    assert.deepEqual(Object.keys(passage.properties).sort(), [
      'book',
      'chapter',
      'endVerse',
      'startVerse',
    ]);
    assert.equal(passage.additionalProperties, false);
  });
});

function evidenceSchema() {
  const schema = buildSourceHarvestDraftSchema(urls(2)) as unknown as {
    properties: { sources: { items: { properties: Record<string, unknown> } } };
  };
  return schema.properties.sources.items.properties.evidenceClaims as unknown as {
    maxItems: number;
    items: {
      // 안쪽 모양은 시험에서 직접 읽는다. 계약 타입을 여기서 다시 적지 않는다.
      properties: Record<string, { maxLength?: number; maxItems?: number; enum?: string[]; items?: {
        properties: Record<string, unknown>;
        additionalProperties: boolean;
      } }>;
      required: string[];
      additionalProperties: boolean;
    };
  };
}

describe('연구 근거 · B. 1단계는 근거를 요구하지 않는다', () => {
  it('1단계는 구조화 응답을 아예 쓰지 않는다', () => {
    const discovery = buildDiscoveryPayload({
      targetDomain: 'financial_hardship',
      domainDescription: '생계와 경제적 어려움',
    });

    // 응답 형식을 정하지 않으므로 근거를 적을 자리 자체가 없다.
    assert.equal('text' in discovery, false);
    assert.equal(JSON.stringify(discovery).includes('evidenceClaims'), false);
  });

  it('1단계 지시문은 근거를 적으라고 하지 않는다', () => {
    const discovery = buildDiscoveryPayload({
      targetDomain: 'financial_hardship',
      domainDescription: '생계와 경제적 어려움',
    });
    assert.equal((discovery.instructions as string).includes('evidenceClaims'), false);
  });

  it('초안을 검사하는 곳은 모두 2단계다', () => {
    // 그래서 근거를 조건 없이 요구해도 1단계에 허위 근거를 강요하지 않는다.
    for (const path of [
      '../../supabase/functions/_shared/source-harvester-execution.ts',
      '../../supabase/functions/_shared/source-harvester-parallel-recovery-execution.ts',
      '../../supabase/functions/_shared/source-harvester-recovery-execution.ts',
    ]) {
      const code = stripComments(read(path));
      if (!code.includes('validateHarvestDraft(')) continue;
      // 1단계 응답을 초안 검사에 넣는 자리가 없다.
      assert.equal(code.includes('validateHarvestDraft(discoveryResponse'), false, path);
    }
    const execution = stripComments(read(EXECUTION));
    assert.ok(execution.includes('validateHarvestDraft(parsed.draft, brief)'));
  });
});

describe('연구 근거 · C·D. 근거가 없으면 채택할 수 없다', () => {
  it('근거가 없으면 거절한다', () => {
    assert.ok(issuesOf({ evidenceClaims: [] }).includes('evidence_count_invalid'));
  });

  it('근거가 배열이 아니면 거절한다', () => {
    for (const bad of [null, undefined, 'x', 42, {}]) {
      assert.ok(issuesOf({ evidenceClaims: bad }).includes('evidence_not_array'), String(bad));
    }
  });

  it('최대 개수를 넘으면 거절한다', () => {
    const many = Array.from({ length: EVIDENCE_CLAIM_MAX + 1 }, () => claim());
    assert.ok(issuesOf({ evidenceClaims: many }).includes('evidence_count_invalid'));
  });

  it('1개에서 최대 개수까지는 통과한다', () => {
    for (let count = EVIDENCE_CLAIM_MIN; count <= EVIDENCE_CLAIM_MAX; count += 1) {
      const claims = Array.from({ length: count }, () => claim());
      assert.deepEqual(issuesOf({ evidenceClaims: claims }), [], String(count));
    }
  });

  it('두 경로가 같은 규칙을 쓴다', () => {
    // Request A와 Request B 모두 이 한 함수를 통과한다.
    const execution = stripComments(read(EXECUTION));
    assert.ok(execution.includes('isValidVerificationDraftSource(entry)'));

    const parallel = stripComments(
      read('../../supabase/functions/_shared/source-harvester-parallel-recovery-execution.ts'),
    );
    assert.ok(parallel.includes('validateHarvestDraft(read.draft, brief)'));

    // 그리고 두 경로가 같은 응답 구조를 쓴다.
    const single = stripComments(
      read('../../supabase/functions/_shared/source-harvester-single-inspection-contract.ts'),
    );
    assert.ok(single.includes('buildSourceHarvestDraftSchema([targetUrl])'));
  });
});

describe('연구 근거 · E. 자료가 가진 용도만 쓸 수 있다', () => {
  it('그 자료에 없는 용도로 근거를 달면 거절한다', () => {
    const issues = issuesOf({
      sourceType: 'professional_context',
      intendedUse: ['pastoral_safety', 'real_world_context'],
      evidenceClaims: [claim({ intendedUse: 'exegesis' })],
    });
    assert.ok(issues.includes('evidence_use_not_in_source'));
  });

  it('그 자료가 가진 용도면 통과한다', () => {
    assert.deepEqual(
      issuesOf({
        sourceType: 'professional_context',
        intendedUse: ['pastoral_safety', 'real_world_context'],
        evidenceClaims: [claim({ intendedUse: 'real_world_context', passageReferences: [] })],
      }),
      [],
    );
  });

  it('모르는 용도는 거절한다', () => {
    for (const bad of ['exegesis_v2', '', null, 42]) {
      assert.ok(
        issuesOf({ evidenceClaims: [claim({ intendedUse: bad })] }).includes('evidence_use_invalid'),
        String(bad),
      );
    }
  });

  it('근거로 자료 정책을 우회할 수 없다', () => {
    // 목회 보조자료는 주해 용도를 가질 수 없다. 근거로도 그 문을 열 수 없다.
    const issues = issuesOf({
      sourceType: 'pastoral_resource',
      intendedUse: ['pastoral_application'],
      evidenceClaims: [claim({ intendedUse: 'exegesis' })],
    });
    assert.ok(issues.includes('evidence_use_not_in_source'));
  });
});

describe('연구 근거 · 문장과 본문 위치', () => {
  it('너무 짧으면 거절한다', () => {
    for (const short of ['', '   ', '짧다', 'ㄱ'.repeat(EVIDENCE_STATEMENT_MIN - 1)]) {
      assert.ok(
        issuesOf({ evidenceClaims: [claim({ statement: short })] }).includes(
          'evidence_statement_too_short',
        ),
        JSON.stringify(short),
      );
    }
  });

  it('너무 길면 거절한다', () => {
    const long = 'ㄱ'.repeat(EVIDENCE_STATEMENT_MAX + 1);
    assert.ok(
      issuesOf({ evidenceClaims: [claim({ statement: long })] }).includes(
        'evidence_statement_too_long',
      ),
    );
  });

  it('경계 길이는 통과한다', () => {
    for (const length of [EVIDENCE_STATEMENT_MIN, EVIDENCE_STATEMENT_MAX]) {
      assert.deepEqual(
        issuesOf({ evidenceClaims: [claim({ statement: 'ㄱ'.repeat(length) })] }),
        [],
        String(length),
      );
    }
  });

  it('성경에 없는 본문 위치는 거절한다', () => {
    const bad = [
      { book: 'Psalmss', chapter: 42, startVerse: 5, endVerse: 5 },
      { book: 'Psalms', chapter: 999, startVerse: 1, endVerse: 1 },
      { book: 'Psalms', chapter: 42, startVerse: 0, endVerse: 1 },
      'Psalms 42',
      null,
    ];
    for (const reference of bad) {
      assert.ok(
        issuesOf({ evidenceClaims: [claim({ passageReferences: [reference] })] }).includes(
          'evidence_passages_invalid',
        ),
        JSON.stringify(reference),
      );
    }
  });

  it('본문 위치 규칙을 새로 적지 않았다', () => {
    const validator = stripComments(
      read('../../supabase/functions/_shared/verification-draft-source.ts'),
    );
    assert.ok(validator.includes('checkBibleReference(reference)'));
    // 성경 책 목록이나 장·절 규칙을 여기서 다시 만들지 않는다.
    assert.equal(/BIBLE_REFERENCE_INDEX|Genesis|Psalms/.test(validator), false);
  });

  it('같은 위치를 두 번 적으면 거절한다', () => {
    assert.ok(
      issuesOf({
        evidenceClaims: [claim({ passageReferences: [{ ...PSALM }, { ...PSALM }] })],
      }).includes('evidence_passages_duplicated'),
    );
  });

  it('본문 위치가 너무 많으면 거절한다', () => {
    const many = Array.from({ length: EVIDENCE_PASSAGE_MAX + 1 }, (_, index) => ({
      book: 'Psalms',
      chapter: 42,
      startVerse: index + 1,
      endVerse: index + 1,
    }));
    assert.ok(
      issuesOf({ evidenceClaims: [claim({ passageReferences: many })] }).includes(
        'evidence_passages_too_many',
      ),
    );
  });

  it('주해 근거는 어느 본문인지 밝혀야 한다', () => {
    assert.ok(
      issuesOf({ evidenceClaims: [claim({ passageReferences: [] })] }).includes(
        'evidence_exegesis_needs_passage',
      ),
    );
  });

  it('주해가 아닌 근거는 본문 위치가 없어도 된다', () => {
    assert.deepEqual(
      issuesOf({
        sourceType: 'biblical_theology',
        intendedUse: ['doctrinal_context'],
        evidenceClaims: [claim({ intendedUse: 'doctrinal_context', passageReferences: [] })],
      }),
      [],
    );
  });
});

describe('연구 근거 · F. 원문을 담는 통로가 되지 않는다', () => {
  const draftWith = (claims: unknown[]): unknown => {
    const base = brief();
    return {
      targetDomain: base.targetDomain,
      evidenceVersion: base.evidenceVersion,
      prioritizerSnapshotId: base.prioritizerSnapshotId,
      sources: [source({ evidenceClaims: claims })],
      rejectedSources: [],
      unresolvedSourceQuestions: [],
    };
  };

  it('원문을 담으려는 이름은 근거 안에서도 막힌다', () => {
    for (const key of ['quote', 'excerpt', 'rawHtml', 'content', 'snippet', 'fullText', 'body']) {
      const checked = validateHarvestDraft(draftWith([claim({ [key]: '원문' })]), brief());
      assert.equal(checked.ok, false, key);
      if (checked.ok) return;
      // 기존 금지 검사가 깊이와 상관없이 잡는다.
      assert.equal(checked.diagnostic, 'verification_invalid_banned_field', key);
    }
  });

  it('모델이 번호를 붙이면 거절한다', () => {
    const checked = validateHarvestDraft(draftWith([claim({ evidenceId: 'src_x:e1' })]), brief());
    assert.equal(checked.ok, false);
    if (checked.ok) return;
    assert.equal(checked.diagnostic, 'verification_invalid_banned_field');
  });

  it('모르는 항목은 거절한다', () => {
    assert.ok(
      issuesOf({ evidenceClaims: [claim({ nickname: 'x' })] }).includes('evidence_unknown_field'),
    );
  });

  it('항목이 빠지면 거절한다', () => {
    for (const key of EVIDENCE_DRAFT_FIELDS) {
      const partial = claim() as Record<string, unknown>;
      delete partial[key];
      assert.ok(
        issuesOf({ evidenceClaims: [partial] }).includes('evidence_missing_field'),
        key,
      );
    }
  });

  it('기존 원문 금지 목록을 약화하지 않았다', () => {
    const execution = stripComments(read(EXECUTION));
    const banned = execution.split('const BANNED_DRAFT_FIELDS = [')[1].split('];')[0];

    for (const name of [
      'rawhtml',
      'html',
      'pagecontent',
      'content',
      'body',
      'snippet',
      'summary',
      'excerpt',
      'quote',
      'quotes',
      'quotation',
      'fulltext',
      'text',
    ]) {
      assert.ok(banned.includes(`'${name}'`), name);
    }
    // 그리고 번호가 새로 막혔다.
    assert.ok(banned.includes("'evidenceid'"));
  });
});

describe('연구 근거 · G. 번호는 서버가 붙인다', () => {
  const materialize = async (claims: unknown[]) => {
    const base = brief();
    const draft = {
      targetDomain: base.targetDomain,
      evidenceVersion: base.evidenceVersion,
      prioritizerSnapshotId: base.prioritizerSnapshotId,
      // 채택 최소 수를 채운다. 근거 변형은 첫 자료에만 준다.
      sources: [
        source({ evidenceClaims: claims }),
        source({ url: url(1), sourceType: 'biblical_theology', intendedUse: ['biblical_theology'],
          publisherOrInstitution: 'Fixture University Press',
          evidenceClaims: [claim({ intendedUse: 'biblical_theology', passageReferences: [] })] }),
        source({ url: url(2), sourceType: 'academic_article', intendedUse: ['exegesis'],
          publisherOrInstitution: 'Fixture Journal' }),
        source({ url: url(3), sourceType: 'pastoral_resource', intendedUse: ['pastoral_application'],
          publisherOrInstitution: 'Fixture Seminary',
          evidenceClaims: [claim({ intendedUse: 'pastoral_application', passageReferences: [] })] }),
        source({ url: url(4), sourceType: 'scholarly_institution', intendedUse: ['exegesis'],
          publisherOrInstitution: 'Fixture Institute' }),
      ],
      rejectedSources: [],
      unresolvedSourceQuestions: [],
    } as unknown as SourceHarvestDraftResult;

    return await materializeHarvestResult({
      brief: base,
      draft,
      discoveredUrls: urls(10),
      evidence: {
        searchSourceUrls: urls(10),
        inspectedUrls: urls(5),
        citedUrls: [],
        rawObservedUrls: urls(10),
      },
      now: () => new Date('2026-09-02T00:00:00.000Z'),
    });
  };

  it('번호가 자료 id와 순서에서 만들어진다', async () => {
    const outcome = await materialize([claim(), claim({ statement: 'ㄱ'.repeat(50) })]);
    assert.notEqual(outcome.status, 'recheck');
    if (outcome.status !== 'ready') return;

    const [first] = outcome.result.sources;
    assert.equal(first.evidenceClaims.length, 2);
    assert.equal(first.evidenceClaims[0].evidenceId, `${first.sourceId}:e1`);
    assert.equal(first.evidenceClaims[1].evidenceId, `${first.sourceId}:e2`);
  });

  it('한 결과 안에서 번호가 겹치지 않는다', async () => {
    const outcome = await materialize([claim(), claim({ statement: 'ㄴ'.repeat(50) })]);
    if (outcome.status !== 'ready') return;

    const ids = outcome.result.sources.flatMap((entry) =>
      entry.evidenceClaims.map((item) => item.evidenceId),
    );
    assert.equal(new Set(ids).size, ids.length);
  });

  it('같은 초안이면 같은 번호가 나온다', async () => {
    const first = await materialize([claim()]);
    const second = await materialize([claim()]);
    if (first.status !== 'ready' || second.status !== 'ready') return;

    assert.deepEqual(
      first.result.sources[0].evidenceClaims.map((item) => item.evidenceId),
      second.result.sources[0].evidenceClaims.map((item) => item.evidenceId),
    );
  });

  it('문장은 모델이 쓴 그대로 둔다', async () => {
    const outcome = await materialize([claim()]);
    if (outcome.status !== 'ready') return;

    const stored = outcome.result.sources[0].evidenceClaims[0];
    assert.equal(stored.statement, STATEMENT);
    assert.deepEqual(stored.passageReferences, [PSALM]);
    assert.equal(stored.intendedUse, 'exegesis');
  });

  it('자료 id와 확인 날짜의 주인은 그대로다', async () => {
    const outcome = await materialize([claim()]);
    if (outcome.status !== 'ready') return;

    const stored = outcome.result.sources[0];
    assert.match(stored.sourceId, /^src_[0-9a-f]{64}$/);
    assert.equal(stored.accessedAt, '2026-09-02');
  });

  it('번호를 붙이는 곳은 한 곳뿐이다', () => {
    const execution = stripComments(read(EXECUTION));
    assert.equal((execution.match(/materializeEvidenceClaims\(/g) || []).length, 2);
    assert.ok(execution.includes('`${sourceId}:e${index + 1}`'));
  });
});

describe('연구 근거 · H. 최종 결과 검사', () => {
  const finalSource = (overrides: Record<string, unknown> = {}) => ({
    sourceId: `src_${'a'.repeat(64)}`,
    sourceType: 'commentary',
    title: '재정 어려움 본문 주석',
    authorOrOrganization: '연구자',
    publisherOrInstitution: 'Fixture Academic Press',
    publicationYear: 2015,
    url: url(0),
    accessedAt: '2026-09-02',
    accessLevel: 'full_text',
    intendedUse: ['exegesis'],
    relevanceNote: '이 영역의 문맥을 확인하는 데 필요합니다.',
    evidenceClaims: [{ ...claim(), evidenceId: `src_${'a'.repeat(64)}:e1` }],
    ...overrides,
  });

  const validateOne = async (overrides: Record<string, unknown> = {}) => {
    const base = brief();
    return await validateSourceHarvestResult(
      {
        targetDomain: base.targetDomain,
        evidenceVersion: base.evidenceVersion,
        prioritizerSnapshotId: base.prioritizerSnapshotId,
        sources: [finalSource(overrides)],
        rejectedSources: [],
        unresolvedSourceQuestions: [],
      },
      base,
    );
  };

  it('근거가 비어 있으면 최종 검사에서 걸린다', async () => {
    const outcome = await validateOne({ evidenceClaims: [] });
    assert.equal(outcome.valid, false);
    assert.ok(outcome.errors.some((error) => error.includes('연구 근거는')));
  });

  it('서버가 붙이지 않은 번호는 걸린다', async () => {
    const outcome = await validateOne({
      evidenceClaims: [{ ...claim(), evidenceId: 'made-up' }],
    });
    assert.equal(outcome.valid, false);
    assert.ok(outcome.errors.some((error) => error.includes('번호가 서버가 붙인 것과 다릅니다')));
  });

  it('근거 안에 모르는 항목이 있으면 걸린다', async () => {
    const outcome = await validateOne({
      evidenceClaims: [
        { ...claim(), evidenceId: `src_${'a'.repeat(64)}:e1`, quote: '원문' },
      ],
    });
    assert.equal(outcome.valid, false);
  });
});

describe('연구 근거 · I. 두 경로의 결과 모양이 같다', () => {
  it('최종 자료 한 건의 항목이 한 곳에서만 정의된다', () => {
    const harvester = stripComments(
      read('../../supabase/functions/_shared/source-harvester.ts'),
    );
    assert.ok(
      harvester.includes(
        "const SOURCE_FIELDS = [...RESEARCH_SOURCE_FIELDS, 'relevanceNote', 'evidenceClaims'] as const;",
      ),
    );
    assert.ok(harvester.includes("const EVIDENCE_FIELDS = [...EVIDENCE_DRAFT_FIELDS, 'evidenceId'] as const;"));
  });

  it('두 경로 모두 근거를 그대로 옮긴다', () => {
    for (const path of [
      '../../supabase/functions/_shared/source-harvester-execution.ts',
      '../../supabase/functions/_shared/source-harvester-parallel-recovery-execution.ts',
      '../../supabase/functions/_shared/source-harvester-recovery-execution.ts',
    ]) {
      const code = stripComments(read(path));
      assert.ok(code.includes('evidenceClaims: entry.evidenceClaims.map('), path);
    }
  });

  it('이어서 할 표도 번호를 담지 않는다', () => {
    const ticket = stripComments(
      read('../../supabase/functions/_shared/harvest-recovery-ticket.ts'),
    );
    const banned = ticket.split('const BANNED_TICKET_FIELDS = [')[1].split('];')[0];
    assert.ok(banned.includes("'evidenceid'"));
  });
});

describe('연구 근거 · 지시문', () => {
  const instructions = () =>
    buildVerificationPayload({
      targetDomain: 'financial_hardship',
      domainDescription: '생계와 경제적 어려움',
      evidenceVersion: 1,
      prioritizerSnapshotId: `snap_${'a'.repeat(64)}`,
      discoveredUrls: urls(10),
    }).instructions as string;

  it('실제로 연 페이지에서만 적으라고 말한다', () => {
    const text = instructions();
    assert.ok(text.includes('실제로 연 그 페이지에서 읽은 것을 **당신의 문장으로** 짧게 정리합니다'));
    assert.ok(text.includes('검색 결과 제목이나 요약문만 보고 적지 마십시오'));
    assert.ok(text.includes('다른 페이지에서 읽은 것을 이 자료의 근거로 섞지 마십시오'));
  });

  it('원문을 옮기지 말라고 말한다', () => {
    const text = instructions();
    assert.ok(text.includes('원문을 그대로 옮기지 마십시오'));
    assert.ok(text.includes('페이지 전체를 요약하는 자리가 아닙니다'));
    assert.ok(text.includes('성경 본문 문장을 옮겨 적지 마십시오'));
  });

  it('자료가 말하지 않은 결론을 만들지 말라고 말한다', () => {
    const text = instructions();
    assert.ok(text.includes('그 자료가 말하지 않은 신학적 결론을 당신이 만들어 붙이지 마십시오'));
    assert.ok(text.includes('나쁜 예'));
  });

  it('숫자를 손으로 적지 않았다', () => {
    const contract = read(CONTRACT);
    const body = contract.split('function buildAcceptedSourceFieldRules')[1].split('\n}\n')[0];

    assert.ok(body.includes('${EVIDENCE_CLAIM_MIN}'));
    assert.ok(body.includes('${EVIDENCE_CLAIM_MAX}'));
    assert.ok(body.includes('${EVIDENCE_STATEMENT_MIN}'));
    assert.ok(body.includes('${EVIDENCE_STATEMENT_MAX}'));
    assert.ok(body.includes('${EVIDENCE_PASSAGE_MAX}'));
  });

  it('번호를 적지 말라고 말한다', () => {
    assert.ok(instructions().includes('번호(evidenceId)는 적지 마십시오. 서버가 붙입니다'));
  });

  it('근거를 못 적을 자료는 채택하지 말라고 말한다', () => {
    const text = instructions();
    assert.ok(text.includes('근거를 정직하게 적을 수 없는 자료는 채택하지 마십시오'));
    assert.ok(text.includes('수를 채우려고 근거를 지어내는 것이 가장 나쁜 답입니다'));
  });
});

describe('연구 근거 · 서버가 보증하지 않는 것을 적어 두었다', () => {
  it('계약 문서에 한계가 적혀 있다', () => {
    const contract = read('../../supabase/functions/_shared/source-harvest-contract.ts');
    assert.ok(contract.includes('서버가 보증하지 않는 것'));
    assert.ok(contract.includes('원문과 대조하지 않는다'));
    assert.ok(contract.includes('모델이 진술한 관찰'));
  });

  it('최종 자료 타입에도 적혀 있다', () => {
    const harvester = read('../../supabase/functions/_shared/source-harvester.ts');
    assert.ok(harvester.includes('서버가 원문과 대조해 확인한 인용이 아니다'));
  });
});

describe('연구 근거 · J. 바뀌지 않은 것', () => {
  it('모델·시간·도구·출력 상한이 그대로다', () => {
    const contract = read(CONTRACT);
    for (const line of [
      "export const SOURCE_HARVEST_MODEL = 'gpt-5.6-terra';",
      'export const DISCOVERY_MAX_TOOL_CALLS = 6;',
      'export const VERIFICATION_MAX_TOOL_CALLS = 18;',
      'export const DISCOVERY_MAX_OUTPUT_TOKENS = 8_000;',
      'export const VERIFICATION_MAX_OUTPUT_TOKENS = 16_000;',
      'export const DISCOVERY_TIMEOUT_MS = 60_000;',
      'export const VERIFICATION_TIMEOUT_MS = 75_000;',
      'export const DISCOVERY_MIN_URLS = 8;',
    ]) {
      assert.ok(contract.includes(line), line);
    }
  });

  it('품질 기준이 그대로다', () => {
    const harvest = read('../../supabase/functions/_shared/source-harvest-contract.ts');
    for (const line of [
      'export const ACCEPTED_MIN = 5;',
      'export const ACCEPTED_MAX = 12;',
      'export const SCHOLARLY_CORE_MIN = 3;',
      'export const PUBLISHER_MIN = 2;',
    ]) {
      assert.ok(harvest.includes(line), line);
    }
  });

  it('병렬 확인 설정이 그대로다', () => {
    const single = read(
      '../../supabase/functions/_shared/source-harvester-single-inspection-contract.ts',
    );
    for (const line of [
      'export const SINGLE_INSPECTION_SPARE_MAX = 4;',
      'export const SINGLE_INSPECTION_MAX_CONCURRENCY = 8;',
      'export const SINGLE_INSPECTION_TIMEOUT_MS = 45_000;',
      'export const SINGLE_INSPECTION_MAX_TOOL_CALLS = 4;',
    ]) {
      assert.ok(single.includes(line), line);
    }
  });

  it('새 네트워크·DB 경로를 만들지 않았다', () => {
    for (const path of [
      '../../supabase/functions/_shared/source-harvest-contract.ts',
      '../../supabase/functions/_shared/verification-draft-source.ts',
      EXECUTION,
      CONTRACT,
    ]) {
      const code = stripComments(read(path));
      for (const banned of ['fetch(', 'Deno.env', '/rest/v1/', 'createClient']) {
        assert.equal(code.includes(banned), false, `${path}: ${banned}`);
      }
    }
    const index = stripComments(read('../../supabase/functions/source-harvester/index.ts'));
    // 이어서 할 표 둘, 판단 대조 하나, 꾸러미 적어 두기 하나.
    assert.equal((index.match(/\/rest\/v1\/rpc\//g) || []).length, 4);
    // 실제로 나가는 자리는 그대로 둘뿐이다. 꾸러미도 같은 자리를 쓴다.
    assert.equal((index.match(/await fetch\(/g) || []).length, 2);
  });

  it('판단 대조와 이어서 할 표의 계약이 그대로다', () => {
    const handler = read('../../supabase/functions/source-harvester/handler.ts');
    assert.ok(handler.includes('await deps.consumePrioritizerDecision('));
    assert.ok(handler.includes('PRIORITIZER_DECISION_UNAVAILABLE'));
    const parallel = read(
      '../../supabase/functions/_shared/source-harvester-parallel-recovery-execution.ts',
    );
    assert.ok(parallel.includes('matchesRecoveryCoverageSnapshot'));
  });

  it('Biblical Researcher가 근거 목록을 직접 들고 있지 않다', () => {
    // 연구 단계는 근거를 번호로만 가리킨다. 근거 내용은 꾸러미가 들고 있다.
    for (const path of [
      '../../supabase/functions/_shared/biblical-researcher.ts',
      '../../supabase/functions/_shared/biblical-research-contract.ts',
    ]) {
      const code = read(path);
      assert.equal(code.includes('evidenceClaims'), false, path);
      assert.equal(code.includes('statement'), false, path);
    }
  });

  it('연구 단계가 보는 자료 모양은 그대로다', () => {
    // ResearchSource는 연구 단계의 계약이다. 이번 단계에서 바꾸지 않는다.
    const researchSource = read('../../supabase/functions/_shared/research-source.ts');
    assert.equal(researchSource.includes('evidenceClaims'), false);

    const harvester = stripComments(read('../../supabase/functions/_shared/source-harvester.ts'));
    assert.ok(harvester.includes('evidenceClaims: _evidenceClaims'));
  });
});


/* ------------------------------------------------------------------ */
/* 최종 결과 구조와 번호 순서                                            */
/* ------------------------------------------------------------------ */

/** 최종 결과 구조에서 자료 한 건의 모양을 꺼낸다. */
function finalSourceSchema() {
  return (SOURCE_HARVEST_SCHEMA as unknown as {
    properties: {
      sources: {
        items: {
          properties: Record<string, never>;
          required: string[];
          additionalProperties: boolean;
        };
      };
    };
  }).properties.sources.items;
}

describe('연구 근거 · A. 최종 결과 구조', () => {
  it('최종 자료에 근거 자리가 있고 필수다', () => {
    const item = finalSourceSchema();
    assert.ok('evidenceClaims' in item.properties);
    assert.ok(item.required.includes('evidenceClaims'));
    assert.equal(item.additionalProperties, false);
  });

  it('최종 결과 구조가 실제 결과와 같은 항목을 요구한다', () => {
    const item = finalSourceSchema();
    // 타입(HarvestedSource)이 요구하는 것과 구조가 요구하는 것이 같아야 한다.
    assert.deepEqual(item.required.slice().sort(), [
      'accessLevel',
      'accessedAt',
      'authorOrOrganization',
      'evidenceClaims',
      'intendedUse',
      'publicationYear',
      'publisherOrInstitution',
      'relevanceNote',
      'sourceId',
      'sourceType',
      'title',
      'url',
    ]);
  });

  it('최종 근거 한 조각에는 번호가 필수다', () => {
    const claims = finalSourceSchema().properties.evidenceClaims as unknown as {
      minItems: number;
      maxItems: number;
      items: {
        properties: Record<string, { enum?: string[] }>;
        required: string[];
        additionalProperties: boolean;
      };
    };

    assert.equal(claims.minItems, EVIDENCE_CLAIM_MIN);
    assert.equal(claims.maxItems, EVIDENCE_CLAIM_MAX);
    assert.ok('evidenceId' in claims.items.properties);
    assert.ok(claims.items.required.includes('evidenceId'));
    assert.equal(claims.items.additionalProperties, false);

    assert.deepEqual(claims.items.required.slice().sort(), [
      'evidenceId',
      ...[...EVIDENCE_DRAFT_FIELDS],
    ].sort());
    // 용도 목록은 canonical 목록을 그대로 쓴다.
    assert.deepEqual(claims.items.properties.intendedUse.enum, [...INTENDED_USES]);
  });

  it('근거 조각의 모양은 한 곳에만 정의돼 있다', () => {
    // 초안 구조와 최종 구조가 같은 조각에서 나온다.
    const draftClaim = evidenceSchema().items;
    assert.deepEqual(
      Object.keys(draftClaim.properties).sort(),
      Object.keys(EVIDENCE_CLAIM_DRAFT_SCHEMA.properties).sort(),
    );

    // 응답 구조를 만드는 파일이 조각을 다시 적지 않는다.
    const contract = stripComments(read(CONTRACT));
    assert.ok(contract.includes('items: EVIDENCE_CLAIM_DRAFT_SCHEMA'));
    assert.equal(contract.includes('const evidenceClaimSchema = {'), false);
    assert.equal(contract.includes('const passageReferenceSchema = {'), false);

    // 성경 책 목록을 구조 안에 복제하지 않았다.
    assert.deepEqual(Object.keys(PASSAGE_REFERENCE_SCHEMA.properties).sort(), [
      'book',
      'chapter',
      'endVerse',
      'startVerse',
    ]);
    assert.equal(JSON.stringify(PASSAGE_REFERENCE_SCHEMA).includes('Psalms'), false);
  });
});

describe('연구 근거 · B. 번호는 순서까지 정확해야 한다', () => {
  const SOURCE_ID = `src_${'a'.repeat(64)}`;

  const withClaims = async (claims: unknown[]) => {
    const base = brief();
    return await validateSourceHarvestResult(
      {
        targetDomain: base.targetDomain,
        evidenceVersion: base.evidenceVersion,
        prioritizerSnapshotId: base.prioritizerSnapshotId,
        sources: [
          {
            sourceId: SOURCE_ID,
            sourceType: 'commentary',
            title: '재정 어려움 본문 주석',
            authorOrOrganization: '연구자',
            publisherOrInstitution: 'Fixture Academic Press',
            publicationYear: 2015,
            url: url(0),
            accessedAt: '2026-09-02',
            accessLevel: 'full_text',
            intendedUse: ['exegesis'],
            relevanceNote: '이 영역의 문맥을 확인하는 데 필요합니다.',
            evidenceClaims: claims,
          },
        ],
        rejectedSources: [],
        unresolvedSourceQuestions: [],
      },
      base,
    );
  };

  const numbered = (suffix: string, sourceId = SOURCE_ID) => ({
    ...claim(),
    evidenceId: `${sourceId}:${suffix}`,
  });

  it('첫 근거가 e1이면 번호 검사를 통과한다', async () => {
    const outcome = await withClaims([numbered('e1')]);
    assert.equal(
      outcome.errors.some((error) => error.includes('번호가')),
      false,
      outcome.errors.join(' / '),
    );
  });

  it('차례대로 붙은 번호는 통과한다', async () => {
    const outcome = await withClaims([numbered('e1'), numbered('e2'), numbered('e3')]);
    assert.equal(outcome.errors.some((error) => error.includes('번호가')), false);
  });

  it('첫 근거가 e2면 거절한다', async () => {
    const outcome = await withClaims([numbered('e2')]);
    assert.equal(outcome.valid, false);
    assert.ok(outcome.errors.some((error) => error.includes('번호가 서버가 붙인 것과 다릅니다')));
  });

  it('e99처럼 없는 순서는 거절한다', async () => {
    for (const suffix of ['e0', 'e99', 'e1x', 'e01']) {
      const outcome = await withClaims([numbered(suffix)]);
      assert.equal(outcome.valid, false, suffix);
      assert.ok(
        outcome.errors.some((error) => error.includes('번호가 서버가 붙인 것과 다릅니다')),
        suffix,
      );
    }
  });

  it('순서가 뒤바뀌면 거절한다', async () => {
    const outcome = await withClaims([numbered('e2'), numbered('e1')]);
    assert.equal(outcome.valid, false);
  });

  it('같은 번호를 두 번 쓰면 거절한다', async () => {
    const outcome = await withClaims([numbered('e1'), numbered('e1')]);
    assert.equal(outcome.valid, false);
  });

  it('다른 자료의 번호를 붙이면 거절한다', async () => {
    const outcome = await withClaims([numbered('e1', `src_${'b'.repeat(64)}`)]);
    assert.equal(outcome.valid, false);
    assert.ok(outcome.errors.some((error) => error.includes('번호가 서버가 붙인 것과 다릅니다')));
  });

  it('서버가 만든 번호는 이 검사를 그대로 통과한다', () => {
    // materializeEvidenceClaims의 규칙과 검사 규칙이 같은 식이어야 한다.
    const execution = stripComments(read(EXECUTION));
    assert.ok(execution.includes('`${sourceId}:e${index + 1}`'));

    const harvester = stripComments(
      read('../../supabase/functions/_shared/source-harvester.ts'),
    );
    assert.ok(harvester.includes('`${source.sourceId}:e${claimIndex + 1}`'));
  });
});
