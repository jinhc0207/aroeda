/**
 * 연구 근거 자료의 canonical 타입과 권한 규칙
 *
 * 자료 목록을 만드는 쪽(Source Harvester)과 쓰는 쪽(Biblical Researcher)이
 * 같은 정의와 같은 규칙을 보게 하려고 한 곳에 모아 둔다.
 * 양쪽에서 허용 목록을 따로 적지 않는다.
 *
 * 핵심 원칙:
 *   자료마다 할 수 있는 역할이 다르다.
 *   의료·법률·재정·상담 자료는 현실의 안전과 전문적 도움의 경계를 확인하는 자료이지
 *   성경 해석이나 신학적 주장의 근거가 아니다.
 *   목회 보조자료도 성경 주해의 핵심 근거를 대신할 수 없다.
 *   그리고 이 경계는 자료를 모으는 단계에서 끝나지 않고 연구 단계까지 그대로 이어져야 한다.
 *
 * 이 파일에는 웹페이지 내용, 인용문, 검색 요약을 담을 자리가 없다.
 */

/**
 * 자료의 종류.
 *
 * bible_primary는 성경 본문 자체를 가리킬 때만 쓴다.
 * (성경은 웹에서 수집하지 않는다. 검증된 개역한글 데이터에서 온다.)
 */
export const SOURCE_TYPES = [
  'bible_primary',
  'commentary',
  'biblical_theology',
  'systematic_theology',
  'academic_article',
  'scholarly_institution',
  'pastoral_resource',
  'professional_context',
] as const;
export type SourceType = (typeof SOURCE_TYPES)[number];

/**
 * Source Harvester가 웹에서 수집할 수 있는 자료 종류.
 * bible_primary는 여기에 없다.
 */
export const HARVESTABLE_SOURCE_TYPES = [
  'commentary',
  'biblical_theology',
  'systematic_theology',
  'academic_article',
  'scholarly_institution',
  'pastoral_resource',
  'professional_context',
] as const;
export type HarvestableSourceType = (typeof HARVESTABLE_SOURCE_TYPES)[number];

/**
 * 학술적 핵심 자료.
 * pastoral_resource와 professional_context는 여기에 포함하지 않는다.
 */
export const SCHOLARLY_CORE_TYPES = [
  'commentary',
  'biblical_theology',
  'systematic_theology',
  'academic_article',
  'scholarly_institution',
] as const;

/** 이 자료를 무엇에 쓸 것인가 */
export const INTENDED_USES = [
  'exegesis',
  'biblical_theology',
  'doctrinal_context',
  'pastoral_application',
  'pastoral_safety',
  'real_world_context',
] as const;
export type IntendedUse = (typeof INTENDED_USES)[number];

/**
 * 내용을 어디까지 실제로 확인했는가.
 * metadata_only는 여기에 없다. 내용을 확인하지 못한 자료는 근거가 아니라 단서일 뿐이다.
 */
export const ACCESS_LEVELS = ['full_text', 'substantial_preview', 'abstract_only'] as const;
export type AccessLevel = (typeof ACCESS_LEVELS)[number];

/**
 * 본문의 세부 내용을 근거로 삼을 수 있는 확인 수준.
 * 초록만 본 자료로 본문의 세부 주장을 만들지 않는다.
 */
export const DEEP_ACCESS_LEVELS: readonly AccessLevel[] = ['full_text', 'substantial_preview'];

/**
 * 자료 종류별로 허용되는 용도. 이 표가 유일한 기준이다.
 *
 * 여기에 없는 종류(bible_primary 등)는 어떤 용도로도 허용되지 않는다(fail-closed).
 */
export const ALLOWED_INTENDED_USES: Readonly<Record<HarvestableSourceType, readonly IntendedUse[]>> = {
  commentary: ['exegesis', 'biblical_theology', 'doctrinal_context', 'pastoral_application'],
  biblical_theology: ['exegesis', 'biblical_theology', 'doctrinal_context', 'pastoral_application'],
  systematic_theology: ['biblical_theology', 'doctrinal_context', 'pastoral_application'],
  academic_article: [
    'exegesis',
    'biblical_theology',
    'doctrinal_context',
    'pastoral_application',
    'real_world_context',
  ],
  scholarly_institution: [
    'exegesis',
    'biblical_theology',
    'doctrinal_context',
    'pastoral_application',
    'real_world_context',
  ],
  pastoral_resource: ['pastoral_application', 'pastoral_safety'],
  professional_context: ['pastoral_safety', 'real_world_context'],
};

/** 이 종류의 자료를 이 용도로 쓸 수 있는가. Harvester와 Researcher가 같은 이 함수를 쓴다. */
export function isSourceTypeAllowedForUse(sourceType: unknown, use: unknown): boolean {
  if (typeof sourceType !== 'string' || typeof use !== 'string') return false;
  const allowed = (ALLOWED_INTENDED_USES as Record<string, readonly string[]>)[sourceType];
  if (!allowed) return false;
  return allowed.includes(use);
}

/**
 * 후보 본문이 어떤 주장을 어떤 자료에 기대고 있는가.
 *
 * exegesis  → 본문 자체의 문맥과 주해
 * theology  → 성경 전체의 흐름과 교리적 자리
 * pastoral  → 목회적 적용
 * safety    → 현실의 안전과 전문적 도움의 경계
 */
export const SUPPORT_ROLES = ['exegesis', 'theology', 'pastoral', 'safety'] as const;
export type SupportRole = (typeof SUPPORT_ROLES)[number];

export type SupportRoleRule = {
  /** 이 중 하나가 자료의 intendedUse에 있어야 한다. */
  requiredUses: readonly IntendedUse[];
  /** 후보 본문마다 최소 몇 개의 자료가 필요한가 */
  minSources: number;
  /** 초록만 확인한 자료를 쓸 수 없는 역할인가 */
  requiresDeepAccess: boolean;
};

/**
 * 역할별 규칙.
 *
 * 후보 본문은 목회 자료나 전문 분야 자료만으로 세워질 수 없다.
 * 그래서 exegesis와 theology는 최소 1개씩 반드시 필요하다.
 */
export const SUPPORT_ROLE_RULES: Readonly<Record<SupportRole, SupportRoleRule>> = {
  exegesis: { requiredUses: ['exegesis'], minSources: 1, requiresDeepAccess: true },
  theology: {
    requiredUses: ['biblical_theology', 'doctrinal_context'],
    minSources: 1,
    requiresDeepAccess: true,
  },
  pastoral: { requiredUses: ['pastoral_application'], minSources: 0, requiresDeepAccess: false },
  safety: {
    requiredUses: ['pastoral_safety', 'real_world_context'],
    minSources: 0,
    requiresDeepAccess: false,
  },
};

/** 연구 근거로 참조하는 자료 한 건. Source Harvester가 만들고, Biblical Researcher는 가리키기만 한다. */
export type ResearchSource = {
  sourceId: string;
  sourceType: SourceType;
  title: string;
  authorOrOrganization: string;
  publisherOrInstitution: string;
  /** 확인하지 못하면 null */
  publicationYear: number | null;
  url: string;
  accessedAt: string;
  accessLevel: AccessLevel;
  intendedUse: IntendedUse[];
};

export const RESEARCH_SOURCE_FIELDS = [
  'sourceId',
  'sourceType',
  'title',
  'authorOrOrganization',
  'publisherOrInstitution',
  'publicationYear',
  'url',
  'accessedAt',
  'accessLevel',
  'intendedUse',
] as const;

/**
 * 이 자료를 이 역할의 근거로 쓸 수 있는가.
 *
 * 세 가지를 모두 만족해야 한다.
 *   1. 자료의 intendedUse에 그 역할에 맞는 용도가 있다.
 *   2. 자료의 종류가 그 용도를 허용한다.
 *   3. 확인 수준이 그 역할에 충분하다.
 *
 * 이 함수가 Harvester에서 세운 권한 경계를 연구 단계까지 그대로 옮긴다.
 */
export function isSourceAllowedForRole(source: ResearchSource, role: SupportRole): boolean {
  const rule = SUPPORT_ROLE_RULES[role];
  if (!rule) return false;

  if (!Array.isArray(source?.intendedUse)) return false;

  const matched = rule.requiredUses.filter(
    (use) => source.intendedUse.includes(use) && isSourceTypeAllowedForUse(source.sourceType, use),
  );
  if (matched.length === 0) return false;

  if (rule.requiresDeepAccess && !DEEP_ACCESS_LEVELS.includes(source.accessLevel)) {
    return false;
  }

  return true;
}
