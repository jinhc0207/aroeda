import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import {
  COMPOUND_SCENARIOS,
  DOMAIN_CHOICE_SCENARIOS,
  EXPANSION_DOMAIN_COUNTS,
  EXPANSION_SCENARIOS,
  SAFETY_BOUNDARY_SCENARIOS,
  SAFETY_REVIEWED_NON_BOUNDARY,
  SCENARIO_RESEARCH_BASIS,
  type ExpansionDomain,
} from '../../scripts/situation-scenario-corpus.ts';
import { FALLBACK_DOMAIN, SITUATION_DOMAINS } from '../data/situation-domains.ts';
import {
  SAFETY_CATEGORIES,
  SAFETY_LEVELS,
  validateSituationAnalysis,
  type SituationAnalysis,
} from './situation-analysis.ts';

/** 코퍼스가 실제로 사용하는 영역. 데이터에서 직접 모은다. */
const CORPUS_DOMAINS = [...new Set(EXPANSION_SCENARIOS.map((item) => item.domain))];

/** 런타임 analyzer가 쓰는 영역 중 fallback을 뺀 것. 코퍼스와 따로 적지 않고 실제 목록에서 가져온다. */
const RUNTIME_DOMAINS = SITUATION_DOMAINS.filter((domain) => domain !== FALLBACK_DOMAIN);

/** 대표 카드가 새로 생긴 확장 영역 7개. 문구·순위·클러스터를 건드리지 않는다. */
const EXISTING_EXPANSION_DOMAINS: ExpansionDomain[] = [
  'loneliness_isolation',
  'family_parenting_conflict',
  'burnout_exhaustion',
  'spiritual_dryness',
  'financial_hardship',
  'chronic_illness',
  'relationship_conflict_forgiveness',
];

/**
 * 기존 7개 영역 140문장의 내용 지문(fingerprint).
 *
 * rank·domain·cluster·text를 그대로 직렬화해 SHA-256으로 고정했다.
 * 이 값이 바뀌면 기존 140문장의 문구·순위·클러스터 중 하나가 달라졌다는 뜻이다.
 */
const EXISTING_EXPANSION_FINGERPRINT =
  '68ef1be82f9241226831cc664557f58360d5e2fccb2761b4309c51a3701a5033';

const fingerprintOf = (rows: readonly { rank: number; domain: string; cluster: string; text: string }[]) =>
  crypto
    .createHash('sha256')
    .update(JSON.stringify(rows.map(({ rank, domain, cluster, text }) => [rank, domain, cluster, text])))
    .digest('hex');

/**
 * 즉시 안전 경로가 필요한 노골적 표현.
 *
 * 이 목록은 안전 판정 로직이 아니다. 지속적 괴롭힘·학대처럼 낱말 하나로 잡히지 않는 신호가 있고,
 * 반대로 낱말만 보고 위험으로 단정하면 안 되는 문장도 있다.
 * 그래서 안전 판정은 사람이 검토한 SAFETY_BOUNDARY_SCENARIOS와 서버 analyzer가 맡는다.
 * 이 검사는 새 복합 문장에 이런 노골적 낱말을 넣지 않았다는 것만 기계적으로 확인한다.
 */
const IMMEDIATE_DANGER_WORDS = [
  '자살',
  '자해',
  '죽고 싶',
  '죽이고 싶',
  '폭행',
  '때리',
  '때려',
  '흉기',
  '응급실',
  '목을 매',
  '투신',
  '성폭행',
  '강간',
];

/** single이면 domain·rank로, compound이면 primaryDomain·text로 원본 문장을 찾는다. */
function findOriginal(item: {
  source: 'single' | 'compound';
  domain: ExpansionDomain;
  rank: number | null;
  text: string;
}): string | undefined {
  if (item.source === 'single') {
    return EXPANSION_SCENARIOS.find((row) => row.domain === item.domain && row.rank === item.rank)?.text;
  }
  return COMPOUND_SCENARIOS.find((row) => row.primaryDomain === item.domain && row.text === item.text)?.text;
}

describe('코퍼스 영역 · 런타임 영역과 교차 검증', () => {
  it('코퍼스의 17개 영역이 SITUATION_DOMAINS에서 fallback을 뺀 17개와 정확히 같다', () => {
    assert.equal(RUNTIME_DOMAINS.length, 17);
    assert.deepEqual([...CORPUS_DOMAINS].sort(), [...RUNTIME_DOMAINS].sort());
    assert.equal(CORPUS_DOMAINS.includes(FALLBACK_DOMAIN as ExpansionDomain), false);
  });

  it('도메인별 개수 표(EXPANSION_DOMAIN_COUNTS)도 같은 17개를 가리킨다', () => {
    assert.deepEqual(Object.keys(EXPANSION_DOMAIN_COUNTS).sort(), [...RUNTIME_DOMAINS].sort());
  });

  it('복합 코퍼스의 중심·보조 영역도 런타임 영역 안에서만 나온다', () => {
    const runtime = new Set<string>(RUNTIME_DOMAINS);
    for (const item of COMPOUND_SCENARIOS) {
      assert.ok(runtime.has(item.primaryDomain), item.primaryDomain);
      for (const secondary of item.secondaryDomains) assert.ok(runtime.has(secondary), secondary);
    }
  });
});

describe('단일 영역 코퍼스 (EXPANSION_SCENARIOS)', () => {
  it('17개 영역에 우선순위 문장이 정확히 20개씩, 총 340개다', () => {
    assert.equal(EXPANSION_SCENARIOS.length, 340);
    for (const domain of RUNTIME_DOMAINS) {
      const rows = EXPANSION_SCENARIOS.filter((item) => item.domain === domain);
      assert.equal(rows.length, 20, `${domain} 문장 수가 20개가 아닙니다.`);
      assert.equal(EXPANSION_DOMAIN_COUNTS[domain as ExpansionDomain], 20);
      assert.deepEqual(rows.map((item) => item.rank), Array.from({ length: 20 }, (_, i) => i + 1));
      assert.equal(new Set(rows.map((item) => item.text)).size, 20, `${domain}에 중복 문장이 있습니다.`);
      assert.ok(rows.every((item) => item.text.length >= 12), `${domain}에 12자 미만 문장이 있습니다.`);
    }
  });

  it('내부 테스트 문구 교정 후 확장 영역 7개의 140문장을 새 지문으로 고정한다', () => {
    const rows = EXPANSION_SCENARIOS.filter((item) => EXISTING_EXPANSION_DOMAINS.includes(item.domain));
    assert.equal(rows.length, 140);
    assert.equal(
      fingerprintOf(rows),
      EXISTING_EXPANSION_FINGERPRINT,
      '기존 7개 영역 140문장의 문구·순위·클러스터 중 하나가 바뀌었습니다.',
    );
  });
});

describe('복합 사연 코퍼스 (COMPOUND_SCENARIOS) · 구조', () => {
  it('17개 중심 영역마다 정확히 4문장, 총 68문장이다', () => {
    assert.equal(COMPOUND_SCENARIOS.length, 68);
    for (const domain of RUNTIME_DOMAINS) {
      const rows = COMPOUND_SCENARIOS.filter((item) => item.primaryDomain === domain);
      assert.equal(rows.length, 4, `${domain}의 복합 문장이 4개가 아닙니다.`);
      assert.equal(rows.filter((item) => item.secondaryDomains.length === 1).length, 3, `${domain}: 보조 1개 문장 3개`);
      assert.equal(rows.filter((item) => item.secondaryDomains.length === 2).length, 1, `${domain}: 보조 2개 문장 1개`);
    }
  });

  it('secondaryDomains에 primaryDomain이 없고 내부 중복도 없다', () => {
    for (const item of COMPOUND_SCENARIOS) {
      assert.equal(item.secondaryDomains.includes(item.primaryDomain), false, `${item.primaryDomain}: ${item.text}`);
      assert.equal(new Set(item.secondaryDomains).size, item.secondaryDomains.length, item.text);
    }
  });

  it('허용된 domain 값만 사용한다 (문장의 의미가 맞는지는 이 테스트가 확인하지 않는다)', () => {
    // 이 검사가 보는 것은 값의 범위뿐이다.
    // 중심 영역이 정말 실제 삶의 문제인지, 보조 영역이 감정·지혜·기도 방식·과거 원인이 아닌지는
    // 사람이 rationale을 읽고 검수한다. 자동으로 검증됐다고 주장하지 않는다.
    const allowed = new Set<string>(RUNTIME_DOMAINS);
    for (const item of COMPOUND_SCENARIOS) {
      assert.ok(allowed.has(item.primaryDomain));
      assert.ok(item.secondaryDomains.every((domain) => allowed.has(domain)));
    }
  });

  it('모든 복합 사례에 사람이 검수할 rationale이 있다 (내용의 옳고 그름은 검사하지 않는다)', () => {
    for (const item of COMPOUND_SCENARIOS) {
      assert.equal(typeof item.rationale, 'string');
      assert.ok(item.rationale.trim().length > 0, `${item.primaryDomain}: rationale이 비어 있습니다.`);
    }
  });

  it('decision_guidance와 wisdom_discernment를 서로 중심·보조로 함께 넣지 않는다', () => {
    for (const item of COMPOUND_SCENARIOS) {
      if (item.primaryDomain === 'decision_guidance') {
        assert.equal(item.secondaryDomains.includes('wisdom_discernment'), false, item.text);
      }
      if (item.primaryDomain === 'wisdom_discernment') {
        assert.equal(item.secondaryDomains.includes('decision_guidance'), false, item.text);
      }
    }
  });

  it('두려움(fear_uncertainty)을 다른 문제에 대한 감정 반응으로 보조 영역에 넣지 않는다', () => {
    // 코퍼스 작성 원칙을 값으로 고정한다. 두려움이 중심인 사연은 primaryDomain으로만 쓴다.
    for (const item of COMPOUND_SCENARIOS) {
      assert.equal(item.secondaryDomains.includes('fear_uncertainty'), false, item.text);
    }
  });

  it('모든 문장은 12자 이상이고, 복합 코퍼스 안과 단일 코퍼스와 겹치지 않는다', () => {
    assert.ok(COMPOUND_SCENARIOS.every((item) => item.text.length >= 12));
    const texts = COMPOUND_SCENARIOS.map((item) => item.text);
    assert.equal(new Set(texts).size, texts.length, '복합 코퍼스에 중복 문장이 있습니다.');
    const singles = new Set(EXPANSION_SCENARIOS.map((item) => item.text));
    assert.deepEqual(texts.filter((text) => singles.has(text)), []);
  });

  it('새 복합 문장에 노골적인 즉시-위험 낱말이 없다 (안전 판정을 대신하지 않는다)', () => {
    for (const item of COMPOUND_SCENARIOS) {
      for (const word of IMMEDIATE_DANGER_WORDS) {
        assert.equal(item.text.includes(word), false, `${item.primaryDomain}에 "${word}": ${item.text}`);
      }
    }
  });
});

describe('안전 경계 사례 (SAFETY_BOUNDARY_SCENARIOS)', () => {
  it('각 경계 사례는 실제 SafetyAssessment 모양의 기대값을 가지며 서버 검증 규칙을 통과한다', () => {
    assert.ok(SAFETY_BOUNDARY_SCENARIOS.length > 0);
    for (const scenario of SAFETY_BOUNDARY_SCENARIOS) {
      const { level, categories } = scenario.expected;
      assert.ok((SAFETY_LEVELS as readonly string[]).includes(level), level);
      assert.ok(categories.length > 0, `${scenario.text}: categories가 비어 있습니다.`);
      for (const category of categories) {
        assert.ok((SAFETY_CATEGORIES as readonly string[]).includes(category), category);
      }

      // 실제 validator에 기대값을 넣어, level과 categories의 조합이 서버 규칙상 유효한지 본다.
      const analysis: SituationAnalysis = {
        domainPriority: 'resolved',
        primaryDomain: scenario.domain,
        domainChoiceCandidates: [],
        secondaryDomains: [],
        situationTags: [],
        emotionTags: [],
        spiritualQuestionTags: [],
        prayerModes: [],
        pastoralFunctions: [],
        safety: { level, categories: [...categories] },
        confidence: 0.8,
      };
      const result = validateSituationAnalysis(analysis);
      assert.equal(result.valid, true, `${scenario.text}: ${result.errors.join(' / ')}`);
    }
  });

  it('반복적 폭언과 폭력 피해 사례는 최소 caution / abuse다', () => {
    for (const rank of [12, 18]) {
      const scenario = SAFETY_BOUNDARY_SCENARIOS.find(
        (item) => item.source === 'single' && item.domain === 'relationship_conflict_forgiveness' && item.rank === rank,
      );
      assert.ok(scenario, `relationship_conflict_forgiveness rank ${rank}가 경계 목록에 없습니다.`);
      assert.ok(['caution', 'urgent'].includes(scenario!.expected.level));
      assert.ok(scenario!.expected.categories.includes('abuse'));
    }
  });

  it('경계 사례와 검토 후 제외한 사례는 모두 실제 코퍼스의 그 자리 문장을 가리킨다', () => {
    for (const item of [...SAFETY_BOUNDARY_SCENARIOS, ...SAFETY_REVIEWED_NON_BOUNDARY]) {
      if (item.source === 'single') assert.equal(typeof item.rank, 'number', item.text);
      else assert.equal(item.rank, null, item.text);
      assert.equal(findOriginal(item), item.text, `${item.domain}/${item.rank}: 원본과 문장이 다릅니다.`);
    }
  });

  it('같은 문장이 경계 사례이면서 동시에 제외 사례일 수 없다', () => {
    const boundary = new Set(SAFETY_BOUNDARY_SCENARIOS.map((item) => item.text));
    for (const item of SAFETY_REVIEWED_NON_BOUNDARY) {
      assert.equal(boundary.has(item.text), false, item.text);
      assert.ok(item.reason.trim().length > 0, `${item.text}: 제외 이유가 비어 있습니다.`);
    }
  });

  it("만성질환의 '죽음이 가까워진 것 같아' 문장은 보존하되 긴급 의료로 단정하지 않는다", () => {
    // chronic_illness rank 19. 임종을 앞두고 가족과 나눌 말을 고민하는 표현일 수 있다.
    // 의료 긴급성은 사용자가 적는 추가 정보(지금의 급성 증상 등)에 달려 있으므로,
    // 이 문장만으로 urgent_medical 경계 사례로 넣지 않고, 제외 이유를 기록해 둔다.
    const original = EXPANSION_SCENARIOS.find((item) => item.domain === 'chronic_illness' && item.rank === 19);
    assert.equal(original?.text, '죽음이 가까워진 것 같아 가족과 무엇을 말해야 할지 모르겠어요.');
    assert.equal(SAFETY_BOUNDARY_SCENARIOS.some((item) => item.text === original?.text), false);
    assert.equal(SAFETY_REVIEWED_NON_BOUNDARY.some((item) => item.text === original?.text), true);
  });
});

describe('조사 근거 (SCENARIO_RESEARCH_BASIS)', () => {
  it('각 자료는 제목·https URL·확인 날짜·검증 상태·참고 영역·note를 가진다', () => {
    assert.ok(SCENARIO_RESEARCH_BASIS.length > 0);
    const allowed = new Set<string>(RUNTIME_DOMAINS);
    for (const ref of SCENARIO_RESEARCH_BASIS) {
      assert.ok(ref.title.trim().length > 0);
      assert.ok(/^https:\/\//.test(ref.url), ref.url);
      assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(ref.checkedOn), ref.checkedOn);
      assert.ok(['verified', 'unverified'].includes(ref.verificationStatus));
      assert.ok(ref.referencedDomains.length > 0);
      assert.ok(ref.referencedDomains.every((domain) => allowed.has(domain)), ref.title);
      assert.ok(ref.note.trim().length > 0);
    }
  });

  it('comparison_identity·injustice_mistreatment·burnout_exhaustion에 확인된 근거가 각각 있다', () => {
    for (const domain of ['comparison_identity', 'injustice_mistreatment', 'burnout_exhaustion'] as const) {
      const verified = SCENARIO_RESEARCH_BASIS.filter(
        (ref) => ref.verificationStatus === 'verified' && ref.referencedDomains.includes(domain),
      );
      assert.ok(verified.length > 0, `${domain}에 확인된 근거가 없습니다.`);
    }
  });

  it('한국갤럽 자료에 기도 빈도를 확인했다고 적지 않는다', () => {
    const gallup = SCENARIO_RESEARCH_BASIS.find((ref) => ref.url.includes('gallup.co.kr'));
    assert.ok(gallup);
    // "확인하지 못했다"는 부정문 안에서만 등장해야 한다.
    const claimsFrequency = /기도 빈도/.test(gallup!.note) && !/기도 빈도[^.]*확인하지 못했다/.test(gallup!.note);
    assert.equal(claimsFrequency, false, gallup!.note);
  });

  it('제목 문자열이 코퍼스 문장과 똑같이 쓰이지 않았다 (제목과 문장의 완전 일치만 검사한다)', () => {
    // 표현을 바꿔 옮긴 경우까지 잡는 검사가 아니다. 제목이 문장으로 그대로 들어갔는지만 본다.
    const texts = new Set([...EXPANSION_SCENARIOS.map((s) => s.text), ...COMPOUND_SCENARIOS.map((s) => s.text)]);
    for (const ref of SCENARIO_RESEARCH_BASIS) assert.equal(texts.has(ref.title), false, ref.title);
  });
});

/* ==================================================================== */
/* 영역 선택 필요 평가 세트 · 우선순위 불명확 사례 (DOMAIN_CHOICE_SCENARIOS) */
/* ==================================================================== */

/**
 * 이 묶음의 테스트는 개수·번호·조합 균형·중복 같은 구조만 확인한다.
 * 이 세트는 두 문제의 실제 중요도가 같다고 주장하지 않는다.
 * 문장에서 어느 영역을 먼저 다룰지 정할 근거가 부족한 사례일 뿐이다.
 * 기계 검사는 우선순위 불명확성을 의미적으로 증명하지 못한다.
 * 그 판단은 34개 문장과 rationale을 사람이 전수 검토해서 정했다.
 */

/** 이 평가 세트를 추가하기 직전에 계산한 기존 데이터의 SHA-256 지문(JSON 직렬화 기준). */
const PROTECTED_DATA_FINGERPRINTS = {
  expansion: '10e9e2e1efbf0b98fc9ffbf17b4d428bd35776a28ff3f362efe5f5a9a0de9fc9',
  compound: '38cb2b3916359dc67520db370ea7eac1d15b0ce1f54c616587d9754344264243',
  safetyBoundary: '6638a60c82e52b8793b6991a79455e6151998620cb9a810300320959f7f48577',
  reviewedNonBoundary: '8e77e9baf0db8ca60f255ebde643d653aa1f6eedb1d9809e805e7250fcc752ba',
  researchBasis: 'e5a89a77cfc4564ec6f0c949009ec881b73b29549647e8cd06b72633f2e8a8b2',
};

const jsonFingerprint = (value: unknown) =>
  crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');

const pairKey = (domains: readonly string[]) => [...domains].sort().join('|');

describe('영역 선택 필요 평가 세트 · 구조 (기계 검사는 우선순위 불명확성을 의미적으로 증명하지 못한다)', () => {
  it('정확히 34개이고 DC-001부터 번호가 빠짐없이 이어진다', () => {
    assert.equal(DOMAIN_CHOICE_SCENARIOS.length, 34);
    DOMAIN_CHOICE_SCENARIOS.forEach((item, index) => {
      assert.equal(item.id, `DC-${String(index + 1).padStart(3, '0')}`);
    });
  });

  it('모든 candidateDomains는 정확히 두 개이고, 서로 다르며, 실제 영역이다', () => {
    const runtime = new Set<string>(RUNTIME_DOMAINS);
    for (const item of DOMAIN_CHOICE_SCENARIOS) {
      assert.equal(item.candidateDomains.length, 2, item.id);
      const [first, second] = item.candidateDomains;
      assert.notEqual(first, second, item.id);
      assert.ok(runtime.has(first), `${item.id}: ${first}`);
      assert.ok(runtime.has(second), `${item.id}: ${second}`);
      assert.equal(item.candidateDomains.includes(FALLBACK_DOMAIN as ExpansionDomain), false, item.id);
    }
  });

  it('17개 영역이 각각 정확히 4번 등장한다', () => {
    const counts = new Map<string, number>();
    for (const item of DOMAIN_CHOICE_SCENARIOS) {
      for (const domain of item.candidateDomains) counts.set(domain, (counts.get(domain) ?? 0) + 1);
    }
    assert.equal(counts.size, 17);
    for (const domain of RUNTIME_DOMAINS) assert.equal(counts.get(domain), 4, domain);
  });

  it('순서를 무시한 영역 조합 34개가 모두 다르다', () => {
    const keys = DOMAIN_CHOICE_SCENARIOS.map((item) => pairKey(item.candidateDomains));
    assert.equal(new Set(keys).size, 34);
  });

  it('ID와 문장이 고유하고, 모든 문장은 12자 이상이다', () => {
    assert.equal(new Set(DOMAIN_CHOICE_SCENARIOS.map((item) => item.id)).size, 34);
    assert.equal(new Set(DOMAIN_CHOICE_SCENARIOS.map((item) => item.text)).size, 34);
    assert.ok(DOMAIN_CHOICE_SCENARIOS.every((item) => item.text.length >= 12));
  });

  it('단일 코퍼스 340개·복합 코퍼스 68개와 문장이 겹치지 않는다', () => {
    const others = new Set([...EXPANSION_SCENARIOS.map((s) => s.text), ...COMPOUND_SCENARIOS.map((s) => s.text)]);
    assert.deepEqual(
      DOMAIN_CHOICE_SCENARIOS.filter((item) => others.has(item.text)).map((item) => item.id),
      [],
    );
  });

  it('모든 사례에 사람이 검수할 rationale이 있다 (내용이 옳은지는 검사하지 않는다)', () => {
    for (const item of DOMAIN_CHOICE_SCENARIOS) {
      assert.ok(item.rationale.trim().length > 0, item.id);
    }
  });

  it('데이터에 primaryDomain·secondaryDomains가 없고, 필드는 id·text·candidateDomains·rationale뿐이다', () => {
    for (const item of DOMAIN_CHOICE_SCENARIOS) {
      assert.equal('primaryDomain' in item, false, item.id);
      assert.equal('secondaryDomains' in item, false, item.id);
      assert.deepEqual(Object.keys(item).sort(), ['candidateDomains', 'id', 'rationale', 'text']);
    }
  });

  it('중심을 정하는 대표 표현이 문장에 쓰이지 않았다 (낱말 검사일 뿐 우선순위 불명확성을 증명하지 않는다)', () => {
    // 이 목록에 없는 방식(어순, 문장 길이, 감정의 강도 등)으로도 중심이 드러날 수 있다.
    // 이 검사는 명시적인 표지어가 없다는 것만 확인한다.
    const priorityMarkers = ['무엇보다', '더 힘든', '가장', '우선', '먼저 다루', '먼저'];
    for (const item of DOMAIN_CHOICE_SCENARIOS) {
      for (const marker of priorityMarkers) {
        assert.equal(item.text.includes(marker), false, `${item.id}에 "${marker}": ${item.text}`);
      }
    }
  });

  it('새 문장에 노골적인 즉시-위험 낱말이 없다 (안전 판정을 대신하지 않는다)', () => {
    for (const item of DOMAIN_CHOICE_SCENARIOS) {
      for (const word of IMMEDIATE_DANGER_WORDS) {
        assert.equal(item.text.includes(word), false, `${item.id}에 "${word}": ${item.text}`);
      }
    }
  });
});

describe('영역 선택 필요 평가 세트 · 문구 교정 회귀 (v2)', () => {
  // 사람이 다시 검토해 고친 네 문장이 예전 표현으로 되돌아가지 않게 고정한다.
  // 이 검사도 낱말만 본다. 교정된 문장이 우선순위 불명확 사례로 의미상 적절한지는 사람이 판단했다.
  const byId = (id: string) => {
    const found = DOMAIN_CHOICE_SCENARIOS.find((item) => item.id === id);
    assert.ok(found, `${id}가 없습니다.`);
    return found!;
  };

  it('DC-008은 영적 메마름이 이사하기 전부터였다고 적는다', () => {
    const item = byId('DC-008');
    assert.ok(item.text.includes('이사하기 전부터'), item.text);
    assert.equal(item.text.includes('이사 온 동네에서 몇 달째'), false, item.text);
    assert.deepEqual(pairKey(item.candidateDomains), pairKey(['loneliness_isolation', 'spiritual_dryness']));
  });

  it('DC-010은 대비 표현 "그래도"를 쓰지 않는다', () => {
    const item = byId('DC-010');
    assert.equal(item.text.includes('그래도'), false, item.text);
    assert.equal(item.rationale.includes('그래도'), false, item.rationale);
    assert.deepEqual(pairKey(item.candidateDomains), pairKey(['burnout_exhaustion', 'gratitude_joy']));
  });

  it('DC-011은 대비 표현 "그런데"를 쓰지 않는다', () => {
    const item = byId('DC-011');
    assert.equal(item.text.includes('그런데'), false, item.text);
    assert.deepEqual(pairKey(item.candidateDomains), pairKey(['gratitude_joy', 'grief_loss']));
  });

  it('DC-031은 꿈이나 메시지를 판정하는 표현이 없고, 영역 조합은 그대로다', () => {
    const item = byId('DC-031');
    for (const word of ['꿈', '메시지']) {
      assert.equal(item.text.includes(word), false, `${word}: ${item.text}`);
      assert.equal(item.rationale.includes(word), false, `${word}: ${item.rationale}`);
    }
    assert.deepEqual([...item.candidateDomains], ['injustice_mistreatment', 'wisdom_discernment']);
  });

  it('두 대상 파일의 이 세트 데이터·설명에 예전 개념 표현과 교정 전 문구가 남지 않았다', () => {
    // 금지 표현을 이 테스트 파일에 그대로 적으면 파일 검색에서 이 목록 자체가 걸린다.
    // 그래서 조각을 이어 붙여 만든다. 검사하는 문자열은 아래 여섯 개와 같다.
    const forbidden = [
      ['영역', '동률'],
      ['의미상', '동률'],
      ['그래도', '지난주'],
      ['그런데', '같은 주'],
      ['하나님이 주시는', '메시지인지'],
      ['반복해서 꾸는', '꿈'],
    ].map((parts) => parts.join(' '));
    const dataText = JSON.stringify(DOMAIN_CHOICE_SCENARIOS);
    const corpusSource = readFileSync(new URL('../../scripts/situation-scenario-corpus.ts', import.meta.url), 'utf8');
    for (const word of forbidden) {
      assert.equal(dataText.includes(word), false, `데이터에 "${word}"`);
      assert.equal(corpusSource.includes(word), false, `코퍼스 파일에 "${word}"`);
    }
  });
});

describe('영역 선택 필요 평가 세트 · 기존 데이터 보존', () => {
  it('코퍼스 수량과 내부 테스트 문구 교정 후 140문장 지문이 그대로다', () => {
    assert.equal(EXPANSION_SCENARIOS.length, 340);
    assert.equal(COMPOUND_SCENARIOS.length, 68);
    const rows = EXPANSION_SCENARIOS.filter((item) => EXISTING_EXPANSION_DOMAINS.includes(item.domain));
    assert.equal(fingerprintOf(rows), EXISTING_EXPANSION_FINGERPRINT);
  });

  it('단일·복합 코퍼스 전체(rationale 포함)가 문구 교정 후 지문과 같다', () => {
    assert.equal(jsonFingerprint(EXPANSION_SCENARIOS), PROTECTED_DATA_FINGERPRINTS.expansion);
    assert.equal(jsonFingerprint(COMPOUND_SCENARIOS), PROTECTED_DATA_FINGERPRINTS.compound);
  });

  it('안전 경계·검토 완료 비경계·조사 근거 데이터가 추가 전과 같다', () => {
    assert.equal(SAFETY_BOUNDARY_SCENARIOS.length, 3);
    assert.equal(SAFETY_REVIEWED_NON_BOUNDARY.length, 11);
    assert.equal(jsonFingerprint(SAFETY_BOUNDARY_SCENARIOS), PROTECTED_DATA_FINGERPRINTS.safetyBoundary);
    assert.equal(jsonFingerprint(SAFETY_REVIEWED_NON_BOUNDARY), PROTECTED_DATA_FINGERPRINTS.reviewedNonBoundary);
    assert.equal(jsonFingerprint(SCENARIO_RESEARCH_BASIS), PROTECTED_DATA_FINGERPRINTS.researchBasis);
  });
});
