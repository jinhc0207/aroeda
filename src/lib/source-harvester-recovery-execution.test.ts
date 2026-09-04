/**
 * Request B (이어서 확인하기) 실행 본체 테스트
 *
 * 실행: npm test
 *
 * 실제 OpenAI, 웹 검색, Supabase를 쓰지 않는다.
 * 가짜 응답(fixture)과 주입한 가짜 호출만 쓴다.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import {
  buildAuthoritativeRecoveryDraft,
  combineInspectedUrls,
  mergePrimaryAndRecoveryDrafts,
  runSourceHarvestRecovery,
  validateStoredPrimaryAuthority,
} from '../../supabase/functions/_shared/source-harvester-recovery-execution.ts';
import { computeActiveCoveredHash } from '../../supabase/functions/_shared/harvest-recovery-ticket.ts';
import { getActiveCoveredDomains } from '../../supabase/functions/_shared/research-prioritizer-edge.ts';
import { ACCEPTED_MAX, REJECTED_SOURCE_MAX } from '../../supabase/functions/_shared/source-harvest-contract.ts';

const url = (index: number) => `https://sources.example.org/aroeda/fixture-${index}`;
const urls = (count: number) => Array.from({ length: count }, (_, index) => url(index));
const outside = (index: number) => `https://outside.example.org/not-given-${index}`;

const SNAPSHOT = `snap_${'3'.repeat(64)}`;
const DOMAIN = 'financial_hardship';
const covered = getActiveCoveredDomains();

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');

/* ------------------------------------------------------------------ */
/* fixture                                                             */
/* ------------------------------------------------------------------ */

const SPECS = [
  { sourceType: 'commentary', publisherOrInstitution: 'Fixture Academic Press', intendedUse: ['exegesis'], accessLevel: 'full_text' },
  { sourceType: 'biblical_theology', publisherOrInstitution: 'Fixture University Press', intendedUse: ['biblical_theology'], accessLevel: 'substantial_preview' },
  { sourceType: 'academic_article', publisherOrInstitution: 'Fixture Journal', intendedUse: ['exegesis'], accessLevel: 'abstract_only' },
] as const;

const draftSource = (index: number, overrides: Record<string, unknown> = {}) => {
  const spec = SPECS[index % SPECS.length];
  return {
    sourceType: spec.sourceType,
    title: `연구 자료 ${index}`,
    authorOrOrganization: `연구자 ${index}`,
    publisherOrInstitution: spec.publisherOrInstitution,
    publicationYear: 2020,
    url: url(index),
    accessLevel: spec.accessLevel,
    intendedUse: [...spec.intendedUse],
    relevanceNote: '이 연구에 필요한 자료입니다.',
    evidenceClaims: [
      {
        intendedUse: spec.intendedUse[0],
        statement: '이 자료는 해당 영역을 다루면서 본문의 문맥과 그 신학적 자리를 함께 설명한다고 관찰되었다.',
        passageReferences:
          spec.intendedUse[0] === 'exegesis'
            ? [{ book: 'Psalms', chapter: 42, startVerse: 5, endVerse: 5 }]
            : [],
      },
    ],
    ...overrides,
  };
};

const rejectedEntry = (index: number, overrides: Record<string, unknown> = {}) => ({
  url: url(index),
  title: '익명 묵상글',
  rejectionReason: 'anonymous_or_unverifiable',
  ...overrides,
});

/** 표에서 꺼낸 상태. 받은 주소 30개 중 2개를 열었다 (production v22 실측과 같은 모양) */
const ticketState = async (overrides: Record<string, unknown> = {}) => ({
  targetDomain: DOMAIN,
  evidenceVersion: 1,
  prioritizerSnapshotId: SNAPSHOT,
  activeCoveredHash: await computeActiveCoveredHash(covered),
  discoveredUrls: urls(30),
  primaryInspectedUrls: [url(0), url(1)],
  primaryDraft: {
    sources: [draftSource(0)],
    rejectedSources: [rejectedEntry(1)],
    unresolvedSourceQuestions: ['유료 장벽'],
  },
  primaryToolCounts: {
    webSearchCallCount: 4,
    searchActionCount: 0,
    openPageActionCount: 3,
    findInPageActionCount: 1,
    unknownActionCount: 0,
    uniqueInspectedUrlCount: 2,
  },
  ...overrides,
});

const openPageCall = (target: string) => ({
  type: 'web_search_call',
  status: 'completed',
  action: { type: 'open_page', url: target },
});
const findInPageCall = (target: string) => ({
  type: 'web_search_call',
  status: 'completed',
  action: { type: 'find_in_page', url: target },
});
const searchCall = (found: readonly string[]) => ({
  type: 'web_search_call',
  status: 'completed',
  action: { type: 'search', query: 'q', sources: found.map((u) => ({ type: 'url', url: u })) },
});

/** 이어서 확인하기 초안. 기본은 남은 주소 2~7번 6개를 열고 그중 하나를 채택한다. */
const recoveryDraft = (overrides: Record<string, unknown> = {}) => ({
  targetDomain: DOMAIN,
  evidenceVersion: 1,
  prioritizerSnapshotId: SNAPSHOT,
  sources: [draftSource(2)],
  rejectedSources: [rejectedEntry(3)],
  unresolvedSourceQuestions: ['출판 연도 미확인'],
  ...overrides,
});

const recoveryResponse = (
  value: unknown = recoveryDraft(),
  options: {
    inspected?: readonly string[];
    searched?: readonly string[];
    status?: string;
    refusal?: boolean;
    text?: string;
    finds?: readonly string[];
  } = {},
) => {
  const inspected = options.inspected ?? [url(2), url(3), url(4), url(5), url(6), url(7)];
  const output: unknown[] = [searchCall(options.searched ?? urls(4).slice(2))];
  for (const target of inspected) output.push(openPageCall(target));
  for (const target of options.finds ?? []) output.push(findInPageCall(target));

  if (options.refusal) {
    output.push({ type: 'message', content: [{ type: 'refusal', refusal: '답할 수 없습니다.' }] });
  } else {
    output.push({
      type: 'message',
      content: [{ type: 'output_text', text: options.text ?? JSON.stringify(value), annotations: [] }],
    });
  }
  return { status: options.status ?? 'completed', output };
};

/** 실행 한 번. 모델 호출 횟수를 함께 센다. */
const run = async (options: {
  state?: unknown;
  response?: unknown;
  throws?: boolean;
  activeCovered?: readonly string[];
} = {}) => {
  const state = 'state' in options ? options.state : await ticketState();
  const calls = { recovery: 0 };
  const payloads: Record<string, unknown>[] = [];

  const outcome = await runSourceHarvestRecovery(
    { ticketState: state, activeCoveredDomains: options.activeCovered ?? covered },
    {
      callRecovery: async (payload) => {
        calls.recovery += 1;
        payloads.push(payload);
        if (options.throws) throw new Error('timeout');
        return options.response ?? recoveryResponse();
      },
      log: () => {},
    },
  );

  return { outcome, calls, payloads };
};

const reasonOf = (outcome: Awaited<ReturnType<typeof run>>['outcome']) =>
  outcome.status === 'recheck' ? outcome.reason : '';

/* ------------------------------------------------------------------ */

describe('Request B 실행 · 꺼낸 표 상태', () => {
  it('올바른 상태는 통과한다', async () => {
    const { outcome, calls } = await run();
    assert.equal(outcome.status, 'ready_to_materialize');
    assert.equal(calls.recovery, 1);
  });

  it('표 구조가 잘못되면 모델을 부르지 않는다', async () => {
    for (const bad of [null, {}, { targetDomain: DOMAIN }, 'state']) {
      const { outcome, calls } = await run({ state: bad });
      assert.equal(reasonOf(outcome), 'recovery_ticket_invalid');
      assert.equal(calls.recovery, 0);
    }
  });

  it('표 검사 규칙을 새로 만들지 않는다', () => {
    const source = read('../../supabase/functions/_shared/source-harvester-recovery-execution.ts');
    assert.ok(source.includes('parseHarvestRecoveryTicketState'));
  });
});

describe('Request B 실행 · 표에 담겨 있던 첫 번째 결과 재확인', () => {
  const withPrimary = async (draft: Record<string, unknown>) =>
    run({ state: await ticketState({ primaryDraft: draft }) });

  it('열어 보지 않은 주소의 자료가 담겨 있으면 멈춘다', async () => {
    // url(4)는 받은 주소이지만 1단계에서 열어 본 적이 없다.
    const { outcome, calls } = await withPrimary({
      sources: [draftSource(4)],
      rejectedSources: [],
      unresolvedSourceQuestions: [],
    });
    assert.equal(reasonOf(outcome), 'recovery_ticket_invalid');
    assert.equal(calls.recovery, 0);
  });

  it('열어 보지 않은 주소의 제외 기록도 마찬가지다', async () => {
    const { outcome, calls } = await withPrimary({
      sources: [],
      rejectedSources: [rejectedEntry(4)],
      unresolvedSourceQuestions: [],
    });
    assert.equal(reasonOf(outcome), 'recovery_ticket_invalid');
    assert.equal(calls.recovery, 0);
  });

  it('받은 적 없는 주소가 담겨 있으면 멈춘다', async () => {
    const { outcome } = await withPrimary({
      sources: [draftSource(0, { url: outside(0) })],
      rejectedSources: [],
      unresolvedSourceQuestions: [],
    });
    assert.equal(reasonOf(outcome), 'recovery_ticket_invalid');
  });

  it('같은 자료가 두 번 담겨 있으면 멈춘다', async () => {
    const dupSource = await withPrimary({
      sources: [draftSource(0), draftSource(0)],
      rejectedSources: [],
      unresolvedSourceQuestions: [],
    });
    assert.equal(reasonOf(dupSource.outcome), 'recovery_ticket_invalid');

    const dupRejected = await withPrimary({
      sources: [],
      rejectedSources: [rejectedEntry(1), rejectedEntry(1)],
      unresolvedSourceQuestions: [],
    });
    assert.equal(reasonOf(dupRejected.outcome), 'recovery_ticket_invalid');
  });

  it('같은 주소를 채택과 제외 양쪽에 담았으면 멈춘다', async () => {
    const { outcome } = await withPrimary({
      sources: [draftSource(0)],
      rejectedSources: [rejectedEntry(0)],
      unresolvedSourceQuestions: [],
    });
    assert.equal(reasonOf(outcome), 'recovery_ticket_invalid');
  });

  it('열어는 봤지만 초안에 적히지 않은 주소는 정상이다', async () => {
    // url(1)을 열어 봤지만 채택도 제외도 하지 않았다.
    const { outcome } = await withPrimary({
      sources: [draftSource(0)],
      rejectedSources: [],
      unresolvedSourceQuestions: [],
    });
    assert.equal(outcome.status, 'ready_to_materialize');
  });

  it('helper 하나로도 같은 판단을 한다', async () => {
    const state = await ticketState();
    assert.equal(validateStoredPrimaryAuthority(state as never), true);

    const broken = await ticketState({
      primaryDraft: { sources: [draftSource(4)], rejectedSources: [], unresolvedSourceQuestions: [] },
    });
    assert.equal(validateStoredPrimaryAuthority(broken as never), false);
  });
});

describe('Request B 실행 · 모델을 부르기 전', () => {
  it('카드가 다루는 영역이 달라졌으면 부르지 않는다', async () => {
    const { outcome, calls } = await run({ activeCovered: covered.slice(1) });
    assert.equal(reasonOf(outcome), 'recovery_coverage_changed');
    assert.equal(calls.recovery, 0);
  });

  it('영역 순서가 달라도 같은 것으로 본다', async () => {
    const { outcome } = await run({ activeCovered: [...covered].reverse() });
    assert.equal(outcome.status, 'ready_to_materialize');
  });

  it('범위를 정할 수 없으면 부르지 않는다', async () => {
    // 이미 목표(8개)를 채운 표는 이어서 할 일이 없다.
    const state = await ticketState({
      primaryInspectedUrls: urls(8),
      primaryDraft: { sources: [], rejectedSources: [], unresolvedSourceQuestions: [] },
      primaryToolCounts: {
        webSearchCallCount: 8,
        searchActionCount: 0,
        openPageActionCount: 8,
        findInPageActionCount: 0,
        unknownActionCount: 0,
        uniqueInspectedUrlCount: 8,
      },
    });
    const { outcome, calls } = await run({ state });
    assert.equal(reasonOf(outcome), 'recovery_scope_invalid');
    assert.equal(calls.recovery, 0);
  });

  it('요청서에는 남은 28개만 들어간다', async () => {
    const { payloads } = await run();
    const sent = JSON.parse(payloads[0].input as string);

    assert.equal(sent.remainingUrls.length, 28);
    assert.equal(sent.requiredAdditionalInspections, 6);
    assert.equal(sent.remainingUrls.includes(url(0)), false);
    assert.equal(sent.remainingUrls.includes(url(1)), false);
  });

  it('요청서에 표 번호도 첫 번째 초안도 들어가지 않는다', async () => {
    const { payloads } = await run();
    const text = JSON.stringify(payloads[0]);
    for (const banned of [
      'recoveryId',
      'primaryDraft',
      'primaryInspectedUrls',
      'activeCoveredHash',
      '연구 자료 0',
      '유료 장벽',
    ]) {
      assert.equal(text.includes(banned), false, banned);
    }
    // 이미 확인한 주소는 고를 수도, 목록에 볼 수도 없다.
    // (fixture-1은 fixture-10의 앞부분이므로 문자열 포함이 아니라 정확히 견준다)
    const sent = JSON.parse(payloads[0].input as string).remainingUrls as string[];
    const schema = (payloads[0].text as { format: { schema: Record<string, unknown> } }).format.schema;
    const props = schema.properties as Record<string, { items: { properties: { url: { enum: string[] } } } }>;
    for (const list of [sent, props.sources.items.properties.url.enum, props.rejectedSources.items.properties.url.enum]) {
      assert.equal(list.includes(url(0)), false);
      assert.equal(list.includes(url(1)), false);
    }
  });
});

describe('Request B 실행 · 응답 검사', () => {
  it('요청이 실패하면 다시 부르지 않는다', async () => {
    const { outcome, calls } = await run({ throws: true });
    assert.equal(reasonOf(outcome), 'recovery_request_failed');
    assert.equal(calls.recovery, 1);
    assert.equal(outcome.status === 'recheck' && outcome.recoveryToolDiagnostics, undefined);
  });

  it('응답이 끊겼으면 그 이유로 끝낸다', async () => {
    const { outcome } = await run({ response: recoveryResponse(recoveryDraft(), { status: 'incomplete' }) });
    assert.equal(reasonOf(outcome), 'recovery_incomplete');
  });

  it('모델이 거절하면 그 이유로 끝낸다', async () => {
    const { outcome } = await run({ response: recoveryResponse(recoveryDraft(), { refusal: true }) });
    assert.equal(reasonOf(outcome), 'recovery_refusal');
  });

  it('형식이 깨졌으면 그 이유로 끝낸다', async () => {
    const { outcome } = await run({ response: recoveryResponse(recoveryDraft(), { text: '{ 깨진' }) });
    assert.equal(reasonOf(outcome), 'recovery_response_invalid');

    const notObject = await run({ response: { status: 'completed', output: [] } });
    assert.equal(reasonOf(notObject.outcome), 'recovery_response_invalid');
  });

  it('영역·근거 판본·판단 시점이 다르면 끝낸다', async () => {
    for (const patch of [
      { targetDomain: 'burnout_exhaustion' },
      { evidenceVersion: 2 },
      { prioritizerSnapshotId: `snap_${'a'.repeat(64)}` },
    ]) {
      const { outcome } = await run({ response: recoveryResponse(recoveryDraft(patch)) });
      assert.equal(reasonOf(outcome), 'recovery_response_invalid', JSON.stringify(patch));
    }
  });
});

describe('Request B 실행 · 실제로 연 주소의 범위', () => {
  it('범위 밖 주소를 열면 멈춘다', async () => {
    const { outcome } = await run({
      response: recoveryResponse(recoveryDraft(), {
        inspected: [url(2), url(3), url(4), url(5), url(6), outside(0)],
      }),
    });
    assert.equal(reasonOf(outcome), 'recovery_url_out_of_scope');
    assert.ok(outcome.status === 'recheck' && outcome.recoveryToolDiagnostics);
  });

  it('페이지 안에서 찾아본 것도 같은 규칙이다', async () => {
    const { outcome } = await run({
      response: recoveryResponse(recoveryDraft(), {
        inspected: [url(2), url(3), url(4), url(5), url(6), url(7)],
        finds: [outside(1)],
      }),
    });
    assert.equal(reasonOf(outcome), 'recovery_url_out_of_scope');
  });

  it('이미 확인한 주소를 다시 열어도 범위 밖이다', async () => {
    const { outcome } = await run({
      response: recoveryResponse(recoveryDraft(), {
        inspected: [url(0), url(2), url(3), url(4), url(5), url(6)],
      }),
    });
    assert.equal(reasonOf(outcome), 'recovery_url_out_of_scope');
  });

  it('검색 결과에만 나타난 범위 밖 주소는 문제 삼지 않는다', async () => {
    const { outcome } = await run({
      response: recoveryResponse(recoveryDraft(), { searched: [outside(0), outside(1)] }),
    });
    assert.equal(outcome.status, 'ready_to_materialize');
  });

  it('초안이 범위 밖 주소를 적으면 멈춘다', async () => {
    const bySource = await run({
      response: recoveryResponse(recoveryDraft({ sources: [draftSource(2, { url: outside(0) })] })),
    });
    assert.equal(reasonOf(bySource.outcome), 'recovery_url_out_of_scope');

    const byRejected = await run({
      response: recoveryResponse(recoveryDraft({ rejectedSources: [rejectedEntry(3, { url: outside(0) })] })),
    });
    assert.equal(reasonOf(byRejected.outcome), 'recovery_url_out_of_scope');
  });

  it('초안의 주소를 정리할 수 없으면 형식 문제로 끝낸다', async () => {
    const { outcome } = await run({
      response: recoveryResponse(recoveryDraft({ sources: [draftSource(2, { url: 'not a url' })] })),
    });
    assert.equal(reasonOf(outcome), 'recovery_response_invalid');
  });
});

describe('Request B 실행 · 이번에 확인한 것만 남긴다', () => {
  const authoritative = (draft: Record<string, unknown>, inspected: readonly string[]) =>
    buildAuthoritativeRecoveryDraft({
      draft: draft as never,
      remainingUrls: urls(30).slice(2),
      recoveryInspectedUrls: inspected,
    });

  it('열어 본 자료만 남는다', () => {
    const outcome = authoritative(
      recoveryDraft({ sources: [draftSource(2), draftSource(9)] }),
      [url(2)],
    );
    assert.equal(outcome.ok, true);
    if (!outcome.ok) return;
    assert.deepEqual(outcome.draft.sources.map((s) => s.url), [url(2)]);
  });

  it('열어 보지 않은 제외 기록도 남지 않는다', () => {
    const outcome = authoritative(
      recoveryDraft({ rejectedSources: [rejectedEntry(3), rejectedEntry(9)] }),
      [url(3)],
    );
    assert.equal(outcome.ok, true);
    if (!outcome.ok) return;
    assert.deepEqual(outcome.draft.rejectedSources.map((r) => r.url), [url(3)]);
  });

  it('sourceId도 확인 날짜도 만들지 않는다', () => {
    const outcome = authoritative(recoveryDraft(), [url(2), url(3)]);
    assert.equal(outcome.ok, true);
    if (!outcome.ok) return;

    const text = JSON.stringify(outcome.draft);
    assert.equal(text.includes('sourceId'), false);
    assert.equal(text.includes('accessedAt'), false);
    assert.equal(text.includes('src_'), false);
    assert.deepEqual(Object.keys(outcome.draft.sources[0]).sort(), [
      'accessLevel',
      'authorOrOrganization',
      'evidenceClaims',
      'intendedUse',
      'publicationYear',
      'publisherOrInstitution',
      'relevanceNote',
      'sourceType',
      'title',
      'url',
    ]);
  });

  it('모르는 것 목록은 순서 그대로 옮긴다', () => {
    const outcome = authoritative(
      recoveryDraft({ unresolvedSourceQuestions: ['가', '나', '다'] }),
      [url(2)],
    );
    assert.equal(outcome.ok, true);
    if (!outcome.ok) return;
    assert.deepEqual(outcome.draft.unresolvedSourceQuestions, ['가', '나', '다']);
  });

  it('같은 자료가 두 번 있거나 채택·제외가 겹치면 멈춘다', () => {
    const dupSource = authoritative(
      recoveryDraft({ sources: [draftSource(2), draftSource(2)] }),
      [url(2)],
    );
    assert.equal(dupSource.ok === false && dupSource.reason, 'recovery_contract_invalid');

    const dupRejected = authoritative(
      recoveryDraft({ rejectedSources: [rejectedEntry(3), rejectedEntry(3)] }),
      [url(3)],
    );
    assert.equal(dupRejected.ok === false && dupRejected.reason, 'recovery_contract_invalid');

    const collision = authoritative(
      recoveryDraft({ sources: [draftSource(2)], rejectedSources: [rejectedEntry(2)] }),
      [url(2)],
    );
    assert.equal(collision.ok === false && collision.reason, 'recovery_contract_invalid');
  });

  it('실행 전체에서도 같은 판단을 한다', async () => {
    const { outcome } = await run({
      response: recoveryResponse(recoveryDraft({ sources: [draftSource(2), draftSource(2)] })),
    });
    assert.equal(reasonOf(outcome), 'recovery_contract_invalid');
  });
});

describe('Request B 실행 · 확인 범위', () => {
  it('필요한 만큼 열지 못하면 합치지 않는다', async () => {
    const { outcome } = await run({
      response: recoveryResponse(recoveryDraft(), {
        inspected: [url(2), url(3), url(4), url(5), url(6)],
      }),
    });
    assert.equal(reasonOf(outcome), 'insufficient_recovery_inspection');
    assert.ok(outcome.status === 'recheck' && outcome.recoveryToolDiagnostics);
  });

  it('정확히 필요한 만큼 열면 통과한다', async () => {
    const { outcome } = await run({
      response: recoveryResponse(recoveryDraft(), {
        inspected: [url(2), url(3), url(4), url(5), url(6), url(7)],
      }),
    });
    assert.equal(outcome.status, 'ready_to_materialize');
  });

  it('더 많이 열어도 통과한다', async () => {
    const { outcome } = await run({
      response: recoveryResponse(recoveryDraft(), {
        inspected: [url(2), url(3), url(4), url(5), url(6), url(7), url(8)],
      }),
    });
    assert.equal(outcome.status, 'ready_to_materialize');
  });

  it('같은 주소를 여러 번 열어도 하나로 센다', async () => {
    const { outcome } = await run({
      response: recoveryResponse(recoveryDraft(), {
        inspected: [url(2), url(2), url(2), url(2), url(2), url(2)],
        finds: [url(2), url(2)],
      }),
    });
    assert.equal(reasonOf(outcome), 'insufficient_recovery_inspection');
    assert.equal(
      outcome.status === 'recheck' && outcome.recoveryToolDiagnostics?.uniqueInspectedUrlCount,
      1,
    );
  });

  it('잘못된 초안을 확인 범위 부족으로 덮지 않는다', async () => {
    // 범위 밖 주소를 적었고 열어 본 수도 모자란다. 앞의 문제로 끝나야 한다.
    const { outcome } = await run({
      response: recoveryResponse(
        recoveryDraft({ sources: [draftSource(2, { url: outside(0) })] }),
        { inspected: [url(2)] },
      ),
    });
    assert.equal(reasonOf(outcome), 'recovery_url_out_of_scope');
  });
});

describe('Request B 실행 · 합치기', () => {
  it('두 번 합쳐 열어 본 주소는 받은 순서를 따른다', () => {
    const combined = combineInspectedUrls({
      discoveredUrls: [url(5), url(0), url(9), url(2), url(7)],
      primaryInspectedUrls: [url(9), url(5)],
      recoveryInspectedUrls: [url(7), url(2)],
    });
    // 도구를 쓴 순서가 아니라 받은 목록의 순서다.
    assert.deepEqual(combined, [url(5), url(9), url(2), url(7)]);
  });

  it('겹치는 주소가 있어도 한 번만 센다', () => {
    const combined = combineInspectedUrls({
      discoveredUrls: urls(5),
      primaryInspectedUrls: [url(0), url(1)],
      recoveryInspectedUrls: [url(1), url(2)],
    });
    assert.deepEqual(combined, [url(0), url(1), url(2)]);
  });

  it('첫 번째 것을 앞에, 이어서 확인한 것을 뒤에 둔다', async () => {
    const { outcome } = await run();
    assert.equal(outcome.status, 'ready_to_materialize');
    if (outcome.status !== 'ready_to_materialize') return;

    assert.deepEqual(outcome.mergedDraft.sources.map((s) => s.url), [url(0), url(2)]);
    assert.deepEqual(outcome.mergedDraft.rejectedSources.map((r) => r.url), [url(1), url(3)]);
    assert.deepEqual(outcome.mergedDraft.unresolvedSourceQuestions, ['유료 장벽', '출판 연도 미확인']);
  });

  it('겹치는 질문 문장도 임의로 지우지 않는다', async () => {
    const { outcome } = await run({
      response: recoveryResponse(recoveryDraft({ unresolvedSourceQuestions: ['유료 장벽'] })),
    });
    if (outcome.status !== 'ready_to_materialize') return assert.fail(reasonOf(outcome));
    assert.deepEqual(outcome.mergedDraft.unresolvedSourceQuestions, ['유료 장벽', '유료 장벽']);
  });

  it('합친 결과의 머리말은 표의 값에서 온다', async () => {
    const { outcome } = await run();
    if (outcome.status !== 'ready_to_materialize') return assert.fail(reasonOf(outcome));
    assert.equal(outcome.mergedDraft.targetDomain, DOMAIN);
    assert.equal(outcome.mergedDraft.evidenceVersion, 1);
    assert.equal(outcome.mergedDraft.prioritizerSnapshotId, SNAPSHOT);
  });

  it('두 단계 사이에 같은 주소가 겹치면 멈춘다', () => {
    const merged = mergePrimaryAndRecoveryDrafts({
      brief: { targetDomain: DOMAIN, domainDescription: 'd', evidenceVersion: 1, prioritizerSnapshotId: SNAPSHOT, activeCoveredDomains: [...covered] },
      primaryDraft: { sources: [draftSource(0)], rejectedSources: [], unresolvedSourceQuestions: [] } as never,
      recoveryDraft: { sources: [draftSource(0)], rejectedSources: [], unresolvedSourceQuestions: [] } as never,
    });
    assert.equal(merged.ok === false && merged.reason, 'recovery_contract_invalid');

    const dupRejected = mergePrimaryAndRecoveryDrafts({
      brief: { targetDomain: DOMAIN, domainDescription: 'd', evidenceVersion: 1, prioritizerSnapshotId: SNAPSHOT, activeCoveredDomains: [...covered] },
      primaryDraft: { sources: [], rejectedSources: [rejectedEntry(1)], unresolvedSourceQuestions: [] } as never,
      recoveryDraft: { sources: [], rejectedSources: [rejectedEntry(1)], unresolvedSourceQuestions: [] } as never,
    });
    assert.equal(dupRejected.ok === false && dupRejected.reason, 'recovery_contract_invalid');

    const collision = mergePrimaryAndRecoveryDrafts({
      brief: { targetDomain: DOMAIN, domainDescription: 'd', evidenceVersion: 1, prioritizerSnapshotId: SNAPSHOT, activeCoveredDomains: [...covered] },
      primaryDraft: { sources: [draftSource(0)], rejectedSources: [], unresolvedSourceQuestions: [] } as never,
      recoveryDraft: { sources: [], rejectedSources: [rejectedEntry(0)], unresolvedSourceQuestions: [] } as never,
    });
    assert.equal(collision.ok === false && collision.reason, 'recovery_contract_invalid');
  });

  it('합친 개수가 상한을 넘으면 멈춘다', () => {
    const brief = { targetDomain: DOMAIN, domainDescription: 'd', evidenceVersion: 1, prioritizerSnapshotId: SNAPSHOT, activeCoveredDomains: [...covered] };
    const many = (from: number, count: number) =>
      Array.from({ length: count }, (_, i) => draftSource(0, { url: url(from + i) }));

    const overAccepted = mergePrimaryAndRecoveryDrafts({
      brief,
      primaryDraft: { sources: many(0, 7), rejectedSources: [], unresolvedSourceQuestions: [] } as never,
      recoveryDraft: { sources: many(7, ACCEPTED_MAX - 6), rejectedSources: [], unresolvedSourceQuestions: [] } as never,
    });
    assert.equal(overAccepted.ok === false && overAccepted.reason, 'recovery_contract_invalid');

    const manyRejected = (from: number, count: number) =>
      Array.from({ length: count }, (_, i) => rejectedEntry(0, { url: url(from + i) }));
    const overRejected = mergePrimaryAndRecoveryDrafts({
      brief,
      primaryDraft: { sources: [], rejectedSources: manyRejected(0, 6), unresolvedSourceQuestions: [] } as never,
      recoveryDraft: { sources: [], rejectedSources: manyRejected(6, REJECTED_SOURCE_MAX - 5), unresolvedSourceQuestions: [] } as never,
    });
    assert.equal(overRejected.ok === false && overRejected.reason, 'recovery_contract_invalid');
  });

  it('상한 숫자를 이 파일에 다시 적지 않는다', () => {
    const source = read('../../supabase/functions/_shared/source-harvester-recovery-execution.ts');
    assert.ok(source.includes('ACCEPTED_MAX'));
    assert.ok(source.includes('REJECTED_SOURCE_MAX'));
    assert.equal(/>\s*1[02]\b/.test(source), false);
  });
});

describe('Request B 실행 · 성공 결과', () => {
  it('자료를 만들 수 있는 상태만 돌려준다', async () => {
    const { outcome } = await run();
    assert.equal(outcome.status, 'ready_to_materialize');
    if (outcome.status !== 'ready_to_materialize') return;

    assert.deepEqual(Object.keys(outcome).sort(), [
      'brief',
      'combinedInspectedUrls',
      'mergedDraft',
      'recoveryToolDiagnostics',
      'status',
    ]);
    assert.equal(outcome.brief.targetDomain, DOMAIN);
    assert.equal(outcome.combinedInspectedUrls.length, 8);
    assert.equal(Object.keys(outcome.recoveryToolDiagnostics).length, 6);
  });

  it('합쳐 열어 본 주소가 처음 목표를 채운다', async () => {
    const { outcome } = await run();
    if (outcome.status !== 'ready_to_materialize') return assert.fail(reasonOf(outcome));
    // 첫 번째 2개 + 이어서 6개 = 8개, 목표와 같다.
    assert.deepEqual(outcome.combinedInspectedUrls, urls(8));
  });

  it('결과 어디에도 sourceId와 확인 날짜가 없다', async () => {
    const { outcome } = await run();
    const text = JSON.stringify(outcome);
    assert.equal(text.includes('sourceId'), false);
    assert.equal(text.includes('accessedAt'), false);
    assert.equal(text.includes('src_'), false);
  });

  it('자료를 완성하지 않는다', () => {
    const source = read('../../supabase/functions/_shared/source-harvester-recovery-execution.ts');
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '');
    assert.equal(code.includes('materializeHarvestResult'), false);
    assert.equal(code.includes('computeSourceId'), false);
    assert.equal(code.includes('toISOString'), false);
  });
});

describe('Request B 실행 · 아직 연결하지 않음', () => {
  it('실행 파일에 바깥으로 나가는 길이 없다', () => {
    const source = read('../../supabase/functions/_shared/source-harvester-recovery-execution.ts');
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '');
    for (const banned of ['Deno.env', 'fetch(', 'process.env', 'createClient', '/rest/v1/', 'SUPABASE_', 'api.openai.com']) {
      assert.equal(code.includes(banned), false, banned);
    }
  });

  it('요청 처리 본체만 이 실행 본체를 쓴다', () => {
    assert.ok(read('../../supabase/functions/source-harvester/handler.ts')
      .includes('source-harvester-recovery-execution'));

    // 첫 번째 요청의 실행 본체는 이어서 하기를 모른다.
    const execution = read('../../supabase/functions/_shared/source-harvester-execution.ts');
    assert.equal(execution.includes('source-harvester-recovery-execution'), false);
    assert.equal(execution.includes('source-harvester-recovery-contract'), false);
    assert.equal(execution.includes('consume_harvest_recovery_ticket'), false);
  });

  it('첫 번째 요청 입구는 그대로다', () => {
    const handler = read('../../supabase/functions/source-harvester/handler.ts');
    // 네 항목을 받는 첫 번째 요청 검사는 그대로 있다.
    assert.ok(handler.includes("'activeCoveredDomains',"));
    assert.ok(handler.includes('parseHarvestRequest'));
    assert.ok(handler.includes('runSourceHarvest('));
  });
});

describe('Request B 실행 · 자료 규칙 (지금은 쓰이지 않는 예전 방식)', () => {
  /**
   * 이 실행 본체는 지금 production 경로에서 쓰이지 않는다.
   * 그래도 남겨 두었으므로, 공용 자료 규칙이 여기에도 같게 적용되는지 확인한다.
   */
  it('규칙을 어긴 자료가 오면 형식 문제로 끝낸다', async () => {
    const cases: [string, Record<string, unknown>][] = [
      ['연도 범위 밖', { publicationYear: 3000 }],
      ['용도 중복', { intendedUse: ['exegesis', 'exegesis'] }],
      ['종류와 용도가 맞지 않음', { sourceType: 'pastoral_resource', intendedUse: ['exegesis'] }],
    ];

    for (const [label, patch] of cases) {
      const { outcome } = await run({
        response: recoveryResponse(
          recoveryDraft({ sources: [{ ...draftSource(2), ...patch }] }),
        ),
      });
      assert.equal(reasonOf(outcome), 'recovery_response_invalid', label);
    }
  });

  it('규칙을 지킨 경계값은 그대로 통과한다', async () => {
    for (const patch of [{ publicationYear: 1450 }, { publicationYear: 2100 }, { publicationYear: null }]) {
      const { outcome } = await run({
        response: recoveryResponse(
          recoveryDraft({ sources: [{ ...draftSource(2), ...patch }] }),
        ),
      });
      assert.equal(outcome.status, 'ready_to_materialize', JSON.stringify(patch));
    }
  });

  it('이 실행 본체는 여전히 쓰이지 않는다', () => {
    const handler = readFileSync(
      new URL('../../supabase/functions/source-harvester/handler.ts', import.meta.url),
      'utf8',
    );
    assert.equal(handler.includes('runSourceHarvestRecovery('), false);
    assert.ok(handler.includes('runParallelSourceHarvestRecovery('));
  });
});
