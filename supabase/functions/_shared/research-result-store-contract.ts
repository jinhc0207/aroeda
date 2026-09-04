/**
 * 연구 결과 보관 계약
 *
 * 왜 필요한가:
 *   지금 Biblical Researcher는 결과를 응답으로 돌려주고 그대로 끝난다.
 *   담아 두는 곳이 없다. 그래서 연구가 끝나는 순간 결과가 사라진다.
 *   사람이 나중에 읽고 검수할 수도, 무엇을 근거로 나온 말인지 물을 수도 없다.
 *
 *   이 파일은 그 결과를 어떤 모양으로 보관할지 먼저 정한다.
 *   표를 만들지는 않는다. 약속만 정한다.
 *
 * 지키는 원칙 네 가지.
 *
 *   1. 연구 내용은 고치지 않는다.
 *      한 번 보관한 연구는 그대로 둔다. 다시 연구했으면 새로 한 건을 남긴다.
 *      틀린 연구를 조용히 고쳐 두면, 그때 무엇을 보고 판단했는지 알 수 없게 된다.
 *
 *   2. 같은 값을 두 곳에 두지 않는다.
 *      연구 결과 안에 이미 있는 값(대상 영역, 근거 지문 등)을
 *      보관 기록에 또 적지 않는다. 두 곳에 있으면 언젠가 서로 달라진다.
 *
 *   3. 근거가 사라져도 검증할 수 있어야 한다.
 *      연구에 쓰인 근거 꾸러미는 한 번 꺼내 쓰면 지워지고, 30분이면 만료된다.
 *      그래서 결과에 남은 근거 번호만으로는 나중에 아무것도 찾을 수 없다.
 *      필요한 사실만 얼어붙은 상태로 함께 보관한다.
 *
 *   4. 사용자 이야기는 여기 오지 않는다.
 *      이 연구는 카드를 만들기 위한 것이지 어떤 사람을 위한 것이 아니다.
 *      사용자가 입력한 상황이나 기도는 이 경로에 들어올 자리가 없다.
 *
 * 여기 없는 것:
 *   사용자에게 보여줄 문구(userExplanation, prayerDirection),
 *   게시 상태, 검수 시각, Scripture Card 번호.
 *   그것들은 다음 계층(게시 콘텐츠)의 몫이다. 여기서 섞지 않는다.
 */

import {
  type BiblicalResearchBrief,
  type BiblicalResearchResult,
  validateBiblicalResearchResult,
} from './biblical-researcher.ts';
import {
  type BiblicalResearchEvidenceSource,
  computeBiblicalResearchEvidenceSetHash,
} from './biblical-research-handoff.ts';

/* ------------------------------------------------------------------ */
/* 영구 보존할 근거                                                     */
/* ------------------------------------------------------------------ */

/**
 * 연구가 무엇을 보고 나왔는지, 나중에도 확인할 수 있게 남기는 최소한의 사실.
 *
 * 여기 담기는 것과 담기지 않는 것의 기준은 하나다.
 *   "연구 결과 안에 이미 있는가?"
 *
 * 대상 영역, 근거 판 번호, 우선순위 스냅샷 번호, 근거 지문은
 * 이미 결과 안에 있으므로 여기 다시 적지 않는다.
 *
 * 반대로 다음 넷은 결과 안에 없고, 꾸러미와 함께 사라진다.
 * 그래서 여기에 남긴다.
 */
export type ResearchResultProvenance = {
  /** 그 영역이 무엇을 뜻하는지. 나중에 분류가 바뀌어도 그때의 뜻이 남는다. */
  domainDescription: string;
  /** 연구 당시 이미 다루고 있던 영역들. "왜 이 영역이었나"의 근거다. */
  activeCoveredDomains: string[];
  /** 실제로 본 자료와 그 자료에서 뽑은 근거. 번호가 가리킬 대상이다. */
  sources: BiblicalResearchEvidenceSource[];
  /** 수집 단계가 남긴 "더 알아봐야 할 것". 연구자가 남긴 것과 다른 목록이다. */
  sourceUnresolvedQuestions: string[];
};

/* ------------------------------------------------------------------ */
/* 보관 기록                                                            */
/* ------------------------------------------------------------------ */

/**
 * 보관할 때 넘기는 값.
 *
 * 번호와 시각은 여기 없다. 그 둘은 저장하는 쪽이 붙인다.
 * 부르는 쪽이 시각을 정하게 두면 같은 연구가 서로 다른 시각으로 들어올 수 있다.
 */
export type ResearchResultStoreInsert = {
  result: BiblicalResearchResult;
  provenance: ResearchResultProvenance;
  /** 같은 연구가 두 번 들어오지 않게 하는 열쇠. computeResearchResultHash로 만든다. */
  resultHash: string;
};

/**
 * 보관된 한 건.
 *
 * 넣을 때 준 것에 저장하는 쪽이 번호와 시각을 붙인 모양이다.
 * 고쳐 쓰는 자리가 없다. 고칠 일이 있으면 새 건을 남긴다.
 */
export type ResearchResultRecord = ResearchResultStoreInsert & {
  /** 보관된 줄의 번호. 저장하는 쪽이 만든다. */
  researchResultId: string;
  /** 보관된 시각. 저장하는 쪽이 붙인다. */
  createdAt: string;
};

/** 넣을 때 넘기는 항목. 이것 말고 다른 항목은 받지 않는다. */
export const RESEARCH_RESULT_INSERT_FIELDS = ['result', 'provenance', 'resultHash'] as const;

/** 근거 기록의 항목. */
export const RESEARCH_RESULT_PROVENANCE_FIELDS = [
  'domainDescription',
  'activeCoveredDomains',
  'sources',
  'sourceUnresolvedQuestions',
] as const;

/**
 * 이 계층에 절대 들어오면 안 되는 항목들.
 *
 * 앞의 넷은 사용자에게 보여줄 글과 게시 상태다. 다음 계층의 몫이다.
 * 뒤의 셋은 사람의 이야기다. 이 경로에는 애초에 올 일이 없다.
 * 실수로 섞이면 검사에서 막는다.
 */
export const FORBIDDEN_STORE_FIELDS = [
  'userExplanation',
  'prayerDirection',
  'status',
  'publishedAt',
  'reviewedAt',
  'scriptureCardId',
  'situation',
  'prayer',
  'userId',
] as const;

export const RESEARCH_RESULT_HASH_FORMAT = /^rres_[0-9a-f]{64}$/;

/* ------------------------------------------------------------------ */
/* 지문                                                                 */
/* ------------------------------------------------------------------ */

/**
 * 항목 순서에 흔들리지 않게 정렬해서 글자로 만든다.
 *
 * 같은 내용이면 항목을 적은 순서가 달라도 같은 글자가 나와야 한다.
 * 그래야 같은 연구가 두 번 들어오는 것을 막을 수 있다.
 *
 * 배열은 정렬하지 않는다. 연구에서는 순서가 뜻을 가진다.
 * 걸음의 차례가 바뀌면 다른 연구다.
 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;

  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(',')}}`;
}

/**
 * 연구 결과 한 건의 지문.
 *
 * 결과 내용만 본다. 보관 시각이나 줄 번호는 넣지 않는다.
 * 그 둘을 넣으면 같은 연구인데도 매번 다른 지문이 나와서
 * 두 번 저장되는 것을 막지 못한다.
 *
 * 근거 꾸러미 지문(evsetc...)과 헷갈리지 않도록 앞머리를 다르게 둔다.
 *   evset_  근거 꾸러미의 지문
 *   rres_   연구 결과의 지문
 */
export async function computeResearchResultHash(result: BiblicalResearchResult): Promise<string> {
  const bytes = new TextEncoder().encode(stableStringify(result));
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  const hex = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');

  return `rres_${hex}`;
}

/* ------------------------------------------------------------------ */
/* 검사                                                                 */
/* ------------------------------------------------------------------ */

export type StoreValidationResult = { valid: boolean; errors: string[] };

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0;

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === 'string');

/**
 * 근거 기록에서 연구 요청서를 되살린다.
 *
 * 요청서의 다섯 항목 중 셋은 이미 결과 안에 있다.
 * 그래서 보관할 때는 나머지 둘만 남기고, 확인할 때 여기서 다시 합친다.
 * 같은 값을 두 곳에 적어 두지 않으면서도 지문을 다시 계산할 수 있다.
 */
function rebuildBrief(
  result: BiblicalResearchResult,
  provenance: ResearchResultProvenance,
): BiblicalResearchBrief {
  return {
    targetDomain: result.targetDomain,
    domainDescription: provenance.domainDescription,
    evidenceVersion: result.evidenceVersion,
    prioritizerSnapshotId: result.prioritizerSnapshotId,
    activeCoveredDomains: provenance.activeCoveredDomains,
  };
}

/**
 * 보관해도 되는 값인지 확인한다.
 *
 * 어떤 이상한 값이 들어와도 예외를 던지지 않는다.
 * 판단이 서지 않으면 막는 쪽으로 끝낸다.
 *
 * 연구 내용 자체는 여기서 새로 검사하지 않는다.
 * 이미 있는 검사기(validateBiblicalResearchResult)를 그대로 쓴다.
 * 같은 규칙을 두 벌 만들면 언젠가 서로 달라진다.
 *
 * 마지막에 근거 꾸러미의 지문을 다시 계산해서 결과에 적힌 값과 같은지 확인한다.
 *
 * 이 검사는 보관된 근거와 연구 결과가 서로 어긋나지 않았는지 확인하는 장치다.
 * 근거만 바뀌고 지문이 그대로면 여기서 드러난다.
 *
 * 다만 값을 바꾸지 못하게 막는 잠금장치는 아니다.
 * 표에 쓸 수 있는 사람이 근거와 지문을 함께 바꾸면 이 검사는 통과한다.
 * 실제로 못 바꾸게 하는 일은 저장 계층의 쓰기 권한과
 * 고쳐 쓰지 않는 규칙이 맡는다.
 */
export async function validateResearchResultInsert(
  value: unknown,
): Promise<StoreValidationResult> {
  const errors: string[] = [];

  try {
    if (!isPlainObject(value)) {
      return { valid: false, errors: ['보관할 값이 객체가 아닙니다.'] };
    }

    for (const key of Object.keys(value)) {
      if (!(RESEARCH_RESULT_INSERT_FIELDS as readonly string[]).includes(key)) {
        errors.push(`보관 계약에 없는 항목입니다: ${key}`);
      }
    }
    for (const key of RESEARCH_RESULT_INSERT_FIELDS) {
      if (!(key in value)) errors.push(`빠진 항목입니다: ${key}`);
    }

    const provenance = value.provenance;
    if (!isPlainObject(provenance)) {
      errors.push('근거 기록이 객체가 아닙니다.');
    } else {
      for (const key of Object.keys(provenance)) {
        if (!(RESEARCH_RESULT_PROVENANCE_FIELDS as readonly string[]).includes(key)) {
          errors.push(`근거 기록에 없는 항목입니다: ${key}`);
        }
      }
      if (!isNonEmptyString(provenance.domainDescription)) {
        errors.push('영역 설명이 없습니다.');
      }
      if (!isStringArray(provenance.activeCoveredDomains)) {
        errors.push('이미 다루던 영역 목록이 문자열 목록이 아닙니다.');
      }
      if (!Array.isArray(provenance.sources) || provenance.sources.length === 0) {
        errors.push('근거 자료가 하나도 없습니다.');
      }
      if (!isStringArray(provenance.sourceUnresolvedQuestions)) {
        errors.push('수집 단계의 남은 질문이 문자열 목록이 아닙니다.');
      }
    }

    if (!isNonEmptyString(value.resultHash) || !RESEARCH_RESULT_HASH_FORMAT.test(value.resultHash)) {
      errors.push('연구 결과 지문의 모양이 맞지 않습니다.');
    }

    // 사용자 이야기나 게시용 문구가 어디에도 섞여 있으면 안 된다.
    const whole = JSON.stringify(value) ?? '';
    for (const forbidden of FORBIDDEN_STORE_FIELDS) {
      if (whole.includes(`"${forbidden}"`)) {
        errors.push(`이 계층에 올 수 없는 항목입니다: ${forbidden}`);
      }
    }

    // 여기까지 모양이 어긋났으면 더 보지 않는다. 지문 계산이 의미가 없다.
    if (errors.length > 0) return { valid: false, errors };

    const result = value.result as BiblicalResearchResult;
    const prov = provenance as unknown as ResearchResultProvenance;

    const research = validateBiblicalResearchResult(result, rebuildBrief(result, prov), prov.sources);
    if (!research.valid) return { valid: false, errors: research.errors };

    const expectedResultHash = await computeResearchResultHash(result);
    if (value.resultHash !== expectedResultHash) {
      errors.push('연구 결과 지문이 내용과 맞지 않습니다.');
    }

    const expectedEvidenceHash = await computeBiblicalResearchEvidenceSetHash({
      brief: rebuildBrief(result, prov),
      sources: prov.sources,
      sourceUnresolvedQuestions: prov.sourceUnresolvedQuestions,
    });
    if (result.evidenceSetHash !== expectedEvidenceHash) {
      errors.push('근거 기록이 연구 결과에 적힌 근거 지문과 맞지 않습니다.');
    }

    return { valid: errors.length === 0, errors };
  } catch {
    // 어떤 값이 들어와도 여기서 멈추지 않는다. 판단이 안 되면 막는다.
    return { valid: false, errors: ['보관할 값을 확인하지 못했습니다.'] };
  }
}
