/**
 * 이어서 확인하기 · 주소 하나씩 나눠 확인하는 실행 본체 테스트
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
  aggregateSuccessfulInspections,
  runParallelSourceHarvestRecovery,
} from '../../supabase/functions/_shared/source-harvester-parallel-recovery-execution.ts';
import { computeActiveCoveredHash } from '../../supabase/functions/_shared/harvest-recovery-ticket.ts';
import { getActiveCoveredDomains } from '../../supabase/functions/_shared/research-prioritizer-edge.ts';
import {
  ACCEPTED_MAX,
  PUBLICATION_YEAR_MAX,
  PUBLICATION_YEAR_MIN,
  REJECTED_SOURCE_MAX,
  RELEVANCE_NOTE_MAX,
} from '../../supabase/functions/_shared/source-harvest-contract.ts';
import {
  SINGLE_INSPECTION_MAX_CONCURRENCY,
  SINGLE_INSPECTION_MAX_TOOL_CALLS,
  SINGLE_INSPECTION_SPARE_MAX,
  SINGLE_INSPECTION_TIMEOUT_MS,
  countInspectionWaves,
  planSingleUrlRecoveryInspections,
} from '../../supabase/functions/_shared/source-harvester-single-inspection-contract.ts';

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

const sourceFor = (target: string, index = 0, overrides: Record<string, unknown> = {}) => {
  const spec = SPECS[index % SPECS.length];
  // 근거의 용도는 그 자료가 실제로 가진 용도를 따라간다.
  // 용도를 바꾼 사본에서도 근거가 저절로 맞게 따라오도록 한다.
  const use = ((overrides.intendedUse as string[] | undefined) ?? spec.intendedUse)[0];
  return {
    sourceType: spec.sourceType,
    title: `연구 자료 ${index}`,
    authorOrOrganization: `연구자 ${index}`,
    publisherOrInstitution: spec.publisherOrInstitution,
    publicationYear: 2020,
    url: target,
    accessLevel: spec.accessLevel,
    intendedUse: [...spec.intendedUse],
    relevanceNote: '이 연구에 필요한 자료입니다.',
    evidenceClaims: [
      {
        intendedUse: use,
        statement: '이 자료는 해당 영역을 다루면서 본문의 문맥과 그 신학적 자리를 함께 설명한다고 관찰되었다.',
        passageReferences:
          use === 'exegesis' ? [{ book: 'Psalms', chapter: 42, startVerse: 5, endVerse: 5 }] : [],
      },
    ],
    ...overrides,
  };
};

const rejectedFor = (target: string, overrides: Record<string, unknown> = {}) => ({
  url: target,
  title: '익명 묵상글',
  rejectionReason: 'anonymous_or_unverifiable',
  ...overrides,
});

const openPageCall = (target: string) => ({
  type: 'web_search_call', status: 'completed',
  action: { type: 'open_page', url: target },
});
const findInPageCall = (target: string) => ({
  type: 'web_search_call', status: 'completed',
  action: { type: 'find_in_page', url: target },
});
const searchCall = (found: readonly string[]) => ({
  type: 'web_search_call', status: 'completed',
  action: { type: 'search', query: 'q', sources: found.map((u) => ({ type: 'url', url: u })) },
});

/** 확인 작업 하나의 정상 응답: 그 주소를 열고, 자료 한 건을 채택 */
const taskResponse = (
  target: string,
  options: {
    draft?: unknown;
    inspected?: readonly string[];
    finds?: readonly string[];
    searched?: readonly string[];
    status?: string;
    refusal?: boolean;
    text?: string;
    noTool?: boolean;
  } = {},
) => {
  const draft = options.draft ?? {
    targetDomain: DOMAIN,
    evidenceVersion: 1,
    prioritizerSnapshotId: SNAPSHOT,
    sources: [sourceFor(target)],
    rejectedSources: [],
    unresolvedSourceQuestions: [],
  };

  const output: unknown[] = [];
  if (!options.noTool) {
    if (options.searched) output.push(searchCall(options.searched));
    for (const t of options.inspected ?? [target]) output.push(openPageCall(t));
    for (const t of options.finds ?? []) output.push(findInPageCall(t));
  }

  if (options.refusal) {
    output.push({ type: 'message', content: [{ type: 'refusal', refusal: '답할 수 없습니다.' }] });
  } else {
    output.push({
      type: 'message',
      content: [{ type: 'output_text', text: options.text ?? JSON.stringify(draft), annotations: [] }],
    });
  }
  return { status: options.status ?? 'completed', output };
};

/** 표에서 꺼낸 상태. 받은 30개 중 4개 확인 (v23 실측과 같은 모양) */
const ticketState = async (overrides: Record<string, unknown> = {}) => ({
  targetDomain: DOMAIN,
  evidenceVersion: 1,
  prioritizerSnapshotId: SNAPSHOT,
  activeCoveredHash: await computeActiveCoveredHash(covered),
  discoveredUrls: urls(30),
  primaryInspectedUrls: urls(4),
  primaryDraft: {
    sources: [sourceFor(url(0), 0)],
    rejectedSources: [rejectedFor(url(1))],
    unresolvedSourceQuestions: ['유료 장벽'],
  },
  primaryToolCounts: {
    webSearchCallCount: 4, searchActionCount: 0, openPageActionCount: 4,
    findInPageActionCount: 0, unknownActionCount: 0, uniqueInspectedUrlCount: 4,
  },
  ...overrides,
});

/**
 * 실행 한 번.
 * respond(target, callIndex) 로 각 작업의 응답을 정한다. throw하면 그 작업만 실패한다.
 */
const run = async (options: {
  state?: unknown;
  activeCovered?: readonly string[];
  respond?: (target: string, callIndex: number) => unknown | Promise<unknown>;
} = {}) => {
  const state = 'state' in options ? options.state : await ticketState();
  const targets: string[] = [];
  const timeouts: number[] = [];
  let started = 0;
  let peakConcurrent = 0;
  let inFlight = 0;

  const outcome = await runParallelSourceHarvestRecovery(
    { ticketState: state, activeCoveredDomains: options.activeCovered ?? covered },
    {
      callInspection: async (payload, callOptions) => {
        const target = JSON.parse(payload.input as string).targetUrl as string;
        const callIndex = started;
        started += 1;
        targets.push(target);
        timeouts.push(callOptions.timeoutMs);

        inFlight += 1;
        peakConcurrent = Math.max(peakConcurrent, inFlight);
        try {
          // 같은 묶음의 요청이 함께 떠 있는지 보기 위해 한 번 양보한다.
          await Promise.resolve();
          const value = options.respond ? await options.respond(target, callIndex) : taskResponse(target);
          return value;
        } finally {
          inFlight -= 1;
        }
      },
      log: () => {},
    },
  );

  return { outcome, targets, timeouts, get calls() { return targets.length; }, get peakConcurrent() { return peakConcurrent; } };
};

const reasonOf = (outcome: Awaited<ReturnType<typeof run>>['outcome']) =>
  outcome.status === 'recheck' ? outcome.reason : '';

const diagOf = (outcome: Awaited<ReturnType<typeof run>>['outcome']) =>
  outcome.status === 'recheck' ? outcome.parallelInspectionDiagnostics : outcome.parallelInspectionDiagnostics;

/* ------------------------------------------------------------------ */

describe('병렬 확인 · 모델을 부르기 전', () => {
  it('표가 잘못되면 아무 요청도 보내지 않는다', async () => {
    for (const bad of [null, {}, 'state', { targetDomain: DOMAIN }]) {
      const { outcome, calls } = await run({ state: bad });
      assert.equal(reasonOf(outcome), 'recovery_ticket_invalid');
      assert.equal(calls, 0);
    }
  });

  it('표에 담긴 첫 결과가 약속을 어기면 보내지 않는다', async () => {
    // url(9)는 받은 주소이지만 1단계에서 열어 본 적이 없다.
    const state = await ticketState({
      primaryDraft: { sources: [sourceFor(url(9))], rejectedSources: [], unresolvedSourceQuestions: [] },
    });
    const { outcome, calls } = await run({ state });
    assert.equal(reasonOf(outcome), 'recovery_ticket_invalid');
    assert.equal(calls, 0);
  });

  it('영역이 달라졌으면 보내지 않는다', async () => {
    const { outcome, calls } = await run({ activeCovered: covered.slice(1) });
    assert.equal(reasonOf(outcome), 'recovery_coverage_changed');
    assert.equal(calls, 0);
  });

  it('범위를 정할 수 없으면 보내지 않는다', async () => {
    const state = await ticketState({
      primaryInspectedUrls: urls(8),
      primaryDraft: { sources: [], rejectedSources: [], unresolvedSourceQuestions: [] },
      primaryToolCounts: {
        webSearchCallCount: 8, searchActionCount: 0, openPageActionCount: 8,
        findInPageActionCount: 0, unknownActionCount: 0, uniqueInspectedUrlCount: 8,
      },
    });
    const { outcome, calls } = await run({ state });
    assert.equal(reasonOf(outcome), 'recovery_scope_invalid');
    assert.equal(calls, 0);
  });

  it('v23 실측 상황이면 8개를 계획한다', async () => {
    // 받은 30, 1단계 4 → 목표 8, 남은 26, 더 필요한 수 4 → 필요 4 + 여유 4
    const { outcome, targets } = await run();
    assert.equal(outcome.status, 'ready_to_materialize');
    assert.equal(targets.length, 8);
    assert.deepEqual(targets, urls(30).slice(4, 12));
    assert.equal(diagOf(outcome)?.plannedTaskCount, 8);
  });

  it('검사 규칙을 새로 만들지 않는다', () => {
    const source = read('../../supabase/functions/_shared/source-harvester-parallel-recovery-execution.ts');
    for (const helper of [
      'parseHarvestRecoveryTicketState',
      'validateStoredPrimaryAuthority',
      'matchesRecoveryCoverageSnapshot',
      'deriveRecoveryScope',
      'buildSourceHarvestBrief',
      'planSingleUrlRecoveryInspections',
      'buildSingleInspectionPayload',
      'combineInspectedUrls',
      'mergePrimaryAndRecoveryDrafts',
    ]) {
      assert.ok(source.includes(helper), helper);
    }
  });
});

describe('병렬 확인 · 나누어 보내기', () => {
  it('한 묶음의 요청은 동시에 나간다', async () => {
    const { peakConcurrent, calls } = await run();
    assert.equal(calls, 8);
    assert.equal(peakConcurrent, 8);
    assert.equal(SINGLE_INSPECTION_MAX_CONCURRENCY, 8);
  });

  it('요청마다 정해진 시간 제한을 전달한다', async () => {
    const { timeouts } = await run();
    assert.deepEqual(timeouts, Array(8).fill(SINGLE_INSPECTION_TIMEOUT_MS));
    assert.equal(SINGLE_INSPECTION_TIMEOUT_MS, 45_000);
  });

  it('앞 묶음으로 충분하면 뒤 묶음을 보내지 않는다', async () => {
    // 1단계 0개 확인 → 목표 8, 필요 8 → 계획 12개, 한 묶음 8개
    const state = await ticketState({
      primaryInspectedUrls: [],
      primaryDraft: { sources: [], rejectedSources: [], unresolvedSourceQuestions: [] },
      primaryToolCounts: {
        webSearchCallCount: 1, searchActionCount: 1, openPageActionCount: 0,
        findInPageActionCount: 0, unknownActionCount: 0, uniqueInspectedUrlCount: 0,
      },
    });
    const { outcome, calls } = await run({
      state,
      respond: (target) => taskResponse(target, { draft: {
        targetDomain: DOMAIN, evidenceVersion: 1, prioritizerSnapshotId: SNAPSHOT,
        sources: [], rejectedSources: [], unresolvedSourceQuestions: [],
      } }),
    });

    assert.equal(outcome.status, 'ready_to_materialize');
    assert.equal(diagOf(outcome)?.plannedTaskCount, 12);
    // 앞 8개가 모두 성공했으므로 나머지 4개는 보내지 않는다.
    assert.equal(calls, 8);
    assert.equal(diagOf(outcome)?.wavesExecuted, 1);
  });

  it('앞 묶음이 모자라면 뒤 묶음을 보낸다', async () => {
    const state = await ticketState({
      primaryInspectedUrls: [],
      primaryDraft: { sources: [], rejectedSources: [], unresolvedSourceQuestions: [] },
      primaryToolCounts: {
        webSearchCallCount: 1, searchActionCount: 1, openPageActionCount: 0,
        findInPageActionCount: 0, unknownActionCount: 0, uniqueInspectedUrlCount: 0,
      },
    });
    const emptyDraft = {
      targetDomain: DOMAIN, evidenceVersion: 1, prioritizerSnapshotId: SNAPSHOT,
      sources: [], rejectedSources: [], unresolvedSourceQuestions: [],
    };
    const { outcome, calls, targets } = await run({
      state,
      // 앞 8개 중 2개는 실패한다.
      respond: (target, index) =>
        index < 2 ? taskResponse(target, { draft: emptyDraft, inspected: [] })
                  : taskResponse(target, { draft: emptyDraft }),
    });

    assert.equal(outcome.status, 'ready_to_materialize');
    assert.equal(diagOf(outcome)?.wavesExecuted, 2);
    assert.equal(calls, 12);
    // 뒤 묶음은 앞과 다른 주소다. 같은 주소를 다시 부르지 않는다.
    assert.equal(new Set(targets).size, 12);
  });

  it('요청이 실패해도 같은 묶음의 다른 결과를 잃지 않는다', async () => {
    const { outcome } = await run({
      respond: (target, index) => {
        if (index === 0 || index === 1) throw new Error('timeout');
        return taskResponse(target);
      },
    });

    assert.equal(outcome.status, 'ready_to_materialize');
    const d = diagOf(outcome);
    assert.equal(d?.attemptedTaskCount, 8);
    assert.equal(d?.successfulTaskCount, 6);
    assert.equal(d?.failedTaskCount, 2);
  });

  it('한 요청을 다시 부르지 않는다', async () => {
    const { targets } = await run({
      respond: (target, index) => (index === 0 ? Promise.reject(new Error('timeout')) : taskResponse(target)),
    });
    assert.equal(new Set(targets).size, targets.length);
  });
});

describe('병렬 확인 · 작업 하나의 성공 조건', () => {
  /** 첫 작업만 특별하게 답하고 나머지는 정상으로 답한다. */
  const withFirst = async (first: unknown) =>
    run({ respond: (target, index) => (index === 0 ? first : taskResponse(target)) });

  it('맡은 주소를 열면 성공이다', async () => {
    const { outcome } = await run();
    assert.equal(diagOf(outcome)?.successfulTaskCount, 8);
  });

  it('페이지 안에서 찾아본 것도 성공이다', async () => {
    const { outcome } = await run({
      respond: (target) => taskResponse(target, { inspected: [], finds: [target] }),
    });
    assert.equal(diagOf(outcome)?.successfulTaskCount, 8);
  });

  it('검색만 하면 실패다', async () => {
    const target = url(4);
    const { outcome } = await withFirst(taskResponse(target, { inspected: [], searched: [target] }));
    assert.equal(diagOf(outcome)?.successfulTaskCount, 7);
  });

  it('도구를 아예 쓰지 않으면 실패다', async () => {
    const { outcome } = await withFirst(taskResponse(url(4), { noTool: true }));
    assert.equal(diagOf(outcome)?.successfulTaskCount, 7);
  });

  it('맡지 않은 주소만 열면 실패다', async () => {
    const { outcome } = await withFirst(taskResponse(url(4), { inspected: [outside(0)] }));
    assert.equal(diagOf(outcome)?.successfulTaskCount, 7);
  });

  it('맡은 주소를 열었어도 다른 주소를 함께 열면 실패다', async () => {
    const { outcome } = await withFirst(taskResponse(url(4), { inspected: [url(4), outside(0)] }));
    assert.equal(diagOf(outcome)?.successfulTaskCount, 7);
  });

  it('검색 결과에만 다른 주소가 보이는 것은 문제가 아니다', async () => {
    const { outcome } = await run({
      respond: (target) => taskResponse(target, { searched: [outside(0), outside(1)] }),
    });
    assert.equal(diagOf(outcome)?.successfulTaskCount, 8);
  });

  it('열었어도 답이 온전하지 않으면 실패다', async () => {
    for (const broken of [
      taskResponse(url(4), { text: '{ 깨진' }),
      taskResponse(url(4), { refusal: true }),
      taskResponse(url(4), { status: 'incomplete' }),
      taskResponse(url(4), { draft: { targetDomain: 'burnout_exhaustion', evidenceVersion: 1, prioritizerSnapshotId: SNAPSHOT, sources: [], rejectedSources: [], unresolvedSourceQuestions: [] } }),
    ]) {
      const { outcome } = await withFirst(broken);
      assert.equal(diagOf(outcome)?.successfulTaskCount, 7);
    }
  });

  it('한 작업은 자료도 제외도 하나씩만 적을 수 있다', async () => {
    const target = url(4);
    const bad = [
      { sources: [sourceFor(target, 0), sourceFor(target, 1)], rejectedSources: [] },
      { sources: [], rejectedSources: [rejectedFor(target), rejectedFor(target)] },
      { sources: [sourceFor(target)], rejectedSources: [rejectedFor(target)] },
      { sources: [sourceFor(outside(0))], rejectedSources: [] },
      { sources: [], rejectedSources: [rejectedFor(outside(0))] },
    ];

    for (const patch of bad) {
      const { outcome } = await withFirst(
        taskResponse(target, {
          draft: { targetDomain: DOMAIN, evidenceVersion: 1, prioritizerSnapshotId: SNAPSHOT, unresolvedSourceQuestions: [], ...patch },
        }),
      );
      assert.equal(diagOf(outcome)?.successfulTaskCount, 7, JSON.stringify(patch).slice(0, 50));
    }
  });

  it('아무것도 채택하지 않아도 성공일 수 있다', async () => {
    const { outcome } = await run({
      respond: (target) => taskResponse(target, {
        draft: { targetDomain: DOMAIN, evidenceVersion: 1, prioritizerSnapshotId: SNAPSHOT, sources: [], rejectedSources: [], unresolvedSourceQuestions: [] },
      }),
    });
    assert.equal(diagOf(outcome)?.successfulTaskCount, 8);
  });

  it('제외 기록만 적어도 성공이다', async () => {
    const { outcome } = await run({
      respond: (target) => taskResponse(target, {
        draft: { targetDomain: DOMAIN, evidenceVersion: 1, prioritizerSnapshotId: SNAPSHOT, sources: [], rejectedSources: [rejectedFor(target)], unresolvedSourceQuestions: [] },
      }),
    });
    assert.equal(diagOf(outcome)?.successfulTaskCount, 8);
  });
});

describe('병렬 확인 · 부분 실패와 확인 범위', () => {
  /** 앞에서 n개만 성공시킨다. */
  const successCount = async (n: number) =>
    run({ respond: (target, index) => (index < n ? taskResponse(target) : taskResponse(target, { inspected: [] })) });

  it('필요한 수를 채우면 이어서 진행한다', async () => {
    const four = await successCount(4);
    assert.equal(four.outcome.status, 'ready_to_materialize');
  });

  it('더 많이 성공해도 진행한다', async () => {
    const seven = await successCount(7);
    assert.equal(seven.outcome.status, 'ready_to_materialize');
    assert.equal(diagOf(seven.outcome)?.successfulTaskCount, 7);
  });

  it('모자라면 합치지 않고 멈춘다', async () => {
    const three = await successCount(3);
    assert.equal(reasonOf(three.outcome), 'insufficient_recovery_inspection');
    assert.equal(diagOf(three.outcome)?.successfulTaskCount, 3);
  });

  it('실패한 작업의 자료 설명은 하나도 들어가지 않는다', async () => {
    const failedTitle = '들어가면 안 되는 자료';
    const { outcome } = await run({
      respond: (target, index) =>
        index < 4
          ? taskResponse(target)
          : taskResponse(target, {
              inspected: [],
              draft: {
                targetDomain: DOMAIN, evidenceVersion: 1, prioritizerSnapshotId: SNAPSHOT,
                sources: [sourceFor(target, 0, { title: failedTitle })],
                rejectedSources: [], unresolvedSourceQuestions: ['들어가면 안 되는 질문'],
              },
            }),
    });

    assert.equal(outcome.status, 'ready_to_materialize');
    const text = JSON.stringify(outcome);
    assert.equal(text.includes(failedTitle), false);
    assert.equal(text.includes('들어가면 안 되는 질문'), false);
  });
});

describe('병렬 확인 · 순서', () => {
  it('끝난 순서가 아니라 작업 번호 순서로 모은다', async () => {
    // 뒤 작업이 먼저 끝나도록 앞 작업을 늦춘다.
    const { outcome } = await run({
      respond: async (target, index) => {
        const delay = (8 - index) * 2;
        await new Promise((resolve) => setTimeout(resolve, delay));
        return taskResponse(target, {
          draft: {
            targetDomain: DOMAIN, evidenceVersion: 1, prioritizerSnapshotId: SNAPSHOT,
            sources: [sourceFor(target, 0, { title: `자료 ${index}` })],
            rejectedSources: [], unresolvedSourceQuestions: [`질문 ${index}`],
          },
        });
      },
    });

    assert.equal(outcome.status, 'ready_to_materialize');
    if (outcome.status !== 'ready_to_materialize') return;

    // 첫 번째 요청의 자료 1건 뒤에 이어서 확인한 것이 받은 주소 순서로 붙는다.
    assert.deepEqual(
      outcome.mergedDraft.sources.map((source) => source.url),
      [url(0), ...urls(12).slice(4)],
    );
    assert.deepEqual(
      outcome.mergedDraft.unresolvedSourceQuestions,
      ['유료 장벽', '질문 0', '질문 1', '질문 2', '질문 3', '질문 4', '질문 5', '질문 6', '질문 7'],
    );
    assert.deepEqual(outcome.combinedInspectedUrls, urls(12));
  });
});

describe('병렬 확인 · 여유분도 실제 확인이다', () => {
  it('필요한 수를 넘겨 성공한 확인도 모두 근거로 남는다', async () => {
    // 필요 4인데 7개 성공
    const { outcome } = await run({
      respond: (target, index) => (index < 7 ? taskResponse(target) : taskResponse(target, { inspected: [] })),
    });

    assert.equal(outcome.status, 'ready_to_materialize');
    if (outcome.status !== 'ready_to_materialize') return;

    // 1단계 4개 + 이어서 7개 = 11개. 4개로 줄이지 않는다.
    assert.equal(outcome.combinedInspectedUrls.length, 11);
    assert.deepEqual(outcome.combinedInspectedUrls, urls(11));
  });

  it('실패한 작업의 주소는 근거에 없다', async () => {
    const { outcome } = await run({
      respond: (target, index) => (index < 4 ? taskResponse(target) : taskResponse(target, { inspected: [] })),
    });
    if (outcome.status !== 'ready_to_materialize') return assert.fail(reasonOf(outcome));

    assert.deepEqual(outcome.combinedInspectedUrls, urls(8));
    for (const failedUrl of urls(12).slice(8)) {
      assert.equal(outcome.combinedInspectedUrls.includes(failedUrl), false);
    }
  });
});

describe('병렬 확인 · 자료 개수 상한', () => {
  const aggregate = (successCount: number, primarySources: number, primaryRejected: number) =>
    aggregateSuccessfulInspections({
      successful: Array.from({ length: successCount }, (_, index) => ({
        taskIndex: index,
        targetUrl: url(4 + index),
        draft: {
          sources: [sourceFor(url(4 + index), 0, { title: `자료 ${index}` })] as never,
          rejectedSources: [rejectedFor(url(4 + index))] as never,
          unresolvedSourceQuestions: [`질문 ${index}`],
        },
        toolDiagnostics: {
          webSearchCallCount: 1, searchActionCount: 0, openPageActionCount: 1,
          findInPageActionCount: 0, unknownActionCount: 0, uniqueInspectedUrlCount: 1,
        },
      })),
      primarySourceCount: primarySources,
      primaryRejectedCount: primaryRejected,
    });

  it('자리가 넉넉하면 모두 담는다', () => {
    const outcome = aggregate(7, 3, 1);
    assert.equal(outcome.ok, true);
    if (!outcome.ok) return;
    assert.equal(outcome.draft.sources.length, 7);
    assert.ok(3 + 7 <= ACCEPTED_MAX);
  });

  it('자리가 차면 앞 순서까지만 담는다', () => {
    // 첫 번째 요청이 이미 10건 → 남은 자리 2
    const outcome = aggregate(7, 10, 0);
    assert.equal(outcome.ok, true);
    if (!outcome.ok) return;

    assert.equal(outcome.draft.sources.length, ACCEPTED_MAX - 10);
    assert.deepEqual(outcome.draft.sources.map((s) => s.title), ['자료 0', '자료 1']);
    // 담지 못한 것을 제외 기록으로 바꾸지 않는다.
    assert.equal(outcome.draft.rejectedSources.length, 7);
  });

  it('제외 기록 자리도 같은 방식이다', () => {
    const outcome = aggregate(5, 0, 8);
    assert.equal(outcome.ok, true);
    if (!outcome.ok) return;
    assert.equal(outcome.draft.rejectedSources.length, REJECTED_SOURCE_MAX - 8);
    assert.equal(outcome.draft.sources.length, 5);
  });

  it('자리가 이미 넘쳐 있으면 멈춘다', () => {
    const overAccepted = aggregate(1, ACCEPTED_MAX + 1, 0);
    assert.equal(overAccepted.ok === false && overAccepted.reason, 'recovery_contract_invalid');

    const overRejected = aggregate(1, 0, REJECTED_SOURCE_MAX + 1);
    assert.equal(overRejected.ok === false && overRejected.reason, 'recovery_contract_invalid');
  });

  it('모르는 것 목록은 자리와 상관없이 순서대로 모은다', () => {
    const outcome = aggregate(5, 12, 10);
    assert.equal(outcome.ok, true);
    if (!outcome.ok) return;
    assert.equal(outcome.draft.sources.length, 0);
    assert.equal(outcome.draft.rejectedSources.length, 0);
    assert.deepEqual(outcome.draft.unresolvedSourceQuestions, ['질문 0', '질문 1', '질문 2', '질문 3', '질문 4']);
  });

  it('상한 숫자를 이 파일에 다시 적지 않는다', () => {
    const source = read('../../supabase/functions/_shared/source-harvester-parallel-recovery-execution.ts');
    assert.ok(source.includes('ACCEPTED_MAX'));
    assert.ok(source.includes('REJECTED_SOURCE_MAX'));
  });
});

describe('병렬 확인 · 합치기', () => {
  it('첫 번째 것이 앞, 이어서 확인한 것이 뒤다', async () => {
    const { outcome } = await run();
    if (outcome.status !== 'ready_to_materialize') return assert.fail(reasonOf(outcome));

    assert.equal(outcome.mergedDraft.sources[0].url, url(0));
    assert.equal(outcome.mergedDraft.rejectedSources[0].url, url(1));
    assert.equal(outcome.mergedDraft.unresolvedSourceQuestions[0], '유료 장벽');
    assert.equal(outcome.mergedDraft.targetDomain, DOMAIN);
    assert.equal(outcome.mergedDraft.evidenceVersion, 1);
    assert.equal(outcome.mergedDraft.prioritizerSnapshotId, SNAPSHOT);
  });

  it('합친 개수가 상한을 넘으면 멈춘다', async () => {
    // 첫 번째 요청이 이미 12건을 담고 있으면 더 담을 자리가 없다.
    const many = urls(4).map((target, index) => sourceFor(target, index));
    const state = await ticketState({
      primaryDraft: {
        sources: [...many, ...many.map((s, i) => ({ ...s, url: url(i) }))].slice(0, 12) as never,
        rejectedSources: [],
        unresolvedSourceQuestions: [],
      },
    });
    // 위 초안은 같은 주소가 겹치므로 표 검사에서 먼저 걸린다. 그것도 정상 동작이다.
    const { outcome, calls } = await run({ state });
    assert.equal(reasonOf(outcome), 'recovery_ticket_invalid');
    assert.equal(calls, 0);
  });
});

describe('병렬 확인 · 숫자 기록', () => {
  it('계획·시도·성공·실패·묶음 수가 맞는다', async () => {
    const { outcome } = await run({
      respond: (target, index) => (index < 5 ? taskResponse(target) : taskResponse(target, { inspected: [] })),
    });
    const d = diagOf(outcome);
    assert.ok(d);
    if (!d) return;

    assert.equal(d.plannedTaskCount, 8);
    assert.equal(d.attemptedTaskCount, 8);
    assert.equal(d.successfulTaskCount, 5);
    assert.equal(d.failedTaskCount, 3);
    assert.equal(d.successfulTaskCount + d.failedTaskCount, d.attemptedTaskCount);
    assert.equal(d.wavesExecuted, 1);
  });

  it('도구 사용 숫자를 합산한다', async () => {
    const { outcome } = await run();
    const d = diagOf(outcome);
    assert.ok(d);
    if (!d) return;

    // 작업마다 한 번 열었다.
    assert.equal(d.openPageActionCount, 8);
    assert.equal(d.searchActionCount, 0);
    assert.equal(d.findInPageActionCount, 0);
    assert.equal(
      d.webSearchCallCount,
      d.searchActionCount + d.openPageActionCount + d.findInPageActionCount + d.unknownActionCount,
    );
  });

  it('관찰된 주소 수와 성공한 작업 수는 다른 뜻이다', async () => {
    // 첫 작업이 맡은 주소와 밖의 주소를 함께 열었다 → 그 작업은 실패지만 주소 두 개가 관찰됐다.
    const { outcome } = await run({
      respond: (target, index) =>
        index === 0 ? taskResponse(target, { inspected: [target, outside(0)] }) : taskResponse(target),
    });
    const d = diagOf(outcome);
    assert.ok(d);
    if (!d) return;

    assert.equal(d.successfulTaskCount, 7);
    // 관찰된 서로 다른 주소는 8개(성공 7 + 밖의 1)이다. 성공 수와 같지 않다.
    assert.equal(d.uniqueInspectedUrlCount, 9);
    assert.ok(d.uniqueInspectedUrlCount >= d.successfulTaskCount);
  });

  it('숫자만 남고 주소나 자료 정보는 없다', async () => {
    const { outcome } = await run();
    const d = diagOf(outcome);
    assert.ok(d);
    if (!d) return;

    assert.equal(Object.keys(d).length, 11);
    for (const value of Object.values(d)) {
      assert.equal(typeof value, 'number');
      assert.ok(Number.isSafeInteger(value) && value >= 0);
    }
    const text = JSON.stringify(d);
    for (const banned of ['http', 'example.org', '연구 자료', 'src_']) {
      assert.equal(text.includes(banned), false, banned);
    }
  });
});

describe('병렬 확인 · 성공 결과', () => {
  it('자료를 만들 수 있는 상태만 돌려준다', async () => {
    const { outcome } = await run();
    assert.equal(outcome.status, 'ready_to_materialize');
    if (outcome.status !== 'ready_to_materialize') return;

    assert.deepEqual(Object.keys(outcome).sort(), [
      'brief',
      'combinedInspectedUrls',
      'mergedDraft',
      'parallelInspectionDiagnostics',
      'status',
    ]);
    assert.equal(outcome.brief.targetDomain, DOMAIN);
  });

  it('결과 어디에도 sourceId와 확인 날짜가 없다', async () => {
    const { outcome } = await run();
    const text = JSON.stringify(outcome);
    assert.equal(text.includes('sourceId'), false);
    assert.equal(text.includes('accessedAt'), false);
    assert.equal(text.includes('src_'), false);
  });

  it('자료를 완성하지 않는다', () => {
    const source = read('../../supabase/functions/_shared/source-harvester-parallel-recovery-execution.ts');
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '');
    assert.equal(code.includes('materializeHarvestResult'), false);
    assert.equal(code.includes('computeSourceId'), false);
    assert.equal(code.includes('toISOString'), false);
  });
});

describe('병렬 확인 · 아직 연결하지 않음', () => {
  const PARALLEL = '../../supabase/functions/_shared/source-harvester-parallel-recovery-execution.ts';

  it('실행 파일에 바깥으로 나가는 길이 없다', () => {
    const code = read(PARALLEL).replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '');
    for (const banned of ['Deno.env', 'fetch(', 'process.env', 'createClient', '/rest/v1/', 'SUPABASE_', 'api.openai.com']) {
      assert.equal(code.includes(banned), false, banned);
    }
  });

  it('요청 처리 본체만 이 파일을 쓴다', () => {
    assert.ok(read('../../supabase/functions/source-harvester/handler.ts')
      .includes('parallel-recovery-execution'));

    // Edge Function 파일과 기존 실행 본체들은 이 파일을 가져다 쓰지 않는다.
    // (설명 주석에 이름이 나오는 것은 참조가 아니므로 import 문으로 본다.)
    for (const path of [
      '../../supabase/functions/source-harvester/index.ts',
      '../../supabase/functions/_shared/source-harvester-recovery-execution.ts',
      '../../supabase/functions/_shared/source-harvester-execution.ts',
    ]) {
      const imports = [...read(path).matchAll(/from '([^']+)'/g)].map((match) => match[1]);
      assert.equal(
        imports.some((name) => name.includes('parallel-recovery-execution')),
        false,
        path,
      );
    }
  });

  it('기존 방식은 지우지 않고 남겨 둔다', () => {
    // 코드와 시험이 그대로 남아 있어 언제든 견주어 볼 수 있다.
    const monolithic = read('../../supabase/functions/_shared/source-harvester-recovery-execution.ts');
    assert.ok(monolithic.includes('export async function runSourceHarvestRecovery'));

    const recovery = read('../../supabase/functions/_shared/source-harvester-recovery-contract.ts');
    assert.ok(recovery.includes('buildRecoveryVerificationPayload'));
    assert.ok(recovery.includes('RECOVERY_VERIFICATION_TIMEOUT_MS'));

    // 다만 지금 쓰이는 경로에서는 부르지 않는다.
    const handler = read('../../supabase/functions/source-harvester/handler.ts');
    assert.equal(handler.includes('runSourceHarvestRecovery('), false);
  });

  it('처음 시작하는 요청은 그대로다', () => {
    const contract = read('../../supabase/functions/_shared/source-harvester-execution-contract.ts');
    assert.ok(contract.includes('export const DISCOVERY_TIMEOUT_MS = 60_000'));
    assert.ok(contract.includes('export const VERIFICATION_TIMEOUT_MS = 75_000'));
    assert.ok(contract.includes('export const VERIFICATION_MAX_TOOL_CALLS = 18'));
  });
});

/* ------------------------------------------------------------------ */
/* 자료 한 건의 규칙이 이 경로에도 적용된다                                */
/* ------------------------------------------------------------------ */

describe('병렬 확인 · 자료 규칙이 각 작업에도 적용된다', () => {
  /**
   * 확인 작업 하나하나가 2단계 응답 검사를 거친다.
   * 그 검사는 이제 공용 자료 규칙(verification-draft-source.ts)을 본다.
   * 따라서 규칙을 어긴 자료를 쓴 작업은 주소를 실제로 열었더라도 성공이 아니다.
   */
  const runWithLog = async (respond: (target: string, index: number) => unknown) => {
    const logged: string[] = [];
    let calls = 0;

    const outcome = await runParallelSourceHarvestRecovery(
      { ticketState: await ticketState(), activeCoveredDomains: covered },
      {
        callInspection: async (payload) => {
          const target = JSON.parse(payload.input as string).targetUrl as string;
          const index = calls;
          calls += 1;
          return respond(target, index);
        },
        log: (reason) => logged.push(reason),
      },
    );

    return { outcome, logged, calls };
  };

  /** 규칙을 어긴 자료 한 건을 쓴 작업 응답. 주소는 실제로 연다. */
  const invalidTask = (target: string, patch: Record<string, unknown>) =>
    taskResponse(target, {
      draft: {
        targetDomain: DOMAIN,
        evidenceVersion: 1,
        prioritizerSnapshotId: SNAPSHOT,
        sources: [sourceFor(target, 0, patch)],
        rejectedSources: [],
        unresolvedSourceQuestions: [],
      },
    });

  it('규칙을 어긴 자료를 쓴 작업은 주소를 열었어도 성공이 아니다', async () => {
    // 앞 3개는 연도가 범위 밖이다. 주소는 모두 실제로 열었다.
    const { outcome, calls } = await runWithLog((target, index) =>
      index < 3 ? invalidTask(target, { publicationYear: 3000 }) : taskResponse(target),
    );

    assert.equal(calls, 8);
    assert.equal(outcome.status, 'ready_to_materialize');

    const d = diagOf(outcome);
    assert.ok(d);
    if (!d) return;

    // 3개는 실패로 세고, 나머지 5개만 성공이다.
    assert.equal(d.successfulTaskCount, 5);
    assert.equal(d.failedTaskCount, 3);
    assert.equal(d.attemptedTaskCount, 8);

    // 주소는 8개 모두 실제로 열었으므로 관찰된 주소 수는 8이다.
    // 성공 수(5)와 다르다는 것이 이 두 숫자를 구분해 두는 이유다.
    assert.equal(d.uniqueInspectedUrlCount, 8);
  });

  it('규칙을 어긴 자료의 설명은 결과에 하나도 들어가지 않는다', async () => {
    const leakTitle = '새면 안 되는 제목';
    const { outcome } = await runWithLog((target, index) =>
      index < 3
        ? invalidTask(target, { publicationYear: 3000, title: leakTitle })
        : taskResponse(target),
    );

    if (outcome.status !== 'ready_to_materialize') return assert.fail(reasonOf(outcome));
    assert.equal(JSON.stringify(outcome.mergedDraft).includes(leakTitle), false);
    assert.equal(outcome.mergedDraft.sources.length, 5 + 1);
  });

  it('규칙을 어긴 작업이 많아 목표를 못 채우면 그대로 멈춘다', async () => {
    // 필요한 수는 4인데 규칙을 지킨 자료는 3개뿐이다.
    const { outcome } = await runWithLog((target, index) =>
      index < 5 ? invalidTask(target, { publicationYear: 3000 }) : taskResponse(target),
    );

    assert.equal(reasonOf(outcome), 'insufficient_recovery_inspection');
    const d = diagOf(outcome);
    assert.equal(d?.successfulTaskCount, 3);
    assert.equal(d?.failedTaskCount, 5);
  });

  it('어긴 규칙마다 같은 결과다', async () => {
    const cases: [string, Record<string, unknown>][] = [
      ['연도 범위 밖', { publicationYear: 3000 }],
      ['메모가 너무 김', { relevanceNote: 'ㄱ'.repeat(RELEVANCE_NOTE_MAX + 1) }],
      ['용도 중복', { intendedUse: ['exegesis', 'exegesis'] }],
      ['종류와 용도가 맞지 않음', { sourceType: 'pastoral_resource', intendedUse: ['exegesis'] }],
      ['받을 수 없는 주소', { url: 'http://example.org/insecure' }],
    ];

    for (const [label, patch] of cases) {
      const { outcome } = await runWithLog((target, index) =>
        index === 0 ? invalidTask(target, patch) : taskResponse(target),
      );
      const d = diagOf(outcome);
      assert.equal(d?.successfulTaskCount, 7, label);
      assert.equal(d?.failedTaskCount, 1, label);
    }
  });

  it('기록에 자료 내용이나 어긴 규칙 이름이 남지 않는다', async () => {
    const { logged } = await runWithLog((target, index) =>
      index < 3
        ? invalidTask(target, { publicationYear: 3000, title: '새면 안 되는 제목' })
        : taskResponse(target),
    );

    const text = logged.join(' ');
    for (const banned of [
      '새면 안 되는 제목',
      'example.org',
      'https://',
      'publication_year_invalid',
      'intended_use_incompatible',
      '3000',
    ]) {
      assert.equal(text.includes(banned), false, banned);
    }
    // 남는 것은 정해진 이유 코드뿐이다.
    assert.deepEqual(logged, ['ready_to_materialize']);
  });

  it('경계값을 지킨 자료는 예전과 똑같이 성공이다', async () => {
    const boundary: Record<string, unknown>[] = [
      { publicationYear: PUBLICATION_YEAR_MIN },
      { publicationYear: PUBLICATION_YEAR_MAX },
      { publicationYear: null },
      { relevanceNote: 'ㄱ'.repeat(RELEVANCE_NOTE_MAX) },
      { sourceType: 'pastoral_resource', intendedUse: ['pastoral_application'] },
      { sourceType: 'professional_context', intendedUse: ['pastoral_safety'] },
    ];

    for (const patch of boundary) {
      const { outcome } = await runWithLog((target) => invalidTask(target, patch));
      assert.equal(outcome.status, 'ready_to_materialize', JSON.stringify(patch));
      assert.equal(diagOf(outcome)?.successfulTaskCount, 8, JSON.stringify(patch));
      assert.equal(diagOf(outcome)?.failedTaskCount, 0, JSON.stringify(patch));
    }
  });

  it('작업 하나하나가 2단계 응답 검사를 지난다', () => {
    const parallel = read('../../supabase/functions/_shared/source-harvester-parallel-recovery-execution.ts');
    const execution = read('../../supabase/functions/_shared/source-harvester-execution.ts');

    // 병렬 실행은 2단계 검사를 그대로 쓰고,
    assert.ok(parallel.includes('validateHarvestDraft'));
    // 그 검사가 공용 자료 규칙을 본다.
    assert.ok(execution.includes('isValidVerificationDraftSource'));
    // 병렬 실행이 자료 규칙을 따로 적어 두지 않는다.
    assert.equal(parallel.includes('PUBLICATION_YEAR'), false);
    assert.equal(parallel.includes('RELEVANCE_NOTE_MAX'), false);
    assert.equal(parallel.includes('isSourceTypeAllowedForUse'), false);
  });
});

describe('병렬 확인 · 구조는 그대로다', () => {
  it('나누어 보내는 규칙과 예산이 바뀌지 않았다', () => {
    assert.equal(SINGLE_INSPECTION_MAX_CONCURRENCY, 8);
    assert.equal(SINGLE_INSPECTION_TIMEOUT_MS, 45_000);
    assert.equal(SINGLE_INSPECTION_SPARE_MAX, 4);
    assert.equal(SINGLE_INSPECTION_MAX_TOOL_CALLS, 4);

    // 필요한 수 8이면 최대 12개, 두 번에 나누어 보낸다.
    const plan = planSingleUrlRecoveryInspections({
      remainingUrls: urls(26),
      requiredAdditionalInspections: 8,
    });
    assert.equal(plan.ok, true);
    if (!plan.ok) return;
    assert.equal(plan.plan.tasks.length, 12);
    assert.equal(countInspectionWaves(plan.plan.tasks.length), 2);
  });

  it('재시도도 세 번째 요청도 없다', () => {
    const parallel = read('../../supabase/functions/_shared/source-harvester-parallel-recovery-execution.ts');
    assert.equal(/retry|retries|attemptAgain/i.test(parallel), false);
    assert.equal(parallel.includes('createRecoveryTicket'), false);
  });

  it('자료를 완성하는 시점도 그대로다', () => {
    const parallel = read('../../supabase/functions/_shared/source-harvester-parallel-recovery-execution.ts');
    const code = parallel.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '');
    assert.equal(code.includes('materializeHarvestResult'), false);
    assert.equal(code.includes('computeSourceId'), false);

    const handler = read('../../supabase/functions/source-harvester/handler.ts');
    // 자료 완성은 여전히 ready_to_materialize 뒤에서 handler가 한 번만 한다.
    assert.equal((handler.match(/materializeHarvestResult\(/g) || []).length, 1);
  });
});
