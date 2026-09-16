-- 아뢰다 · 자동 Scripture Catalog 기반 (v1)
--
-- 무엇을 위한 것인가
--   카드와 영역을 사람의 사전 승인 없이, 철저한 자동 검증을 통과한 경우에만
--   버전이 붙은 서버 카탈로그로 활성화할 수 있게 하는 저장소와 전환 함수다.
--
--     기준 카탈로그 → 자동 후보(연구 결과·수요 연결 필수) → 자동 검증 기록 + 항목별 attestation
--       → 활성 버전 포인터 전환 ↘ 롤백(이전 활성 조상 버전으로만)
--   전환과 롤백은 매번 소유자 공지 기록을 같은 트랜잭션에 남긴다.
--
-- 스스로 적은 pass를 믿지 않는다
--   활성화는 검증 기록의 status만 보지 않는다.
--     * 수요: 집계 표(weak_match / normalized_theme)에서 기간별 횟수를 다시 만들어 evidence와 대조한다.
--     * 본문 위치·중복: 저장된 기준 카탈로그와 후보에서 다시 만들어 payload와 대조한다.
--     * 안전·회귀·생성 평가·신학 평가: payload 안의 사례를 다시 세어 통과 조건을 확인한다.
--     * SQL이 다시 계산할 수 없는 것(개역한글 원문 지문, payload 지문 자체, 외부 평가 판단)은
--       항목마다 등록된 validator profile의 불변 attestation이 payload 지문에 묶여 있어야 한다.
--       validator profile은 이 migration이 넣지 않는다. 검토된 다음 migration으로만 들어간다.
--       그래서 profile이 등록되기 전까지는 어떤 후보도 활성화될 수 없다.
--
-- 사람 검토 경계와의 관계
--   게시 콘텐츠의 사람 검토 표·함수(published_content*)를 읽지도 쓰지도 않는다.
--   연구 보관소 private.research_result는 외래 키로 "있는지"만 확인한다.
--
-- 권한
--   모든 표는 RLS를 켜고 public·anon·authenticated·service_role 모두에게서 권한을 거둔다.
--   쓰기는 아래 일곱 SECURITY DEFINER 함수로만 한다. 각 함수는 search_path를 고정하고,
--   입력을 검사하고, PUBLIC·anon·authenticated 실행 권한을 거두고 service_role에만 연다.
--
-- 저장하지 않는 것
--   사용자 원문, 사용자 번호, 세션·기기 식별자, 접속 주소, 인증 토큰, 모델 원본 응답.
--   수요 집계는 날짜·영역 id 또는 주제 지문·횟수뿐이다.
--
-- 이 경계가 보장하지 못하는 것
--   attestation은 지문과 등록 profile에 묶이지만 암호 서명이 아니다. service_role 열쇠를 가진 쪽은
--   profile 이름으로 attestation을 적을 수 있다. 실제 발행 주체 인증에는 서명 열쇠가 따로 필요하다.
--   postgres 주인 권한이 있으면 이 경계는 아래에서 열린다.
--
-- 이 migration은 아직 어디에도 적용하지 않았다. 로컬에 Postgres가 없어 실행해 보지 못했다.
-- 적용 전에 실제 DB에서 문법과 동작을 따로 확인해야 한다.

create schema if not exists private;

------------------------------------------------------------------
-- 고쳐 쓰지 못하게 막는 방아쇠
------------------------------------------------------------------

create function private.reject_scripture_catalog_mutation()
returns trigger
language plpgsql
set search_path = pg_catalog
as $$
begin
  raise exception '자동 카탈로그 기록은 새로 적기만 합니다. 고치거나 지울 수 없습니다.'
    using errcode = 'restrict_violation';
end;
$$;

revoke all on function private.reject_scripture_catalog_mutation() from public;
revoke all on function private.reject_scripture_catalog_mutation() from anon, authenticated, service_role;

------------------------------------------------------------------
-- 1. 카탈로그 버전 (한 판 전체)
------------------------------------------------------------------

create table private.scripture_catalog_version (
  version_hash text primary key,
  -- 기준 카탈로그만 부모가 없다.
  parent_version_hash text
    references private.scripture_catalog_version (version_hash)
    on delete restrict,
  catalog jsonb not null,
  created_at timestamptz not null default now(),

  constraint scripture_catalog_version_hash_format
    check (version_hash ~ '^scat_[0-9a-f]{64}$'),
  constraint scripture_catalog_version_parent_not_self
    check (parent_version_hash is null or parent_version_hash <> version_hash),
  constraint scripture_catalog_version_is_object
    check (jsonb_typeof(catalog) = 'object'),
  constraint scripture_catalog_version_contract
    check (
      jsonb_exists(catalog, 'contractVersion')
      and catalog ->> 'contractVersion' = 'scripture-catalog/v1'
      and jsonb_typeof(catalog -> 'domains') = 'array'
      and jsonb_typeof(catalog -> 'cards') = 'array'
    )
);

comment on table private.scripture_catalog_version is
  '카탈로그 한 판. 지문이 이름이다. 새로 적기만 한다. 활성 여부는 포인터가 정한다.';

create trigger scripture_catalog_version_reject_mutation
before update or delete on private.scripture_catalog_version
for each statement execute function private.reject_scripture_catalog_mutation();
create trigger scripture_catalog_version_reject_truncate
before truncate on private.scripture_catalog_version
for each statement execute function private.reject_scripture_catalog_mutation();

alter table private.scripture_catalog_version enable row level security;
revoke all on table private.scripture_catalog_version from public;
revoke all on table private.scripture_catalog_version from anon, authenticated, service_role;

------------------------------------------------------------------
-- 2. validator profile allowlist (검토된 migration으로만 들어간다)
------------------------------------------------------------------

-- 이 표에 줄을 넣는 함수는 없다. 이 migration도 줄을 넣지 않는다.
-- 독립성은 이 표의 independence_group으로만 판단한다. 기록 안의 이름 문자열은 증거가 아니다.
create table private.scripture_catalog_validator_profile (
  profile_hash text primary key,
  profile jsonb not null,
  validator_kind text not null,
  authorized_checks text[] not null,
  independence_group text not null,
  created_at timestamptz not null default now(),

  constraint scripture_catalog_validator_profile_hash_format
    check (profile_hash ~ '^svp_[0-9a-f]{64}$'),
  constraint scripture_catalog_validator_profile_kind_allowed
    check (validator_kind in ('aggregate_counter', 'deterministic', 'model_evaluator')),
  constraint scripture_catalog_validator_profile_group_format
    check (independence_group ~ '^[a-z][a-z0-9_-]{2,48}$'),
  -- 한 종류가 모든 항목을 판정하지 못하게 종류별로 판정할 수 있는 항목을 나눈다.
  constraint scripture_catalog_validator_profile_checks_by_kind
    check (
      cardinality(authorized_checks) > 0
      and (
        (validator_kind = 'aggregate_counter'
          and authorized_checks <@ array['demandSignal']::text[])
        or (validator_kind = 'model_evaluator'
          and authorized_checks <@ array['contextTheologyReview']::text[])
        or (validator_kind = 'deterministic'
          and authorized_checks <@ array[
            'passageExistence',
            'krvTextMatch',
            'safetyBoundary',
            'duplicateCheck',
            'corpusRegression',
            'candidateGenerationEvaluation'
          ]::text[])
      )
    ),
  constraint scripture_catalog_validator_profile_matches_columns
    check (
      jsonb_typeof(profile) = 'object'
      and profile ->> 'contractVersion' = 'scripture-catalog-validator-profile/v1'
      and profile ->> 'validatorKind' = validator_kind
      and profile ->> 'independenceGroup' = independence_group
    )
);

comment on table private.scripture_catalog_validator_profile is
  '자동 검증 attestation을 낼 수 있는 validator profile 목록. 넣는 함수가 없다. 비어 있으면 어떤 후보도 활성화되지 않는다.';

create trigger scripture_catalog_validator_profile_reject_mutation
before update or delete on private.scripture_catalog_validator_profile
for each statement execute function private.reject_scripture_catalog_mutation();
create trigger scripture_catalog_validator_profile_reject_truncate
before truncate on private.scripture_catalog_validator_profile
for each statement execute function private.reject_scripture_catalog_mutation();

alter table private.scripture_catalog_validator_profile enable row level security;
revoke all on table private.scripture_catalog_validator_profile from public;
revoke all on table private.scripture_catalog_validator_profile from anon, authenticated, service_role;

------------------------------------------------------------------
-- 3. 수요 집계 (weak_match · normalized_theme)
------------------------------------------------------------------

-- 날짜(서울 기준)·대상·횟수만 센다. 사용자 문장, 사용자 번호, 기기 정보는 들어갈 칸이 없다.
-- 칸은 기록 함수가 1씩만 늘린다. 지우거나 줄일 수 없다.
create table private.scripture_demand_weak_match_daily (
  bucket_date date not null,
  domain_id text not null,
  match_count bigint not null,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  primary key (bucket_date, domain_id),

  constraint scripture_demand_weak_match_daily_domain_format
    check (domain_id ~ '^[a-z][a-z0-9_]{2,47}$'),
  constraint scripture_demand_weak_match_daily_count_positive
    check (match_count > 0)
);

comment on table private.scripture_demand_weak_match_daily is
  '기존 영역에서 약하게만 맞은 추천의 날짜·영역별 횟수. 기존 영역 후보의 수요 근거다.';

create table private.scripture_demand_theme_daily (
  bucket_date date not null,
  theme_fingerprint text not null,
  theme_count bigint not null,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  primary key (bucket_date, theme_fingerprint),

  constraint scripture_demand_theme_daily_fingerprint_format
    check (theme_fingerprint ~ '^sthm_[0-9a-f]{64}$'),
  constraint scripture_demand_theme_daily_count_positive
    check (theme_count > 0)
);

comment on table private.scripture_demand_theme_daily is
  '분류 밖 요청을 비식별 정규화 주제 지문으로 센 날짜별 횟수. 새 영역 후보의 수요 근거다. other_uncovered 전체 합계와 다르다.';

create function private.guard_scripture_demand_counter_update()
returns trigger
language plpgsql
set search_path = pg_catalog
as $$
begin
  if new.bucket_date is distinct from old.bucket_date then
    raise exception '수요 집계는 1씩만 늘어납니다.'
      using errcode = 'restrict_violation';
  end if;
  if tg_table_name = 'scripture_demand_weak_match_daily' then
    if new.domain_id is distinct from old.domain_id or new.match_count <> old.match_count + 1 then
      raise exception '수요 집계는 1씩만 늘어납니다.'
        using errcode = 'restrict_violation';
    end if;
  elsif new.theme_fingerprint is distinct from old.theme_fingerprint or new.theme_count <> old.theme_count + 1 then
    raise exception '수요 집계는 1씩만 늘어납니다.'
      using errcode = 'restrict_violation';
  end if;
  return new;
end;
$$;

revoke all on function private.guard_scripture_demand_counter_update() from public;
revoke all on function private.guard_scripture_demand_counter_update() from anon, authenticated, service_role;

create trigger scripture_demand_weak_match_daily_guard_update
before update on private.scripture_demand_weak_match_daily
for each row execute function private.guard_scripture_demand_counter_update();
create trigger scripture_demand_weak_match_daily_reject_delete
before delete on private.scripture_demand_weak_match_daily
for each statement execute function private.reject_scripture_catalog_mutation();
create trigger scripture_demand_weak_match_daily_reject_truncate
before truncate on private.scripture_demand_weak_match_daily
for each statement execute function private.reject_scripture_catalog_mutation();

create trigger scripture_demand_theme_daily_guard_update
before update on private.scripture_demand_theme_daily
for each row execute function private.guard_scripture_demand_counter_update();
create trigger scripture_demand_theme_daily_reject_delete
before delete on private.scripture_demand_theme_daily
for each statement execute function private.reject_scripture_catalog_mutation();
create trigger scripture_demand_theme_daily_reject_truncate
before truncate on private.scripture_demand_theme_daily
for each statement execute function private.reject_scripture_catalog_mutation();

alter table private.scripture_demand_weak_match_daily enable row level security;
revoke all on table private.scripture_demand_weak_match_daily from public;
revoke all on table private.scripture_demand_weak_match_daily from anon, authenticated, service_role;

alter table private.scripture_demand_theme_daily enable row level security;
revoke all on table private.scripture_demand_theme_daily from public;
revoke all on table private.scripture_demand_theme_daily from anon, authenticated, service_role;

------------------------------------------------------------------
-- 4. 자동 후보 (생성 기록)
------------------------------------------------------------------

create table private.scripture_catalog_candidate (
  candidate_hash text primary key,
  candidate_kind text not null,
  target_domain_id text not null,
  base_version_hash text not null
    references private.scripture_catalog_version (version_hash)
    on delete restrict,
  proposed_version_hash text not null
    references private.scripture_catalog_version (version_hash)
    on delete restrict,
  -- 연구 보관소에 실제로 있는 연구 결과여야 한다. 없으면 적히지 않는다.
  source_research_result_hash text not null
    references private.research_result (result_hash)
    on delete restrict,
  demand_binding_kind text not null,
  demand_subject_key text not null,
  candidate jsonb not null,
  created_at timestamptz not null default now(),

  constraint scripture_catalog_candidate_hash_format
    check (candidate_hash ~ '^sccand_[0-9a-f]{64}$'),
  constraint scripture_catalog_candidate_kind_allowed
    check (candidate_kind in ('existing_domain_card', 'new_domain_with_cards')),
  constraint scripture_catalog_candidate_target_format
    check (target_domain_id ~ '^[a-z][a-z0-9_]{2,47}$'),
  constraint scripture_catalog_candidate_research_format
    check (source_research_result_hash ~ '^rres_[0-9a-f]{64}$'),
  constraint scripture_catalog_candidate_binding_kind_allowed
    check (demand_binding_kind in ('weak_match', 'normalized_theme')),
  -- 기존 영역은 그 영역 id의 weak_match에, 새 영역은 주제 지문의 normalized_theme에만 묶인다.
  constraint scripture_catalog_candidate_binding_matches_kind
    check (
      (candidate_kind = 'existing_domain_card'
        and demand_binding_kind = 'weak_match'
        and demand_subject_key = target_domain_id)
      or (candidate_kind = 'new_domain_with_cards'
        and demand_binding_kind = 'normalized_theme'
        and demand_subject_key ~ '^sthm_[0-9a-f]{64}$')
    ),
  constraint scripture_catalog_candidate_versions_differ
    check (base_version_hash <> proposed_version_hash),
  constraint scripture_catalog_candidate_is_object
    check (jsonb_typeof(candidate) = 'object'),
  constraint scripture_catalog_candidate_matches_columns
    check (
      candidate ->> 'contractVersion' = 'scripture-catalog-candidate/v1'
      and candidate ->> 'candidateKind' = candidate_kind
      and candidate ->> 'targetDomainId' = target_domain_id
      and candidate ->> 'baseVersionHash' = base_version_hash
      and candidate ->> 'proposedVersionHash' = proposed_version_hash
      and candidate ->> 'sourceResearchResultHash' = source_research_result_hash
      and candidate #>> '{demandBinding,kind}' = demand_binding_kind
      and (
        case
          when demand_binding_kind = 'weak_match' then candidate #>> '{demandBinding,domainId}'
          else candidate #>> '{demandBinding,themeFingerprint}'
        end
      ) = demand_subject_key
    )
);

comment on table private.scripture_catalog_candidate is
  '자동으로 만든 후보 한 건. 연구 결과와 수요 연결이 반드시 있다. 새로 적기만 한다.';

create trigger scripture_catalog_candidate_reject_mutation
before update or delete on private.scripture_catalog_candidate
for each statement execute function private.reject_scripture_catalog_mutation();
create trigger scripture_catalog_candidate_reject_truncate
before truncate on private.scripture_catalog_candidate
for each statement execute function private.reject_scripture_catalog_mutation();

alter table private.scripture_catalog_candidate enable row level security;
revoke all on table private.scripture_catalog_candidate from public;
revoke all on table private.scripture_catalog_candidate from anon, authenticated, service_role;

------------------------------------------------------------------
-- 5. 자동 검증 기록 (evidence)
------------------------------------------------------------------

create table private.scripture_catalog_validation (
  validation_hash text primary key,
  candidate_hash text not null
    references private.scripture_catalog_candidate (candidate_hash)
    on delete restrict,
  validation jsonb not null,
  created_at timestamptz not null default now(),

  constraint scripture_catalog_validation_hash_format
    check (validation_hash ~ '^scval_[0-9a-f]{64}$'),
  constraint scripture_catalog_validation_is_object
    check (jsonb_typeof(validation) = 'object'),
  -- 사람 검토 authority로 적힌 자동 기록이 남을 수 없다.
  constraint scripture_catalog_validation_automated_authority
    check (
      jsonb_exists(validation, 'validationAuthority')
      and validation ->> 'validationAuthority' = 'automated_validation'
    ),
  constraint scripture_catalog_validation_matches_candidate
    check (
      jsonb_exists(validation, 'contractVersion')
      and validation ->> 'contractVersion' = 'automatic-scripture-catalog-validation/v2'
      and jsonb_exists(validation, 'candidateHash')
      and validation ->> 'candidateHash' = candidate_hash
    ),
  constraint scripture_catalog_validation_hash_candidate_unique
    unique (validation_hash, candidate_hash)
);

comment on table private.scripture_catalog_validation is
  '자동 검증 기록 한 건. 실패한 검증도 증거로 남긴다. 새로 적기만 한다.';

create trigger scripture_catalog_validation_reject_mutation
before update or delete on private.scripture_catalog_validation
for each statement execute function private.reject_scripture_catalog_mutation();
create trigger scripture_catalog_validation_reject_truncate
before truncate on private.scripture_catalog_validation
for each statement execute function private.reject_scripture_catalog_mutation();

alter table private.scripture_catalog_validation enable row level security;
revoke all on table private.scripture_catalog_validation from public;
revoke all on table private.scripture_catalog_validation from anon, authenticated, service_role;

------------------------------------------------------------------
-- 6. 항목별 attestation (등록 validator의 불변 판정)
------------------------------------------------------------------

create table private.scripture_catalog_validation_attestation (
  attestation_hash text primary key,
  validation_hash text not null,
  candidate_hash text not null,
  check_name text not null,
  profile_hash text not null
    references private.scripture_catalog_validator_profile (profile_hash)
    on delete restrict,
  payload_hash text not null,
  verdict text not null,
  attestation jsonb not null,
  created_at timestamptz not null default now(),

  constraint scripture_catalog_validation_attestation_belongs
    foreign key (validation_hash, candidate_hash)
    references private.scripture_catalog_validation (validation_hash, candidate_hash)
    on delete restrict,
  constraint scripture_catalog_validation_attestation_hash_format
    check (attestation_hash ~ '^satt_[0-9a-f]{64}$'),
  constraint scripture_catalog_validation_attestation_payload_format
    check (payload_hash ~ '^sart_[0-9a-f]{64}$'),
  constraint scripture_catalog_validation_attestation_check_allowed
    check (check_name in (
      'demandSignal',
      'passageExistence',
      'krvTextMatch',
      'contextTheologyReview',
      'safetyBoundary',
      'duplicateCheck',
      'corpusRegression',
      'candidateGenerationEvaluation'
    )),
  constraint scripture_catalog_validation_attestation_verdict_allowed
    check (verdict in ('pass', 'fail')),
  constraint scripture_catalog_validation_attestation_one_per_profile
    unique (validation_hash, check_name, profile_hash),
  constraint scripture_catalog_validation_attestation_matches_columns
    check (
      jsonb_typeof(attestation) = 'object'
      and attestation ->> 'contractVersion' = 'scripture-catalog-attestation/v1'
      and attestation ->> 'candidateHash' = candidate_hash
      and attestation ->> 'checkName' = check_name
      and attestation ->> 'payloadHash' = payload_hash
      and attestation ->> 'profileHash' = profile_hash
      and attestation ->> 'verdict' = verdict
    )
);

comment on table private.scripture_catalog_validation_attestation is
  '검증 항목 하나에 대한 등록 validator의 판정. payload 지문과 profile 지문에 묶인다. 새로 적기만 한다.';

-- 권한 없는 profile의 판정, 다른 payload에 대한 판정, 기록된 결과와 다른 판정을 적지 못하게 한다.
create function private.check_scripture_catalog_attestation_link()
returns trigger
language plpgsql
set search_path = private, pg_catalog
as $$
declare
  v_check jsonb;
begin
  if not exists (
    select 1 from private.scripture_catalog_validator_profile
     where profile_hash = new.profile_hash
       and authorized_checks @> array[new.check_name]
  ) then
    raise exception '이 항목을 판정할 수 없는 validator profile입니다.'
      using errcode = 'check_violation';
  end if;

  select validation #> array['checks', new.check_name] into v_check
    from private.scripture_catalog_validation
   where validation_hash = new.validation_hash;

  if v_check is null
     or v_check ->> 'artifactHash' is distinct from new.payload_hash
     or v_check ->> 'status' is distinct from new.verdict then
    raise exception 'attestation이 검증 기록의 payload·결과와 이어지지 않습니다.'
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

revoke all on function private.check_scripture_catalog_attestation_link() from public;
revoke all on function private.check_scripture_catalog_attestation_link() from anon, authenticated, service_role;

create trigger scripture_catalog_validation_attestation_link
before insert on private.scripture_catalog_validation_attestation
for each row execute function private.check_scripture_catalog_attestation_link();
create trigger scripture_catalog_validation_attestation_reject_mutation
before update or delete on private.scripture_catalog_validation_attestation
for each statement execute function private.reject_scripture_catalog_mutation();
create trigger scripture_catalog_validation_attestation_reject_truncate
before truncate on private.scripture_catalog_validation_attestation
for each statement execute function private.reject_scripture_catalog_mutation();

alter table private.scripture_catalog_validation_attestation enable row level security;
revoke all on table private.scripture_catalog_validation_attestation from public;
revoke all on table private.scripture_catalog_validation_attestation from anon, authenticated, service_role;

------------------------------------------------------------------
-- 7. 기준 카탈로그 등록 기록 (한 번뿐)
------------------------------------------------------------------

create table private.scripture_catalog_baseline (
  baseline_id uuid primary key default gen_random_uuid(),
  singleton boolean not null default true unique,
  request_id text not null unique,
  version_hash text not null
    references private.scripture_catalog_version (version_hash)
    on delete restrict,
  pointer_revision bigint not null unique,
  authority text not null,
  created_at timestamptz not null default now(),

  constraint scripture_catalog_baseline_singleton check (singleton),
  constraint scripture_catalog_baseline_request_format check (request_id ~ '^screq_[0-9a-f]{32}$'),
  constraint scripture_catalog_baseline_first_revision check (pointer_revision = 1),
  constraint scripture_catalog_baseline_authority check (authority = 'automated_operations')
);

create trigger scripture_catalog_baseline_reject_mutation
before update or delete on private.scripture_catalog_baseline
for each statement execute function private.reject_scripture_catalog_mutation();
create trigger scripture_catalog_baseline_reject_truncate
before truncate on private.scripture_catalog_baseline
for each statement execute function private.reject_scripture_catalog_mutation();

alter table private.scripture_catalog_baseline enable row level security;
revoke all on table private.scripture_catalog_baseline from public;
revoke all on table private.scripture_catalog_baseline from anon, authenticated, service_role;

------------------------------------------------------------------
-- 8. 활성화 기록
------------------------------------------------------------------

create table private.scripture_catalog_activation (
  activation_id uuid primary key default gen_random_uuid(),
  request_id text not null unique,
  -- 같은 후보와 같은 결과 버전은 두 번 활성화되지 않는다.
  candidate_hash text not null unique
    references private.scripture_catalog_candidate (candidate_hash)
    on delete restrict,
  validation_hash text not null,
  from_version_hash text not null
    references private.scripture_catalog_version (version_hash)
    on delete restrict,
  to_version_hash text not null unique
    references private.scripture_catalog_version (version_hash)
    on delete restrict,
  pointer_revision bigint not null unique,
  authority text not null,
  created_at timestamptz not null default now(),

  -- 검증 기록은 반드시 이 후보의 것이어야 한다.
  constraint scripture_catalog_activation_validation_belongs
    foreign key (validation_hash, candidate_hash)
    references private.scripture_catalog_validation (validation_hash, candidate_hash)
    on delete restrict,
  constraint scripture_catalog_activation_request_format check (request_id ~ '^screq_[0-9a-f]{32}$'),
  constraint scripture_catalog_activation_versions_differ check (from_version_hash <> to_version_hash),
  constraint scripture_catalog_activation_revision_positive check (pointer_revision > 1),
  constraint scripture_catalog_activation_authority check (authority = 'automated_validation')
);

create trigger scripture_catalog_activation_reject_mutation
before update or delete on private.scripture_catalog_activation
for each statement execute function private.reject_scripture_catalog_mutation();
create trigger scripture_catalog_activation_reject_truncate
before truncate on private.scripture_catalog_activation
for each statement execute function private.reject_scripture_catalog_mutation();

alter table private.scripture_catalog_activation enable row level security;
revoke all on table private.scripture_catalog_activation from public;
revoke all on table private.scripture_catalog_activation from anon, authenticated, service_role;

------------------------------------------------------------------
-- 9. 롤백 기록
------------------------------------------------------------------

create table private.scripture_catalog_rollback (
  rollback_id uuid primary key default gen_random_uuid(),
  request_id text not null unique,
  from_version_hash text not null
    references private.scripture_catalog_version (version_hash)
    on delete restrict,
  to_version_hash text not null
    references private.scripture_catalog_version (version_hash)
    on delete restrict,
  reason_code text not null,
  pointer_revision bigint not null unique,
  authority text not null,
  created_at timestamptz not null default now(),

  constraint scripture_catalog_rollback_request_format check (request_id ~ '^screq_[0-9a-f]{32}$'),
  constraint scripture_catalog_rollback_versions_differ check (from_version_hash <> to_version_hash),
  constraint scripture_catalog_rollback_reason_allowed
    check (reason_code in (
      'regression_detected',
      'safety_concern',
      'validation_evidence_invalidated',
      'owner_requested',
      'operational_incident'
    )),
  constraint scripture_catalog_rollback_revision_positive check (pointer_revision > 1),
  constraint scripture_catalog_rollback_authority check (authority = 'automated_operations')
);

create trigger scripture_catalog_rollback_reject_mutation
before update or delete on private.scripture_catalog_rollback
for each statement execute function private.reject_scripture_catalog_mutation();
create trigger scripture_catalog_rollback_reject_truncate
before truncate on private.scripture_catalog_rollback
for each statement execute function private.reject_scripture_catalog_mutation();

alter table private.scripture_catalog_rollback enable row level security;
revoke all on table private.scripture_catalog_rollback from public;
revoke all on table private.scripture_catalog_rollback from anon, authenticated, service_role;

------------------------------------------------------------------
-- 10. 소유자 공지 보낼 목록 (outbox)
------------------------------------------------------------------

-- 보내지 않는다. 보낼 일을 적어 두기만 한다. 받는 사람 주소를 담지 않는다.
-- 보낸 결과는 이 표를 고치지 않고 나중에 별도 기록으로 남긴다.
create table private.scripture_catalog_owner_notification (
  notification_id uuid primary key default gen_random_uuid(),
  pointer_revision bigint not null unique,
  notification_kind text not null,
  notice jsonb not null,
  created_at timestamptz not null default now(),

  constraint scripture_catalog_owner_notification_kind_allowed
    check (notification_kind in ('baseline_registered', 'catalog_activated', 'catalog_rolled_back')),
  constraint scripture_catalog_owner_notification_is_object
    check (jsonb_typeof(notice) = 'object'),
  constraint scripture_catalog_owner_notification_matches_columns
    check (
      jsonb_exists(notice, 'kind')
      and notice ->> 'kind' = notification_kind
      and jsonb_exists(notice, 'pointerRevision')
      and notice ->> 'pointerRevision' = pointer_revision::text
    )
);

create trigger scripture_catalog_owner_notification_reject_mutation
before update or delete on private.scripture_catalog_owner_notification
for each statement execute function private.reject_scripture_catalog_mutation();
create trigger scripture_catalog_owner_notification_reject_truncate
before truncate on private.scripture_catalog_owner_notification
for each statement execute function private.reject_scripture_catalog_mutation();

alter table private.scripture_catalog_owner_notification enable row level security;
revoke all on table private.scripture_catalog_owner_notification from public;
revoke all on table private.scripture_catalog_owner_notification from anon, authenticated, service_role;

------------------------------------------------------------------
-- 11. 활성 버전 포인터 (한 줄)
------------------------------------------------------------------

create table private.scripture_catalog_active_pointer (
  singleton boolean primary key default true,
  active_version_hash text not null
    references private.scripture_catalog_version (version_hash)
    on delete restrict,
  pointer_revision bigint not null,
  updated_at timestamptz not null default now(),

  constraint scripture_catalog_active_pointer_singleton check (singleton),
  constraint scripture_catalog_active_pointer_revision_positive check (pointer_revision > 0)
);

comment on table private.scripture_catalog_active_pointer is
  '지금 활성인 카탈로그 버전 하나. 기준 등록·활성화·롤백 함수만 바꾼다. 지우지 못한다.';

create function private.guard_scripture_catalog_pointer_update()
returns trigger
language plpgsql
set search_path = pg_catalog
as $$
begin
  if new.singleton is distinct from old.singleton
     or new.pointer_revision <> old.pointer_revision + 1
     or new.active_version_hash = old.active_version_hash then
    raise exception '활성 포인터는 한 단계씩, 다른 버전으로만 바뀝니다.'
      using errcode = 'restrict_violation';
  end if;
  return new;
end;
$$;

revoke all on function private.guard_scripture_catalog_pointer_update() from public;
revoke all on function private.guard_scripture_catalog_pointer_update() from anon, authenticated, service_role;

create trigger scripture_catalog_active_pointer_guard_update
before update on private.scripture_catalog_active_pointer
for each row execute function private.guard_scripture_catalog_pointer_update();
create trigger scripture_catalog_active_pointer_reject_delete
before delete on private.scripture_catalog_active_pointer
for each statement execute function private.reject_scripture_catalog_mutation();
create trigger scripture_catalog_active_pointer_reject_truncate
before truncate on private.scripture_catalog_active_pointer
for each statement execute function private.reject_scripture_catalog_mutation();

-- 트랜잭션이 끝나는 순간 확인한다.
-- 포인터가 바뀐 그 단계(pointer_revision)에 대한 등록·활성화·롤백 기록과 공지 기록이
-- 둘 다 같은 트랜잭션 안에 있어야 한다. 하나라도 없으면 전체가 없던 일이 된다.
-- 이 트리거는 deferrable initially deferred라서 RPC가 끝난 뒤 커밋 시점에 실행된다.
-- 그때는 SECURITY DEFINER 함수 밖이라 호출자(service_role) 권한으로 돌아가는데,
-- service_role에는 private 스키마 권한이 없어 확인 자체가 막힌다.
-- 그래서 이 확인 함수도 security definer로 고정한다. 권한은 넓히지 않는다.
create function private.check_scripture_catalog_pointer_transition()
returns trigger
language plpgsql
security definer
set search_path = private, pg_catalog
as $$
begin
  if not exists (
    select 1 from private.scripture_catalog_owner_notification
     where pointer_revision = new.pointer_revision
       and notice ->> 'toVersionHash' = new.active_version_hash
  ) then
    raise exception '포인터 전환에 소유자 공지 기록이 없습니다.'
      using errcode = 'restrict_violation';
  end if;

  if not (
    exists (
      select 1 from private.scripture_catalog_baseline
       where pointer_revision = new.pointer_revision and version_hash = new.active_version_hash
    )
    or exists (
      select 1 from private.scripture_catalog_activation
       where pointer_revision = new.pointer_revision and to_version_hash = new.active_version_hash
    )
    or exists (
      select 1 from private.scripture_catalog_rollback
       where pointer_revision = new.pointer_revision and to_version_hash = new.active_version_hash
    )
  ) then
    raise exception '포인터 전환에 등록·활성화·롤백 기록이 없습니다.'
      using errcode = 'restrict_violation';
  end if;

  return null;
end;
$$;

revoke all on function private.check_scripture_catalog_pointer_transition() from public;
revoke all on function private.check_scripture_catalog_pointer_transition() from anon, authenticated, service_role;

create constraint trigger scripture_catalog_active_pointer_transition
after insert or update on private.scripture_catalog_active_pointer
deferrable initially deferred
for each row execute function private.check_scripture_catalog_pointer_transition();

alter table private.scripture_catalog_active_pointer enable row level security;
revoke all on table private.scripture_catalog_active_pointer from public;
revoke all on table private.scripture_catalog_active_pointer from anon, authenticated, service_role;

------------------------------------------------------------------
-- 함수 1. 기준 카탈로그 등록 (한 번뿐)
------------------------------------------------------------------

create function public.register_scripture_catalog_baseline(
  p_request_id text,
  p_version_hash text,
  p_catalog jsonb
)
returns uuid
language plpgsql
security definer
set search_path = private, pg_catalog
as $$
declare
  v_existing private.scripture_catalog_baseline%rowtype;
  v_existing_catalog jsonb;
  v_baseline_id uuid;
begin
  if p_request_id is null or p_request_id !~ '^screq_[0-9a-f]{32}$'
     or p_version_hash is null or p_version_hash !~ '^scat_[0-9a-f]{64}$'
     or p_catalog is null or jsonb_typeof(p_catalog) <> 'object'
     or p_catalog ->> 'contractVersion' is distinct from 'scripture-catalog/v1' then
    raise exception '기준 카탈로그 요청이 올바르지 않습니다.'
      using errcode = 'invalid_parameter_value';
  end if;

  select * into v_existing from private.scripture_catalog_baseline where singleton;
  if found then
    select catalog into v_existing_catalog
      from private.scripture_catalog_version where version_hash = v_existing.version_hash;
    if v_existing.request_id = p_request_id
       and v_existing.version_hash = p_version_hash
       and v_existing_catalog = p_catalog then
      return v_existing.baseline_id;
    end if;
    raise exception '기준 카탈로그는 이미 등록됐습니다.'
      using errcode = 'unique_violation';
  end if;

  if exists (select 1 from private.scripture_catalog_active_pointer) then
    raise exception '활성 카탈로그가 이미 있습니다.'
      using errcode = 'unique_violation';
  end if;

  insert into private.scripture_catalog_version (version_hash, parent_version_hash, catalog)
  values (p_version_hash, null, p_catalog);

  insert into private.scripture_catalog_baseline (request_id, version_hash, pointer_revision, authority)
  values (p_request_id, p_version_hash, 1, 'automated_operations')
  returning baseline_id into v_baseline_id;

  insert into private.scripture_catalog_owner_notification (pointer_revision, notification_kind, notice)
  values (
    1,
    'baseline_registered',
    jsonb_build_object(
      'kind', 'baseline_registered',
      'pointerRevision', 1,
      'fromVersionHash', null,
      'toVersionHash', p_version_hash,
      'candidateHash', null,
      'reasonCode', null
    )
  );

  insert into private.scripture_catalog_active_pointer (singleton, active_version_hash, pointer_revision)
  values (true, p_version_hash, 1);

  return v_baseline_id;
end;
$$;

comment on function public.register_scripture_catalog_baseline(text, text, jsonb) is
  '서버 카탈로그의 첫 판을 한 번만 등록한다. 같은 요청의 재실행은 같은 번호를 돌려준다.';

revoke all on function public.register_scripture_catalog_baseline(text, text, jsonb) from public;
revoke all on function public.register_scripture_catalog_baseline(text, text, jsonb)
  from anon, authenticated, service_role;
grant execute on function public.register_scripture_catalog_baseline(text, text, jsonb) to service_role;

------------------------------------------------------------------
-- 함수 2·3. 수요 관찰 기록 (weak_match · normalized_theme)
------------------------------------------------------------------

-- 받는 값은 영역 id 하나다. 현재 활성 카탈로그에 있는 영역만 센다.
create function public.record_scripture_demand_weak_match(
  p_domain_id text
)
returns void
language plpgsql
security definer
set search_path = private, pg_catalog
as $$
declare
  v_active_catalog jsonb;
begin
  if p_domain_id is null or p_domain_id !~ '^[a-z][a-z0-9_]{2,47}$' then
    raise exception '수요 관찰 요청이 올바르지 않습니다.'
      using errcode = 'invalid_parameter_value';
  end if;

  select v.catalog into v_active_catalog
    from private.scripture_catalog_active_pointer p
    join private.scripture_catalog_version v on v.version_hash = p.active_version_hash
   where p.singleton;
  if v_active_catalog is null then
    raise exception '활성 카탈로그가 없습니다.'
      using errcode = 'no_data_found';
  end if;
  if not exists (
    select 1 from jsonb_array_elements(v_active_catalog -> 'domains') as d(item)
     where item ->> 'id' = p_domain_id
  ) then
    raise exception '수요 관찰 요청이 올바르지 않습니다.'
      using errcode = 'invalid_parameter_value';
  end if;

  insert into private.scripture_demand_weak_match_daily (bucket_date, domain_id, match_count)
  values ((now() at time zone 'Asia/Seoul')::date, p_domain_id, 1)
  on conflict (bucket_date, domain_id)
  do update set match_count = scripture_demand_weak_match_daily.match_count + 1,
                last_seen_at = now();
end;
$$;

comment on function public.record_scripture_demand_weak_match(text) is
  '기존 영역의 약한 추천 한 번을 서울 날짜 기준으로 센다. 영역 id 말고는 받지 않는다.';

revoke all on function public.record_scripture_demand_weak_match(text) from public;
revoke all on function public.record_scripture_demand_weak_match(text)
  from anon, authenticated, service_role;
grant execute on function public.record_scripture_demand_weak_match(text) to service_role;

-- 받는 값은 주제 지문 하나다. 주제 이름이나 사용자 문장은 받지 않는다.
create function public.record_scripture_demand_theme(
  p_theme_fingerprint text
)
returns void
language plpgsql
security definer
set search_path = private, pg_catalog
as $$
begin
  if p_theme_fingerprint is null or p_theme_fingerprint !~ '^sthm_[0-9a-f]{64}$' then
    raise exception '수요 관찰 요청이 올바르지 않습니다.'
      using errcode = 'invalid_parameter_value';
  end if;

  insert into private.scripture_demand_theme_daily (bucket_date, theme_fingerprint, theme_count)
  values ((now() at time zone 'Asia/Seoul')::date, p_theme_fingerprint, 1)
  on conflict (bucket_date, theme_fingerprint)
  do update set theme_count = scripture_demand_theme_daily.theme_count + 1,
                last_seen_at = now();
end;
$$;

comment on function public.record_scripture_demand_theme(text) is
  '분류 밖 요청 한 번을 정규화 주제 지문과 서울 날짜 기준으로 센다. 지문 말고는 받지 않는다.';

revoke all on function public.record_scripture_demand_theme(text) from public;
revoke all on function public.record_scripture_demand_theme(text)
  from anon, authenticated, service_role;
grant execute on function public.record_scripture_demand_theme(text) to service_role;

------------------------------------------------------------------
-- 함수 4. 자동 후보와 결과 카탈로그 적기
------------------------------------------------------------------

create function public.store_scripture_catalog_candidate(
  p_candidate_hash text,
  p_candidate jsonb,
  p_proposed_catalog jsonb
)
returns text
language plpgsql
security definer
set search_path = private, pg_catalog
as $$
declare
  v_candidate_kinds constant text[] := array[
    'existing_domain_card',
    'new_domain_with_cards'
  ];
  v_kind text;
  v_target text;
  v_base_hash text;
  v_proposed_hash text;
  v_research_hash text;
  v_binding_kind text;
  v_subject_key text;
  v_base_catalog jsonb;
  v_expected_domains jsonb;
  v_expected_cards jsonb;
  v_existing_candidate jsonb;
  v_existing_parent text;
  v_existing_catalog jsonb;
begin
  if p_candidate_hash is null or p_candidate_hash !~ '^sccand_[0-9a-f]{64}$'
     or p_candidate is null or jsonb_typeof(p_candidate) <> 'object'
     or p_proposed_catalog is null or jsonb_typeof(p_proposed_catalog) <> 'object'
     or p_candidate ->> 'contractVersion' is distinct from 'scripture-catalog-candidate/v1'
     or p_proposed_catalog ->> 'contractVersion' is distinct from 'scripture-catalog/v1'
     or jsonb_typeof(p_candidate -> 'cards') is distinct from 'array'
     or jsonb_array_length(p_candidate -> 'cards') = 0
     or jsonb_typeof(p_candidate -> 'demandBinding') is distinct from 'object' then
    raise exception '후보 요청이 올바르지 않습니다.'
      using errcode = 'invalid_parameter_value';
  end if;

  v_kind := p_candidate ->> 'candidateKind';
  v_target := p_candidate ->> 'targetDomainId';
  v_base_hash := p_candidate ->> 'baseVersionHash';
  v_proposed_hash := p_candidate ->> 'proposedVersionHash';
  v_research_hash := p_candidate ->> 'sourceResearchResultHash';
  v_binding_kind := p_candidate #>> '{demandBinding,kind}';
  v_subject_key := case
    when v_binding_kind = 'weak_match' then p_candidate #>> '{demandBinding,domainId}'
    else p_candidate #>> '{demandBinding,themeFingerprint}'
  end;

  if v_kind is null or not (v_kind = any (v_candidate_kinds))
     or v_target is null or v_target !~ '^[a-z][a-z0-9_]{2,47}$'
     or v_base_hash is null or v_base_hash !~ '^scat_[0-9a-f]{64}$'
     or v_proposed_hash is null or v_proposed_hash !~ '^scat_[0-9a-f]{64}$'
     or v_base_hash = v_proposed_hash
     or v_research_hash is null or v_research_hash !~ '^rres_[0-9a-f]{64}$'
     or v_subject_key is null then
    raise exception '후보 요청이 올바르지 않습니다.'
      using errcode = 'invalid_parameter_value';
  end if;

  if v_kind = 'existing_domain_card'
     and (jsonb_typeof(p_candidate -> 'newDomain') is distinct from 'null'
          or v_binding_kind is distinct from 'weak_match'
          or v_subject_key is distinct from v_target) then
    raise exception '후보 요청이 올바르지 않습니다.'
      using errcode = 'invalid_parameter_value';
  end if;
  if v_kind = 'new_domain_with_cards'
     and (jsonb_typeof(p_candidate -> 'newDomain') is distinct from 'object'
          or v_binding_kind is distinct from 'normalized_theme'
          or v_subject_key !~ '^sthm_[0-9a-f]{64}$') then
    raise exception '후보 요청이 올바르지 않습니다.'
      using errcode = 'invalid_parameter_value';
  end if;

  -- 연구 결과가 실제로 없으면 적지 않는다. 외래 키가 한 번 더 막는다.
  if not exists (select 1 from private.research_result where result_hash = v_research_hash) then
    raise exception '연구 보관소에 없는 연구 결과입니다.'
      using errcode = 'foreign_key_violation';
  end if;

  select catalog into v_base_catalog
    from private.scripture_catalog_version where version_hash = v_base_hash;
  if v_base_catalog is null then
    raise exception '기준 카탈로그 버전이 없습니다.'
      using errcode = 'no_data_found';
  end if;

  -- 결과 카탈로그가 정확히 "기준 + 후보"인지 구조로 다시 만든다. 지문은 다시 계산하지 않는다.
  select coalesce(jsonb_agg(item order by item ->> 'id' collate "C"), '[]'::jsonb)
    into v_expected_domains
    from (
      select jsonb_array_elements(v_base_catalog -> 'domains') as item
      union all
      select p_candidate -> 'newDomain' where v_kind = 'new_domain_with_cards'
    ) as merged;

  select coalesce(jsonb_agg(item order by item ->> 'id' collate "C"), '[]'::jsonb)
    into v_expected_cards
    from (
      select jsonb_array_elements(v_base_catalog -> 'cards') as item
      union all
      select jsonb_array_elements(p_candidate -> 'cards')
    ) as merged;

  if p_proposed_catalog <> jsonb_build_object(
       'contractVersion', 'scripture-catalog/v1',
       'domains', v_expected_domains,
       'cards', v_expected_cards
     ) then
    raise exception '결과 카탈로그가 기준 카탈로그와 후보를 합친 것과 다릅니다.'
      using errcode = 'check_violation';
  end if;

  select parent_version_hash, catalog into v_existing_parent, v_existing_catalog
    from private.scripture_catalog_version where version_hash = v_proposed_hash;
  if found then
    if v_existing_parent is distinct from v_base_hash or v_existing_catalog <> p_proposed_catalog then
      raise exception '같은 버전 지문으로 다른 카탈로그가 있습니다.'
        using errcode = 'unique_violation';
    end if;
  else
    insert into private.scripture_catalog_version (version_hash, parent_version_hash, catalog)
    values (v_proposed_hash, v_base_hash, p_proposed_catalog);
  end if;

  select candidate into v_existing_candidate
    from private.scripture_catalog_candidate where candidate_hash = p_candidate_hash;
  if v_existing_candidate is not null then
    if v_existing_candidate = p_candidate then
      return p_candidate_hash;
    end if;
    raise exception '같은 지문으로 다른 후보가 들어왔습니다.'
      using errcode = 'unique_violation';
  end if;

  insert into private.scripture_catalog_candidate (
    candidate_hash, candidate_kind, target_domain_id, base_version_hash, proposed_version_hash,
    source_research_result_hash, demand_binding_kind, demand_subject_key, candidate
  ) values (
    p_candidate_hash, v_kind, v_target, v_base_hash, v_proposed_hash,
    v_research_hash, v_binding_kind, v_subject_key, p_candidate
  );

  return p_candidate_hash;
end;
$$;

comment on function public.store_scripture_catalog_candidate(text, jsonb, jsonb) is
  '자동 후보 한 건과 그 결과 카탈로그를 적는다. 연구 결과가 없거나 결과가 기준+후보와 다르면 거절한다. 같은 내용 재전송은 멱등이다.';

revoke all on function public.store_scripture_catalog_candidate(text, jsonb, jsonb) from public;
revoke all on function public.store_scripture_catalog_candidate(text, jsonb, jsonb)
  from anon, authenticated, service_role;
grant execute on function public.store_scripture_catalog_candidate(text, jsonb, jsonb) to service_role;

------------------------------------------------------------------
-- 함수 5. 자동 검증 기록과 attestation 적기
------------------------------------------------------------------

-- p_attestations: [{ "attestationHash": "satt_…", "attestation": { … } }, …]
create function public.store_scripture_catalog_validation(
  p_validation_hash text,
  p_candidate_hash text,
  p_validation jsonb,
  p_attestations jsonb
)
returns text
language plpgsql
security definer
set search_path = private, pg_catalog
as $$
declare
  v_required_checks constant text[] := array[
    'demandSignal',
    'passageExistence',
    'krvTextMatch',
    'contextTheologyReview',
    'safetyBoundary',
    'duplicateCheck',
    'corpusRegression',
    'candidateGenerationEvaluation'
  ];
  v_candidate private.scripture_catalog_candidate%rowtype;
  v_existing private.scripture_catalog_validation%rowtype;
  v_check_name text;
  v_status text;
  v_item jsonb;
  v_attestation jsonb;
  v_attestation_count integer;
begin
  if p_validation_hash is null or p_validation_hash !~ '^scval_[0-9a-f]{64}$'
     or p_candidate_hash is null or p_candidate_hash !~ '^sccand_[0-9a-f]{64}$'
     or p_validation is null or jsonb_typeof(p_validation) <> 'object'
     or p_validation ->> 'validationAuthority' is distinct from 'automated_validation'
     or p_validation ->> 'contractVersion' is distinct from 'automatic-scripture-catalog-validation/v2'
     or p_validation ->> 'candidateHash' is distinct from p_candidate_hash
     or coalesce(p_validation ->> 'validatorRegistryHash', '') !~ '^svreg_[0-9a-f]{64}$'
     or p_validation ->> 'overallStatus' is null
     or not (p_validation ->> 'overallStatus' = any (array['pass', 'fail']))
     or jsonb_typeof(p_validation -> 'checks') is distinct from 'object'
     or (select count(*) from jsonb_object_keys(p_validation -> 'checks')) <> array_length(v_required_checks, 1)
     or p_attestations is null or jsonb_typeof(p_attestations) <> 'array' then
    raise exception '검증 기록 요청이 올바르지 않습니다.'
      using errcode = 'invalid_parameter_value';
  end if;

  foreach v_check_name in array v_required_checks loop
    if jsonb_typeof(p_validation -> 'checks' -> v_check_name) is distinct from 'object'
       or not (coalesce(p_validation -> 'checks' -> v_check_name ->> 'status', '') = any (array['pass', 'fail', 'not_run']))
       or coalesce(p_validation -> 'checks' -> v_check_name ->> 'artifactHash', '') !~ '^sart_[0-9a-f]{64}$'
       or not jsonb_exists(p_validation -> 'checks' -> v_check_name, 'payload') then
      raise exception '검증 기록 요청이 올바르지 않습니다.'
        using errcode = 'invalid_parameter_value';
    end if;
  end loop;

  select * into v_candidate from private.scripture_catalog_candidate where candidate_hash = p_candidate_hash;
  if not found then
    raise exception '후보가 없습니다.'
      using errcode = 'no_data_found';
  end if;

  if p_validation ->> 'candidateKind' is distinct from v_candidate.candidate_kind
     or p_validation ->> 'baseVersionHash' is distinct from v_candidate.base_version_hash
     or p_validation ->> 'proposedVersionHash' is distinct from v_candidate.proposed_version_hash then
    raise exception '검증 기록이 후보와 이어지지 않습니다.'
      using errcode = 'check_violation';
  end if;

  -- 같은 지문의 재전송: 기록과 attestation 묶음이 모두 같을 때만 멱등이다.
  select * into v_existing from private.scripture_catalog_validation where validation_hash = p_validation_hash;
  if found then
    if v_existing.candidate_hash = p_candidate_hash
       and v_existing.validation = p_validation
       and (select count(*) from private.scripture_catalog_validation_attestation
             where validation_hash = p_validation_hash) = jsonb_array_length(p_attestations)
       and not exists (
         select 1 from jsonb_array_elements(p_attestations) as e(item)
          where not exists (
            select 1 from private.scripture_catalog_validation_attestation a
             where a.validation_hash = p_validation_hash
               and a.attestation_hash = item ->> 'attestationHash'
               and a.attestation = item -> 'attestation'
          )
       ) then
      return p_validation_hash;
    end if;
    raise exception '같은 지문으로 다른 검증 기록이 들어왔습니다.'
      using errcode = 'unique_violation';
  end if;

  insert into private.scripture_catalog_validation (validation_hash, candidate_hash, validation)
  values (p_validation_hash, p_candidate_hash, p_validation);

  for v_item in select value from jsonb_array_elements(p_attestations) loop
    v_attestation := v_item -> 'attestation';
    if jsonb_typeof(v_attestation) is distinct from 'object'
       or coalesce(v_item ->> 'attestationHash', '') !~ '^satt_[0-9a-f]{64}$' then
      raise exception '검증 기록 요청이 올바르지 않습니다.'
        using errcode = 'invalid_parameter_value';
    end if;
    -- 표 조건과 연결 방아쇠가 profile 권한, payload 지문, 기록된 결과와의 일치를 확인한다.
    insert into private.scripture_catalog_validation_attestation (
      attestation_hash, validation_hash, candidate_hash, check_name,
      profile_hash, payload_hash, verdict, attestation
    ) values (
      v_item ->> 'attestationHash', p_validation_hash, p_candidate_hash, v_attestation ->> 'checkName',
      v_attestation ->> 'profileHash', v_attestation ->> 'payloadHash', v_attestation ->> 'verdict', v_attestation
    );
  end loop;

  -- 실행된 항목마다 attestation이 있어야 하고, 실행되지 않은 항목에는 없어야 한다.
  foreach v_check_name in array v_required_checks loop
    v_status := p_validation -> 'checks' -> v_check_name ->> 'status';
    select count(*) into v_attestation_count
      from private.scripture_catalog_validation_attestation
     where validation_hash = p_validation_hash and check_name = v_check_name;
    if (v_status = 'not_run' and v_attestation_count <> 0)
       or (v_status <> 'not_run' and v_attestation_count = 0) then
      raise exception '검증 항목과 attestation이 맞지 않습니다.'
        using errcode = 'check_violation';
    end if;
  end loop;

  -- 신학 평가는 payload에서 평가한 validator와 attestation을 낸 validator가 정확히 같아야 한다.
  if p_validation -> 'checks' -> 'contextTheologyReview' ->> 'status' <> 'not_run'
     and (
       jsonb_typeof(p_validation #> '{checks,contextTheologyReview,payload,evaluations}') is distinct from 'array'
       or (
         select coalesce(array_agg(profile_hash order by profile_hash), array[]::text[])
           from private.scripture_catalog_validation_attestation
          where validation_hash = p_validation_hash and check_name = 'contextTheologyReview'
       ) is distinct from (
         select coalesce(array_agg(item ->> 'profileHash' order by item ->> 'profileHash'), array[]::text[])
           from jsonb_array_elements(p_validation #> '{checks,contextTheologyReview,payload,evaluations}') as e(item)
       )
     ) then
    raise exception '신학 평가 validator와 attestation이 맞지 않습니다.'
      using errcode = 'check_violation';
  end if;

  return p_validation_hash;
end;
$$;

comment on function public.store_scripture_catalog_validation(text, text, jsonb, jsonb) is
  '자동 검증 기록과 항목별 attestation을 한 묶음으로 적는다. 실패 기록도 남긴다. 활성화 여부는 여기서 정하지 않는다.';

revoke all on function public.store_scripture_catalog_validation(text, text, jsonb, jsonb) from public;
revoke all on function public.store_scripture_catalog_validation(text, text, jsonb, jsonb)
  from anon, authenticated, service_role;
grant execute on function public.store_scripture_catalog_validation(text, text, jsonb, jsonb) to service_role;

------------------------------------------------------------------
-- 함수 6. 자동 활성화 (fail-closed)
------------------------------------------------------------------

-- 받는 값은 번호와 지문뿐이다. 검증 결과를 요청에서 받지 않고 적혀 있는 기록을 다시 본다.
-- 적힌 status를 믿지 않고 저장된 집계·카탈로그·payload에서 다시 계산하고,
-- 다시 계산할 수 없는 항목은 등록 validator의 attestation을 요구한다.
-- 어느 확인이든 실패하면 예외로 끝나고, 함수 한 번이 한 트랜잭션이므로 아무것도 남지 않는다.
-- 이 함수 안에서 예외를 삼키지 않는다.
create function public.activate_scripture_catalog_candidate(
  p_request_id text,
  p_candidate_hash text,
  p_validation_hash text,
  p_expected_active_version_hash text
)
returns uuid
language plpgsql
security definer
set search_path = private, pg_catalog
as $$
declare
  -- 아래 값들의 주인은 automatic-scripture-catalog-activation-contract.ts 다.
  -- migration 계약 테스트가 둘을 대조한다.
  v_required_checks constant text[] := array[
    'demandSignal',
    'passageExistence',
    'krvTextMatch',
    'contextTheologyReview',
    'safetyBoundary',
    'duplicateCheck',
    'corpusRegression',
    'candidateGenerationEvaluation'
  ];
  v_min_independent_evaluations constant integer := 2;
  v_min_demand_occurrences constant integer := 30;
  v_min_demand_active_days constant integer := 7;
  v_min_reportable_daily_count constant integer := 5;
  v_max_demand_window_days constant integer := 90;
  v_min_generation_cases_per_card constant integer := 3;
  v_bible_source_sha256 constant text := '65c6d99f80a5a47b9c0d144f313ac533f482454f336d3a82fc1dcedb020612e2';

  v_replay private.scripture_catalog_activation%rowtype;
  v_pointer private.scripture_catalog_active_pointer%rowtype;
  v_candidate private.scripture_catalog_candidate%rowtype;
  v_base_catalog jsonb;
  v_validation jsonb;
  v_checks jsonb;
  v_check_name text;
  v_demand jsonb;
  v_window_start date;
  v_window_end date;
  v_expected_daily jsonb;
  v_demand_total bigint;
  v_demand_active_days bigint;
  v_expected_passages jsonb;
  v_expected_compared jsonb;
  v_overlap_count bigint;
  v_group_count bigint;
  v_theology_attestations bigint;
  v_all_model_evaluators boolean;
  v_card_count integer;
  v_next_revision bigint;
  v_activation_id uuid;
begin
  if p_request_id is null or p_request_id !~ '^screq_[0-9a-f]{32}$'
     or p_candidate_hash is null or p_candidate_hash !~ '^sccand_[0-9a-f]{64}$'
     or p_validation_hash is null or p_validation_hash !~ '^scval_[0-9a-f]{64}$'
     or p_expected_active_version_hash is null
     or p_expected_active_version_hash !~ '^scat_[0-9a-f]{64}$' then
    raise exception '활성화 요청이 올바르지 않습니다.'
      using errcode = 'invalid_parameter_value';
  end if;

  -- 같은 요청 번호: 같은 내용이면 이미 끝난 결과, 다르면 거절.
  select * into v_replay from private.scripture_catalog_activation where request_id = p_request_id;
  if found then
    if v_replay.candidate_hash = p_candidate_hash
       and v_replay.validation_hash = p_validation_hash
       and v_replay.from_version_hash = p_expected_active_version_hash then
      return v_replay.activation_id;
    end if;
    raise exception '같은 요청 번호로 다른 활성화가 들어왔습니다.'
      using errcode = 'unique_violation';
  end if;

  -- 동시에 들어온 전환이 서로를 덮지 않도록 포인터를 잠근다.
  select * into v_pointer from private.scripture_catalog_active_pointer where singleton for update;
  if not found then
    raise exception '활성 카탈로그가 없습니다.'
      using errcode = 'no_data_found';
  end if;
  if v_pointer.active_version_hash <> p_expected_active_version_hash then
    raise exception '활성 버전이 이미 바뀌었습니다.'
      using errcode = 'serialization_failure';
  end if;

  select * into v_candidate from private.scripture_catalog_candidate where candidate_hash = p_candidate_hash;
  if not found then
    raise exception '후보가 없습니다.'
      using errcode = 'no_data_found';
  end if;
  if v_candidate.base_version_hash <> v_pointer.active_version_hash then
    raise exception '후보의 기준 버전이 현재 활성 버전이 아닙니다.'
      using errcode = 'serialization_failure';
  end if;

  if not exists (
    select 1 from private.research_result where result_hash = v_candidate.source_research_result_hash
  ) then
    raise exception '연구 보관소에 없는 연구 결과입니다.'
      using errcode = 'foreign_key_violation';
  end if;

  if exists (
    select 1 from private.scripture_catalog_activation
     where candidate_hash = p_candidate_hash
        or to_version_hash = v_candidate.proposed_version_hash
  ) then
    raise exception '이미 활성화된 후보 또는 버전입니다.'
      using errcode = 'unique_violation';
  end if;

  select validation into v_validation
    from private.scripture_catalog_validation
   where validation_hash = p_validation_hash
     and candidate_hash = p_candidate_hash;
  if v_validation is null then
    raise exception '이 후보의 검증 기록이 없습니다.'
      using errcode = 'no_data_found';
  end if;

  select catalog into v_base_catalog
    from private.scripture_catalog_version where version_hash = v_candidate.base_version_hash;

  ----------------------------------------------------------------
  -- 기록의 이음과 항목 목록
  ----------------------------------------------------------------

  if v_validation ->> 'validationAuthority' is distinct from 'automated_validation'
     or v_validation ->> 'candidateKind' is distinct from v_candidate.candidate_kind
     or v_validation ->> 'baseVersionHash' is distinct from v_candidate.base_version_hash
     or v_validation ->> 'proposedVersionHash' is distinct from v_candidate.proposed_version_hash
     or v_validation ->> 'overallStatus' is distinct from 'pass'
     or v_validation #>> '{dataVersions,bibleSourceSha256}' is distinct from v_bible_source_sha256 then
    raise exception '검증 기록이 활성화 조건을 만족하지 않습니다.'
      using errcode = 'check_violation';
  end if;

  v_checks := v_validation -> 'checks';
  if jsonb_typeof(v_checks) is distinct from 'object'
     or (select count(*) from jsonb_object_keys(v_checks)) <> array_length(v_required_checks, 1) then
    raise exception '검증 기록이 활성화 조건을 만족하지 않습니다.'
      using errcode = 'check_violation';
  end if;

  ----------------------------------------------------------------
  -- 항목마다: status pass + 등록·권한 있는 profile의 pass attestation이 payload 지문에 묶여 있고,
  -- 실패 attestation이 하나도 없어야 한다.
  ----------------------------------------------------------------

  foreach v_check_name in array v_required_checks loop
    if not jsonb_exists(v_checks, v_check_name)
       or jsonb_typeof(v_checks -> v_check_name) is distinct from 'object'
       or v_checks -> v_check_name ->> 'status' is distinct from 'pass'
       or coalesce(v_checks -> v_check_name ->> 'artifactHash', '') !~ '^sart_[0-9a-f]{64}$' then
      raise exception '검증 기록이 활성화 조건을 만족하지 않습니다.'
        using errcode = 'check_violation';
    end if;

    if not exists (
         select 1
           from private.scripture_catalog_validation_attestation a
           join private.scripture_catalog_validator_profile vp on vp.profile_hash = a.profile_hash
          where a.validation_hash = p_validation_hash
            and a.check_name = v_check_name
            and a.verdict = 'pass'
            and a.payload_hash = v_checks -> v_check_name ->> 'artifactHash'
            and vp.authorized_checks @> array[v_check_name]
       )
       or exists (
         select 1 from private.scripture_catalog_validation_attestation a
          where a.validation_hash = p_validation_hash
            and a.check_name = v_check_name
            and (a.verdict <> 'pass' or a.payload_hash <> v_checks -> v_check_name ->> 'artifactHash')
       ) then
      raise exception '등록된 validator의 attestation이 활성화 조건을 만족하지 않습니다.'
        using errcode = 'check_violation';
    end if;
  end loop;

  ----------------------------------------------------------------
  -- 독립 평가: registry의 서로 다른 independence_group 모델 평가자 최소 둘, 모든 카드 pass.
  ----------------------------------------------------------------

  select count(distinct vp.independence_group), count(*), bool_and(vp.validator_kind = 'model_evaluator')
    into v_group_count, v_theology_attestations, v_all_model_evaluators
    from private.scripture_catalog_validation_attestation a
    join private.scripture_catalog_validator_profile vp on vp.profile_hash = a.profile_hash
   where a.validation_hash = p_validation_hash
     and a.check_name = 'contextTheologyReview'
     and a.verdict = 'pass';

  v_card_count := jsonb_array_length(v_candidate.candidate -> 'cards');

  if v_group_count < v_min_independent_evaluations
     or v_group_count <> v_theology_attestations
     or not coalesce(v_all_model_evaluators, false)
     or jsonb_typeof(v_checks #> '{contextTheologyReview,payload,evaluations}') is distinct from 'array'
     or jsonb_array_length(v_checks #> '{contextTheologyReview,payload,evaluations}') <> v_theology_attestations
     or exists (
       select 1 from jsonb_array_elements(v_checks #> '{contextTheologyReview,payload,evaluations}') as e(item)
        where jsonb_typeof(item -> 'cardVerdicts') is distinct from 'array'
           or jsonb_array_length(item -> 'cardVerdicts') <> v_card_count
           or not exists (
             select 1 from private.scripture_catalog_validation_attestation a
              where a.validation_hash = p_validation_hash
                and a.check_name = 'contextTheologyReview'
                and a.profile_hash = item ->> 'profileHash'
           )
           or exists (
             select 1 from jsonb_array_elements(item -> 'cardVerdicts') as v(verdict_item)
              where verdict_item ->> 'verdict' is distinct from 'pass'
           )
     ) then
    raise exception '독립 평가가 등록된 서로 다른 그룹에서 합의하지 않았습니다.'
      using errcode = 'check_violation';
  end if;

  ----------------------------------------------------------------
  -- 수요: 집계 표에서 기간별 횟수를 다시 만들어 evidence와 대조한다.
  ----------------------------------------------------------------

  v_demand := v_checks #> '{demandSignal,payload}';
  if jsonb_typeof(v_demand) is distinct from 'object'
     or v_demand ->> 'contractVersion' is distinct from 'scripture-demand-evidence/v1'
     or v_demand ->> 'evidenceKind' is distinct from v_candidate.demand_binding_kind
     or v_demand ->> 'subjectKey' is distinct from v_candidate.demand_subject_key
     or coalesce(v_demand ->> 'windowStartDate', '') !~ '^\d{4}-\d{2}-\d{2}$'
     or coalesce(v_demand ->> 'windowEndDate', '') !~ '^\d{4}-\d{2}-\d{2}$' then
    raise exception '수요 evidence가 후보와 이어지지 않습니다.'
      using errcode = 'check_violation';
  end if;

  v_window_start := (v_demand ->> 'windowStartDate')::date;
  v_window_end := (v_demand ->> 'windowEndDate')::date;
  if v_window_end < v_window_start
     or v_window_end - v_window_start + 1 > v_max_demand_window_days
     or v_window_end >= (now() at time zone 'Asia/Seoul')::date then
    raise exception '수요 기간이 올바르지 않거나 아직 끝나지 않았습니다.'
      using errcode = 'check_violation';
  end if;

  if v_candidate.demand_binding_kind = 'weak_match' then
    select jsonb_agg(
             jsonb_build_object(
               'date', to_char(d.day, 'YYYY-MM-DD'),
               'count', case when coalesce(w.match_count, 0) >= v_min_reportable_daily_count then w.match_count else 0 end
             )
             order by d.day
           )
      into v_expected_daily
      from generate_series(v_window_start::timestamp, v_window_end::timestamp, interval '1 day') as d(day)
      left join private.scripture_demand_weak_match_daily w
        on w.bucket_date = d.day::date and w.domain_id = v_candidate.demand_subject_key;
  else
    select jsonb_agg(
             jsonb_build_object(
               'date', to_char(d.day, 'YYYY-MM-DD'),
               'count', case when coalesce(t.theme_count, 0) >= v_min_reportable_daily_count then t.theme_count else 0 end
             )
             order by d.day
           )
      into v_expected_daily
      from generate_series(v_window_start::timestamp, v_window_end::timestamp, interval '1 day') as d(day)
      left join private.scripture_demand_theme_daily t
        on t.bucket_date = d.day::date and t.theme_fingerprint = v_candidate.demand_subject_key;
  end if;

  if v_expected_daily is null or v_demand -> 'dailyCounts' is distinct from v_expected_daily then
    raise exception '수요 evidence가 실제 집계와 다릅니다.'
      using errcode = 'check_violation';
  end if;

  select coalesce(sum((item ->> 'count')::bigint), 0), count(*) filter (where (item ->> 'count')::bigint > 0)
    into v_demand_total, v_demand_active_days
    from jsonb_array_elements(v_expected_daily) as e(item);

  if v_demand_total < v_min_demand_occurrences or v_demand_active_days < v_min_demand_active_days then
    raise exception '수요가 활성화 기준에 미치지 못합니다.'
      using errcode = 'check_violation';
  end if;

  ----------------------------------------------------------------
  -- 본문 위치·개역한글·중복: 저장된 후보와 기준 카탈로그에서 다시 만든다.
  ----------------------------------------------------------------

  select coalesce(
           jsonb_agg(
             jsonb_build_object(
               'cardId', c.item ->> 'id',
               'passageIndex', p.ord - 1,
               'book', p.item ->> 'book',
               'chapter', p.item -> 'chapter',
               'startVerse', p.item -> 'startVerse',
               'endVerse', p.item -> 'endVerse'
             )
             order by c.ord, p.ord
           ),
           '[]'::jsonb
         )
    into v_expected_passages
    from jsonb_array_elements(v_candidate.candidate -> 'cards') with ordinality as c(item, ord),
         jsonb_array_elements(c.item -> 'passages') with ordinality as p(item, ord);

  if v_checks #> '{passageExistence,payload,passages}' is distinct from v_expected_passages
     or v_checks #>> '{krvTextMatch,payload,bibleSourceSha256}' is distinct from v_bible_source_sha256
     or jsonb_typeof(v_checks #> '{krvTextMatch,payload,passageTextHashes}') is distinct from 'array'
     or jsonb_array_length(v_checks #> '{krvTextMatch,payload,passageTextHashes}') <> jsonb_array_length(v_expected_passages) then
    raise exception '본문 위치 검증이 후보와 다릅니다.'
      using errcode = 'check_violation';
  end if;

  select coalesce(jsonb_agg(c.item -> 'id' order by c.ord), '[]'::jsonb)
    into v_expected_compared
    from jsonb_array_elements(v_base_catalog -> 'cards') with ordinality as c(item, ord);

  with candidate_passages as (
    select c.item ->> 'id' as card_id, p.item as passage
      from jsonb_array_elements(v_candidate.candidate -> 'cards') as c(item),
           jsonb_array_elements(c.item -> 'passages') as p(item)
  ),
  other_passages as (
    select c.item ->> 'id' as card_id, p.item as passage
      from jsonb_array_elements(v_base_catalog -> 'cards') as c(item),
           jsonb_array_elements(c.item -> 'passages') as p(item)
    union all
    select card_id, passage from candidate_passages
  )
  select count(*) into v_overlap_count
    from candidate_passages x
    join other_passages o
      on o.card_id <> x.card_id
     and o.passage ->> 'book' = x.passage ->> 'book'
     and (o.passage ->> 'chapter')::integer = (x.passage ->> 'chapter')::integer
     and (o.passage ->> 'startVerse')::integer <= (x.passage ->> 'endVerse')::integer
     and (x.passage ->> 'startVerse')::integer <= (o.passage ->> 'endVerse')::integer;

  if v_overlap_count <> 0
     or v_checks #> '{duplicateCheck,payload,overlaps}' is distinct from '[]'::jsonb
     or v_checks #> '{duplicateCheck,payload,comparedCardIds}' is distinct from v_expected_compared then
    raise exception '기존 카드와 본문이 겹치거나 중복 검증이 카탈로그와 다릅니다.'
      using errcode = 'check_violation';
  end if;

  ----------------------------------------------------------------
  -- 안전·회귀·생성 평가: payload 안의 사례를 다시 센다.
  ----------------------------------------------------------------

  if jsonb_typeof(v_checks #> '{safetyBoundary,payload,cases}') is distinct from 'array'
     or jsonb_array_length(v_checks #> '{safetyBoundary,payload,cases}') = 0
     or exists (
       select 1 from jsonb_array_elements(v_checks #> '{safetyBoundary,payload,cases}') as e(item)
        where item ->> 'expectedRoute' is null
           or item ->> 'expectedRoute' is distinct from item ->> 'observedRoute'
     ) then
    raise exception '안전 경계 사례가 활성화 조건을 만족하지 않습니다.'
      using errcode = 'check_violation';
  end if;

  if jsonb_typeof(v_checks #> '{corpusRegression,payload,cases}') is distinct from 'array'
     or jsonb_array_length(v_checks #> '{corpusRegression,payload,cases}') = 0
     or exists (
       select 1 from jsonb_array_elements(v_checks #> '{corpusRegression,payload,cases}') as e(item)
        where (item #> '{candidate,safetyFalsePositive}') is distinct from 'false'::jsonb
           or ((item #> '{baseline,domainMatch}') = 'true'::jsonb
               and (item #> '{candidate,domainMatch}') is distinct from 'true'::jsonb)
           or ((item #> '{baseline,acceptableMatch}') = 'true'::jsonb
               and (item #> '{candidate,acceptableMatch}') is distinct from 'true'::jsonb)
     ) then
    raise exception '평가 코퍼스 회귀가 활성화 조건을 만족하지 않습니다.'
      using errcode = 'check_violation';
  end if;

  if jsonb_typeof(v_checks #> '{candidateGenerationEvaluation,payload,cases}') is distinct from 'array'
     or exists (
       select 1 from jsonb_array_elements(v_candidate.candidate -> 'cards') as c(item)
        where (
          select count(*) from jsonb_array_elements(v_checks #> '{candidateGenerationEvaluation,payload,cases}') as g(case_item)
           where case_item ->> 'cardId' = c.item ->> 'id'
        ) < v_min_generation_cases_per_card
     )
     or exists (
       select 1 from jsonb_array_elements(v_checks #> '{candidateGenerationEvaluation,payload,cases}') as g(case_item)
        where (case_item -> 'passed') is distinct from 'true'::jsonb
           or not exists (
             select 1 from jsonb_array_elements(v_candidate.candidate -> 'cards') as c(item)
              where c.item ->> 'id' = case_item ->> 'cardId'
           )
     ) then
    raise exception '신규 카드 생성 평가가 활성화 조건을 만족하지 않습니다.'
      using errcode = 'check_violation';
  end if;

  ----------------------------------------------------------------
  -- 활성화 기록 · 공지 기록 · 포인터 전환을 한 트랜잭션에 함께 남긴다.
  ----------------------------------------------------------------

  v_next_revision := v_pointer.pointer_revision + 1;

  insert into private.scripture_catalog_activation (
    request_id, candidate_hash, validation_hash,
    from_version_hash, to_version_hash, pointer_revision, authority
  ) values (
    p_request_id, p_candidate_hash, p_validation_hash,
    v_pointer.active_version_hash, v_candidate.proposed_version_hash, v_next_revision, 'automated_validation'
  )
  returning activation_id into v_activation_id;

  insert into private.scripture_catalog_owner_notification (pointer_revision, notification_kind, notice)
  values (
    v_next_revision,
    'catalog_activated',
    jsonb_build_object(
      'kind', 'catalog_activated',
      'pointerRevision', v_next_revision,
      'fromVersionHash', v_pointer.active_version_hash,
      'toVersionHash', v_candidate.proposed_version_hash,
      'candidateHash', p_candidate_hash,
      'reasonCode', null
    )
  );

  update private.scripture_catalog_active_pointer
     set active_version_hash = v_candidate.proposed_version_hash,
         pointer_revision = v_next_revision,
         updated_at = now()
   where singleton;

  return v_activation_id;
end;
$$;

comment on function public.activate_scripture_catalog_candidate(text, text, text, text) is
  '연구 결과·수요 집계·카탈로그·payload·등록 validator attestation을 모두 다시 확인한 뒤에만 활성화한다. 활성화·공지·포인터 전환이 함께 성공하거나 함께 없던 일이 된다.';

revoke all on function public.activate_scripture_catalog_candidate(text, text, text, text) from public;
revoke all on function public.activate_scripture_catalog_candidate(text, text, text, text)
  from anon, authenticated, service_role;
grant execute on function public.activate_scripture_catalog_candidate(text, text, text, text) to service_role;

------------------------------------------------------------------
-- 함수 7. 롤백 (이전에 활성이었던 조상 버전으로만)
------------------------------------------------------------------

create function public.rollback_scripture_catalog_version(
  p_request_id text,
  p_target_version_hash text,
  p_expected_active_version_hash text,
  p_reason_code text
)
returns uuid
language plpgsql
security definer
set search_path = private, pg_catalog
as $$
declare
  v_rollback_reason_codes constant text[] := array[
    'regression_detected',
    'safety_concern',
    'validation_evidence_invalidated',
    'owner_requested',
    'operational_incident'
  ];

  v_replay private.scripture_catalog_rollback%rowtype;
  v_pointer private.scripture_catalog_active_pointer%rowtype;
  v_next_revision bigint;
  v_rollback_id uuid;
begin
  if p_request_id is null or p_request_id !~ '^screq_[0-9a-f]{32}$'
     or p_target_version_hash is null or p_target_version_hash !~ '^scat_[0-9a-f]{64}$'
     or p_expected_active_version_hash is null
     or p_expected_active_version_hash !~ '^scat_[0-9a-f]{64}$'
     or p_reason_code is null or not (p_reason_code = any (v_rollback_reason_codes)) then
    raise exception '롤백 요청이 올바르지 않습니다.'
      using errcode = 'invalid_parameter_value';
  end if;

  select * into v_replay from private.scripture_catalog_rollback where request_id = p_request_id;
  if found then
    if v_replay.to_version_hash = p_target_version_hash
       and v_replay.from_version_hash = p_expected_active_version_hash
       and v_replay.reason_code = p_reason_code then
      return v_replay.rollback_id;
    end if;
    raise exception '같은 요청 번호로 다른 롤백이 들어왔습니다.'
      using errcode = 'unique_violation';
  end if;

  select * into v_pointer from private.scripture_catalog_active_pointer where singleton for update;
  if not found then
    raise exception '활성 카탈로그가 없습니다.'
      using errcode = 'no_data_found';
  end if;
  if v_pointer.active_version_hash <> p_expected_active_version_hash then
    raise exception '활성 버전이 이미 바뀌었습니다.'
      using errcode = 'serialization_failure';
  end if;

  -- 조상이면서, 한 번이라도 활성이었던 버전이어야 한다.
  if p_target_version_hash = v_pointer.active_version_hash
     or not exists (
       with recursive ancestors (version_hash) as (
         select parent_version_hash
           from private.scripture_catalog_version
          where version_hash = v_pointer.active_version_hash
            and parent_version_hash is not null
         union
         select v.parent_version_hash
           from private.scripture_catalog_version v
           join ancestors a on v.version_hash = a.version_hash
          where v.parent_version_hash is not null
       )
       select 1 from ancestors where version_hash = p_target_version_hash
     )
     or not (
       exists (select 1 from private.scripture_catalog_baseline where version_hash = p_target_version_hash)
       or exists (select 1 from private.scripture_catalog_activation where to_version_hash = p_target_version_hash)
       or exists (select 1 from private.scripture_catalog_rollback where to_version_hash = p_target_version_hash)
     ) then
    raise exception '이전에 활성이었던 조상 버전으로만 되돌릴 수 있습니다.'
      using errcode = 'check_violation';
  end if;

  v_next_revision := v_pointer.pointer_revision + 1;

  insert into private.scripture_catalog_rollback (
    request_id, from_version_hash, to_version_hash, reason_code, pointer_revision, authority
  ) values (
    p_request_id, v_pointer.active_version_hash, p_target_version_hash, p_reason_code, v_next_revision,
    'automated_operations'
  )
  returning rollback_id into v_rollback_id;

  insert into private.scripture_catalog_owner_notification (pointer_revision, notification_kind, notice)
  values (
    v_next_revision,
    'catalog_rolled_back',
    jsonb_build_object(
      'kind', 'catalog_rolled_back',
      'pointerRevision', v_next_revision,
      'fromVersionHash', v_pointer.active_version_hash,
      'toVersionHash', p_target_version_hash,
      'candidateHash', null,
      'reasonCode', p_reason_code
    )
  );

  update private.scripture_catalog_active_pointer
     set active_version_hash = p_target_version_hash,
         pointer_revision = v_next_revision,
         updated_at = now()
   where singleton;

  return v_rollback_id;
end;
$$;

comment on function public.rollback_scripture_catalog_version(text, text, text, text) is
  '이전에 활성이었던 조상 버전으로만 되돌린다. 롤백·공지·포인터 전환이 함께 성공하거나 함께 없던 일이 된다. 같은 요청 재실행은 멱등이다.';

revoke all on function public.rollback_scripture_catalog_version(text, text, text, text) from public;
revoke all on function public.rollback_scripture_catalog_version(text, text, text, text)
  from anon, authenticated, service_role;
grant execute on function public.rollback_scripture_catalog_version(text, text, text, text) to service_role;
