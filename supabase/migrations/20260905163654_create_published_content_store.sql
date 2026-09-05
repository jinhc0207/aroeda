-- 아뢰다 · 게시 콘텐츠 보관소와 사람의 검토
--
-- 무엇을 위한 것인가
--   연구 결과는 이제 남는다. 그러나 그것은 연구자를 위한 재료이지
--   사용자가 읽을 글이 아니다.
--
--   그 사이에 사람이 선다.
--     연구 결과 → 검토 대상 글 → 사람의 승인 → 게시 콘텐츠
--
--   이 migration은 그 네 자리를 만든다.
--
-- 왜 권한을 둘로 나누는가
--   글을 적어 두는 것은 아직 승인이 아니다. 서버가 해도 된다.
--   승인은 사람이 읽고 판단하는 일이다. 서버 열쇠로 되면 안 된다.
--
--   그래서 승인 함수에는 service_role 실행 권한을 주지 않는다.
--   로그인한 사람 중에서도 검토자 명단에 있는 사람만 부를 수 있다.
--   누가 검토했는지는 요청에서 받지 않고 auth.uid()로 읽는다.
--
-- 이 경계가 보장하는 것과 하지 못하는 것
--   보장하려는 것은 "정상 권한 경로에서 서버 열쇠 자동화와 사람의 승인을 분리"한다는 것이다.
--   실제로 사람이 버튼을 눌렀다는 증명은 아니다.
--   검토자 계정이 털리거나, 프로젝트 관리자 권한이 있거나, postgres 주인이면
--   이 경계는 위가 아니라 아래에서 열린다.
--
-- SQL에 값을 한 벌 더 적는 이유
--   승인 함수는 로그인한 사람에게 열린다. 우리 앱을 거치지 않고 직접 부를 수 있다.
--   그래서 결정 종류, 확인 항목 이름, 반려 이유를 DB가 스스로 알고 막아야 한다.
--
--   다만 그 값들의 주인은 여기가 아니다.
--   주인은 supabase/functions/_shared/published-content-contract.ts 이고
--   여기 적힌 것은 보안을 위한 사본이다.
--   둘이 갈라지면 migration 계약 테스트가 먼저 깨진다.
--
-- 여기서 하지 않는 일
--   글의 뜻을 검사하지 않는다. 태그 길이, 본문이 연구 후보인지, 지문 계산은
--   애플리케이션 계약의 몫이다. 여기서 다시 하면 규칙의 주인이 둘이 된다.
--
--   검토자를 등록하지 않는다. 명단이 비어 있으면 승인 함수는 아무도 부를 수 없다.
--   그것은 고장이 아니라 의도한 상태다. 사람을 넣는 일은 따로 승인받는다.
--
-- 이 migration은 아직 어디에도 적용하지 않았다.

create schema if not exists private;

------------------------------------------------------------------
-- 고쳐 쓰지 못하게 막는 방아쇠
------------------------------------------------------------------

-- 세 표가 함께 쓴다. 하는 일이 같아서 따로 둘 이유가 없다.
-- 검토자 명단에는 걸지 않는다. 권한을 주고 거두는 일이 있어야 하기 때문이다.
--
-- 남의 권한을 빌리지 않는다(security definer 아님). 오류만 내면 되기 때문이다.
-- 오류 문구에 저장된 내용을 담지 않는다.
create or replace function private.reject_published_content_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception '게시 콘텐츠 보관소는 새로 적기만 합니다. 고치거나 지울 수 없습니다.'
    using errcode = 'restrict_violation';
end;
$$;

comment on function private.reject_published_content_mutation() is
  '게시 콘텐츠 관련 표의 UPDATE / DELETE / TRUNCATE 를 거절한다. 저장된 내용은 오류 문구에 담지 않는다.';

------------------------------------------------------------------
-- 1. 검토 대상 글
------------------------------------------------------------------

create table private.published_content_candidate (
  -- 글의 지문이 곧 이 줄의 이름이다.
  -- 따로 번호를 두면 "같은 글, 다른 번호"가 생긴다.
  candidate_hash text primary key,

  -- 어느 연구에서 나왔는지. 글 안에도 같은 값이 있다.
  -- 밖에 한 번 더 두는 이유는 연구 보관소와 이어 두기 위해서다.
  -- 겹치는 것은 괜찮다. 어긋나는 것을 아래 조건이 막는다.
  research_result_hash text not null
    references private.research_result (result_hash)
    on delete restrict,

  -- 사람이 읽고 판단할 글 전체.
  candidate jsonb not null,

  created_at timestamptz not null default now(),

  -- 애플리케이션 계약의 CANDIDATE_HASH_FORMAT 과 같은 모양이다.
  constraint published_content_candidate_hash_format
    check (candidate_hash ~ '^pcand_[0-9a-f]{64}$'),

  -- 연구 결과 지문. RESEARCH_RESULT_HASH_FORMAT 과 같은 모양이다.
  constraint published_content_candidate_research_hash_format
    check (research_result_hash ~ '^rres_[0-9a-f]{64}$'),

  constraint published_content_candidate_is_object
    check (jsonb_typeof(candidate) = 'object'),
  constraint published_content_candidate_not_empty
    check (candidate <> '{}'::jsonb),

  -- 밖에 적은 연구 지문과 글 안의 것이 어긋난 상태를 만들 수 없다.
  --
  -- 키가 없는 경우를 함께 막는다.
  -- ->> 만 쓰면 키가 없을 때 NULL이 되고, NULL 비교는 조건을 통과시킨다.
  constraint published_content_candidate_research_hash_matches
    check (
      jsonb_exists(candidate, 'researchResultHash')
      and candidate ->> 'researchResultHash' = research_result_hash
    )
);

comment on table private.published_content_candidate is
  '사람이 읽고 판단할 글 한 건. 글의 지문이 줄의 이름이다. 새로 적기만 하고 고치거나 지우지 않는다.';

create trigger published_content_candidate_reject_mutation
before update or delete on private.published_content_candidate
for each statement
execute function private.reject_published_content_mutation();

create trigger published_content_candidate_reject_truncate
before truncate on private.published_content_candidate
for each statement
execute function private.reject_published_content_mutation();

alter table private.published_content_candidate enable row level security;
revoke all on table private.published_content_candidate from public;
revoke all on table private.published_content_candidate from anon, authenticated, service_role;

------------------------------------------------------------------
-- 2. 검토자 명단
------------------------------------------------------------------

create table private.published_content_reviewer (
  -- 인증이 아는 그 사람의 번호. auth.uid()가 돌려주는 값과 같다.
  --
  -- auth.users 를 가리키지 않는다.
  -- 사람이 탈퇴해도 "누가 승인했는가"는 남아야 하고,
  -- 이름이나 메일 주소를 여기 베껴 두지 않기 위해서다.
  user_id uuid primary key,

  -- 기본은 꺼짐이다. 줄을 만드는 것만으로 권한이 생기지 않는다.
  is_active boolean not null default false,

  created_at timestamptz not null default now()
);

comment on table private.published_content_reviewer is
  '누가 게시 콘텐츠를 검토할 수 있는지. 이 표만 고칠 수 있다. 사람을 넣는 일은 따로 승인받는다.';

-- 이 표에는 고쳐 쓰기를 막는 방아쇠를 걸지 않는다.
-- 권한을 주고 거두는 일이 있어야 하기 때문이다.
alter table private.published_content_reviewer enable row level security;
revoke all on table private.published_content_reviewer from public;
revoke all on table private.published_content_reviewer from anon, authenticated, service_role;

------------------------------------------------------------------
-- 3. 사람이 내린 결정
------------------------------------------------------------------

create table private.published_content_review (
  review_id uuid primary key default gen_random_uuid(),

  -- 한 글에 최종 결정은 하나뿐이다.
  -- 반려된 글을 나중에 승인으로 바꿀 수 없다. 고치려면 새 글이 된다.
  candidate_hash text not null unique
    references private.published_content_candidate (candidate_hash)
    on delete restrict,

  -- 누가 판단했는지. 나중에 물을 수 있어야 한다.
  -- 이 값은 게시된 글 안으로 들어가지 않는다.
  reviewer_user_id uuid not null,

  -- 서버가 구성한 결정 기록. 부르는 쪽이 통째로 보내지 않는다.
  review jsonb not null,

  created_at timestamptz not null default now(),

  constraint published_content_review_is_object
    check (jsonb_typeof(review) = 'object'),
  constraint published_content_review_not_empty
    check (review <> '{}'::jsonb),

  -- 결정이 다른 글을 가리키는 상태를 만들 수 없다.
  constraint published_content_review_hash_matches
    check (
      jsonb_exists(review, 'candidateHash')
      and review ->> 'candidateHash' = candidate_hash
    ),

  -- 사람이 아닌 자격으로 적힌 결정이 남을 수 없다.
  constraint published_content_review_human_authority
    check (
      jsonb_exists(review, 'reviewAuthority')
      and review ->> 'reviewAuthority' = 'human'
    )
);

comment on table private.published_content_review is
  '사람이 내린 결정 한 건. 한 글에 하나뿐이고 고치거나 지울 수 없다. 누가 판단했는지는 여기에만 남는다.';

create trigger published_content_review_reject_mutation
before update or delete on private.published_content_review
for each statement
execute function private.reject_published_content_mutation();

create trigger published_content_review_reject_truncate
before truncate on private.published_content_review
for each statement
execute function private.reject_published_content_mutation();

alter table private.published_content_review enable row level security;
revoke all on table private.published_content_review from public;
revoke all on table private.published_content_review from anon, authenticated, service_role;

------------------------------------------------------------------
-- 4. 승인된 글
------------------------------------------------------------------

create table private.published_content (
  -- 글의 지문이 곧 이름이다. 같은 글이 두 번 게시되지 않는다.
  candidate_hash text primary key
    references private.published_content_candidate (candidate_hash)
    on delete restrict,

  content jsonb not null,

  created_at timestamptz not null default now(),

  constraint published_content_is_object
    check (jsonb_typeof(content) = 'object'),
  constraint published_content_not_empty
    check (content <> '{}'::jsonb),

  constraint published_content_hash_matches
    check (
      jsonb_exists(content, 'candidateHash')
      and content ->> 'candidateHash' = candidate_hash
    )
);

-- 진행 상태 칸이 없다. 줄이 있다는 것이 곧 승인됐다는 뜻이다.
-- 검토자 번호도 없다. 그것은 결정 기록의 것이다.
comment on table private.published_content is
  '사람이 승인한 글. 줄이 있다는 것 자체가 승인됐다는 뜻이다. 진행 상태 칸과 검토자 정보를 담지 않는다.';

create trigger published_content_reject_mutation
before update or delete on private.published_content
for each statement
execute function private.reject_published_content_mutation();

create trigger published_content_reject_truncate
before truncate on private.published_content
for each statement
execute function private.reject_published_content_mutation();

alter table private.published_content enable row level security;
revoke all on table private.published_content from public;
revoke all on table private.published_content from anon, authenticated, service_role;

------------------------------------------------------------------
-- 게시되는 글이 승인된 그 글인지 확인
------------------------------------------------------------------

-- 표에 직접 쓸 수 있는 길은 이미 막혀 있다.
-- 이 방아쇠는 그 위에 한 겹 더 두는 것이다.
--
-- 세 가지를 본다.
--   승인된 결정이 있는가
--   글의 지문이 줄의 이름과 같은가
--   내용이 적혀 있는 그 글과 글자 하나까지 같은가
--
-- 마지막이 중요하다.
-- 게시 콘텐츠는 검토 대상 글에 지문 하나를 더한 것이다. 그것뿐이다.
-- 그래서 지문을 떼어 낸 나머지가 적혀 있는 글과 같은지만 보면 된다.
-- 항목 이름을 여기에 하나도 나열하지 않는다. 나열하면 계약이 바뀔 때 여기가 뒤처진다.
create or replace function private.check_published_content_integrity()
returns trigger
language plpgsql
as $$
declare
  v_candidate jsonb;
  v_decision text;
begin
  select candidate into v_candidate
    from private.published_content_candidate
   where candidate_hash = new.candidate_hash;

  if v_candidate is null then
    raise exception '게시할 수 있는 글이 아닙니다.'
      using errcode = 'foreign_key_violation';
  end if;

  select review ->> 'decision' into v_decision
    from private.published_content_review
   where candidate_hash = new.candidate_hash;

  if v_decision is distinct from 'approve' then
    raise exception '승인된 글이 아닙니다.'
      using errcode = 'restrict_violation';
  end if;

  -- 지문을 떼어 낸 나머지가 적혀 있는 글과 같아야 한다.
  if (new.content - 'candidateHash') <> v_candidate then
    raise exception '승인된 글과 다른 내용입니다.'
      using errcode = 'restrict_violation';
  end if;

  return new;
end;
$$;

comment on function private.check_published_content_integrity() is
  '게시되는 글이 승인된 그 글과 같은지 확인한다. 항목 이름을 나열하지 않고 지문을 뺀 나머지를 통째로 비교한다.';

create trigger published_content_integrity
before insert on private.published_content
for each row
execute function private.check_published_content_integrity();

------------------------------------------------------------------
-- 검토 대상 글 적어 두기
------------------------------------------------------------------

-- 서버가 부른다. 아직 승인이 아니기 때문이다.
--
-- 지문을 여기서 다시 계산하지 않는다. 그 주인은 애플리케이션 계약이다.
-- 여기가 보는 것은 모양과 겹침과 이음뿐이다.
create or replace function public.store_published_content_candidate(
  p_candidate_hash text,
  p_research_result_hash text,
  p_candidate jsonb
)
returns text
language plpgsql
security definer
set search_path = private, pg_catalog
as $$
declare
  v_candidate_hash text;
  v_existing_research_hash text;
  v_existing_candidate jsonb;
begin
  insert into private.published_content_candidate (
    candidate_hash,
    research_result_hash,
    candidate
  ) values (
    p_candidate_hash,
    p_research_result_hash,
    p_candidate
  )
  on conflict (candidate_hash) do nothing
  returning candidate_hash into v_candidate_hash;

  -- 처음 적힌 경우.
  if v_candidate_hash is not null then
    return v_candidate_hash;
  end if;

  -- 같은 지문이 이미 있다. 다시 보낸 것인지 확인한다.
  select candidate_hash, research_result_hash, candidate
    into v_candidate_hash, v_existing_research_hash, v_existing_candidate
    from private.published_content_candidate
   where candidate_hash = p_candidate_hash;

  if v_candidate_hash is null then
    raise exception '글을 적지 못했습니다.'
      using errcode = 'internal_error';
  end if;

  if v_existing_research_hash = p_research_result_hash
     and v_existing_candidate = p_candidate then
    return v_candidate_hash;
  end if;

  -- 지문은 같은데 내용이 다르다. 덮어쓰지 않고 멈춘다.
  raise exception '같은 지문으로 다른 글이 들어왔습니다.'
    using errcode = 'unique_violation';
end;
$$;

comment on function public.store_published_content_candidate(text, text, jsonb) is
  '검토 대상 글 한 건을 적고 지문을 돌려준다. 같은 지문에 같은 내용이면 다시 적지 않는다. 다른 내용이면 거절한다.';

revoke all on function public.store_published_content_candidate(text, text, jsonb) from public;
revoke all on function public.store_published_content_candidate(text, text, jsonb)
  from anon, authenticated, service_role;
grant execute on function public.store_published_content_candidate(text, text, jsonb) to service_role;

------------------------------------------------------------------
-- 사람의 검토
------------------------------------------------------------------

-- 로그인한 사람 중 명단에 있는 사람만 부를 수 있다.
-- 서버 열쇠로는 부를 수 없다.
--
-- 받는 값에 검토자 번호와 자격이 없다. 그 둘은 서버가 정한다.
-- 글도 받지 않는다. 이미 적혀 있는 것을 쓴다.
-- 승인하는 순간에 글을 다시 받으면, 사람이 읽은 글과 승인된 글이 달라질 수 있다.
--
-- 승인이면 게시까지 이 안에서 끝낸다. 함수 한 번의 호출이 곧 하나의 묶음이다.
-- 게시가 실패하면 결정도 함께 없던 일이 된다.
-- "승인은 됐는데 글이 없다"는 상태를 만들지 않는다.
create or replace function public.review_published_content_candidate(
  p_candidate_hash text,
  p_decision text,
  p_checklist jsonb,
  p_rejection_reasons text[]
)
returns uuid
language plpgsql
security definer
set search_path = private, pg_catalog
as $$
declare
  -- 아래 세 목록의 주인은 published-content-contract.ts 다.
  -- 여기 적힌 것은 보안을 위한 사본이고, migration 계약 테스트가 둘을 대조한다.
  v_allowed_decisions constant text[] := array[
    'approve',
    'reject'
  ];
  v_required_checklist_keys constant text[] := array[
    'researchTraceability',
    'canonicalContext',
    'theologicalFaithfulness',
    'pastoralSafety',
    'misuseGuardsAdequate',
    'userFacingClarity',
    'taggingFit'
  ];
  v_allowed_rejection_reasons constant text[] := array[
    'insufficient_research_support',
    'passage_context_problem',
    'theological_problem',
    'pastoral_safety_problem',
    'misuse_guard_problem',
    'user_facing_copy_problem',
    'tagging_problem',
    'needs_more_research'
  ];

  v_reviewer_user_id uuid;
  v_reasons text[];
  v_key text;
  v_reason text;
  v_candidate jsonb;
  v_review jsonb;
  v_review_id uuid;
  v_existing_reviewer uuid;
  v_existing_review jsonb;
  v_published_content jsonb;
begin
  ----------------------------------------------------------------
  -- 누가 부르고 있는가
  ----------------------------------------------------------------

  -- 요청에서 받지 않는다. 인증이 아는 값을 읽는다.
  v_reviewer_user_id := auth.uid();

  if v_reviewer_user_id is null then
    raise exception '검토할 수 없습니다.'
      using errcode = 'insufficient_privilege';
  end if;

  -- 로그인했다는 것만으로는 부족하다. 명단에 있고 켜져 있어야 한다.
  -- 없으면 왜 없는지 알리지 않는다.
  if not exists (
    select 1
      from private.published_content_reviewer
     where user_id = v_reviewer_user_id
       and is_active
  ) then
    raise exception '검토할 수 없습니다.'
      using errcode = 'insufficient_privilege';
  end if;

  ----------------------------------------------------------------
  -- 보낸 값이 받을 수 있는 모양인가
  ----------------------------------------------------------------

  if p_candidate_hash is null or p_candidate_hash !~ '^pcand_[0-9a-f]{64}$' then
    raise exception '검토 요청이 올바르지 않습니다.'
      using errcode = 'invalid_parameter_value';
  end if;

  if p_decision is null or not (p_decision = any (v_allowed_decisions)) then
    raise exception '검토 요청이 올바르지 않습니다.'
      using errcode = 'invalid_parameter_value';
  end if;

  if p_checklist is null or jsonb_typeof(p_checklist) <> 'object' then
    raise exception '검토 요청이 올바르지 않습니다.'
      using errcode = 'invalid_parameter_value';
  end if;

  -- 있어야 할 항목이 모두 있고, 값이 참/거짓이어야 한다.
  foreach v_key in array v_required_checklist_keys loop
    if not jsonb_exists(p_checklist, v_key)
       or jsonb_typeof(p_checklist -> v_key) <> 'boolean' then
      raise exception '검토 요청이 올바르지 않습니다.'
        using errcode = 'invalid_parameter_value';
    end if;
  end loop;

  -- 모르는 항목이 섞여 있으면 받지 않는다.
  if (select count(*) from jsonb_object_keys(p_checklist)) <> array_length(v_required_checklist_keys, 1) then
    raise exception '검토 요청이 올바르지 않습니다.'
      using errcode = 'invalid_parameter_value';
  end if;

  -- 목록을 주지 않은 것과 빈 목록을 같게 본다.
  v_reasons := coalesce(p_rejection_reasons, array[]::text[]);

  foreach v_reason in array v_reasons loop
    if not (v_reason = any (v_allowed_rejection_reasons)) then
      raise exception '검토 요청이 올바르지 않습니다.'
        using errcode = 'invalid_parameter_value';
    end if;
  end loop;

  if p_decision = 'approve' then
    -- 승인은 일곱 항목이 모두 참일 때만 성립한다.
    foreach v_key in array v_required_checklist_keys loop
      if (p_checklist -> v_key) <> 'true'::jsonb then
        raise exception '검토 요청이 올바르지 않습니다.'
          using errcode = 'invalid_parameter_value';
      end if;
    end loop;

    -- 승인인데 반려 이유가 적혀 있으면 받지 않는다.
    if array_length(v_reasons, 1) is not null then
      raise exception '검토 요청이 올바르지 않습니다.'
        using errcode = 'invalid_parameter_value';
    end if;
  end if;

  if p_decision = 'reject' and array_length(v_reasons, 1) is null then
    raise exception '검토 요청이 올바르지 않습니다.'
      using errcode = 'invalid_parameter_value';
  end if;

  ----------------------------------------------------------------
  -- 무엇을 검토하는가
  ----------------------------------------------------------------

  select candidate into v_candidate
    from private.published_content_candidate
   where candidate_hash = p_candidate_hash;

  if v_candidate is null then
    raise exception '검토할 글이 없습니다.'
      using errcode = 'no_data_found';
  end if;

  -- 결정 기록은 서버가 만든다. 부르는 쪽이 통째로 보내지 않는다.
  -- 자격은 명단을 통과한 뒤 여기서 붙인다. 선언해서 얻는 것이 아니다.
  v_review := jsonb_build_object(
    'candidateHash', p_candidate_hash,
    'reviewAuthority', 'human',
    'decision', p_decision,
    'checklist', p_checklist,
    'rejectionReasons', to_jsonb(v_reasons)
  );

  ----------------------------------------------------------------
  -- 이미 결정이 있는가
  ----------------------------------------------------------------

  select review_id, reviewer_user_id, review
    into v_review_id, v_existing_reviewer, v_existing_review
    from private.published_content_review
   where candidate_hash = p_candidate_hash;

  if v_review_id is not null then
    -- 같은 사람이 같은 결정을 다시 보낸 경우에만 원래 번호를 준다.
    -- 남의 결정을 자기 것으로 성공 처리하지 않는다.
    if v_existing_reviewer <> v_reviewer_user_id or v_existing_review <> v_review then
      raise exception '이미 결정된 글입니다.'
        using errcode = 'unique_violation';
    end if;

    -- 다시 보낸 요청이라도 앞의 결과가 온전한지 확인한다.
    -- 어긋나 있으면 조용히 고치지 않는다. 멈추고 알린다.
    if p_decision = 'approve' then
      select content into v_published_content
        from private.published_content
       where candidate_hash = p_candidate_hash;

      if v_published_content is null
         or (v_published_content - 'candidateHash') <> v_candidate then
        raise exception '이미 결정된 글입니다.'
          using errcode = 'internal_error';
      end if;
    else
      if exists (
        select 1 from private.published_content where candidate_hash = p_candidate_hash
      ) then
        raise exception '이미 결정된 글입니다.'
          using errcode = 'internal_error';
      end if;
    end if;

    return v_review_id;
  end if;

  ----------------------------------------------------------------
  -- 적는다
  ----------------------------------------------------------------

  insert into private.published_content_review (
    candidate_hash,
    reviewer_user_id,
    review
  ) values (
    p_candidate_hash,
    v_reviewer_user_id,
    v_review
  )
  returning review_id into v_review_id;

  -- 승인이면 같은 묶음 안에서 게시까지 끝낸다.
  --
  -- 게시할 글은 적혀 있는 것에서 만든다. 부르는 쪽이 보낸 것에서 만들지 않는다.
  -- 게시 콘텐츠는 검토 대상 글에 지문 하나를 더한 것이다. 그래서 합치기만 하면 된다.
  -- 항목 이름을 나열하지 않는다.
  if p_decision = 'approve' then
    insert into private.published_content (candidate_hash, content)
    values (
      p_candidate_hash,
      v_candidate || jsonb_build_object('candidateHash', p_candidate_hash)
    );
  end if;

  return v_review_id;
end;
$$;

comment on function public.review_published_content_candidate(text, text, jsonb, text[]) is
  '사람이 검토 대상 글 한 건을 최종 판단한다. 검토자는 auth.uid()로 읽고 명단에서 확인한다. 승인이면 같은 묶음에서 게시까지 끝낸다.';

revoke all on function public.review_published_content_candidate(text, text, jsonb, text[]) from public;
revoke all on function public.review_published_content_candidate(text, text, jsonb, text[])
  from anon, authenticated, service_role;
grant execute on function public.review_published_content_candidate(text, text, jsonb, text[]) to authenticated;
