/**
 * 2단계 지시문이 서버 규칙과 같은 말을 하는가 · 테스트
 *
 * 실행: npm test
 *
 * production v29에서 2단계 응답이 verification_invalid_source_metadata로 끝났다.
 * 응답 형식(JSON schema)은 지켰지만 서버가 보는 규칙은 어긴 것이다.
 * 형식으로는 말할 수 없는 규칙(비어 있지 않기·겹치지 않기·종류별 허용 용도)을
 * 지시문이 실제로 말하는지 확인한다.
 *
 * 중요: 이 파일은 허용표를 다시 적지 않는다.
 * canonical 상수에서 읽어 비교한다. 두 벌이 따로 낡는 일이 없게 하기 위해서다.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import {
  DISCOVERY_TIMEOUT_MS,
  RESPONSE_INCLUDE,
  SOURCE_HARVEST_DRAFT_SCHEMA,
  SOURCE_HARVEST_MODEL,
  VERIFICATION_MAX_OUTPUT_TOKENS,
  VERIFICATION_MAX_TOOL_CALLS,
  VERIFICATION_TIMEOUT_MS,
  WEB_SEARCH_TOOL,
  buildSourceHarvestDraftSchema,
  buildVerificationInstructions,
  buildVerificationPayload,
} from '../../supabase/functions/_shared/source-harvester-execution-contract.ts';
import {
  ACCESS_LEVELS,
  ALLOWED_INTENDED_USES,
  HARVESTABLE_SOURCE_TYPES,
  INTENDED_USES,
  PUBLICATION_YEAR_MAX,
  PUBLICATION_YEAR_MIN,
  RELEVANCE_NOTE_MAX,
  VERIFICATION_DRAFT_SOURCE_FIELDS,
} from '../../supabase/functions/_shared/source-harvest-contract.ts';
import { isSourceTypeAllowedForUse } from '../../supabase/functions/_shared/research-source.ts';
import { checkVerificationDraftSource } from '../../supabase/functions/_shared/verification-draft-source.ts';

const urls = (count: number) =>
  Array.from({ length: count }, (_, index) => `https://sources.example.org/aroeda/fixture-${index}`);

const instructions = () =>
  buildVerificationInstructions({
    targetDomain: 'financial_hardship',
    domainDescription: '생계와 경제적 어려움',
    discoveredUrls: urls(10),
  });

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
const CONTRACT = '../../supabase/functions/_shared/source-harvester-execution-contract.ts';

/* ------------------------------------------------------------------ */

describe('2단계 지시문 · 자료 한 건의 항목을 모두 말한다', () => {
  it('아홉 항목의 이름이 모두 나온다', () => {
    const text = instructions();
    for (const field of VERIFICATION_DRAFT_SOURCE_FIELDS) {
      assert.ok(text.includes(field), field);
    }
  });

  it('제목·저자·발행처는 빈 값을 금지하고 채택하지 말라고 말한다', () => {
    const text = instructions();

    assert.ok(text.includes('title, authorOrOrganization, publisherOrInstitution'));
    assert.ok(text.includes('빈 문자열'));
    assert.ok(text.includes('공백만 있는 값을 넣지 마십시오'));
    assert.ok(text.includes('sources에 넣지 말고'));
    // 빈 값으로 형식만 맞추는 것을 명확히 막는다.
    assert.ok(text.includes('빈 값을 만들어 형식만 맞추는 것이 가장 나쁜 답입니다'));
  });

  it('확인하지 못한 자료가 갈 곳을 말한다', () => {
    const text = instructions();
    assert.ok(text.includes('rejectedSources'));
    assert.ok(text.includes('unresolvedSourceQuestions'));
  });

  it('relevanceNote의 목적·필수·길이를 말한다', () => {
    const text = instructions();
    assert.ok(text.includes('relevanceNote'));
    assert.ok(text.includes('왜 필요한지'));
    assert.ok(text.includes('반드시 한 글자 이상'));
    assert.ok(text.includes(`${RELEVANCE_NOTE_MAX}자를 넘기지 마십시오`));
    // 내용을 옮겨 담는 칸이 아니라는 것과 개인정보 금지를 말한다.
    assert.ok(text.includes('길게 인용하는 칸이 아닙니다'));
    assert.ok(text.includes('개인정보를 적는 칸도 아닙니다'));
  });
});

describe('2단계 지시문 · 숫자와 목록이 서버 규칙과 같다', () => {
  it('연도 범위가 서버가 보는 범위와 같다', () => {
    const text = instructions();
    assert.ok(text.includes(`${PUBLICATION_YEAR_MIN} 이상 ${PUBLICATION_YEAR_MAX} 이하의 정수`));
    assert.ok(text.includes('확인하지 못했다면 null'));

    // 상수를 바꾸면 이 시험이 함께 움직인다. 숫자를 손으로 적지 않는다.
    assert.equal(text.includes(String(PUBLICATION_YEAR_MIN)), true);
    assert.equal(text.includes(String(PUBLICATION_YEAR_MAX)), true);
  });

  it('종류와 확인 수준 목록이 canonical 목록과 같다', () => {
    const text = instructions();
    assert.ok(text.includes(HARVESTABLE_SOURCE_TYPES.join(', ')));
    assert.ok(text.includes(ACCESS_LEVELS.join(', ')));
  });

  it('메모 길이 제한을 손으로 적지 않았다', () => {
    // 지시문 소스에 300 같은 숫자가 직접 박혀 있으면 상수와 따로 낡는다.
    const source = read(CONTRACT);
    const body = source.split('function buildAcceptedSourceFieldRules')[1].split('\n}\n')[0];

    assert.ok(body.includes('${RELEVANCE_NOTE_MAX}'));
    assert.ok(body.includes('${PUBLICATION_YEAR_MIN}'));
    assert.ok(body.includes('${PUBLICATION_YEAR_MAX}'));
    assert.equal(/\b300\b|\b1450\b|\b2100\b/.test(body), false);
  });
});

describe('2단계 지시문 · 용도 규칙', () => {
  it('최소 한 개와 중복 금지를 말한다', () => {
    const text = instructions();
    assert.ok(text.includes('최소 한 개를 넣으십시오'));
    assert.ok(text.includes('빈 목록은 안 됩니다'));
    assert.ok(text.includes('같은 값을 두 번 넣지 마십시오'));
  });

  it('종류별 허용표가 canonical 상수와 정확히 같다', () => {
    const text = instructions();

    // 표를 여기서 다시 적지 않는다. 상수에서 만들어 비교한다.
    for (const sourceType of HARVESTABLE_SOURCE_TYPES) {
      const allowed = ALLOWED_INTENDED_USES[sourceType];
      const line = `- ${sourceType}: ${allowed.join(', ')}`;
      assert.ok(text.includes(line), sourceType);
    }
  });

  it('허용표가 바뀌면 지시문도 함께 바뀐다', () => {
    // 상수에서 만든 줄과 지시문에 실제로 있는 줄의 개수가 같아야 한다.
    const text = instructions();
    const rendered = HARVESTABLE_SOURCE_TYPES.filter((sourceType) =>
      text.includes(`- ${sourceType}: ${ALLOWED_INTENDED_USES[sourceType].join(', ')}`),
    );
    assert.equal(rendered.length, HARVESTABLE_SOURCE_TYPES.length);

    // 표에 없는 조합이 지시문에 섞여 들어가지 않았는지 상수 기준으로 확인한다.
    for (const sourceType of HARVESTABLE_SOURCE_TYPES) {
      for (const use of INTENDED_USES) {
        if (isSourceTypeAllowedForUse(sourceType, use)) continue;
        assert.equal(
          text.includes(`- ${sourceType}: `) &&
            text.split(`- ${sourceType}: `)[1].split('\n')[0].split(', ').includes(use),
          false,
          `${sourceType} × ${use}`,
        );
      }
    }
  });

  it('짐작하지 말라고 못 박는다', () => {
    const text = instructions();
    assert.ok(text.includes('이 표에 없는 조합은 넣지 마십시오'));
    assert.ok(text.includes('관계를 짐작하지 마십시오'));
  });

  it('지시문이 말하는 규칙은 서버가 실제로 보는 규칙과 같다', () => {
    // 지시문대로 쓴 자료는 서버 검사를 통과한다.
    for (const sourceType of HARVESTABLE_SOURCE_TYPES) {
      const source = {
        sourceType,
        title: '연구 자료',
        authorOrOrganization: '연구자',
        publisherOrInstitution: '연구 기관',
        publicationYear: PUBLICATION_YEAR_MAX,
        url: 'https://sources.example.org/aroeda/fixture-0',
        accessLevel: ACCESS_LEVELS[0],
        intendedUse: [...ALLOWED_INTENDED_USES[sourceType]],
        relevanceNote: '이 영역의 문맥을 확인하는 데 필요합니다.',
        evidenceClaims: [
          {
            // 근거의 용도는 그 자료가 실제로 가진 용도 중 하나여야 한다.
            intendedUse: ALLOWED_INTENDED_USES[sourceType][0],
            statement: '이 자료는 본문의 문맥과 그 신학적 자리를 함께 설명한다고 관찰되었다.',
            passageReferences:
              ALLOWED_INTENDED_USES[sourceType][0] === 'exegesis'
                ? [{ book: 'Psalms', chapter: 42, startVerse: 5, endVerse: 5 }]
                : [],
          },
        ],
      };
      assert.deepEqual(checkVerificationDraftSource(source), [], sourceType);
    }
  });
});

describe('2단계 지시문 · 기존 의미를 지운 곳이 없다', () => {
  it('실제 확인·주소 범위·역할 제한 규칙이 그대로 있다', () => {
    const text = instructions();
    const kept = [
      '먼저 그 주소를 실제로 열어',
      '목록에 없는 새 주소를 만들지 않는다',
      '검색 결과 요약만 보고 자료를 승인하지 않는다',
      'sourceId나 확인 날짜를 적지 않는다',
      '의료·법률·재정·상담 자료는 현실의 안전과 전문적 도움의 경계를 확인하는 용도입니다',
      '목회 보조자료도 성경 해석의 핵심 근거가 될 수 없습니다',
      '초록만 확인했더라도 그 초록 페이지를 실제로 열어야 합니다',
      '억지로 채우는 것이 실패입니다',
      '확인되지 않은 것을 추측해서 적지 마십시오',
    ];
    for (const line of kept) assert.ok(text.includes(line), line);
  });

  it('확인 범위 숫자 안내가 그대로다', () => {
    const text = buildVerificationInstructions({
      targetDomain: 'financial_hardship',
      domainDescription: '생계와 경제적 어려움',
      discoveredUrls: urls(10),
    });
    // 받은 주소가 10개면 서로 다른 8개를 열라고 말한다.
    assert.ok(text.includes('서로 다른 주소를 최소 8개 열어'));
  });

  it('지시문이 지나치게 길어지지 않았다', () => {
    assert.ok(instructions().length < 8_000, String(instructions().length));
  });
});

describe('2단계 요청 · 지시문 밖은 아무것도 바뀌지 않았다', () => {
  const payload = () =>
    buildVerificationPayload({
      targetDomain: 'financial_hardship',
      domainDescription: '생계와 경제적 어려움',
      evidenceVersion: 1,
      prioritizerSnapshotId: `snap_${'a'.repeat(64)}`,
      discoveredUrls: urls(10),
    });

  it('모델·도구·상한·include가 그대로다', () => {
    const value = payload();
    assert.equal(value.model, SOURCE_HARVEST_MODEL);
    assert.equal(SOURCE_HARVEST_MODEL, 'gpt-5.6-terra');
    assert.equal(value.store, false);
    assert.deepEqual(value.tools, [{ ...WEB_SEARCH_TOOL }]);
    assert.deepEqual(value.include, [...RESPONSE_INCLUDE]);
    assert.equal(value.max_tool_calls, VERIFICATION_MAX_TOOL_CALLS);
    assert.equal(VERIFICATION_MAX_TOOL_CALLS, 18);
    assert.equal(value.max_output_tokens, VERIFICATION_MAX_OUTPUT_TOKENS);
    // 기존에 없던 설정을 새로 넣지 않았다.
    assert.deepEqual(Object.keys(value).sort(), [
      'include',
      'input',
      'instructions',
      'max_output_tokens',
      'max_tool_calls',
      'model',
      'store',
      'text',
      'tools',
    ]);
  });

  it('응답 형식(JSON schema)이 그대로다', () => {
    const value = payload();
    const format = (value.text as { format: Record<string, unknown> }).format;
    assert.equal(format.type, 'json_schema');
    assert.equal(format.name, 'source_harvest_draft');
    assert.equal(format.strict, true);
    assert.deepEqual(format.schema, buildSourceHarvestDraftSchema(urls(10)));

    // 자료 한 건의 형식 조건을 이번에 손대지 않았다.
    const source = read(CONTRACT).split('const draftSourceSchema = ')[1].split('} as const;')[0];
    for (const banned of ['minLength', 'minItems', 'uniqueItems', 'minimum', 'maximum']) {
      assert.equal(source.includes(banned), false, banned);
    }
    assert.ok(source.includes('maxLength: RELEVANCE_NOTE_MAX'));
  });

  it('시간 제한은 다른 계약이므로 그대로다', () => {
    assert.equal(DISCOVERY_TIMEOUT_MS, 60_000);
    assert.equal(VERIFICATION_TIMEOUT_MS, 75_000);
  });

  it('최상위 초안 형식도 그대로다', () => {
    assert.deepEqual(SOURCE_HARVEST_DRAFT_SCHEMA.required, [
      'targetDomain',
      'evidenceVersion',
      'prioritizerSnapshotId',
      'sources',
      'rejectedSources',
      'unresolvedSourceQuestions',
    ]);
  });
});

describe('2단계 지시문 · 다른 계약에 손대지 않았다', () => {
  const stripComments = (source: string) =>
    source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '');

  it('서버가 보는 규칙 파일은 그대로다', () => {
    const validator = stripComments(
      read('../../supabase/functions/_shared/verification-draft-source.ts'),
    );
    // 판정은 여전히 이 열여섯 사유뿐이고, 지시문을 참조하지 않는다.
    assert.equal(validator.includes('buildVerificationInstructions'), false);
    assert.equal(validator.includes('ALLOWED_INTENDED_USES'), false);
    assert.ok(validator.includes('isSourceTypeAllowedForUse'));
  });

  it('두 진단은 그대로다', () => {
    const execution = stripComments(
      read('../../supabase/functions/_shared/source-harvester-execution.ts'),
    );
    assert.equal((execution.match(/log\((parsed|checked)\.diagnostic\)/g) || []).length, 2);
    assert.equal((execution.match(/describeOpenAIHttpFailure\(/g) || []).length, 2);
  });

  it('이어서 하는 요청은 지시문을 쓰지 않는다', () => {
    const parallel = stripComments(
      read('../../supabase/functions/_shared/source-harvester-parallel-recovery-execution.ts'),
    );
    assert.equal(parallel.includes('buildVerificationInstructions'), false);
    assert.equal(parallel.includes('buildAcceptedSourceFieldRules'), false);
  });

  it('허용표를 손으로 옮겨 적은 곳이 없다', () => {
    // 표의 정의는 research-source.ts 한 곳뿐이다.
    const contract = stripComments(read(CONTRACT));
    assert.ok(contract.includes('ALLOWED_INTENDED_USES[sourceType]'));
    assert.equal(contract.includes("commentary:"), false);
    assert.equal(contract.includes("pastoral_resource:"), false);
  });
});
