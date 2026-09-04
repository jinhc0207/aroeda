/**
 * 자료 한 건의 규칙 테스트 · 두 검사가 같은 기준을 보는지 확인한다
 *
 * 실행: npm test
 *
 * production에서 이런 일이 있었다.
 *   2단계 응답 검사는 통과했는데, 표에 담을 때 같은 자료가 거절되어
 *   "표를 만들지 못했다"로 끝났다. 원인은 두 검사의 기준 차이였다.
 * 여기서는 그 차이가 다시 생기지 않는지 본다.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import {
  DRAFT_SOURCE_ISSUES,
  checkVerificationDraftSource,
  isValidVerificationDraftSource,
} from '../../supabase/functions/_shared/verification-draft-source.ts';
import { validateHarvestDraft } from '../../supabase/functions/_shared/source-harvester-execution.ts';
import { validateHarvestRecoveryTicketInput } from '../../supabase/functions/_shared/harvest-recovery-ticket.ts';
import {
  PUBLICATION_YEAR_MAX,
  PUBLICATION_YEAR_MIN,
  RELEVANCE_NOTE_MAX,
} from '../../supabase/functions/_shared/source-harvest-contract.ts';
import { buildSourceHarvestBrief } from '../../supabase/functions/_shared/source-harvester.ts';
import { getActiveCoveredDomains } from '../../supabase/functions/_shared/research-prioritizer-edge.ts';

const url = (index: number) => `https://sources.example.org/aroeda/fixture-${index}`;
const urls = (count: number) => Array.from({ length: count }, (_, index) => url(index));

const SNAPSHOT = `snap_${'3'.repeat(64)}`;
const DOMAIN = 'financial_hardship';
const covered = getActiveCoveredDomains();

const brief = () =>
  buildSourceHarvestBrief({
    targetDomain: DOMAIN,
    evidenceVersion: 1,
    prioritizerSnapshotId: SNAPSHOT,
    activeCoveredDomains: covered,
  });

/** 규칙을 모두 지킨 자료 한 건 */
const source = (overrides: Record<string, unknown> = {}) => {
  // 근거의 용도는 그 자료가 실제로 가진 용도를 따라간다.
  // 용도를 바꾼 사본에서도 근거가 저절로 맞게 따라오도록 한다.
  const uses = (overrides.intendedUse as string[] | undefined) ?? ['exegesis'];
  const use = uses[0];

  return {
  sourceType: 'commentary',
  title: '재정 어려움 본문 주석',
  authorOrOrganization: '연구자 이름',
  publisherOrInstitution: 'Fixture Academic Press',
  publicationYear: 2015,
  url: url(0),
  accessLevel: 'full_text',
  intendedUse: ['exegesis'],
  relevanceNote: '이 본문의 문맥을 확인하는 데 필요합니다.',
  evidenceClaims: [
    {
      intendedUse: use,
      statement: '이 주석은 본문의 반복 구조를 절망의 부정이 아니라 신뢰 회복의 움직임으로 읽는다.',
      passageReferences:
        use === 'exegesis' ? [{ book: 'Psalms', chapter: 42, startVerse: 5, endVerse: 5 }] : [],
    },
  ],
  ...overrides,
  };
};

/** 2단계 응답 검사에 그 자료 한 건을 넣어 본다. */
const verificationAccepts = (entry: unknown) =>
  validateHarvestDraft(
    {
      targetDomain: DOMAIN,
      evidenceVersion: 1,
      prioritizerSnapshotId: SNAPSHOT,
      sources: [entry],
      rejectedSources: [],
      unresolvedSourceQuestions: [],
    },
    brief(),
  ).ok;

/** 표에 담을 값 검사에 같은 자료 한 건을 넣어 본다. */
const ticketAccepts = (entry: unknown) =>
  validateHarvestRecoveryTicketInput({
    targetDomain: DOMAIN,
    evidenceVersion: 1,
    prioritizerSnapshotId: SNAPSHOT,
    activeCoveredHash: 'a'.repeat(64),
    discoveredUrls: urls(8),
    primaryInspectedUrls: urls(4),
    primaryDraft: {
      sources: [entry],
      rejectedSources: [],
      unresolvedSourceQuestions: [],
    },
    primaryToolCounts: {
      webSearchCallCount: 4,
      searchActionCount: 0,
      openPageActionCount: 4,
      findInPageActionCount: 0,
      unknownActionCount: 0,
      uniqueInspectedUrlCount: 4,
    },
  }).valid;

/** 두 검사가 같은 답을 내는가. */
const parity = (entry: unknown) => ({
  verification: verificationAccepts(entry),
  ticket: ticketAccepts(entry),
  shared: isValidVerificationDraftSource(entry),
});

describe('자료 한 건 · 두 검사가 같은 기준을 본다', () => {
  it('규칙을 지킨 자료는 두 곳 다 받아들인다', () => {
    const outcome = parity(source());
    assert.deepEqual(outcome, { verification: true, ticket: true, shared: true });
  });

  it('출판 연도를 확인하지 못한 자료도 두 곳 다 받아들인다', () => {
    assert.deepEqual(parity(source({ publicationYear: null })), {
      verification: true,
      ticket: true,
      shared: true,
    });
  });

  it('출판 연도가 범위 밖이면 두 곳 다 거절한다', () => {
    // 예전에는 2단계만 통과하고 표에서 거절되던 자리다.
    for (const year of [PUBLICATION_YEAR_MIN - 1, PUBLICATION_YEAR_MAX + 1, 0, -100, 3000]) {
      assert.deepEqual(parity(source({ publicationYear: year })), {
        verification: false,
        ticket: false,
        shared: false,
      }, String(year));
    }
  });

  it('연도 경계값은 두 곳 다 받아들인다', () => {
    for (const year of [PUBLICATION_YEAR_MIN, PUBLICATION_YEAR_MAX]) {
      assert.deepEqual(parity(source({ publicationYear: year })), {
        verification: true,
        ticket: true,
        shared: true,
      }, String(year));
    }
  });

  it('메모가 너무 길면 두 곳 다 거절한다', () => {
    const tooLong = 'ㄱ'.repeat(RELEVANCE_NOTE_MAX + 1);
    assert.deepEqual(parity(source({ relevanceNote: tooLong })), {
      verification: false,
      ticket: false,
      shared: false,
    });
  });

  it('메모 길이 경계값은 두 곳 다 받아들인다', () => {
    const atLimit = 'ㄱ'.repeat(RELEVANCE_NOTE_MAX);
    assert.deepEqual(parity(source({ relevanceNote: atLimit })), {
      verification: true,
      ticket: true,
      shared: true,
    });
  });

  it('같은 용도를 두 번 적으면 두 곳 다 거절한다', () => {
    assert.deepEqual(parity(source({ intendedUse: ['exegesis', 'exegesis'] })), {
      verification: false,
      ticket: false,
      shared: false,
    });
  });

  it('자료 종류에 맞지 않는 용도는 두 곳 다 거절한다', () => {
    // 목회 보조자료를 성경 주해의 근거로 쓸 수 없다.
    assert.deepEqual(
      parity(source({ sourceType: 'pastoral_resource', intendedUse: ['exegesis'] })),
      { verification: false, ticket: false, shared: false },
    );
    // 전문 분야 자료도 마찬가지다.
    assert.deepEqual(
      parity(source({ sourceType: 'professional_context', intendedUse: ['biblical_theology'] })),
      { verification: false, ticket: false, shared: false },
    );
  });

  it('맞는 조합은 두 곳 다 받아들인다', () => {
    assert.deepEqual(
      parity(source({ sourceType: 'pastoral_resource', intendedUse: ['pastoral_application'] })),
      { verification: true, ticket: true, shared: true },
    );
    assert.deepEqual(
      parity(source({ sourceType: 'professional_context', intendedUse: ['pastoral_safety'] })),
      { verification: true, ticket: true, shared: true },
    );
  });

  it('받을 수 없는 주소는 두 곳 다 거절한다', () => {
    for (const bad of ['http://example.org/x', 'javascript:alert(1)', 'https://127.0.0.1/x', '']) {
      assert.deepEqual(parity(source({ url: bad })), {
        verification: false,
        ticket: false,
        shared: false,
      }, bad);
    }
  });

  it('그 밖의 기본 규칙도 두 곳이 같다', () => {
    const cases: Record<string, unknown>[] = [
      { sourceType: 'blog' },
      { sourceType: 'bible_primary' },
      { accessLevel: 'metadata_only' },
      { intendedUse: [] },
      { intendedUse: ['made_up_use'] },
      { title: '' },
      { authorOrOrganization: '   ' },
      { publisherOrInstitution: '' },
      { relevanceNote: '' },
      { extraField: 1 },
    ];

    for (const patch of cases) {
      const outcome = parity(source(patch));
      assert.equal(outcome.verification, false, JSON.stringify(patch));
      assert.equal(outcome.ticket, false, JSON.stringify(patch));
      assert.equal(outcome.shared, false, JSON.stringify(patch));
    }
  });

  it('필수 항목이 빠져도 두 곳이 같다', () => {
    for (const key of Object.keys(source())) {
      const partial = { ...source() } as Record<string, unknown>;
      delete partial[key];
      const outcome = parity(partial);
      assert.equal(outcome.verification, false, key);
      assert.equal(outcome.ticket, false, key);
    }
  });
});

describe('자료 한 건 · 규칙을 어긴 까닭', () => {
  it('까닭은 고정된 이름뿐이다', () => {
    assert.equal(new Set(DRAFT_SOURCE_ISSUES).size, DRAFT_SOURCE_ISSUES.length);
    for (const issue of DRAFT_SOURCE_ISSUES) assert.match(issue, /^[a-z_]+$/);
  });

  it('까닭에 자료 내용이 들어가지 않는다', () => {
    const issues = checkVerificationDraftSource(
      source({
        title: '',
        publicationYear: 3000,
        relevanceNote: 'ㄱ'.repeat(RELEVANCE_NOTE_MAX + 1),
        url: 'http://leak.example.org/secret-path',
      }),
    );

    assert.ok(issues.length > 0);
    for (const issue of issues) {
      assert.ok((DRAFT_SOURCE_ISSUES as readonly string[]).includes(issue), issue);
      assert.equal(issue.includes('leak.example.org'), false);
      assert.equal(issue.includes('http'), false);
    }
  });

  it('어긴 것을 모두 모아서 돌려준다', () => {
    const issues = checkVerificationDraftSource(
      source({ title: '', publicationYear: 3000, accessLevel: 'metadata_only' }),
    );
    assert.ok(issues.includes('title_empty'));
    assert.ok(issues.includes('publication_year_invalid'));
    assert.ok(issues.includes('access_level_invalid'));
  });

  it('객체가 아니면 그것만 알려 준다', () => {
    for (const bad of [null, 'source', 42, [], true]) {
      assert.deepEqual(checkVerificationDraftSource(bad), ['not_an_object'], String(bad));
    }
  });

  it('자료를 고치지 않는다', () => {
    const shared = readFileSync(
      new URL('../../supabase/functions/_shared/verification-draft-source.ts', import.meta.url),
      'utf8',
    );
    // 자르거나 바꾸는 코드가 없다.
    // (빈 값인지 보려고 앞뒤 공백을 떼어 보는 것은 값을 고치는 것이 아니다.)
    for (const banned of ['.slice(0,', '.substring(', 'Math.min(', 'Math.max(', '.padEnd(']) {
      assert.equal(shared.includes(banned), false, banned);
    }
    // 목록과 숫자를 새로 적지 않는다.
    assert.ok(shared.includes('PUBLICATION_YEAR_MIN'));
    assert.ok(shared.includes('RELEVANCE_NOTE_MAX'));
    assert.ok(shared.includes('isSourceTypeAllowedForUse'));
    assert.equal(shared.includes("'commentary'"), false);
    assert.equal(shared.includes("'full_text'"), false);
  });
});

describe('자료 한 건 · 계층 방향', () => {
  const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');

  it('두 실행 경로가 공용 규칙을 바라본다', () => {
    const execution = read('../../supabase/functions/_shared/source-harvester-execution.ts');
    const ticket = read('../../supabase/functions/_shared/harvest-recovery-ticket.ts');

    assert.ok(execution.includes('verification-draft-source.ts'));
    assert.ok(ticket.includes('verification-draft-source.ts'));
  });

  it('두 실행 경로가 서로를 거꾸로 참조하지 않는다', () => {
    const execution = read('../../supabase/functions/_shared/source-harvester-execution.ts');
    const ticket = read('../../supabase/functions/_shared/harvest-recovery-ticket.ts');

    // 표 저장소는 실행 본체를 모른다.
    assert.equal(ticket.includes('source-harvester-execution.ts'), false);
    // 실행 본체는 표의 자료 검사를 부르지 않는다.
    assert.equal(execution.includes('checkDraftSource'), false);
  });

  it('공용 규칙 파일은 실행 환경을 모른다', () => {
    const shared = read('../../supabase/functions/_shared/verification-draft-source.ts');
    const code = shared.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '');
    for (const banned of ['Deno.env', 'fetch(', 'process.env', 'createClient', '/rest/v1/']) {
      assert.equal(code.includes(banned), false, banned);
    }
    // 실행 본체나 표 저장소를 참조하지 않는다.
    assert.equal(shared.includes('source-harvester-execution.ts'), false);
    assert.equal(shared.includes('harvest-recovery-ticket.ts'), false);
  });
});
