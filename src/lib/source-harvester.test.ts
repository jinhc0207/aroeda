/**
 * Source Harvester v1 계약 테스트
 *
 * 실행: npm test
 *
 * 실제 웹 검색, 페이지 접속, AI, Supabase를 쓰지 않는다. fixture만 사용한다.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  ACCEPTED_MAX,
  ACCEPTED_MIN,
  FINAL_REJECTED_SOURCE_MAX,
  MODEL_REJECTION_REASONS,
  SERVER_ONLY_REJECTION_REASONS,
  SERVER_REJECTED_SOURCE_MAX,
  ACCESS_LEVELS,
  ALLOWED_INTENDED_USES,
  HARVESTABLE_SOURCE_TYPES,
  INTENDED_USES,
  PUBLISHER_MIN,
  REJECTED_SOURCE_MAX,
  RESEARCH_CONSTITUTION,
  SCHOLARLY_CORE_MIN,
  SOURCE_HARVEST_SCHEMA,
  SOURCE_REJECTION_REASONS,
  buildSourceHarvestInstructions,
} from '../../supabase/functions/_shared/source-harvest-contract.ts';
import {
  InvalidResearchBriefError,
  buildSourceHarvestBrief,
  computeSourceId,
  isValidSourceUrl,
  normalizeSourceUrl,
  toResearchSources,
  validateSourceHarvestResult,
  type HarvestedSource,
  type RejectedSource,
  type SourceHarvestBrief,
  type SourceHarvestResult,
} from '../../supabase/functions/_shared/source-harvester.ts';
import { RESEARCHABLE_DOMAINS } from '../../supabase/functions/_shared/research-prioritizer-contract.ts';
import { getActiveCoveredDomains } from '../../supabase/functions/_shared/research-prioritizer-edge.ts';
import {
  isSourceAllowedForRole,
  isSourceTypeAllowedForUse,
  type ResearchSource,
} from '../../supabase/functions/_shared/research-source.ts';
import {
  validateBiblicalResearchResult,
  type SourceSupport,
} from '../../supabase/functions/_shared/biblical-researcher.ts';

const activeCovered = getActiveCoveredDomains();

const brief = (): SourceHarvestBrief =>
  buildSourceHarvestBrief({
    targetDomain: 'financial_hardship',
    evidenceVersion: 4,
    prioritizerSnapshotId: `snap_${'a'.repeat(64)}`,
    activeCoveredDomains: activeCovered,
  });

/** 구조 확인용 fixture. 실제 조사한 자료가 아니다. */
type Spec = Pick<
  HarvestedSource,
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
    intendedUse: ['exegesis', 'real_world_context'],
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
  {
    sourceType: 'scholarly_institution',
    publisherOrInstitution: 'Fixture Research Institute',
    intendedUse: ['biblical_theology'],
    accessLevel: 'full_text',
  },
  {
    sourceType: 'systematic_theology',
    publisherOrInstitution: 'Fixture Academic Press',
    intendedUse: ['doctrinal_context'],
    accessLevel: 'full_text',
  },
];

const fixtureUrl = (index: number) => `https://sources.example.org/aroeda/fixture-${index}`;

async function makeSource(index: number, overrides: Partial<HarvestedSource> = {}): Promise<HarvestedSource> {
  const spec = SPECS[index % SPECS.length];
  const url = overrides.url ?? fixtureUrl(index);
  const sourceId = (await computeSourceId(url)) ?? `src_${index}`;

  return {
    sourceId,
    sourceType: spec.sourceType,
    title: `연구 자료 ${index}`,
    authorOrOrganization: `연구자 ${index}`,
    publisherOrInstitution: spec.publisherOrInstitution,
    publicationYear: 2018 + (index % 5),
    url,
    accessedAt: '2026-08-29',
    accessLevel: spec.accessLevel,
    intendedUse: [...spec.intendedUse],
    relevanceNote: '이 영역의 문맥을 확인하는 데 필요한 자료입니다.',
    evidenceClaims: [
      {
        evidenceId: `${sourceId}:e1`,
        intendedUse: spec.intendedUse[0],
        statement: '이 자료는 해당 영역의 문맥을 다루며 연구에 필요한 관점을 제공한다고 관찰되었다.',
        passageReferences: [],
      },
    ],
    ...overrides,
    ...(overrides.url ? { sourceId: overrides.sourceId ?? sourceId } : {}),
  };
}

async function makeSources(count: number): Promise<HarvestedSource[]> {
  const sources: HarvestedSource[] = [];
  for (let index = 0; index < count; index += 1) {
    sources.push(await makeSource(index));
  }
  return sources;
}

const rejectedSources = (count: number): RejectedSource[] =>
  Array.from({ length: count }, (_, index) => ({
    url: `https://blog.example.com/post-${index}`,
    title: index % 2 === 0 ? `묵상글 ${index}` : null,
    rejectionReason: 'anonymous_or_unverifiable' as const,
  }));

async function makeResult(
  overrides: Partial<SourceHarvestResult> = {},
): Promise<SourceHarvestResult> {
  const base = brief();
  return {
    targetDomain: base.targetDomain,
    evidenceVersion: base.evidenceVersion,
    prioritizerSnapshotId: base.prioritizerSnapshotId,
    sources: await makeSources(ACCEPTED_MIN),
    rejectedSources: rejectedSources(2),
    unresolvedSourceQuestions: [],
    ...overrides,
  };
}

const base = brief();
const check = (value: unknown) => validateSourceHarvestResult(value, base);

describe('Source Harvester · 수집 의뢰서', () => {
  it('카드가 없는 7개 영역만 수집 대상이 된다', () => {
    for (const domain of RESEARCHABLE_DOMAINS) {
      const made = buildSourceHarvestBrief({
        targetDomain: domain,
        evidenceVersion: 1,
        prioritizerSnapshotId: 'snap_x',
        activeCoveredDomains: activeCovered,
      });
      assert.equal(made.targetDomain, domain);
      assert.ok(made.domainDescription.length > 0);
    }
  });

  it('other_uncovered와 이미 카드가 있는 영역은 거절한다', () => {
    for (const domain of ['other_uncovered', 'grief_loss', 'fear_uncertainty', 'made_up']) {
      assert.throws(
        () =>
          buildSourceHarvestBrief({
            targetDomain: domain,
            evidenceVersion: 1,
            prioritizerSnapshotId: 'snap_x',
            activeCoveredDomains: activeCovered,
          }),
        InvalidResearchBriefError,
        domain,
      );
    }
  });

  it('의뢰서에 사용자 정보나 Prioritizer 판단 근거가 없다', () => {
    const made = brief();
    assert.deepEqual(Object.keys(made).sort(), [
      'activeCoveredDomains',
      'domainDescription',
      'evidenceVersion',
      'prioritizerSnapshotId',
      'targetDomain',
    ]);

    const text = JSON.stringify(made).toLowerCase();
    for (const banned of ['situation', 'reason', 'confidence', 'score', 'userid', 'jwt', 'token']) {
      assert.equal(text.includes(banned), false, `${banned}가 들어 있습니다.`);
    }
  });

  it('연구 의뢰서와 같은 helper를 쓴다', () => {
    // 두 의뢰서가 같은 구조여야 Biblical Researcher가 그대로 이어받을 수 있다.
    const made = buildSourceHarvestBrief({
      targetDomain: 'burnout_exhaustion',
      evidenceVersion: 2,
      prioritizerSnapshotId: 'snap_y',
      activeCoveredDomains: activeCovered,
    });
    assert.deepEqual(made.activeCoveredDomains, getActiveCoveredDomains());
  });
});

describe('Source Harvester · 지시문과 응답 구조', () => {
  it('지시문에 금지 사항과 원칙이 들어 있다', () => {
    const instructions = buildSourceHarvestInstructions(brief());

    for (const marker of [
      '성경 본문 후보를 고르지 않는다',
      '성경을 해석하거나 신학적 결론을 쓰지 않는다',
      '자기가 모은 자료를 스스로 최종 승인하지 않는다',
      '검색 결과에 나왔다는 이유만으로',
      '검색 결과 요약문(snippet)',
      '오늘의 말씀 사이트',
      '성경 해석의 근거로 쓰지 마십시오',
      '웹페이지 문장을 그대로 옮기거나 길게 인용하지 마십시오',
      '한 기관의 자료만으로 근거를 구성하지 마십시오',
      '고난은 믿음이 부족해서 생긴다',
      '학대 상황에서도 먼저 용서하고 참고 순종하라',
      '모른다고 적는 것은 실패가 아닙니다',
      'financial_hardship',
      '생계와 경제적 어려움',
    ]) {
      assert.ok(instructions.includes(marker), `지시문에 없습니다: ${marker}`);
    }

    for (const principle of RESEARCH_CONSTITUTION) {
      assert.ok(instructions.includes(principle), `원칙이 빠졌습니다: ${principle}`);
    }
  });

  it('응답 구조에 페이지 내용·인용문 자리가 없다', () => {
    assert.deepEqual(Object.keys(SOURCE_HARVEST_SCHEMA.properties).sort(), [
      'evidenceVersion',
      'prioritizerSnapshotId',
      'rejectedSources',
      'sources',
      'targetDomain',
      'unresolvedSourceQuestions',
    ]);
    assert.equal(SOURCE_HARVEST_SCHEMA.additionalProperties, false);

    // 응답 구조 어디에도 페이지 내용을 담을 항목 이름이 없어야 한다.
    // (enum 값에 들어 있는 search_snippet_only 같은 '거절 사유'와 헷갈리지 않도록 항목 이름만 본다.)
    const propertyNames: string[] = [];
    const collect = (node: unknown) => {
      if (Array.isArray(node)) {
        node.forEach(collect);
        return;
      }
      if (typeof node !== 'object' || node === null) return;
      for (const [key, child] of Object.entries(node)) {
        if (key === 'properties' && typeof child === 'object' && child !== null) {
          propertyNames.push(...Object.keys(child));
        }
        collect(child);
      }
    };
    collect(SOURCE_HARVEST_SCHEMA);

    for (const banned of ['rawHtml', 'html', 'pageContent', 'content', 'body', 'snippet', 'quote', 'quotation', 'fullText', 'excerpt', 'text']) {
      assert.equal(
        propertyNames.some((name) => name.toLowerCase() === banned.toLowerCase()),
        false,
        `${banned} 자리가 있습니다.`,
      );
    }

    // 성경 자체는 웹에서 수집하지 않는다.
    assert.equal((HARVESTABLE_SOURCE_TYPES as readonly string[]).includes('bible_primary'), false);
  });
});

describe('Source Harvester · 주소 검증', () => {
  it('https 주소는 통과한다', () => {
    for (const url of [
      'https://www.cambridge.org/core/journals/example/article/abc',
      'https://library.example.edu/handle/123/456',
      'https://example.org/a/b?page=2',
    ]) {
      assert.equal(isValidSourceUrl(url), true, url);
    }
  });

  it('http는 거절한다', () => {
    assert.equal(isValidSourceUrl('http://example.org/a'), false);
  });

  it('javascript / data / file / ftp 주소는 거절한다', () => {
    for (const url of [
      'javascript:alert(1)',
      'data:text/html,<h1>x</h1>',
      'file:///etc/passwd',
      'ftp://example.org/a',
      'about:blank',
    ]) {
      assert.equal(isValidSourceUrl(url), false, url);
    }
  });

  it('localhost는 거절한다', () => {
    for (const url of [
      'https://localhost/a',
      'https://localhost:443/a',
      'https://api.localhost/a',
      'https://intranet/a',
      'https://server.local/a',
      'https://svc.internal/a',
    ]) {
      assert.equal(isValidSourceUrl(url), false, url);
    }
  });

  it('되돌이 주소(loopback)는 거절한다', () => {
    for (const url of ['https://127.0.0.1/a', 'https://127.1.2.3/a', 'https://[::1]/a']) {
      assert.equal(isValidSourceUrl(url), false, url);
    }
  });

  it('내부망 주소는 거절한다', () => {
    for (const url of [
      'https://10.0.0.5/a',
      'https://192.168.1.10/a',
      'https://172.16.4.4/a',
      'https://169.254.169.254/latest/meta-data',
      'https://[fd00::1]/a',
    ]) {
      assert.equal(isValidSourceUrl(url), false, url);
    }
  });

  it('아이디·비밀번호가 들어간 주소는 거절한다', () => {
    for (const url of [
      'https://user:pass@example.org/a',
      'https://user@example.org/a',
      'https://admin:secret@library.example.edu/x',
    ]) {
      assert.equal(isValidSourceUrl(url), false, url);
    }
  });

  it('모양이 깨진 값은 거절한다', () => {
    for (const url of ['', '   ', 'example.org/a', 'https://', 'not a url', null, 42, {}, undefined]) {
      assert.equal(isValidSourceUrl(url), false, String(url));
    }
  });

  it('같은 자료를 가리키는 주소는 같은 모양으로 정리된다', () => {
    const canonical = 'https://example.org/a/b';
    for (const url of [
      'https://example.org/a/b',
      'https://Example.ORG/a/b',
      'https://example.org/a/b#section-2',
      'https://example.org:443/a/b',
      'https://example.org/a/b?utm_source=google&utm_medium=cpc',
      'https://example.org/a/b?fbclid=xyz',
      '  https://example.org/a/b  ',
    ]) {
      assert.equal(normalizeSourceUrl(url), canonical, url);
    }
  });

  it('두 번 정리해도 결과가 달라지지 않는다', () => {
    // 값 안에 &나 = 같은 글자가 들어 있어도 뜻이 바뀌면 안 된다.
    const cases = [
      'https://example.com/article?q=a%26b',
      'https://example.com/article?q=a%3Db',
      'https://example.com/a?q=%2Fpath%3Fx',
      'https://example.com/a?q=hello%20world',
      'https://example.com/a?q=%ED%8F%89%EC%95%88',
      'https://example.com/a?tag=x&tag=y',
      'https://example.com/a?q=a+b',
      'https://example.com/a?q=%2B',
      'https://example.com/a?utm_source=g&id=123&gclid=z',
      'https://example.com/a/b/?utm_medium=cpc#section',
      'https://example.com/',
      'https://example.com',
      'https://example.com/A/b?Q=Value',
      'https://example.com/article/',
      'https://example.com/article//',
      'https://example.com/article///',
      'https://example.com/a?x=2&x=1',
      'https://example.com/a?utm_source=g&b=2&a=1&gclid=z',
    ];

    for (const original of cases) {
      const once = normalizeSourceUrl(original);
      assert.notEqual(once, null, original);
      assert.equal(normalizeSourceUrl(once), once, `두 번 정리하니 달라집니다: ${original}`);
      assert.equal(normalizeSourceUrl(normalizeSourceUrl(once)), once, original);
    }
  });

  it('경로 끝의 /를 임의로 떼지 않는다', () => {
    // 끝의 /를 떼면 //가 정리할 때마다 하나씩 줄어들어 결과가 계속 달라진다.
    // 그러면 저장한 주소와 그 주소로 만든 id의 기준이 어긋난다.
    for (const path of ['/article', '/article/', '/article//', '/article///']) {
      const canonical = normalizeSourceUrl(`https://example.com${path}`);
      assert.equal(canonical, `https://example.com${path}`, path);
      assert.equal(normalizeSourceUrl(canonical), canonical, path);
    }

    // 네 가지가 모두 서로 다른 주소로 남는다.
    const canonicals = ['/article', '/article/', '/article//', '/article///'].map((path) =>
      normalizeSourceUrl(`https://example.com${path}`),
    );
    assert.equal(new Set(canonicals).size, 4);

    // 경로가 아예 없는 / 하나만 예외다.
    assert.equal(normalizeSourceUrl('https://example.com/'), 'https://example.com');
    assert.equal(normalizeSourceUrl('https://example.com'), 'https://example.com');
  });

  it('값 안의 특수문자가 주소의 뜻을 바꾸지 않는다', () => {
    // a%26b(값 하나)가 a와 b(값 둘)로 쪼개지면 안 된다.
    assert.equal(
      normalizeSourceUrl('https://example.com/article?q=a%26b'),
      'https://example.com/article?q=a%26b',
    );
    assert.notEqual(
      normalizeSourceUrl('https://example.com/article?q=a%26b'),
      normalizeSourceUrl('https://example.com/article?q=a&b'),
    );
  });

  it('같은 이름이 여러 번 나와도 모두, 원래 순서대로 남는다', () => {
    assert.equal(normalizeSourceUrl('https://example.com/a?tag=y&tag=x'), 'https://example.com/a?tag=y&tag=x');
    assert.equal(normalizeSourceUrl('https://example.com/a?tag=x&tag=y'), 'https://example.com/a?tag=x&tag=y');
    assert.notEqual(
      normalizeSourceUrl('https://example.com/a?tag=y&tag=x'),
      normalizeSourceUrl('https://example.com/a?tag=x'),
    );
  });

  it('흔한 이름의 값을 지워서 다른 자료를 합치지 않는다', () => {
    // source, ref는 사이트에 따라 실제 내용을 가리킬 수 있으므로 지우지 않는다.
    assert.notEqual(
      normalizeSourceUrl('https://example.com/article?source=editionA&id=123'),
      normalizeSourceUrl('https://example.com/article?source=editionB&id=123'),
    );
    assert.notEqual(
      normalizeSourceUrl('https://example.com/a?ref=chapterA'),
      normalizeSourceUrl('https://example.com/a?ref=chapterB'),
    );
    assert.equal(
      normalizeSourceUrl('https://example.com/article?source=editionA&id=123'),
      'https://example.com/article?source=editionA&id=123',
    );
  });

  it('광고·메일 추적용 값만 지우고, 남은 값의 순서는 그대로 둔다', () => {
    assert.equal(
      normalizeSourceUrl('https://example.com/a?utm_source=g&utm_medium=cpc&gclid=z&fbclid=y&id=123'),
      'https://example.com/a?id=123',
    );
    assert.equal(
      normalizeSourceUrl('https://example.com/a?utm_source=g&b=2&a=1&gclid=z'),
      'https://example.com/a?b=2&a=1',
    );
    for (const param of ['msclkid', 'yclid', 'igshid', 'mc_cid', 'mc_eid']) {
      assert.equal(normalizeSourceUrl(`https://example.com/a?${param}=x&id=1`), 'https://example.com/a?id=1');
    }
  });

  it('뜻이 다른 주소는 다르게 남는다', () => {
    assert.notEqual(normalizeSourceUrl('https://example.org/a'), normalizeSourceUrl('https://example.org/A'));
    assert.notEqual(
      normalizeSourceUrl('https://example.org/a?page=2'),
      normalizeSourceUrl('https://example.org/a?page=3'),
    );

    // 경로 끝의 /를 임의로 떼지 않는다. 다른 자료일 수 있기 때문이다.
    assert.equal(normalizeSourceUrl('https://example.org/article'), 'https://example.org/article');
    assert.equal(normalizeSourceUrl('https://example.org/article/'), 'https://example.org/article/');
    assert.equal(normalizeSourceUrl('https://example.org/article//'), 'https://example.org/article//');
    assert.notEqual(
      normalizeSourceUrl('https://example.org/article'),
      normalizeSourceUrl('https://example.org/article/'),
    );
    assert.notEqual(
      normalizeSourceUrl('https://example.org/article/'),
      normalizeSourceUrl('https://example.org/article//'),
    );

    // 다만 경로가 아예 없는 / 하나는 없는 것과 같다.
    assert.equal(
      normalizeSourceUrl('https://example.org/'),
      normalizeSourceUrl('https://example.org'),
    );

    // 값의 순서도 임의로 바꾸지 않는다.
    assert.notEqual(
      normalizeSourceUrl('https://example.org/a?b=2&a=1'),
      normalizeSourceUrl('https://example.org/a?a=1&b=2'),
    );
    assert.notEqual(
      normalizeSourceUrl('https://example.org/a?x=1&x=2'),
      normalizeSourceUrl('https://example.org/a?x=2&x=1'),
    );
  });
});

describe('Source Harvester · 자료 id', () => {
  it('같은 자료면 항상 같은 id가 나온다', async () => {
    const first = await computeSourceId('https://example.org/a/b');
    const second = await computeSourceId('https://Example.ORG/a/b#top');
    assert.equal(first, second);
    assert.match(String(first), /^src_[0-9a-f]{64}$/);
  });

  it('다른 자료면 다른 id가 나온다', async () => {
    const first = await computeSourceId('https://example.org/a');
    const second = await computeSourceId('https://example.org/b');
    assert.notEqual(first, second);
  });

  it('정리 전 주소와 정리 후 주소의 id가 같다', async () => {
    for (const original of [
      'https://example.com/article?q=a%26b',
      'https://example.com/a?utm_source=g&id=123',
      'https://Example.COM/a/b#top',
      'https://example.com/a?tag=y&tag=x',
      'https://example.com/a?q=hello%20world',
    ]) {
      const canonical = normalizeSourceUrl(original)!;
      assert.equal(await computeSourceId(original), await computeSourceId(canonical), original);
      // 저장된 주소를 다시 정리해도 그대로다.
      assert.equal(normalizeSourceUrl(canonical), canonical, original);
    }
  });

  it('받을 수 없는 주소로는 id를 만들지 않는다', async () => {
    assert.equal(await computeSourceId('http://example.org/a'), null);
    assert.equal(await computeSourceId('https://127.0.0.1/a'), null);
  });
});

describe('Source Harvester · 결과 검증', () => {
  it('올바른 결과는 통과한다', async () => {
    const outcome = await check(await makeResult());
    assert.equal(outcome.valid, true, outcome.errors.join(' / '));
  });

  it('의뢰서와 대상·버전·판단 시점이 다르면 무효다', async () => {
    assert.equal((await check(await makeResult({ targetDomain: 'burnout_exhaustion' }))).valid, false);
    assert.equal((await check(await makeResult({ evidenceVersion: 9 }))).valid, false);
    assert.equal((await check(await makeResult({ prioritizerSnapshotId: 'snap_other' }))).valid, false);
  });

  it(`채택 자료는 ${ACCEPTED_MIN}~${ACCEPTED_MAX}개여야 한다`, async () => {
    assert.equal((await check(await makeResult({ sources: await makeSources(4) }))).valid, false);
    assert.equal((await check(await makeResult({ sources: await makeSources(13) }))).valid, false);
    assert.equal(
      (await check(await makeResult({ sources: await makeSources(ACCEPTED_MAX) }))).valid,
      true,
    );
  });

  it(`학술적 핵심 자료가 ${SCHOLARLY_CORE_MIN}개 미만이면 무효다`, async () => {
    const sources = await makeSources(5);
    // 주석 자료를 목회 보조자료로 바꿔 핵심 자료를 2개로 줄인다.
    sources[0] = {
      ...sources[0],
      sourceType: 'pastoral_resource',
      intendedUse: ['pastoral_application'],
    };
    const outcome = await check(await makeResult({ sources }));
    assert.equal(outcome.valid, false);
    assert.ok(outcome.errors.some((error) => error.includes('학술적 핵심 자료')));
  });

  it(`발행처가 ${PUBLISHER_MIN}곳 미만이면 무효다`, async () => {
    const sources = (await makeSources(5)).map((source) => ({
      ...source,
      publisherOrInstitution: '한 곳뿐인 기관',
    }));
    const outcome = await check(await makeResult({ sources }));
    assert.equal(outcome.valid, false);
    assert.ok(outcome.errors.some((error) => error.includes('발행처')));
  });

  it('같은 자료가 두 번 들어가면 무효다', async () => {
    const sources = await makeSources(5);

    // 같은 id
    const sameId = [...sources];
    sameId[4] = { ...sameId[4], sourceId: sameId[0].sourceId };
    assert.equal((await check(await makeResult({ sources: sameId }))).valid, false);

    // 정리하면 같아지는 주소
    const sameUrl = [...sources];
    const url = 'https://SOURCES.example.org/aroeda/fixture-0?utm_source=x#top';
    sameUrl[4] = { ...sameUrl[4], url, sourceId: (await computeSourceId(url))! };
    const outcome = await check(await makeResult({ sources: sameUrl }));
    assert.equal(outcome.valid, false);
    assert.ok(outcome.errors.some((error) => error.includes('같은 자료가 두 번')));
  });

  it('주소에서 만들어지지 않은 sourceId는 무효다', async () => {
    const sources = await makeSources(5);
    sources[0] = { ...sources[0], sourceId: 'src_내가지어낸id' };
    const outcome = await check(await makeResult({ sources }));
    assert.equal(outcome.valid, false);
    assert.ok(outcome.errors.some((error) => error.includes('sourceId가 주소에서 만들어진 값과 다릅니다')));
  });

  it('받을 수 없는 주소를 가진 채택 자료는 무효다', async () => {
    for (const url of ['http://example.org/a', 'https://127.0.0.1/a', 'javascript:alert(1)', 'https://user:pw@example.org/a']) {
      const sources = await makeSources(5);
      sources[0] = { ...sources[0], url, sourceId: sources[0].sourceId };
      assert.equal((await check(await makeResult({ sources }))).valid, false, url);
    }
  });

  it('빠진 정보가 있으면 무효다', async () => {
    for (const field of ['title', 'authorOrOrganization', 'publisherOrInstitution', 'relevanceNote'] as const) {
      const sources = await makeSources(5);
      sources[0] = { ...sources[0], [field]: '' };
      assert.equal((await check(await makeResult({ sources }))).valid, false, field);
    }
  });

  it('출판 연도는 연도이거나 null이어야 한다', async () => {
    const withNull = await makeSources(5);
    withNull[0] = { ...withNull[0], publicationYear: null };
    assert.equal((await check(await makeResult({ sources: withNull }))).valid, true);

    for (const bad of [0, -20, 1200, 3000, 2020.5, Number.NaN]) {
      const sources = await makeSources(5);
      sources[0] = { ...sources[0], publicationYear: bad };
      assert.equal((await check(await makeResult({ sources }))).valid, false, String(bad));
    }
  });
});

describe('Source Harvester · 자료의 종류와 역할', () => {
  it('알 수 없는 sourceType은 무효다', async () => {
    const sources = await makeSources(5);
    sources[0] = { ...sources[0], sourceType: 'blog_post' as never };
    assert.equal((await check(await makeResult({ sources }))).valid, false);
  });

  it('알 수 없는 intendedUse는 무효다', async () => {
    const sources = await makeSources(5);
    sources[0] = { ...sources[0], intendedUse: ['final_approval' as never] };
    assert.equal((await check(await makeResult({ sources }))).valid, false);
  });

  it('전문 분야 자료를 성경 해석 근거로 쓸 수 없다', async () => {
    for (const use of ['exegesis', 'biblical_theology', 'doctrinal_context'] as const) {
      const sources = await makeSources(5);
      sources[4] = { ...sources[4], sourceType: 'professional_context', intendedUse: [use] };
      const outcome = await check(await makeResult({ sources }));
      assert.equal(outcome.valid, false, use);
      assert.ok(outcome.errors.some((error) => error.includes('professional_context')));
    }
  });

  it('전문 분야 자료를 안전·현실 확인 용도로는 쓸 수 있다', async () => {
    const sources = await makeSources(5);
    sources[4] = {
      ...sources[4],
      sourceType: 'professional_context',
      intendedUse: ['pastoral_safety'],
    };
    const outcome = await check(await makeResult({ sources }));
    assert.equal(outcome.valid, true, outcome.errors.join(' / '));
  });

  it('목회 보조자료도 성경 해석의 근거가 될 수 없다', () => {
    for (const use of ['exegesis', 'biblical_theology', 'doctrinal_context']) {
      assert.equal(
        ALLOWED_INTENDED_USES.pastoral_resource.includes(use as never),
        false,
        use,
      );
    }
  });

  it('허용 조합표는 아는 값만 담는다', () => {
    for (const type of HARVESTABLE_SOURCE_TYPES) {
      const allowed = ALLOWED_INTENDED_USES[type];
      assert.ok(allowed.length > 0, type);
      for (const use of allowed) {
        assert.ok((INTENDED_USES as readonly string[]).includes(use), `${type} → ${use}`);
      }
    }
  });
});

describe('Source Harvester · 내용을 어디까지 확인했는가', () => {
  it('metadata만 확인한 자료는 채택할 수 없다', async () => {
    assert.equal((ACCESS_LEVELS as readonly string[]).includes('metadata_only'), false);

    const sources = await makeSources(5);
    sources[0] = { ...sources[0], accessLevel: 'metadata_only' as never };
    assert.equal((await check(await makeResult({ sources }))).valid, false);
  });

  it('초록까지만 확인한 자료는 채택할 수 있다', async () => {
    const sources = await makeSources(5);
    sources[0] = { ...sources[0], accessLevel: 'abstract_only' };
    const outcome = await check(await makeResult({ sources }));
    assert.equal(outcome.valid, true, outcome.errors.join(' / '));
  });
});

describe('Source Harvester · 채택하지 않은 자료', () => {
  it('0개도 정상이다', async () => {
    const outcome = await check(await makeResult({ rejectedSources: [] }));
    assert.equal(outcome.valid, true, outcome.errors.join(' / '));
  });

  it(`${REJECTED_SOURCE_MAX}개까지 기록할 수 있다`, async () => {
    const outcome = await check(
      await makeResult({ rejectedSources: rejectedSources(REJECTED_SOURCE_MAX) }),
    );
    assert.equal(outcome.valid, true, outcome.errors.join(' / '));

    const tooMany = await check(
      await makeResult({ rejectedSources: rejectedSources(REJECTED_SOURCE_MAX + 1) }),
    );
    assert.equal(tooMany.valid, false);
  });

  it('알 수 없는 rejectionReason은 무효다', async () => {
    const outcome = await check(
      await makeResult({
        rejectedSources: [
          {
            url: 'https://blog.example.com/x',
            title: null,
            rejectionReason: '그냥 별로임' as never,
          },
        ],
      }),
    );
    assert.equal(outcome.valid, false);
  });

  it('결과 보장·안전 위험 자료를 걸러낸 기록을 남길 수 있다', async () => {
    for (const reason of ['outcome_guarantee_risk', 'unsafe_pastoral_claim'] as const) {
      assert.ok((SOURCE_REJECTION_REASONS as readonly string[]).includes(reason));
      const outcome = await check(
        await makeResult({
          rejectedSources: [
            { url: 'https://example.com/prosperity', title: '자료', rejectionReason: reason },
          ],
        }),
      );
      assert.equal(outcome.valid, true, outcome.errors.join(' / '));
    }
  });
});

describe('Source Harvester · 제외 기록의 두 가지 출처', () => {
  /** 모델이 직접 남긴 기록 */
  const modelRejections = (count: number): RejectedSource[] =>
    Array.from({ length: count }, (_, index) => ({
      url: `https://blog.example.com/model-${index}`,
      title: null,
      rejectionReason: 'insufficient_relevance' as const,
    }));

  /** 서버가 자동으로 남긴 기록 (열어 본 적 없어 뺀 자료) */
  const serverRejections = (count: number): RejectedSource[] =>
    Array.from({ length: count }, (_, index) => ({
      url: `https://sources.example.org/server-${index}`,
      title: null,
      rejectionReason: 'not_inspected' as const,
    }));

  const budgetOk = async (model: number, server: number) => {
    const outcome = await check(
      await makeResult({ rejectedSources: [...modelRejections(model), ...serverRejections(server)] }),
    );
    // 제외 기록 관련 오류만 본다. 다른 규칙은 fixture가 이미 만족한다.
    const rejectionErrors = outcome.errors.filter((error) => error.includes('제외 기록'));
    return { valid: outcome.valid, rejectionErrors };
  };

  it('상수는 canonical 값에서 파생된다', () => {
    assert.equal(REJECTED_SOURCE_MAX, 10);
    assert.equal(SERVER_REJECTED_SOURCE_MAX, ACCEPTED_MAX);
    assert.equal(SERVER_REJECTED_SOURCE_MAX, 12);
    assert.equal(FINAL_REJECTED_SOURCE_MAX, REJECTED_SOURCE_MAX + SERVER_REJECTED_SOURCE_MAX);
    assert.equal(FINAL_REJECTED_SOURCE_MAX, 22);
  });

  it('모델 10 + 서버 2는 통과한다', async () => {
    // 직전 실제 실행과 같은 모양이다. 서버가 안전하게 뺀 것 때문에 실패하지 않는다.
    const outcome = await budgetOk(10, 2);
    assert.equal(outcome.valid, true, outcome.rejectionErrors.join(' / '));
  });

  it('모델 10 + 서버 0도 통과한다', async () => {
    assert.equal((await budgetOk(10, 0)).valid, true);
  });

  it('모델 11은 서버 기록이 없어도 무효다', async () => {
    const outcome = await budgetOk(11, 0);
    assert.equal(outcome.valid, false);
    assert.ok(outcome.rejectionErrors.some((error) => error.includes('모델이 남긴')));
  });

  it('모델 10 + 서버 12(합 22)는 통과한다', async () => {
    const outcome = await budgetOk(10, 12);
    assert.equal(outcome.valid, true, outcome.rejectionErrors.join(' / '));
  });

  it('서버 13은 무효다', async () => {
    const outcome = await budgetOk(10, 13);
    assert.equal(outcome.valid, false);
    assert.ok(outcome.rejectionErrors.some((error) => error.includes('서버가 남긴')));
  });

  it('합이 22여도 모델 한도를 넘으면 무효다', async () => {
    // 모델 11 + 서버 11 = 22. 전체 상한은 지켰지만 모델 한도를 넘었다.
    const outcome = await budgetOk(11, 11);
    assert.equal(outcome.valid, false);
    assert.ok(outcome.rejectionErrors.some((error) => error.includes('모델이 남긴')));
  });

  it('전체 상한을 넘으면 무효다', async () => {
    const outcome = await budgetOk(11, 12);
    assert.equal(outcome.valid, false);
    assert.ok(outcome.rejectionErrors.some((error) => error.includes('전체는')));
  });

  it('사유로 어느 쪽 기록인지 가른다', async () => {
    // not_inspected만 서버 기록으로 센다. 모델 사유 11개는 무효.
    for (const reason of MODEL_REJECTION_REASONS.slice(0, 3)) {
      const many = Array.from({ length: 11 }, (_, index) => ({
        url: `https://blog.example.com/x-${index}`,
        title: null,
        rejectionReason: reason,
      }));
      const outcome = await check(await makeResult({ rejectedSources: many }));
      assert.equal(outcome.valid, false, reason);
    }

    // 같은 11개라도 서버 사유면 통과한다.
    const outcome = await check(await makeResult({ rejectedSources: serverRejections(11) }));
    assert.equal(outcome.valid, true, outcome.errors.join(' / '));
  });

  it('서버 전용 사유는 하나뿐이고 모델은 쓸 수 없다', () => {
    assert.deepEqual([...SERVER_ONLY_REJECTION_REASONS], ['not_inspected']);
    assert.equal(MODEL_REJECTION_REASONS.includes('not_inspected' as never), false);
  });

  it('다른 규칙이 깨지면 여전히 무효다', async () => {
    // 제외 기록은 정상이지만 채택 자료가 4개뿐인 경우
    const outcome = await check(
      await makeResult({
        sources: await makeSources(4),
        rejectedSources: [...modelRejections(10), ...serverRejections(2)],
      }),
    );
    assert.equal(outcome.valid, false);
    assert.equal(outcome.errors.some((error) => error.includes('제외 기록')), false);
  });
});

describe('Source Harvester · 들어오면 안 되는 항목', () => {
  it('모르는 최상위 항목이 붙으면 무효다', async () => {
    assert.equal((await check({ ...(await makeResult()), extraField: 1 })).valid, false);
  });

  it('안쪽에 모르는 항목이 붙어도 무효다', async () => {
    const nested = await makeResult();
    (nested.sources[0] as unknown as Record<string, unknown>).extraNote = 'x';
    assert.equal((await check(nested)).valid, false);

    const rejectedExtra = await makeResult();
    (rejectedExtra.rejectedSources[0] as unknown as Record<string, unknown>).note = 'x';
    assert.equal((await check(rejectedExtra)).valid, false);
  });

  it('페이지 내용이나 인용문을 넣으면 무효다', async () => {
    for (const key of ['rawHtml', 'html', 'pageContent', 'content', 'body', 'snippet', 'summary', 'quote', 'quotation', 'excerpt', 'fullText', 'text']) {
      const withBanned = (await makeResult()) as unknown as Record<string, unknown>;
      withBanned[key] = '웹페이지에서 가져온 긴 문장';
      assert.equal((await check(withBanned)).valid, false, `${key}가 통과되었습니다.`);
    }

    // 자료 안쪽에 숨겨도 막는다.
    const nested = await makeResult();
    (nested.sources[0] as unknown as Record<string, unknown>).quote = '긴 인용문';
    assert.equal((await check(nested)).valid, false);
  });

  it('사용자 데이터 항목은 어디에 있든 무효다', async () => {
    for (const key of ['situation', 'rawSituation', 'userId', 'sessionId', 'deviceId', 'jwt', 'token']) {
      const withUserData = (await makeResult()) as unknown as Record<string, unknown>;
      withUserData[key] = 'x';
      assert.equal((await check(withUserData)).valid, false, `${key}가 통과되었습니다.`);
    }
  });

  it('Prioritizer 판단 근거 항목은 어디에 있든 무효다', async () => {
    for (const key of ['reason', 'score', 'confidence', 'rank']) {
      const withEvaluator = (await makeResult()) as unknown as Record<string, unknown>;
      withEvaluator[key] = 1;
      assert.equal((await check(withEvaluator)).valid, false, `${key}가 통과되었습니다.`);
    }
  });

  it('객체가 아니거나 필수 항목이 빠지면 무효다', async () => {
    for (const value of [null, 'ok', 42, []]) {
      assert.equal((await check(value)).valid, false);
    }
    const { sources: _sources, ...withoutSources } = await makeResult();
    void _sources;
    assert.equal((await check(withoutSources)).valid, false);
  });
});

describe('Source Harvester · 모르는 것', () => {
  it('빈 목록도, 남긴 질문도 모두 정상이다', async () => {
    assert.equal((await check(await makeResult({ unresolvedSourceQuestions: [] }))).valid, true);

    const withQuestions = await check(
      await makeResult({
        unresolvedSourceQuestions: [
          '중요한 학술 자료가 유료 장벽 뒤에 있어 본문을 확인하지 못했습니다.',
          '한 자료의 출판 연도를 확인하지 못했습니다.',
        ],
      }),
    );
    assert.equal(withQuestions.valid, true, withQuestions.errors.join(' / '));
  });
});

describe('Source Harvester → Biblical Researcher 인계', () => {
  /**
   * fixture 자료 5건의 역할:
   *   0 주석         · 주해            · 본문 전체 확인
   *   1 성경신학     · 성경신학/교리    · 상당 부분 확인
   *   2 학술 논문    · 주해/현실 확인   · 초록만 확인
   *   3 목회 보조    · 목회 적용        · 본문 전체 확인
   *   4 전문 분야    · 안전/현실 확인   · 본문 전체 확인
   */
  const research = async (
    sources: ResearchSource[],
    supportOverrides: Partial<SourceSupport> = {},
  ) => {
    const researchBrief = brief();
    const base: SourceSupport = {
      exegesisEvidenceIds: [`${sources[0].sourceId}:e1`],
      theologyEvidenceIds: [`${sources[1].sourceId}:e1`],
      pastoralEvidenceIds: [],
      safetyEvidenceIds: [],
      exegesisSourceIds: [sources[0].sourceId],
      theologySourceIds: [sources[1].sourceId],
      pastoralSourceIds: [],
      safetySourceIds: [],
    };
    const support: SourceSupport = { ...base, ...supportOverrides };

    // 자료 id만 바꾼 시험이면 근거 번호도 함께 맞춘다.
    for (const role of ['exegesis', 'theology', 'pastoral', 'safety'] as const) {
      const sourceField = `${role}SourceIds` as keyof SourceSupport;
      const evidenceField = `${role}EvidenceIds` as keyof SourceSupport;
      if (sourceField in supportOverrides && !(evidenceField in supportOverrides)) {
        support[evidenceField] = (supportOverrides[sourceField] as string[]).map(
          (id) => `${id}:e1`,
        );
      }
    }

    const candidate = (chapter: number) => ({
      reference: { book: 'Psalms', chapter, startVerse: 1, endVerse: 3 },
      additionalReferences: [],
      canonicalContext: '본문이 놓인 흐름에 대한 메모입니다.',
      theologicalContribution: '이 영역에 주는 신학적 기여에 대한 메모입니다.',
      domainFit: '이 삶의 문제를 직접 다루기 때문입니다.',
      pastoralUse: ['위로'],
      misuseRisks: ['결과 보장으로 쓰지 않는다.'],
      distinctnessFromActiveCoverage: {
        distinct: true,
        nearestExistingDomain: 'fear_uncertainty',
        explanation: '불안 일반이 아니라 생계 문제를 다룹니다.',
      },
      researchConfidence: 0.6,
      // Harvester가 만든 sourceId만 가리킨다.
      sourceSupport: support,
    });

    return validateBiblicalResearchResult(
      {
        targetDomain: researchBrief.targetDomain,
        evidenceVersion: researchBrief.evidenceVersion,
        prioritizerSnapshotId: researchBrief.prioritizerSnapshotId,
        researchQuestion: '성경은 이 문제를 어디에서 다루는가?',
        domainBoundaries: {
          includedConcerns: ['생계 압박'],
          excludedOrAdjacentConcerns: ['일반적인 미래 불안'],
        },
        candidatePassages: [candidate(1), candidate(2), candidate(3)],
        rejectedPassages: [
          {
            reference: { book: 'Proverbs', chapter: 1, startVerse: 5, endVerse: 6 },
            rejectionReason: '이 영역의 핵심 문제를 다루지 않습니다.',
            riskCategory: 'adjacent_domain_only',
          },
        ],
        unresolvedQuestions: [],
        // 꾸러미 지문은 서버가 붙인다. 시험에서도 모양이 맞는 값을 쓴다.
        evidenceSetHash: `evset_${'a'.repeat(64)}`,
      },
      researchBrief,
      sources,
    );
  };

  it('자료의 역할 정보가 연구 단계까지 그대로 넘어간다', async () => {
    const harvest = await makeResult();
    const sources: ResearchSource[] = toResearchSources(harvest);

    assert.equal(sources.length, harvest.sources.length);
    for (const source of sources) {
      // 떨어져 나가는 것은 수집 단계에서만 쓰는 두 값(메모, 연구 근거)뿐이다.
      assert.deepEqual(Object.keys(source).sort(), [
        'accessLevel',
        'accessedAt',
        'authorOrOrganization',
        'intendedUse',
        'publicationYear',
        'publisherOrInstitution',
        'sourceId',
        'sourceType',
        'title',
        'url',
      ]);
    }

    for (const [index, source] of sources.entries()) {
      const original = harvest.sources[index];
      assert.equal(source.sourceId, original.sourceId);
      assert.equal(source.sourceType, original.sourceType);
      assert.deepEqual(source.intendedUse, original.intendedUse);
      assert.equal(source.accessLevel, original.accessLevel);
      assert.equal(source.publisherOrInstitution, original.publisherOrInstitution);
      assert.equal(source.publicationYear, original.publicationYear);
      assert.equal(source.url, original.url);
    }
  });

  it('올바른 인계는 통과한다', async () => {
    const sources = toResearchSources(await makeResult());
    const outcome = await research(sources);
    assert.equal(outcome.valid, true, outcome.errors.join(' / '));
  });

  it('전문 분야 자료는 안전 근거로만 넘어간다', async () => {
    const sources = toResearchSources(await makeResult());

    const safety = await research(sources, { safetySourceIds: [sources[4].sourceId] });
    assert.equal(safety.valid, true, safety.errors.join(' / '));

    for (const field of ['exegesisSourceIds', 'theologySourceIds', 'pastoralSourceIds'] as const) {
      const outcome = await research(sources, { [field]: [sources[4].sourceId] });
      assert.equal(outcome.valid, false, field);
    }
  });

  it('목회 보조자료는 적용·안전 근거로만 넘어간다', async () => {
    const sources = toResearchSources(await makeResult());

    const pastoral = await research(sources, { pastoralSourceIds: [sources[3].sourceId] });
    assert.equal(pastoral.valid, true, pastoral.errors.join(' / '));

    for (const field of ['exegesisSourceIds', 'theologySourceIds'] as const) {
      const outcome = await research(sources, { [field]: [sources[3].sourceId] });
      assert.equal(outcome.valid, false, field);
    }
  });

  it('초록만 확인한 학술 논문은 주해 근거가 되지 못한다', async () => {
    const sources = toResearchSources(await makeResult());

    // 자료 2는 주해 용도로 승인됐지만 초록까지만 확인했다.
    assert.equal(sources[2].accessLevel, 'abstract_only');
    assert.ok(sources[2].intendedUse.includes('exegesis'));

    const outcome = await research(sources, { exegesisSourceIds: [sources[2].sourceId] });
    assert.equal(outcome.valid, false);

    // 안전·현실 확인 용도로는 초록만 확인한 자료도 쓸 수 있다.
    const safety = await research(sources, { safetySourceIds: [sources[2].sourceId] });
    assert.equal(safety.valid, true, safety.errors.join(' / '));
  });

  it('Harvester가 주지 않은 sourceId는 연구 근거가 될 수 없다', async () => {
    const sources = toResearchSources(await makeResult());
    const outcome = await research(sources, {
      theologySourceIds: [sources[1].sourceId, 'src_researcher가지어낸id'],
    });

    assert.equal(outcome.valid, false);
    assert.ok(outcome.errors.some((error) => error.includes('존재하지 않는 근거 자료')));
  });

  it('주해와 신학 근거가 하나도 없으면 후보가 될 수 없다', async () => {
    const sources = toResearchSources(await makeResult());

    for (const field of ['exegesisSourceIds', 'theologySourceIds'] as const) {
      const outcome = await research(sources, { [field]: [] });
      assert.equal(outcome.valid, false, field);
    }
  });

  it('두 단계가 같은 canonical 규칙을 쓴다', async () => {
    // Harvester가 자료에 붙일 수 있는 용도와, Researcher가 역할로 인정하는 용도는
    // research-source.ts의 같은 함수 하나가 판단한다.
    assert.equal(isSourceTypeAllowedForUse('professional_context', 'pastoral_safety'), true);
    assert.equal(isSourceTypeAllowedForUse('professional_context', 'exegesis'), false);
    assert.equal(isSourceTypeAllowedForUse('pastoral_resource', 'exegesis'), false);
    assert.equal(isSourceTypeAllowedForUse('commentary', 'exegesis'), true);
    // 성경 본문 자체는 웹 자료가 아니므로 어떤 용도로도 허용되지 않는다.
    assert.equal(isSourceTypeAllowedForUse('bible_primary', 'exegesis'), false);

    const sources = toResearchSources(await makeResult());
    for (const source of sources) {
      for (const use of source.intendedUse) {
        assert.equal(
          isSourceTypeAllowedForUse(source.sourceType, use),
          true,
          `${source.sourceType} → ${use}`,
        );
      }
    }

    // 역할 판단도 같은 규칙 위에서 이뤄진다.
    assert.equal(isSourceAllowedForRole(sources[4], 'safety'), true);
    assert.equal(isSourceAllowedForRole(sources[4], 'exegesis'), false);
    assert.equal(isSourceAllowedForRole(sources[2], 'exegesis'), false);
    assert.equal(isSourceAllowedForRole(sources[0], 'exegesis'), true);
  });
});
