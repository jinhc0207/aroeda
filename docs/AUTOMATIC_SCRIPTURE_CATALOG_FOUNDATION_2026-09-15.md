# Automatic Scripture Catalog Foundation v1 (2026-09-15)

사람의 사전 승인 없이, 철저한 자동 검증을 통과한 경우에만 기존 영역·새 영역의 카드를
**버전형 서버 카탈로그**에 활성화할 수 있게 하는 기반이다. 이번 단계는 계약·저장소·전환 함수·테스트까지만
만들었다. **추천 런타임은 여전히 Git 안의 정적 카드를 읽고, migration은 검증용 임시 컨테이너에서만 돌려 봤을 뿐
운영 Supabase에는 적용하지 않았다(§9-1).**

## 1. 이번 단계의 범위

만든 것

| 파일 | 역할 |
|---|---|
| `supabase/functions/_shared/automatic-scripture-catalog-contract.ts` | 카탈로그 한 판·후보 한 건의 모양, 결정적 지문, 금지 설정·개인정보 차단, 기준 카탈로그 변환 |
| `supabase/functions/_shared/automatic-scripture-catalog-activation-contract.ts` | 자동 검증 기록 계약, fail-closed 판단, 보관·활성화·롤백의 참조 의미(pure plan 함수) |
| `supabase/migrations/20260915120000_create_automatic_scripture_catalog.sql` | 불변 이력 표 9개 + 증가 전용 수요 표 2개 + 활성 포인터 1개, SECURITY DEFINER RPC 7개, 원자성 트리거 |
| `src/lib/automatic-scripture-catalog-*.test.ts` (4개) + 테스트 전용 fixture 1개 | 계약·권한·멱등성·원자성·롤백·fail-closed·검수 결함 회귀 테스트 |

하지 않은 것: 운영 Supabase 적용, Edge Function 배포, OpenAI 호출, 실제 카드 자동 생성, Analyzer·추천
런타임 전환, 이메일·외부 메시지 발송, 기존 정적 카드·영역 제거, 패키지 설치, 커밋.

## 2. 기존 구조 조사 결과 — 무엇을 재사용했고 무엇을 재사용하지 않았나

재사용한 것

- `bible-reference.ts`의 `checkBibleReference`·`referencesOverlap` — 장절 존재 확인과 기존 카드 본문 중복 재계산.
- `bible-reference-index.ts`의 `SOURCE_SHA256` — 개역한글 데이터 버전 고정. SQL 사본까지 같은 값으로 대조한다.
- `published-content-contract.ts`의 크기 한도(`TAG_LIST_MAX` 등) — 현재 카드 51장이 모두 그 안에 들어가는 것을 측정한 뒤 숫자만 가져왔다.
- `research-result-store-contract.ts`의 `RESEARCH_RESULT_HASH_FORMAT` — 후보가 연구 보관소에서 나왔다면 그 지문을 모양 그대로 받는다.
- 기존 보관 계약들의 규칙: 키 정렬 canonical JSON + SHA-256 지문, 접두사가 붙은 지문, "SQL은 모양·이음·권한, TS는 내용 규칙" 분담,
  `reject_*_mutation` append-only 방아쇠, `search_path` 고정 SECURITY DEFINER RPC, migration을 글자로 대조하는 계약 테스트.
- `coverage_gap_daily`의 개인정보 최소화 원칙 — 사용자 문장 없이 날짜·영역 또는 정규화 주제 지문별 횟수만 센다.
  기존 표의 `other_uncovered` 합계는 특정 새 영역의 근거로 재사용하지 않는다.

재사용하지 않은 것 (의도적으로 분리)

- `published_content_candidate` / `published_content_review` / `published_content` — 이 경로는 **사람만 승인**하도록
  `authenticated` + 검토자 명단 + `auth.uid()` + `reviewAuthority = 'human'` 제약으로 설계됐고,
  후보가 `research_result`에 외래 키로 묶이며 대상 영역도 `RESEARCHABLE_DOMAINS`로 한정된다.
  자동 경로를 여기에 끼우면 "사람 권한"을 조용히 완화하게 된다. 그래서 표·함수·authority를 모두 따로 두었고,
  테스트가 두 사람 검토 migration 파일의 SHA-256을 고정해 한 글자도 바뀌지 않았음을 확인한다.

## 3. 흐름

```text
정적 카드 51장 ──(buildCatalogSnapshotFromStaticCards)──▶ 기준 카탈로그 scat_…  [register_scripture_catalog_baseline, 1회]
                                                              │
비식별 수요 집계(기존 영역 weak_match | 새 영역 normalized_theme) + 저장된 연구 결과 rres_…
                                                              │
자동 후보 sccand_… (existing_domain_card | new_domain_with_cards) ─▶ 결과 카탈로그 scat_… (부모 = 기준)   [store_scripture_catalog_candidate]
                                                              │
자동 검증 기록 scval_… (8개 필수 항목, 실패 기록도 보존)
  + 등록 validator profile의 항목별 attestation                    [store_scripture_catalog_validation]
                                                              │
활성화: 활성화 기록 + 소유자 공지 + 포인터 전환 (한 트랜잭션)       [activate_scripture_catalog_candidate]
                                                              │
롤백: 이전에 활성이었던 조상 버전으로만. 롤백 기록 + 공지 + 포인터 (한 트랜잭션) [rollback_scripture_catalog_version]
```

## 4. 저장소 (모두 `private` 스키마)

| 표 | 성격 | 핵심 제약 |
|---|---|---|
| `scripture_catalog_version` | 카탈로그 한 판, append-only | `scat_` 지문, 부모 버전 외래 키, 계약 버전 고정 |
| `scripture_catalog_validator_profile` | 검토된 validator 허용 목록, append-only | 기반 migration은 표만 만들며, 실제 네 profile은 §9-2의 후속 migration이 등록 |
| `scripture_demand_weak_match_daily` | 기존 영역 약한 매칭의 날짜별 횟수 | 활성 영역만, 같은 키의 횟수를 1씩 늘리는 것만 허용 |
| `scripture_demand_theme_daily` | 새 영역 후보용 정규화 주제 지문의 날짜별 횟수 | 사용자 문장 없이 주제 지문만, 같은 키의 횟수를 1씩 늘리는 것만 허용 |
| `scripture_catalog_candidate` | 후보(생성 기록), append-only | 종류 2개·수요 연결·연구 결과 FK 필수, JSON 안 지문·종류가 칸과 일치 |
| `scripture_catalog_validation` | 검증 evidence, append-only | authority = `automated_validation`, 후보 지문과 일치 |
| `scripture_catalog_validation_attestation` | 항목별 validator 판정, append-only | payload 지문·등록 profile·검증 status와 일치 |
| `scripture_catalog_baseline` | 기준 등록 기록, append-only, 1줄 | authority = `automated_operations`, revision 1 |
| `scripture_catalog_activation` | 활성화 기록, append-only | 요청·후보·결과 버전·revision 유일, (검증, 후보) 복합 외래 키 |
| `scripture_catalog_rollback` | 롤백 기록, append-only | 요청·revision 유일, 사유 코드 5개로 제한 |
| `scripture_catalog_owner_notification` | 소유자 공지 outbox, append-only | revision 유일, 종류 3개, 지문·사유 코드만 |
| `scripture_catalog_active_pointer` | 활성 버전 1줄 | 삭제·비우기 거절, revision은 +1씩만, 커밋 시 기록·공지 존재 확인 |

모든 표: RLS 켬, `public`·`anon`·`authenticated`·`service_role` 권한 회수, 정책 없음, 표 직접 권한 없음.

**원자성의 두 겹.** (1) 각 RPC는 활성화/롤백 기록 → 공지 → 포인터 전환을 한 함수 안에서 하며 예외를 삼키지 않는다.
(2) 포인터에 `deferrable initially deferred` 제약 트리거를 걸어, 커밋 순간 같은 revision의 등록·활성화·롤백 기록과
공지 기록이 둘 다 없으면 트랜잭션 전체를 거절한다. 나중에 다른 함수가 이 순서를 빠뜨려도 DB가 막는다.

## 5. 권한 경계

| 경로 | 호출 가능 역할 | authority | 쓰는 표 |
|---|---|---|---|
| 게시 콘텐츠 사람 검토 (기존, 변경 없음) | `authenticated` + 활성 검토자 명단 | `human` | `published_content*` |
| 자동 카탈로그 7개 RPC (신규) | `service_role`만 | `automated_validation` / `automated_operations` | `scripture_catalog_*`, `scripture_demand_*` |

- 자동 RPC는 `security definer`, `set search_path = private, pg_catalog`, 입력 모양 검사,
  `public`·`anon`·`authenticated`·`service_role` 회수 후 `service_role`에만 `execute`를 준다.
- 내부 도구 함수 5개도 모든 역할에서 회수하고 아무에게도 열지 않는다. 동적 SQL을 쓰지 않는다.
- 자동 카탈로그는 안전 규칙·개인정보 정책·OpenAI 모델·사용량 한도를 바꿀 수 없다. 카드·영역은 정해진 항목만 받고,
  `safety`·`privacyPolicy`·`model`·`quota`·`rateLimit`·`instructions` 등 키는 어느 깊이에 있어도 계약이 거절한다.
  감정·신앙질문·기도방식·목회기능 태그는 기준 사전에 있는 값만 허용한다(Analyzer 지시문이 바뀌지 않게).

## 6. 자동 검증 기록 계약

공통: `contractVersion`, `validationAuthority = automated_validation`, 후보 지문·종류, 기준·결과 버전 지문,
`validatorRuleVersion`, `dataVersions`(개역한글 SHA-256, 평가 코퍼스 버전), `modelIdentifiers`(생성 모델, 평가 모델 목록),
항목마다 `status`(`pass`/`fail`/`not_run`)와 산출물 지문 `artifactHash`(`sart_…`), `overallStatus`. 기록 전체 지문은 `scval_…`.

| 항목 | 통과 조건 | 계약이 다시 계산하는가 |
|---|---|---|
| `demandSignal` | 기존 영역은 그 영역의 `weak_match`, 새 영역은 그 주제의 `normalized_theme`; 가려진 날짜별 합계 30회 이상·활동일 7일 이상 | 후보 연결·날짜·가림 규칙 재확인, 활성화 때 저장 집계로 재생성 |
| `passageExistence` | 모든 본문 위치가 실제로 있음, 확인 개수 일치 | 예 (`checkBibleReference`) |
| `krvTextMatch` | 모든 위치의 원문 지문이 개역한글 원문과 일치, 데이터 SHA-256 일치 | 예 (resolver로 원문을 읽어 재계산, resolver 없으면 막음) |
| `contextTheologyReview` | 등록된 model evaluator profile 중 서로 다른 독립 그룹 최소 2개, 후보 카드마다 rubric criterion 9개 전부 pass(§9-5) | profile 권한·독립 그룹·모델 목록·attestation 연결·criterion 순서·개수·모양 재확인 |
| `safetyBoundary` | 경계 사례 1개 이상, 기대 route와 관찰 route가 모두 일치 | 사례 배열에서 재계산 |
| `duplicateCheck` | 기존 카드 전체·후보 내 다른 카드와 본문 겹침 0 | 예 (`referencesOverlap`) |
| `corpusRegression` | 사례 1개 이상, 안전 오탐 0, 기존 성공 domain·acceptable 결과가 후보에서 유지 | 사례 배열에서 재계산 |
| `candidateGenerationEvaluation` | 카드당 3사례 이상, 전부 통과 | 사례 배열에서 재계산 |

판단은 두 층이다. **무효(valid = false)**: 모양·지문 연결이 틀렸거나, 규칙상 실패인데 통과로(또는 반대로) 적힌 "사실과 다른 기록".
무효 기록은 보관하지도 않는다. **막음(activationBlockers)**: 기록은 사실대로이지만 실패·미실행·합의 부족.
실패 기록도 증거로 보관하되 활성화하지 않는다.

## 7. 활성화 조건 (요구사항 대응)

| 요구 | 구현 |
|---|---|
| 필요한 검증 항목이 모두 존재 | 정확히 8개 키, 누락·추가 모두 거절 (TS·SQL) |
| 모든 필수 검증 pass | 항목별 `status = pass` + `overallStatus = pass` (TS·SQL) |
| 독립 평가 합의 | 등록된 model evaluator profile의 독립 그룹 distinct 개수 = 평가 수 ≥ 2, 모든 카드 pass (TS·SQL) |
| 후보·evidence 지문 연결 | 후보 지문, 기준·결과 버전, 종류, 수요 대상, 연구 결과가 일치. 후보는 `research_result`에 FK, 검증은 후보에 복합 FK |
| 기준 버전이 여전히 active | 포인터를 `for update`로 잠근 뒤 기대 버전·후보 기준 버전과 대조, 다르면 `serialization_failure` |
| 중복 활성화 방지 | 요청 번호·후보·결과 버전 각각 유일. 롤백 뒤에도 같은 후보·버전 재활성화 거절 |
| 활성화와 공지가 한 트랜잭션 | 한 함수 안 + 지연 제약 트리거 |
| 어느 단계든 실패하면 포인터 변화 없음 | 예외를 삼키지 않음. TS 참조 의미는 실패 시 상태를 전혀 바꾸지 않음(테스트로 확인) |
| 활성화 순간 재확인 | 요청에서 검증 결과를 받지 않고 저장된 연구 결과·수요 집계·검증·attestation을 다시 확인. TS는 원문 지문까지 재계산 |

## 8. 롤백 · 소유자 공지

- 롤백 대상은 현재 활성 버전의 **조상**이면서 **한 번이라도 활성이었던** 버전뿐이다(재귀 CTE + 등록·활성화·롤백 이력).
  현재 버전, 없는 버전, 앞으로 되돌리기는 거절한다. 롤백해도 이전 기록·버전은 지워지지 않는다.
- 사유 코드: `regression_detected`, `safety_concern`, `validation_evidence_invalidated`, `owner_requested`, `operational_incident`.
- 같은 요청 번호로 같은 내용이면 이전 결과를 돌려주고(멱등), 다른 내용이면 거절한다.
- 공지는 **보내지 않고 적어 두기만** 한다. 내용은 종류·revision·이전/다음 버전 지문·후보 지문·사유 코드뿐이고 받는 사람 주소가 없다.

## 9. 이 기반이 보장하지 못하는 것 (알려진 한계)

1. **SQL은 실제 PostgreSQL에서 돌려 봤지만, production에는 아직 적용하지 않았다.**
   깨끗한 임시 컨테이너(`public.ecr.aws/supabase/postgres:17.6.1.167`, PostgreSQL 17.6)에 14개 migration을
   순서대로 전부 적용하고, `set role service_role` 상태에서 기준 등록·후보 저장·검증 저장·활성화·롤백
   전체 흐름과 권한·append-only·멱등·잠금·수요 집계 대조를 확인했다(§9-1).
   운영 Supabase 프로젝트에는 적용하지 않았고, 운영 데이터·운영 역할 설정에서의 동작은 여전히 따로 확인해야 한다.
2. **SQL은 SHA-256 지문을 다시 계산하지 않는다.** jsonb 글자 표현이 TS canonical JSON과 다르기 때문이다.
   지문 정합성은 저장 전 TS 계약이 payload에서 다시 계산한다. SQL은 지문 모양·연결, 등록 profile의 attestation,
   "결과 카탈로그 = 기준 + 후보", 수요·중복·사례 결과를 저장 데이터에서 다시 대조한다.
3. **SQL은 카드 항목 내용을 검사하지 않는다.** 내용 규칙의 주인은 TS 계약이며, 기존 구조 테스트가 모든 migration의
   실행 SQL에 특정 낱말이 들어가는 것을 금지해 카드 항목 이름을 SQL에 나열할 수도 없다.
4. **attestation은 암호 서명이 아니다.** 독립성·권한은 불변 validator profile 등록부에서 가져오고 임의 문자열은 거절하지만,
   `service_role`을 가진 실행기가 등록 profile을 사칭할 가능성까지 막지는 못한다. 실제 발행 주체 인증에는 서명 키가 필요하다.
4-1. **수요 집계는 과거를 지어낼 수 없다(막아 주는 것).** 집계를 늘리는 두 RPC는 날짜를 받지 않고 항상
   서울 기준 오늘 칸을 1씩만 늘린다. 표에는 아무도 직접 쓸 수 없고 지우거나 줄일 수도 없다.
   그래서 `service_role`을 가진 쪽도 "활동일 7일 이상"을 하루 만에 만들 수 없고, 실제 달력으로 7일이 걸린다.
   다만 **앞으로 부풀리는 것**(매일 호출해 숫자를 키우는 것)은 막지 못한다. 그것은 호출 지점의 권한과 감시가 맡는다.
5. **수요를 기록하는 RPC는 있지만 런타임 호출 지점이 아직 없다.** `weak_match`와 `normalized_theme`을 언제 기록할지,
   새 영역용 주제를 원문 없이 어떻게 정규화할지는 다음 실행기 단계에서 연결해야 한다. `other_uncovered` 전체 합계는 사용하지 않는다.
6. 쓸 validator profile은 §9-2에서 코드로 정했고, 검토된 별도 migration으로 등록하도록 만들었다.
   새 PostgreSQL에는 실제 적용해 확인했지만 **운영 DB에는 아직 적용하지 않았다.** 또한 실행기가 없으므로
   **운영 자동 활성화는 계속 완전히 닫혀 있다.**
7. **`service_role` 열쇠나 DB 주인 권한이 털리면** 이 경계는 아래에서 열린다.
8. **새 situationTag**는 허용된다. 런타임을 이 카탈로그에 연결하는 시점에 Analyzer 지시문의 태그 목록이 달라지므로,
   그 연결 단계에서 지시문 변경 규칙을 따로 정해야 한다.

## 9-1. 실제 PostgreSQL 검증 (2026-09-16)

깨끗한 임시 컨테이너 `public.ecr.aws/supabase/postgres:17.6.1.167`(PostgreSQL 17.6)에
`supabase/migrations`의 14개 파일을 이름 순서대로 전부 적용했다. 문법·제약·트리거 생성은 전부 통과했다.

### 실제로 잡힌 결함 하나 — 지연 트리거 권한

`set role service_role` 상태에서 `public.register_scripture_catalog_baseline(...)`을 부르면
함수 본문은 SECURITY DEFINER로 끝까지 성공하지만, **커밋 순간** 전체가 되돌아갔다.

```
ERROR:  permission denied for schema private
CONTEXT:  PL/pgSQL function private.check_scripture_catalog_pointer_transition()
```

- 포인터 전환 확인 트리거는 `deferrable initially deferred`다. 그래서 RPC가 반환된 **뒤**, 커밋 시점에 돈다.
- 그 시점은 SECURITY DEFINER 함수 **밖**이라 호출자(`service_role`) 권한이 쓰인다.
- `service_role`에는 `private` 스키마 권한이 없다(그것이 이 설계의 핵심이다). 그래서 확인 자체가 막혔다.
- 기준 등록만이 아니라 활성화·롤백의 포인터 전환도 같은 이유로 전부 막혔다. 즉 **모든 쓰기 경로가 죽어 있었다.**

**수정:** `private.check_scripture_catalog_pointer_transition()`에 `security definer` 한 줄을 더했다.
`set search_path = private, pg_catalog`, 모든 역할의 EXECUTE 회수, `deferrable initially deferred` 계약,
다른 함수·권한은 그대로다. 권한을 넓혀 막은 것이 아니라, 이미 있던 확인이 자기 일을 할 수 있게만 했다.

**확인:** 수정 뒤에도 이 트리거는 여전히 거절한다. 공지 기록 없이 포인터를 직접 넣어 보면
INSERT 문장은 통과하고(지연이 맞다) 커밋에서 `포인터 전환에 소유자 공지 기록이 없습니다.`로 전체가 롤백된다.

### 통과한 시나리오 (`service_role`로 호출, 89개 확인)

기준 등록과 재시도 멱등 / 연구 결과 없는 후보 거절 / 연구 결과 저장 후 후보 저장 /
validator profile 없이는 검증 묶음 저장 실패 + 부분 행 0건 / 검토된 profile 등록 후 검증·attestation 9건 저장 /
실제 집계와 evidence가 다르면 활성화 실패 + 포인터·활성화 행 무변경 / 집계를 맞춘 뒤 활성화 성공 /
같은 활성화 요청 재시도 시 행 무증가 / stale expected version 차단 / 조상 버전 롤백 성공과 멱등 /
후손 버전 롤백 차단 / 전환마다 공지와 포인터 revision이 같은 트랜잭션 / append-only 표의 UPDATE·DELETE 차단 /
포인터 직접 UPDATE는 전환 규칙으로 차단 / anon 실행 차단 / `service_role` 직접 테이블 접근·profile 자가 등록 차단 /
수요 기록 RPC는 서울 기준 오늘 칸만 1씩 증가하고 날짜 인자를 받지 않는다.

최종 상태: versions 2, candidates 1, validations 1, attestations 9, activations 1, rollbacks 1,
owner notifications 3, final pointer revision 3.

### 여전히 확인하지 못한 것

- **production Supabase에는 적용하지 않았다.** 운영 역할 설정·기존 데이터에서의 동작은 별도 확인이 필요하다.
- 동시 활성화 두 건이 실제로 부딪힐 때의 `for update` 대기·`serialization_failure`는 단일 연결로만 확인했고,
  두 연결을 동시에 붙여 겨루게 하지는 않았다.
- 이 89개 기반 검증 당시에는 profile 등록 migration이 없어 시험용 fixture를 DB 소유자로 넣었다.
  이후 실제 profile migration 자체는 §9-2처럼 별도의 새 DB에서 검증했다.

## 9-2. 실제 validator registry · 신학 검수 rubric · 실행 순서 (2026-09-16)

`supabase/functions/_shared/automatic-scripture-catalog-validator-registry.ts`가 단일 원본이다.
`20260916011019_register_automatic_scripture_catalog_validator_profiles.sql`은 그 단일 원본과 지문까지 같은
profile 네 개만 append-only 등록부에 넣는다. 로컬 새 PostgreSQL에서 적용했지만 **운영 DB에는 아직 적용하지 않았다.**

### profile 네 개

| profileId | 종류 | 맡는 검증 항목 | 모델 | independenceGroup |
|---|---|---|---|---|
| `aroeda-demand-counter` | `aggregate_counter` | `demandSignal` | 없음 | `aroeda-demand-aggregate` |
| `aroeda-deterministic-checker` | `deterministic` | `passageExistence`, `krvTextMatch`, `safetyBoundary`, `duplicateCheck`, `corpusRegression`, `candidateGenerationEvaluation` | 없음 | `aroeda-deterministic-suite` |
| `aroeda-theology-sol` | `model_evaluator` | `contextTheologyReview` | `gpt-5.6-sol` | `openai-gpt-5-6` |
| `aroeda-theology-astra` | `model_evaluator` | `contextTheologyReview` | `gpt-6-astra` | `openai-gpt-6` |

검증 항목 여덟 개 중 신학 평가 하나만 두 번 배정된다. 나머지 일곱은 정확히 한 번씩이다.
그래서 후보 한 건에 필요한 attestation은 모두 9개다.
실제 registry 객체와 profile·권한 배열은 실행 중 바꿀 수 없도록 고정했다.

`profiles` 배열은 계약이 요구하는 `profileId@profileVersion` 오름차순이라 Astra가 Sol보다 **앞**에 온다.
이것은 정렬 순서일 뿐 실행 순서가 아니다. 실행 순서는 아래 단계 데이터가 따로 정한다.

### Sol과 Astra를 고른 이유

신학 검수는 결정적 규칙으로 판정할 수 없다. 본문의 문맥을 실제로 읽어야 하고, 사람이 매번 보기에는 양이 많다.
그래서 모델 평가자 둘을 쓰되, 둘이 **서로 다른 세대의 모델**이어야 의미가 있다.
`gpt-5.6-sol`은 현재 이 저장소의 다른 평가 경로에서 이미 쓰는 세대이고, `gpt-6-astra`는 그다음 세대다.
세대가 다르면 같은 학습 경향에서 오는 같은 실수를 함께 놓칠 가능성이 줄어든다.

### Sol과 Terra를 독립 평가 둘로 세지 않은 이유

계약이 정한 독립성의 단위는 평가자 이름이 아니라 `independenceGroup`이고,
**같은 모델 계열·같은 운영 주체는 같은 그룹**이다. Terra는 Sol과 같은 `gpt-5.6` 계열이다.
계열이 같으면 편향도 대체로 같아서, 둘을 나란히 세워도 "서로를 검증한다"는 말이 성립하지 않는다.
그래서 registry의 모델 allowlist가 Sol과 Terra를 **같은 계열 `openai-gpt-5-6`으로 명시적으로 매핑**해 두었고,
누가 Terra를 다른 그룹 이름으로 적어 독립 평가 둘로 위장하면 정책 검사가 거절한다.
같은 이유로 Sol을 이름이나 지시문만 바꿔 두 번 부르는 것, 같은 profile을 두 번 부르는 것도 거절한다.
계열 판정은 이름에 어떤 글자가 들어 있는지 훑는 방식이 아니라 allowlist 매핑이다.
allowlist에 없는 모델은 계열을 **모른다**고 답하고, 모르면 거절한다.

### 신학 검수 rubric

버전 `aroeda-theology-rubric/v1`, 지문 `srub_6d2483bb9e76970d9b9dd767c08534a9abe371e38588b9f3b6cfe41b070aa672`.

기준 아홉 가지를 문자열 한 줄이 아니라 구조화된 읽기 전용 데이터로 두었다. 각 기준은
통과 조건 하나와 fail 사례 세 개를 가진다.

1. `context-fidelity` — 본문 문맥과 카드 설명이 일치하는가
2. `no-unpromised-outcome` — 본문에 없는 약속·결과를 보장하지 않는가
3. `no-divine-intent-claim` — 하나님의 구체적 뜻·계시·예언을 단정하지 않는가
4. `domain-tag-support` — 영역·상황 태그·목회 기능을 본문이 실제로 지지하는가
5. `crisis-guidance-precedence` — 위험 상황에서 말씀 추천이 안전 안내를 대체하지 않는가
6. `no-coerced-reconciliation` — 피해자에게 용서·인내·관계 유지를 강요하지 않는가
7. `krv-citation-integrity` — 개역한글 본문 위치와 인용이 왜곡되지 않았는가
8. `new-domain-distinctness` — 새 영역이 기존 영역과 구분되고 표시 이름이 자연스러운가
9. `uncertainty-defaults-to-fail` — 불확실하거나 근거가 부족하면 fail로 판정하는가

불확실할 때의 판정은 `fail`이고, 한 카드라도 fail이면 후보 전체가 fail이다.
rubric 버전은 Sol·Astra 두 profile의 `rubricVersion`과 정확히 같은 값이어야 한다.
**문구만 고치고 버전을 그대로 두는 실수**를 막기 위해 rubric 전체의 지문을 소스와 테스트 두 곳에 각각 못 박아 두었다.
한 글자만 바꿔도 다시 계산한 지문이 달라져 두 곳 모두에서 걸린다.

### 실행 순서와 Astra 호출 조건

| 순서 | 단계 | 담당 profile | 만드는 항목 |
|---|---|---|---|
| 1 | `demand-counter` | `aroeda-demand-counter` | `demandSignal` |
| 2 | `deterministic-checks` | `aroeda-deterministic-checker` | 결정적 여섯 항목 |
| 3 | `theology-sol` | `aroeda-theology-sol` | `contextTheologyReview` |
| 4 | `theology-astra` | `aroeda-theology-astra` | `contextTheologyReview` |

Astra는 **마지막 단계에서만** 부른다. 다음이 모두 참일 때만 호출할 수 있다.

- 수요 기준을 넘겼다.
- 결정적 검사 여섯 개가 모두 통과했다.
- Sol이 후보 카드 **전부에 정확히 한 번씩** pass를 냈다(누락·중복·후보 밖 카드가 있어도 안 된다).
- 후보 지문·기준 버전 지문·rubric 버전이 단계 사이에 바뀌지 않았다.

이렇게 두는 이유는 값이 비싼 마지막 평가를 **어차피 떨어질 후보에 쓰지 않기 위해서**다.
막을 이유가 하나라도 있으면 돌리지 않는다(fail-closed). 이 판단은 순수 함수이고 네트워크를 보지 않는다.

### 실제 DB 등록 검증 (2026-09-16)

`public.ecr.aws/supabase/postgres:17.6.1.167` 새 컨테이너에 전체 migration 15개를 순서대로 적용했다.
profile 4개, model evaluator 2개, 독립 그룹 4개가 정확히 등록됐고, 각 profile JSON·파생 열·고정 지문이 일치했다.
`service_role`은 profile 표에 직접 읽기·추가·수정·삭제 권한이 없으며, DB 소유자도 append-only 방아쇠 때문에
기존 profile을 수정하거나 지울 수 없음을 확인했다. 이 검증은 로컬 DB에만 해당하며 production 적용을 뜻하지 않는다.

### 이 단계에서 만들지 않은 것

- **실행기의 외부 연결부.** 순수 실행 핵심부는 §9-3처럼 만들었지만 OpenAI·DB를 실제로 부르는 연결 코드는 없다.
- **공지 발송기(dispatcher).** outbox를 읽어 내보내는 코드가 없다.
- **런타임 카탈로그 읽기.** 앱과 Edge Function은 여전히 Git 안의 정적 카드를 읽는다.

**남아 있는 위험은 그대로다.** profile attestation은 암호 서명이 아니다(§9의 4번).
등록부에 있는 profile을 `service_role`을 가진 쪽이 사칭하는 것은 이 registry로도 막지 못한다.

## 9-3. 자동 검증 실행기 순수 핵심부 (2026-09-16)

`automatic-scripture-catalog-validator-executor.ts`가 §9-2의 네 단계를 실제 순서대로 집행한다.
다만 이 파일은 DB·OpenAI·환경변수·시계를 직접 읽지 않는다. 수요 집계, 개역한글 resolver,
안전·코퍼스·생성 평가, Sol·Astra 평가 함수와 단계별 현재 지문을 주입받는 순수 오케스트레이션 경계다.
그래서 이 단계의 검증은 외부 호출 없이 재현할 수 있고, 실제 연결부는 별도 작업으로 남아 있다.

### 중단 규칙

- 수요 기준이 부족하면 결정 검사와 Sol·Astra를 모두 0회 호출한다.
- 결정 검사 여섯 항목 중 하나라도 실패하면 Sol·Astra를 모두 0회 호출한다.
- Sol 결과가 누락·중복·후보 밖 카드·알 수 없는 판정이면 결과를 꾸며 내지 않고 `unavailable`로 닫는다.
- Sol이 카드 하나라도 fail하면 실패 기록과 attestation을 남기고 Astra를 0회 호출한다.
- Astra는 앞 단계가 모두 통과하고 후보·기준 버전·rubric 지문이 그대로일 때만 한 번 호출한다.
- adapter는 status·profile·artifactHash를 정하지 못한다. 실행기가 등록 profile과 payload로 직접 만든다.
- 완성 기록은 기존 `validateAutomaticValidationRecord`로 다시 검증해 유효해야만 반환한다.

합격 기록은 필수 항목 8개와 attestation 9개(수요 1 + 결정 검사 6 + 독립 신학 평가 2)를 가진다.
결정 검사나 모델의 의미상 fail은 사실대로 봉인한 실패 기록을 반환하고, malformed 응답·연결 오류·단계 중 지문 변경은
가짜 실패 기록을 만들지 않고 `unavailable`로 반환한다. 원문 모델 응답이나 사용자 문장은 결과에 저장하지 않는다.

### 검토 중 발견해 함께 막은 개역한글 절 번호 결함

공유 계약(`automatic-scripture-catalog-activation-contract.ts`)의 독립 재검증은 resolver가 돌려준
**절 수**와 본문 지문은 확인했지만, 배열 안의 절 번호가 요청한 시작 절부터 연속되는지는 보지 않았다.
그래서 기록을 지을 때와 다시 확인할 때 **같은** resolver를 썼다면, 절 번호가 전부 밀려 있거나 본문이
빈 문자열이어도 지문은 자기 자신과 맞아떨어져 `pass`로 통과할 수 있었다. 실행기 자신은 이미 같은 확인을
안쪽에서 따로 하고 있어 실행기 단계 테스트만으로는 이 구멍이 가려져 있었다(겹치는 확인이 서로를 가린 경우).
공유 계약과 실행기 양쪽에서 시작 절부터 정확히 이어지는 절 번호와 빈 문자열이 아닌 본문을 확인하도록 고쳤고,
`automatic-scripture-catalog-activation-contract.test.ts`에 **같은 resolver를 짓기·확인 양쪽에 쓰면서** 절 번호를
1씩 밀거나 본문을 비운 두 가지 회귀 테스트를 새로 추가해 공유 계약 자체가 이 결함을 잡는지 직접 고정했다.

## 9-4. Sol·Astra 증거 확장과 OpenAI adapter (2026-09-16)

### 먼저 확인한 설계 공백

§9-3까지의 `TheologyEvaluationRequest`에는 `candidate`와 `rubric`만 있었다. 그것만으로는 rubric의
`context-fidelity`(본문 문맥과 카드 설명 일치), `krv-citation-integrity`(개역한글 인용의 정확성),
`new-domain-distinctness`(새 영역이 기존 영역과 실질적으로 구분되는지)를 평가자가 충분히 검토할 수 없었다.
본문이 실제로 무엇인지, 기존 영역이 무엇인지 평가자에게 주어지지 않았기 때문이다.

### 확장한 증거

`TheologyEvaluationRequest`에 두 필드를 추가했다.

- **`baselineDomains`** — 기준 카탈로그 영역만 `{id, displayName, description}` 셋으로, id 오름차순.
  기준 카탈로그의 51장 카드나 다른 항목은 넣지 않는다.
- **`verifiedPassages`** — 결정 검사(`deterministic-checks`) 동안 이미 확인한 개역한글 본문을
  `{cardId, passageIndex, passage, verses}`로, 후보 카드·본문 순서 그대로. **resolver를 신학 평가
  단계에서 다시 부르지 않는다** — 절 번호 연속성·비어 있지 않은 본문 검사를 통과한 값만 그대로 재사용한다.

Sol과 Astra는 `modelId`·`profileId`만 다르고 나머지 증거는 canonical JSON이 완전히 같다. 각 adapter에는
독립된 복사본이 가므로 한 adapter가 받은 증거를 바꿔도 원본이나 다음 평가자에게 새지 않는다.

### OpenAI adapter

`automatic-scripture-catalog-theology-openai-adapter.ts`가 `TheologyEvaluationRequest`를 Responses API
요청 spec으로, 응답을 `{cardId, verdict}` 배열로 결정적으로 옮긴다(이 카드 최종 verdict 계약은 §9-5에서
criterion 단위로 폐기·대체됐다 — 아래 설명은 이 단계 시점의 기록이다). 실제 fetch·환경변수·Supabase
연결은 없다 — 그 경계는 다음 단계(전송)의 몫이다.

요청 본문은 정확히 열두 개 필드(`model, instructions, input, reasoning, max_output_tokens, text, store,
stream, background, truncation, service_tier, tools`)로 고정했다. `temperature`·`top_p`는 없다. `store:
false`, `stream: false`, `background: false`, `tools: []`, 자동 재시도 0회, fallback 모델 없음. 모델
id는 `request.modelId`를 그대로 옮길 뿐이며, 이 파일은 Sol·Astra 상수를 알지 못한다 — registry가 이미
정한 것을 여기서 다시 정하지 않기 위해서다. `input`은 rubric 전체·candidate·baselineDomains·verifiedPassages를
`canonicalJson`으로 담아 키 순서까지 결정적이다.

응답 해석은 기존 후보 생성 adapter의 순서를 그대로 따른다: 객체 여부 → provider 오류 → incomplete →
completed 이외 상태 → 거절 → 답의 글 → JSON 1회 파싱 → 담는 자리 확인 → 카드 개수·차례·id·verdict 확인
→ 성공. 기술적 실패(오류·거절·모양 위반)와 모델이 유효한 모양으로 낸 `fail` 판정을 구분한다 — 후자는
정상 평가 결과다. 모델 원문·거절 문구·오류 메시지·설명·confidence는 어디에도 남기지 않는다.

### 이 단계에서 만들지 않은 것

- **fetch transport.** 이 adapter가 만든 요청 spec을 실제로 보내는 코드가 없다.
- **환경변수·Supabase 연결.** API 키를 읽거나 결과를 저장하는 코드가 없다.
- Edge Function·index·handler.

## 9-5. Criterion 단위 신학 attestation (2026-09-16)

### 폐기한 계약과 그 이유

§9-4까지 신학 평가는 카드마다 모델이 낸 **최종 verdict 하나**(`{cardId, verdict}`)만 저장했다.
그 verdict가 rubric의 아홉 기준 중 무엇 때문에 나왔는지는 어디에도 남지 않았다 — 모델이 "왜"를 답하지
않아도 되는 구조였다. 이 단계에서 그 계약을 **폐기**하고, 카드마다 rubric criterion 아홉 개 전부를
개별 판정한 결과만 저장하도록 바꿨다. **모델은 카드의 최종 verdict를 절대 내지 않는다.** 카드가
pass인지 fail인지는 "criterion 하나라도 fail이면 카드는 fail"이라는 규칙으로 코드가 계산한다.

### 새 계약

`contextTheologyReview.payload.evaluations[i].cardEvaluations`(옛 `cardVerdicts`를 대체):

```json
{
  "evaluations": [
    {
      "profileHash": "svp_…",
      "cardEvaluations": [
        {
          "cardId": "SC-052",
          "criteria": [
            { "criterionId": "context-fidelity", "verdict": "pass" },
            { "criterionId": "no-unpromised-outcome", "verdict": "pass" },
            { "criterionId": "no-divine-intent-claim", "verdict": "pass" },
            { "criterionId": "domain-tag-support", "verdict": "pass" },
            { "criterionId": "crisis-guidance-precedence", "verdict": "pass" },
            { "criterionId": "no-coerced-reconciliation", "verdict": "pass" },
            { "criterionId": "krv-citation-integrity", "verdict": "pass" },
            { "criterionId": "new-domain-distinctness", "verdict": "pass" },
            { "criterionId": "uncertainty-defaults-to-fail", "verdict": "pass" }
          ]
        }
      ]
    }
  ]
}
```

카드마다 criterion 아홉 개가 rubric(`THEOLOGY_REVIEW_RUBRIC.criteria`)과 정확히 같은 순서로, 빠짐없이,
한 번씩만 있어야 한다. `criterionId`·`verdict` 말고 다른 필드(설명, 확신도, 카드 최종 verdict 등)가
있으면 그 기록은 무효다. `artifactHash`·attestation은 이 criterion별 전체 결과에 그대로 묶인다
(payload 전체를 해시하는 기존 방식은 바뀌지 않았다 — 담기는 내용만 바뀌었다).

`activation-contract.ts`가 새로 고정한 canonical 순서는 `THEOLOGY_CRITERION_IDS`(9개)다. registry.ts의
실제 rubric(`THEOLOGY_REVIEW_RUBRIC.criteria`)과 값이 같아야 하며, 그 사실은 registry 쪽 테스트가
대조해 고정한다 — `activation-contract.ts`는 순환 참조를 피하려고 registry.ts를 참조하지 않는다.

### 실행기·adapter 변경

- 실행기(`validator-executor.ts`)의 `parseCardCriterionEvaluations`가 Sol·Astra의 원시 출력을 카드별
  criterion 배열로 옮긴다. 카드 개수·차례·id, criterion 아홉 개의 개수·차례·id, verdict 모양 중
  하나라도 어긋나면 `null`(→ `unavailable`)이다. `cardFinalVerdict`가 "criterion 전부 pass여야 카드
  pass"를 계산해, 이 값만 Astra 게이트(§9-2)와 attestation에 쓴다.
- OpenAI adapter(`theology-openai-adapter.ts`)의 담는 자리 이름이 `cardVerdicts`에서 `cardEvaluations`로
  바뀌었다. 답의 모양(schema)에는 카드 최종 verdict를 담을 자리가 애초에 없다 — `cardId`·`criteria`
  둘뿐이고, `criteria`의 각 항목도 `criterionId`·`verdict` 둘뿐이다. 지시문도 "카드 전체의 최종 판정은
  절대 내지 않는다"고 명시한다.

### 테스트로 잡은 실제 결함(가려짐)

criterion 개수·순서 검사를 하나씩 지워 보는 변형 12개 중, 처음에는 **6개가 잡히지 않았다**. 구현은
전부 옳았지만 두 가지 이유로 가려져 있었다.

1. **호출 스택 테스트의 "prefix 겹침".** 배열 앞쪽 원소를 지운 테스트(`.slice(1)`)는 위치가 밀려 앞쪽에서
   바로 어긋나 버려서, 정작 "개수 자체를 대조하는지"는 시험하지 못했다. **뒤쪽**을 지우는(`.slice(0, -1)`)
   경우를 추가해서야 개수 검사가 빠지면 실제로 새는 것을 확인했다(executor 2건, adapter 1건).
2. **계약 테스트의 "artifactHash 겹침".** `activation-contract.test.ts`의 기존 "규칙상 실패" 표는
   `artifactHash`를 다시 봉인하지 않은 채로 payload만 바꿔, 내가 새로 추가한 3개 항목이 실제로는
   criterion 검사가 아니라 "지문 재계산 불일치"라는 훨씬 앞선 검사에 걸려 통과하고 있었다. 기존
   "겹침에 가려지지 않는 단일 규칙" describe 블록의 관례(`resealRecord`로 지문을 다시 맞춘 뒤 검사)를
   그대로 따라 옮기고 나서야 criterion 순서·카드 여분 필드·카드 id 대조 각각을 독립적으로 증명했다.

다시 돌렸을 때 12개 변형이 모두 실패로 잡히고, 파일은 변형 전과 바이트 단위로 같게 복원된다.

## 9-6. Criterion 계약 v3 DB 업그레이드와 실제 PostgreSQL 검증 (2026-09-16)

§9-5에서 신학 평가 payload를 `cardVerdicts`에서 `cardEvaluations`로 바꾼 것은 저장 계약의
호환 불가능한 변경이다. TypeScript만 바꾼 상태에서는 기준 migration의 활성화 RPC가 여전히
`cardVerdicts`를 요구했다. 깨끗한 PostgreSQL 17.6 컨테이너에 v3 이전 migration과
criterion 단위 fixture를 적용해 실제로 재현한 결과는 다음과 같았다.

```text
ERROR: 독립 평가가 등록된 서로 다른 그룹에서 합의하지 않았습니다.
activation=0, pointer_revision=1, owner_notification=1
```

`20260916141221_upgrade_automatic_scripture_catalog_validation_v3.sql`을 후속 migration으로 추가했다.
이미 추적된 기준 migration과 validator profile 등록 migration은 수정하지 않았다. 새 migration은
검증 기록 표의 버전 제약을 `automatic-scripture-catalog-validation/v3`으로 바꾸고, 검증 저장 RPC와
활성화 RPC 두 개만 `create or replace`한다. 활성화 RPC는 evaluation·카드·criterion 세 층의 정확한
필드, 후보 카드 순서, rubric criterion 아홉 개의 순서와 개수, 모든 `pass`, 등록 profile·독립 그룹·
attestation 연결을 DB에서 다시 확인한다. 옛 v2 기록과 `cardVerdicts` payload는 거절한다.

깨끗한 컨테이너 두 개에서 모든 migration을 순서대로 적용해 실제 `service_role` 경로를 확인했다.

- 정상 경로 **13/13**: v3 기록 저장, attestation 9건, criterion 전부 pass 활성화, 포인터·활성화·
  소유자 공지가 같은 revision의 한 트랜잭션으로 생성됐다. 최종 상태는
  `versions=2, candidates=1, validations=1, attestations=9, activations=1, owner_notifications=2, pointer_revision=2`.
- 실패 경로 **23/23**: criterion 하나 fail·누락·중복·순서 변경·잘못된 id·여분 필드, 카드 누락·
  순서 변경·여분 필드, 옛 `cardVerdicts`, v2 계약을 각각 독립 후보로 확인했다. 모든 활성화 실패에서
  포인터·활성화·공지가 변하지 않았다. 최종 상태는
  `versions=12, candidates=11, validations=10, attestations=90, activations=0, owner_notifications=1, pointer_revision=1`.
- 합계 **36/36** 통과. v3 이전 결함 재현도 별도 컨테이너에서 다시 확인했다.

이 검증은 로컬 Docker 컨테이너에서만 수행했다. production Supabase에는 migration이나 데이터를
적용하지 않았다. 검증 과정에서 사용한 fixture·스크립트는 `/private/tmp`에만 있으며 제품 파일이 아니다.

## 9-7. Sol·Astra 신학 평가 OpenAI fetch transport (2026-09-17)

`automatic-scripture-catalog-theology-openai-fetch-transport.ts`가 §9-4 adapter와 §9-3 실행기 사이의
실제 Responses API 전송 경계를 구현한다. 서버에서 주입받은 `OPENAI_API_KEY`가 쓸 수 있는 문자열인지
먼저 확인하고, adapter가 만든 body를 `https://api.openai.com/v1/responses`에 정확히 한 번 POST한다.
spec의 60초 제한은 응답 본문을 다 읽을 때까지 적용되며, 자동 재시도·fallback model·fallback key는 없다.

정상 HTTP 응답은 기존 `interpretTheologyEvaluationOpenAIResponse`에 그대로 넘긴다. 이 adapter가
`success`로 확인한 카드별 criterion 판정만 실행기에 돌려준다. criterion의 `fail`은 기술적 실패가 아니라
정상 평가 결과이며, 카드 최종 pass/fail은 기존 실행기가 계산한다. incomplete·refusal·빈 응답·JSON 오류·
계약 위반은 각각 정제된 transport 오류로 끝나고, 원본 응답·오류 문구·HTTP 상태·열쇠는 남기지 않는다.
408은 timeout, 429와 5xx는 unavailable, 그 밖의 non-2xx는 provider error로 분류하되 오류 본문은 열지 않는다.

전송 테스트 32건은 실제 네트워크 대신 가짜 fetch를 사용해 body·모델 id 보존, Sol/Astra 분리, criterion
`fail` 전달, 자격 누락 시 호출 0회, fetch·본문 timeout, HTTP 400/401/403/404/408/429/500, adapter의
모든 실패 결과 매핑, 비밀정보 비노출과 책임 경계를 확인했다. 이 단계는 transport까지만 구현했으며
Edge Function·DB 오케스트레이션에는 아직 연결하지 않았다. 실제 OpenAI 호출도 하지 않았다.

추가로 자격 사전 확인 제거, 요청 body 변조, non-2xx 오류 본문 읽기, fetch 실패의 timeout 오분류,
adapter 실패를 빈 성공으로 변경, criterion 기대 순서 정렬의 여섯 변형을 각각 넣었다. 신규 테스트가
**6/6 모두 실패로 잡았고**, transport 원본은 변형 전 SHA-256과 같은 상태로 복원했다.

## 9-8. 자동 검증용 활성 카탈로그·수요 읽기 RPC (2026-09-17)

validator 실행기가 요청 본문에 실린 기준 카탈로그나 수요 숫자를 믿지 않도록,
`get_scripture_catalog_validation_context` 읽기 RPC를 추가했다. 입력은 후보에 이미 봉인된 수요 연결의
종류(`weak_match` 또는 `normalized_theme`)와 대상 키, 과거 날짜 범위뿐이다. 사용자 문장·사용자 번호·
기기·IP·인증값은 입력과 출력에 없다.

RPC는 활성 포인터와 그 버전의 카탈로그를 DB에서 읽고, 요청한 대상·기간의 수요 행만 날짜 오름차순으로
돌려준다. 기존 영역 수요는 대상 영역이 활성 카탈로그에 실제로 있을 때만 허용한다. 기간은 최대 90일이며
서울 기준 오늘과 미래는 거절한다. 함수는 `stable security definer`, 고정 `search_path`이고 실행 권한은
`service_role`에만 있다. `anon`·`authenticated`는 실행할 수 없고 `service_role`도 private 표를 직접 읽을
수 없다.

TypeScript 경계는 응답의 최상위 필드와 수요 행 필드를 exact-fields로 검사하고, 포인터 revision·날짜·
정렬·중복·횟수·대상 일치를 확인한다. DB가 돌려준 활성 버전 지문도 카탈로그 내용에서 다시 계산한다.
DB가 기록하지 않은 날짜는 응답에서 생략하며, 실행기의 기존 수요 계산 단계가 0으로 채운다.

깨끗한 PostgreSQL 17.6 컨테이너에 모든 migration을 순서대로 적용하고 실제 `service_role` 경로를 검사했다.
정상 weak-match·normalized-theme 응답, 빈 집계, 다른 대상 필터링, 잘못된 종류·키·기간·오늘/미래·비활성
영역 거절, 사용자 역할 실행 차단, private 표 직접 접근 차단까지 **18/18** 통과했다. 호출 전후 카탈로그
버전 수·포인터 수와 두 수요표의 전체 JSON 체크섬도 같아 읽기 전용임을 확인했다. 임시 컨테이너는
검증 뒤 삭제했고 production Supabase에는 적용하지 않았다.

### fetch transport (`automatic-scripture-catalog-validation-context-fetch-transport.ts`)

이 RPC를 실제로 부르는 경계다. Supabase URL·`service_role` 키는 환경변수를 직접 읽지 않고 호출자가
주입하며, 이 파일은 `Deno.env`·`process.env`·DB 클라이언트·로그를 갖지 않는다. 요청은 한 번만 보내고
자동 재시도·fallback이 없다(`VALIDATION_CONTEXT_FETCH_TRANSPORT_POLICY`).

URL은 프로토콜이 http/https이고 자격·query·fragment가 없는 값만 받아 `/rest/v1/rpc/<함수명>`을 이어
붙인다. RPC 본문은 `p_evidence_kind`·`p_subject_key`·`p_window_start_date`·`p_window_end_date` 네
필드뿐이다. 타임아웃은 `AbortController`로 fetch 호출과 응답 본문 읽기 전체를 함께 덮고, 실패하면
한 번만 시도한 채로 끝난다. HTTP 상태가 2xx가 아니면 본문을 읽지 않고 바로 실패로 옮긴다(408→timeout,
429·5xx→unavailable, 그 밖의 non-2xx→error). 어떤 실패 경로도 원본 URL·키·HTTP 상태 숫자·응답 원문을
오류 객체에 담지 않는다 — 오류는 정해진 종류 이름 하나만 갖는다. 성공 응답은 원문을 그대로 돌려주지
않고 `parseValidationContextRpcResponse`를 통과해 다시 지은 값만 돌려준다.

검수 중 테스트 자체의 결함 세 가지를 고쳤다(구현이 아니라 테스트가 틀렸다).

1. `ok(validResponse(THEME))`처럼 async 함수의 반환값(Promise)을 그대로 `JSON.stringify`해 `{}`가
   되던 두 곳 — `ok(await validResponse(...))`로 고쳤다.
2. 소스 경계 테스트가 주석의 "service_role"이라는 역할 이름까지 금지어로 걸어 오탐하던 것 —
   금지어를 실제 직접 접근 흔적인 `SUPABASE_SERVICE_ROLE_KEY`로 좁혔다. transport가 주입된
   `serviceRoleKey`를 쓰는 것은 정상이다.

세 건을 고친 뒤 fetch transport 구현을 처음부터 독립적으로 다시 읽고, 위 다섯 항목(URL 조립·자격
차단·exact params·1회 호출·timeout 범위, non-2xx 미독해, 오류 비유출, 검증 통과 값만 반환, 재시도·
환경변수·DB 쓰기·로그 부재)을 하나씩 코드로 대조했다. 그 과정에서 기존 "원본을 그대로 돌려주지 않는다"
테스트가 실제로는 아무것도 증명하지 못한다는 것을 발견했다 — `JSON.stringify`/`JSON.parse`를 거치면
어떤 구현이든 항상 새 객체가 나오므로, "참조가 다르다"는 것만으로는 구현이 진짜 검증을 거쳤는지 가릴
수 없었다. 직렬화를 우회해 원본 참조를 살려 두는 새 헬퍼(`okObject`)로 테스트를 다시 만들었다.

변형 검증(mutation testing) 8건 — non-2xx 본문 읽기 허용, URL 자격·query 허용, 오류에 HTTP 상태 새김,
잘못된 기간 통과, timeout이 fetch를 덮지 않음, 검증 전 원본 반환, 재시도, timeout 상한 제거 — **8/8
모두 잡혔다**(원본 파일은 변형 전과 바이트 단위로 같게 복원). timeout·재시도 관련 변형 2건은 테스트가
깔끔한 실패 대신 실제로 멈춰 버리는 방식으로 드러났다 — 타이머가 실제로 fetch를 붙잡고 있다는 것의
방증이지만, CI에서는 "느린 실패"로 보일 수 있어 별도로 타임아웃을 씌워 확인했다.

실제 fetch·Supabase 프로젝트·운영 호출은 하지 않았다. 이 파일과 테스트는 모두 가짜 fetch로만
검증했다.

## 9-9. 고정 분석 스냅샷 계약 v1 — safetyBoundary·corpusRegression만 (2026-09-17)

### 무엇을 메우려 했는가

§9의 4번과 §10에 이미 적어 둔 공백이다: `safetyBoundary`·`corpusRegression`·
`candidateGenerationEvaluation` 세 결정적 검사는 실행기에 함수로 주입받는 자리만 있고,
그 판단 근거(독립 검증된 고정 분석)가 저장소에 없었다. 더 심각하게는, 오늘의
`validateAutomaticValidationRecord` 재확인이 이 세 검사의 payload를 **모양만** 보고
원본 코퍼스나 Analyzer를 다시 돌려 확인하지 않는다는 것도 이번에 다시 확인했다 —
adapter가 `expectedRoute`/`observedRoute`나 `baseline`/`candidate` 양쪽 값을 스스로
지어내도 오늘 구조에서는 통과한다.

이번 작업은 이 공백을 메울 **"고정 분석 스냅샷"의 순수 계약(타입과 검증 함수)만** 만들었다.
"고정"은 사람이 미리 승인했다는 뜻이 아니다 — 운영 정책은 자동 검증 → 자동 활성화 → 소유자
공지이고 활성화 전 사람 승인을 요구하지 않는다. `reviewedBy`·`reviewedAt`·사람 서명·승인
필드는 이 계약 어디에도 없다(§9-10에서 이름을 `FrozenAnalysisSnapshot`으로 다시 정리했다).
`safety_boundary`·`corpus_regression` 두 종류만 Git에 고정할 수 있게 지원한다.
`candidate_generation`(후보 카드별 최소 3개 생성 사례)은 이번 계약에 넣지 않았다 — 후보가
생길 때마다 새로 생기므로 Git에 미리 고정할 수 없고, 후보 생성 모델이 자기 사례를 스스로
지어 자기 채점하는 것을 막을 독립성 결속(사례 저작 profile과 그 independence group,
candidateHash, research-result artifact hash)이 오늘의 validator-registry에 아예 없기
때문이다. 이 사실은 새 파일의 문서 주석에만 남겼다.

### 새 파일

- `supabase/functions/_shared/automatic-scripture-catalog-analysis-snapshot-contract.ts` (신규)
- `src/lib/automatic-scripture-catalog-analysis-snapshot-contract.test.ts` (신규)

### 스냅샷이 결속하는 값

`FrozenAnalysisSnapshot`(§9-10 이전 이름 `ReviewedAnalysisSnapshot`)은 `contractVersion`·
`sourceCorpusArtifactHash`(원본 문장·기대값의 지문)·`frozenAnalysisArtifactHash`(동결된
분석만의 지문 — 코퍼스는 그대로인데 분석만 다시 만들어진 경우와 코퍼스 자체가 바뀐 경우를
구분해 알아보려고 둘을 분리했다)·`environment`(Analyzer
모델·지시문·스키마·태그 사전·domain 목록의 지문, Gate·Matcher의 명시적 결속, 기준 카탈로그
지문)·`cases` 배열(caseId 오름차순, 사례마다 합성 문장·동결된 `SituationAnalysis`·종류별
기대값)을 하나의 `fingerprint`로 묶는다. `fingerprint`는 `canonicalJson`(기존
automatic-scripture-catalog-contract.ts의 것을 그대로 재사용 — 객체 key 순서에는 흔들리지
않고 배열 순서는 그대로 반영한다)으로 전체를 지문화하므로, 사례 하나의 text·analysis·expected나
environment 값 하나만 바뀌어도 저장된 fingerprint와 다시 계산한 값이 달라진다.

`safetyBoundary`는 후보 카드 품질을 증명하지 않는다 — Gate의 안전 판정은 candidate 카드를
보기 전에 끝나므로, 전체 추천 파이프라인의 후보-무관 전역 회귀 가드로 타입·주석·테스트에
명시했다. `corpusRegression`의 기대값은 기존 153개 자연어 코퍼스
(`scripts/scripture-recommendation-evaluation-cases.ts`)의 recommend/domain_choice/
no_coverage 세 경로와 같은 정보를 표현하지만, Edge Function이 `scripts/` 바깥을 참조할 수
없으므로 타입을 다시 이 파일 안에 같은 뜻으로 정의했다(import하지 않았다).

### validator가 fail-closed로 보는 것

`validateAnalysisSnapshot`은 저장된 fingerprint를 신뢰하지 않고 항상 다시 계산해 대조한다.
그 밖에 최상위·중첩 객체의 정확한 필드 집합(스키마에 없는 필드는 전부 거절 — 사람 승인 필드나
raw response·reasoning·token usage류 필드가 들어갈 자리 자체가 없다)을 확인한다. **이 exact-
fields 검사는 `analysis` 자체와 `analysis.safety` 안에도 그대로 들어간다** — 처음에는
스냅샷 자신이 선언한 필드(최상위·environment·case 공통 필드·expected)에만 exact-fields를
적용했는데, `analysis`는 값이 공용 `SituationAnalysis` 타입이라 그 안에 `rawResponse`·
`userId`·`analysis.safety.sessionId` 같은 여분의 필드를 얹어도 `validateSituationAnalysis`
혼자서는 걸러내지 못했다(그 함수는 알려진 필드의 *값*만 검사하지, 모르는 필드가 얹혀 있는지는
보지 않는다). 공용 `situation-analysis.ts`는 고치지 않고, 이 계약 안에서만 `analysis`와
`analysis.safety`에 각각 exact-fields를 별도로 적용해(허용 필드는 `SituationAnalysis`
타입과 정확히 같은 11개, `safety`는 `level`·`categories` 2개) 이 공백을 막았다. `candidate_generation`
명시적 거절, caseId 오름차순·중복 금지, 빈 cases 거절, 종류별 기대값 모양, 모든 동결 분석을
**타입상 맞아 보인다는 이유로 신뢰하지 않고 실제 `validateSituationAnalysis`로 재검사**,
artifact hash·catalog version hash 형식을 확인한다. 사례 문장 값 자체는
`scanForbiddenContent`로 이메일·jwt·ip·uuid·비밀키 패턴을 추가로 확인한다 — 다만 이
함수의 일반 목적 개인정보 키 목록(`PROTECTED_CONFIGURATION_KEYS`)에는 `safety`가 들어
있어(자동 카탈로그 후보가 안전 설정을 못 바꾸게 막는 목적) `SituationAnalysis.safety`
필드와 이름이 겹친다는 것을 조사 중 발견했다. 그래서 전체 스냅샷 객체가 아니라 사례의
`text` 문자열 값에만 이 함수를 좁혀서 적용했다 — PII 부재를 의미적으로 완전히 증명한다고
과장하지 않는다.

mutation 검증(테스트 파일 안에 포함, 별도 스크립트 없음)으로 text·분석 태그·expected 값·
environment의 모델·스키마·태그 사전·domain manifest·Gate·Matcher·기준 카탈로그 결속·저장된
fingerprint 자체를 하나씩 바꿔 보았다. 각 mutation은 그 항목만 바꾸고 다른 모든 필드는
유효하게 유지해, "다른 검사가 우연히 먼저 잡는" 겹침 없이 fingerprint 재계산 검사 자체가
잡는지 정확히 대조했다(`assert.deepEqual(result.errors, ['snapshot.fingerprint: ...'])`로
그 mutation에서 오류가 정확히 그 하나뿐임을 확인). 36개 테스트 전부 통과했다.

### 이번 작업이 하지 않은 것 (다음 작업이 이어받을 것)

- 실제 스냅샷 데이터를 만들지 않았다. `automatic-scripture-catalog-validator-executor.ts`의
  `DeterministicAdapters`에 연결하지 않았다. `validateAutomaticValidationRecord`를 고치지
  않았다(이 함수는 여전히 §9의 4번에 적은 대로 payload 모양만 본다 — 이번 계약이 존재한다는
  사실이 activation-ready를 뜻하지 않는다). DB에 쓰지 않았다. OpenAI를 부르지 않았다.
- `environment` 결속 값들이 **지금 저장소의 실제 값과 같은지**는 이번 계약이 확인하지
  않는다 — 스냅샷 "안에서" 그 값들이 지문에 결속돼 몰래 못 바뀌게만 보장한다. "지금 값과
  같은가"의 실제 대조는 실행기 연결 단계의 몫이다.
- `analyzerDomainManifestHash`는 오늘의 정적 `SituationDomain` 목록의 지문일 뿐이다. 동적
  Analyzer domain manifest(활성 카탈로그에서 유도, prompt/schema/runtime validator가 같은
  manifest를 쓰고, manifest 지문이 스냅샷 environment에 결속되고, catalog pointer 전환과
  원자적으로 맞물리고, 롤백 시 두 상태가 함께 복원되는 것)가 없으므로, **새 영역
  (`new_domain_with_cards`) 후보의 자동 활성화는 이 기능이 생기기 전까지 fail-closed로 막혀
  있어야 한다.** 이번 작업은 이 기능을 만들지 않았다.
- `candidate_generation`을 append-only DB 기록으로 설계하는 것, 그 기록을 candidateHash·
  research-result artifact hash·자동 사례 저작 profile과 그 independence group·분석 환경
  지문에 결속하는 것, 후보 생성 모델과 사례 저작 모델의 독립성을 자동으로 검증하는 것.
- Supabase 공식 changelog를 확인했다. 이 순수 TypeScript 계약(타입·`canonicalJson`·SHA-256
  지문 계산뿐이고 Supabase SDK·DB·Edge Function 런타임을 부르지 않는다)에 영향을 주는 2026년
  breaking change는 없었다. TypeScript SDK 관련 항목(2027-01-31부터 TypeScript 4.7~4.9 지원
  중단 예고)은 미래 일정이고 이번 변경과 무관하다.

## 9-10. 고정 분석 스냅샷 계약 v1 — 독립 검수 결함 수정 (2026-09-17, 후속)

### 독립 검수가 찾아낸 것

§9-9의 계약을 그대로 둔 채 다음 스냅샷을 넣으면 **통과했다**(실제로 재현해 확인).

- `safety_boundary` 사례 하나만 있고 `corpus_regression`은 0개
- 그 사례의 frozen analysis는 `safety.level = urgent`인데, expected는
  `expectedRoute = recommend`·`expectedSafety.level = normal`(분석과 기대값이 서로 다른
  사건을 가리킨다)
- `sourceCorpusArtifactHash`·`frozenAnalysisArtifactHash`는 cases와 전혀 무관한, 형식만
  맞는 임의의 해시
- `recommendationGate`·`scriptureMatcher`도 임의의 version 문자열
- 이 값들 그대로 top-level `fingerprint`만 다시 계산해 "자기 일관"되게 맞춤

원인은 두 가지였다. (1) `sourceCorpusArtifactHash`·`frozenAnalysisArtifactHash`를 형식만
확인하고 cases에서 다시 계산해 대조하지 않았다 — top-level fingerprint가 이 두 값을
"있는 그대로" 지문에 섞을 뿐, 그 값 자체가 cases에서 정직하게 나왔는지는 아무도 보지
않았다. (2) frozen analysis와 expected 사이에 교차 검증이 전혀 없어, 서로 모순되는 두
값(위험하다는 분석 + 안전하다는 기대값)이 각각 모양만 맞으면 나란히 통과했다. 두 검사
종류(safetyBoundary·corpusRegression) 중 하나가 아예 없어도 막는 장치도 없었다.

이 결함을 `src/lib/automatic-scripture-catalog-analysis-snapshot-contract.test.ts`의
"[재현]" 테스트로 먼저 고정한 뒤(수정 전 코드에서 이 스냅샷이 통과한다는 것을 확인한
근거는 이번 수정으로 새로 생긴 세 검사— 하위 해시 재계산, 두 종류 존재 확인, 교차
일관성 — 중 무엇을 걷어내도 이 스냅샷이 다시 통과한다는 것으로 갈음한다), 아래 네 가지를
고쳤다.

### 수정 1 — 하위 해시를 cases에서 직접 재계산

`computeSourceCorpusArtifactHash(cases)`(사례마다 `{caseId, kind, text, expected}`만
투영)와 `computeFrozenAnalysisArtifactHash(cases)`(사례마다 `{caseId, analysis}`만 투영)를
새로 추가했다. 둘 다 기존 `computeArtifactHash`·`canonicalJson`을 그대로 쓴다.
`validateAnalysisSnapshot`은 이제 저장된 두 값을 이 두 함수의 결과와 **직접 대조**한다 —
형식만 맞으면 통과하던 것을 없앴다. 재계산 순서는 source → frozen → top-level fingerprint
이고, 앞선 검사(사례 모양, 이 두 하위 해시)가 하나라도 실패하면 뒤 검사는 시도하지 않는다
(오염된 입력으로 지문을 계산해 혼란스러운 오류를 내지 않기 위해서다). 그 결과 "cases를
고치고 하위 해시·최상위 지문을 안 고치면" 항상 **가장 먼저 어긋난 해시 하나만** 오류로
남는다 — text를 고치면 source 쪽이, analysis를 고치면 frozen 쪽이 잡는다는 것을 테스트로
직접 대조했다.

### 수정 2 — 두 검사 종류가 모두 존재해야 함

`cases` 안에 `safety_boundary`·`corpus_regression`이 각각 최소 1개씩 있는지 본다. 개수
상한이나 정확한 개수는 두지 않았다(§9의 안전 경계 코퍼스는 "개수를 고정하지 않는다"는
기존 방침과 같다). 한 종류만 있으면 `snapshot.cases: (없는 종류) 사례가 최소 1개 있어야
합니다.`로 거절한다.

### 수정 3 — frozen analysis와 expected의 교차 일관성

`validateSituationAnalysis`와 사례별 expected 모양 검사가 각각 통과한 뒤에만
`validateCrossConsistency`를 부른다(모양이 이미 어긋난 값에 안전하지 않게 접근하지
않으려고).

- `safety_boundary`: `expectedSafety`가 `analysis.safety`와 canonical 값까지 정확히
  같아야 하고, `analysis.safety.level !== 'normal'`이면 `expectedRoute`는 반드시
  `safety`, `level === 'normal'`이면 `expectedRoute`는 `safety`일 수 없다.
- `corpus_regression`은 공통으로 `analysis.safety.level`이 `normal`이어야 한다(이 종류는
  안전 route를 표현하지 않는다). `recommend`는 `domainPriority === 'resolved'`·
  `primaryDomain === expectedPrimaryDomain`·fallback 아님을, `domain_choice`는
  `domainPriority === 'needs_choice'`·`primaryDomain === null`·
  `expectedDomainChoiceCandidates`가 `domainChoiceCandidates`와 **순서까지** 같음을,
  `no_coverage`는 `domainPriority === 'resolved'`·`primaryDomain === FALLBACK_DOMAIN`을
  본다.

### 수정 4 — 사람 승인 의미 제거

`ReviewedAnalysisSnapshot`을 `FrozenAnalysisSnapshot`으로 이름을 바꿨다. 파일 제목·주석의
"검토된 분석 스냅샷"·"미리 검토해 동결한"·"사람 검토 포함" 표현을 "고정 분석 스냅샷"·
"자동으로 만든 뒤 독립적으로 검증할"·"자동 생성 + 독립 검증 예정"으로 고쳤다. 활성화 전
사람 승인을 요구하지 않는다는 정책(자동 검증 → 자동 활성화 → 소유자 공지)과 `reviewedBy`·
`reviewedAt`·사람 서명·승인 필드 금지는 원래부터 이 계약 어디에도 없었고 지금도 없다 —
이번 수정은 이름과 주석의 오해 소지만 없앴다. 자동 producer profile과 독립성 attestation이
validator-registry에 실제로 연결되기 전까지는 이 계약이 activation-ready를 뜻하지 않는다는
설명은 그대로 유지했다(§9-9의 "이번 작업이 하지 않은 것" 그대로).

### 수정 5 — 중첩 exact-fields: `analysis`와 `analysis.safety`도 여분의 필드를 거절한다 (후속, 같은 날)

독립 검수가 다시 확인해 보니, 유효한 `corpus_regression` 사례의 `analysis`에
`rawResponse: 'provider output'`·`userId: 'user-123'`을 얹고 두 하위 해시와 top-level
fingerprint를 전부 올바르게 재계산하면 여전히 `{ valid: true, errors: [] }`로 통과했다.
`analysis.safety.sessionId`도 마찬가지였다(안전 사례가 아니라 corpus 사례에 넣어
재현해, `expectedSafety` canonical 비교가 우연히 잡아 주는 것과 구별했다). 원인은
"validator가 fail-closed로 보는 것"에서 이미 적었던 "스키마에 없는 필드는 전부 거절"이
스냅샷 자신이 선언한 필드(최상위·environment·case 공통·expected)에만 적용됐고,
`analysis`는 값이 공용 `SituationAnalysis` 타입이라 그 exact-fields 그물 밖에 있었기
때문이다 — `validateSituationAnalysis`는 알려진 필드의 값만 검사할 뿐 여분의 필드를
거절하지 않는다.

이 두 fixture를 `[재현]` 테스트로 먼저 고정한 뒤, 공용 `situation-analysis.ts`는 고치지
않고 이 계약 파일 안에서만 `validateAnalysisShape(analysis, label)`를 추가했다.
`analysis`는 `SituationAnalysis` 타입과 정확히 같은 11개 필드(`domainPriority`·
`primaryDomain`·`domainChoiceCandidates`·`secondaryDomains`·`situationTags`·
`emotionTags`·`spiritualQuestionTags`·`prayerModes`·`pastoralFunctions`·`safety`·
`confidence`)만, `analysis.safety`는(plain object일 때만) `level`·`categories` 2개만
허용한다. 검사 순서는 (1) `analysis`가 plain object인지 → (2) `analysis` exact-fields →
(3) `analysis.safety` exact-fields(plain object일 때만) → (4) 기존
`validateSituationAnalysis` → (5) 기존 expectation·교차 일관성이며, 뒤 단계는 앞 단계가
전부 통과했을 때만 실행한다(모양이 이미 어긋난 값에 안전하지 않게 접근하지 않기 위해서다).

새로 추가한 exact-fields 검사를 실제로 걷어내고(값을 반환하지 않는 no-op으로 바꿔) 새
테스트 7개(재현 2개 + `analysis.userId`/`rawResponse`/`tokenUsage`/`analysis.safety.
sessionId`/`providerErrorMessage`)를 돌려 **정확히 그 7개만** 실패하는 것을 확인한 뒤
원본으로 되돌렸다(바이트 단위로 같음을 diff로 확인) — 다른 검사가 우연히 잡아 주고 있던
것이 아니라는 것을 이렇게 증명했다.

### 수정 6 — 현재 환경 결속 계층 (후속, 2026-09-17)

§9-9·수정 5까지의 `validateAnalysisSnapshot`은 스냅샷 "안에서" 값들이 서로 일관되는지만
본다. `environment.analyzerModel: 'arbitrary-model'`처럼 지금 저장소와 아무 관련 없는
값이라도, 나머지 하위 해시·cases·top-level fingerprint를 전부 그 값에 맞춰 올바르게
다시 계산하면 **내부적으로는 완전히 일관되므로** `validateAnalysisSnapshot` 혼자로는
통과한다 — 이 함수는 애초에 "지금 값과 같은가"를 확인하겠다고 약속한 적이 없다(§9-9
`AnalysisSnapshotEnvironmentBinding` 타입 주석에 이미 그렇게 적혀 있다). 이번 작업은
그 위에 "지금 환경과 같은가"를 보는 순수 계층 하나를 새로 얹었다.

**새 파일**: `supabase/functions/_shared/automatic-scripture-catalog-analysis-environment.ts`,
`src/lib/automatic-scripture-catalog-analysis-environment.test.ts`(17건).

**`buildCurrentAnalysisSnapshotEnvironment(baselineCatalogVersionHash)`**는 지금 저장소
코드에서 결정적으로 만든 여덟 값을 돌려준다.

| environment 필드 | 실제 원본 |
|---|---|
| `analyzerModel` | `analyzer-contract.ts`의 `MODEL` |
| `analyzerInstructionsHash` | `computeArtifactHash(INSTRUCTIONS)` (같은 파일) |
| `analyzerSchemaHash` | `computeArtifactHash(SITUATION_ANALYSIS_SCHEMA)` (같은 파일) |
| `analysisTaxonomyHash` | `computeArtifactHash(TAXONOMY)` (`analysis-taxonomy.ts`) |
| `analyzerDomainManifestHash` | `computeArtifactHash({domains: SITUATION_DOMAINS, fallbackDomain: FALLBACK_DOMAIN})` (`situation-domains.ts`) |
| `recommendationGate` | `{kind:'version', version: RECOMMENDATION_GATE_CONTRACT_VERSION}` (신규 상수, `recommendation-gate.ts`) |
| `scriptureMatcher` | `{kind:'version', version: SCRIPTURE_MATCHER_CONTRACT_VERSION}` (신규 상수, `scripture-matcher.ts`) |
| `baselineCatalogVersionHash` | 함수 인자로 받은 값 그대로(아래 "신뢰 경계" 참고) |

해시 계산은 기존 `computeArtifactHash`·`canonicalJson`을 그대로 재사용했다. 환경변수·
파일 시스템·시계·네트워크·DB는 읽지 않는다 — 전부 정적 import와 함수 인자다(소스
스캔 테스트로 고정).

`recommendation-gate.ts`·`scripture-matcher.ts`에는 각각 `RECOMMENDATION_GATE_CONTRACT_VERSION
= 'recommendation-gate/v1'`·`SCRIPTURE_MATCHER_CONTRACT_VERSION = 'scripture-matcher/v1'`
상수만 추가했다. 두 파일 모두 기존 동작(선택 결과)은 바꾸지 않았고, 기존
`recommendation-gate.test.ts`(있음)·`scripture-matcher.test.ts`(있음)가 그대로 통과하는
것으로 확인했다. 주석에 "선택 결과에 영향을 주는 규칙이 바뀌면 반드시 버전을 올린다,
주석·서식 변경만으로는 올리지 않는다"를 명시했다.

**`validateAnalysisSnapshotAgainstCurrentEnvironment(snapshot, baselineCatalogVersionHash)`**는
(1) 기존 `validateAnalysisSnapshot(snapshot)`을 먼저 보고 실패하면 그 오류를 그대로
돌려주며 아래를 진행하지 않는다 → (2) 인자로 받은 `baselineCatalogVersionHash` 자체의
형식을 확인한다 → (3) `buildCurrentAnalysisSnapshotEnvironment`로 지금 환경을 만든다 →
(4) snapshot의 environment 여덟 필드를 각각 `canonicalJson`으로 대조해, **다른 필드마다
경로가 드러나는 오류**를 하나씩 낸다(`environment.analyzerModel: 스냅샷 값이 지금
저장소의 실제 값과 다릅니다.` 형태) — 전체가 다르다고 뭉뚱그리지 않는다. 완전히
봉인된(하위 해시·fingerprint가 스스로와 정확히 맞는) 스냅샷이라도 지금 환경과 다르면
반드시 거절된다는 것을 8개 필드 각각 단일 오류로 고정했다.

**기준 catalog hash 신뢰 경계**: `baselineCatalogVersionHash`는 이번 단계에서 함수
인자로만 받는다. candidate payload나 모델 응답이 스스로 선언한 값을 여기서 신뢰하지
않는다. 후속 executor 연결 단계에서는 이 인자를 candidate가 아니라
validation-context RPC(`automatic-scripture-catalog-validation-context.ts`)가 읽어 온
**활성 기준 카탈로그 버전**에서 가져와야 한다. 이번 작업은 그 RPC나 DB에 연결하지
않았다 — 여전히 순수 함수 계층뿐이다.

**mutation 검증**(수동 수행, 원본은 diff로 바이트 단위 복원 확인): (a) 환경 대조
루프 전체를 제거하자 관련 9개 테스트가 정확히 실패했다(임의 environment 거절 테스트
1개 + 필드별 단일 변경 테스트 8개). (b) `ENVIRONMENT_FIELD_LABELS`에서
`analyzerModel` 한 줄만 제거하자, 그 필드가 걸린 테스트 2개(전체 8필드 대조 테스트,
Analyzer model 단일 변경 테스트)만 실패하고 나머지는 그대로 통과했다 — 다른 검사가
우연히 잡아 주고 있던 것이 아님을 확인했다.

**새 영역 정책**: `analyzerDomainManifestHash`는 여전히 정적 `SITUATION_DOMAINS`+
`FALLBACK_DOMAIN`의 지문일 뿐이다. 활성 카탈로그에서 유도되는 동적 manifest, catalog
pointer 전환과의 원자성, 롤백 시 동시 복원은 이번에도 만들지 않았다 — `new_domain_with_
cards` 후보의 자동 활성화는 계속 fail-closed다.

**activation은 여전히 닫혀 있다**: 이 계층이 있어도 executor·`validateAutomaticValidationRecord`·
activation SQL·migration 중 어디에도 연결하지 않았다. `validateAnalysisSnapshotAgainstCurrentEnvironment`가
통과해도 activation-ready를 뜻하지 않는다 — 실제 스냅샷 데이터, adapter 구현, executor
연결이 모두 후속 작업으로 남아 있다.

### 바뀌지 않은 것

`candidate_generation` 명시적 거절, exact-fields(§9-9·수정 5의 중첩 exact-fields
포함), `validateSituationAnalysis` 재검사, 합성 text의 금지 패턴 검사
(`scanForbiddenContent`, 사례 `text` 값에만 좁혀 적용하는 이유는 §9-9에 남긴 그대로 —
`PROTECTED_CONFIGURATION_KEYS`의 `safety`가 `SituationAnalysis.safety`와 이름이 겹치기
때문), raw response·reasoning·token usage 필드 거절, 새 영역 activation fail-closed —
모두 그대로다. "실제 환경 값과의 대조"는 이제 수정 6에서 순수 함수로 **구현됐지만**,
executor·activation·DB에 연결하는 것은 여전히 후속 작업이다. `validateAutomaticValidationRecord`·
activation SQL·migration은 이번에도 건드리지 않았다.

### 검증

`npm run test:logic`(4199/4199), `npm run test:ui`(113/113), `npx tsc --noEmit`(오류 0)
모두 통과했다. 스냅샷 계약 테스트는 60개, 신규 환경 결속 테스트는 17개, 기존
`recommendation-gate.test.ts`·`scripture-matcher.test.ts`도 그대로 통과한다. OpenAI·
Supabase·DB 호출, 커밋·푸시·배포는 없었다.

## 9-11. 고정 분석 스냅샷 빌더 v1 (2026-09-17, 후속)

### 무엇을 메우려 했는가

§9-9·§9-10에서 고정 분석 스냅샷의 계약·해시·현재 환경 대조는 갖췄지만, 실제 평가
코퍼스를 빠짐없이 "분석 계획"으로 만들고 외부(장차 별도 실행기)가 만든 분석 결과를
안전하게 스냅샷으로 조립하는 빌더가 없었다. 이번 작업이 그 빌더다. **실제 156회
OpenAI 분석 실행은 다음 단계로 미룬다** — 이 파일은 OpenAI·DB·Supabase·네트워크를
전혀 부르지 않는 순수 로컬 코드다.

### 새 파일

- `scripts/automatic-scripture-catalog-analysis-snapshot-builder.ts` (신규, 후속 결함 수정 포함)
- `src/lib/automatic-scripture-catalog-analysis-snapshot-builder.test.ts` (신규, 36건)

### 1) 결정적 156개 분석 계획

`buildDeterministicAnalysisPlan()`이 두 원본에서 caseId·kind·text·expected만 뽑은
156개 계획을 만든다. 런타임 분석 결과·사용량·원본 응답·오류 메시지·사용자 식별자·
시각은 애초에 이 계획에 들어갈 자리가 없다.

- **corpus_regression 153개**: `EVALUATION_CASES`의 기존 `EVAL-001`~`EVAL-153` ID를
  그대로 쓴다. `rationale`·`domain`·`rank`·`cluster`·`smoke`·`isNewCardSmoke`는 계획에
  옮기지 않는다. `RecommendationExpectation`/`DomainChoiceExpectation`/
  `NoCoverageExpectation`을 `CorpusRegressionCaseExpectation`과 정확히 같은 모양으로
  투영하고, `acceptableCardIds`·`expectedDomainChoiceCandidates`는 원본과 참조를
  공유하지 않게 새로 만든다.
- **safety_boundary 3개**: 배열 인덱스가 아니라 (source, domain, rank)로 원본을
  찾는다. **`SafeCaseSpec`은 (source, domain, rank)만이 아니라 검토 시점의 실제
  `text`와 `expectedSafety`(level·categories) 전체까지 함께 고정한다** — 아래
  "후속 결함 수정" 참고. `findSafetyBoundaryScenario`가 먼저 (source, domain, rank)로
  정확히 하나로 대응하는 원본을 찾고(0개거나 2개 이상이면 예외), 그 원본의 `text`·
  `expected`를 spec에 고정해 둔 값과 다시 대조해 하나라도 다르면 어떤 항목이
  다른지(`text`, `expectedSafety.level`, `expectedSafety.categories`) 밝히며 예외를
  던진다. `note`는 고정하지 않는다 — 판정 근거 설명일 뿐 사례 정체성의 일부가 아니다.
  원본 배열의 순서만 바뀌고 내용이 같으면 같은 계획을 만든다(매칭이 인덱스가 아니라
  조건절이기 때문).

| caseId | source | domain | rank | 고정된 text | 고정된 expectedSafety |
|---|---|---|---|---|---|
| `SAFE-001` | single | relationship_conflict_forgiveness | 12 | "상대가 폭언을 반복해..." | `{level:'caution', categories:['abuse']}` |
| `SAFE-002` | single | relationship_conflict_forgiveness | 18 | "폭력을 당한 뒤에도..." | `{level:'caution', categories:['abuse']}` |
| `SAFE-003` | single | injustice_mistreatment | 5 | "직장에서 은근히 따돌림..." | `{level:'caution', categories:['abuse']}` |

### 후속 결함 수정 — Codex가 재현한 (source, domain, rank)만으로는 부족한 결함 (2026-09-17)

Codex Sol High가 다음을 실제로 재현했다. 처음 버전의 `SAFE_CASE_SPECS`는 (source,
domain, rank)만 고정했고, `buildSafetyBoundaryPlanCases()`는 그 세 값만으로 원본을
찾은 뒤 `scenario.text`·`scenario.expected`를 그대로 믿었다. 같은 (source, domain,
rank)를 유지한 채 `SAFETY_BOUNDARY_SCENARIOS`의 `SAFE-001` 자리 문장을 `'원본과
다른 안전 문장입니다.'`로, `expected`를 `{level:'caution', categories:['self_harm']}`로
바꿔도 예외 없이 기존 `SAFE-001`을 그대로 만들어 냈다. "정확히 대응한다"는 기존
테스트도 `findSafetyBoundaryScenario`로 원본을 다시 읽어 그 값과 대조하는 **순환
비교**였기 때문에 이 결함을 잡지 못했다.

수정: `SafeCaseSpec`에 `text`와 `expectedSafety`(level·categories 전체)를 검토
시점의 실제 값으로 고정했다. `findSafetyBoundaryScenario`가 (source, domain, rank)로
정확히 하나를 찾은 뒤 그 원본의 `text`·`expected`를 spec의 고정값과 다시 대조하고,
하나라도 다르면 `${caseId}: ... 불일치 항목: text, expectedSafety.level, ...` 형태로
어떤 항목이 다른지 밝히며 예외를 던진다. `note`는 판정 근거 설명일 뿐이라 고정하지
않았다. 매칭이 배열 인덱스가 아니라 (source, domain, rank) 조건절이므로 원본 배열의
순서만 바뀌어도(내용이 같다면) 여전히 같은 계획을 만든다.

"5) SAFE-001~003이 지정된 원본 사례와 정확히 대응한다" 테스트를 다시 썼다 —
`findSafetyBoundaryScenario`나 `SAFETY_BOUNDARY_SCENARIOS`를 거치지 않고, 검토
시점의 실제 text·level·categories를 테스트 파일에 직접(하드코딩으로) 다시 적어
계획·spec 양쪽과 대조한다. 이렇게 하면 원본과 spec이 함께 잘못된 값으로 바뀌어도
이 테스트가 잡는다.

신규 회귀 테스트 4개를 추가했다: text만 바뀌면 거절, `caution`을 유지한 채
categories만 바뀌어도 거절, 원본 배열 순서만 바뀌면 동일한 계획, 한 SAFE 사례가
불일치하면 다른 SAFE ID로 대체되거나 부분 계획(예: 155개)을 조용히 돌려주지 않고
`buildSafetyBoundaryPlanCases`·`buildDeterministicAnalysisPlan` 모두 전체가 예외로
멈춘다. Codex가 보고한 정확한 재현 fixture(text와 categories를 동시에 바꾼 경우)로
직접 재확인해, 이제 두 항목 모두 불일치로 잡힌다는 것을 확인했다.

mutation 검증으로 `findSafetyBoundaryScenario`의 text·expectedSafety 대조 자체를
제거해 보았다 — 관련 신규 테스트 4개(caution→urgent 거절, text 불일치 거절,
categories 불일치 거절, 부분 계획 미반환)만 정확히 실패하고 나머지 32개는 그대로
통과했다. 검증 후 소스를 diff로 바이트 단위 복원 확인했다.

### 2) 외부 분석 결과 계약

`matchExternalAnalysisResultsToPlan(plan, externalAnalysisResults)`은 외부 분석
결과(정확히 `{caseId, text, analysis}` 세 필드만)를 계획과 완전히 1:1 대조한다.
wrapper 모양(정확한 필드 집합·caseId 형식·text가 문자열·analysis가 객체)을 먼저
보고, 하나라도 어긋나면 매칭을 시도하지 않고 그 오류만 돌려준다. wrapper가 전부
맞은 뒤에야 개수·순서·caseId 중복·계획과의 대응·text 일치를 본다. `{ok:true, cases}
| {ok:false, errors}` 명시적 union이며, 오류를 고치거나 추정하지 않고 부분 결과도
만들지 않는다. `analysis`(그리고 `analysis.safety`)의 내부 필드·값 규격은 여기서
보지 않는다 — 스냅샷 조립 마지막 단계(`validateAnalysisSnapshotAgainstCurrentEnvironment`)가
반드시 다시 본다.

### 3) 스냅샷 조립

`buildFrozenAnalysisSnapshot(baselineCatalogVersionHash, externalAnalysisResults)`은
기존 함수만 재사용해 조립한다: 계획 생성·검증 → 외부 결과 1:1 대조 →
`AnalysisSnapshotCase[]` 생성 → `buildCurrentAnalysisSnapshotEnvironment`로 현재
environment 생성 → `computeSourceCorpusArtifactHash`/`computeFrozenAnalysisArtifactHash` →
`computeAnalysisSnapshotFingerprint` → `validateAnalysisSnapshotAgainstCurrentEnvironment`
실행 → 완전히 성공한 경우에만 반환. 호출자는 신뢰 경계에서 얻은
`baselineCatalogVersionHash`와 156개 분석 결과만 줄 수 있다 — analyzer model·
instructions hash·schema hash·taxonomy hash·domain manifest hash·Gate/Matcher
version은 항상 `buildCurrentAnalysisSnapshotEnvironment`가 지금 저장소 코드에서
내부적으로 만들며, 호출자가 주입할 방법이 없다. 마지막 검증이 실패하면 그 오류를
그대로 돌려주고, 성공으로 바꾸거나 부분 스냅샷을 반환하지 않는다.

### 순수성·격리

OpenAI SDK·`fetch`·환경변수·파일 시스템·시계·난수·`console`·Supabase client·DB/RPC·
Edge Function·네트워크를 전혀 부르지 않는다(소스 스캔 테스트로 고정). 사용자 원문
수집·raw provider response·token usage·사람 승인·서명 필드가 들어갈 자리가 없다.
`candidate_generation` 사례는 이 계획에 없다.

### 테스트와 mutation 검증

36개 테스트 전부 통과했다(원래 32개 + 위 "후속 결함 수정"의 신규 회귀 4개). 핵심
검사 네 곳을 임시로 무력화해 mutation 검증했다 — (1) text 일치·순서 일치 검사를
제거하자 관련 테스트 2개만 실패, (2) SAFE 원본 대응 "정확히 하나" 검사를 제거하자
관련 fail-closed 테스트 2개만 실패, (3) wrapper 여분 필드 검사를 제거하자 그 검사를
직접 쓰는 테스트와 "모든 실패 경로에서 부분 스냅샷이 없다" 테스트까지 정확히 2개
실패, (4) `findSafetyBoundaryScenario`의 text·expectedSafety 대조 자체를 제거하자
관련 신규 테스트 4개만 실패했다. 네 번 모두 검증 후 소스를 diff로 바이트 단위
복원 확인하고 전체 테스트를 다시 통과시켰다.

### 아직 연결하지 않은 경계

- 실제 156회 OpenAI 분석 실행은 하지 않았다.
- 실제 frozen snapshot artifact를 만들어 Git에 커밋하지 않았다 — 156개 계획과 빌더
  함수만 있고, 실제 분석 결과를 넣어 만든 진짜 스냅샷 데이터 파일은 아직 없다.
- executor·validation-context·DB·activation 어디에도 연결하지 않았다.
- 이 단계만으로 자동 활성화 준비가 끝난 것이 아니다 — `buildFrozenAnalysisSnapshot`이
  성공해도 activation-ready를 뜻하지 않는다.
- `new_domain_with_cards`는 여전히 fail-closed다 — 동적 domain manifest가 없다.
- 사람의 사전 승인 필드는 추가하지 않았다.
- `baselineCatalogVersionHash`는 이번에도 호출자 인자로만 받는다. 후속 executor
  연결에서는 candidate나 모델 응답이 아니라 validation-context RPC가 읽은 활성
  기준 카탈로그 버전에서 가져와야 한다(§9-10 수정 6과 같은 신뢰 경계).

### 검증

`npm run test:logic`(4235/4235), `npm run test:ui`(113/113), `npx tsc --noEmit`(오류 0)
모두 통과했다. 새 빌더 테스트 36개(후속 결함 수정 포함), 스냅샷 계약 테스트 60개,
현재 환경 결속 테스트 17개, 자동 Scripture Catalog 전체 테스트(912/912)가 모두
통과한다. OpenAI·Supabase·DB 호출, 커밋·푸시·배포는 없었다.

## 9-12. 재개 가능한 분석 실행기 핵심 v1 — 실제 호출 없음 (2026-09-18, 후속)

### 무엇을 메우려 했는가

§9-11의 builder는 156개 결정적 계획을 만들고, 외부에서 이미 얻은 156개 분석 결과를
**한 번에** 스냅샷으로 조립하는 순수 함수만 가지고 있었다. "그 156개 결과를 실제로
어떻게, 몇 번에 나눠, 중단됐다 이어서 얻을 것인가"는 없었다. 이번 작업이 그
실행기 핵심(runner core)이다. **이번에도 실제 OpenAI 호출·파일 저장·DB·네트워크는
전혀 하지 않는다** — 분석 함수와 체크포인트 읽기·쓰기는 전부 테스트가 주입한
가짜 함수다.

### 새 파일 / 수정 파일

- `scripts/automatic-scripture-catalog-analysis-snapshot-runner.ts` (신규, 이후 Codex
  재현 결함 3건 수정 포함 — 아래 "4) 실패 계약" 참고)
- `src/lib/automatic-scripture-catalog-analysis-snapshot-runner.test.ts` (신규, 36건 —
  최초 28건 + 결함 재현·회귀 테스트 8건)
- `supabase/functions/_shared/automatic-scripture-catalog-analysis-snapshot-contract.ts`
  (수정 — `validateAnalysisSnapshotCase` 신규 공개 함수만 추가, 기존 로직 불변)
- `src/lib/automatic-scripture-catalog-analysis-snapshot-contract.test.ts`
  (수정 — 위 신규 함수 대응 테스트 5건 추가, 65건)

### 1) 단일 사례 검증 재사용 — `validateAnalysisSnapshotCase`

기존 `validateAnalysisSnapshot`이 스냅샷 전체를 볼 때 내부적으로만 쓰던 `validateCase`를
로직 복제 없이 그대로 공개했다. `{caseId, kind, text, expected, analysis}` 사례
하나를 받아 exact-fields·caseId 형식·금지 패턴·`analysis`와 `analysis.safety`의
exact-fields·공용 `validateSituationAnalysis`·`analysis`와 `expected`의 교차
일관성까지 스냅샷 전체 검증과 정확히 같은 규칙으로 확인한다. 실행기가 매 분석
결과를 체크포인트에 넣기 전에 이 함수 하나로 검증한다.

### 2) 체크포인트 계약

`AnalysisRunnerCheckpoint`는 `contractVersion`·`planFingerprint`(지금 156개 계획의
지문, `computeAnalysisPlanFingerprint`로 계산 — 기존 `computeArtifactHash`·
`canonicalJson` 재사용)·`environment`(`buildCurrentAnalysisSnapshotEnvironment`로 만든
지금 저장소의 실제 분석 환경)·`results`(계획 맨 앞에서부터 이어지는 연속 prefix)만
담는다. 각 결과는 정확히 `{caseId, text, analysis}`뿐이다 — raw response·provider
오류 원문·token usage·API key·사용자/세션 식별자·시각·사람 승인·서명 필드가 들어갈
자리가 계약 어디에도 없다.

`validateAnalysisRunnerCheckpoint`가 exact-fields·`contractVersion`·계획 지문·
environment를 확인한 뒤, `results`가 연속 prefix인지 **위치 i의 결과가 `plan[i]`의
caseId·text와 정확히 같아야 한다**는 단일 규칙으로 검사한다. 이 규칙 하나가 순서
뒤바뀜·중간 누락·중복·계획 밖 사례·text 변경을 전부 동시에 잡는다. 각 결과의
`analysis`는 `validateAnalysisSnapshotCase`로 다시 검증한다.

### 3) 재개 가능한 순차 실행기 — `runAnalysisSnapshotRunner`

실행 순서: 156개 계획 생성 → 지금 environment·계획 지문 계산 → 기존 체크포인트가
있으면 완전 검증 → 체크포인트 다음 사례부터 한 건씩(`maxCases`까지) 순차 분석 →
`validateAnalysisSnapshotCase`로 검증 → 성공한 결과를 더한 새 체크포인트 저장 →
저장이 성공한 뒤에만 다음 사례로 진행 → 156개가 모두 모이면 기존
`buildFrozenAnalysisSnapshot`으로 최종 스냅샷 조립 → 그 최종 검증이 완전히 성공한
경우에만 `completed`를 돌려준다. 모든 analyze 호출은 `for` 루프 안에서 순서대로
`await`하며, 병렬 호출은 하지 않는다.

`analyze` 함수는 `{caseId, text}`만 받는다 — **`expected`를 절대 넘기지 않는다.**
분석이 정답을 미리 알면 뒤이은 교차 일관성 검사가 아무 의미가 없어지기 때문이다.

### 4) 실패 계약

analyze가 예외를 던지거나 결과가 계약(exact-fields·`validateSituationAnalysis`·
교차 일관성)을 어기면: 그 결과를 저장하지 않고, 이전까지 저장된 정상 prefix는
그대로 두고, 실패한 caseId와 안전한 내부 오류 코드(`analyze_failed`/
`analysis_invalid`)만 돌려주며, provider 오류 원문은 어디에도 담지 않고, 다음
사례로 넘어가지 않는다.

체크포인트 저장이 실패하면(`checkpoint_save_failed`): 다음 analyze를 부르지 않고,
저장됐다고 가정하지 않는다(실행기 내부 상태도 그 결과를 다음 사례 진행에 반영하지
않는다).

체크포인트 **읽기**가 예외를 던지면(`checkpoint_load_failed`, 2026-09-18 Codex
재현·수정): analyze도 저장도 한 번도 부르지 않고 즉시 실패로 수렴한다. `loadCheckpoint`
호출을 try/catch로 감싸, 디스크 경로·내부 스택 같은 원문을 절대 담지 않고
`{ status: 'failed', reason: 'checkpoint_load_failed' }`만 돌려준다. 마찬가지로
체크포인트의 `environment` 필드 자체가 없거나(undefined) 문자열·배열 등으로
망가진 경우, 내부적으로 `canonicalJson`이 예외를 던질 수 있는데 이 예외도 밖으로
새지 않고 "environment가 다르다"는 검증 실패로만 수렴한다 — `validateAnalysisRunnerCheckpoint`는
어떤 unknown 입력에도 절대 throw하지 않고 항상 `{ok:false, errors}`를 돌려준다.

**공개 결과에는 상세 오류를 담지 않는다** (2026-09-18 Codex 재현·수정). 실행기의
공개 타입 `AnalysisRunnerResult`는 `errors` 필드를 갖지 않는다 — `checkpoint_invalid`는
`reason`만, `analysis_invalid`는 `reason`과 사례 단위 실패를 가리키는 `caseId`만,
`final_snapshot_invalid`는 `reason`만 돌려준다. `validateAnalysisRunnerCheckpoint`·
`validateAnalysisSnapshotCase` 내부의 상세 `errors: string[]`는 모델이 만든 값
(예: 표준 사전에 없는 태그 이름 자체)이나 구현 세부사항을 그대로 담고 있을 수
있어, 그 배열을 실행기의 공개 결과로 그대로 옮기면 그 값이 호출자 로그로 새어
나간다. 그 상세 오류를 실제로 봐야 하면(개발용) 이 실행기를 거치지 않고
`validateAnalysisRunnerCheckpoint`·`validateAnalysisSnapshotCase` 같은 순수
validator를 직접 호출해야 한다 — 이 실행기는 그 함수들을 감싸기만 할 뿐, 반환값의
`errors`를 절대 옮기지 않는다.

**"정확히 한 번"을 주장하지 않는다.** analyze 호출과 체크포인트 저장은 원자적일
수 없다. analyze가 성공적으로 값을 돌려준 **직후**, 저장이 끝나기 **전**에
프로세스가 죽으면 그 결과는 어디에도 남지 않는다. 다음 실행은 저장된 체크포인트만
보고 이어가므로, 그 사례는 **다시 analyze가 호출된다** — 장애 시 최대 한 건(직전에
저장되지 않은 사례)이 다시 호출될 수 있다.

### 5) 처리량 제한 — `maxCases`

`0`이면 analyze 호출 0회(완성 여부만 확인), `1`이면 다음 미완료 사례 1개만,
남은 수보다 크면 남은 사례까지만 처리한다. 음수·정수가 아닌 값(`-1`, `1.5`, `NaN`
등)은 analyze·저장을 부르지 않고 즉시 `invalid_max_cases`로 거절한다.
`baselineCatalogVersionHash`의 형식도 시작하자마자 확인해, 잘못된 값이면 analyze·
체크포인트 읽기 전에 `invalid_baseline_hash`로 거절한다(비용 낭비 없이 빠르게
막는다).

### 순수성·격리

OpenAI SDK·`fetch`·환경변수·파일 시스템·시계·난수·`console`·Supabase client·DB/RPC·
Edge Function·네트워크를 전혀 부르지 않는다(소스 스캔 테스트로 고정). `analyze`·
`loadCheckpoint`·`saveCheckpoint` 세 함수는 전부 테스트가 만든 인메모리 가짜
함수다.

### 테스트와 mutation 검증

36개 테스트 전부 통과한다(최초 28건 + 기존 스냅샷 계약 테스트에
`validateAnalysisSnapshotCase` 대응 5건 추가 — 이 5건은 계약 테스트 파일 65건
쪽 카운트). 핵심 검사 세 곳을 임시로 무력화해 mutation 검증했다 — (1) 저장
실패를 무시하고 계속 진행하게 하자 관련 테스트 2개("저장 전 다음 분석 안 부름",
"저장 실패 뒤 추가 호출 없음")만 실패, (2) 체크포인트의 위치별 대조를 caseId
존재 여부만 보는 검사로 바꾸자 순서·누락·중복·text 변경 거절 테스트 4개만 실패
(계획 밖 사례 거절 테스트는 존재 여부 검사만으로도 여전히 걸려 그대로 통과 —
다른 성격의 검사임을 확인), (3) analyze 결과의 검증 게이트를 제거하자 계약 위반·
교차 일관성 위반 저장 거부 테스트 2개만 실패했다. 세 번 모두 검증 후 소스를
diff로 바이트 단위 복원 확인하고 전체 테스트를 다시 통과시켰다.

**2026-09-18 후속 결함 수정 시 추가 mutation 검증** (Codex 재현 3건 대응, 새
회귀 테스트 8건 포함해 28→36건으로 증가): (4) `environment` 비교의 try/catch를
제거하자 environment 안전성 테스트 2개("environment 필드 누락", "environment가
undefined·문자열·배열")만 실패 — 실제로 `Error: 지문을 만들 수 없는 값입니다.`가
테스트 밖으로 그대로 튀어나오는 것을 확인, (5) `loadCheckpoint` 호출의
try/catch를 제거하자 `loadCheckpoint` 예외 재현 테스트 1개만 실패 — unhandled
rejection으로 원문(`disk secret detail...`)이 그대로 노출되는 것을 확인,
(6) `AnalysisRunnerResult` 타입과 세 호출부에 `errors` 필드를 다시 붙이자 테스트
5개(계약 위반 저장 거부 2건, `PRIVATE_MODEL_VALUE_123` 재현 테스트, checkpoint_invalid
무누출 테스트, final_snapshot_invalid 소스 패턴 테스트)만 실패했고, 실패 출력에
`PRIVATE_MODEL_VALUE_123` 문자열이 실제로 섞여 나오는 것을 직접 확인해 원래
결함과 수정된 테스트의 실효성을 함께 검증했다. 세 라운드 모두 검증 후 `cp`로
백업한 원본으로 복원하고 `diff`로 바이트 단위 동일함을 확인한 뒤 `tsc --noEmit`과
전체 테스트를 다시 통과시켰다.

### 아직 연결하지 않은 경계

- runner core만 구현했다. 실제 OpenAI transport와 실제 파일(또는 DB) 체크포인트
  저장소 구현은 아직 없다 — `analyze`·`loadCheckpoint`·`saveCheckpoint`는 이번에도
  테스트의 인메모리 가짜 함수뿐이다.
- 실제 156회 호출과 실제 frozen snapshot artifact 생성은 아직 하지 않았다.
- 순차 실행과 체크포인트 저장 계약만 정했다 — 실제 실행에서 "장애 시 마지막
  미저장 1건이 재호출될 수 있다"는 성질은 위 "4) 실패 계약"에 그대로 문서화했다.
- executor·validation-context·DB·activation 어디에도 연결하지 않았다.
- `new_domain_with_cards`는 여전히 fail-closed다 — 동적 domain manifest가 없다.
- 사람의 사전 승인 필드는 이번에도 추가하지 않았다(체크포인트·결과 계약 어디에도
  없다).
- `baselineCatalogVersionHash`는 이번에도 호출자 인자로만 받는다(§9-10 수정 6·
  §9-11과 같은 신뢰 경계 — 후속 executor 연결에서는 validation-context RPC의 활성
  기준 버전에서 가져와야 한다).

### 검증

`npm run test:logic`(4276/4276), `npm run test:ui`(113/113), `npx tsc --noEmit`
(오류 0) 모두 통과했다. runner 테스트 36개(2026-09-18 결함 재현·회귀 8건 포함),
builder 테스트 36개, 스냅샷 계약·현재 환경 결속 테스트 82개(계약 65 + 환경 17),
자동 Scripture Catalog 전체 테스트(953/953)가 모두 통과한다. `git diff --check`
공백 오류 없음, `package.json`·`package-lock.json` 변경 없음, 변경된 5개 파일
외 다른 파일 변경 없음(`git status --short` 확인)도 함께 검증했다. OpenAI·
Supabase·DB 호출, 커밋·푸시·배포는 없었다.

## 9-13. 분석 실행기 파일 저장소·안전 CLI v1 — 실제 호출 없음 (2026-09-18, 후속)

### 무엇을 메우려 했는가

§9-12까지는 재개 가능한 실행기 핵심(`runAnalysisSnapshotRunner`)이 있었지만
`analyze`·`loadCheckpoint`·`saveCheckpoint`는 전부 테스트가 주입한 인메모리
가짜 함수였다 — 실제로 어디에, 어떻게 저장할지, 그리고 사람이 실수로
`--execute`를 잘못 눌러 비용을 쓰는 일을 어떻게 막을지는 없었다. 이번 작업이
그 두 경계, **로컬 파일 저장소**와 **안전한 CLI**를 채운다. 이번에도 실제
OpenAI 호출은 하지 않는다 — 모든 실행 검증은 fake analyzer 또는 `--dry-run`으로
했다.

### 새 파일

- `scripts/automatic-scripture-catalog-analysis-runner-file-store.ts` (신규,
  이후 Codex 독립 검수 결함 수정 포함 — 아래 "1)" 끝부분과 "4)" 참고) —
  체크포인트·최종 스냅샷을 구분하지 않는 범용 원자적 JSON 파일 저장소.
- `src/lib/automatic-scripture-catalog-analysis-runner-file-store.test.ts`
  (신규, 27건 — 최초 16건 + 결함 재현·회귀 11건)
- `scripts/automatic-scripture-catalog-analysis-runner-cli.ts` (신규, 이후
  Codex 독립 검수 결함 수정 포함) — `--dry-run`/`--execute` 안전 CLI. 실행기
  핵심과 파일 저장소를 실제로 잇는다.
- `src/lib/automatic-scripture-catalog-analysis-runner-cli.test.ts` (신규,
  29건 — 최초 20건 + 결함 재현·회귀 9건)
- `.gitignore` (수정) — 이 CLI의 로컬 산출물 디렉터리 이름 하나만 좁게 추가.

### 1) 파일 저장소 — 체크포인트인지 스냅샷인지 모른다

`readJsonFile(path)`와 `writeJsonFileAtomic(path, value)`는 `unknown` JSON
값 하나만 다룬다. 체크포인트 계약이나 스냅샷 계약을 전혀 검증하지 않는다 —
그건 runner의 순수 validator(`validateAnalysisRunnerCheckpoint`)와
`buildFrozenAnalysisSnapshot`이 각자 이미 하고 있다.

**읽기**: 파일이 없으면 `null`. 있으면 파싱한 `unknown`. 그 밖의 모든 경우 —
JSON 손상, 대상이 디렉터리, symlink, 크기 상한(기본 20MiB) 초과, 그 밖의 읽기
오류 — 는 `FileStoreError`를 던진다. 그 오류의 `message`는 항상 `code`에서만
나오는 고정 문구다(`file_store_error:invalid_json`처럼) — 실제 경로나 OS가 준
원본 오류 문구를 절대 담지 않는다. symlink는 `open()`에 `O_NOFOLLOW`를 써서
막는다 — "먼저 확인하고 나중에 연다" 방식의 경쟁 조건이 없다. `stat()`으로
확인한 크기와 실제로 읽은 바이트 수(`buffer.length`)를 **둘 다** 상한과
비교한다 — `stat()`과 `readFile()` 사이에 파일이 커지는 경쟁 상황(TOCTOU)까지
막기 위한 방어적 이중 확인이다(2026-09-18 보강 — 이 두 번째 확인이 실제로
필요한 순간은 결정적으로 재현할 수 없어, 이 파일의 다른 소스 패턴 테스트와
같은 방식으로 존재 자체를 소스에서 직접 확인한다).

**원자적 쓰기**: 값을 먼저 저장 형식(`stablePrettyJson`)으로 직렬화한다 —
BigInt·순환 참조처럼 `JSON.stringify`가 원본 `TypeError`를 던지는 값이나,
top-level `undefined`처럼 예외 없이 `undefined`(문자열이 아님)를 돌려주는
값은 원본 값이나 원본 예외 문구를 밖으로 내지 않고 `FileStoreError
('write_failed')`로 수렴한다(2026-09-18 Codex 재현·수정 — 이전에는 이
직렬화 호출이 어떤 try/catch로도 감싸여 있지 않아 raw `TypeError: Do not
know how to serialize a BigInt`가 그대로 밖으로 샜다). 이 단계에서 실패하면
아직 어떤 파일도 만들지 않는다. 직렬화에 성공하면, 대상과 같은 디렉터리에
`O_EXCL`·`O_NOFOLLOW`·권한 `0600`으로 임시 파일을 만들고, 전체 JSON을 한
번에 쓴 뒤 `fsync`하고, 같은 디렉터리 안에서 `rename`한다. rename은 대상이
이미 있어도 원자적으로 통째로 교체하며(부분 덮어쓰기가 없다), 대상이
symlink여도 그 symlink 자체를 교체할 뿐 따라가지 않는다 — 그래서 쓰기
경로에는 symlink를 통해 다른 곳에 쓰는 위험이 구조적으로 없다(별도의
symlink 거절 검사를 쓰기 쪽에 추가하지 않아도 된다). 디렉터리 자체도
가능하면 `fsync`한다(best-effort). 대상 디렉터리는 명시적으로 이미 있어야
한다 — 이 함수가 임의로 만들지 않는다. 실패하면(디렉터리 없음, 직렬화 실패,
임시 파일 생성/쓰기/rename 실패) 대상 경로는 rename 전까지 전혀 건드리지
않으므로 기존 정상 파일이 그대로 남고, 만들어졌던 임시 파일은 best-effort로
지운다.

저장 형식은 `stablePrettyJson` — key를 재귀적으로 알파벳 순 정렬하고(배열
순서는 그대로 둔다) 2칸 들여쓰기로 낸다. 지문 계산에 쓰는 `canonicalJson`(공백
없는 압축 형식)과는 다른, 사람이 다시 읽기 위한 저장 전용 형식이다. 같은 값을
key 순서만 다르게 여러 번 저장해도 파일 내용은 글자 그대로 같다(테스트로
확인).

**쓰기 전 미리보기 — `preflightJsonFileTarget`**(2026-09-18 Codex 재현·수정):
대상 파일에는 아무 것도 쓰지 않고, 같은 디렉터리에 빈 probe 파일을 잠깐
생성·삭제해 "이 경로에 나중에 `writeJsonFileAtomic`이 성공할 수 있는가"만 확인한다 — 부모 디렉터리가 실제 디렉터리인지, 대상 자체가 이미
디렉터리는 아닌지, 같은 디렉터리에 0600 probe 파일을 `O_EXCL|O_NOFOLLOW`로
만들 수 있는지(만들면 `fsync`·close 후 곧바로 best-effort로 지운다). 기존
대상 파일은 열거나 바꾸지 않는다 — 전혀 건드리지 않는다. 실패하면 다른
함수와 같은 규칙으로 `FileStoreError`를 던진다(경로·OS 원문 없음). 아래
"2) 안전한 CLI"에서 이 함수를 유료 analyze 호출보다 먼저 부르는 이유를
설명한다.

### 2) 안전한 CLI — `--dry-run` / `--execute`

`scripts/automatic-scripture-catalog-analysis-runner-cli.ts`는 `runCli(args,
deps)`로 실제 실행 로직을 뽑아 두고, 파일 맨 아래에서 "이 파일이 직접
실행됐을 때만"(`import.meta.url`이 실행 진입점과 같을 때만) 실제 의존성
(OpenAI client·실제 파일 I/O·`console.log`)을 연결한다 — 그래서 이 파일을
`import`만 해도(테스트가 하듯) 아무 것도 실행되지 않는다.

`--dry-run`과 `--execute` 중 정확히 하나가 있어야 한다. 없거나 둘 다 있으면
사용법만 출력하고 끝난다 — OpenAI client 생성 0회. **같은 flag가 중복되면
(값이 같아도) 마지막 값이 조용히 이기게 두지 않고 똑같이 거절한다**
(2026-09-18 Codex 재현·수정 — 이전에는 인자를 담는 자료구조가 `Map`이라
`--max-cases=1 --max-cases=156`처럼 같은 key가 두 번 오면 마지막 값이 조용히
이겨서, 비용 상한 1건을 지정한 것처럼 보이는 명령이 실제로는 156건 전체를
처리했다). `--dry-run`·`--execute` 자체가 반복되는 경우도 같은 규칙으로
거절한다.

**dry-run**: OpenAI client·analyze·체크포인트/스냅샷 쓰기를 전혀 하지 않는다.
`--checkpoint`를 주면 그 파일을 읽기만 해서(쓰지 않는다) 156개 계획 수,
체크포인트 존재 여부, 완료 수, 다음 caseId, 이번 처리 예정 수만 출력한다.
이 완료 수는 `results` 배열 길이만 세는 **대략적인 미리보기**다 —
`validateAnalysisRunnerCheckpoint`의 exact-fields·순서·environment 전체
검증은 하지 않는다(그러려면 baseline hash가 필요한데, dry-run은 그런 입력
없이도 항상 안전하게 돌아가야 한다). 정확한 재개 지점은 `--execute`가 전체
검증을 통해 확정한다. 사례 문장·분석 내용·API key는 절대 출력하지 않는다 —
caseId 같은 식별자만 낸다.

**execute**: `--checkpoint`·`--snapshot`·`--baseline-catalog-version-hash`·
`--max-cases` 네 인자가 모두 명시적으로 있어야 한다. `--max-cases`는 생략할
수 없고 **0도 거절한다**(양수만 허용 — 한 번의 실행이 얼마나 비용을 쓸지
항상 명시하게 한다). checkpoint와 snapshot 경로가 같으면(정규화해서 비교)
거절한다. 이 네 검사는 전부 OpenAI client를 만들기 전에 끝난다.

**출력 경로 preflight**(2026-09-18 Codex 재현·수정 — blocking): 위 네 인자
검사를 통과하면, `runAnalysisSnapshotRunner`를 시작하기 전에(따라서 client를
만들기 전에) checkpoint·snapshot 두 경로 각각에 대해
`preflightWritableTarget`(파일 저장소의 `preflightJsonFileTarget`을 실제로
연결)을 부른다. 이전에는 이 확인이 전혀 없어서, 잘못된 checkpoint 경로(예:
없는 디렉터리)를 줘도 실행기가 곧바로 시작돼 **첫 유료 analyze 호출과 client
생성이 각각 1회 일어난 뒤**에야 체크포인트를 저장하려는 순간 실패했다 —
snapshot 경로가 잘못된 경우는 더 심해서 156건 전부를 분석한 뒤 최종 저장
순간에야 드러났다. 이제는 어느 한쪽 경로든 preflight가 실패하면 client·
analyze·checkpoint 저장·snapshot 저장이 전부 0회이고, 실패 사유
(`checkpoint_target_unwritable`/`snapshot_target_unwritable`)만 돌려준다 —
preflight 자체가 던지는 원본 오류 문구는 CLI 출력 어디에도 나타나지 않는다.

OpenAI client는 **지연 생성**한다 — client 생성 코드를 `analyze` 클로저 안에
두고 첫 호출에서만 실제로 만든다. `runAnalysisSnapshotRunner`는 항상 "인자
검증 → 기존 체크포인트 완전 검증 → (그 다음에야) 첫 analyze 호출"의 순서로
진행하므로, client 생성을 "실제로 analyze가 처음 필요한 순간"으로 미루기만
해도 그 생성이 자동으로 "인자와 기존 체크포인트가 둘 다 검증된 뒤"에만
일어난다 — 검증 로직을 CLI 쪽에서 다시 베끼지 않고도 순서를 보장하는
방법이다(mutation 검증으로 확인 — 아래 참고).

`analyzeSituation`(기존 `scripts/analyzer-prompt.ts`)을 연결하되, 빈 응답·
JSON 파싱 실패·규격 위반·API 오류를 전부 하나의 generic `analyze_failed`
예외로 뭉갠다 — 원본 응답이나 provider 오류 문구는 절대 CLI 밖으로 나가지
않는다(그 값을 담지 않는 예외를 던지므로, `runAnalysisSnapshotRunner`가 이미
그 예외의 `message`조차 읽지 않고 버리는 기존 계약과 이중으로 안전하다).

**완료 처리**: `runAnalysisSnapshotRunner`가 156건 전부 검증된 `completed`를
돌려줄 때만 CLI가 `writeJsonFileAtomic`으로 최종 스냅샷을 저장한다.
`in_progress`나 `failed`일 때는 스냅샷 파일을 만들거나 건드리지 않는다 —
기존 스냅샷이 있어도 이번 실행이 완료되기 전에는 그대로 둔다.

### 3) 경로 안전성

checkpoint와 snapshot 경로가 같으면 CLI가 즉시 거절한다(위 참고). 임시 파일
이름은 대상 파일명 + 난수 접미사로 만들어지므로, 서로 다른 대상(checkpoint·
snapshot)의 임시 파일은 같은 디렉터리에 있어도 이름이 겹치지 않는다. 저장
대상 디렉터리는 파일 저장소가 명시적으로 존재를 확인만 하고 만들지 않는다
(`writeJsonFileAtomic`도, preflight도 마찬가지다 — preflight가 확인만 하고
아무 것도 만들지 않는 이유도 이 규칙을 지키기 위해서다). CLI의 모든 출력에는
실제 파일 경로나 홈 경로 문자열을 절대 넣지 않는다 —
`--checkpoint`/`--snapshot`에 무엇을 넘겼든 출력에는 boolean·개수·caseId 같은
값만 나온다. `.gitignore`에는 이 CLI의 로컬 산출물 관례 디렉터리
(`/automatic-scripture-catalog-analysis-runner.local/`) 하나만 좁게
추가했다 — 기존 `*.json` 전체를 무시하는 규칙은 없고, 이번에도 만들지
않았다.

### 4) Codex 독립 검수 결함 수정 요약 (2026-09-18)

이 절의 최초 구현을 Codex가 독립적으로 검수해 결함 3건을 재현했다. 세 건
모두 위 1)·2)에 이미 반영했고, 여기서는 수정 전 실제 재현값과 수정 후 값만
나란히 정리한다.

| 결함 | 재현 방법 | 수정 전 | 수정 후 |
| --- | --- | --- | --- |
| 1. 출력 경로 preflight 누락(blocking) | 없는 디렉터리를 `--checkpoint`로 준 채 `--execute` | client 1회, analyze 1회, `status:'failed', reason:'analyze_failed'`(fake analyze가 던진 예외로 우연히 멈춤 — 진짜 provider였다면 비용이 이미 발생) | client 0회, analyze 0회, `status:'failed', reason:'checkpoint_target_unwritable'` |
| 2. 직렬화 오류 원문 노출(blocking) | `writeJsonFileAtomic(path, {bad: 1n})` | raw `TypeError: Do not know how to serialize a BigInt`가 그대로 던져짐 | `FileStoreError`(`code:'write_failed'`)만 던져짐, 원문 없음 |
| 3. 중복 CLI 인자 묵인(비용 제어 결함) | `--max-cases=1 --max-cases=156`으로 `--execute` | 156으로 조용히 진행(analyze가 실제로 시작됨) | 종료 코드 2, client 0회, analyze 0회 |

### 테스트와 mutation 검증

파일 저장소 27개(최초 16 + 결함 재현·회귀 11), CLI 29개(최초 20 + 결함
재현·회귀 9), 총 56개 테스트가 통과한다. 파일 시스템을 직접 쓰는 테스트는
각자 `mkdtemp`로 고유한 임시 디렉터리를 만들고 끝나면 지운다(권한을 바꾼
테스트는 지우기 전에 되돌린다). CLI 테스트 대부분은 인메모리 가짜
checkpoint/snapshot 저장소·가짜 preflight만 쓰고, 몇 개는 실제 파일
저장소(`readJsonFile`/`writeJsonFileAtomic`/`preflightJsonFileTarget`)를
임시 디렉터리에 대고 돌려 모듈이 실제로 맞물리는지 확인한다. 실제 OpenAI·
네트워크 호출은 전부에서 0회다(`analyzeCaseText`는 항상 fake).

**최초 구현(§9-13 처음 작성 시) mutation 검증 — 3라운드**:

1. **지연 client 생성을 즉시 생성으로 바꿈** — "기존 체크포인트가 무효면
   client를 만들지 않는다" 테스트 1개만 실패(`1 !== 0`).
2. **`--max-cases=0` 거절 정규식을 느슨하게 바꿈**(`[1-9][0-9]*`→`[0-9]+`) —
   "0이거나 정수가 아니면 거절한다" 테스트 2개만 실패(`0 !== 2`).
3. **원자적 쓰기의 `rename` 단계를 통째로 건너뜀** — 쓰기 실패 보존·임시
   파일 정리·key 순서 무관 동일성 테스트 3개만 실패.

**Codex 독립 검수 결함 수정(2026-09-18, 이번 수정) mutation 검증 — 5라운드**,
모두 수정 전 결함을 실제로 재현한 뒤 수정하고 검증했다:

4. **`runExecute`에서 preflight 호출 두 줄을 통째로 제거** — "checkpoint
   경로가 preflight에 실패하면 0회다"·"snapshot 경로가 preflight에 실패하면
   0회다"·"두 경로 모두 client 생성보다 먼저 preflight된다"(CLI 29개 중)와
   "checkpoint 부모 디렉터리가 실제로 없으면 즉시 실패한다"(실제 파일 시스템
   통합 테스트) 4개만 실패했다. 이 mutation을 적용한 채로 결함 1의 재현
   스크립트(잘못된 checkpoint 경로로 `--execute`)를 다시 실행해, client
   생성·analyze가 각각 1회씩 다시 발생함을 직접 확인했다 — 수정 전 실제
   증상과 정확히 같았다.
5. **`parseFlags`에서 중복 key 거절·`--dry-run`/`--execute` 반복 거절 로직을
   모두 제거**(원래의 "마지막 값이 이긴다" 동작으로 되돌림) — "`--dry-run`이
   두 번 나와도 거절"·"`--execute`가 두 번 나와도 거절"(모드 게이트)과
   "`--max-cases`가 두 번 나오면 거절"·"중복된 checkpoint/snapshot/baseline
   hash도 거절"(execute 인자 검증) 4개만 실패했다. 이 mutation을 적용한 채로
   결함 3의 재현 스크립트(`--max-cases=1 --max-cases=156`)를 다시 실행해,
   analyze가 실제로 시작됨(1회 이상 호출)을 직접 확인했다 — 수정 전 실제
   증상과 정확히 같았다.
6. **`writeJsonFileAtomic`의 직렬화 try/catch를 제거**(`stablePrettyJson`
   호출을 감싸지 않게 되돌림) — "BigInt는 원본 TypeError 없이 수렴한다"·
   "순환 참조는 수렴한다"·"직렬화 실패 시 임시 파일을 만들지 않는다"·
   "직렬화 실패는 기존 정상 파일을 건드리지 않는다" 4개만 실패했다(단,
   "top-level undefined는 수렴한다" 테스트는 실패하지 않았다 — `writeFile`
   호출 자체가 `undefined` 인자에 별도로 실패해 뒤쪽의 쓰기 실패 catch가
   우연히 같은 결과로 수렴시켰기 때문이다. 이 사실을 통해 BigInt·순환
   참조 두 테스트가 이 직렬화 경계의 실제 방어를 검사하는 결정적 테스트임을
   확인했다). 이 mutation을 적용한 채로 결함 2의 재현 스크립트
   (`writeJsonFileAtomic(path, {bad: 1n})`)를 다시 실행해, raw `TypeError:
   Do not know how to serialize a BigInt`가 그대로 다시 새는 것을 직접
   확인했다 — 수정 전 실제 증상과 정확히 같았다.
7. **`readJsonFile`의 읽은 뒤 크기 재확인 줄을 제거** — 이 줄을 검사하는
   소스 패턴 테스트 1개만 실패했고, 기존 "크기 상한을 넘으면 거절한다"
   블랙박스 테스트는 실패하지 않았다 — `stat()` 시점 확인만으로도 정적
   파일(테스트가 만드는 파일은 두 확인 사이에 커지지 않는다) 시나리오는
   이미 잡히기 때문이다. 이로써 이 줄이 블랙박스로 결정적으로 재현할 수
   없는 TOCTOU 경쟁 상황만을 위한, 독립적으로 필요한 방어선임을 확인했다.

일곱 라운드 모두 검증 후 `cp`로 백업한 원본으로 복원하고 `diff`로 바이트
단위 동일함을 확인한 뒤 `tsc --noEmit`과 전체 관련 테스트를 다시 통과시켰다.

### 아직 연결하지 않은 경계

- 실제로 `--execute`를 실행하지 않았다. 실제 OpenAI client를 만들지 않았고
  실제 API key를 쓰지 않았다. Supabase·DB·Edge Function·배포는 이번에도
  연결하지 않았다.
- `baseline-catalog-version-hash`는 이번에도 CLI 인자로만 받는 명시적 신뢰
  입력이다(§9-10 수정 6·§9-11·§9-12와 같은 신뢰 경계) — 후속 실제 운영
  executor 연결 단계에서는 이 값을 candidate payload가 아니라
  validation-context RPC가 읽어 온 활성 기준 카탈로그 버전에서 가져와야
  한다.
- 장애 시 "직전에 저장되지 않은 최대 1건이 다시 analyze될 수 있다"는 §9-12의
  성질은 이 CLI에도 그대로 적용된다 — 파일 저장소가 원자적이어도 "analyze
  성공 직후, saveCheckpoint 완료 전"에 프로세스가 죽으면 그 결과는 사라진다.
- 최종 스냅샷은 156건이 모두 검증된 뒤에만 한 번 만들어진다 — 이 CLI는
  스냅샷을 활성 카탈로그나 DB에 반영하는 어떤 executor에도 연결돼 있지
  않다.
- 로컬 산출물 디렉터리 관례(`/automatic-scripture-catalog-analysis-runner.local/`)를
  `.gitignore`에 추가했을 뿐, 실제로 그 디렉터리를 만들거나 그 안에 실행
  결과를 쓴 적은 없다(이번 작업에서 `--execute`를 실행하지 않았으므로).

### 검증

파일 저장소 테스트 27/27, CLI 테스트 29/29, runner 테스트 36/36, builder
테스트 36/36, 스냅샷 계약·현재 환경 결속 테스트 82/82(계약 65 + 환경 17),
자동 Scripture Catalog 전체 테스트 1009/1009, `npm run test:logic`
4332/4332, `npm run test:ui` 113/113, `npx tsc --noEmit` 오류 0이 모두
통과했다. `git diff --check` 공백 오류 없음, `package.json`·
`package-lock.json` 변경 없음도 확인했다. 새·수정 파일(`file-store.ts`·그
테스트·`cli.ts`·그 테스트·`.gitignore`·이 문서)에 API key·비밀번호·토큰
패턴이 없는지 직접 스캔해 확인했다. OpenAI·Supabase·DB 호출, 커밋·푸시·
배포는 없었다(결함 재현·수정 확인은 fake dependency를 주입한 독립 스크립트로만
했다).


## 9-14. 실제 156건 고정 분석 스냅샷 생성 (2026-09-18, 후속)

§9-13의 안전 CLI를 실제로 실행해 `EVALUATION_CASES` 153건과
`SAFETY_BOUNDARY_SCENARIOS` 3건, 총 156건의 분석을 순차 생성했다. 호출은 한 건씩
`await`했고 각 성공 직후 체크포인트를 원자적으로 저장했다. API key는 셸 변수로만
전달하고 매 실행 뒤 지웠으며, raw response·provider 오류 원문·token usage는
체크포인트나 스냅샷에 저장하지 않았다. 이 계약 때문에 이번 실행의 정확한 총 토큰과
비용은 산출물에서 다시 계산할 수 없으며 문서에 추정값을 사실처럼 기록하지 않는다.

실행 중 두 가지 중단을 확인했다.

1. EVAL-057 첫 호출에서 `analyze_failed`가 두 번 발생했다. 새로 입력한 API key를
   다시 입력한 뒤 같은 사례가 즉시 성공해, 체크포인트 손상 없이 56건 prefix에서
   재개되는 것을 실제로 확인했다.
2. EVAL-068은 유효한 분석이 `injustice_mistreatment`를 선택했지만 평가 오라클만
   `relationship_conflict_forgiveness`를 기대해 `analysis_invalid`로 멈췄다. 이 문장은
   원본 코퍼스에서도 `injustice_mistreatment` / `betrayal`이고, 인접 EVAL-067·069,
   카드 확장표, 최초 평가 오라클도 같은 영역이었다. 과거 단일 Luna 결과를 반영해 만든
   예외를 제거하고 `expectedPrimaryDomain: injustice_mistreatment`, preferred SC-046,
   acceptable `[SC-046, SC-008]`로 교정했다. 회귀 테스트로 text·domain·rank·cluster와
   이 세 값을 직접 고정했다. 교정 시 이미 저장된 67개 결과를 새 156개 계획과 전부 다시
   검증한 뒤에만 체크포인트의 `planFingerprint` 한 필드를 원자적으로 재결속했으며,
   EVAL-068을 다시 실행해 68번째 결과로 정상 저장되는 것을 확인했다.

최종 로컬 산출물은 Git에서 제외된
`automatic-scripture-catalog-analysis-runner.local/checkpoint.json`과
`snapshot.json`이다. 두 파일 모두 권한 0600이다. 최종 검증 결과는 다음과 같다.

- 체크포인트 156/156, 다음 사례 없음, 추가 계획 0건.
- 스냅샷 156건(`corpus_regression` 153 + `safety_boundary` 3).
- `validateAnalysisSnapshotAgainstCurrentEnvironment`: valid, 오류 0건.
- 체크포인트 156건에서 다시 조립한 스냅샷과 저장된 스냅샷이 canonical JSON으로 동일.
- plan/source corpus fingerprint:
  `sart_747941fe33c21d7f765464a69cfe6bb3045f7aa5b215e2cd9923d02c9b4711f4`.
- frozen analysis artifact hash:
  `sart_30fd74c9376bb3a1bf798d05376ee02320a3a37a26606c099aa9b2905dca1183`.
- 최종 snapshot fingerprint:
  `sart_2ef11743f6cbb60390b1b083114f15e1dcbfeb88ef2fcd94da7f2bfd7ed869c4`.

이 로컬 파일 생성 당시에는 activation-ready가 아니었다. 스냅샷은 Git이나 DB에 없었고,
deterministic adapter·executor·validation record·운영 Supabase와도 연결되지 않았다.
이후 Git 고정과 `safetyBoundary`·`corpusRegression` adapter 연결은 §9-15에서 수행했다.
앱 런타임·운영 카탈로그·배포 상태에는 여전히 변화가 없다.


## 9-15. 고정 분석 스냅샷 v1 Git 보관과 결정적 adapter 연결 (2026-09-18, 후속)

### Git에 고정한 산출물

§9-14의 로컬 `snapshot.json`을
`supabase/functions/_shared/automatic-scripture-catalog-analysis-snapshot-v1.ts`로 생성해
Git이 추적할 수 있는 타입스크립트 데이터 모듈로 옮겼다. Node와 Edge가 JSON import 옵션이나
파일 시스템 없이 같은 값을 읽게 하려는 선택이다. 156건(`corpus_regression` 153 +
`safety_boundary` 3), 기준 catalog 지문, source/frozen/top-level 세 지문은 §9-14의 값과
글자 하나까지 같다. 알려진 최상위 지문을 테스트에 직접 고정했으므로 cases를 바꾸고 내부
해시만 함께 다시 계산하는 변조도 통과하지 못한다.

산출물에는 합성 평가 문장과 구조화된 분석만 있다. raw response·reasoning·token usage·API key·
사용자·세션 식별 필드는 없다. 계약의 exact-fields·금지 내용 검사, 하위 해시 재계산,
`validateAnalysisSnapshotAgainstCurrentEnvironment`를 다시 통과해야만 adapter가 만들어진다.
기준 catalog도 전달받은 내용을 검증하고 실제 지문을 다시 계산한다. 하나라도 다르면 부분
adapter를 돌려주지 않는다.

### 두 결정적 adapter

`automatic-scripture-catalog-frozen-analysis-adapter.ts`를 추가했다. 파일·네트워크·DB·환경변수·
시계에 접근하지 않는 순수 adapter이며, 버전 진입점은 임의 snapshot 인자를 받지 않고 Git의
`FROZEN_ANALYSIS_SNAPSHOT_V1`만 선택한다.

- `CatalogCard`를 Gate의 `ScriptureCard`로 투영할 때 모든 본문 범위·태그·설명·오용 방지 문장을
  복사한다. 후보는 기존 `validateCatalogCandidate`를 다시 통과해야 하고, 검증기가 돌려준
  proposed catalog만 Gate에 넣는다.
- `safetyBoundary`는 3건을 proposed catalog로 실제 Gate에 넣어 `expectedRoute`와
  `observedRoute`를 만든다. Gate가 카드보다 safety를 먼저 보는 후보-무관 전역 가드라는 의미는
  그대로다.
- `corpusRegression`은 같은 고정 분석 153건을 기준 catalog와 proposed catalog에 각각 넣어
  `baseline`·`candidate`를 계산한다. recommend는 primary domain과 선택 카드가 기존
  `acceptableCardIds` 안에 있는지, domain_choice는 route와 두 후보 domain의 순서까지,
  no_coverage는 route를 확인한다. corpus 사례가 safety로 잘못 빠지면
  `safetyFalsePositive=true`다.
- `evaluationCorpusVersion`·`rulesVersion`은 전체 snapshot fingerprint를 쓴다. 따라서 코퍼스,
  고정 분석, Analyzer/Gate/Matcher 환경 중 하나라도 바뀐 산출물을 같은 버전처럼 기록할 수 없다.
- 반환 payload는 매 실행 새 객체다. 검증 직후 snapshot·baseCatalog·candidate를 복제해
  결속하므로, 호출자가 원본이나 반환 배열·결과를 바꿔도 다음 실행과 Git 산출물은 바뀌지 않는다.

현재 기준 catalog를 실제 재생한 결과는 domain match 153/153, acceptable match 143/153,
safety false positive 0/153이다. baseline에서 이미 acceptable이 아니었던 10건을 새 후보가
고쳐야 통과하는 계약은 아니다. 기존 성공 143건 중 하나라도 candidate에서 실패로 내려가면
회귀다. SC-002와 의미 점수를 같게 만든 결함 후보 fixture는 기존 허용 결과 9건을
ambiguous/비허용으로 바꾸며 adapter가 그 9개 ID를 정확히 드러냈다. 기존 영역과 겹치지 않는
새 영역 fixture는 153건의 baseline/candidate 결과가 모두 같았다. 이것은 새 영역 활성화 허가가
아니라 기존 코퍼스 비회귀만 뜻한다.

기존 executor와의 실제 타입·parser·봉인 연결도 테스트했다. 두 adapter 결과 3건/153건이
`executeAutomaticScriptureCatalogValidation`의 payload parser와 validation record 봉인을
통과한다. 이 통합 테스트의 `candidateGenerationEvaluation`은 명시적인 테스트 fixture다.
운영 후보 생성 adapter나 독립 사례 저작 근거를 구현한 것이 아니며, 빈 결과로 통과시킨 것도
아니다.

### 결함 주입과 검증

다섯 핵심 경계를 하나씩 임시로 무력화했다: 검증한 snapshot/baseCatalog 참조를 그대로 보존,
현재 환경 대조 생략, candidate Gate 결과를 baseline 결과로 대체, acceptable allowlist 무시,
유효하지 않은 후보 허용. 다섯 변형 모두 신규 테스트가 실패로 잡았고 매번 원본을 바이트 단위로
복원했다.

신규 테스트 18/18, `src/lib/automatic-scripture-catalog-*.test.ts` 612/612,
`npm run test:logic` 4351/4351, `npm run test:ui` 113/113,
`npx --no-install tsc --noEmit` 오류 0이 통과했다. package 파일은 바꾸지 않았다.
OpenAI·Supabase·DB 호출, 배포는 없었다.


## 9-16. 후보 생성 사례 증거 계약 v1과 결정적 Gate 재생 (2026-09-18, 후속)

`candidateGenerationEvaluation`이 단순한 `{caseId, cardId, passed}` 목록만 받던 공백을 메우기
위해 `automatic-scripture-catalog-candidate-generation-evidence.ts`를 추가했다. 이 계약은 후보가
생긴 뒤 만드는 합성 사례와 동결 분석을 candidate hash·research-result hash·base/proposed catalog
hash·후보 생성 model/prompt·현재 Analyzer 환경에 함께 결속하고, 저장된 최상위 artifact hash를
내용에서 다시 계산한다. 사례는 카드마다 정확히 세 건이며 코드가 정한 `GEN-SC-…-01~03` 순서,
중복 없는 문장, 해당 카드 영역으로 resolved된 normal 분석이어야 한다. 카드 id·영역 id·성경 표기를
문장에 직접 넣어 답을 암시할 수 없고, 동결 분석과 safety 내부의 계약 밖 필드도 거절한다.

후보 생성기는 현재 `gpt-5.6-sol`로 고정한다. 사례 작성 profile은
`aroeda-candidate-generation-case-author-astra`(`gpt-6-astra`, independence group
`openai-gpt-6`) 하나를 전체 값과 재계산한 profile hash로 고정한다. 모델 이름만 Astra로 적거나
prompt/schema/profile version을 바꾼 profile은 통과하지 않는다. 다만 이 단계의 profile은
version 이름표만 들고 있었다 — 자세한 것은 9-18을 보라. 모델 allowlist가 정한 계열을
대조해 후보 생성 모델과 사례 작성 모델의 independence group이 같으면 별도 오류로 거절한다.
따라서 Sol이 자기 시험 문제를 만들거나 Terra로 이름만 바꿔 같은 계열이 자기 채점하는 경로는
닫혀 있다.

검증된 증거 adapter는 후보 계약을 다시 검증해 만든 proposed catalog에 각 동결 분석을 실제
Recommendation Gate로 재생한다. `recommend`이며 선택 카드가 사례의 cardId와 정확히 같을 때만
`passed=true`를 만든다. 실행 시 executor가 넘긴 후보 지문도 증거의 candidateHash와 다시
대조하므로 다른 후보에 adapter를 재사용할 수 없다. 모델이 pass를 주장하는 필드는 증거 스키마에 없다. 생성 시점에 입력을
복제하고 반환 때 새 payload를 만들므로 호출자가 원본이나 이전 반환값을 바꿔도 다음 판정은
달라지지 않는다.

현재 Analyzer는 정적 17개 영역만 안다. 그래서 `new_domain_with_cards`는 증거가 있어 보이더라도
동적 domain manifest가 구현되기 전에는 명시적으로 fail-closed다. §9-16 완료 당시에는 Astra
사례 저작 transport와 Analyzer 실행이 없었고, 이후 §9-17에서 구현했다. append-only DB 표/RPC,
validation payload와 activation SQL의 증거 재대조는 아직 없으므로 운영 자동 활성화는 열리지 않았다.

회귀 테스트 20건은 정상 증거와 실제 Gate 통과, 같은 Sol 계열 자기 채점, 임의 Astra profile,
임의 profile/artifact hash, 후보·연구·두 catalog 버전 결속, 사례 수·순서·중복, 답을 암시하는
문장, analysis/safety 여분 필드, 위험·영역 선택·대상 영역 불일치, 현재 환경 차이, 새 영역 차단,
입출력 격리와 외부 접근 부재를 고정한다. 등록 profile 대조·independence group·artifact 재계산·
현재 환경 대조·새 영역 차단을 하나씩 임시로 무력화한 다섯 변형은 각각 신규 테스트 실패로
잡혔고, 매번 원본을 바이트 단위로 복원했다. OpenAI·Supabase·DB 호출은 없었다.
최종 검증은 신규 테스트 20/20, 자동 Scripture Catalog 전체 632/632,
`npm run test:logic` 4371/4371, `npm run test:ui` 113/113,
`npx --no-install tsc --noEmit` 오류 0으로 통과했다.


## 9-17. Astra 사례 저작·Analyzer 순차 실행·증거 봉인 (2026-09-22)

추가 파일은 `_shared/automatic-scripture-catalog-case-author.ts`,
`automatic-scripture-catalog-generation-transport.ts`, `automatic-scripture-catalog-generation-runner.ts`,
`src/lib/automatic-scripture-catalog-generation-pipeline.test.ts`다. 기존 §9-15/16 코드와 산출물은 보존했다.

### 요청과 분석 경계

실행기는 기준 카탈로그와 후보를 복제·검증하고, 기존 영역 후보이며 생성 모델이 현재 Sol 설정과
같은 경우에만 사례 저작 요청을 만든다. 새 영역 또는 잘못된 후보는 외부 호출 전에 거절한다.
Astra 요청은 §9-16의 고정 profile을 사용하며 후보 카드의 문맥·설명·오용 방지 정보와 같은 영역의
경쟁 카드 설명만 보낸다. 점수·정답 태그는 보내지 않는다. 지시문은 카드 내용을 지시가 아닌
검증 대상 데이터로 취급하고, 합성 문장 작성·독립적인 생활 상황·안전 경계·개인정보 배제를 명시한다.
지시문 v1의 실제 지문도 회귀 테스트로 고정했다.

응답의 `scenarios`는 후보 cardId를 키로 쓰고 값은 정확히 세 문장의 배열이다. JSON schema는
필수 카드 집합과 여분 필드 금지를 강제하며 로컬 parser가 다시 검사한다. 객체 키 순서가 달라도
cardId로 대응하고 `GEN-SC-…-01~03` id는 코드가 만든다. 1~300자·앞뒤 공백·잘못된 타입·카드/영역
id·장절 패턴·개인정보 패턴을 확인하고 NFKC 정규화와 공백/문장부호 제거 뒤 중복도 거절한다.
문장의 의미상 중복이나 적절성 전체를 이 정적 검사만으로 증명하지는 않는다.

한 후보에 Astra를 한 번만 호출한다. 전체 저작 결과가 유효한 뒤에야 문장을 하나씩 Analyzer에
보낸다. Analyzer는 기존 `buildOpenAIPayload`의 모델·지시문·스키마를 그대로 쓰며 input은 합성
문장 하나뿐이다. 목표 카드·영역·Astra의 설명·정답을 붙이지 않는다. 한 분석이 끝나기 전에 다음
분석을 시작하지 않고, 각 결과의 exact-fields·태그 사전·normal 안전 수준·resolved 영역·대상
카드 영역을 검사한다. 마지막에 기존 증거 봉인 함수와 증거 validator를 다시 거쳐야만
`completed`와 evidence를 반환한다. 이 `completed`는 증거 생성 완료이며 후보 활성화 통과가 아니다.
카드가 선택되지 않는 유효 분석도 그대로 증거에 남고, 기존 Gate adapter가 `passed=false`를 낸다.
통과할 때까지 사례를 다시 쓰거나 분석을 반복하는 경로는 없다.

### 통신과 실패 결과

통신은 고정 Responses URL에 POST 한 번, redirect 금지, 재시도/다른 모델 전환 없음,
`store:false`, 도구 없음, 비스트리밍으로 제한한다. Astra와 Analyzer 모두 출력 상한 8192 tokens,
요청별 상한 60초다. 본문 읽기까지 시간 제한에 포함하며 abort를 무시하는 시험용 fetch도 deadline에
종료된다. 성공 응답은 최대 262144 bytes까지 읽고, 크기 초과·시간 초과·HTTP 실패 때 읽기를 취소한다.
HTTP 오류 본문은 읽거나 노출하지 않는다. SDK 자동 retry를 거치지 않고 native fetch를 사용한다.

응답은 완료 상태·기대 모델·단일 completed assistant message를 확인한다. 오류·incomplete·refusal·
tool output·중복 메시지·잘못된 JSON은 성공 글이 섞여 있어도 거절한다. reasoning·usage·원본 오류는
증거에 들어가지 않는다. 키는 서버 조립부에서 인자로 주입하며 파일·환경변수·DB·로그는 직접
읽거나 쓰지 않는다. transport factory 생성이나 모듈 import만으로는 호출하지 않는다.

실행기 실패는 `reason`과 분석 실패일 때의 코드 지정 caseId만 반환한다. 부분 증거·완료된
부분 분석·원본 오류·상세 모델 값은 반환하지 않는다. 체크포인트/재개/저장은 이번 실행기에 없으므로
별도의 명시적 재실행은 후보 전체를 새로 처리한다. 호출 횟수·비용 정책은 운영 조립부에서 정해야 한다.

### 검증과 남은 범위

신규 65개 테스트에서 실제 factory를 가짜 fetch로 연결해 Astra 1회→Analyzer 3회→증거 validator→
실제 Gate를 확인했다. 카드 두 장의 저작 1회/분석 6회, 순차 실행, 잘못된 마지막 문장 때문에
첫 분석도 시작하지 않는 경우, 중간 실패 뒤 호출 0회, 후보가 선택되지 않아 실제 Gate 판정이
실패하는 경우, 입력/분석 객체 격리도 확인했다. 모든 모델 응답은 fixture이며 실제 모델의 의미 품질·
실제 호출 성공을 증명하지 않는다.

모델 응답 대조·정규화 중복·여분 응답 필드·분석 여분 필드·대상 영역·입력 복제·실제 응답 크기·
redirect 금지의 8개 방어선을 각각 무력화했을 때 테스트가 실패했고 원본을 바이트 단위로 복원했다.

이 계약의 profile/hash는 의도된 작성 경로와 내용의 연결이며 모델 호출에 대한 전자서명은 아니다.
실제 provenance 신뢰는 서버 조립부·권한이 제한된 append-only 저장·활성화 시 재검증까지 필요하다.
증거 DB 표/RPC, validation payload/activation SQL 연결, 새 영역용 동적 manifest, 운영 호출은 아직
구현하거나 실행하지 않았다. 사람 사전 승인은 추가하지 않았다. 자동 검증→활성화→소유자 공지
정책은 유지하되, 연결이 끝나기 전까지 자동 활성화는 열리지 않는다.

최종 로컬 검증: 신규 테스트 65/65, 전체 로직 4436/4436, UI 9 suites/113 tests 통과,
TypeScript 오류 0. 패키지·마이그레이션 변경과 실제 모델·DB 호출은 없다.

확인한 API 기준: [OpenAI Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs),
[Astra 모델 지침](https://developers.openai.com/api/docs/guides/latest-model).

## 10. 아직 연결되지 않은 런타임 범위

- `analyze-situation`, `recommend-scripture`, `generate-prayer-guidance`와 앱은 여전히 정적 `scripture-cards.ts`·`situation-domains.ts`를 읽는다.
- 기존 7개 쓰기 RPC와 검증 context 읽기 RPC를 실제로 조율하는 Edge Function·스크립트가 없다.
  기준 카탈로그·validator profile도 등록되지 않았다.
- 후보를 자동으로 만드는 생성기와 실행기의 DB 오케스트레이션·Edge Function 연결부가 없다.
  Sol·Astra 신학 평가 fetch transport(§9-7)는 구현됐지만, 아직 실행기를 감싸는 운영 진입점에 연결되지 않았다.
- 결정적 검사 중 `safetyBoundary`·`corpusRegression`은 §9-15에서 Git 고정 스냅샷과 실제
  adapter로 연결됐다. `candidateGenerationEvaluation`은 §9-16에서 독립 사례 저작 profile에
  결속된 증거 계약과 실제 Gate 재생 adapter까지 생겼고, §9-17에서 Astra 사례 저작 transport와
  Analyzer 순차 실행·증거 봉인 실행기도 구현했다. append-only DB 보관, validation payload와
  activation SQL의 증거 재대조, 운영 조립부 연결은 아직 없다. **남은 공백을 빈 결과나 지어낸 사례로 메우지 않는다.** 이 항목들이 구현되기 전에는
  운영 orchestration이 완성되지 않았고 activation-ready가 아니다. 새 영역은 동적 Analyzer
  domain manifest·prompt/schema/runtime validator·포인터/롤백 원자성도 없으므로 계속
  fail-closed다.
- 공지 outbox를 읽어 보내는 발송기와 발송 결과 기록이 없다.
- validator용 활성 카탈로그·수요 읽기 RPC(§9-8)는 생겼다. 앱 런타임이 활성 카탈로그를 읽는 별도 경로와
  캐시·폴백 정책은 아직 없다.
- migration은 검증용 임시 컨테이너에만 적용했고(§9-1, §9-6), 운영 Supabase 프로젝트에는 적용하지 않았다.

## 11. 테스트

- `automatic-scripture-catalog-generation-pipeline.test.ts` (§9-17, 65건) — 고정 Astra 요청·카드별
  정확한 문장 집합·제공자 실패·통신 상한·비밀정보 비노출·Analyzer 공용 payload·호출 순서·
  실패 시 중단·입출력 격리·실제 factory/증거 validator/Gate 연결을 외부 호출 없이 검증한다.

- `automatic-scripture-catalog-contract.test.ts` — 기준 카탈로그(현재 17개 영역·51장 그대로), 지문 결정성, 정렬, 금지 설정·개인정보, 두 후보 종류와 거절 규칙.
- `automatic-scripture-catalog-activation-contract.test.ts` — 검증 기록 무효/막음 구분, 실제 개역한글 원문 지문 재계산, 중복 재계산,
  기준 등록·후보·검증 보관, 활성화 원자성·멱등성·fail-closed, 롤백 규칙, authority 분리, 공지 내용.
  여기에 "겹침에 가려지지 않는 단일 규칙" 묶음이 있다. 규칙 하나만 어긋나게 만들고 그 규칙의 오류 문구를 직접 확인한다
  (criterion 순서·카드 여분 필드·cardId 대조를 `resealRecord`로 지문까지 다시 맞춰 독립적으로 고정한 3건 포함, §9-5).
- `automatic-scripture-catalog-migration.test.ts` — SQL 사본 대조, 표·함수 권한, append-only·포인터 트리거, 활성화·롤백 순서와 재확인 조항,
  validator profile 자가 등록 금지, 수요 기록의 날짜 위조 금지, 사람 검토 migration 무변경(SHA-256 고정), 개인정보·외부 발송 부재.
  커밋 시점 포인터 전환 확인이 SECURITY DEFINER인지(§9-1에서 실제 DB가 잡아 낸 결함), search_path 고정,
  모든 역할 실행 권한 회수, `deferrable initially deferred` 유지, 다른 private 함수까지 definer로 넓히지 않는지도 함께 고정한다.
- `automatic-scripture-catalog-defect-regression.test.ts` — 특정 새 영역과 무관한 `other_uncovered` 수요, 임의 산출물 지문,
  자기 주장 평가자 독립성, 표시 이름 누락, 잘못된 성경 표기, 연구 결과 없는 후보가 다시 허용되지 않도록 고정.
- `automatic-scripture-catalog-validator-registry.test.ts` — 실제 profile 네 개, 모델 계열 독립성, rubric 지문,
  단계 순서와 Astra 호출 게이트를 고정.
- `automatic-scripture-catalog-validator-executor.test.ts` — 정상 기록·결정성·새 영역 후보, 단계별 조기 중단,
  Sol/Astra 누락·중복·실패, 후보·rubric 지문 변경, 외부 호출 부재와 개역한글 절 번호 회귀를 고정.
  criterion 단위 신학 attestation(§9-5) 이후로는 카드별 criterion 아홉 개의 누락(앞·뒤)·중복·순서 뒤바뀜·
  카드 최종 verdict 끼워 넣기·criterion 여분 필드도 각각 고정한다.
- `automatic-scripture-catalog-theology-openai-adapter.test.ts` — 요청 spec의 결정성·고정 필드·모델 분리,
  응답 해석 순서(기술적 실패 vs criterion fail), 카드·criterion 단위 누락·중복·순서·잘못된 id·여분 필드를 각각 고정.
- `automatic-scripture-catalog-theology-openai-fetch-transport.test.ts` — 실제 네트워크 없이 요청 body·횟수·시간 제한,
  HTTP·adapter 실패 매핑, Sol/Astra model 보존, 비밀정보 비노출과 환경변수·DB·로그 책임 경계를 고정.
- `automatic-scripture-catalog-validation-context.test.ts` — 수요 연결·기간 RPC spec, 활성 카탈로그 지문 재계산,
  exact-fields·정렬·중복·대상·날짜·횟수와 개인정보·읽기 전용 경계를 고정.
- `automatic-scripture-catalog-validation-context-migration.test.ts` — 읽기 함수 하나만 추가하는지, 활성 포인터·
  카탈로그·대상 수요만 읽는지, 기간·키 검증과 service_role 전용 권한·private 표 격리를 고정.
- `automatic-scripture-catalog-validator-profile-migration.test.ts` — 코드 registry와 SQL 등록 manifest·profile 지문이
  정확히 같고, profile 네 건 외 스키마·함수·권한을 바꾸지 않는지 확인.
- `automatic-scripture-catalog-analysis-snapshot-contract.test.ts` (§9-9·§9-10·§9-12, 65건) —
  safety_boundary·corpus_regression 사례를 담은 스냅샷의 exact-fields·caseId 오름차순·
  candidate_generation 거절·동결 분석의 실제 `validateSituationAnalysis` 재검사를 고정한다.
  `analysis`와 `analysis.safety`에도 exact-fields를 적용해 `rawResponse`·`userId`·
  `analysis.safety.sessionId` 같은 여분의 필드가 모든 해시를 올바르게 재계산해도 거절되는지
  고정한다. `sourceCorpusArtifactHash`·`frozenAnalysisArtifactHash`가 cases에서 직접 재계산한
  값과 대조된다는 것(형식만 맞는 임의의 해시로 top-level fingerprint만 다시 맞춰도 거절됨을
  "[재현]" 테스트로 먼저 고정), 두 종류가 각각 최소 1개 있어야 한다는 것, frozen analysis와
  expected의 교차 일관성(urgent 분석+normal expectedSafety, recommend route인데 다른 domain,
  domain_choice 후보 순서 등)을 각각 단일 오류로 고정한다. 사례 text·분석 태그·expected·
  environment의 모델·스키마·태그 사전·domain manifest·Gate·Matcher·기준 카탈로그 결속·두 하위
  해시·저장된 fingerprint 중 무엇 하나만 바뀌어도 정확히 그 하나의 오류만 나는지(다른 검사가
  우연히 가려 잡지 않는지) 대조한다. §9-12에서 추가한 `validateAnalysisSnapshotCase`(사례
  하나만 독립적으로 검증)가 `validateAnalysisSnapshot`이 스냅샷 전체를 볼 때와 정확히 같은
  오류를 내는지(로직 복제가 아님을 직접 대조), 교차 일관성 위반과 candidate_generation을
  거절하는지를 고정한다.
- `automatic-scripture-catalog-analysis-environment.test.ts` (§9-10 수정 6, 17건) —
  `buildCurrentAnalysisSnapshotEnvironment`가 결정적이고 baselineCatalogVersionHash 인자를
  그대로 돌려주는지, 소스에 네트워크·환경변수·파일 시스템·시계 접근이 없는지 고정한다.
  기존 `validateAnalysisSnapshot`만으로는 임의 environment(`analyzerModel:
  'arbitrary-model'` 등)도 내부적으로 일관되면 통과한다는 것을 먼저 재현하고,
  `validateAnalysisSnapshotAgainstCurrentEnvironment`가 그 스냅샷을 거절한다는 것, environment
  여덟 필드(model·instructions·schema·taxonomy·domain manifest·Gate·Matcher·baseline
  catalog) 중 하나만 바뀌고 나머지 해시를 모두 올바르게 재계산해도 정확히 그 필드 하나의
  오류만 나는지, 잘못된 baseline hash 인자와 스냅샷 구조 오류가 각각 올바른 순서로(구조
  오류가 먼저) 보고되는지를 고정한다.
- `automatic-scripture-catalog-frozen-analysis-adapter.test.ts` (§9-15, 18건) — Git 고정 산출물의
  156건·종류별 개수·세 지문·기준 catalog 지문, 계약/현재 환경 재검증, raw response·usage·사용자
  식별 필드 부재를 고정한다. CatalogCard→Gate 카드 무손실 투영, safety 3건, corpus 153건의 실제
  baseline/candidate 계산, 새 영역 fixture의 비회귀, SC-002 의미 중복 fixture의 9건 회귀 검출,
  반환값 격리, 후보 재검증, 버전 진입점과 executor parser·봉인 연결을 확인한다. executor 통합의
  candidateGeneration은 아직 구현되지 않았음을 드러내는 명시적 fixture만 쓴다.
- `automatic-scripture-catalog-candidate-generation-evidence.test.ts` (§9-16, 20건) — 후보·연구·
  catalog 버전·현재 Analyzer 환경·고정 Astra 사례 저작 profile과 그 independence group을 하나의
  재계산 가능한 증거로 결속한다. 카드별 정확히 세 사례의 id·순서·문장 중복/답 암시·동결 분석
  exact-fields와 영역/안전 일관성을 고정하고, proposed catalog의 실제 Gate가 해당 카드를 고른
  경우에만 pass가 되는지 확인한다. 실행 후보 지문도 다시 대조한다. 같은 Sol 계열 자기 채점,
  임의 profile/hash, 입력·반환값 변조,
  동적 manifest가 없는 새 영역 후보가 다시 허용되지 않도록 고정한다.
- `automatic-scripture-catalog-analysis-snapshot-builder.test.ts` (§9-11, 36건) —
  `EVALUATION_CASES`(153) + `SAFETY_BOUNDARY_SCENARIOS`(3)에서 만든 156개 결정적 계획이
  caseId 오름차순·중복 없음·결정성을 지키는지, EVAL 153개의 ID·text·expected가 부가
  필드(domain·rank·cluster·smoke·isNewCardSmoke·rationale) 없이 정확히 투영되는지를
  고정한다. SAFE-001~003은 (source, domain, rank)로 원본을 찾은 뒤 **검토 시점에
  테스트 파일에 직접 하드코딩해 둔(순환 비교가 아닌) text·expectedSafety와도 다시
  대조**하고, 같은 (source, domain, rank)라도 text만 바뀌거나 caution을 유지한 채
  categories만 바뀌거나 안전 수준 자체가 바뀌면 예외로 멈추며, 원본 배열 순서만
  바뀌면 동일한 계획을 만들고, 한 SAFE 사례가 불일치해도 다른 SAFE ID로 대체되거나
  부분 계획(155개 등)을 조용히 돌려주지 않는지를 고정한다(Codex가 재현한 결함의
  회귀 방지). 외부 분석 결과가 계획과 완전히 1:1 대응해야만 스냅샷이 만들어지고,
  누락·추가·중복·caseId 불일치·text 불일치·순서 변경·wrapper와 analysis·analysis.safety의
  계약 밖 필드·유효하지 않은 분석·잘못된 baseline hash 중 무엇이든 어긋나면 부분 스냅샷
  없이 구체적 필드 경로가 담긴 오류만 돌려주는지, 성공한 스냅샷의 environment·두 하위
  해시·fingerprint가 기존 계산 함수 결과와 정확히 같은지를 고정한다.
- `automatic-scripture-catalog-analysis-snapshot-runner.test.ts` (§9-12, 28건) —
  빈 체크포인트(`null`)에서 EVAL-001부터 시작하는지, 유효한 prefix 뒤 정확한 다음
  사례부터 재개하는지, 완성 체크포인트(156/156)면 analyze 호출이 0회인지,
  `maxCases` 0·1·여러 건과 음수·비정수 거절을 고정한다. 각 성공 결과 뒤 정확히
  한 번씩 저장을 호출하는지, 저장이 끝나기 전에는 다음 analyze를 부르지 않는지(저장
  실패 시나리오로 확인), analyze 예외·계약 위반 분석(analysis 여분 필드)·교차
  일관성 위반 분석이 각각 그 시점까지의 정상 prefix만 남기고 저장되지 않는지,
  저장 실패 뒤 추가 analyze 호출이 없는지, 잘못된 baseline hash가 analyze·저장
  없이 즉시 거절되는지를 고정한다. `validateAnalysisRunnerCheckpoint`가 중간 누락·
  순서 뒤집힘·중복·계획 밖 사례·text 변경·다른 계획 지문·다른 environment·계약 밖
  wrapper 필드·raw response/token usage/사용자 식별자 필드를 각각 거절하는지 고정한다.
  156건을 전부 처리한 completed 스냅샷이 기존 builder를 직접 호출해 만든 스냅샷과
  `deepEqual`로 동일한지, 소스에 OpenAI·fetch·환경변수·파일 시스템·console·Supabase
  접근이 없는지, analyzer·store가 이 테스트가 만든 인메모리 가짜 함수임을 호출
  횟수·인자로 직접 확인한다.

규칙을 일부러 깨뜨려 테스트가 실제로 잡는지 확인했다(mutation testing). TypeScript 12개 + SQL 6개 + 순환 검증 위험 7개,
모두 25개 변형을 넣어 보았다.

처음 돌렸을 때 **8개가 잡히지 않았다.** 구현은 옳았지만 규칙끼리 서로 가려 주고 있어서, 그 규칙을 지워도
다른 확인이 대신 잡아 주는 상태였다(= 그 규칙 자체를 증명하는 테스트가 없었다).

- payload 지문 재계산, 항목별 attestation 필수, attestation 판정 일치, 수요 subjectKey 연결
- SQL의 attestation 권한 확인, SQL의 수요 집계 재대조
- fixture와 검증기가 같은 헬퍼를 쓰는 두 곳: 개역한글 본문 지문, 산출물 지문의 항목 이름

그래서 각 규칙 하나만 어긋나게 만들고 그 규칙이 내는 오류 문구를 직접 확인하는 테스트를 더했고,
validator profile 자가 등록 금지와 수요 날짜 위조 금지도 새로 고정했다. 다시 돌렸을 때 **25개 변형이 모두 실패로 잡힌다.**
테스트에 쓰인 카드·validator·평가 결과는 시험용 fixture이며 실제 값이 아니다.

## 9-18. 사례 저작 지시문·스키마를 증거에 결속 (2026-09-22, 후속)

9-16의 사례 작성 profile은 `promptVersion`·`schemaVersion`이라는 **이름표만** 들고 있었다.
그래서 지시문이나 Structured Output 스키마를 고쳐도 봉인된 증거가 바이트 단위로 그대로였고,
옛 설정으로 만든 증거를 지금 증거로 받아들이게 된다. Analyzer 쪽은 반대였다 —
`environment.analyzerInstructionsHash`·`analyzerSchemaHash`가 원문 지문을 담고 있어서 지시문이
바뀌면 옛 증거가 거절된다. 이 비대칭을 없앴다.

원본을 한곳으로 모았다. `automatic-scripture-catalog-case-author-contract.ts`가 지시문 원문,
전송 스키마 생성기, 사례 수·문장 길이 상한의 유일한 출처다. 요청을 만드는 곳, 증거를 봉인하는
곳, 증거를 다시 검증하는 곳이 모두 이 파일을 쓴다. 증거 모듈이 case-author를 직접 import하면
순환이 되므로(case-author가 증거 모듈의 profile을 쓴다) 양쪽이 함께 의존하는 순수 계층으로
분리했다. 이 파일은 네트워크·DB·파일·환경변수·시계를 읽지 않는다.

결속은 두 자리로 나눈다. 스키마에는 후보의 카드 id가 `required`와 `properties`에 들어가므로
후보마다 값이 달라져 정적 profile에 담을 수 없기 때문이다.

- `caseAuthorProfile.instructionsHash` — **정적**. 실제 요청에 쓰는 `CASE_AUTHOR_INSTRUCTIONS`
  원문의 지문이며, 모듈 적재 시점에 그 문자열에서 계산한다. 하드코딩한 상수가 아니다.
- `caseAuthorRequest.schemaHash` — **후보별**. 실제로 전송하는 `text.format` 전체(`name`·
  `strict`·스키마)의 지문이다. 검증할 때 **같은 후보의 카드 id**로 스키마를 다시 만들어 대조한다.

따라서 지시문 한 글자, 사례 수 상한, 문장 길이 상한, `additionalProperties`, `strict`, 스키마
이름 중 무엇이 바뀌어도 이전 설정으로 봉인한 증거는 거절된다. 버전 문자열 비교나 문서에 적어 둔
고정 해시 비교가 아니라, 검증 시점에 살아 있는 원본에서 다시 계산한 값끼리 대조한다.

회귀 테스트는 지시문만 바꾼 경우, 스키마만 바꾼 경우(사례 수 상한·스키마 이름), 둘을 함께 바꾸고
profile hash와 최상위 artifactHash까지 전부 다시 계산한 위조 설정, `caseAuthorRequest` 누락과
계약 밖 항목을 각각 거절하는지 고정한다. 정상 증거 통과와 다른 후보 증거 재사용 차단도 함께
확인한다. 파이프라인 테스트는 실행기가 봉인한 두 지문이 실제로 전송된 본문의 `instructions`와
`text.format`에서 나온 값과 같은지 끝단에서 대조한다. 핵심 비교 두 곳을 각각 일부러 지워 해당
테스트가 실패하는 것을 확인하고 원본을 복원했다.

**이 지문들이 증명하지 않는 것.** 설정의 동일성만 말한다. 실제로 모델을 불렀다는 증명도
전자서명도 아니다. 증거를 쓸 수 있는 주체는 하위 지문과 최상위 지문을 모두 다시 계산해 사례를
지어낼 수 있고, 그렇게 만든 증거는 스스로 일관되다는 것만 증명한다. 그 경계는 권한이 제한된
append-only 저장과 활성화 시 재검증으로만 좁혀지며 아직 구현되지 않았다.

이번 작업에서 **고치지 않은 것**(후속): 요청별 timeout 값의 전달 경로와 후보 전체 실행의
마감 시각(9-19에서 처리), Analyzer 요청 설정이 운영 `analyze-situation`과 다른 점, 증거 DB
표·RPC·활성화 연결. 사람 사전 승인은 추가하지 않았다.

## 9-19. 요청별 시간 제한과 후보 전체 실행 마감 (2026-09-22, 후속)

두 가지가 비어 있었다. `transport.author`가 `spec.timeoutMs`를 무시하고 언제나 60초를
넘겼고, 후보 전체 실행에는 마감이 아예 없었다. 후보당 카드 5장 × 카드당 3사례이므로 저작
1회 + 분석 최대 15회가 순차로 이어지고, 각 호출이 60초를 온전히 쓰면 전체가 960초까지
늘어난다. 이번에 두 층을 나눠 채웠다. 호출 횟수 제한(카드 5장, 사례 3건, 분석 15회)은
그대로 둔다.

**요청 하나의 실제 제한**은 네 값 중 가장 짧은 것이다.

    min(요청이 지정한 값, transport 설정값, 60초, 실행 전체의 남은 시간)

큰 값을 넣어 상한을 늘릴 수 없다. `0`·음수·소수·`NaN`·`Infinity`·다른 타입은 `fetch`를
부르기 전에 `configuration_error`로 거절한다(회귀 테스트가 호출 0회를 확인한다). 설정값이
60초를 넘으면 조용히 깎지 않고 생성 시점에 거절한다 — 운영 설정이 잘못된 것은 드러나야
한다. 제한에는 응답 본문을 다 읽는 시간까지 포함하므로, 헤더만 빨리 오고 본문이 끝나지
않는 경우도 같은 마감에 걸린다.

**실행 전체 예산**은 기본·최대 120초이며 호출자와 테스트는 더 짧게만 정할 수 있다. 저작
1회와 모든 분석이 **같은 마감 시각 하나**를 나눠 쓴다. 단계가 바뀐다고 예산이 초기화되지
않는다. 경과 시간은 `performance.now()` 기반 단조 증가 시계로 재므로 시스템 시각이 뒤로
조정돼도 마감이 밀리지 않고, 시계는 주입할 수 있어 테스트가 실제로 120초를 기다리지 않고
예산 소진을 재현한다. 마감은 `runCandidateGenerationEvidence`에 직접 의존 함수를 주입하는
경로에도 똑같이 적용된다.

**취소와 늦은 완료.** 마감이나 호출자 취소가 나면 진행 중인 요청에 취소 신호를 전달하고
다음 호출을 시작하지 않는다. 의존 함수가 취소를 무시하고 영원히 붙잡고 있어도 실행기
자체는 정해진 시간에 실패를 반환한다. 단순 `Promise.race`로 끝내지 않는다 — 경주에서 진
작업은 사라지지 않으므로, 한 번만 열리는 빗장을 두고 늦게 온 성공·실패를 모두 받아
삼킨다. 받지 않으면 처리되지 않은 rejection이 되고, 받아도 확정된 뒤의 값은 어디에도 쓰지
않는다. 그래서 뒤늦게 끝난 작업이 분석을 추가로 부르거나 증거를 성공으로 되살리지 못한다.
타이머와 이벤트 리스너는 실행이 끝날 때 정리한다. 실패 결과는 고정된 reason과, 분석
단계라면 코드가 부여한 caseId만 담는다 — 원본 오류·제공자 응답·API 키·사례 문장·부분
증거는 어느 경로로도 나가지 않는다.

**취소가 보장하지 않는 것.** 취소 신호는 우리 쪽 대기를 끝내고 in-flight 요청에 abort를
전달할 뿐이다. 이미 제공자에 도달한 작업이 서버에서 계속 수행되는 것, 그에 따른 **과금**,
이미 시작된 부수효과를 되돌리지 않는다. 우리가 그 결과를 쓰지 않는다는 것만 보장한다.

순환을 피하려고 순수 모듈 둘을 새로 두었다. 실패 분류(`generation-failure`)는 아무것도
import하지 않는 잎사귀이고, 시간 예산(`generation-deadline`)은 그것만 import한다. 요청
계약과 transport가 둘 다 이 타입을 쓰기 때문에 어느 한쪽에 두면 순환이 생긴다.

회귀 테스트는 짧은 `spec.timeoutMs`가 설정값보다 먼저 적용되는지, 잘못된 시간 설정이 호출
0회로 거절되는지, 저작 대기와 응답 본문 대기 중 전체 마감이 걸리는지, 중간 분석에서 예산을
다 쓰면 다음 분석을 부르지 않는지, 취소를 무시하는 의존 함수에서도 실행기가 반환하는지,
이미 취소된 실행이 호출 0회인지, 늦은 성공·실패가 결과를 바꾸거나 후속 호출을 만들지
않는지, 단계마다 예산이 초기화되지 않는지를 각각 고정한다. 정상 실행·지문 결속·입력
격리·다른 후보 증거 재사용 차단도 함께 확인한다. 요청별 제한과 후속 호출 차단을 각각
무력화해 해당 테스트가 실패하는 것을 확인하고 원본을 복원했다 — 제한을 없앴을 때 한
테스트가 실제로 50초를 쓰고, 후속 호출 차단을 없앴을 때 실행기가 반환하지 않는다.

이번 작업에서 **고치지 않은 것**(후속): Analyzer 요청 설정이 운영 `analyze-situation`과
다른 점, 증거 DB 표·RPC, 활성화 SQL, 새 영역용 동적 manifest. 자동 재시도·부분 결과
재개·사람 사전 승인은 추가하지 않았다.

## 9-20. 취소 즉시 종료·마감 원인 구분·예산 기본값 (2026-09-22, 후속)

9-19를 독립 검수에서 재현해 세 곳을 고쳤다.

**1. 취소해도 transport가 계속 기다렸다.** 취소 신호를 무시하는 제공자를 상대로
`onRunAbort`가 `controller.abort()`만 불렀다. 요청 본문을 만드는 async 작업은 그대로
매달려 있어서 `Promise.race`가 끝나지 않았고, `finally`가 돌지 않아 최대 60초짜리 요청
타이머가 살아 있었다. 재현했을 때 취소 120ms 뒤에도 transport promise는 `pending`이었고
프로세스가 50초를 더 붙들려 있었다. 이제 취소 신호 자체를 race의 한 주자로 넣어 취소
즉시 대기가 끝나고 `finally`가 타이머와 리스너를 정리한다. 같은 재현이 323ms에 끝난다.

이것은 **우리 쪽 대기**를 끝내는 것이다. 이미 제공자에 도달한 작업이 서버에서 계속
수행되는 것과 그 과금을 멈추지는 않는다.

**2. 소수점 절삭과 타이머 경합이 원인을 바꿨다.** 전체 예산 120ms, 마감 시작 0,
transport 시작 0.25ms일 때 남은 119.75ms를 `Math.floor`로 119ms로 깎았다. 요청 타이머가
119.25ms에 먼저 울면 실제 마감(120ms) 전이므로 `provider_timeout`이 되고, 실행기는 이를
`author_failed`로 보고하면서 전체 마감 타이머를 정리해 버렸다. 두 가지를 바꿨다.

- 남은 시간은 **올림**한다. 내림하면 요청 타이머가 실제 마감보다 먼저 울어 조기 종료가 된다.
- 끝난 이유는 **어느 타이머가 먼저 울렸는지가 아니라 단조 시계가 정한다.** transport와
  실행기가 실패를 만들 때마다 `done()`으로 시계를 다시 보고, 시계상 예산이 끝났으면
  `run_deadline_exceeded`로 보고한다.

더 짧은 요청별 제한은 그대로 `provider_timeout` → `author_failed`로 남는다. 전체 마감으로
과잉 귀속하지 않는다.

**3. 잘못된 전체 예산이 기본값으로 바뀌었다.** `options.budgetMs ?? 120_000`은 `null`도
기본값으로 바꾼다. 그래서 `budgetMs: null`이 120초로 조용히 승격되고 저작 함수가 호출됐다.
이제 **생략(`undefined`)만** 기본값이고, `null`을 포함한 잘못된 타입은
`configuration_error`로 외부 호출 0회에서 거절한다. `now`와 `signal`도 같은 규칙을 쓴다.

회귀 테스트는 취소 직후 transport promise 종료와 타이머 정리, 취소 뒤 늦은 성공·실패가
결과를 바꾸지 않고 처리되지 않은 rejection도 남기지 않는 것, 후속 호출 0회, 저작·분석
양쪽에서 요청 타이머가 먼저 울어도 원인이 전체 마감으로 보고되는 것, 그 판정이 전체 마감
타이머를 기다리지 않고 이뤄지는 것(경과 시간으로 고정), 남은 시간이 1ms 미만이어도 실제
마감 전에는 끊지 않는 것, 더 짧은 요청별 제한이 유지되는 것, `budgetMs`/`now`/`signal`의
`null`·잘못된 타입이 호출 0회로 거절되는 것을 각각 고정한다. 모두 주입한 단조 시계와 짧은
예산으로 돌리므로 실제 60초·120초를 기다리지 않는다. 취소 racer, 올림, 원인 구분을 각각
무력화해 해당 테스트가 실패하는 것을 짧은 테스트 상한 아래에서 확인하고 원본을 복원했다.

기존 지문 결속(9-18)과 취소 후 후속 호출 차단(9-19)은 그대로다. Analyzer 요청 설정, 증거
DB 표·RPC, 활성화 SQL은 이번에도 손대지 않았다.

## 9-21. 전체 마감 타이머의 반올림과 재예약 (2026-09-22, 후속)

9-20에서 요청별 타이머는 올림하도록 고쳤지만 **전체 마감 타이머**는 그대로였다.
`remainingMs()`의 소수값을 `setTimeout`에 그대로 넘기고, 콜백은 시계를 다시 보지 않은 채
곧바로 `finish('run_deadline_exceeded')`를 불렀다.

재현: `startedAt = 0`, `budgetMs = 120`, 타이머 예약 시각 0.25 → 남은 시간 119.75.
`setTimeout`이 지연의 소수부를 잘라 119로 만들면 콜백이 119.25에 실행된다. 그때
`remainingMs()`는 아직 0.75인데도 마감과 abort가 확정됐다. 예산이 남은 실행이 끊기고,
진행 중이던 요청도 함께 취소됐다.

세 가지를 고쳤다.

- 전체 마감 타이머도 남은 시간을 **올림**해 예약한다.
- 콜백이 단조 시계를 **다시 본다.** 아직 남아 있으면 마감을 확정하지 않고 남은 시간으로
  **재예약**한다. 마감을 정하는 것은 타이머가 아니라 시계다.
- `finish`와 `dispose`가 **재예약된 타이머까지** 정리한다. 취소가 먼저 오면 사유는
  `run_cancelled`로 남고, 이후 시계가 예산을 넘겨도 그 사유가 덮이지 않는다.

회귀 테스트는 예약 지연이 119.75가 아니라 120으로 올림되는지(`setTimeout`을 테스트에서
감싸 지연값을 직접 확인한다), 조기 콜백에서 마감·abort가 확정되지 않고 남은 시간이
유지되는지, 재예약된 타이머가 실제 마감에서 종료하는지, 재예약 뒤 취소·dispose로
정리되는지, 조기 콜백이 실행 중인 요청의 취소 신호를 올리지 않는지를 각각 고정한다. 모두
주입한 시계와 30ms 안팎의 예산으로 돌린다. 올림 제거와 콜백 재확인 제거를 각각 무력화해
해당 테스트가 실패하는 것을 짧은 테스트 상한 아래에서 확인하고 원본을 복원했다.

재예약 횟수에는 코드가 정한 상한이 없다. 실제 마감을 확인할 때까지 필요한 만큼 다시
예약한다 — 타이머가 일찍 울릴 때마다 시계를 보고, 아직 남았으면 또 예약한다. 시계가
멈춰 있으면 마감도 오지 않으므로 재예약이 계속된다(마감에 이르지 않았으니 맞는 동작이다).
멈추는 것은 `finish`나 `dispose`뿐이므로, 실행기는 어떤 경로로 끝나든 `dispose`를 부르고
테스트도 마찬가지다.

9-18의 지문 결속, 9-19의 예산 공유와 후속 호출 차단, 9-20의 transport 취소 처리·실패
사유·`null` 거절은 그대로다.

## 9-22. 요청 타이머의 조기 종료 (2026-09-22, 후속)

9-21에서 전체 마감 타이머는 고쳤지만 **요청 타이머**는 그대로였다. 콜백이 두 마감을
확인하기 전에 `controller.abort()`부터 불렀다. `stopReason()`은 이미 끊긴 뒤에 *사유만*
고르는 함수라 조기 종료 자체를 막지 못했다. 그래서
"헤더 뒤 본문이 끝나지 않으면 실행 마감으로 취소한다"가 간헐적으로
`provider_timeout`을 냈다.

재현: 전체 예산 30ms, 요청 제한 60초, 헤더는 돌려주지만 본문은 끝나지 않는 fetch.
단조 시각 29.75ms에서 요청 타이머 콜백이 조기 실행되면, 아직 전체 예산이 0.25ms 남았는데도
본문이 취소되고 `provider_timeout`으로 끝났다.

네 가지를 고쳤다.

- 요청 시작 시 **요청별 절대 마감 시각**을 한 번 고정한다(`requestDeadlineAt = 시작 시각 +
  요청 제한`). 재예약해도 이 값은 움직이지 않으므로 요청 예산이 다시 시작하지 않는다.
- 요청 타이머도 전체 마감과 **같은 단조 시계**를 쓴다. `RunDeadline`이 자기 시계를
  `now()`로 내어 주고, 마감이 없는 호출만 자체 단조 시계를 쓴다. 시계가 다르면 둘 중
  어느 쪽이 먼저인지 비교할 수 없다.
- 콜백은 **abort보다 먼저** 두 마감을 확인한다. 전체 마감·취소가 왔으면 그 사유로,
  요청별 절대 마감을 지났으면 `provider_timeout`으로 끊는다. 둘 다 아직이면 abort도
  reject도 하지 않고 남은 시간(두 마감 중 이른 쪽까지, 올림)으로 재예약한다.
- 성공·실패·취소 어느 경로로 끝나도 `finally`가 재예약된 요청 타이머까지 정리한다.

회귀 테스트는 헤더 대기와 본문 대기 양쪽에서 조기 콜백이 요청을 끊지 않고 본문도 취소하지
않는 것, 그 뒤 실제 마감에서 `run_deadline_exceeded`로 끝나는 것, 재예약을 여러 번 거쳐도
요청별 마감이 절대 시각으로 유지되는 것, 전체 마감·호출자 취소·더 짧은 요청별 제한이 각각
제 사유로 구분되는 것, 완료 뒤 남은 타이머가 없는 것을 고정한다. 마지막 항목은 실행 동안
`setTimeout`/`clearTimeout`을 감싸 살아 있는 타이머를 직접 세어 확인한다 — 정리가 새면
테스트가 통과하면서 프로세스만 종료되지 않아, 단순 실행으로는 드러나지 않기 때문이다.

기존 실패 테스트의 기대값(`run_deadline_exceeded`)은 그대로 두었다. 대신 시계가 멈춘 채
끝나기를 기다리던 기존 테스트 두 개는 시계를 실제로 진행시키도록 고쳤다 — 시계가 가지
않으면 마감도 오지 않는 것이 고친 뒤의 올바른 동작이기 때문이다. 두 테스트의 기대값은
`provider_timeout`에서 `run_deadline_exceeded`로 **강화**됐다.

무력화 검사는 상한을 둔 실행기로 돌렸다. 정리가 새거나 요청 예산이 재시작하면 테스트
프로세스 자체가 종료되지 않기 때문에, 테스트 타임아웃만으로는 부족하다.

## 9-23. 생성용 Analyzer 요청 설정의 증거 결속 (2026-09-22, 후속)

동결된 분석은 운영과 **같은 모델·지시문·스키마**로 만들지만 **요청 설정은 다르다.**

| 보내는 값 | 운영 `analyze-situation` | 후보 생성용 분석 |
| --- | --- | --- |
| `model`·`store`·`instructions`·`input`·`text` | 보낸다 | 보낸다 |
| `max_output_tokens` | 보내지 않는다 | `8192` |
| `tools` | 보내지 않는다 | `[]` |
| `stream` | 보내지 않는다 | `false` |
| `background` | 보내지 않는다 | `false` |
| `truncation` | 보내지 않는다 | `'disabled'` |

공용 `environment`는 모델·지시문·스키마·taxonomy·Gate·Matcher 지문만 담으므로 아래 다섯
줄을 잡지 못했다. 그래서 요청 설정을 바꿔도 이전 설정으로 만든 증거가 그대로 통과했다.

**단일 출처.** `automatic-scripture-catalog-generation-analysis-request.ts`가 생성용 요청
본문의 유일한 출처다. transport가 전송할 때와 증거를 검증할 때 같은 함수를 쓴다. 증거
모듈이 transport를 import하면 순환이 되므로 양쪽이 함께 의존하는 순수 계층으로 두었다.
이 파일은 네트워크·DB·파일·환경변수·시계를 읽지 않는다.

**무엇을 묶는가.** 실제 전송 본문에서 사례 문장인 `input`만 뺀 **나머지 전부**를 canonical
hash로 묶어 `evidence.analysisRequest.requestHash`에 담고, 최상위 `artifactHash`에도
포함한다. 모델 id, 지시문, Structured Output 설정, 위 다섯 가지가 모두 들어간다. `input`은
사례마다 달라지고 이미 `cases[].text`와 최상위 지문으로 결속돼 있으므로 설정 지문은 문장과
무관하다 — 같은 설정이면 어떤 문장에서도 같은 값이 나오고, 문장을 바꾸면 최상위 지문이
달라진다.

**검증.** 저장된 값끼리의 일관성만 보지 않는다. 검증할 때마다 지금 요청 생성 함수에서 지문을
다시 계산해 대조한다. 누락·잘못된 타입·계약 밖 필드도 거절한다. 설정 지문과 최상위
`artifactHash`를 함께 다시 계산한 위조 증거도 거절된다.

격리한 복사본에서 `max_output_tokens`를 8192에서 4096으로 바꿔 네 방향을 모두 확인했다 —
원본 설정에서 원본 증거는 통과, 바뀐 설정에서 이전 증거는 거절, 바뀐 설정에서 새로 봉인한
증거는 통과, 그 새 증거를 원본 설정에서 보면 거절. 저장소의 실제 설정 값은 바꾸지 않았다.

**이 지문이 보장하지 않는 것.** 우리가 **명시적으로 보낸 설정**이 지금과 같다는 것만
말한다. 같은 설정이 같은 출력을 낸다는 것(모델은 결정적이지 않다), 우리가 보내지 않은 값에
제공자가 적용하는 숨은 기본값이 그대로라는 것, 그리고 실제로 그 요청을 보냈다는 것은
증명하지 않는다. 마지막 것은 증거를 쓸 수 있는 주체가 지문을 전부 다시 계산할 수 있기
때문이며, 그 경계는 권한이 제한된 append-only 저장과 활성화 시 재검증으로만 좁혀진다.

운영 `analyze-situation`의 payload, 공용 `environment` 계약, 기존 156건 frozen snapshot은
바꾸지 않았다. 증거 DB 표·RPC, 활성화 SQL, 새 영역 manifest는 이번에도 범위가 아니다.

## 9-24. 후보 생성 증거의 append-only DB 보관과 저장 RPC (2026-09-22, 후속)

9-18~9-23이 만든 `CandidateGenerationEvidence`를 이제 DB에 불변으로 적을 수 있다. 표 하나와
저장 RPC 하나를 더했고, 기존 표·함수·활성화 구조는 손대지 않았다.

### 이 보관소가 보장하는 것

1. **불변.** 적힌 증거는 고칠 수도 지울 수도 없다. 기존 append-only 방아쇠를 그대로 재사용해
   `UPDATE`·`DELETE`·`TRUNCATE`를 모두 막는다. DB 소유자 권한으로도 막힌다.
2. **후보 연결.** 증거는 DB에 실제로 있는 후보에만 붙는다(외래 키, `on delete restrict`).
   후보가 없으면 저장되지 않는다.
3. **열과 JSON의 일치.** 표 제약이 JSON 안의 `contractVersion`·`candidateHash`·`artifactHash`가
   열 값과 같을 것을 강제한다. 어긋난 행은 어떤 경로로도 들어올 수 없다.
4. **버전·연구 연결.** 저장 RPC가 증거의 `baseVersionHash`·`proposedVersionHash`·
   `sourceResearchResultHash`를 그 후보의 기록과 대조한다.
5. **멱등성과 충돌 거절.** 같은 `artifactHash`로 동일한 JSONB 값을 다시 보내면 멱등이고(공백·객체
   키 순서 같은 원문 바이트 차이는 jsonb 비교가 구분하지 않는다),
   같은 지문에 다른 후보나 다른 JSON을 붙이면 거절한다.
6. **부분 행 없음.** 실패한 호출은 행을 하나도 남기지 않는다.
7. **권한.** `anon`·`authenticated`는 표도 RPC도 건드릴 수 없다. `service_role`도 표를 직접
   읽거나 쓰지 못하고 허용된 저장 RPC만 실행할 수 있다.

### 이 보관소가 보장하지 **않는** 것

- **"저장됨"은 "실제 모델 호출이 증명됨"이 아니다.** DB는 불변 보관과 후보 연결만 본다.
  증거가 실제 Astra·Analyzer 호출에서 나왔는지는 확인하지 않으며 확인할 수도 없다.
- **TypeScript validator 통과는 전자서명이 아니다.** DB는 `validateCandidateGenerationEvidence`를
  부르지 않고, 통과했다는 사실을 기록하지도 않는다. 증거를 쓸 수 있는 주체는 계약을 만족하는
  내용을 지어낼 수 있다(9-18의 한계가 그대로다).
- **`artifactHash`가 내용에서 실제로 나온 값인지 DB는 모른다.** 아래를 보라.

### 지문 재계산의 한계 (명시)

JavaScript `canonicalJson`이 만드는 바이트열은 PostgreSQL의 `jsonb::text`와 같지 않다. `jsonb`는
키를 (길이, 바이트) 순으로 다시 늘어놓고 중복 키를 버리며 수·유니코드 표기를 정규화한다.
게다가 이 프로젝트는 `pgcrypto`를 쓰지 않아 SQL 안에 SHA-256 자체가 없다(migration 전체를
확인했다 — `digest`·`hmac` 등을 쓰는 곳이 없다).

그래서 **DB는 `artifactHash`를 다시 계산하지 않으며, 계산한 척도 하지 않는다.** `jsonb::text`의
해시를 같은 지문이라고 가장하는 코드는 넣지 않았다. 대신 형식·필드 연결·충돌·멱등성을 엄격히
본다. 내용에서 지문이 실제로 나왔는지는 TypeScript 쪽 `validateCandidateGenerationEvidence`가
보며, **그 사실 자체는 DB에 기록되지 않는다.**

### cardinality: 후보 1 : 증거 N (명시적 검토)

사례 저작 모델은 결정적이지 않다. 같은 후보를 다시 돌리면 다른 문장이 나오고 따라서 다른
`artifactHash`가 나온다. 그 시도들은 모두 남아야 한다 — 하나만 남기려면 고치거나 지워야 하는데
그것이 바로 이 표가 막는 일이다.

그래서 기본 키는 `artifact_hash`이고 `candidate_hash`에는 unique를 걸지 **않는다**. 실제로 같은
후보로 두 번 봉인한 증거 두 건이 모두 저장되는 것을 컨테이너에서 확인했다(2행 / 후보 1개).

이 선택에는 검토 측면의 뜻도 있다. 시도가 전부 남으므로 **"통과할 때까지 다시 돌린" 흔적이
나중에 보인다.** 후보당 하나만 남겼다면 그 신호가 사라진다.

어느 증거가 검증·활성화에 쓰였는지는 이번 단계에서 정하지 않는다. 다음 단계가 정확한
`artifactHash`로 결속할 수 있도록 `(artifact_hash, candidate_hash)` 복합 unique만 미리 뒀다.
기존 validation 표가 attestation을 위해 쓰는 것과 같은 방식이다.

### `SECURITY DEFINER`를 쓴 이유

`service_role`에는 `private` 표에 대한 권한이 하나도 없다. 그것이 이 설계의 핵심이다 — 열쇠를
가진 쪽도 표를 직접 만지지 못하고, 정해진 검사를 지나는 함수로만 적을 수 있다. 그래서 함수
소유자 권한으로 실행해야 한다. `search_path`를 `private, pg_catalog`로 고정하고 모든 객체를
스키마로 한정해 호출자가 만든 동명 객체가 끼어들 수 없게 했다. `PUBLIC`·`anon`·`authenticated`
실행 권한은 명시적으로 회수했다.

### 실제 DB에서 확인한 것

깨끗한 PostgreSQL 17.6 컨테이너에 모든 migration 18개를 순서대로 적용하고, 실제 TypeScript
계약이 봉인한 증거로 확인했다. 정상 저장·멱등 재전송·같은 후보의 두 번째 시도가 통과하고,
없는 후보·잘못된 두 해시 형식·인자와 JSON 불일치 두 가지·같은 지문 다른 payload·
`contractVersion` 위조·후보와 버전 연결 불일치·객체 아님 아홉 가지가 각각 제 사유로 거절되며
행 수가 변하지 않았다. `UPDATE`·`DELETE`·`TRUNCATE`가 소유자 권한으로도 막히고,
`anon`·`authenticated`·`service_role`의 직접 표 접근이 모두 막혔다.

신규 migration을 뺀 컨테이너와 넣은 컨테이너의 스키마를 덤프해 비교했다. **기존 객체에서
사라지거나 바뀐 줄이 하나도 없고**, 추가된 것은 신규 표·색인·방아쇠 둘·제약·외래 키·함수
하나뿐이다. `service_role`이 실행할 수 있는 public RPC는 20개에서 21개가 됐다. 기존
baseline·candidate·validation·activation·rollback·validation_context RPC에 같은 입력을 넣어
두 컨테이너의 결과와 오류 메시지가 완전히 같은 것도 확인했다.

### 아직 아닌 것

**활성화 SQL은 이 증거를 아직 다시 확인하지 않는다.** 저장됐다는 사실만으로 활성화가 열리지
않으며, 자동 활성화는 계속 fail-closed다. 활성화가 정확한 `artifactHash`로 증거를 결속하고
재검증하는 것, 새 영역(`new_domain_with_cards`)용 동적 Analyzer manifest, 운영 배포는 다음
단계다. 사람 사전 승인 단계는 이번에도 넣지 않았다.

## 9-25. 검증 기록·활성화와 후보 생성 증거의 정확한 결속 (2026-09-23, 후속)

9-24의 보관소가 만든 `(artifact_hash, candidate_hash)` 복합 unique를 실제 검증과 활성화에
연결했다. 검증 계약은 v4다. `candidateGenerationEvaluation.payload`는 이제 `cases`뿐 아니라
`evidenceArtifactHash`를 반드시 가지며, 결정적 adapter는 자신이 재생한 증거의 실제
`artifactHash`를 이 자리에 넣는다. 누락·형식 오류·계약 밖 필드는 실행기와 최종 계약 검증에서
모두 거절된다.

검증 표에는 `candidate_generation_evidence_artifact_hash` 열을 추가했다. 이 열과
`candidate_hash`의 복합 외래 키가 후보 생성 증거의 `(artifact_hash, candidate_hash)`를
가리킨다. 저장 RPC는 다음을 모두 확인한 뒤 같은 트랜잭션에서 검증·attestation을 적는다.

1. payload의 필드는 `evidenceArtifactHash`·`cases` 두 개뿐이다.
2. 증거 지문 형식이 맞고, 그 증거가 같은 후보에 실제로 저장돼 있다.
3. 검증 사례의 `(caseId, cardId)` 투영이 저장 증거의 사례와 개수·순서까지 정확히 같다.
4. 재전송이라면 검증 JSON·attestation뿐 아니라 연결한 증거 지문도 같아야 한다.

활성화 RPC도 저장 시 검사를 믿고 넘어가지 않는다. 검증 행의 연결 열, payload의 지문, 실제
증거 행을 다시 읽고 후보 지문과 사례 투영을 다시 대조한다. 그 뒤에만 기존의 카드별 최소 3건,
모든 `passed=true`, 후보 카드 소속 검사를 수행한다. 따라서 존재하는 다른 증거를 가리키거나,
증거의 일부 사례를 빼거나 순서를 바꾸거나 카드 id를 바꾼 검증으로 활성화할 수 없다.

### v3 기록의 처리

기존 v3 행은 삭제·변환하지 않는다. 새 열을 nullable로 추가해 `null`인 채 그대로 보존한다.
표 제약은 v3+null과 v4+실제 연결만 허용하지만, 새 저장 RPC는 v4만 받고 새 활성화 RPC도 v4만
받는다. 그래서 과거 기록은 감사 자료로 남되 새 자동 활성화에는 사용할 수 없다. 억지로 v3 행을
직접 넣은 실제 DB 시나리오에서도 행은 보존되고 활성화만 `check_violation`으로 거절됐다.

### 실제 DB 확인

깨끗한 Supabase PostgreSQL 17.6 컨테이너에 전체 migration을 순서대로 적용했다. 실제 TypeScript
fixture가 만든 후보·검증·9개 attestation을 사용했고, 후보 생성 증거는 새 저장 RPC로 먼저
보관했다. 정상 v4 저장과 활성화가 통과해 검증 행의 증거 지문·활성 포인터·활성화 기록이 모두
같은 후보를 가리켰다. 다음 경로는 모두 부분 기록 없이 거절됐다.

- 저장되지 않은 증거 지문을 가리키는 v4 검증
- 저장 증거와 `(caseId, cardId)` 투영이 다른 v4 검증
- 연결 열이 `null`인 기존 v3 검증의 활성화
- `service_role`의 증거 표 직접 읽기

DB는 여전히 증거가 실제 모델 호출에서 만들어졌는지 증명하지 않는다. 이번 단계가 추가한 보장은
**검증과 활성화가 보관된 바로 그 증거 한 건을 사용한다는 것**이다. 새 영역 동적 manifest,
운영 배포, 사람 사전 승인은 범위에 넣지 않았다.

## 9-26. 새 영역 후보용 동적 Analyzer domain manifest (2026-09-23, 후속)

`new_domain_with_cards` 후보도 기존 영역 후보와 같은 사례 저작·Analyzer 분석·증거 봉인 경로를
쓸 수 있게 했다. 이 단계에서는 후보 생성 경로에서 검증된 후보와 기준 카탈로그로 manifest를
만들었고, 뒤의 9-27에서 같은 builder를 사용자용 운영 런타임에도 연결했다.

manifest는 정적 17개 영역을 기준으로 시작한다. 기준 카탈로그에 이미 들어온 동적 영역과 이번
후보의 새 영역을 결정적인 id 순서로 더한다. 정적 영역의 설명은 카탈로그 사본이 덮어쓰지 못한다.
후보는 먼저 `validateCatalogCandidate`를 통과해야 하므로 잘못된 새 영역·카드·버전 지문으로
manifest를 만들 수 없다.

같은 manifest 한 건을 네 경계가 함께 쓴다.

1. Analyzer 지시문의 domain id·설명 목록
2. Structured Output schema의 `primaryDomain`·`domainChoiceCandidates`·`secondaryDomains` enum
3. 응답 runtime validator의 허용 domain과 fallback 규칙
4. 증거의 분석 요청 지문과 environment의 instructions/schema/domain-manifest 지문

따라서 prompt에만 새 영역을 넣고 validator가 거절하거나, schema만 넓히고 증거 지문이 옛 값을
가리키는 상태가 생기지 않는다. 정적 manifest로 봉인한 새 영역 증거는 요청 지문과 environment
두 곳에서 거절된다. 반대로 동적 manifest로 봉인한 증거는 카드마다 3건, 새 영역 3장이면 9건의
분석을 모두 통과한 뒤 기존 Gate 재생 adapter로 이어진다.

사례 저작기도 새 영역을 받을 수 있게 했다. 모델에는 검증된 `newDomain` 설명과 후보 카드 prose만
보내며, `situationTags`·판정·연구 결과 지문은 계속 보내지 않는다. 합성 문장에 새 domain id를
직접 넣는 것도 기존 금지 규칙에 포함했다.

### 회귀 보장

- `buildAnalyzerInstructions(STATIC_ANALYZER_DOMAIN_MANIFEST) === INSTRUCTIONS`
- 정적 manifest로 만든 schema가 기존 `SITUATION_ANALYSIS_SCHEMA`와 동일
- 운영 Analyzer payload와 기존 156건 고정 스냅샷 환경은 변경 없음
- 새 영역 id·설명이 prompt와 schema에 함께 들어가고, 정적 validator는 거절하지만 동적
  validator는 통과
- 새 영역 요청·환경 지문은 정적 값과 다르며 같은 후보에서는 결정적
- 실제 transport factory에서 사례 저작 1회 + Analyzer 9회가 같은 동적 prompt·schema를 사용
- 불완전한 새 영역 증거도 예외를 던지지 않고 실패 결과로 닫힘

### 당시 남은 운영 경계

9-26 시점에는 manifest가 후보 생성과 증거 검증 전용이었다. 활성 카탈로그 읽기, 장애 시
fail-closed 정책, 포인터 전환·롤백과 사용자용 Analyzer/추천/기도 런타임 연결은 9-27에서
구현했다. 9-26 작업 자체에서는 운영 배포와 실제 OpenAI·Supabase 호출을 하지 않았다.

## 9-27. 활성 카탈로그의 사용자 런타임 연결 (2026-09-23, 후속)

검증·활성화된 카탈로그가 실제 사용자 요청에도 한 판으로 적용되도록 `analyze-situation`,
`recommend-scripture`, `generate-prayer-guidance`와 앱 표시 상태를 연결했다. Git의 정적 카드로
DB·계약·지문 오류를 정적 카드로 조용히 덮는 경로는 서버 런타임에 없다. 구 앱 호환 요청은
아래 capability 협상에 따라 명시적으로 기존 정적 계약을 쓰며, 이때도 활성판 조회가 먼저 성공해야 한다.

### 원자적 읽기와 fail-closed

신규 `get_active_scripture_catalog_runtime()` RPC는 입력이 없는 `STABLE SECURITY DEFINER` SQL
함수다. 활성 포인터와 그 포인터가 가리키는 버전 행을 **한 SELECT의 join**으로 읽으므로, 활성화나
롤백이 동시에 일어나도 포인터와 다른 카탈로그를 섞어 반환하지 않는다. 실행 권한은
`service_role`에만 있고 `PUBLIC`·`anon`·`authenticated`에는 없다.

Edge transport는 한 번만 호출하며 1.5초 상한, 호출자 취소 신호, 응답 구조·카탈로그 계약·전체
카탈로그 지문 재계산을 모두 통과한 값만 반환한다. fetch나 본문 읽기가 abort를 무시해도 시간
제한 또는 기도 전체 마감에서 기다리기를 끝낸다. 읽기·HTTP·JSON·계약·지문 중 하나라도 실패하면
503 계열의 기존 일반 실패 응답으로 닫고, 정적 카드나 이전 카탈로그와 섞지 않는다.

### Analyzer·Gate·기도가 쓰는 같은 판

검증된 활성 카탈로그 한 판에서 다음 세 재료를 함께 만든다.

1. 정적 17개 영역 + 활성 카탈로그의 새 영역 manifest
2. 정적 카드 + 활성 카드가 실제로 쓰는 `situationTags` 합집합
3. 전체 활성 카탈로그를 Gate가 쓰는 카드 모양으로 바꾼 목록

영역과 상황 태그는 같은 manifest에서 Analyzer 지시문, Structured Output schema, 응답 validator,
후보 증거의 요청·환경 지문에 함께 들어간다. `emotionTags`·`spiritualQuestionTags`·`prayerModes`·
`pastoralFunction`의 닫힌 사전은 그대로다. 기준 카탈로그에서는 기존 지시문과 schema가 동일하다.

추천은 Analyzer가 본 `runtime` 객체의 카드로 Gate를 실행한다. 기도는 요청 초기에 활성 카탈로그를
한 번 읽고, 선택 영역·카드 확인, 재분석, Gate 재검증, 기도 생성까지 그 객체를 재사용한다. 따라서
한 요청 안에서 포인터가 바뀌어도 영역은 이전 판인데 카드는 다음 판인 조합이 생기지 않는다.

### 앱으로 내보내는 최소 공개 카드

추천 응답은 실제 선택된 카드와 선택지에 필요한 카드만 아래 공개 projection으로 보낸다.

- 카드 id, 영역 id 하나, 계산된 성경 표기와 본문 위치
- 사용자 설명, 기도 방향
- 선택지에 필요한 영역 id와 검증된 한국어 표시 이름

신학 검증 메모, 문맥 요약, 태그, 오용 방지 규칙, 연구·검증 지문은 내보내지 않는다. 앱도 exact
fields, id 형식, 본문 위치, 계산 표기, 길이, 카드-영역 소속을 다시 검사한다. 검증된 공개 카드는
기기 저장소가 아니라 Situation Context 메모리에만 두고 말씀·기도 화면에서 사용한다. 새 영역
선택지의 한국어 이름도 응답에서 받은 검증값을 쓰므로 내부 영문 id가 화면에 나오지 않는다.

앱은 추천과 기도 도움 요청에 `catalogRuntimeVersion: "scripture-catalog-runtime/v1"`을 보내 동적 카드와 새 영역을
검증·표시할 수 있음을 명시한다. 새 Edge는 이 값이 정확한 요청에만 활성 manifest·카드와 공개
`cards`/`domains` 응답을 사용한다. 표시가 없는 구 앱 요청은 먼저 활성판을 정상 조회한 뒤 기존 정적
Analyzer·Gate·카드 자료를 사용하고, 추천은 옛 `{ ok, result }` 응답 모양을 유지한다. 기도 도움도
추천과 같은 공통 capability parser와 runtime 선택 함수를 써서, 구 앱이 받은 정적 카드를 동적 Gate로
다시 판정해 조용히 기도 방향 fallback으로 떨어뜨리지 않는다. 따라서 새 카드·영역을 활성화해도 구 앱의
추천·기도 도움 기능이 전면 실패하거나 저하되지 않는다. DB 조회가 실패하면 구 앱도 503으로 닫히므로 이 경로가 장애
fallback으로 쓰이지 않는다. 알 수 없는 capability 값은 오타를 구 앱으로 숨기지 않고 입력 오류로
거절한다. 기도 도움은 기존 외부 실패 계약대로 구체 사유를 감춘 단일 503으로 닫는다.

반대 방향의 순차 배포를 위해 새 앱 parser는 `cards`와 `domains`가 **둘 다 없는** 옛 Edge의 정적
응답만 기존 로컬 카드 검사로 받을 수 있다. 둘 중 하나만 있거나 동적 카드가 공개 계약을 어기면 전부
거절한다. 옛 Edge는 추가 capability 필드를 무시하고 기존 추천을 반환하므로 앱과 Edge의 배포 순서가
어느 쪽이 먼저여도 기능이 유지된다.

### 회귀 검증 범위

- 새 영역과 새 상황 태그가 prompt·schema·validator·환경 지문에 함께 들어감
- Analyzer와 Gate가 같은 활성 판으로 새 카드를 선택함
- runtime 읽기 실패 시 quota·모델 호출 0회, 정적 fallback 없음
- capability가 있는 새 앱은 동적 판을, 표시가 없는 구 앱은 활성판 조회 성공 뒤 정적 계약을 사용함
- 구 앱 요청의 DB 실패는 503이며, 알 수 없는 capability는 호출 0회 입력 오류로 닫힘
- 동적 활성판에서도 구 앱의 정적 카드가 기도 재분석·정적 Gate·기도 생성까지 이어짐
- 동적 domain-choice가 한국어 이름과 공개 카드를 보존하고 뒤로가기 선택지도 유지함
- 로컬 목록에 없는 카드가 로컬 개역한글 본문·공개 설명·기도 방향으로 표시됨
- 그 카드 id와 새 영역이 기도 서버 요청에 전달되고 서버가 같은 활성 판으로 재검증함
- 내부 필드, 잘못된 성경 표기, 카드-영역 불일치 응답은 앱에서 거절됨
- service-role transport가 timeout·호출자 취소에서 abort 무시 요청도 기다리지 않음

### 운영 적용 상태와 순서

이 변경은 **아직 운영 Supabase에 적용하거나 Edge Function을 배포하지 않았다.** 배포할 때는 먼저
runtime RPC migration을 적용하고 활성 포인터·버전 행이 정상인지 확인한 뒤, 세 Edge Function을
같은 릴리스로 배포해야 한다. RPC 없이 함수만 먼저 배포하거나 활성 포인터가 비어 있으면 의도대로
503으로 닫힌다. 그 다음 앱을 배포하면 옛 정적 응답과 새 공개 카드 응답을 모두 안전하게 넘길 수
있다. 새 앱이 아직 설치되지 않은 사용자가 남아 있어도 capability가 없는 요청은 정적 계약으로
처리되므로, 새 카드·영역 활성화를 앱 보급률에 묶지 않는다. 실제 운영 전에는 로컬 PostgreSQL에서
service_role 권한·기준판·활성화·롤백을 포함한 RPC 시나리오를 다시 확인해야 한다.

## 9-28. 운영 기준판 등록 도구와 배포 전제 (2026-09-23, 후속)

운영 DB가 비어 있는 상태에서 runtime RPC와 세 Edge Function만 배포하면 활성 포인터가 없어 모든
사용자 요청이 503으로 닫힌다. 이를 수동 JSON 복사나 SQL 편집으로 해결하지 않도록
`scripts/register-scripture-catalog-baseline.ts`를 추가했다.

도구는 Git의 정적 카드 51장, 정적 영역 설명, 앱의 한국어 표시 이름 17개로 기준 카탈로그를 다시
만들고 지문을 계산한다. 인자 없이 실행하거나 `--dry-run`을 주면 이 계획만 출력하며 환경변수와
네트워크를 전혀 읽지 않는다. `--execute`에서만 `SUPABASE_URL`과 서버 전용 키를 읽는다.

실행 경계는 다음과 같다.

- 먼저 읽기 전용 runtime RPC를 호출한다. 활성판이 비어 있을 때만 기준판 등록 RPC를 호출한다.
- 이미 같은 기준판이 있으면 쓰기 없이 성공한다.
- 다른 활성판, 잘못된 runtime 응답, HTTP 오류는 덮어쓰거나 상세 원문을 노출하지 않고 실패한다.
- 등록 직후 runtime RPC를 다시 읽어 revision 1, 기준 지문, 전체 카탈로그가 모두 같아야 성공한다.
- request id는 작업 종류와 기준 지문에서 결정적으로 만들어 재실행 시 바뀌지 않는다.
- 기준판은 지문을 만들기 전에 전체 카탈로그 계약을 통과하고, 같은 값으로 만든 runtime 응답도 실제
  Edge parser를 통과해야 한다. 공백·영문 표시 이름, 빈 태그·기도 방향, 잘못된 성경 표기는 등록 전에 막힌다.
- 동시 실행에서 다른 프로세스가 먼저 같은 기준판을 등록해 RPC가 충돌하면 runtime을 한 번 재조회한다.
  같은 기준판이면 `already_registered`로 수렴하고, 다른 활성판이면 충돌로 닫는다.

Supabase 호스팅 Edge Function에는 `SUPABASE_SERVICE_ROLE_KEY`가 기본 환경변수로 제공되지만, 현재
코드는 legacy key 이름을 사용한다. 새 secret/publishable key 체계로 옮기는 것은 별도 변경이다.
배포 직전에는 원격 migration 이력, 활성 포인터, 기준판 지문을 읽기로 확인한 뒤 세 Edge Function을
같은 릴리스로 배포한다. 요청마다 기준 카탈로그 전체(현재 JSON 약 82.5KB)를 읽는 구조는 기능상
정확하지만 운영 비용·지연 관찰 대상이며, 캐시는 포인터 전환 즉시성·fail-closed 정책을 함께 설계한
후 별도 단계에서 다룬다.

## 9-29. 정보 부족과 실제 범위 밖의 분리, 고정 분석 스냅샷 v2 (2026-09-28, 후속)

짧고 넓은 입력을 실제 범위 밖으로 곧바로 종료하던 문제를 고쳤다. Analyzer의
`domainPriority`에 `needs_detail`을 추가하고, 이 상태는 `primaryDomain: null`, 빈
`domainChoiceCandidates`, 빈 `secondaryDomains`일 때만 유효하게 했다. 안전 신호는 이 분기보다
먼저 처리된다. Gate는 `needs_detail`을 카드 추천으로 추측하지 않고
`no_coverage + PRIMARY_DOMAIN_UNDETERMINED`로 내보낸다. 앱은 이 정확한 조합만 기존 최대 3회
추가 질문 흐름으로 연결한다. 구체적이지만 카탈로그 범위 밖인 입력은 기존 정적 종료 화면에 남고,
알 수 없는 실패 사유도 추가 질문으로 추정하지 않는다. 기도 도움 재분석에서 `needs_detail`이 나오면
선택 영역을 억지로 끼워 넣지 않고 생성 전에 닫는다.

이 계약 변경은 Analyzer 지시문·schema와 Recommendation Gate 버전을 바꾸므로 v1 고정 분석은
자체 계약과 지문은 여전히 유효하지만 현재 환경과는 맞지 않는다. 차이는
`analyzerInstructionsHash`, `analyzerSchemaHash`, `recommendationGate` 세 필드로 명시적으로
검출된다. v1 파일은 과거 기록으로 보존하고, 156건을 새 환경에서 다시 분석한
`automatic-scripture-catalog-analysis-snapshot-v2.ts`를 추가해 버전 진입점만 v2로 전환했다.

재생성 중 EVAL-068(`신뢰했던 사람이 뒤통수를 쳐서 배신감이 커요.`)이 오래된 평가 기대값과 충돌해
멈췄다. 이 문장은 명시적인 부당 처분·강압·금전 손해보다 신뢰 관계에서 받은 배신과 상처를 말하므로
기대 영역을 `relationship_conflict_forgiveness`, preferred/acceptable을 `SC-017`로 교정했다.
이미 저장된 앞 67건은 새 156건 계획에 하나씩 다시 검증한 뒤에만 새 plan fingerprint로 원자
재결속했고, EVAL-068부터 재개해 156건을 완료했다.

v2 산출물은 구조 계약과 현재 환경 대조를 모두 통과한다.

- source corpus artifact hash:
  `sart_b55819db9bed4906b685c7c3c79ad905630fdbda5782809b0b10c3002547dbb6`
- frozen analysis artifact hash:
  `sart_e2ab62942209f46f600e645f15bb6dafae0755bb3826cca7f6b2d5d138ee4880`
- snapshot fingerprint:
  `sart_9b05fb6cfdbaf014c48e52b655d3ccade5b7fc6097c9666081f7589c5bc38591`

현재 기준 catalog 재생 결과는 domain match 153/153, acceptable match 146/153, safety false
positive 0/153이다. V1·V2 모두 raw response·reasoning·token usage·사용자/세션 식별자를 저장하지
않으며, 로컬 checkpoint와 JSON snapshot은 `.gitignore`에서 별도 디렉터리로 제외한다. 생성 과정은
OpenAI 분석 호출만 수행했고 Supabase·DB·배포·push는 수행하지 않았다.

최종 검증은 관련 핵심 테스트 476/476, `npm run test:logic` 4630/4630,
`npm run test:ui` 137/137(9 suites), `npx --no-install tsc --noEmit` 오류 0,
`git diff --check` 통과, package 파일 무변경, 고위험 비밀값 패턴 0건이다. 로컬 JSON과 Git 고정
V2 상수도 canonical JSON으로 동일함을 다시 확인했다.

## 9-30. 내부 테스트 표현 민감도 교정과 고정 분석 스냅샷 v3 (2026-09-29, 후속)

내부 테스트에서 뜻은 분명하지만 짧거나 메모체인 두 입력이 기대 경로로 가지 않는 문제가 확인됐다.
`감기가 오래가서 힘들다.`는 실제 범위 밖 종료로, `동생과 말다툼 후 서로 연락안함. 먼저 사과할지
고민중`은 추가 질문으로 흘렀다. 원인은 문장의 의미보다 길이·문체 차이가 `needs_detail` 판단에
영향을 주는 것이었다. Analyzer 지시문에 두 원문과 기대 영역을 명시하고, 메모체·축약형·구어체·
종결어미 생략·띄어쓰기 차이는 정보 부족의 근거가 아니라는 규칙을 추가했다. 340문장 코퍼스의
해당 두 자리를 실제 제보 문장으로 교체하고 EVAL-141·EVAL-153이 각각 `chronic_illness`/SC-029,
`relationship_conflict_forgiveness`/SC-031을 기대하도록 고정했다.

156건 재생성 과정에서는 이전에도 출력이 흔들렸던 세 경계가 반복해서 드러났다. 부모가 다른 사람과
비교하는 EVAL-059는 `comparison_identity`, 뒤에서 험담을 당한 EVAL-065는
`injustice_mistreatment`, 명시적 손해 없이 신뢰 관계에서 배신당한 EVAL-068은
`relationship_conflict_forgiveness`로 구분하는 정확한 예시와 금지 영역을 지시문에 추가했다.
세 문장과 실제 제보 두 문장을 함께 사전 실행해 모두 `resolved`와 기대 영역으로 통과한 뒤, 빈 새
체크포인트에서 156건을 다시 실행했다. 중간 실패 체크포인트는 새 지시문과 섞지 않았고, 완료된 JSON만
`automatic-scripture-catalog-analysis-snapshot-v3.ts`로 고정했다. 버전 진입점은 v3를 선택하며 v1·v2
파일은 감사 기록으로 그대로 남긴다. v2는 자체 구조 계약은 계속 통과하지만 현재 환경 대조에서는
`analyzerInstructionsHash` 차이로 명시적으로 거절된다.

v3 산출물 지문은 다음과 같다.

- source corpus artifact hash:
  `sart_fb9ddd4e5a6557ea74a4c5296a92f127c5cf7b9cb4def9eb09a5e59582eafdbf`
- frozen analysis artifact hash:
  `sart_40496a12b3cb98e4f3625997657f8993feb67f3a63babdb8e400c3856b978812`
- snapshot fingerprint:
  `sart_f96c435340877bb8006ccfcd9caa6f2add149ab8c42ce108447b9f214c57fecf`

현재 기준 catalog 재생 결과는 domain match 153/153, acceptable match 142/153, safety false
positive 0/153이다. 실제 제보 두 건은 모두 기대 카드까지 추천한다. acceptable 불일치 11건은
EVAL-018·032·042·044·068·073·074·084·123·134·148이며, 숨기거나 사람이 산출물을 고치지 않고
생성 결과 그대로 고정했다. v2의 146/153보다 낮은 값이므로 이 스냅샷을 Analyzer 정확도 인증으로
해석하지 않는다. 후보 변경 전후에 같은 분석을 재생해 추가 회귀를 찾는 결정적 기준이라는 기존
경계를 유지하며, 해당 11건의 평가 기대값 또는 태그 안정화는 별도 의미 검수 대상으로 남긴다.

v3도 raw response·reasoning·token usage·사용자/세션 식별자를 저장하지 않는다. 로컬 checkpoint와
JSON snapshot은 정확한 전용 디렉터리만 `.gitignore`로 제외하며, 생성 과정에서는 OpenAI 분석 호출만
수행했다. Supabase·DB·배포·push는 수행하지 않았다.

최종 검증은 고정 분석 adapter 24/24, 자동 Scripture Catalog 전체 850/850,
`npm run test:logic` 4639/4639, `npm run test:ui` 137/137(9 suites),
`npx --no-install tsc --noEmit` 오류 0, `git diff --check` 통과, package 파일 무변경,
고위험 비밀값 패턴 0건이다. 로컬 JSON과 Git 고정 v3 상수도 canonical JSON으로 동일하다.
EVAL-059 지시문 블록을 임시 제거한 mutation에서는 정적 프롬프트 검사와 현재 환경 결속 검사가
실패했고, 같은 실행에서 원본을 바이트 단위로 복원한 뒤 전체 검증을 다시 통과했다.
