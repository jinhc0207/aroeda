/**
 * 수집 결과를 연구 단계로 넘기는 꾸러미 (순수 로직)
 *
 * 왜 필요한가:
 *   toResearchSources()는 ResearchSource 계약을 지키려고
 *   relevanceNote와 evidenceClaims를 떼어 낸다.
 *   그것을 그대로 쓰면 연구 단계가 자료의 신원만 받고 근거는 다시 사라진다.
 *
 *   그렇다고 ResearchSource에 근거를 밀어 넣으면
 *   이미 검증된 연구 단계 계약을 흔들게 된다.
 *
 *   그래서 ResearchSource는 그대로 두고, 넘겨줄 꾸러미를 따로 만든다.
 *
 * 이 파일이 하는 일:
 *   확인한다 → 수집 단계에서만 쓰던 값을 뗀다 → 정해진 모양으로 늘어놓는다
 *   → 지문을 만든다 → 꾸러미로 싼다.
 *
 * 이 파일이 하지 않는 일:
 *   네트워크, DB, 환경변수, OpenAI 호출.
 *   문장을 고치거나 요약하지 않는다. 모델이 쓴 것을 그대로 옮긴다.
 *   새 검증 규칙을 만들지 않는다. 이미 있는 것을 다시 쓴다.
 *
 * 서버가 보증하지 않는 것:
 *   근거 문장이 원문의 뜻을 옳게 옮겼는지.
 *   그 한계는 수집 단계에서 정한 것과 같고, 여기서 강해지지 않는다.
 */

import {
  buildSourceHarvestBrief,
  validateSourceHarvestResult,
  type HarvestEvidence,
  type SourceHarvestResult,
} from './source-harvester.ts';
import { checkVerificationDraftSource } from './verification-draft-source.ts';
import type { BiblicalResearchBrief } from './biblical-researcher.ts';
import { RESEARCH_SOURCE_FIELDS, type ResearchSource } from './research-source.ts';

/**
 * 연구 단계가 실제로 보는 자료 한 건.
 *
 * ResearchSource를 고치지 않는다. 그 위에 근거만 얹는다.
 * 수집 단계에서만 쓰던 메모(relevanceNote)는 여기 없다.
 */
export type BiblicalResearchEvidenceSource = ResearchSource & {
  evidenceClaims: readonly HarvestEvidence[];
};

/** 연구 단계로 넘기는 꾸러미. 이것 말고 다른 경로로 자료가 넘어가지 않는다. */
export type BiblicalResearchHandoff = {
  brief: BiblicalResearchBrief;
  /** 이 꾸러미의 지문. 서버가 만든다. 모델이 정할 수 없다. */
  evidenceSetHash: string;
  sources: BiblicalResearchEvidenceSource[];
  /** 수집 단계가 남긴 "더 알아봐야 할 것". 순서를 그대로 둔다. */
  sourceUnresolvedQuestions: string[];
};

export type HandoffResult =
  | { ok: true; handoff: BiblicalResearchHandoff }
  | { ok: false; errors: string[] };

/* ------------------------------------------------------------------ */
/* 지문                                                                 */
/* ------------------------------------------------------------------ */

/** 지문 계산 방식의 판본. 방식이 바뀌면 이 값도 바뀐다. */
export const EVIDENCE_SET_HASH_VERSION = 'v1|biblical-research-evidence';

/**
 * 배열 순서만 다르고 뜻이 같은 것은 같은 지문이 나와야 한다.
 * 그러나 뜻이 있는 순서를 함부로 정렬하지는 않는다.
 *
 * 정렬하는 것:
 *   자료      — sourceId 기준. 목록의 순서 자체에 뜻이 없다.
 *   근거      — evidenceId 기준. 번호가 이미 순서를 담고 있다.
 *   용도      — 집합이다. 중복이 금지돼 있으므로 정렬해도 뜻이 변하지 않는다.
 *   활성 영역  — 집합이다. 기존 지문 계산과 같은 방식(중복 제거 + 정렬)을 쓴다.
 *
 * 정렬하지 않는 것:
 *   남은 물음 — 순서에 뜻이 있는지 알 수 없으므로 그대로 둔다.
 *   본문 위치 — 자료가 다루는 차례일 수 있으므로 그대로 둔다.
 *
 * 왜 이어 붙이지 않고 배열로 늘어놓는가:
 *   제목·저자·발행처·근거 문장·남은 물음은 사람이 쓴 자유로운 글이다.
 *   무엇으로 이어 붙이든 그 글자가 값 안에 들어올 수 있고,
 *   그러면 뜻이 다른 두 꾸러미가 같은 글이 되어 같은 지문이 나온다.
 *
 *     ["A", "B"]  와  ["A?B"]  (?가 이음 글자일 때)
 *
 *   그래서 이음 글자를 쓰지 않는다. 자리를 정해 배열로 담는다.
 *   값의 경계는 JSON이 지킨다.
 *
 * JSON.stringify를 쓰되 객체를 넘기지 않는다.
 * 객체를 넘기면 항목이 적힌 순서에 따라 결과가 달라질 수 있다.
 * 배열만 넘기므로 자리 순서는 이 코드가 정한 것 하나뿐이다.
 */
function canonicalize(input: {
  brief: BiblicalResearchBrief;
  sources: readonly BiblicalResearchEvidenceSource[];
  sourceUnresolvedQuestions: readonly string[];
}): string {
  const { brief, sources, sourceUnresolvedQuestions } = input;

  const byText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

  const canonical: unknown[] = [
    EVIDENCE_SET_HASH_VERSION,

    [
      brief.targetDomain,
      brief.domainDescription,
      brief.evidenceVersion,
      brief.prioritizerSnapshotId,
      [...new Set(brief.activeCoveredDomains)].sort(byText),
    ],

    [...sources]
      .sort((a, b) => byText(a.sourceId, b.sourceId))
      .map((source) => [
        source.sourceId,
        source.sourceType,
        source.title,
        source.authorOrOrganization,
        source.publisherOrInstitution,
        source.publicationYear,
        source.url,
        source.accessedAt,
        source.accessLevel,
        [...source.intendedUse].sort(byText),

        [...source.evidenceClaims]
          .sort((a, b) => byText(a.evidenceId, b.evidenceId))
          .map((claim) => [
            claim.evidenceId,
            claim.intendedUse,
            claim.statement,
            // 순서를 그대로 둔다.
            claim.passageReferences.map((reference) => [
              reference.book,
              reference.chapter,
              reference.startVerse,
              reference.endVerse,
            ]),
          ]),
      ]),

    // 순서를 그대로 둔다. 순서가 바뀌면 다른 지문이 된다.
    [...sourceUnresolvedQuestions],
  ];

  return JSON.stringify(canonical);
}

/**
 * 꾸러미의 지문을 만든다.
 *
 * 자료 목록만 묶지 않는다. 근거 문장과 본문 위치까지 묶는다.
 * 같은 자료에 다른 근거를 붙이면 다른 지문이 나온다.
 */
export async function computeBiblicalResearchEvidenceSetHash(input: {
  brief: BiblicalResearchBrief;
  sources: readonly BiblicalResearchEvidenceSource[];
  sourceUnresolvedQuestions: readonly string[];
}): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalize(input));
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  const hex = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');

  return `evset_${hex}`;
}

/* ------------------------------------------------------------------ */
/* 꾸러미 만들기                                                        */
/* ------------------------------------------------------------------ */

/**
 * 최종 결과 한 건을 가공 전 초안 모양으로 되돌린다.
 *
 * 왜 필요한가:
 *   최종 검사는 근거의 개수와 번호까지만 본다.
 *   문장 길이, 용도가 그 자료의 것인지, 본문 위치가 성경에 있는지는 보지 않는다.
 *
 *   그래서 "최종 결과니까 안전할 것"이라고 넘기지 않는다.
 *   이미 검증된 초안 검사기를 여기서 한 번 더 쓴다.
 *
 * 서버가 붙인 값(자료 id, 확인 날짜, 근거 번호)은 초안에 없으므로 떼어 낸다.
 */
function toDraftShape(source: BiblicalResearchEvidenceSource, relevanceNote: string): unknown {
  return {
    sourceType: source.sourceType,
    title: source.title,
    authorOrOrganization: source.authorOrOrganization,
    publisherOrInstitution: source.publisherOrInstitution,
    publicationYear: source.publicationYear,
    url: source.url,
    accessLevel: source.accessLevel,
    intendedUse: [...source.intendedUse],
    relevanceNote,
    evidenceClaims: source.evidenceClaims.map((claim) => ({
      intendedUse: claim.intendedUse,
      statement: claim.statement,
      passageReferences: claim.passageReferences.map((reference) => ({ ...reference })),
    })),
  };
}

/**
 * 수집 결과를 연구 단계로 넘길 꾸러미로 만든다.
 *
 * 하나라도 어긋나면 꾸러미를 만들지 않는다. 일부만 넘기지 않는다.
 *
 * 의뢰서는 부르는 쪽에서 받지 않는다. 영역 설명도 받지 않는다.
 * 수집 결과에 들어 있는 영역·근거 판본·판단 시점으로 서버가 다시 만든다.
 */
export async function buildBiblicalResearchHandoff(input: {
  harvest: SourceHarvestResult;
  activeCoveredDomains: readonly string[];
}): Promise<HandoffResult> {
  const { harvest, activeCoveredDomains } = input;

  if (typeof harvest !== 'object' || harvest === null || Array.isArray(harvest)) {
    return { ok: false, errors: ['수집 결과가 객체가 아닙니다.'] };
  }

  // 의뢰서는 서버가 만든다. 영역 설명을 부르는 쪽이 바꿀 수 없다.
  let brief: BiblicalResearchBrief;
  try {
    brief = buildSourceHarvestBrief({
      targetDomain: harvest.targetDomain,
      evidenceVersion: harvest.evidenceVersion,
      prioritizerSnapshotId: harvest.prioritizerSnapshotId,
      activeCoveredDomains,
    });
  } catch {
    // 어떤 값이 잘못됐는지는 밖으로 나누지 않는다.
    return { ok: false, errors: ['이 수집 결과로는 연구 의뢰서를 만들 수 없습니다.'] };
  }

  // 최종 결과 검사를 그대로 다시 통과해야 한다.
  const finalCheck = await validateSourceHarvestResult(harvest, brief);
  if (!finalCheck.valid) return { ok: false, errors: finalCheck.errors };

  const errors: string[] = [];
  const sources: BiblicalResearchEvidenceSource[] = [];
  const seenEvidenceIds = new Set<string>();
  const seenSourceIds = new Set<string>();

  for (const [index, entry] of harvest.sources.entries()) {
    const label = `sources[${index}]`;

    // 근거는 그 자료가 이미 들고 있다. 자리를 맞춰 다시 이어 붙이지 않는다.
    // 그래서 다른 자료의 근거가 섞일 길이 없다.
    const { relevanceNote, ...rest } = entry;
    const source: BiblicalResearchEvidenceSource = {
      ...rest,
      evidenceClaims: entry.evidenceClaims.map((claim) => ({
        evidenceId: claim.evidenceId,
        intendedUse: claim.intendedUse,
        statement: claim.statement,
        passageReferences: claim.passageReferences.map((reference) => ({ ...reference })),
      })),
    };

    if (seenSourceIds.has(source.sourceId)) {
      errors.push(`${label}: 같은 자료가 두 번 있습니다.`);
    }
    seenSourceIds.add(source.sourceId);

    // 최종 검사가 보지 않는 깊이를 여기서 본다. 규칙은 새로 적지 않는다.
    for (const issue of checkVerificationDraftSource(toDraftShape(source, relevanceNote))) {
      errors.push(`${label}: ${issue}`);
    }

    // 번호가 이 자료의 것이고 순서까지 맞는지 다시 본다.
    for (const [claimIndex, claim] of source.evidenceClaims.entries()) {
      const expected = `${source.sourceId}:e${claimIndex + 1}`;
      if (claim.evidenceId !== expected) {
        errors.push(`${label}.evidenceClaims[${claimIndex}]: 번호가 서버가 붙인 것과 다릅니다.`);
      }
      if (seenEvidenceIds.has(claim.evidenceId)) {
        errors.push(`${label}.evidenceClaims[${claimIndex}]: 같은 번호가 두 번 있습니다.`);
      }
      seenEvidenceIds.add(claim.evidenceId);
    }

    sources.push(source);
  }

  if (errors.length > 0) return { ok: false, errors };

  const sourceUnresolvedQuestions = [...harvest.unresolvedSourceQuestions];

  const evidenceSetHash = await computeBiblicalResearchEvidenceSetHash({
    brief,
    sources,
    sourceUnresolvedQuestions,
  });

  return {
    ok: true,
    handoff: { brief, evidenceSetHash, sources, sourceUnresolvedQuestions },
  };
}

/* ------------------------------------------------------------------ */
/* 꾸러미를 다시 확인하기                                                */
/* ------------------------------------------------------------------ */

/**
 * 꾸러미의 최상위 항목. 이 넷뿐이다.
 * 타입 정의와 어긋나면 시험이 잡는다.
 */
export const HANDOFF_FIELDS = [
  'brief',
  'evidenceSetHash',
  'sources',
  'sourceUnresolvedQuestions',
] as const;

/**
 * 꾸러미 안 자료 한 건의 항목.
 *
 * 연구 단계가 쓰는 자료의 항목에 근거만 더한 것이다.
 * 수집 단계 메모(relevanceNote)는 여기 없다. 그 목록을 새로 적지 않는다.
 */
export const HANDOFF_SOURCE_FIELDS = [...RESEARCH_SOURCE_FIELDS, 'evidenceClaims'] as const;

const EVIDENCE_SET_HASH_FORMAT = /^evset_[0-9a-f]{64}$/;

/**
 * 꾸러미에는 수집 단계 메모가 없다.
 *
 * 자료 한 건을 깊이 보는 검사기는 그 메모가 있는 모양을 받는다.
 * 만드는 쪽도 같은 검사기를 쓰려고 메모를 넣어 초안 모양으로 되돌린다.
 * 여기서도 같은 검사기를 쓰기 위해 자리만 채운다.
 *
 * 이 값은 검사에만 쓰이고 꾸러미에 들어가지 않는다. 지문에도 들어가지 않는다.
 * 꾸러미가 메모를 들고 있지 않으므로, 메모에 대한 규칙은 여기서 확인할 수 없다.
 */
const RELEVANCE_NOTE_PLACEHOLDER = '이 자료는 수집 단계에서 이미 확인되었습니다.';

export type HandoffValidationResult =
  | { valid: true; handoff: BiblicalResearchHandoff }
  | { valid: false; errors: string[] };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * 두 의뢰서가 같은지 본다. 항목 하나하나를 견준다.
 * 적힌 순서가 달라도 뜻이 같으면 같다고 본다.
 */
function sameBrief(stored: Record<string, unknown>, rebuilt: BiblicalResearchBrief): boolean {
  if (stored.targetDomain !== rebuilt.targetDomain) return false;
  if (stored.domainDescription !== rebuilt.domainDescription) return false;
  if (stored.evidenceVersion !== rebuilt.evidenceVersion) return false;
  if (stored.prioritizerSnapshotId !== rebuilt.prioritizerSnapshotId) return false;

  const covered = stored.activeCoveredDomains;
  if (!Array.isArray(covered)) return false;
  if (covered.length !== rebuilt.activeCoveredDomains.length) return false;
  return covered.every((domain, index) => domain === rebuilt.activeCoveredDomains[index]);
}

/**
 * 보관해 둔 꾸러미가 정말 그 꾸러미인지 다시 확인한다.
 *
 * 왜 필요한가:
 *   표에서 나왔다는 것만으로 그 값을 꾸러미라고 부르면 아무것도 확인하지 않은 것이다.
 *   표가 망가졌거나, 잘못 적혔거나, 코드가 어긋나 있을 수 있다.
 *
 *   꾸러미가 실제 수집에서 나왔다는 보증은 이 함수가 하지 않는다.
 *   그것은 서버가 만들어 서버가 보관했다는 흐름이 한다.
 *   여기서 하는 일은 그 위에 한 겹 더 두는 것이다.
 *
 * 새 규칙을 만들지 않는다:
 *   의뢰서는 서버가 다시 만들어 견준다. 영역 설명을 부르는 쪽이 바꿀 수 없다.
 *   자료와 근거는 수집 단계의 최종 검사기와 자료 한 건 검사기를 그대로 다시 쓴다.
 *   지문은 만들 때 쓴 그 함수로 다시 계산해서 견준다.
 *
 * 고치지 않는다:
 *   정렬하지 않고, 공백을 다듬지 않고, 빠진 값을 채우지 않는다.
 *   어긋나면 그대로 실패다. 통과하면 받은 그 객체를 그대로 돌려준다.
 *
 * 하지 않는 일:
 *   지금 카드가 다루는 영역과 견주지 않는다. 그 판단은 표가 꺼낼 때 한다.
 *   네트워크, DB, 환경변수를 모른다.
 */
export async function validateBiblicalResearchHandoff(
  value: unknown,
): Promise<HandoffValidationResult> {
  const errors: string[] = [];
  const invalid = (): HandoffValidationResult => ({ valid: false, errors });

  if (!isRecord(value)) return { valid: false, errors: ['꾸러미가 객체가 아닙니다.'] };

  for (const key of Object.keys(value)) {
    if (!(HANDOFF_FIELDS as readonly string[]).includes(key)) {
      errors.push(`허용되지 않는 항목이 있습니다 (${key})`);
    }
  }
  for (const key of HANDOFF_FIELDS) {
    if (!(key in value)) errors.push(`필수 항목이 없습니다 (${key})`);
  }
  if (errors.length > 0) return invalid();

  // 지문의 모양. 값이 맞는지는 뒤에서 다시 계산해서 본다.
  if (
    typeof value.evidenceSetHash !== 'string' ||
    !EVIDENCE_SET_HASH_FORMAT.test(value.evidenceSetHash)
  ) {
    errors.push('꾸러미 지문의 모양이 다릅니다.');
  }

  if (!isRecord(value.brief)) errors.push('의뢰서가 객체가 아닙니다.');
  if (!Array.isArray(value.sources)) errors.push('자료 목록이 배열이 아닙니다.');
  if (
    !Array.isArray(value.sourceUnresolvedQuestions) ||
    !value.sourceUnresolvedQuestions.every((question) => typeof question === 'string')
  ) {
    errors.push('남은 물음이 문자열 목록이 아닙니다.');
  }
  if (errors.length > 0) return invalid();

  const storedBrief = value.brief as Record<string, unknown>;
  const sources = value.sources as unknown[];

  // 자료 한 건의 항목. 수집 단계 메모가 들어 있으면 그 자체로 잘못이다.
  for (const [index, entry] of sources.entries()) {
    if (!isRecord(entry)) {
      errors.push(`sources[${index}]: 객체가 아닙니다.`);
      continue;
    }
    for (const key of Object.keys(entry)) {
      if (!(HANDOFF_SOURCE_FIELDS as readonly string[]).includes(key)) {
        errors.push(`sources[${index}]: 허용되지 않는 항목이 있습니다 (${key})`);
      }
    }
  }
  if (errors.length > 0) return invalid();

  // 의뢰서는 서버가 다시 만든다. 영역 설명을 적어 넣을 수 없다.
  let rebuilt: BiblicalResearchBrief;
  try {
    rebuilt = buildSourceHarvestBrief({
      targetDomain: storedBrief.targetDomain as string,
      evidenceVersion: storedBrief.evidenceVersion as number,
      prioritizerSnapshotId: storedBrief.prioritizerSnapshotId as string,
      // 빠진 값을 빈 목록으로 채우지 않는다. 없으면 없는 대로 넘긴다.
      activeCoveredDomains: storedBrief.activeCoveredDomains as readonly string[],
    });
  } catch {
    // 어떤 값이 잘못됐는지는 밖으로 나누지 않는다.
    errors.push('이 꾸러미의 의뢰서를 다시 만들 수 없습니다.');
    return invalid();
  }

  const briefKeys = Object.keys(storedBrief);
  if (briefKeys.length !== 5) errors.push('의뢰서의 항목 수가 다릅니다.');
  if (!sameBrief(storedBrief, rebuilt)) errors.push('의뢰서가 서버가 만드는 것과 다릅니다.');
  if (errors.length > 0) return invalid();

  // 수집 단계의 최종 검사를 그대로 다시 통과해야 한다.
  //
  // 꾸러미에 없는 두 가지는 자리만 채운다.
  //   수집 단계 메모 — 꾸러미에서 떼어 낸 값이다.
  //   제외 기록      — 꾸러미가 들고 오지 않는다.
  // 둘 다 지문에 들어가지 않으므로, 이 자리 채움이 지문 판정에 영향을 주지 않는다.
  const reconstructed = {
    targetDomain: rebuilt.targetDomain,
    evidenceVersion: rebuilt.evidenceVersion,
    prioritizerSnapshotId: rebuilt.prioritizerSnapshotId,
    sources: sources.map((source) => ({
      ...(source as Record<string, unknown>),
      relevanceNote: RELEVANCE_NOTE_PLACEHOLDER,
    })),
    rejectedSources: [],
    unresolvedSourceQuestions: value.sourceUnresolvedQuestions,
  };

  const checked = await validateSourceHarvestResult(reconstructed, rebuilt);
  if (!checked.valid) {
    // 여기서 멈춘다. 만드는 쪽도 같은 자리에서 멈춘다.
    //
    // 아래 깊은 검사는 자료가 이미 약속된 모양이라고 보고 값을 꺼낸다.
    // 모양부터 어긋난 값을 그대로 내려보내면 검사가 아니라 오류로 끝난다.
    errors.push(...checked.errors);
    return invalid();
  }

  // 최종 검사가 보지 않는 깊이를 여기서 본다. 만드는 쪽과 같은 검사기다.
  //
  // 앞의 검사를 지나왔어도 아직 모양이 어긋난 자리가 남을 수 있다.
  // 본문 위치 목록이 그렇다. 앞의 검사는 그것을 보지 않는다.
  //
  // 그런 값을 꺼내려다 오류가 나면 그 자리에서 실패로 본다.
  // 오류 문구는 옮기지 않는다. 무엇이 들어 있을지 모르기 때문이다.
  for (const [index, source] of sources.entries()) {
    try {
      const draft = toDraftShape(
        source as BiblicalResearchEvidenceSource,
        RELEVANCE_NOTE_PLACEHOLDER,
      );
      for (const issue of checkVerificationDraftSource(draft)) {
        errors.push(`sources[${index}]: ${issue}`);
      }
    } catch {
      errors.push(`sources[${index}]: 자료의 모양이 약속과 다릅니다.`);
    }
  }
  if (errors.length > 0) return invalid();

  // 마지막으로 지문을 다시 계산한다. 적혀 있는 값을 그대로 믿지 않는다.
  const handoff = value as unknown as BiblicalResearchHandoff;
  const recomputed = await computeBiblicalResearchEvidenceSetHash({
    brief: handoff.brief,
    sources: handoff.sources,
    sourceUnresolvedQuestions: handoff.sourceUnresolvedQuestions,
  });

  if (recomputed !== handoff.evidenceSetHash) {
    errors.push('꾸러미의 내용과 지문이 맞지 않습니다.');
    return invalid();
  }

  // 받은 그 객체를 그대로 돌려준다. 새로 만들거나 고치지 않는다.
  return { valid: true, handoff };
}
