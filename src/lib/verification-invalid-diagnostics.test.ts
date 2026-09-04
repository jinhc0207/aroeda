/**
 * 2단계 응답을 쓸 수 없을 때 어느 큰 범주였는지 · 테스트
 *
 * 실행: npm test
 *
 * production v27 Request A가 `verification_response_invalid` 하나로 끝났는데,
 * 그 사유를 쓰는 자리가 코드 안에 여럿이라 어디서 막혔는지 알 수 없었다.
 * 밖으로 나가는 사유는 그대로 두고, 서버 기록에만 큰 범주가 남는지 확인한다.
 *
 * 실제 웹 검색과 OpenAI 호출은 하지 않는다. 응답 모양을 흉내 낸 fixture만 쓴다.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import {
  VERIFICATION_INVALID_DIAGNOSTICS,
  type VerificationInvalidDiagnostic,
} from '../../supabase/functions/_shared/verification-invalid-diagnostics.ts';
import {
  parseVerificationResponse,
  runSourceHarvest,
  validateHarvestDraft,
  type SourceHarvestDraftResult,
  type VerifiedSourceDraft,
} from '../../supabase/functions/_shared/source-harvester-execution.ts';
import { buildSourceHarvestBrief } from '../../supabase/functions/_shared/source-harvester.ts';
import {
  PUBLICATION_YEAR_MAX,
  REJECTED_SOURCE_MAX,
  RELEVANCE_NOTE_MAX,
} from '../../supabase/functions/_shared/source-harvest-contract.ts';
import { DISCOVERY_MIN_URLS } from '../../supabase/functions/_shared/source-harvester-execution-contract.ts';
import { getActiveCoveredDomains } from '../../supabase/functions/_shared/research-prioritizer-edge.ts';

/* ------------------------------------------------------------------ */
/* fixture                                                             */
/* ------------------------------------------------------------------ */

const brief = () =>
  buildSourceHarvestBrief({
    targetDomain: 'financial_hardship',
    evidenceVersion: 4,
    prioritizerSnapshotId: `snap_${'a'.repeat(64)}`,
    activeCoveredDomains: getActiveCoveredDomains(),
  });

const FIXED_NOW = () => new Date('2026-09-02T00:00:00.000Z');

const url = (index: number) => `https://sources.example.org/aroeda/fixture-${index}`;
const urls = (count: number) => Array.from({ length: count }, (_, index) => url(index));

type Spec = Pick<
  VerifiedSourceDraft,
  'sourceType' | 'publisherOrInstitution' | 'intendedUse' | 'accessLevel'
>;

const SPECS: Spec[] = [
  {
    sourceType: 'commentary',
    publisherOrInstitution: 'Fixture Academic Press',
    intendedUse: ['exegesis'],
    accessLevel: 'full_text',
  },
  {
    sourceType: 'biblical_theology',
    publisherOrInstitution: 'Fixture University Press',
    intendedUse: ['biblical_theology', 'doctrinal_context'],
    accessLevel: 'substantial_preview',
  },
  {
    sourceType: 'academic_article',
    publisherOrInstitution: 'Fixture Journal',
    intendedUse: ['exegesis'],
    accessLevel: 'abstract_only',
  },
  {
    sourceType: 'pastoral_resource',
    publisherOrInstitution: 'Fixture Seminary',
    intendedUse: ['pastoral_application'],
    accessLevel: 'full_text',
  },
  {
    sourceType: 'professional_context',
    publisherOrInstitution: 'Fixture Public Health Agency',
    intendedUse: ['pastoral_safety', 'real_world_context'],
    accessLevel: 'full_text',
  },
];

const draftSource = (
  index: number,
  overrides: Partial<VerifiedSourceDraft> = {},
): VerifiedSourceDraft => {
  const spec = SPECS[index % SPECS.length];
  return {
    sourceType: spec.sourceType,
    title: `연구 자료 ${index}`,
    authorOrOrganization: `연구자 ${index}`,
    publisherOrInstitution: spec.publisherOrInstitution,
    publicationYear: 2018 + (index % 5),
    url: url(index),
    accessLevel: spec.accessLevel,
    intendedUse: [...spec.intendedUse],
    relevanceNote: '이 영역의 문맥을 확인하는 데 필요한 자료입니다.',
    evidenceClaims: [
      {
        intendedUse: spec.intendedUse[0],
        statement: '이 자료는 해당 영역을 다루면서 본문의 문맥과 그 신학적 자리를 함께 설명한다고 관찰되었다.',
        // 주해 근거는 어느 본문을 두고 하는 말인지 밝혀야 한다.
        passageReferences:
          spec.intendedUse[0] === 'exegesis'
            ? [{ book: 'Psalms', chapter: 42, startVerse: 5, endVerse: 5 }]
            : [],
      },
    ],
    ...overrides,
  };
};

const draft = (overrides: Record<string, unknown> = {}): SourceHarvestDraftResult => {
  const base = brief();
  return {
    targetDomain: base.targetDomain,
    evidenceVersion: base.evidenceVersion,
    prioritizerSnapshotId: base.prioritizerSnapshotId,
    sources: Array.from({ length: 5 }, (_, index) => draftSource(index)),
    rejectedSources: [
      { url: url(7), title: '익명 묵상글', rejectionReason: 'anonymous_or_unverifiable' },
    ],
    unresolvedSourceQuestions: [],
    ...overrides,
  } as SourceHarvestDraftResult;
};

/** 초안 하나만 바꾼 사본. 원본은 건드리지 않는다. */
const withSource = (source: unknown): SourceHarvestDraftResult => {
  const base = draft();
  return { ...base, sources: [source, ...base.sources.slice(1)] } as SourceHarvestDraftResult;
};

const searchCall = (found: readonly string[]) => ({
  type: 'web_search_call',
  status: 'completed',
  action: {
    type: 'search',
    query: '생계 어려움 성경 연구',
    sources: found.map((item) => ({ type: 'url', url: item })),
  },
});

const openPageCall = (target: string) => ({
  type: 'web_search_call',
  status: 'completed',
  action: { type: 'open_page', url: target },
});

const messageWithText = (text: string) => ({
  type: 'message',
  role: 'assistant',
  content: [{ type: 'output_text', text, annotations: [] }],
});

const discoveryResponse = (found: readonly string[]) => ({
  status: 'completed',
  output: [searchCall(found)],
});

/** 초안에 든 자료를 모두 열어 본 것으로 만든 2단계 응답 */
const verificationResponse = (
  value: unknown,
  options: { status?: string; refusal?: boolean; text?: string } = {},
) => {
  const found = urls(10);
  const drafted =
    typeof value === 'object' && value !== null && Array.isArray((value as { sources?: unknown }).sources)
      ? ((value as SourceHarvestDraftResult).sources as VerifiedSourceDraft[])
          .map((source) => source?.url)
          .filter((item): item is string => typeof item === 'string')
      : [];

  const inspected = [...drafted];
  for (const candidate of found) {
    if (inspected.length >= DISCOVERY_MIN_URLS) break;
    if (!inspected.includes(candidate)) inspected.push(candidate);
  }

  const output: unknown[] = [searchCall(found)];
  for (const target of inspected) output.push(openPageCall(target));

  if (options.refusal) {
    output.push({
      type: 'message',
      role: 'assistant',
      content: [{ type: 'refusal', refusal: '거절' }],
    });
  } else {
    output.push(messageWithText(options.text ?? JSON.stringify(value)));
  }

  const response: Record<string, unknown> = { output };
  if (options.status) response.status = options.status;
  return response;
};

/** 실패 결과에 담긴 큰 범주를 꺼낸다. 성공이면 테스트를 세운다. */
const diagnosticOf = (result: { ok: boolean } & Record<string, unknown>): unknown => {
  assert.equal(result.ok, false, '실패해야 하는데 통과했습니다.');
  return result.diagnostic;
};

/* ------------------------------------------------------------------ */

describe('2단계 invalid · 범주 목록', () => {
  it('정해진 아홉 가지뿐이고 모두 다르다', () => {
    assert.deepEqual([...VERIFICATION_INVALID_DIAGNOSTICS], [
      'verification_invalid_response_shape',
      'verification_invalid_output_text',
      'verification_invalid_json',
      'verification_invalid_draft_shape',
      'verification_invalid_banned_field',
      'verification_invalid_provenance',
      'verification_invalid_source_metadata',
      'verification_invalid_rejected_source',
      'verification_invalid_unresolved_questions',
    ]);
    assert.equal(new Set(VERIFICATION_INVALID_DIAGNOSTICS).size, 9);
    for (const code of VERIFICATION_INVALID_DIAGNOSTICS) {
      assert.match(code, /^verification_invalid_[a-z_]+$/);
    }
  });

  it('범주를 정하는 파일은 실행 환경도 규칙도 모른다', () => {
    // 이 파일은 이름만 정한다. 판정도, 네트워크도, DB도 없다.
    const source = readFileSync(
      new URL(
        '../../supabase/functions/_shared/verification-invalid-diagnostics.ts',
        import.meta.url,
      ),
      'utf8',
    );
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '');

    for (const item of ['Deno.env', 'fetch(', 'process.env', 'import ', 'function ', '=>']) {
      assert.equal(code.includes(item), false, item);
    }
  });
});

describe('2단계 invalid · 응답 읽기 범주', () => {
  it('A. 응답 자체가 객체가 아니면 response_shape다', () => {
    for (const bad of [null, undefined, 'text', 42, []]) {
      const result = parseVerificationResponse(bad);
      assert.equal(diagnosticOf(result), 'verification_invalid_response_shape', String(bad));
      if (result.ok) return;
      assert.equal(result.reason, 'verification_response_invalid');
    }
  });

  it('B. 모델이 쓴 본문을 꺼낼 수 없으면 output_text다', () => {
    const result = parseVerificationResponse({ output: [searchCall(urls(10))] });
    assert.equal(diagnosticOf(result), 'verification_invalid_output_text');
    if (result.ok) return;
    assert.equal(result.reason, 'verification_response_invalid');
  });

  it('C. 본문이 깨진 JSON이면 json이다', () => {
    const result = parseVerificationResponse(verificationResponse(draft(), { text: '{ 깨진' }));
    assert.equal(diagnosticOf(result), 'verification_invalid_json');
  });

  it('D. JSON이 객체가 아니면(배열 등) json이다', () => {
    for (const text of ['[1,2,3]', '"문자열"', 'null', '7']) {
      const result = parseVerificationResponse(verificationResponse(draft(), { text }));
      assert.equal(diagnosticOf(result), 'verification_invalid_json', text);
    }
  });

  it('E. 중간에 끊긴 응답에는 새 범주를 붙이지 않는다', () => {
    const result = parseVerificationResponse(
      verificationResponse(draft(), { status: 'incomplete' }),
    );
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.reason, 'verification_incomplete');
    assert.equal(result.diagnostic, undefined);
  });

  it('F. 거절한 응답에도 새 범주를 붙이지 않는다', () => {
    const result = parseVerificationResponse(verificationResponse(draft(), { refusal: true }));
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.reason, 'verification_refusal');
    assert.equal(result.diagnostic, undefined);
  });

  it('정상 응답에는 범주가 없다', () => {
    const result = parseVerificationResponse(verificationResponse(draft()));
    assert.equal(result.ok, true);
    assert.equal('diagnostic' in result, false);
  });
});

describe('2단계 invalid · 초안 검사 범주', () => {
  const check = (value: unknown) => validateHarvestDraft(value, brief());

  it('초안이 객체가 아니면 draft_shape다', () => {
    for (const bad of [null, 'text', 42, []]) {
      assert.equal(diagnosticOf(check(bad)), 'verification_invalid_draft_shape', String(bad));
    }
  });

  it('없어야 할 최상위 항목이 있으면 draft_shape다', () => {
    assert.equal(
      diagnosticOf(check({ ...draft(), extraField: 1 })),
      'verification_invalid_draft_shape',
    );
  });

  it('있어야 할 최상위 항목이 빠지면 draft_shape다', () => {
    const value = draft() as unknown as Record<string, unknown>;
    delete value.unresolvedSourceQuestions;
    assert.equal(diagnosticOf(check(value)), 'verification_invalid_draft_shape');
  });

  it('세 목록이 배열이 아니면 draft_shape다', () => {
    for (const key of ['sources', 'rejectedSources', 'unresolvedSourceQuestions']) {
      assert.equal(
        diagnosticOf(check({ ...draft(), [key]: '배열이 아님' })),
        'verification_invalid_draft_shape',
        key,
      );
    }
  });

  it('서버가 만드는 항목을 모델이 적으면 banned_field다', () => {
    const cases: Record<string, unknown>[] = [
      { ...draft(), sources: [{ ...draftSource(0), sourceId: 'src_x' }] },
      { ...draft(), sources: [{ ...draftSource(0), accessedAt: '2026-09-02' }] },
      { ...draft(), sources: [{ ...draftSource(0), content: '본문 전체' }] },
    ];
    for (const value of cases) {
      assert.equal(diagnosticOf(check(value)), 'verification_invalid_banned_field');
    }
  });

  it('금지 항목은 자료 규칙보다 먼저 걸린다', () => {
    // 값 자체도 틀렸지만, 있어서는 안 될 항목이 먼저다.
    const value = { ...draft(), sources: [{ ...draftSource(0), sourceId: 'src_x', publicationYear: 3000 }] };
    assert.equal(diagnosticOf(check(value)), 'verification_invalid_banned_field');
  });

  it('영역·근거 판본·판단 시점이 다르면 provenance다', () => {
    const cases = [
      { targetDomain: 'grief_loss' },
      { evidenceVersion: 99 },
      { prioritizerSnapshotId: `snap_${'b'.repeat(64)}` },
    ];
    for (const override of cases) {
      assert.equal(
        diagnosticOf(check({ ...draft(), ...override })),
        'verification_invalid_provenance',
        JSON.stringify(Object.keys(override)),
      );
    }
  });

  it('자료 한 건의 문제는 모두 source_metadata 하나로 묶인다', () => {
    const cases: [string, unknown][] = [
      ['연도 초과', draftSource(0, { publicationYear: 3000 })],
      ['메모 초과', draftSource(0, { relevanceNote: '가'.repeat(RELEVANCE_NOTE_MAX + 1) })],
      ['용도 중복', draftSource(1, { intendedUse: ['biblical_theology', 'biblical_theology'] })],
      ['종류와 용도 불일치', draftSource(0, { sourceType: 'commentary', intendedUse: ['real_world_context'] })],
      ['쓸 수 없는 주소', draftSource(0, { url: 'javascript:alert(1)' })],
      ['제목 비어 있음', draftSource(0, { title: '   ' })],
      ['모르는 항목', { ...draftSource(0), nickname: '별칭' }],
      ['자료가 객체가 아님', '자료'],
    ];

    for (const [label, source] of cases) {
      assert.equal(
        diagnosticOf(check(withSource(source))),
        'verification_invalid_source_metadata',
        label,
      );
    }

    // 연도가 상한 안이면 통과한다. 상한 자체를 바꾸지 않았다.
    const ok = check(withSource(draftSource(0, { publicationYear: PUBLICATION_YEAR_MAX })));
    assert.equal(ok.ok, true);
  });

  it('뺀 자료 목록의 문제는 rejected_source다', () => {
    const bad: [string, unknown][] = [
      ['항목이 객체가 아님', ['문자열']],
      ['모르는 항목', [{ url: url(7), title: null, rejectionReason: 'anonymous_or_unverifiable', memo: 'x' }]],
      ['항목 누락', [{ url: url(7), rejectionReason: 'anonymous_or_unverifiable' }]],
      ['주소 비어 있음', [{ url: '  ', title: null, rejectionReason: 'anonymous_or_unverifiable' }]],
      ['제목이 빈 문자열', [{ url: url(7), title: '   ', rejectionReason: 'anonymous_or_unverifiable' }]],
      ['허용되지 않은 사유', [{ url: url(7), title: null, rejectionReason: '그냥' }]],
      [
        '개수 초과',
        Array.from({ length: REJECTED_SOURCE_MAX + 1 }, (_, index) => ({
          url: url(20 + index),
          title: null,
          rejectionReason: 'anonymous_or_unverifiable',
        })),
      ],
    ];

    for (const [label, rejectedSources] of bad) {
      assert.equal(
        diagnosticOf(check({ ...draft(), rejectedSources })),
        'verification_invalid_rejected_source',
        label,
      );
    }
  });

  it('남은 물음 목록의 문제는 unresolved_questions다', () => {
    for (const questions of [[1], ['괜찮음', null], [{}]]) {
      assert.equal(
        diagnosticOf(check({ ...draft(), unresolvedSourceQuestions: questions })),
        'verification_invalid_unresolved_questions',
        JSON.stringify(questions),
      );
    }
  });

  it('정상 초안에는 범주가 없다', () => {
    const result = check(draft());
    assert.equal(result.ok, true);
    assert.equal('diagnostic' in result, false);
  });

  it('나오는 범주는 정해진 목록 안에만 있다', () => {
    const samples: unknown[] = [
      null,
      { ...draft(), extraField: 1 },
      { ...draft(), sources: [{ ...draftSource(0), sourceId: 'x' }] },
      { ...draft(), targetDomain: 'grief_loss' },
      withSource(draftSource(0, { publicationYear: 3000 })),
      { ...draft(), rejectedSources: ['x'] },
      { ...draft(), unresolvedSourceQuestions: [1] },
    ];
    for (const value of samples) {
      const code = diagnosticOf(check(value)) as VerificationInvalidDiagnostic;
      assert.ok(
        (VERIFICATION_INVALID_DIAGNOSTICS as readonly string[]).includes(code),
        String(code),
      );
    }
  });
});

describe('2단계 invalid · 자료 내용이 새지 않는다', () => {
  const SECRET_TITLE = 'SUPER_SECRET_TITLE';
  const SECRET_HOST = 'secret.example.org';

  const leakyDraft = () =>
    withSource(
      draftSource(0, {
        title: SECRET_TITLE,
        authorOrOrganization: 'SECRET_AUTHOR',
        publisherOrInstitution: 'SECRET_PUBLISHER',
        url: `https://${SECRET_HOST}/private`,
        publicationYear: 3000,
        relevanceNote: 'SECRET_NOTE',
      }),
    );

  it('실패 결과에는 고정된 두 이름뿐이다', () => {
    const result = validateHarvestDraft(leakyDraft(), brief());
    assert.equal(result.ok, false);
    if (result.ok) return;

    assert.deepEqual(Object.keys(result).sort(), ['diagnostic', 'ok', 'reason']);
    assert.equal(result.reason, 'verification_response_invalid');
    assert.equal(result.diagnostic, 'verification_invalid_source_metadata');
  });

  it('shared validator의 세부 위반 이름을 옮겨 적지 않는다', () => {
    const result = validateHarvestDraft(leakyDraft(), brief());
    const dumped = JSON.stringify(result);

    for (const banned of [
      SECRET_TITLE,
      SECRET_HOST,
      'SECRET_AUTHOR',
      'SECRET_PUBLISHER',
      'SECRET_NOTE',
      '3000',
      'publication_year_invalid',
      'relevance_note_too_long',
      'intended_use_duplicated',
      'intended_use_incompatible',
      'url_unacceptable',
    ]) {
      assert.equal(dumped.includes(banned), false, banned);
    }
  });

  it('전체 실행에서도 기록에 남는 것은 두 이름뿐이다', async () => {
    const logged: string[] = [];
    const outcome = await runSourceHarvest(brief(), {
      callDiscovery: async () => discoveryResponse(urls(10)),
      callVerification: async () => verificationResponse(leakyDraft()),
      now: FIXED_NOW,
      log: (reason) => logged.push(reason),
    });

    assert.deepEqual(logged, [
      'verification_invalid_source_metadata',
      'verification_response_invalid',
    ]);

    const dumped = JSON.stringify({ outcome, logged });
    for (const banned of [
      SECRET_TITLE,
      SECRET_HOST,
      'SECRET_AUTHOR',
      'SECRET_NOTE',
      '3000',
      'publication_year_invalid',
    ]) {
      assert.equal(dumped.includes(banned), false, banned);
    }
  });
});

describe('2단계 invalid · 전체 실행 통합', () => {
  const run = async (verification: unknown) => {
    const calls = { discovery: 0, verification: 0, ticket: 0 };
    const logged: string[] = [];

    const outcome = await runSourceHarvest(brief(), {
      callDiscovery: async () => {
        calls.discovery += 1;
        return discoveryResponse(urls(10));
      },
      callVerification: async () => {
        calls.verification += 1;
        return verification;
      },
      now: FIXED_NOW,
      log: (reason) => logged.push(reason),
      createRecoveryTicket: async () => {
        calls.ticket += 1;
        return '00000000-0000-4000-8000-000000000000';
      },
    });

    return { outcome, calls, logged };
  };

  it('큰 범주를 먼저 남기고 그다음 사유를 남긴다', async () => {
    const cases: [string, unknown][] = [
      ['verification_invalid_json', verificationResponse(draft(), { text: '{ 깨진' })],
      ['verification_invalid_output_text', { output: [searchCall(urls(10))] }],
      ['verification_invalid_draft_shape', verificationResponse({ ...draft(), extraField: 1 })],
      [
        'verification_invalid_banned_field',
        verificationResponse({ ...draft(), sources: [{ ...draftSource(0), sourceId: 'x' }] }),
      ],
      ['verification_invalid_provenance', verificationResponse({ ...draft(), targetDomain: 'grief_loss' })],
      [
        'verification_invalid_source_metadata',
        verificationResponse(withSource(draftSource(0, { publicationYear: 3000 }))),
      ],
      ['verification_invalid_rejected_source', verificationResponse({ ...draft(), rejectedSources: ['x'] })],
      [
        'verification_invalid_unresolved_questions',
        verificationResponse({ ...draft(), unresolvedSourceQuestions: [1] }),
      ],
    ];

    for (const [expected, verification] of cases) {
      const { outcome, calls, logged } = await run(verification);

      assert.deepEqual(logged, [expected, 'verification_response_invalid'], expected);
      assert.equal(calls.discovery, 1, expected);
      assert.equal(calls.verification, 1, expected);
      assert.equal(calls.ticket, 0, expected);

      assert.equal(outcome.status, 'recheck', expected);
      if (outcome.status !== 'recheck') return;
      assert.equal(outcome.reason, 'verification_response_invalid', expected);
    }
  });

  it('공개 응답에는 범주를 담지 않는다', async () => {
    const { outcome } = await run(verificationResponse(withSource(draftSource(0, { publicationYear: 3000 }))));

    assert.equal(outcome.status, 'recheck');
    if (outcome.status !== 'recheck') return;

    assert.equal('diagnostic' in outcome, false);
    assert.deepEqual(Object.keys(outcome).sort(), ['reason', 'status']);
    // 이 경로는 예전처럼 도구 숫자를 붙이지 않는다. 계산 시점을 앞당기지 않았다.
    assert.equal(outcome.verificationToolDiagnostics, undefined);
  });

  it('끊김·거절에는 큰 범주를 남기지 않는다', async () => {
    const cases: [string, unknown][] = [
      ['verification_incomplete', verificationResponse(draft(), { status: 'incomplete' })],
      ['verification_refusal', verificationResponse(draft(), { refusal: true })],
    ];

    for (const [expected, verification] of cases) {
      const { logged, outcome } = await run(verification);
      assert.deepEqual(logged, [expected], expected);
      assert.equal(outcome.status, 'recheck');
      if (outcome.status !== 'recheck') return;
      assert.equal(outcome.reason, expected);
    }
  });

  it('정상 초안에서는 새 기록이 하나도 남지 않는다', async () => {
    const { logged, outcome } = await run(verificationResponse(draft()));

    for (const reason of logged) {
      assert.equal(reason.startsWith('verification_invalid_'), false, reason);
    }
    // 이 fixture는 확인 범위를 채우므로 다시 보기로 끝나지 않는다.
    assert.notEqual(outcome.status, 'recheck');
  });
});

describe('2단계 invalid · 이어서 하는 요청(Request B)은 그대로다', () => {
  const stripComments = (source: string) =>
    source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '');

  it('병렬 실행 쪽은 새 범주를 쓰지도 남기지도 않는다', () => {
    const code = stripComments(
      readFileSync(
        new URL(
          '../../supabase/functions/_shared/source-harvester-parallel-recovery-execution.ts',
          import.meta.url,
        ),
        'utf8',
      ),
    );

    assert.equal(code.includes('verification_invalid'), false);
    assert.equal(code.includes('diagnostic:'), false);
    assert.equal(code.includes('.diagnostic'), false);
    assert.equal(code.includes('verification-invalid-diagnostics'), false);

    // 실패 판단은 예전 그대로 ok 하나만 본다.
    assert.ok(code.includes('const read = parseVerificationResponse(response);'));
    assert.ok(code.includes('if (!read.ok) return failed;'));
    assert.ok(code.includes('const checked = validateHarvestDraft(read.draft, brief);'));
    assert.ok(code.includes('if (!checked.ok) return failed;'));
  });

  it('한 번에 하던 옛 실행 쪽도 사유 옮기기 방식이 그대로다', () => {
    const code = stripComments(
      readFileSync(
        new URL(
          '../../supabase/functions/_shared/source-harvester-recovery-execution.ts',
          import.meta.url,
        ),
        'utf8',
      ),
    );

    assert.equal(code.includes('verification_invalid'), false);
    assert.equal(code.includes('.diagnostic'), false);
    assert.ok(code.includes("if (read.reason === 'verification_incomplete') return stop('recovery_incomplete');"));
    assert.ok(code.includes("return stop('recovery_response_invalid');"));
  });

  it('Edge Function 쪽 공개 응답에도 새 범주가 없다', () => {
    for (const path of ['handler.ts', 'index.ts']) {
      const code = stripComments(
        readFileSync(
          new URL(`../../supabase/functions/source-harvester/${path}`, import.meta.url),
          'utf8',
        ),
      );
      assert.equal(code.includes('verification_invalid'), false, path);
      assert.equal(code.includes('diagnostic:'), false, path);
    }
  });

  it('새 범주를 쓰는 곳은 실행 본체 한 곳뿐이다', () => {
    const execution = stripComments(
      readFileSync(
        new URL('../../supabase/functions/_shared/source-harvester-execution.ts', import.meta.url),
        'utf8',
      ),
    );

    // 기록으로 내보내는 자리는 정확히 두 곳(응답 읽기, 초안 검사)이다.
    assert.equal((execution.match(/log\((parsed|checked)\.diagnostic\)/g) || []).length, 2);
    // 공개 결과를 만드는 자리에는 붙이지 않는다.
    assert.equal(execution.includes('diagnostic,\n    status'), false);
  });
});
