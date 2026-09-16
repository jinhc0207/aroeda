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
| `scripture_catalog_validator_profile` | 검토된 validator 허용 목록, append-only | 종류별 판정 가능 항목·독립 그룹 고정. 이 migration에서는 비어 있음 |
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
| `contextTheologyReview` | 등록된 model evaluator profile 중 서로 다른 독립 그룹 최소 2개, 후보 카드마다 모두 pass | profile 권한·독립 그룹·모델 목록·attestation 연결 재확인 |
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
6. **validator profile 등록부는 의도적으로 비어 있다.** 검토된 profile을 별도 migration으로 등록하기 전에는 모든 자동 검증·활성화가 닫힌다.
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
- validator profile 등록은 검토된 migration이 아직 없어 시험용 fixture profile을 DB 소유자로 넣어 대신했다.

## 10. 아직 연결되지 않은 런타임 범위

- `analyze-situation`, `recommend-scripture`, `generate-prayer-guidance`와 앱은 여전히 정적 `scripture-cards.ts`·`situation-domains.ts`를 읽는다.
- 7개 RPC를 부르는 Edge Function·스크립트가 없다. 기준 카탈로그·validator profile도 등록되지 않았다.
- 후보를 자동으로 만드는 생성기, 독립 평가·안전·회귀·생성 평가를 실제로 돌리는 실행기가 없다.
- 공지 outbox를 읽어 보내는 발송기와 발송 결과 기록이 없다.
- 활성 카탈로그를 읽는 read RPC와 캐시·폴백 정책이 없다.
- migration은 검증용 임시 컨테이너에만 적용했고(§9-1), 운영 Supabase 프로젝트에는 적용하지 않았다.

## 11. 테스트

- `automatic-scripture-catalog-contract.test.ts` — 기준 카탈로그(현재 17개 영역·51장 그대로), 지문 결정성, 정렬, 금지 설정·개인정보, 두 후보 종류와 거절 규칙.
- `automatic-scripture-catalog-activation-contract.test.ts` — 검증 기록 무효/막음 구분, 실제 개역한글 원문 지문 재계산, 중복 재계산,
  기준 등록·후보·검증 보관, 활성화 원자성·멱등성·fail-closed, 롤백 규칙, authority 분리, 공지 내용.
  여기에 "겹침에 가려지지 않는 단일 규칙" 묶음이 있다. 규칙 하나만 어긋나게 만들고 그 규칙의 오류 문구를 직접 확인한다.
- `automatic-scripture-catalog-migration.test.ts` — SQL 사본 대조, 표·함수 권한, append-only·포인터 트리거, 활성화·롤백 순서와 재확인 조항,
  validator profile 자가 등록 금지, 수요 기록의 날짜 위조 금지, 사람 검토 migration 무변경(SHA-256 고정), 개인정보·외부 발송 부재.
  커밋 시점 포인터 전환 확인이 SECURITY DEFINER인지(§9-1에서 실제 DB가 잡아 낸 결함), search_path 고정,
  모든 역할 실행 권한 회수, `deferrable initially deferred` 유지, 다른 private 함수까지 definer로 넓히지 않는지도 함께 고정한다.
- `automatic-scripture-catalog-defect-regression.test.ts` — 특정 새 영역과 무관한 `other_uncovered` 수요, 임의 산출물 지문,
  자기 주장 평가자 독립성, 표시 이름 누락, 잘못된 성경 표기, 연구 결과 없는 후보가 다시 허용되지 않도록 고정.

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
