-- 자동 Scripture Catalog 검증 계약 v2 → v3 업그레이드.
--
-- criterion 단위 신학 attestation으로 저장 계약이 호환 불가능하게 바뀌었다.
--   contextTheologyReview.payload.evaluations[].cardVerdicts (카드 하나에 최종 verdict 하나)
--   → cardEvaluations (카드마다 rubric criterion 아홉 개를 개별 판정, 모델은 카드 최종 verdict를 내지 않는다).
-- 그래서 automatic-scripture-catalog-validation 계약 버전을 v3으로 올리고, 검증 저장·활성화 RPC와
-- 표 제약을 v3 기준으로 다시 만든다.
--
-- 20260915120000_create_automatic_scripture_catalog.sql은 손대지 않는다(이미 적용된 것으로 다룬다).
-- 20260916011019_register_automatic_scripture_catalog_validator_profiles.sql도 profile 등록 전용으로 그대로 둔다.
-- 여기서는 표 하나의 CHECK 제약과 함수 둘(create or replace)만 바꾼다. 다른 표·권한·트리거는 그대로다.

------------------------------------------------------------------
-- 1. 검증 기록 표의 계약 버전 제약을 v3으로 바꾼다.
------------------------------------------------------------------

alter table private.scripture_catalog_validation
  drop constraint scripture_catalog_validation_matches_candidate;

alter table private.scripture_catalog_validation
  add constraint scripture_catalog_validation_matches_candidate
  check (
    jsonb_exists(validation, 'contractVersion')
    and validation ->> 'contractVersion' = 'automatic-scripture-catalog-validation/v3'
    and jsonb_exists(validation, 'candidateHash')
    and validation ->> 'candidateHash' = candidate_hash
  );

------------------------------------------------------------------
-- 함수 5(v3). 자동 검증 기록과 attestation 적기 — 계약 버전만 v3으로 바뀌었다.
------------------------------------------------------------------

create or replace function public.store_scripture_catalog_validation(
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
     or p_validation ->> 'contractVersion' is distinct from 'automatic-scripture-catalog-validation/v3'
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
  '자동 검증 기록과 항목별 attestation을 한 묶음으로 적는다(v3: criterion 단위 신학 attestation). 실패 기록도 남긴다. 활성화 여부는 여기서 정하지 않는다.';

revoke all on function public.store_scripture_catalog_validation(text, text, jsonb, jsonb) from public;
revoke all on function public.store_scripture_catalog_validation(text, text, jsonb, jsonb)
  from anon, authenticated, service_role;
grant execute on function public.store_scripture_catalog_validation(text, text, jsonb, jsonb) to service_role;


------------------------------------------------------------------
-- 함수 6(v3). 자동 활성화 (fail-closed) — criterion 단위 신학 attestation을 DB가 직접 다시 확인한다.
------------------------------------------------------------------

-- 받는 값은 번호와 지문뿐이다. 검증 결과를 요청에서 받지 않고 적혀 있는 기록을 다시 본다.
-- 적힌 status를 믿지 않고 저장된 집계·카탈로그·payload에서 다시 계산하고,
-- 다시 계산할 수 없는 항목은 등록 validator의 attestation을 요구한다.
-- 어느 확인이든 실패하면 예외로 끝나고, 함수 한 번이 한 트랜잭션이므로 아무것도 남지 않는다.
-- 이 함수 안에서 예외를 삼키지 않는다.
create or replace function public.activate_scripture_catalog_candidate(
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
  -- criterion 아홉 개, rubric(THEOLOGY_REVIEW_RUBRIC.criteria)과 정확히 같은 순서.
  -- 이 값의 주인은 automatic-scripture-catalog-activation-contract.ts의 THEOLOGY_CRITERION_IDS다.
  v_required_criteria constant text[] := array[
    'context-fidelity',
    'no-unpromised-outcome',
    'no-divine-intent-claim',
    'domain-tag-support',
    'crisis-guidance-precedence',
    'no-coerced-reconciliation',
    'krv-citation-integrity',
    'new-domain-distinctness',
    'uncertainty-defaults-to-fail'
  ];

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
  v_expected_card_ids text[];
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

  if v_validation ->> 'contractVersion' is distinct from 'automatic-scripture-catalog-validation/v3'
     or v_validation ->> 'validationAuthority' is distinct from 'automated_validation'
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
  -- 독립 평가: registry의 서로 다른 independence_group 모델 평가자 최소 둘,
  -- 카드마다 rubric criterion 아홉 개 전부가 정확한 순서로 있고 모두 pass.
  -- v3: 모델은 카드 최종 verdict를 내지 않는다. TypeScript 결과를 믿지 않고
  -- evaluation·카드·criterion 세 층의 필드·개수·차례를 여기서 직접 다시 만들어 대조한다.
  ----------------------------------------------------------------

  select count(distinct vp.independence_group), count(*), bool_and(vp.validator_kind = 'model_evaluator')
    into v_group_count, v_theology_attestations, v_all_model_evaluators
    from private.scripture_catalog_validation_attestation a
    join private.scripture_catalog_validator_profile vp on vp.profile_hash = a.profile_hash
   where a.validation_hash = p_validation_hash
     and a.check_name = 'contextTheologyReview'
     and a.verdict = 'pass';

  v_card_count := jsonb_array_length(v_candidate.candidate -> 'cards');
  select array_agg(item ->> 'id' order by ord)
    into v_expected_card_ids
    from jsonb_array_elements(v_candidate.candidate -> 'cards') with ordinality as e(item, ord);

  if v_group_count < v_min_independent_evaluations
     or v_group_count <> v_theology_attestations
     or not coalesce(v_all_model_evaluators, false)
     or jsonb_typeof(v_checks #> '{contextTheologyReview,payload,evaluations}') is distinct from 'array'
     or jsonb_array_length(v_checks #> '{contextTheologyReview,payload,evaluations}') <> v_theology_attestations
     or exists (
       select 1 from jsonb_array_elements(v_checks #> '{contextTheologyReview,payload,evaluations}') as e(item)
        where (select array_agg(k order by k) from jsonb_object_keys(item) as k)
                is distinct from array['cardEvaluations', 'profileHash']
           or jsonb_typeof(item -> 'cardEvaluations') is distinct from 'array'
           or jsonb_array_length(item -> 'cardEvaluations') <> v_card_count
           or (
             select array_agg(card ->> 'cardId' order by ord)
               from jsonb_array_elements(item -> 'cardEvaluations') with ordinality as c(card, ord)
           ) is distinct from v_expected_card_ids
           or not exists (
             select 1 from private.scripture_catalog_validation_attestation a
              where a.validation_hash = p_validation_hash
                and a.check_name = 'contextTheologyReview'
                and a.profile_hash = item ->> 'profileHash'
           )
           -- 카드 하나라도 필드·criterion 아홉 개의 모양·차례·판정이 어긋나면 그 evaluation은 무효다.
           or exists (
             select 1 from jsonb_array_elements(item -> 'cardEvaluations') as c(card)
              where (select array_agg(k order by k) from jsonb_object_keys(card) as k)
                      is distinct from array['cardId', 'criteria']
                 or jsonb_typeof(card -> 'criteria') is distinct from 'array'
                 or jsonb_array_length(card -> 'criteria') <> array_length(v_required_criteria, 1)
                 or exists (
                   select 1
                     from jsonb_array_elements(card -> 'criteria') with ordinality as crit(entry, ord)
                    where (select array_agg(k order by k) from jsonb_object_keys(entry) as k)
                            is distinct from array['criterionId', 'verdict']
                       or entry ->> 'criterionId' is distinct from v_required_criteria[ord]
                       or entry ->> 'verdict' is distinct from 'pass'
                 )
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
  '연구 결과·수요 집계·카탈로그·payload·등록 validator attestation을 모두 다시 확인한 뒤에만 활성화한다(v3: criterion 단위 신학 attestation). 활성화·공지·포인터 전환이 함께 성공하거나 함께 없던 일이 된다.';

revoke all on function public.activate_scripture_catalog_candidate(text, text, text, text) from public;
revoke all on function public.activate_scripture_catalog_candidate(text, text, text, text)
  from anon, authenticated, service_role;
grant execute on function public.activate_scripture_catalog_candidate(text, text, text, text) to service_role;
