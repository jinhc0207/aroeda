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

## 10. 아직 연결되지 않은 런타임 범위

- `analyze-situation`, `recommend-scripture`, `generate-prayer-guidance`와 앱은 여전히 정적 `scripture-cards.ts`·`situation-domains.ts`를 읽는다.
- 기존 7개 쓰기 RPC와 검증 context 읽기 RPC를 실제로 조율하는 Edge Function·스크립트가 없다.
  기준 카탈로그·validator profile도 등록되지 않았다.
- 후보를 자동으로 만드는 생성기와 실행기의 DB 오케스트레이션·Edge Function 연결부가 없다.
  Sol·Astra 신학 평가 fetch transport(§9-7)는 구현됐지만, 아직 실행기를 감싸는 운영 진입점에 연결되지 않았다.
- **결정적 검사(deterministic) adapter 셋이 아직 없다.** `safetyBoundary`(경계 사례), `corpusRegression`
  (153개 코퍼스), `candidateGenerationEvaluation`(카드별 생성 사례)을 실제로 돌릴 독립 검증된 고정 분석
  스냅샷이 저장소에 없다. 세 adapter는 지금 실행기에 함수로 주입받는 자리만 있고, 그 안을 채울 판단
  근거(무엇을 안전 경계로 볼지, 153개 코퍼스의 정답, 카드별 생성 사례의 채점 기준)가 아직 정해지지
  않았다. **이 공백을 임의 구현으로 메우지 않는다** — 빈 결과나 지어낸 사례로 이 검사들을 통과시키면,
  fail-closed 전제 전체가 무의미해진다(무엇을 검사했는지 아무도 보증하지 못하는 채로 "통과"만 남는다).
  독립 검증된 고정 분석 스냅샷이 마련된 뒤에 별도 작업으로 구현해야 한다.
  §9-9에서 `safety_boundary`·`corpus_regression` 두 종류의 스냅샷 **계약(순수 타입과 검증 함수)**은
  만들었지만, 실제 스냅샷 데이터·adapter 구현·executor 연결·`validateAutomaticValidationRecord`
  강화는 아직 없다 — 계약이 있다는 사실이 activation-ready를 뜻하지 않는다.
  `candidateGenerationEvaluation`은 이 계약에도 아직 없다(§9-9의 "candidate_generation은 왜
  없는가" 참고 — 후보 생성 모델과 사례 저작 모델의 독립성 결속이 오늘 아예 없다).
- 공지 outbox를 읽어 보내는 발송기와 발송 결과 기록이 없다.
- validator용 활성 카탈로그·수요 읽기 RPC(§9-8)는 생겼다. 앱 런타임이 활성 카탈로그를 읽는 별도 경로와
  캐시·폴백 정책은 아직 없다.
- migration은 검증용 임시 컨테이너에만 적용했고(§9-1, §9-6), 운영 Supabase 프로젝트에는 적용하지 않았다.

## 11. 테스트

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
- `automatic-scripture-catalog-analysis-snapshot-contract.test.ts` (§9-9·§9-10, 60건) — safety_boundary·
  corpus_regression 사례를 담은 스냅샷의 exact-fields·caseId 오름차순·candidate_generation 거절·동결
  분석의 실제 `validateSituationAnalysis` 재검사를 고정한다. `analysis`와 `analysis.safety`에도
  exact-fields를 적용해 `rawResponse`·`userId`·`analysis.safety.sessionId` 같은 여분의 필드가
  모든 해시를 올바르게 재계산해도 거절되는지 고정한다. `sourceCorpusArtifactHash`·
  `frozenAnalysisArtifactHash`가 cases에서 직접 재계산한 값과 대조된다는 것(형식만 맞는 임의의 해시로
  top-level fingerprint만 다시 맞춰도 거절됨을 "[재현]" 테스트로 먼저 고정), 두 종류가 각각 최소 1개
  있어야 한다는 것, frozen analysis와 expected의 교차 일관성(urgent 분석+normal expectedSafety,
  recommend route인데 다른 domain, domain_choice 후보 순서 등)을 각각 단일 오류로 고정한다. 사례
  text·분석 태그·expected·environment의 모델·스키마·태그 사전·domain manifest·Gate·Matcher·기준
  카탈로그 결속·두 하위 해시·저장된 fingerprint 중 무엇 하나만 바뀌어도 정확히 그 하나의 오류만
  나는지(다른 검사가 우연히 가려 잡지 않는지) 대조한다.
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
