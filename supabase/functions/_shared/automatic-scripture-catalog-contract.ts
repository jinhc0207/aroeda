/**
 * 자동 Scripture Catalog 계약 — 버전형 영역·카드 목록과 자동 후보의 모양
 *
 * 무엇을 위한 것인가
 *   지금 카드와 영역은 Git 안의 정적 파일(scripture-cards.ts, situation-domains.ts)에 있다.
 *   이 계약은 사람의 사전 승인 없이도, 철저한 자동 검증을 통과한 후보만
 *   "버전이 붙은 서버 카탈로그"로 올릴 수 있게 하는 기반이다.
 *
 *     정적 카드 → 기준 카탈로그(baseline) → 자동 후보 → 자동 검증 기록 → 활성 버전 전환
 *
 *   이 파일은 그중 "카탈로그 한 판"과 "후보 한 건"의 모양, 결정적 지문, 성경 표기, 수요 연결 방식을 정한다.
 *   검증 기록·validator profile·attestation·활성화·롤백은 automatic-scripture-catalog-activation-contract.ts 의 몫이다.
 *
 * 사람 검토 경계와의 관계
 *   published-content-contract.ts 의 "사람만 승인할 수 있다" 경계를 완화하지 않는다.
 *   이 경로는 그것과 다른 표·다른 함수·다른 authority를 쓴다. 게시 콘텐츠를 만들지 않는다.
 *   크기 한도 숫자만 그대로 가져다 쓴다(현재 카드 51장이 모두 그 한도 안에 들어간다).
 *
 * 자동 카탈로그가 바꿀 수 없는 것
 *   안전 규칙, 개인정보 정책, OpenAI 모델, 사용량 한도. 그런 키가 어느 깊이에 있어도 거절한다.
 *
 * 이 파일이 하지 않는 일
 *   카드를 만들지 않는다. 저장하지 않는다. 바깥을 부르지 않는다.
 *   추천 런타임은 아직 이 카탈로그를 읽지 않는다.
 */

import { isValidBibleReference } from './bible-reference.ts';
import {
  KOREAN_BIBLE_BOOK_NAMES,
  REFERENCE_RANGE_DASH,
  formatKoreanBibleReferenceSequence,
  koreanBibleBookName,
} from './bible-reference-label.ts';
import {
  MISUSE_GUARD_LIST_MAX,
  MISUSE_GUARD_TEXT_MAX,
  PROSE_MAX,
  REFERENCE_LABEL_MAX,
  TAG_LIST_MAX,
  TAG_TEXT_MAX,
} from './published-content-contract.ts';
import { RESEARCH_RESULT_HASH_FORMAT } from './research-result-store-contract.ts';
import type { ScriptureCard } from './scripture-cards.ts';
import { FALLBACK_DOMAIN } from './situation-domains.ts';

/* ------------------------------------------------------------------ */
/* 이름과 모양                                                          */
/* ------------------------------------------------------------------ */

export const CATALOG_CONTRACT_VERSION = 'scripture-catalog/v1';
export const CANDIDATE_CONTRACT_VERSION = 'scripture-catalog-candidate/v1';
export const DEMAND_THEME_CONTRACT_VERSION = 'scripture-demand-theme/v1';

export const CANDIDATE_KINDS = ['existing_domain_card', 'new_domain_with_cards'] as const;
export type CandidateKind = (typeof CANDIDATE_KINDS)[number];

export const CATALOG_VERSION_HASH_FORMAT = /^scat_[0-9a-f]{64}$/;
export const CATALOG_CANDIDATE_HASH_FORMAT = /^sccand_[0-9a-f]{64}$/;
export const ARTIFACT_HASH_FORMAT = /^sart_[0-9a-f]{64}$/;
export const THEME_FINGERPRINT_FORMAT = /^sthm_[0-9a-f]{64}$/;

export const DOMAIN_ID_FORMAT = /^[a-z][a-z0-9_]{2,47}$/;
export const CARD_ID_FORMAT = /^SC-[0-9]{3,5}$/;
/** 비식별 정규화 주제 이름. 사용자 문장이 아니라 분류기가 정한 짧은 영문 slug다. */
export const THEME_KEY_FORMAT = /^[a-z][a-z0-9_]{2,47}$/;

/**
 * 사용자에게 보이는 영역 이름. 한글 낱말과 한 칸 띄어쓰기만 허용한다.
 * 영문·숫자·밑줄이 들어갈 자리가 없으므로 내부 domain id가 화면에 새어 나갈 수 없다.
 * 현재 앱의 17개 이름(src/data/domain-labels.ts)이 모두 이 규칙 안에 들어간다.
 */
export const DOMAIN_DISPLAY_NAME_FORMAT = /^[가-힣]+(?: [가-힣]+)*$/;
export const DOMAIN_DISPLAY_NAME_MIN = 2;
export const DOMAIN_DISPLAY_NAME_MAX = 24;

export const DOMAIN_DESCRIPTION_MAX = 120;
export const MAX_PASSAGES_PER_CARD = 3;
export const MAX_CARDS_PER_CANDIDATE = 5;
/** 새 영역은 기존 17개 영역처럼 최소 3장으로 시작한다. */
export const MIN_CARDS_FOR_NEW_DOMAIN = 3;
export const GENERATION_TEXT_MAX = 100;

export type CatalogPassage = {
  book: string;
  chapter: number;
  startVerse: number;
  endVerse: number;
};

export type CatalogDomain = {
  id: string;
  /** 사용자 화면에 보이는 한국어 이름. 카탈로그 지문에 포함된다. */
  displayName: string;
  /** 개발자용 설명. 화면에 쓰지 않는다. */
  description: string;
};

export const CATALOG_TAG_FIELDS = [
  'situationTags',
  'emotionTags',
  'spiritualQuestionTags',
  'prayerModes',
  'pastoralFunction',
] as const;

/**
 * 새 카드가 새 값을 들여올 수 없는 태그 차원.
 * 이 넷의 사전은 Analyzer 지시문에 그대로 들어간다. 자동 카드가 사전을 늘리면
 * Analyzer 계약이 사람 확인 없이 바뀌므로 기준 카탈로그에 있던 값만 허용한다.
 */
export const CLOSED_VOCABULARY_TAG_FIELDS = [
  'emotionTags',
  'spiritualQuestionTags',
  'prayerModes',
  'pastoralFunction',
] as const;

export const CATALOG_PROSE_FIELDS = [
  'contextSummary',
  'theologicalInsight',
  'userExplanation',
  'prayerDirection',
] as const;

export type CatalogCard = {
  id: string;
  domainId: string;
  /** passages에서 formatCatalogReferenceLabel로 계산한 값과 글자 하나까지 같아야 한다. */
  referenceLabel: string;
  passages: CatalogPassage[];
  situationTags: string[];
  emotionTags: string[];
  spiritualQuestionTags: string[];
  prayerModes: string[];
  pastoralFunction: string[];
  contextSummary: string;
  theologicalInsight: string;
  userExplanation: string;
  prayerDirection: string;
  misuseGuards: string[];
};

export const CATALOG_DOMAIN_FIELDS = ['id', 'displayName', 'description'] as const;
export const CATALOG_CARD_FIELDS = [
  'id',
  'domainId',
  'referenceLabel',
  'passages',
  ...CATALOG_TAG_FIELDS,
  ...CATALOG_PROSE_FIELDS,
  'misuseGuards',
] as const;
export const CATALOG_SNAPSHOT_FIELDS = ['contractVersion', 'domains', 'cards'] as const;

/**
 * 카탈로그 한 판.
 * 영역과 카드는 id 오름차순이어야 한다. 같은 내용이 서로 다른 지문을 갖지 않게 하기 위해서다.
 */
export type ScriptureCatalogSnapshot = {
  contractVersion: typeof CATALOG_CONTRACT_VERSION;
  domains: CatalogDomain[];
  cards: CatalogCard[];
};

export type CandidateGeneration = {
  method: 'automated';
  modelId: string;
  promptVersion: string;
};

/**
 * 후보가 어떤 수요 집계에 묶이는지. 후보 지문에 포함되므로 나중에 바꿀 수 없다.
 *   weak_match       : 이미 있는 영역에서 약하게만 맞은 추천의 날짜별 횟수. 대상 영역 id에 묶인다.
 *   normalized_theme : 분류 밖 요청을 비식별 정규화 주제로 센 날짜별 횟수. 주제 지문에 묶인다.
 * other_uncovered 전체 합계처럼 특정 영역·주제를 가리키지 않는 수는 어떤 후보의 수요도 될 수 없다.
 */
export const DEMAND_BINDING_KINDS = ['weak_match', 'normalized_theme'] as const;
export type DemandBindingKind = (typeof DEMAND_BINDING_KINDS)[number];
export type DemandBinding =
  | { kind: 'weak_match'; domainId: string }
  | { kind: 'normalized_theme'; themeKey: string; themeFingerprint: string };

export const CANDIDATE_FIELDS = [
  'contractVersion',
  'candidateKind',
  'baseVersionHash',
  'proposedVersionHash',
  'targetDomainId',
  'newDomain',
  'cards',
  'demandBinding',
  'sourceResearchResultHash',
  'generation',
] as const;
export const CANDIDATE_GENERATION_FIELDS = ['method', 'modelId', 'promptVersion'] as const;

/** 자동 후보 한 건. 한 번 적히면 고치지 않는다. 고치면 새 지문의 새 후보다. */
export type ScriptureCatalogCandidate = {
  contractVersion: typeof CANDIDATE_CONTRACT_VERSION;
  candidateKind: CandidateKind;
  /** 이 후보가 딛고 선 카탈로그. 활성화 순간에도 이것이 현재 활성 버전이어야 한다. */
  baseVersionHash: string;
  /** base에 이 후보를 합친 결과 카탈로그의 지문. */
  proposedVersionHash: string;
  targetDomainId: string;
  /** new_domain_with_cards일 때만 있다. 그 밖에는 null. */
  newDomain: CatalogDomain | null;
  cards: CatalogCard[];
  demandBinding: DemandBinding;
  /** 반드시 있어야 한다. 저장소에서 실제 research_result 한 건에 묶인다. */
  sourceResearchResultHash: string;
  generation: CandidateGeneration;
};

/* ------------------------------------------------------------------ */
/* 바꿀 수 없는 설정 · 개인정보                                          */
/* ------------------------------------------------------------------ */

/** 자동 카탈로그가 어떤 깊이에서도 담을 수 없는 운영 설정 키 (대소문자 무시, 정확한 이름). */
export const PROTECTED_CONFIGURATION_KEYS = [
  'safety',
  'safetyRules',
  'safetyCategories',
  'safetyLevel',
  'privacy',
  'privacyPolicy',
  'model',
  'openaiModel',
  'instructions',
  'systemPrompt',
  'temperature',
  'quota',
  'rateLimit',
  'rateLimits',
  'hourLimit',
  'dayLimit',
  'verifyJwt',
  'reviewAuthority',
  'reviewerUserId',
] as const;

/** 사용자 원문·식별자·인증 값·모델 원본 응답이 들어갈 수 있는 키 (대소문자 무시, 정확한 이름). */
export const PERSONAL_DATA_KEYS = [
  'situation',
  'situationText',
  'userText',
  'rawText',
  'input',
  'prayer',
  'userId',
  'uid',
  'authUid',
  'sessionId',
  'deviceId',
  'installationId',
  'ip',
  'ipAddress',
  'jwt',
  'accessToken',
  'refreshToken',
  'authorization',
  'email',
  'phone',
  'openaiResponse',
  'rawResponse',
  'responseBody',
  'outputText',
] as const;

/** 값 자체가 개인정보·자격 증명처럼 생긴 경우. 판단이 애매하면 막는다. */
export const PERSONAL_DATA_VALUE_PATTERNS: readonly { name: string; pattern: RegExp }[] = [
  { name: 'jwt', pattern: /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/ },
  { name: 'email', pattern: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/ },
  { name: 'ipv4', pattern: /\b(?:\d{1,3}\.){3}\d{1,3}\b/ },
  { name: 'secret_key', pattern: /\bsk-[A-Za-z0-9_-]{16,}/ },
  { name: 'uuid', pattern: /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/i },
];

const MAX_SCAN_DEPTH = 32;

/**
 * 값 전체를 훑어 바꿀 수 없는 설정 키, 개인정보 키, 개인정보처럼 생긴 문자열을 찾는다.
 * 깊이가 비정상적으로 깊으면 판단하지 않고 막는다.
 */
export function scanForbiddenContent(value: unknown, label = 'value'): string[] {
  const protectedKeys = new Set(PROTECTED_CONFIGURATION_KEYS.map((key) => key.toLowerCase()));
  const personalKeys = new Set(PERSONAL_DATA_KEYS.map((key) => key.toLowerCase()));
  const errors: string[] = [];

  const visit = (node: unknown, path: string, depth: number) => {
    if (depth > MAX_SCAN_DEPTH) {
      errors.push(`${path}: 구조가 너무 깊어 확인하지 못했습니다.`);
      return;
    }
    if (typeof node === 'string') {
      for (const { name, pattern } of PERSONAL_DATA_VALUE_PATTERNS) {
        if (pattern.test(node)) errors.push(`${path}: 개인정보·자격 증명처럼 보이는 값입니다(${name}).`);
      }
      return;
    }
    if (Array.isArray(node)) {
      node.forEach((item, index) => visit(item, `${path}[${index}]`, depth + 1));
      return;
    }
    if (node !== null && typeof node === 'object') {
      for (const [key, item] of Object.entries(node as Record<string, unknown>)) {
        const lower = key.toLowerCase();
        if (protectedKeys.has(lower)) errors.push(`${path}.${key}: 자동 카탈로그가 바꿀 수 없는 설정입니다.`);
        if (personalKeys.has(lower)) errors.push(`${path}.${key}: 개인정보가 들어갈 수 있는 항목입니다.`);
        visit(item, `${path}.${key}`, depth + 1);
      }
    }
  };

  visit(value, label, 0);
  return errors;
}

/* ------------------------------------------------------------------ */
/* 지문                                                                 */
/* ------------------------------------------------------------------ */

/**
 * 키 순서에 흔들리지 않는 글자열. 배열 순서는 뜻이 있으므로 그대로 둔다.
 * 기존 보관 계약들의 stableStringify와 같은 규칙이다(그 함수들은 각 파일 안에만 있다).
 * 여기서는 지문이 조용히 달라지지 않도록 JSON이 아닌 값을 받으면 멈춘다.
 */
export function canonicalJson(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('지문을 만들 수 없는 숫자입니다.');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0,
    );
    return `{${entries
      .map(([key, item]) => {
        if (item === undefined) throw new Error('지문을 만들 수 없는 값입니다.');
        return `${JSON.stringify(key)}:${canonicalJson(item)}`;
      })
      .join(',')}}`;
  }
  throw new Error('지문을 만들 수 없는 값입니다.');
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function computeCatalogVersionHash(snapshot: ScriptureCatalogSnapshot): Promise<string> {
  return `scat_${await sha256Hex(canonicalJson(snapshot))}`;
}

export async function computeCatalogCandidateHash(candidate: ScriptureCatalogCandidate): Promise<string> {
  return `sccand_${await sha256Hex(canonicalJson(candidate))}`;
}

/** 검증 산출물(payload)의 지문. 같은 payload면 언제 계산해도 같은 값이다. */
export async function computeArtifactHash(artifact: unknown): Promise<string> {
  return `sart_${await sha256Hex(canonicalJson(artifact))}`;
}

/** 정규화 주제의 지문. 주제 이름만 들어가고 사용자 문장이나 식별자는 들어갈 자리가 없다. */
export async function computeThemeFingerprint(themeKey: string): Promise<string> {
  return `sthm_${await sha256Hex(canonicalJson({ contractVersion: DEMAND_THEME_CONTRACT_VERSION, themeKey }))}`;
}

/* ------------------------------------------------------------------ */
/* 성경 표기                                                            */
/* ------------------------------------------------------------------ */

const BOOK_ORDER = new Map(Object.keys(KOREAN_BIBLE_BOOK_NAMES).map((book, index) => [book, index]));

/**
 * 본문 위치 목록에서 표기를 결정적으로 만든다. 사람이 적은 라벨을 믿지 않고 이 결과와 대조한다.
 *
 * 받는 목록의 조건: 모두 실제 위치, 정경 순서(책 → 장 → 절)로 앞에서 뒤로, 서로 겹치지 않음,
 * 같은 장 안에서는 절 사이가 떨어져 있음(붙어 있으면 한 위치로 합쳐 적어야 한다). 아니면 null.
 *
 * 1. 한 위치이거나 장을 넘어 붙어 있는 위치들이면 기존 formatKoreanBibleReferenceSequence 결과를 그대로 쓴다.
 *      시편 56:3–4 / 요한일서 1:8–2:2
 * 2. 떨어져 있으면 아래 규칙으로 잇는다(자동 카탈로그에서 합의한 규칙).
 *      같은 책·같은 장: 절만 ", "로 잇는다          잠언 18:13, 17
 *      같은 책·다른 장: "; 장:절"로 잇는다          잠언 3:5–6; 16:3
 *      다른 책       : "; 책 장:절"로 잇는다        시편 23:1; 요한복음 10:11
 *
 * 기존 bible-reference-label.ts 는 떨어진 위치를 일부러 null로 두었고 사람 검토 경로가 그 파일을 쓴다.
 * 그 규칙을 바꾸지 않기 위해 이 확장은 자동 카탈로그 계약 안에만 둔다.
 */
export function formatCatalogReferenceLabel(passages: unknown): string | null {
  if (!Array.isArray(passages) || passages.length === 0) return null;
  for (const passage of passages) {
    if (!isValidBibleReference(passage)) return null;
    if (koreanBibleBookName((passage as CatalogPassage).book) === null) return null;
  }
  const list = passages as CatalogPassage[];

  for (let index = 1; index < list.length; index += 1) {
    const previous = list[index - 1];
    const current = list[index];
    const previousBook = BOOK_ORDER.get(previous.book)!;
    const currentBook = BOOK_ORDER.get(current.book)!;
    if (currentBook < previousBook) return null;
    if (currentBook === previousBook) {
      if (current.chapter < previous.chapter) return null;
      if (current.chapter === previous.chapter && current.startVerse <= previous.endVerse + 1) return null;
    }
  }

  const contiguous = formatKoreanBibleReferenceSequence(list[0], list.slice(1));
  if (contiguous !== null) return contiguous;

  const verses = (passage: CatalogPassage) =>
    passage.startVerse === passage.endVerse
      ? `${passage.startVerse}`
      : `${passage.startVerse}${REFERENCE_RANGE_DASH}${passage.endVerse}`;

  let label = '';
  list.forEach((passage, index) => {
    const previous = list[index - 1];
    if (index === 0 || previous.book !== passage.book) {
      label += `${index === 0 ? '' : '; '}${koreanBibleBookName(passage.book)} ${passage.chapter}:${verses(passage)}`;
    } else if (previous.chapter !== passage.chapter) {
      label += `; ${passage.chapter}:${verses(passage)}`;
    } else {
      label += `, ${verses(passage)}`;
    }
  });
  return label;
}

/* ------------------------------------------------------------------ */
/* 검사 도구                                                            */
/* ------------------------------------------------------------------ */

export type ContractCheck = { valid: boolean; errors: string[] };

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isBoundedText = (value: unknown, max: number): value is string =>
  typeof value === 'string' && value.trim().length > 0 && value === value.trim() && value.length <= max;

function checkExactFields(value: Record<string, unknown>, fields: readonly string[], label: string): string[] {
  const errors: string[] = [];
  for (const key of Object.keys(value)) {
    if (!fields.includes(key)) errors.push(`${label}: 계약에 없는 항목입니다: ${key}`);
  }
  for (const key of fields) {
    if (!Object.hasOwn(value, key)) errors.push(`${label}: 빠진 항목입니다: ${key}`);
  }
  return errors;
}

function checkTextList(value: unknown, label: string, maxItems: number, maxText: number): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > maxItems) {
    return [`${label}: 1~${maxItems}개의 목록이어야 합니다.`];
  }
  const errors: string[] = [];
  value.forEach((item, index) => {
    if (!isBoundedText(item, maxText)) errors.push(`${label}[${index}]: 1~${maxText}자의 글이어야 합니다.`);
  });
  if (new Set(value).size !== value.length) errors.push(`${label}: 같은 값이 두 번 있습니다.`);
  return errors;
}

function isStrictlyAscending(ids: string[]): boolean {
  return ids.every((id, index) => index === 0 || ids[index - 1] < id);
}

/* ------------------------------------------------------------------ */
/* 카드 · 영역 · 카탈로그 검사                                            */
/* ------------------------------------------------------------------ */

export function validateCatalogDomain(value: unknown, label = 'domain'): ContractCheck {
  if (!isPlainObject(value)) return { valid: false, errors: [`${label}: 객체가 아닙니다.`] };
  const errors = checkExactFields(value, CATALOG_DOMAIN_FIELDS, label);
  if (typeof value.id !== 'string' || !DOMAIN_ID_FORMAT.test(value.id)) {
    errors.push(`${label}.id: 영역 이름 모양이 맞지 않습니다.`);
  } else if (value.id === FALLBACK_DOMAIN) {
    errors.push(`${label}.id: ${FALLBACK_DOMAIN}은 카드 영역이 될 수 없습니다.`);
  }
  const displayName = value.displayName;
  if (
    typeof displayName !== 'string' ||
    displayName.length < DOMAIN_DISPLAY_NAME_MIN ||
    displayName.length > DOMAIN_DISPLAY_NAME_MAX ||
    !DOMAIN_DISPLAY_NAME_FORMAT.test(displayName)
  ) {
    errors.push(
      `${label}.displayName: ${DOMAIN_DISPLAY_NAME_MIN}~${DOMAIN_DISPLAY_NAME_MAX}자의 한글 낱말과 한 칸 띄어쓰기만 쓸 수 있습니다.`,
    );
  } else {
    errors.push(...scanForbiddenContent(displayName, `${label}.displayName`));
  }
  if (!isBoundedText(value.description, DOMAIN_DESCRIPTION_MAX)) {
    errors.push(`${label}.description: 1~${DOMAIN_DESCRIPTION_MAX}자의 설명이어야 합니다.`);
  }
  return { valid: errors.length === 0, errors };
}

export function validateCatalogCard(value: unknown, label = 'card'): ContractCheck {
  if (!isPlainObject(value)) return { valid: false, errors: [`${label}: 객체가 아닙니다.`] };
  const errors = checkExactFields(value, CATALOG_CARD_FIELDS, label);

  if (typeof value.id !== 'string' || !CARD_ID_FORMAT.test(value.id)) {
    errors.push(`${label}.id: 카드 번호 모양이 맞지 않습니다.`);
  }
  if (typeof value.domainId !== 'string' || !DOMAIN_ID_FORMAT.test(value.domainId)) {
    errors.push(`${label}.domainId: 영역 이름 모양이 맞지 않습니다.`);
  }

  let passagesShapeOk = false;
  if (!Array.isArray(value.passages) || value.passages.length === 0 || value.passages.length > MAX_PASSAGES_PER_CARD) {
    errors.push(`${label}.passages: 1~${MAX_PASSAGES_PER_CARD}개의 본문 위치여야 합니다.`);
  } else {
    passagesShapeOk = true;
    value.passages.forEach((passage, index) => {
      const passageLabel = `${label}.passages[${index}]`;
      if (!isPlainObject(passage)) {
        errors.push(`${passageLabel}: 객체가 아닙니다.`);
        passagesShapeOk = false;
        return;
      }
      const fieldErrors = checkExactFields(passage, ['book', 'chapter', 'startVerse', 'endVerse'], passageLabel);
      if (fieldErrors.length > 0 || !isValidBibleReference(passage)) passagesShapeOk = false;
      errors.push(...fieldErrors);
      if (!isValidBibleReference(passage)) errors.push(`${passageLabel}: 성경에 없는 위치입니다.`);
    });
  }

  if (!isBoundedText(value.referenceLabel, REFERENCE_LABEL_MAX)) {
    errors.push(`${label}.referenceLabel: 1~${REFERENCE_LABEL_MAX}자여야 합니다.`);
  } else if (passagesShapeOk) {
    const expected = formatCatalogReferenceLabel(value.passages);
    if (expected === null) {
      errors.push(`${label}.passages: 정경 순서로 떨어져 있어야 하고 서로 겹치거나 붙어 있으면 안 됩니다.`);
    } else if (value.referenceLabel !== expected) {
      errors.push(`${label}.referenceLabel: 본문 위치로 계산한 표기(${expected})와 다릅니다.`);
    }
  }

  for (const field of CATALOG_TAG_FIELDS) {
    errors.push(...checkTextList(value[field], `${label}.${field}`, TAG_LIST_MAX, TAG_TEXT_MAX));
  }
  for (const field of CATALOG_PROSE_FIELDS) {
    if (!isBoundedText(value[field], PROSE_MAX)) errors.push(`${label}.${field}: 1~${PROSE_MAX}자여야 합니다.`);
  }
  errors.push(
    ...checkTextList(value.misuseGuards, `${label}.misuseGuards`, MISUSE_GUARD_LIST_MAX, MISUSE_GUARD_TEXT_MAX),
  );

  return { valid: errors.length === 0, errors };
}

/** 카탈로그 한 판을 확인한다. 어떤 값이 와도 예외를 던지지 않고, 판단이 안 되면 막는다. */
export function validateCatalogSnapshot(value: unknown): ContractCheck {
  try {
    if (!isPlainObject(value)) return { valid: false, errors: ['카탈로그가 객체가 아닙니다.'] };
    const errors = checkExactFields(value, CATALOG_SNAPSHOT_FIELDS, 'catalog');
    if (value.contractVersion !== CATALOG_CONTRACT_VERSION) errors.push('catalog: 계약 버전이 맞지 않습니다.');

    if (!Array.isArray(value.domains) || value.domains.length === 0) {
      errors.push('catalog.domains: 영역이 하나 이상 있어야 합니다.');
    }
    if (!Array.isArray(value.cards) || value.cards.length === 0) {
      errors.push('catalog.cards: 카드가 하나 이상 있어야 합니다.');
    }
    errors.push(...scanForbiddenContent(value, 'catalog'));
    if (errors.length > 0) return { valid: false, errors };

    const domains = value.domains as unknown[];
    const cards = value.cards as unknown[];
    domains.forEach((domain, index) => errors.push(...validateCatalogDomain(domain, `catalog.domains[${index}]`).errors));
    cards.forEach((card, index) => errors.push(...validateCatalogCard(card, `catalog.cards[${index}]`).errors));
    if (errors.length > 0) return { valid: false, errors };

    const domainList = domains as CatalogDomain[];
    const domainIds = domainList.map((domain) => domain.id);
    const cardList = cards as CatalogCard[];
    const cardIds = cardList.map((card) => card.id);

    if (!isStrictlyAscending(domainIds)) errors.push('catalog.domains: id 오름차순이어야 하고 중복이 없어야 합니다.');
    if (!isStrictlyAscending(cardIds)) errors.push('catalog.cards: id 오름차순이어야 하고 중복이 없어야 합니다.');
    const displayNames = domainList.map((domain) => domain.displayName);
    if (new Set(displayNames).size !== displayNames.length) {
      errors.push('catalog.domains: 같은 표시 이름을 쓰는 영역이 있습니다.');
    }

    const domainSet = new Set(domainIds);
    for (const card of cardList) {
      if (!domainSet.has(card.domainId)) errors.push(`catalog.cards ${card.id}: 없는 영역을 가리킵니다.`);
    }
    for (const domainId of domainIds) {
      if (!cardList.some((card) => card.domainId === domainId)) {
        errors.push(`catalog.domains ${domainId}: 카드가 한 장도 없는 영역입니다.`);
      }
    }

    return { valid: errors.length === 0, errors };
  } catch {
    return { valid: false, errors: ['카탈로그를 확인하지 못했습니다.'] };
  }
}

/* ------------------------------------------------------------------ */
/* 기준 카탈로그 · 후보 적용                                              */
/* ------------------------------------------------------------------ */

const byId = <T extends { id: string }>(a: T, b: T) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/**
 * 지금 Git 안의 정적 카드·영역 설명·표시 이름으로 기준 카탈로그를 만든다.
 * 런타임이 이것을 쓰지 않는다. 서버 카탈로그의 첫 판을 결정적으로 만들기 위한 변환일 뿐이다.
 */
export function buildCatalogSnapshotFromStaticCards(
  cards: readonly ScriptureCard[],
  domainDescriptions: Readonly<Record<string, string>>,
  domainDisplayNames: Readonly<Record<string, string>>,
): ScriptureCatalogSnapshot {
  const catalogCards: CatalogCard[] = cards.map((card) => {
    if (card.domains.length !== 1) throw new Error(`${card.id}: 카드마다 영역은 하나여야 합니다.`);
    const passages = card.passages ?? [card.passage];
    return {
      id: card.id,
      domainId: card.domains[0],
      referenceLabel: card.referenceLabel,
      passages: passages.map(({ book, chapter, startVerse, endVerse }) => ({ book, chapter, startVerse, endVerse })),
      situationTags: [...card.situationTags],
      emotionTags: [...card.emotionTags],
      spiritualQuestionTags: [...card.spiritualQuestionTags],
      prayerModes: [...card.prayerModes],
      pastoralFunction: [...card.pastoralFunction],
      contextSummary: card.contextSummary,
      theologicalInsight: card.theologicalInsight,
      userExplanation: card.userExplanation,
      prayerDirection: card.prayerDirection,
      misuseGuards: [...card.misuseGuards],
    };
  });

  const domainIds = [...new Set(catalogCards.map((card) => card.domainId))];
  const domains = domainIds.map((id) => {
    const description = domainDescriptions[id];
    const displayName = domainDisplayNames[id];
    if (typeof description !== 'string') throw new Error(`${id}: 영역 설명이 없습니다.`);
    if (typeof displayName !== 'string') throw new Error(`${id}: 표시 이름이 없습니다.`);
    return { id, displayName, description };
  });

  return {
    contractVersion: CATALOG_CONTRACT_VERSION,
    domains: domains.sort(byId),
    cards: catalogCards.sort(byId),
  };
}

/** base에 후보를 합친다. base와 후보를 바꾸지 않고 새 카탈로그를 돌려준다. */
export function applyCandidateToCatalog(
  base: ScriptureCatalogSnapshot,
  candidate: ScriptureCatalogCandidate,
): ScriptureCatalogSnapshot {
  const domains = candidate.newDomain ? [...base.domains, candidate.newDomain] : [...base.domains];
  return {
    contractVersion: CATALOG_CONTRACT_VERSION,
    domains: domains.map((domain) => ({ ...domain })).sort(byId),
    cards: [...base.cards, ...candidate.cards].map((card) => structuredClone(card)).sort(byId),
  };
}

export type CandidateCheck = ContractCheck & { proposedCatalog: ScriptureCatalogSnapshot | null };

/** 후보 종류에 맞는 수요 연결인지 확인한다. 주제 지문은 주제 이름에서 다시 계산한다. */
async function checkDemandBinding(candidate: Record<string, unknown>): Promise<string[]> {
  const binding = candidate.demandBinding;
  if (!isPlainObject(binding)) return ['candidate.demandBinding: 객체가 아닙니다.'];
  if (candidate.candidateKind === 'existing_domain_card') {
    const errors = checkExactFields(binding, ['kind', 'domainId'], 'candidate.demandBinding');
    if (binding.kind !== 'weak_match') errors.push('candidate.demandBinding.kind: 기존 영역 후보는 weak_match 집계에만 묶입니다.');
    if (binding.domainId !== candidate.targetDomainId) {
      errors.push('candidate.demandBinding.domainId: 대상 영역과 같아야 합니다.');
    }
    return errors;
  }
  const errors = checkExactFields(binding, ['kind', 'themeKey', 'themeFingerprint'], 'candidate.demandBinding');
  if (binding.kind !== 'normalized_theme') {
    errors.push('candidate.demandBinding.kind: 새 영역 후보는 normalized_theme 집계에만 묶입니다.');
  }
  if (typeof binding.themeKey !== 'string' || !THEME_KEY_FORMAT.test(binding.themeKey)) {
    errors.push('candidate.demandBinding.themeKey: 정규화 주제 이름 모양이 맞지 않습니다.');
  } else if (binding.themeFingerprint !== (await computeThemeFingerprint(binding.themeKey))) {
    errors.push('candidate.demandBinding.themeFingerprint: 주제 이름에서 계산한 지문과 다릅니다.');
  }
  return errors;
}

/**
 * 후보 한 건을 기준 카탈로그에 대어 확인한다.
 * 모양, 종류별 규칙, 번호 충돌, 닫힌 태그 사전, 성경 표기, 수요 연결, 연구 결과 지문,
 * 금지 내용, 결과 카탈로그와 두 지문까지 본다.
 * 연구 결과가 저장소에 실제로 있는지는 저장 계층(DB 외래 키, 참조 의미의 planStoreCandidate)이 확인한다.
 * 어떤 값이 와도 예외를 던지지 않는다. 판단이 안 되면 막는다.
 */
export async function validateCatalogCandidate(
  value: unknown,
  baseCatalog: ScriptureCatalogSnapshot,
): Promise<CandidateCheck> {
  const fail = (errors: string[]): CandidateCheck => ({ valid: false, errors, proposedCatalog: null });
  try {
    const base = validateCatalogSnapshot(baseCatalog);
    if (!base.valid) return fail(['기준 카탈로그가 올바르지 않습니다.', ...base.errors]);
    if (!isPlainObject(value)) return fail(['후보가 객체가 아닙니다.']);

    const errors = checkExactFields(value, CANDIDATE_FIELDS, 'candidate');
    errors.push(...scanForbiddenContent(value, 'candidate'));
    if (value.contractVersion !== CANDIDATE_CONTRACT_VERSION) errors.push('candidate: 계약 버전이 맞지 않습니다.');
    if (!(CANDIDATE_KINDS as readonly unknown[]).includes(value.candidateKind)) {
      errors.push('candidate.candidateKind: 알 수 없는 후보 종류입니다.');
    }
    if (typeof value.baseVersionHash !== 'string' || !CATALOG_VERSION_HASH_FORMAT.test(value.baseVersionHash)) {
      errors.push('candidate.baseVersionHash: 지문 모양이 맞지 않습니다.');
    }
    if (typeof value.proposedVersionHash !== 'string' || !CATALOG_VERSION_HASH_FORMAT.test(value.proposedVersionHash)) {
      errors.push('candidate.proposedVersionHash: 지문 모양이 맞지 않습니다.');
    }
    if (typeof value.targetDomainId !== 'string' || !DOMAIN_ID_FORMAT.test(value.targetDomainId)) {
      errors.push('candidate.targetDomainId: 영역 이름 모양이 맞지 않습니다.');
    }
    if (
      typeof value.sourceResearchResultHash !== 'string' ||
      !RESEARCH_RESULT_HASH_FORMAT.test(value.sourceResearchResultHash)
    ) {
      errors.push('candidate.sourceResearchResultHash: 연구 결과 지문이 반드시 있어야 합니다.');
    }

    if (!isPlainObject(value.generation)) {
      errors.push('candidate.generation: 객체가 아닙니다.');
    } else {
      errors.push(...checkExactFields(value.generation, CANDIDATE_GENERATION_FIELDS, 'candidate.generation'));
      if (value.generation.method !== 'automated') errors.push('candidate.generation.method: automated여야 합니다.');
      if (!isBoundedText(value.generation.modelId, GENERATION_TEXT_MAX)) {
        errors.push('candidate.generation.modelId: 모델 식별자가 필요합니다.');
      }
      if (!isBoundedText(value.generation.promptVersion, GENERATION_TEXT_MAX)) {
        errors.push('candidate.generation.promptVersion: 생성 규칙 버전이 필요합니다.');
      }
    }

    if (!Array.isArray(value.cards) || value.cards.length === 0 || value.cards.length > MAX_CARDS_PER_CANDIDATE) {
      errors.push(`candidate.cards: 1~${MAX_CARDS_PER_CANDIDATE}장이어야 합니다.`);
    } else {
      value.cards.forEach((card, index) => errors.push(...validateCatalogCard(card, `candidate.cards[${index}]`).errors));
    }
    if (errors.length > 0) return fail(errors);

    errors.push(...(await checkDemandBinding(value)));

    const candidate = value as unknown as ScriptureCatalogCandidate;
    const baseDomainIds = new Set(baseCatalog.domains.map((domain) => domain.id));
    const baseCardIds = new Set(baseCatalog.cards.map((card) => card.id));

    if (candidate.baseVersionHash !== (await computeCatalogVersionHash(baseCatalog))) {
      errors.push('candidate.baseVersionHash: 기준 카탈로그의 지문과 다릅니다.');
    }

    if (candidate.candidateKind === 'existing_domain_card') {
      if (candidate.newDomain !== null) errors.push('candidate.newDomain: 기존 영역 후보는 null이어야 합니다.');
      if (!baseDomainIds.has(candidate.targetDomainId)) {
        errors.push('candidate.targetDomainId: 기준 카탈로그에 없는 영역입니다.');
      }
    } else {
      const domainCheck = validateCatalogDomain(candidate.newDomain, 'candidate.newDomain');
      errors.push(...domainCheck.errors);
      if (domainCheck.valid) {
        if (candidate.newDomain!.id !== candidate.targetDomainId) {
          errors.push('candidate.newDomain.id: targetDomainId와 같아야 합니다.');
        }
        if (baseDomainIds.has(candidate.newDomain!.id)) {
          errors.push('candidate.newDomain.id: 이미 있는 영역입니다.');
        }
        if (baseCatalog.domains.some((domain) => domain.displayName === candidate.newDomain!.displayName)) {
          errors.push('candidate.newDomain.displayName: 이미 다른 영역이 쓰는 표시 이름입니다.');
        }
      }
      if (candidate.cards.length < MIN_CARDS_FOR_NEW_DOMAIN) {
        errors.push(`candidate.cards: 새 영역은 최소 ${MIN_CARDS_FOR_NEW_DOMAIN}장이 필요합니다.`);
      }
    }

    const vocabulary = new Map(
      CLOSED_VOCABULARY_TAG_FIELDS.map((field) => [field, new Set(baseCatalog.cards.flatMap((card) => card[field]))]),
    );
    const seenIds = new Set<string>();
    for (const card of candidate.cards) {
      if (card.domainId !== candidate.targetDomainId) errors.push(`${card.id}: targetDomainId와 다른 영역입니다.`);
      if (baseCardIds.has(card.id)) errors.push(`${card.id}: 이미 있는 카드 번호입니다.`);
      if (seenIds.has(card.id)) errors.push(`${card.id}: 후보 안에서 번호가 겹칩니다.`);
      seenIds.add(card.id);
      for (const field of CLOSED_VOCABULARY_TAG_FIELDS) {
        for (const tag of card[field]) {
          if (!vocabulary.get(field)!.has(tag)) errors.push(`${card.id}.${field}: 기준 사전에 없는 값입니다: ${tag}`);
        }
      }
    }
    if (errors.length > 0) return fail(errors);

    const proposedCatalog = applyCandidateToCatalog(baseCatalog, candidate);
    const proposed = validateCatalogSnapshot(proposedCatalog);
    if (!proposed.valid) return fail(['합친 카탈로그가 올바르지 않습니다.', ...proposed.errors]);
    if (candidate.proposedVersionHash !== (await computeCatalogVersionHash(proposedCatalog))) {
      return fail(['candidate.proposedVersionHash: 합친 카탈로그의 지문과 다릅니다.']);
    }

    return { valid: true, errors: [], proposedCatalog };
  } catch {
    return fail(['후보를 확인하지 못했습니다.']);
  }
}
