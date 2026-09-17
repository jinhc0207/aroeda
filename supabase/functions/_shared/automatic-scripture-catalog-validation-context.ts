/** Automatic Scripture Catalog 검증 실행에 필요한 읽기 전용 DB context 계약. */

import {
  CATALOG_VERSION_HASH_FORMAT,
  type DemandBinding,
  type ScriptureCatalogSnapshot,
  computeCatalogVersionHash,
  validateCatalogSnapshot,
} from './automatic-scripture-catalog-contract.ts';
import {
  MAX_DEMAND_WINDOW_DAYS,
  type DemandCell,
  demandSubjectKey,
  enumerateDemandWindow,
} from './automatic-scripture-catalog-activation-contract.ts';

export const GET_SCRIPTURE_CATALOG_VALIDATION_CONTEXT_RPC =
  'get_scripture_catalog_validation_context';

export const VALIDATION_CONTEXT_RESPONSE_FIELDS = [
  'activeVersionHash',
  'pointerRevision',
  'baseCatalog',
  'demandCells',
] as const;

export const VALIDATION_CONTEXT_DEMAND_CELL_FIELDS = [
  'evidenceKind',
  'subjectKey',
  'bucketDate',
  'count',
] as const;

export type ValidationContextWindow = {
  windowStartDate: string;
  windowEndDate: string;
};

export type ScriptureCatalogValidationContext = {
  activeVersionHash: string;
  pointerRevision: number;
  baseCatalog: ScriptureCatalogSnapshot;
  demandCells: DemandCell[];
};

export type ValidationContextRpcSpec = {
  functionName: typeof GET_SCRIPTURE_CATALOG_VALIDATION_CONTEXT_RPC;
  params: {
    p_evidence_kind: DemandBinding['kind'];
    p_subject_key: string;
    p_window_start_date: string;
    p_window_end_date: string;
  };
};

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const hasExactFields = (value: Record<string, unknown>, fields: readonly string[]): boolean =>
  Object.keys(value).length === fields.length && fields.every((field) => Object.hasOwn(value, field));

/** 사용자 원문 없이 후보의 수요 연결과 날짜 범위만 RPC 입력으로 만든다. */
export function buildValidationContextRpcSpec(
  binding: DemandBinding,
  window: ValidationContextWindow,
): ValidationContextRpcSpec | null {
  const dates = enumerateDemandWindow(window.windowStartDate, window.windowEndDate);
  if (!dates || dates.length > MAX_DEMAND_WINDOW_DAYS) return null;
  return {
    functionName: GET_SCRIPTURE_CATALOG_VALIDATION_CONTEXT_RPC,
    params: {
      p_evidence_kind: binding.kind,
      p_subject_key: demandSubjectKey(binding),
      p_window_start_date: window.windowStartDate,
      p_window_end_date: window.windowEndDate,
    },
  };
}

/**
 * RPC 응답을 실행기 입력으로 읽는다. DB가 준 version hash도 카탈로그 내용에서 다시 계산한다.
 * 잘못된 응답의 상세값은 밖으로 돌려주지 않는다.
 */
export async function parseValidationContextRpcResponse(
  value: unknown,
  binding: DemandBinding,
  window: ValidationContextWindow,
): Promise<{ ok: true; context: ScriptureCatalogValidationContext } | { ok: false }> {
  try {
    const dates = enumerateDemandWindow(window.windowStartDate, window.windowEndDate);
    if (!dates || !isPlainObject(value) || !hasExactFields(value, VALIDATION_CONTEXT_RESPONSE_FIELDS)) {
      return { ok: false };
    }
    if (
      typeof value.activeVersionHash !== 'string' ||
      !CATALOG_VERSION_HASH_FORMAT.test(value.activeVersionHash) ||
      !Number.isSafeInteger(value.pointerRevision) ||
      (value.pointerRevision as number) <= 0
    ) {
      return { ok: false };
    }

    const catalogCheck = validateCatalogSnapshot(value.baseCatalog);
    if (!catalogCheck.valid) return { ok: false };
    const baseCatalog = value.baseCatalog as ScriptureCatalogSnapshot;
    if ((await computeCatalogVersionHash(baseCatalog)) !== value.activeVersionHash) return { ok: false };
    if (!Array.isArray(value.demandCells)) return { ok: false };

    const subjectKey = demandSubjectKey(binding);
    const allowedDates = new Set(dates);
    let previousDate: string | null = null;
    const demandCells: DemandCell[] = [];
    for (const item of value.demandCells) {
      if (!isPlainObject(item) || !hasExactFields(item, VALIDATION_CONTEXT_DEMAND_CELL_FIELDS)) {
        return { ok: false };
      }
      if (
        item.evidenceKind !== binding.kind ||
        item.subjectKey !== subjectKey ||
        typeof item.bucketDate !== 'string' ||
        !allowedDates.has(item.bucketDate) ||
        (previousDate !== null && item.bucketDate <= previousDate) ||
        !Number.isSafeInteger(item.count) ||
        (item.count as number) <= 0
      ) {
        return { ok: false };
      }
      previousDate = item.bucketDate;
      demandCells.push({
        evidenceKind: binding.kind,
        subjectKey: item.subjectKey,
        bucketDate: item.bucketDate,
        count: item.count as number,
      });
    }

    return {
      ok: true,
      context: {
        activeVersionHash: value.activeVersionHash,
        pointerRevision: value.pointerRevision as number,
        baseCatalog: structuredClone(baseCatalog),
        demandCells,
      },
    };
  } catch {
    return { ok: false };
  }
}

export const VALIDATION_CONTEXT_PRIVACY_POLICY = {
  acceptsUserText: false,
  returnsUserText: false,
  returnsUserId: false,
  returnsDeviceId: false,
  returnsIpAddress: false,
  returnsCredential: false,
  readOnly: true,
} as const;
