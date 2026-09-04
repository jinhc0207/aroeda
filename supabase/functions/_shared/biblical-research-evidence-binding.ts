/**
 * 연구 결과를 실제 근거에 묶기 (순수 로직)
 *
 * 왜 필요한가:
 *   "이 자료를 참고했다"만으로는 무엇을 근거로 삼았는지 알 수 없다.
 *   자료의 어느 관찰(evidence)을 보고 그 후보를 세웠는지가 남아야
 *   나중에 그 판단을 되짚을 수 있다.
 *
 * 누가 무엇을 정하는가:
 *   모델 — 어떤 근거를 썼는가 (evidenceId)
 *   서버 — 그 근거가 어느 자료의 것인가 (sourceId), 그리고 꾸러미 지문
 *
 *   모델이 자료 id를 직접 고르지 않으므로 근거와 자료가 어긋날 길이 없다.
 *
 * 이 파일이 하는 일:
 *   확인한다 → 근거의 주인을 찾는다 → 자료 id를 뽑는다 → 지문을 붙인다.
 *
 * 이 파일이 하지 않는 일:
 *   네트워크, DB, 환경변수, OpenAI 호출.
 *   새 자료를 찾지 않는다. 꾸러미에 없는 근거는 쓸 수 없다.
 *   후보의 글도, 근거 문장도 고치지 않는다.
 *   새 검증 규칙을 만들지 않는다. 이미 있는 것을 다시 쓴다.
 */

import {
  DRAFT_TOP_LEVEL_FIELDS,
  SUPPORT_DRAFT_FIELDS,
  SUPPORT_EVIDENCE_FIELD,
  SUPPORT_ROLE_EVIDENCE_USES,
  validateBiblicalResearchResult,
  type BiblicalResearchDraftResult,
  type BiblicalResearchResult,
  type CandidatePassage,
  type SourceSupport,
  type ValidationResult,
} from './biblical-researcher.ts';
import { SUPPORT_ROLES, type SupportRole } from './research-source.ts';
import { referencesOverlap } from './bible-reference.ts';
import type {
  BiblicalResearchEvidenceSource,
  BiblicalResearchHandoff,
} from './biblical-research-handoff.ts';

export type BindingResult =
  | { ok: true; result: BiblicalResearchResult }
  | { ok: false; errors: string[] };

/** 근거 번호 하나가 가리키는 것. 자료와 그 안의 근거 한 조각이다. */
type EvidenceOwner = {
  source: BiblicalResearchEvidenceSource;
  intendedUse: string;
  passageReferences: readonly { book: string; chapter: number; startVerse: number; endVerse: number }[];
};

/**
 * 꾸러미에서 근거 번호로 주인을 찾을 수 있는 표를 만든다.
 *
 * 번호 문자열을 잘라 자료 id를 짐작하지 않는다.
 * 실제로 그 자료가 들고 있는 근거만 표에 들어간다.
 *
 * 앞 단계가 이미 확인한 것이라도 여기서 다시 본다.
 * 같은 번호가 두 자료에 있으면 나중 것이 앞 것을 조용히 덮어쓰게 되고,
 * 그러면 근거의 주인이 바뀐 채로 통과한다. 그런 일이 없게 한다.
 *
 * 앞 단계의 깊은 검사를 여기서 다시 적지는 않는다. 주인 관계만 본다.
 */
function buildEvidenceIndex(
  handoff: BiblicalResearchHandoff,
): { ok: true; index: Map<string, EvidenceOwner> } | { ok: false; errors: string[] } {
  const index = new Map<string, EvidenceOwner>();
  const errors: string[] = [];
  const seenSourceIds = new Set<string>();

  for (const source of handoff.sources) {
    if (seenSourceIds.has(source.sourceId)) {
      errors.push(`근거 꾸러미에 같은 자료가 두 번 있습니다 (${source.sourceId})`);
    }
    seenSourceIds.add(source.sourceId);

    for (const [claimIndex, claim] of source.evidenceClaims.entries()) {
      // 번호가 그 자료의 것이고 순서까지 맞아야 한다.
      const expected = `${source.sourceId}:e${claimIndex + 1}`;
      if (claim.evidenceId !== expected) {
        errors.push(`근거 꾸러미의 번호가 서버가 붙인 것과 다릅니다 (${claim.evidenceId})`);
        continue;
      }

      // 덮어쓰지 않는다. 겹치면 그 자리에서 실패로 본다.
      if (index.has(claim.evidenceId)) {
        errors.push(`근거 꾸러미에 같은 번호가 두 번 있습니다 (${claim.evidenceId})`);
        continue;
      }

      index.set(claim.evidenceId, {
        source,
        intendedUse: claim.intendedUse,
        passageReferences: claim.passageReferences,
      });
    }
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, index };
}

/** 후보가 다루는 본문 위치 전부. 대표 위치와 이어지는 위치를 함께 본다. */
function candidateReferences(candidate: { reference: unknown; additionalReferences: unknown }): unknown[] {
  const extra = Array.isArray(candidate.additionalReferences) ? candidate.additionalReferences : [];
  return [candidate.reference, ...extra];
}

/**
 * 연구 결과 초안을 실제 근거에 묶어 최종 결과로 만든다.
 *
 * 하나라도 어긋나면 만들지 않는다. 일부만 묶지 않는다.
 */
export function bindBiblicalResearchEvidence(input: {
  draft: BiblicalResearchDraftResult;
  handoff: BiblicalResearchHandoff;
}): BindingResult {
  const { draft, handoff } = input;

  if (typeof draft !== 'object' || draft === null || Array.isArray(draft)) {
    return { ok: false, errors: ['연구 결과가 객체가 아닙니다.'] };
  }

  const errors: string[] = [];

  // 0. 초안에 서버가 붙일 값이 미리 들어 있으면 그대로 거절한다.
  //    조용히 덮어쓰지 않는다. 덮어쓰면 무엇이 잘못됐는지 아무도 모르게 된다.
  for (const key of Object.keys(draft as Record<string, unknown>)) {
    if (!(DRAFT_TOP_LEVEL_FIELDS as readonly string[]).includes(key)) {
      errors.push(`초안에 있을 수 없는 항목이 있습니다 (${key})`);
    }
  }
  if (errors.length > 0) return { ok: false, errors };

  // 1. 의뢰서와 같은 연구인가.
  if (draft.targetDomain !== handoff.brief.targetDomain) {
    errors.push('연구 영역이 근거 꾸러미와 다릅니다.');
  }
  if (draft.evidenceVersion !== handoff.brief.evidenceVersion) {
    errors.push('근거 판본이 근거 꾸러미와 다릅니다.');
  }
  if (draft.prioritizerSnapshotId !== handoff.brief.prioritizerSnapshotId) {
    errors.push('판단 시점이 근거 꾸러미와 다릅니다.');
  }
  if (errors.length > 0) return { ok: false, errors };

  if (!Array.isArray(draft.candidatePassages)) {
    return { ok: false, errors: ['후보 목록이 배열이 아닙니다.'] };
  }

  // 꾸러미 자체의 주인 관계가 온전한지 먼저 본다.
  const built = buildEvidenceIndex(handoff);
  if (!built.ok) return { ok: false, errors: built.errors };

  const index = built.index;
  const candidates: CandidatePassage[] = [];

  for (const [position, candidate] of draft.candidatePassages.entries()) {
    const label = `candidatePassages[${position}]`;

    if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) {
      errors.push(`${label}: 후보가 객체가 아닙니다.`);
      continue;
    }

    const support = candidate.sourceSupport;
    if (typeof support !== 'object' || support === null || Array.isArray(support)) {
      errors.push(`${label}: sourceSupport가 객체가 아닙니다.`);
      continue;
    }

    for (const key of Object.keys(support as Record<string, unknown>)) {
      if (!(SUPPORT_DRAFT_FIELDS as readonly string[]).includes(key)) {
        // 자료 id는 서버가 뽑는다. 초안에 있으면 그 자체로 잘못이다.
        errors.push(`${label}: sourceSupport에 있을 수 없는 항목이 있습니다 (${key})`);
      }
    }

    const bound: Record<string, string[]> = {};
    // 한 후보 안에서 같은 근거를 두 역할에 나누어 쓰지 않는다.
    const usedInCandidate = new Set<string>();
    let candidateFailed = false;

    for (const role of SUPPORT_ROLES) {
      const evidenceField = SUPPORT_EVIDENCE_FIELD[role];
      const raw = (support as Record<string, unknown>)[evidenceField];

      if (!Array.isArray(raw) || raw.some((id) => typeof id !== 'string')) {
        errors.push(`${label}: ${evidenceField}가 문자열 목록이 아닙니다.`);
        candidateFailed = true;
        continue;
      }

      const evidenceIds = raw as string[];
      if (new Set(evidenceIds).size !== evidenceIds.length) {
        errors.push(`${label}: ${evidenceField}에 같은 근거가 두 번 들어 있습니다.`);
        candidateFailed = true;
      }

      const sourceIds = new Set<string>();

      for (const evidenceId of evidenceIds) {
        if (usedInCandidate.has(evidenceId)) {
          errors.push(`${label}: 같은 근거를 여러 역할에 썼습니다 (${evidenceId})`);
          candidateFailed = true;
        }
        usedInCandidate.add(evidenceId);

        // 번호의 주인은 표에서만 찾는다. 문자열을 잘라 짐작하지 않는다.
        const owner = index.get(evidenceId);
        if (!owner) {
          errors.push(`${label}: 꾸러미에 없는 근거를 가리킵니다 (${evidenceId})`);
          candidateFailed = true;
          continue;
        }

        // 역할이 받을 수 있는 용도인가. 목록은 research-source.ts의 것을 그대로 쓴다.
        if (!SUPPORT_ROLE_EVIDENCE_USES[role].includes(owner.intendedUse)) {
          errors.push(`${label}: ${owner.intendedUse} 근거를 ${evidenceField}에 쓸 수 없습니다 (${evidenceId})`);
          candidateFailed = true;
          continue;
        }

        // 주해 근거는 그 후보가 다루는 본문을 실제로 다루어야 한다.
        if (role === 'exegesis') {
          const touches = owner.passageReferences.some((reference) =>
            candidateReferences(candidate).some((candidateRef) =>
              referencesOverlap(reference, candidateRef),
            ),
          );
          if (!touches) {
            errors.push(`${label}: 이 후보 본문을 다루지 않는 주해 근거입니다 (${evidenceId})`);
            candidateFailed = true;
            continue;
          }
        }

        sourceIds.add(owner.source.sourceId);
      }

      bound[evidenceField] = [...evidenceIds];
      // 자료 id는 근거의 주인에서만 나온다. 같은 자료는 한 번만 둔다.
      bound[roleSourceField(role)] = [...sourceIds].sort();
    }

    if (candidateFailed) continue;

    candidates.push({
      ...candidate,
      sourceSupport: bound as unknown as SourceSupport,
    } as CandidatePassage);
  }

  if (errors.length > 0) return { ok: false, errors };

  const result: BiblicalResearchResult = {
    targetDomain: draft.targetDomain,
    evidenceVersion: draft.evidenceVersion,
    prioritizerSnapshotId: draft.prioritizerSnapshotId,
    researchQuestion: draft.researchQuestion,
    domainBoundaries: draft.domainBoundaries,
    candidatePassages: candidates,
    rejectedPassages: draft.rejectedPassages,
    unresolvedQuestions: draft.unresolvedQuestions,
    // 지문은 꾸러미의 것을 그대로 쓴다. 모델이 정할 수 없다.
    evidenceSetHash: handoff.evidenceSetHash,
  };

  // 마지막으로 기존 검사를 그대로 통과해야 한다.
  // 자료의 종류·확인 수준 정책은 여기서 다시 적지 않고 그 검사가 본다.
  const checked = validateBiblicalResearchResult(result, handoff.brief, handoff.sources);
  if (!checked.valid) return { ok: false, errors: checked.errors };

  return { ok: true, result };
}

const ROLE_SOURCE_FIELD: Readonly<Record<SupportRole, string>> = {
  exegesis: 'exegesisSourceIds',
  theology: 'theologySourceIds',
  pastoral: 'pastoralSourceIds',
  safety: 'safetySourceIds',
};

function roleSourceField(role: SupportRole): string {
  return ROLE_SOURCE_FIELD[role];
}

/**
 * 최종 결과가 이 꾸러미에서 나온 것인지 다시 본다.
 *
 * 지문만 보지 않는다. 어느 연구였는지도 함께 본다.
 * 지문이 같아도 영역·근거 판본·판단 시점이 다르면 같은 연구가 아니다.
 *
 * 여기서 지문을 새로 계산하지 않는다. 꾸러미가 들고 있는 값을 그대로 견준다.
 */
export function matchesEvidenceSet(
  result: BiblicalResearchResult,
  handoff: BiblicalResearchHandoff,
): ValidationResult {
  const errors: string[] = [];

  if (result.targetDomain !== handoff.brief.targetDomain) {
    errors.push('연구 영역이 근거 꾸러미와 다릅니다.');
  }
  if (result.evidenceVersion !== handoff.brief.evidenceVersion) {
    errors.push('근거 판본이 근거 꾸러미와 다릅니다.');
  }
  if (result.prioritizerSnapshotId !== handoff.brief.prioritizerSnapshotId) {
    errors.push('판단 시점이 근거 꾸러미와 다릅니다.');
  }
  if (result.evidenceSetHash !== handoff.evidenceSetHash) {
    errors.push('이 연구 결과는 그 근거 꾸러미에서 나온 것이 아닙니다.');
  }

  return { valid: errors.length === 0, errors };
}
