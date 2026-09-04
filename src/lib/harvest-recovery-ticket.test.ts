/**
 * Recovery Ticket 저장소 테스트
 *
 * 실행: npm test
 *
 * 실제 DB, 네트워크, AI를 쓰지 않는다.
 * 순수 검사 함수와 migration 파일의 내용만 확인한다.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import {
  RECOVERY_TICKET_TTL_MINUTES,
  TICKET_ROW_COLUMNS,
  computeActiveCoveredHash,
  TICKET_TOOL_COUNT_FIELDS,
  isRecoveryId,
  mapTicketRowToState,
  parseConsumeTicketResponse,
  parseCreateTicketResponse,
  parseHarvestRecoveryTicketState,
  validateHarvestRecoveryTicketInput,
  type HarvestPrimaryDraft,
  type HarvestRecoveryTicketInput,
} from '../../supabase/functions/_shared/harvest-recovery-ticket.ts';
import {
  VERIFICATION_DRAFT_SOURCE_FIELDS,
  type VerificationDraftSource,
} from '../../supabase/functions/_shared/source-harvest-contract.ts';
import type { RejectedSource } from '../../supabase/functions/_shared/source-harvester.ts';

const url = (index: number) => `https://sources.example.org/aroeda/fixture-${index}`;
const urls = (count: number) => Array.from({ length: count }, (_, index) => url(index));

const SNAPSHOT = `snap_${'3'.repeat(64)}`;
const COVERED_HASH = 'a'.repeat(64);
const RECOVERY_ID = '6f9619ff-8b86-4d11-b42d-00c04fc964ff';

/**
 * 실제로 열어 본 주소 하나에 대해 2단계가 쓴 가공 전 자료 한 건.
 * sourceId와 accessedAt은 서버가 나중에 붙이는 값이므로 여기에 없다.
 */
const draftSource = (index: number): VerificationDraftSource => ({
  sourceType: 'commentary',
  title: `재정 어려움 본문 주석 ${index}`,
  authorOrOrganization: '연구자 이름',
  publisherOrInstitution: `출판사 ${index}`,
  publicationYear: 2015,
  url: url(index),
  accessLevel: 'full_text',
  intendedUse: ['exegesis'],
  relevanceNote: '이 본문의 문맥을 확인하는 데 필요합니다.',
  evidenceClaims: [
    {
      intendedUse: 'exegesis' as const,
      statement: '이 주석은 본문의 반복 구조를 절망의 부정이 아니라 신뢰 회복의 움직임으로 읽는다.',
      passageReferences: [{ book: 'Psalms', chapter: 42, startVerse: 5, endVerse: 5 }],
    },
  ],
});

/** 서버가 만들어 붙이는 최종 모양. 표에 담으면 안 되는 쪽이다. */
const materializedSource = (index: number) => ({
  ...draftSource(index),
  sourceId: `src_${index}${'b'.repeat(63)}`,
  accessedAt: '2026-09-01',
});

const draftRejected = (index: number): RejectedSource => ({
  url: url(index),
  title: null,
  rejectionReason: 'anonymous_or_unverifiable',
});

const draft = (overrides: Partial<HarvestPrimaryDraft> = {}): HarvestPrimaryDraft => ({
  sources: [draftSource(0), draftSource(1)],
  rejectedSources: [draftRejected(2)],
  unresolvedSourceQuestions: ['출판 연도를 확인하지 못했습니다.'],
  ...overrides,
});

const ticket = (overrides: Partial<HarvestRecoveryTicketInput> = {}): HarvestRecoveryTicketInput => ({
  targetDomain: 'financial_hardship',
  evidenceVersion: 1,
  prioritizerSnapshotId: SNAPSHOT,
  activeCoveredHash: COVERED_HASH,
  discoveredUrls: urls(8),
  primaryInspectedUrls: urls(6),
  primaryDraft: draft(),
  primaryToolCounts: {
    webSearchCallCount: 6,
    searchActionCount: 0,
    openPageActionCount: 3,
    findInPageActionCount: 3,
    unknownActionCount: 0,
    uniqueInspectedUrlCount: 6,
  },
  ...overrides,
});

/** DB가 돌려주는 모양(snake_case)으로 바꾼다. 실제 RPC 응답 한 줄과 같다. */
const row = (input: HarvestRecoveryTicketInput = ticket()): Record<string, unknown> => ({
  target_domain: input.targetDomain,
  evidence_version: input.evidenceVersion,
  prioritizer_snapshot_id: input.prioritizerSnapshotId,
  active_covered_hash: input.activeCoveredHash,
  discovered_urls: input.discoveredUrls,
  primary_inspected_urls: input.primaryInspectedUrls,
  primary_draft: input.primaryDraft,
  primary_tool_counts: input.primaryToolCounts,
});

const check = (value: unknown) => validateHarvestRecoveryTicketInput(value);

describe('Recovery Ticket · 담을 값 검사', () => {
  it('올바른 값은 통과한다', () => {
    const outcome = check(ticket());
    assert.equal(outcome.valid, true, outcome.errors.join(' / '));
  });

  it('판단 시점 id의 모양이 다르면 거절한다', () => {
    for (const bad of ['snap_x', 'a'.repeat(64), `snap_${'A'.repeat(64)}`, `snap_${'3'.repeat(63)}`, '']) {
      assert.equal(check(ticket({ prioritizerSnapshotId: bad })).valid, false, bad);
    }
  });

  it('영역 지문의 모양이 다르면 거절한다', () => {
    for (const bad of ['A'.repeat(64), 'a'.repeat(63), 'a'.repeat(65), `snap_${'a'.repeat(64)}`, '']) {
      assert.equal(check(ticket({ activeCoveredHash: bad })).valid, false, bad);
    }
  });

  it('발견된 주소가 없으면 거절한다', () => {
    assert.equal(check(ticket({ discoveredUrls: [], primaryInspectedUrls: [] })).valid, false);
  });

  it('발견된 주소가 중복되면 거절한다', () => {
    assert.equal(check(ticket({ discoveredUrls: [url(0), url(0), ...urls(6)] })).valid, false);
  });

  it('열어 본 주소가 발견 목록 밖이면 거절한다', () => {
    const outcome = check(
      ticket({ primaryInspectedUrls: [...urls(5), 'https://never-discovered.example.org/x'] }),
    );
    assert.equal(outcome.valid, false);
    assert.ok(outcome.errors.some((error) => error.includes('발견된 주소 목록에 없습니다')));
  });

  it('열어 본 주소가 중복되면 거절한다', () => {
    const counts = { ...ticket().primaryToolCounts, uniqueInspectedUrlCount: 6 };
    assert.equal(
      check(ticket({ primaryInspectedUrls: [url(0), url(0), url(1), url(2), url(3), url(4)], primaryToolCounts: counts }))
        .valid,
      false,
    );
  });

  it('정리되지 않았거나 받을 수 없는 주소는 거절한다', () => {
    for (const bad of [
      'http://example.org/insecure',
      'https://127.0.0.1/internal',
      'javascript:alert(1)',
      'https://sources.example.org/aroeda/fixture-0?utm_source=x', // 정리 전 모양
      'https://sources.example.org/aroeda/fixture-0#top',
      '',
    ]) {
      const outcome = check(ticket({ discoveredUrls: [bad, ...urls(7)] }));
      assert.equal(outcome.valid, false, bad);
    }
  });

  it('열어 본 주소는 비어 있어도 된다', () => {
    // 아무것도 열지 못한 실행도 표를 만들 수는 있다. 쓸지 말지는 나중 단계가 정한다.
    const outcome = check(
      ticket({
        primaryInspectedUrls: [],
        primaryToolCounts: {
          webSearchCallCount: 1,
          searchActionCount: 1,
          openPageActionCount: 0,
          findInPageActionCount: 0,
          unknownActionCount: 0,
          uniqueInspectedUrlCount: 0,
        },
      }),
    );
    assert.equal(outcome.valid, true, outcome.errors.join(' / '));
  });
});

describe('Recovery Ticket · 도구 사용 숫자 검사', () => {
  it('숫자는 정확히 6개다', () => {
    assert.equal(TICKET_TOOL_COUNT_FIELDS.length, 6);
  });

  it('모르는 항목이 붙으면 거절한다', () => {
    const counts = { ...ticket().primaryToolCounts, extraCount: 1 } as never;
    assert.equal(check(ticket({ primaryToolCounts: counts })).valid, false);
  });

  it('빠진 항목이 있으면 거절한다', () => {
    const { unknownActionCount: _drop, ...rest } = ticket().primaryToolCounts;
    void _drop;
    assert.equal(check(ticket({ primaryToolCounts: rest as never })).valid, false);
  });

  it('총 횟수가 종류별 합과 다르면 거절한다', () => {
    const counts = { ...ticket().primaryToolCounts, webSearchCallCount: 7 };
    const outcome = check(ticket({ primaryToolCounts: counts }));
    assert.equal(outcome.valid, false);
    assert.ok(outcome.errors.some((error) => error.includes('종류별 합과 다릅니다')));
  });

  it('확인한 주소 수가 목록 길이와 다르면 거절한다', () => {
    const counts = { ...ticket().primaryToolCounts, uniqueInspectedUrlCount: 5 };
    const outcome = check(ticket({ primaryToolCounts: counts }));
    assert.equal(outcome.valid, false);
    assert.ok(outcome.errors.some((error) => error.includes('주소 목록의 길이와 다릅니다')));
  });

  it('음수·소수·숫자가 아닌 값은 거절한다', () => {
    for (const bad of [-1, 1.5, Number.NaN, '3', null]) {
      const counts = { ...ticket().primaryToolCounts, openPageActionCount: bad } as never;
      assert.equal(check(ticket({ primaryToolCounts: counts })).valid, false, String(bad));
    }
  });
});

describe('Recovery Ticket · 담으면 안 되는 것', () => {
  it('모르는 최상위 항목이 붙으면 거절한다', () => {
    assert.equal(check({ ...ticket(), extraField: 1 }).valid, false);
  });

  it('필수 항목이 빠지면 거절한다', () => {
    const { primaryDraft: _drop, ...rest } = ticket();
    void _drop;
    assert.equal(check(rest).valid, false);
  });

  it('사용자 정보는 어느 깊이에 있든 거절한다', () => {
    for (const key of ['situation', 'rawSituation', 'userSituation', 'userId', 'sessionId', 'deviceId', 'ip', 'jwt', 'token', 'prayer', 'emotionTags']) {
      const withUserData = { ...ticket() } as unknown as Record<string, unknown>;
      withUserData[key] = 'x';
      assert.equal(check(withUserData).valid, false, `${key}가 통과되었습니다.`);
    }
  });

  it('초안 안쪽에 숨겨도 거절한다', () => {
    const nested = ticket();
    (nested.primaryDraft as Record<string, unknown>).userId = 'user-1';
    assert.equal(check(nested).valid, false);

    const deeper = ticket();
    deeper.primaryDraft = { sources: [{ url: url(0), pageContent: '웹페이지 본문' }] } as never;
    assert.equal(check(deeper).valid, false);
  });

  it('모델 원본 응답이나 판단 점수는 거절한다', () => {
    for (const key of ['rawResponse', 'rawHtml', 'html', 'pageContent', 'webpageContent', 'score', 'confidence', 'rank', 'apiKey']) {
      const withBanned = { ...ticket() } as unknown as Record<string, unknown>;
      withBanned[key] = 'x';
      assert.equal(check(withBanned).valid, false, `${key}가 통과되었습니다.`);
    }
  });

  it('초안이 객체가 아니면 거절한다', () => {
    for (const bad of ['draft', 42, null, [], true]) {
      assert.equal(check(ticket({ primaryDraft: bad as never })).valid, false, String(bad));
    }
  });

  it('객체가 아니면 거절한다', () => {
    for (const bad of [null, 'ok', 42, []]) {
      assert.equal(check(bad).valid, false);
    }
  });
});

describe('Recovery Ticket · 응답 읽기', () => {
  it('표 id 모양을 가린다', () => {
    assert.equal(isRecoveryId(RECOVERY_ID), true);
    for (const bad of ['', 'not-a-uuid', RECOVERY_ID.slice(0, -1), 123, null]) {
      assert.equal(isRecoveryId(bad), false, String(bad));
    }
  });

  it('표 만들기 결과에서 id만 꺼낸다', () => {
    assert.equal(parseCreateTicketResponse(RECOVERY_ID), RECOVERY_ID);
    assert.equal(parseCreateTicketResponse([RECOVERY_ID]), RECOVERY_ID);
    assert.equal(parseCreateTicketResponse({ create_harvest_recovery_ticket: RECOVERY_ID }), RECOVERY_ID);
    assert.equal(parseCreateTicketResponse([{ create_harvest_recovery_ticket: RECOVERY_ID }]), RECOVERY_ID);
  });

  it('id 말고 다른 것이 함께 오면 쓰지 않는다', () => {
    assert.equal(parseCreateTicketResponse({ id: RECOVERY_ID, discoveredUrls: urls(2) }), null);
    assert.equal(parseCreateTicketResponse([RECOVERY_ID, RECOVERY_ID]), null);
    assert.equal(parseCreateTicketResponse('nope'), null);
    assert.equal(parseCreateTicketResponse(null), null);
  });

  it('꺼낸 값이 비어 있으면 빈 결과로 다룬다', () => {
    const outcome = parseConsumeTicketResponse([]);
    assert.equal(outcome.ok, false);
    assert.equal(outcome.ok === false && outcome.reason, 'empty');
  });

  it('없는 id·만료·이미 쓴 경우를 구분해서 알려주지 않는다', () => {
    // 세 경우 모두 DB에서 빈 배열로 온다. 읽는 쪽도 하나로만 다룬다.
    for (const _case of ['없는 id', '만료된 id', '이미 쓴 id']) {
      const outcome = parseConsumeTicketResponse([]);
      assert.equal(outcome.ok === false && outcome.reason, 'empty', _case);
    }
  });

  it('꺼낸 값도 담을 때와 같은 규칙으로 다시 확인한다', () => {
    const good = parseConsumeTicketResponse([row()]);
    assert.equal(good.ok, true, good.ok === false ? good.reason : '');

    const broken = parseConsumeTicketResponse([row(ticket({ prioritizerSnapshotId: 'snap_x' }))]);
    assert.equal(broken.ok, false);
    assert.equal(broken.ok === false && broken.reason, 'invalid');

    const tooMany = parseConsumeTicketResponse([row(), row()]);
    assert.equal(tooMany.ok === false && tooMany.reason, 'invalid');

    assert.equal(parseConsumeTicketResponse({}).ok, false);
  });

  it('parseHarvestRecoveryTicketState는 같은 규칙을 쓴다', () => {
    assert.equal(parseHarvestRecoveryTicketState(ticket()).ok, true);
    assert.equal(parseHarvestRecoveryTicketState({ ...ticket(), extra: 1 }).ok, false);
  });
});

describe('Recovery Ticket · DB 줄 읽기', () => {
  it('DB 칸 이름과 앱 이름의 대응표는 여덟 쌍이다', () => {
    const columns = Object.keys(TICKET_ROW_COLUMNS);
    assert.equal(columns.length, 8);
    // 대응표에 적힌 DB 칸 이름은 모두 밑줄 표기다.
    for (const column of columns) {
      assert.ok(/^[a-z][a-z_]*$/.test(column), column);
    }
  });

  it('DB가 준 밑줄 이름 줄을 앱 이름으로 바꿔 읽는다', () => {
    const outcome = mapTicketRowToState(row());
    assert.equal(outcome.ok, true, outcome.ok === false ? outcome.errors.join(' / ') : '');
    if (outcome.ok) {
      assert.equal(outcome.state.targetDomain, 'financial_hardship');
      assert.equal(outcome.state.evidenceVersion, 1);
      assert.equal(outcome.state.prioritizerSnapshotId, SNAPSHOT);
      assert.equal(outcome.state.activeCoveredHash, COVERED_HASH);
      assert.deepEqual(outcome.state.discoveredUrls, urls(8));
      assert.deepEqual(outcome.state.primaryInspectedUrls, urls(6));
      assert.equal(outcome.state.primaryToolCounts.uniqueInspectedUrlCount, 6);
    }
  });

  it('모르는 칸이 하나라도 있으면 쓰지 않는다', () => {
    const outcome = mapTicketRowToState({ ...row(), extra_column: 'x' });
    assert.equal(outcome.ok, false);
  });

  it('있어야 할 칸이 빠지면 쓰지 않는다', () => {
    for (const column of Object.keys(TICKET_ROW_COLUMNS)) {
      const partial = { ...row() };
      delete partial[column];
      assert.equal(mapTicketRowToState(partial).ok, false, column);
    }
  });

  it('앱 이름 그대로 온 줄을 DB 줄로 오인하지 않는다', () => {
    // camelCase 객체는 DB가 준 줄이 아니다. 통과시키면 이름 변환을 건너뛴 값이 흘러든다.
    assert.equal(mapTicketRowToState(ticket()).ok, false);
    assert.equal(parseConsumeTicketResponse([ticket()]).ok, false);
  });

  it('줄이 객체가 아니면 쓰지 않는다', () => {
    for (const bad of [null, 'row', 42, [], true]) {
      assert.equal(mapTicketRowToState(bad).ok, false, String(bad));
    }
  });

  it('꺼내기 결과는 반드시 이 변환을 지난다', () => {
    assert.equal(parseConsumeTicketResponse([row()]).ok, true);
    assert.equal(parseConsumeTicketResponse([]).ok === false, true);
    assert.equal(parseConsumeTicketResponse([row(), row()]).ok === false, true);
    assert.equal(parseConsumeTicketResponse([{ ...row(), extra_column: 1 }]).ok, false);
  });
});

describe('Recovery Ticket · 연구 대상 영역', () => {
  it('아직 카드가 없는 영역만 받는다', () => {
    for (const domain of ['financial_hardship', 'burnout_exhaustion']) {
      assert.equal(check(ticket({ targetDomain: domain })).valid, true, domain);
    }
  });

  it('이미 카드가 있는 영역은 거절한다', () => {
    for (const domain of ['fear_uncertainty', 'grief_loss', 'gratitude_joy']) {
      assert.equal(check(ticket({ targetDomain: domain })).valid, false, domain);
    }
  });

  it('분류 밖 영역과 모르는 이름은 거절한다', () => {
    for (const domain of ['other_uncovered', 'unknown_domain', '', 'FINANCIAL_HARDSHIP']) {
      assert.equal(check(ticket({ targetDomain: domain })).valid, false, domain);
    }
  });

  it('영역 목록을 이 파일에 다시 적지 않는다', () => {
    const source = readFileSync(
      new URL('../../supabase/functions/_shared/harvest-recovery-ticket.ts', import.meta.url),
      'utf8',
    );
    assert.ok(source.includes('RESEARCHABLE_DOMAINS'));
    // 영역 이름을 문자열로 직접 적어 두지 않는다.
    for (const domain of ['financial_hardship', 'burnout_exhaustion', 'other_uncovered']) {
      assert.equal(source.includes(`'${domain}'`), false, domain);
    }
  });
});

describe('Recovery Ticket · 초안 구조', () => {
  const withDraft = (value: unknown) => check(ticket({ primaryDraft: value as never }));

  it('올바른 초안은 통과한다', () => {
    const outcome = withDraft(draft());
    assert.equal(outcome.valid, true, outcome.errors.join(' / '));
  });

  it('아직 완성된 결과가 아니므로 빈 목록도 통과한다', () => {
    const outcome = withDraft({ sources: [], rejectedSources: [], unresolvedSourceQuestions: [] });
    assert.equal(outcome.valid, true, outcome.errors.join(' / '));
  });

  it('빈 객체는 거절한다', () => {
    assert.equal(withDraft({}).valid, false);
  });

  it('모르는 최상위 항목은 거절한다', () => {
    assert.equal(withDraft({ ...draft(), foo: 'bar' }).valid, false);
  });

  it('완성된 결과의 머리말을 초안에 담지 않는다', () => {
    // targetDomain·evidenceVersion·prioritizerSnapshotId는 표의 칸으로 따로 있다.
    // 초안 안에 또 두면 두 번째 요청이 그중 하나만 바꿔치기할 자리가 생긴다.
    for (const key of ['targetDomain', 'evidenceVersion', 'prioritizerSnapshotId']) {
      assert.equal(withDraft({ ...draft(), [key]: 'x' }).valid, false, key);
    }
  });

  it('세 항목 중 하나라도 빠지면 거절한다', () => {
    for (const key of ['sources', 'rejectedSources', 'unresolvedSourceQuestions'] as const) {
      const partial = { ...draft() } as Record<string, unknown>;
      delete partial[key];
      assert.equal(withDraft(partial).valid, false, key);
    }
  });

  it('세 항목의 종류가 다르면 거절한다', () => {
    assert.equal(withDraft({ ...draft(), sources: {} }).valid, false);
    assert.equal(withDraft({ ...draft(), rejectedSources: 'none' }).valid, false);
    assert.equal(withDraft({ ...draft(), unresolvedSourceQuestions: 'none' }).valid, false);
  });

  it('모르는 것 목록에 문자열이 아닌 값이 있으면 거절한다', () => {
    assert.equal(withDraft(draft({ unresolvedSourceQuestions: [1] as never })).valid, false);
    assert.equal(withDraft(draft({ unresolvedSourceQuestions: [null] as never })).valid, false);
  });

  it('자료 한 건의 항목이 어긋나면 거절한다', () => {
    const bad = (patch: Record<string, unknown>) =>
      withDraft(draft({ sources: [{ ...draftSource(0), ...patch }] })).valid;

    assert.equal(bad({ sourceType: 'bible_primary' }), false);
    assert.equal(bad({ sourceType: 'blog' }), false);
    assert.equal(bad({ accessLevel: 'metadata_only' }), false);
    assert.equal(bad({ intendedUse: [] }), false);
    assert.equal(bad({ intendedUse: ['exegesis', 'exegesis'] }), false);
    assert.equal(bad({ intendedUse: ['made_up_use'] }), false);
    // pastoral_resource 자료를 성경 주해의 근거로 쓸 수 없다.
    assert.equal(bad({ sourceType: 'pastoral_resource', intendedUse: ['exegesis'] }), false);
    assert.equal(bad({ url: 'http://example.org/insecure' }), false);
    assert.equal(bad({ publicationYear: 1200 }), false);
    assert.equal(bad({ title: '' }), false);
    assert.equal(bad({ relevanceNote: 'ㄱ'.repeat(301) }), false);
    assert.equal(bad({ extraField: 1 }), false);
  });

  it('같은 자료를 두 번 담으면 거절한다', () => {
    assert.equal(withDraft(draft({ sources: [draftSource(0), draftSource(0)] })).valid, false);
  });

  it('자료의 필수 항목이 빠지면 거절한다', () => {
    for (const key of Object.keys(draftSource(0))) {
      const partial = { ...draftSource(0) } as Record<string, unknown>;
      delete partial[key];
      assert.equal(withDraft(draft({ sources: [partial as never] })).valid, false, key);
    }
  });

  it('제외 기록의 항목이 어긋나면 거절한다', () => {
    const bad = (patch: Record<string, unknown>) =>
      withDraft(draft({ rejectedSources: [{ ...draftRejected(2), ...patch }] })).valid;

    assert.equal(bad({ rejectionReason: 'because_i_said_so' }), false);
    assert.equal(bad({ url: '' }), false);
    assert.equal(bad({ title: '' }), false);
    assert.equal(bad({ extraField: 1 }), false);
    // 확인한 제목이 없으면 null이어야 한다.
    assert.equal(withDraft(draft({ rejectedSources: [draftRejected(2)] })).valid, true);
  });

  it('서버 전용 제외 사유는 가공 전 초안에 있을 수 없다', () => {
    // 열어 본 적 없어 뺀 기록은 materialization 단계에서 서버가 붙인다.
    // 실행 본체의 초안 검사와 같은 규칙(MODEL_REJECTION_REASONS)을 쓴다.
    const outcome = withDraft(
      draft({ rejectedSources: [{ ...draftRejected(2), rejectionReason: 'not_inspected' } as never] }),
    );
    assert.equal(outcome.valid, false);
  });

  it('제외 기록은 모델 쪽 상한 10개까지다', () => {
    const many = (count: number) =>
      Array.from({ length: count }, (_, index) => ({
        ...draftRejected(0),
        url: `https://rejected.example.org/${index}`,
      }));

    assert.equal(withDraft(draft({ rejectedSources: many(10) })).valid, true);
    assert.equal(withDraft(draft({ rejectedSources: many(11) })).valid, false);
    // 22개(서버 기록까지 더한 최종 상한)는 이 단계의 상한이 아니다.
    assert.equal(withDraft(draft({ rejectedSources: many(22) })).valid, false);
  });

  it('채택 자료는 12개까지이고 최소 개수는 요구하지 않는다', () => {
    const many = (count: number) => Array.from({ length: count }, (_, index) => draftSource(index));
    assert.equal(withDraft(draft({ sources: many(1) })).valid, true);
    assert.equal(withDraft(draft({ sources: many(12) })).valid, true);
    assert.equal(withDraft(draft({ sources: many(13) })).valid, false);
  });

  it('웹페이지 내용을 담는 항목은 어느 깊이든 거절한다', () => {
    const webContentFields = [
      'rawHtml',
      'html',
      'pageContent',
      'webpageContent',
      'rawResponse',
      'content',
      'body',
      'snippet',
      'summary',
      'excerpt',
      'quote',
      'quotes',
      'quotation',
      'fullText',
      'text',
    ];

    for (const key of webContentFields) {
      // 최상위
      assert.equal(withDraft({ ...draft(), [key]: '웹페이지 본문' }).valid, false, key);

      // 자료 한 건 안쪽
      const nested = withDraft(draft({ sources: [{ ...draftSource(0), [key]: '웹페이지 본문' }] }));
      assert.equal(nested.valid, false, key);
      assert.ok(
        nested.errors.some((error) => error.includes('표에 담을 수 없는 항목')),
        `${key}: 금지 항목으로 걸리지 않았습니다.`,
      );

      // 더 깊은 곳
      const deeper = withDraft(
        draft({ sources: [{ ...draftSource(0), intendedUse: [{ [key]: 'x' }] as never }] }),
      );
      assert.ok(
        deeper.errors.some((error) => error.includes('표에 담을 수 없는 항목')),
        `${key}: 깊은 곳에서 걸리지 않았습니다.`,
      );
    }
  });

  it('Source Harvester 결과의 금지 항목을 빠짐없이 막는다', () => {
    const harvester = readFileSync(
      new URL('../../supabase/functions/_shared/source-harvester.ts', import.meta.url),
      'utf8',
    );
    const block = harvester.split('const BANNED_FIELD_NAMES = [')[1].split('];')[0];
    const names = [...block.matchAll(/'([a-z_]+)'/g)].map((match) => match[1]);
    assert.ok(names.length >= 25, `금지 목록을 읽지 못했습니다 (${names.length}개)`);

    for (const name of names) {
      const outcome = withDraft(draft({ sources: [{ ...draftSource(0), [name]: 'x' }] }));
      assert.ok(
        outcome.errors.some((error) => error.includes('표에 담을 수 없는 항목')),
        `${name}: Ticket 쪽 금지 목록에 없습니다.`,
      );
    }
  });

  it('Source Harvester 초안의 금지 항목도 빠짐없이 막는다', () => {
    const execution = readFileSync(
      new URL('../../supabase/functions/_shared/source-harvester-execution.ts', import.meta.url),
      'utf8',
    );
    const block = execution.split('const BANNED_DRAFT_FIELDS = [')[1].split('];')[0];
    const names = [...block.matchAll(/'([a-z_]+)'/g)].map((match) => match[1]);
    assert.ok(names.includes('sourceid') && names.includes('accessedat'));

    for (const name of names) {
      const outcome = withDraft(draft({ sources: [{ ...draftSource(0), [name]: 'x' } as never] }));
      assert.ok(
        outcome.errors.some((error) => error.includes('표에 담을 수 없는 항목')),
        `${name}: Ticket 쪽 금지 목록에 없습니다.`,
      );
    }
  });

  it('자료 한 건의 규칙을 이 파일에 다시 적지 않는다', () => {
    const source = readFileSync(
      new URL('../../supabase/functions/_shared/harvest-recovery-ticket.ts', import.meta.url),
      'utf8',
    );

    // 자료 한 건의 규칙은 공용 검사 하나만 본다.
    assert.ok(source.includes('checkVerificationDraftSource'));

    // 그래서 이 파일에는 그 규칙에 쓰이던 목록과 숫자가 더 이상 없다.
    for (const moved of [
      'HARVESTABLE_SOURCE_TYPES',
      'ACCESS_LEVELS',
      'INTENDED_USES',
      'PUBLICATION_YEAR_MIN',
      'PUBLICATION_YEAR_MAX',
      'RELEVANCE_NOTE_MAX',
      'isSourceTypeAllowedForUse',
    ]) {
      assert.equal(source.includes(moved), false, moved);
    }

    // 표 자신의 책임에 쓰는 것들은 그대로 있다.
    for (const own of [
      'MODEL_REJECTION_REASONS',
      'VERIFICATION_DRAFT_REJECTED_FIELDS',
      'RESEARCHABLE_DOMAINS',
      'ACCEPTED_MAX',
      'REJECTED_SOURCE_MAX',
    ]) {
      assert.ok(source.includes(own), own);
    }

    for (const literal of ['commentary', 'full_text', 'exegesis', 'search_snippet_only']) {
      assert.equal(source.includes(`'${literal}'`), false, literal);
    }
  });
});

describe('Recovery Ticket · 가공 전 초안만 담는다', () => {
  const withDraft = (value: unknown) => check(ticket({ primaryDraft: value as never }));

  it('가공 전 자료 한 건의 항목은 정확히 10개다', () => {
    assert.equal(VERIFICATION_DRAFT_SOURCE_FIELDS.length, 10);
    assert.deepEqual([...VERIFICATION_DRAFT_SOURCE_FIELDS], Object.keys(draftSource(0)));
    // 서버가 붙이는 세 값은 목록에 없다. 근거 번호도 서버가 붙인다.
    for (const key of ['sourceId', 'accessedAt', 'evidenceId']) {
      assert.equal((VERIFICATION_DRAFT_SOURCE_FIELDS as readonly string[]).includes(key), false, key);
    }
  });

  it('가공 전 자료 10개 항목만 있으면 통과한다', () => {
    const outcome = withDraft(draft({ sources: [draftSource(0)] }));
    assert.equal(outcome.valid, true, outcome.errors.join(' / '));
  });

  it('sourceId를 붙이면 거절한다', () => {
    const outcome = withDraft(
      draft({ sources: [{ ...draftSource(0), sourceId: `src_${'a'.repeat(64)}` } as never] }),
    );
    assert.equal(outcome.valid, false);
    assert.ok(outcome.errors.some((error) => error.includes('표에 담을 수 없는 항목')));
  });

  it('accessedAt을 붙이면 거절한다', () => {
    const outcome = withDraft(
      draft({ sources: [{ ...draftSource(0), accessedAt: '2026-09-01' } as never] }),
    );
    assert.equal(outcome.valid, false);
    assert.ok(outcome.errors.some((error) => error.includes('표에 담을 수 없는 항목')));
  });

  it('둘 다 붙이면 거절한다', () => {
    assert.equal(withDraft(draft({ sources: [materializedSource(0) as never] })).valid, false);
  });

  it('서버가 만든 최종 자료 목록은 표에 담지 못한다', () => {
    // materializeHarvestResult가 만든 모양이다. Ticket이 담는 것은 그 이전 단계다.
    const outcome = withDraft(
      draft({ sources: [materializedSource(0), materializedSource(1)] as never }),
    );
    assert.equal(outcome.valid, false);
  });

  it('더 깊은 곳에 숨겨도 거절한다', () => {
    for (const key of ['sourceId', 'accessedAt']) {
      const deeper = withDraft(
        draft({ sources: [{ ...draftSource(0), intendedUse: [{ [key]: 'x' }] } as never] }),
      );
      assert.ok(
        deeper.errors.some((error) => error.includes('표에 담을 수 없는 항목')),
        key,
      );
      const inRejected = withDraft(
        draft({ rejectedSources: [{ ...draftRejected(2), [key]: 'x' } as never] }),
      );
      assert.ok(
        inRejected.errors.some((error) => error.includes('표에 담을 수 없는 항목')),
        key,
      );
    }
  });

  it('Ticket은 sourceId도 accessedAt도 만들지 않는다', () => {
    const source = readFileSync(
      new URL('../../supabase/functions/_shared/harvest-recovery-ticket.ts', import.meta.url),
      'utf8',
    );
    assert.equal(source.includes('computeSourceId'), false);
    assert.equal(source.includes('src_'), false);
    assert.equal(source.includes('isIsoDate'), false);
    assert.equal(source.includes('toISOString'), false);
    // 최종 결과 단계의 상한은 이 파일에서 쓰지 않는다.
    assert.equal(source.includes('FINAL_REJECTED_SOURCE_MAX'), false);
    assert.ok(source.includes('REJECTED_SOURCE_MAX'));
  });

  it('실행 본체와 같은 규칙 하나를 본다', () => {
    const execution = readFileSync(
      new URL('../../supabase/functions/_shared/source-harvester-execution.ts', import.meta.url),
      'utf8',
    );
    const ticketSource = readFileSync(
      new URL('../../supabase/functions/_shared/harvest-recovery-ticket.ts', import.meta.url),
      'utf8',
    );
    const shared = readFileSync(
      new URL('../../supabase/functions/_shared/verification-draft-source.ts', import.meta.url),
      'utf8',
    );

    // 자료 한 건의 규칙은 두 곳이 같은 파일 하나를 본다.
    assert.ok(execution.includes('verification-draft-source.ts'));
    assert.ok(ticketSource.includes('verification-draft-source.ts'));

    // 9개 항목 목록을 직접 적어 둔 곳은 계약 파일 한 곳뿐이다.
    assert.ok(shared.includes('VERIFICATION_DRAFT_SOURCE_FIELDS'));
    for (const file of [execution, ticketSource, shared]) {
      assert.equal(file.includes("'sourceType'"), false);
    }

    // 제외 기록 항목은 두 곳이 여전히 같은 목록을 쓴다.
    for (const file of [execution, ticketSource]) {
      assert.ok(file.includes('VERIFICATION_DRAFT_REJECTED_FIELDS'));
    }
  });
});

describe('Recovery Ticket · migration', () => {
  const sql = readFileSync(
    new URL('../../supabase/migrations/20260831143037_harvest_recovery_ticket.sql', import.meta.url),
    'utf8',
  );
  const code = sql.replace(/^\s*--.*$/gm, '');

  it('표는 private 스키마에 있다', () => {
    assert.ok(code.includes('create table private.harvest_recovery_ticket'));
    assert.equal(/create table public\./.test(code), false);
  });

  it('상태 칸이 없다', () => {
    // 줄이 있으면 아직 안 쓴 것, 없으면 쓸 수 없는 것이다.
    assert.equal(/^\s*status\s/m.test(code), false);
    for (const word of ['pending', 'processing', 'completed', 'failed']) {
      assert.equal(code.includes(word), false, word);
    }
  });

  it('마무리용 함수를 만들지 않는다', () => {
    assert.equal(code.includes('finish_harvest_recovery_ticket'), false);
  });

  it('수명 30분을 서버가 정한다', () => {
    assert.ok(code.includes("now() + interval '30 minutes'"));
    assert.equal(RECOVERY_TICKET_TTL_MINUTES, 30);
    // 수명을 인자로 받지 않는다.
    assert.equal(/p_expires_at|p_ttl/.test(code), false);
  });

  it('만드는 함수와 쓰는 함수가 있다', () => {
    assert.ok(code.includes('create or replace function public.create_harvest_recovery_ticket'));
    assert.ok(code.includes('create or replace function public.consume_harvest_recovery_ticket'));
  });

  it('쓰는 함수는 지우면서 꺼낸다', () => {
    assert.ok(/delete from private\.harvest_recovery_ticket t[\s\S]{0,200}returning/.test(code));
    assert.ok(code.includes('t.recovery_id = p_recovery_id'));
    assert.ok(code.includes('t.expires_at > now()'));
  });

  it('만들 때와 쓸 때 만료된 표를 치운다', () => {
    const cleanups = code.match(/delete from private\.harvest_recovery_ticket\s*\n\s*where expires_at <= now\(\)/g);
    assert.equal(cleanups?.length, 2);
    // 따로 도는 작업을 만들지 않는다.
    assert.equal(/cron|pg_cron|schedule/i.test(code), false);
  });

  it('표에 직접 접근할 권한을 주지 않는다', () => {
    assert.ok(code.includes('revoke all on table private.harvest_recovery_ticket from public;'));
    assert.ok(code.includes('revoke all on table private.harvest_recovery_ticket from anon, authenticated, service_role;'));
    assert.ok(code.includes('alter table private.harvest_recovery_ticket enable row level security;'));
    assert.equal(/create policy/i.test(code), false);
    assert.equal(/grant .* on table private\.harvest_recovery_ticket/i.test(code), false);
  });

  it('두 함수는 서버 역할만 부를 수 있다', () => {
    for (const fn of ['create_harvest_recovery_ticket', 'consume_harvest_recovery_ticket']) {
      const revokedPublic = new RegExp(`revoke all on function public\\.${fn}[\\s\\S]{0,200}?from public;`);
      const revokedRoles = new RegExp(`revoke all on function public\\.${fn}[\\s\\S]{0,200}?from anon, authenticated, service_role;`);
      const granted = new RegExp(`grant execute on function public\\.${fn}[\\s\\S]{0,200}?to service_role;`);
      assert.ok(revokedPublic.test(code), `${fn}: public revoke 없음`);
      assert.ok(revokedRoles.test(code), `${fn}: anon/authenticated revoke 없음`);
      assert.ok(granted.test(code), `${fn}: service_role grant 없음`);
    }
    assert.equal(/to (anon|authenticated|public)\s*;/.test(code), false);
  });

  it('두 함수 모두 검색 경로를 고정한다', () => {
    assert.equal((code.match(/security definer/g) || []).length, 2);
    assert.equal((code.match(/set search_path = private, pg_catalog/g) || []).length, 2);
  });

  it('만료 시각에 색인이 있다', () => {
    assert.ok(code.includes('create index harvest_recovery_ticket_expires_at_idx'));
    assert.ok(code.includes('on private.harvest_recovery_ticket (expires_at)'));
  });

  it('사용자 정보 칸이 없다', () => {
    for (const word of ['user_id', 'session', 'device', 'jwt', 'ip_', 'situation', 'prayer', 'emotion']) {
      assert.equal(code.includes(word), false, word);
    }
  });

  it('만드는 함수는 표 id만 돌려준다', () => {
    const create = code.split('create or replace function public.create_harvest_recovery_ticket')[1].split('$$;')[0];
    assert.ok(create.includes('returns uuid'));
    assert.equal(create.includes('returns table'), false);
  });

  it('모양 검사를 DB에서도 한다', () => {
    assert.ok(code.includes("prioritizer_snapshot_id ~ '^snap_[0-9a-f]{64}$'"));
    assert.ok(code.includes("active_covered_hash ~ '^[0-9a-f]{64}$'"));
    assert.ok(code.includes('expires_at > created_at'));
  });

  it('빈 주소 목록을 DB가 실제로 막는다', () => {
    // array_length()는 빈 배열에서 "없음"을 돌려주고, CHECK는 없음을 통과로 본다.
    // cardinality()는 0을 돌려주므로 실제로 막힌다.
    assert.ok(code.includes('cardinality(discovered_urls) >= 1'));
    assert.equal(code.includes('array_length('), false);
  });
});

describe('Recovery Ticket · 영역 목록 지문', () => {
  const covered = ['fear_uncertainty', 'grief_loss', 'gratitude_joy'];

  it('64자리 소문자 16진수를 만든다', async () => {
    const hash = await computeActiveCoveredHash(covered);
    assert.match(hash, /^[0-9a-f]{64}$/);
  });

  it('순서가 달라도 같은 지문이다', async () => {
    const a = await computeActiveCoveredHash(covered);
    const b = await computeActiveCoveredHash([...covered].reverse());
    const c = await computeActiveCoveredHash(['grief_loss', 'fear_uncertainty', 'gratitude_joy']);
    assert.equal(a, b);
    assert.equal(a, c);
  });

  it('같은 이름이 두 번 있어도 같은 지문이다', async () => {
    const a = await computeActiveCoveredHash(covered);
    const b = await computeActiveCoveredHash([...covered, 'grief_loss', 'fear_uncertainty']);
    assert.equal(a, b);
  });

  it('영역이 하나라도 달라지면 다른 지문이다', async () => {
    const a = await computeActiveCoveredHash(covered);
    assert.notEqual(a, await computeActiveCoveredHash([...covered, 'quiet_communion']));
    assert.notEqual(a, await computeActiveCoveredHash(covered.slice(1)));
    assert.notEqual(a, await computeActiveCoveredHash([]));
  });

  it('같은 입력이면 언제 계산해도 같다', async () => {
    assert.equal(
      await computeActiveCoveredHash(covered),
      await computeActiveCoveredHash(covered),
    );
  });

  it('표가 요구하는 모양을 그대로 만족한다', async () => {
    const hash = await computeActiveCoveredHash(covered);
    assert.equal(check(ticket({ activeCoveredHash: hash })).valid, true);
  });

  it('영역 이름 말고는 계산에 들어가지 않는다', () => {
    const source = readFileSync(
      new URL('../../supabase/functions/_shared/harvest-recovery-ticket.ts', import.meta.url),
      'utf8',
    );
    const body = source.split('export async function computeActiveCoveredHash')[1].split('\n}')[0];
    // 계산에 쓰는 것은 넘겨받은 목록 하나뿐이다.
    assert.ok(body.includes('v1|covered:'));
    for (const banned of ['situation', 'userId', 'Date', 'now(', 'random']) {
      assert.equal(body.includes(banned), false, banned);
    }
  });
});

describe('Recovery Ticket · 어디까지 연결했는가', () => {
  const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');

  it('표를 만드는 쪽만 연결되어 있다', () => {
    // 실행 본체가 무엇을 담을지 정하고, Edge Function이 실제로 보낸다.
    for (const path of [
      '../../supabase/functions/_shared/source-harvester-execution.ts',
      '../../supabase/functions/source-harvester/index.ts',
      '../../supabase/functions/source-harvester/handler.ts',
    ]) {
      assert.ok(read(path).includes('harvest-recovery-ticket'), path);
    }
    // 계약 파일과 순수 검증 파일은 표를 모른다.
    for (const path of [
      '../../supabase/functions/_shared/source-harvester-execution-contract.ts',
      '../../supabase/functions/_shared/source-harvester.ts',
    ]) {
      assert.equal(read(path).includes('harvest-recovery-ticket'), false, path);
    }
  });

  it('표를 꺼내는 쪽은 두 번째 요청 경로에만 연결되어 있다', () => {
    // DB로 가는 길은 Edge Function 파일에, 결과를 읽는 일은 요청 처리 본체에 있다.
    assert.ok(read('../../supabase/functions/source-harvester/index.ts')
      .includes('consume_harvest_recovery_ticket'));
    assert.ok(read('../../supabase/functions/source-harvester/handler.ts')
      .includes('parseConsumeTicketResponse'));

    // 첫 번째 요청의 실행 본체는 표를 꺼내는 일을 모른다.
    const execution = read('../../supabase/functions/_shared/source-harvester-execution.ts');
    assert.equal(execution.includes('consume_harvest_recovery_ticket'), false);
    assert.equal(execution.includes('parseConsumeTicketResponse'), false);

    // 표 줄을 직접 읽는 일은 어느 실행 경로에도 없다.
    for (const path of [
      '../../supabase/functions/source-harvester/index.ts',
      '../../supabase/functions/source-harvester/handler.ts',
      '../../supabase/functions/_shared/source-harvester-execution.ts',
    ]) {
      assert.equal(read(path).includes('mapTicketRowToState'), false, path);
    }
  });

  it('DB에 닿는 곳은 Edge Function 파일 하나뿐이다', () => {
    // 요청 처리 본체와 실행 본체는 여전히 DB도 네트워크도 모른다.
    for (const path of [
      '../../supabase/functions/source-harvester/handler.ts',
      '../../supabase/functions/_shared/source-harvester-execution.ts',
    ]) {
      const source = read(path);
      for (const banned of ['SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_URL', 'createClient', '/rest/v1/', 'Deno.env']) {
        assert.equal(source.includes(banned), false, `${path}: ${banned}`);
      }
    }

    const index = read('../../supabase/functions/source-harvester/index.ts');
    const paths = [...index.matchAll(/\/rest\/v1\/[a-z0-9_/]*/g)].map((match) => match[0]);
    // 이어서 할 표 둘, 시작 전 판단 대조 하나, 끝난 뒤 꾸러미 적어 두기 하나.
    assert.deepEqual([...new Set(paths)].sort(), [
      '/rest/v1/rpc/consume_harvest_recovery_ticket',
      '/rest/v1/rpc/consume_prioritizer_decision',
      '/rest/v1/rpc/create_biblical_research_handoff',
      '/rest/v1/rpc/create_harvest_recovery_ticket',
    ]);
  });

  it('DB 함수에 보내는 값은 정해진 것뿐이다', () => {
    const index = read('../../supabase/functions/source-harvester/index.ts');
    const params = [...index.matchAll(/\bp_[a-z_]+/g)].map((match) => match[0]);

    assert.deepEqual([...new Set(params)].sort(), [
      'p_active_covered_hash',
      // 판단을 대조할 때만 쓰는 인자다.
      'p_decision_id',
      'p_discovered_urls',
      'p_evidence_version',
      'p_primary_draft',
      'p_primary_inspected_urls',
      'p_primary_tool_counts',
      'p_prioritizer_snapshot_id',
      'p_recovery_id',
      'p_target_domain',
    ]);

    // migration이 받는 인자 이름과 정확히 같아야 한다.
    const sql = read('../../supabase/migrations/20260831143037_harvest_recovery_ticket.sql');
    const decisionSql = read('../../supabase/migrations/20260902030000_prioritizer_decision.sql');
    const declared = [
      sql.split('create or replace function public.create_harvest_recovery_ticket(')[1].split(')')[0],
      sql.split('create or replace function public.consume_harvest_recovery_ticket(')[1].split(')')[0],
      decisionSql
        .split('create or replace function public.consume_prioritizer_decision(')[1]
        .split(')')[0],
    ];
    for (const param of new Set(params)) {
      assert.ok(declared.some((block) => block.includes(param)), param);
    }

    // 수명을 인자로 보내지 않는다.
    assert.equal(index.includes('p_expires_at'), false);
    assert.equal(index.includes('p_ttl'), false);
  });

  it('표를 만드는 일 말고 다른 DB 작업에 서버 권한을 쓰지 않는다', () => {
    const index = read('../../supabase/functions/source-harvester/index.ts');
    for (const banned of [
      'content_research_queue',
      'coverage_gap',
      'openai_rate_limit',
      'refresh_content_research_queue',
      'get_content_research_queue_for_prioritizer',
      'scripture',
      'from(',
      '.insert(',
      '.select(',
      '.delete(',
    ]) {
      assert.equal(index.includes(banned), false, banned);
    }
  });

  it('저장소 파일에 실행 환경 코드가 없다', () => {
    const source = read('../../supabase/functions/_shared/harvest-recovery-ticket.ts');
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '');
    for (const banned of ['Deno.env', 'fetch(', 'process.env', 'createClient']) {
      assert.equal(code.includes(banned), false, banned);
    }
  });

  it('실행 파일에 기대지 않는다', () => {
    // 나중에 실행 쪽이 이 파일을 쓰게 되므로, 지금 반대 방향 의존을 만들면 서로 물린다.
    const source = read('../../supabase/functions/_shared/harvest-recovery-ticket.ts');
    assert.equal(source.includes('source-harvester-execution'), false);
  });

  it('주소 정리 규칙을 새로 만들지 않는다', () => {
    const source = read('../../supabase/functions/_shared/harvest-recovery-ticket.ts');
    assert.ok(source.includes("import { normalizeSourceUrl } from './source-harvester.ts'"));
    assert.equal(source.includes('new URL('), false);
  });
});
