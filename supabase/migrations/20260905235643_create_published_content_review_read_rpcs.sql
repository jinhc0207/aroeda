-- 아뢰다 · 검토자가 글을 읽는 두 가지 길
--
-- 앞 단계에서 "사람이 승인해야만 글이 게시된다"는 쓰기 경계를 만들었다.
-- 그런데 사람이 판단하려면 먼저 읽을 수 있어야 한다.
--
-- 지금은 읽을 길이 없다. 표는 어느 역할에도 직접 권한을 주지 않았기 때문이다.
-- 그래서 여기서 읽기 함수 둘을 만든다. 표는 계속 닫아 둔다.
--
--   1. 무엇을 검토할지 고르는 목록
--   2. 한 건을 실제로 판단하기 위한 꾸러미
--
-- 두 함수 모두 승인과 같은 신분 경계를 쓴다.
--   로그인한 사람이어야 하고, 검토자 명단에 있고 켜져 있어야 한다.
--   서버 열쇠로는 부를 수 없다.
--
-- 읽기가 더 느슨하면 아직 사람이 보지 않은 글이 밖으로 나가는 길이 생긴다.
--
-- 이 함수들은 아무것도 고치지 않는다. 붙잡아 두지도 않는다.
-- 꾸러미를 읽었다고 그 글이 그 사람 것이 되지 않는다.
-- 두 사람이 같은 글을 열 수 있고, 최종 판단은 승인 함수의 "한 글 한 결정" 규칙이 정한다.
--
-- 지문을 여기서 다시 계산하지 않는다. 그 주인은 애플리케이션 계약이다.
-- 여기가 하는 일은 적혀 있는 줄을 정확히 모아 주는 것뿐이고,
-- 내용이 서로 맞는지 보는 일은 받는 쪽의 검사기가 한다.
--
-- 아직 적용하지 않았다. 적용 시점은 사용자가 정한다.

------------------------------------------------------------------
-- 1. 검토할 글 목록
------------------------------------------------------------------

-- create or replace를 쓰지 않는다.
-- 같은 이름의 함수가 이미 있으면 조용히 덮어쓰지 말고 여기서 실패해야 한다.
--
-- 인자를 받지 않는다.
-- 몇 건을 볼지도 부르는 쪽이 정하지 않는다. 한 번에 50건이다.
--
-- "아직 결정이 없다"를 진행 상태 칸으로 두지 않는다.
-- 칸을 만들면 그 값과 실제가 어긋날 수 있다.
-- 결정 표에 그 지문의 줄이 없으면 아직 결정이 없는 것이다.
--
-- 결정의 내용(승인/반려)을 보지 않는다. 줄이 있다는 것 자체가 끝났다는 뜻이다.
create function public.list_published_content_review_queue()
returns jsonb
language plpgsql
security definer
stable
set search_path = private, pg_catalog
as $$
declare
  v_reviewer_user_id uuid;
  v_queue jsonb;
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
  -- 무엇이 남아 있는가
  ----------------------------------------------------------------

  -- 자격을 확인한 뒤에야 글을 찾는다.
  -- 순서를 바꾸면 명단에 없는 사람이 오류의 종류로
  -- "그 지문의 글이 있는가"를 알아낼 수 있다.
  --
  -- 안쪽에서 먼저 오래된 순으로 50건을 고르고, 바깥에서 그 순서대로 묶는다.
  -- 전부 묶은 뒤에 자르면 50건이라는 약속이 의미를 잃는다.
  --
  -- 같은 시각의 글이 있을 수 있어서 지문을 두 번째 기준으로 둔다.
  -- 두 번째 기준이 없으면 부를 때마다 순서가 달라질 수 있다.
  select coalesce(
           jsonb_agg(q.item order by q.created_at asc, q.candidate_hash asc),
           '[]'::jsonb
         )
    into v_queue
    from (
      select
        c.created_at,
        c.candidate_hash,
        -- 고르는 데 필요한 것만 담는다. 연구 근거는 꾸러미의 몫이다.
        -- 두 지문은 글 안의 값이 아니라 표의 칸에서 가져온다. 표의 칸이 주인이다.
        -- 본문 위치는 객체다. ->> 를 쓰면 글자로 바뀌어 받는 쪽 검사기가 막는다.
        jsonb_build_object(
          'candidateHash', c.candidate_hash,
          'researchResultHash', c.research_result_hash,
          'targetDomain', c.candidate ->> 'targetDomain',
          'referenceLabel', c.candidate ->> 'referenceLabel',
          'passage', c.candidate -> 'passage',
          'candidateCreatedAt', c.created_at
        ) as item
        from private.published_content_candidate c
       where not exists (
         select 1
           from private.published_content_review r
          where r.candidate_hash = c.candidate_hash
       )
       order by c.created_at asc, c.candidate_hash asc
       limit 50
    ) q;

  -- 남은 글이 없으면 빈 목록이다. 없음(null)과 빈 목록은 다르다.
  return v_queue;
end;
$$;

comment on function public.list_published_content_review_queue() is
  '명단에 있는 검토자에게 아직 결정이 없는 글을 오래된 순으로 최대 50건 보여준다. 고르는 데 필요한 값만 담고 연구 근거는 담지 않는다.';

revoke all on function public.list_published_content_review_queue() from public;
revoke all on function public.list_published_content_review_queue()
  from anon, authenticated, service_role;
grant execute on function public.list_published_content_review_queue() to authenticated;

------------------------------------------------------------------
-- 2. 한 건을 판단하기 위한 꾸러미
------------------------------------------------------------------

-- 받는 값은 글의 지문 하나뿐이다.
--
-- 글 본문을 받지 않는다. 이미 적혀 있는 것을 쓴다.
-- 연구 지문도 받지 않는다. 그것은 글이 적힐 때 표에 이어 둔 값이다.
-- 검토자 번호도 받지 않는다. 인증이 아는 값을 읽는다.
--
-- 지문의 모양을 여기서 다시 확인하지 않는다.
-- 그 규칙의 주인은 애플리케이션 계약이고 글 표의 조건에도 이미 있다.
-- 여기에 세 번째 사본을 두면 언젠가 서로 달라진다.
-- 모양이 틀린 값은 찾지 못하고 끝나며, 없는 글과 같은 답이 된다.
--
-- 이미 결정이 난 글에는 꾸러미를 주지 않는다.
-- 지금 목적은 새로 검토하는 것이지 지난 결정을 들여다보는 것이 아니다.
-- 승인이었는지 반려였는지도 알려주지 않는다.
create function public.get_published_content_review_packet(
  p_candidate_hash text
)
returns jsonb
language plpgsql
security definer
stable
set search_path = private, pg_catalog
as $$
declare
  v_reviewer_user_id uuid;
  v_packet jsonb;
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
  -- 무엇을 판단하는가
  ----------------------------------------------------------------

  -- 자격을 확인한 뒤에야 글을 찾는다.
  --
  -- 연구는 표의 칸으로 잇는다. 글 안에 적힌 연구 지문으로 잇지 않는다.
  -- 두 값이 어긋날 수 없다는 조건이 표에 이미 있지만,
  -- 이을 때 기준으로 삼는 자리는 표의 칸 하나로 둔다.
  --
  -- 사람이 "연구까지 되짚을 수 있는가"를 판단하려면 자료와 근거를 보아야 한다.
  -- 그래서 근거 기록을 통째로 넘긴다. 이것은 검토자만 보는 것이고,
  -- 승인된 글에는 옮겨 적지 않는다.
  --
  -- 연구 줄의 내부 번호는 넘기지 않는다. 검토에 쓸 일이 없다.
  select jsonb_build_object(
           'candidateHash', c.candidate_hash,
           'candidate', c.candidate,
           'candidateCreatedAt', c.created_at,
           'researchResultHash', c.research_result_hash,
           'researchResult', rr.result,
           'researchProvenance', rr.provenance,
           'researchResultCreatedAt', rr.created_at
         )
    into v_packet
    from private.published_content_candidate c
    join private.research_result rr
      on rr.result_hash = c.research_result_hash
   where c.candidate_hash = p_candidate_hash
     and not exists (
       select 1
         from private.published_content_review r
        where r.candidate_hash = c.candidate_hash
     );

  -- 네 가지 경우가 여기서 하나로 모인다.
  --   글이 없다 / 이미 결정이 났다 / 연구가 남아 있지 않다 / 이음이 끊겼다
  --
  -- 어느 쪽인지 알려주지 않는다. 알려주면 그것으로 안을 짐작할 수 있다.
  if v_packet is null then
    raise exception '검토할 수 없습니다.'
      using errcode = 'no_data_found';
  end if;

  return v_packet;
end;
$$;

comment on function public.get_published_content_review_packet(text) is
  '명단에 있는 검토자에게 아직 결정이 없는 글 한 건과 그 연구·근거를 넘긴다. 지문을 다시 계산하지 않고 적혀 있는 줄만 모은다.';

revoke all on function public.get_published_content_review_packet(text) from public;
revoke all on function public.get_published_content_review_packet(text)
  from anon, authenticated, service_role;
grant execute on function public.get_published_content_review_packet(text) to authenticated;
