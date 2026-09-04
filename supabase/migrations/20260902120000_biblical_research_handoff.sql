-- 아뢰다 · 연구 근거 꾸러미 보관소
--
-- 무엇을 위한 것인가
--   Source Harvester가 자료를 다 모으고 나면, 그 근거 꾸러미는 지금 HTTP 응답으로
--   나가고 그대로 사라진다. 서버에는 아무것도 남지 않는다.
--
--   그래서 다음 단계인 Biblical Researcher가 "이 꾸러미로 연구해 주십시오"라는
--   요청을 받으면, 그 꾸러미가 실제 수집에서 나온 것인지 확인할 방법이 없다.
--   부르는 쪽이 자료 목록과 근거 문장을 통째로 지어내도 서버는 알 수 없다.
--
--   이 표는 그 원본을 서버가 갖고 있게 한다.
--
-- 왜 지문만으로는 안 되는가
--   꾸러미에는 그 내용으로 계산한 지문이 함께 들어 있다.
--   하지만 그 지문은 넘겨받은 내용으로 다시 계산해서 맞춰 보는 값이다.
--   내용을 지어내면 지어낸 내용의 지문이 나오고, 그대로 맞는다.
--   지문은 "내용이 바뀌지 않았다"를 말하지 "어디서 왔다"를 말하지 않는다.
--
-- 왜 꾸러미 전체를 담는가
--   지문만 담으면 부르는 쪽이 여전히 꾸러미를 함께 보내야 한다.
--   그러면 지어낼 수 있는 자리가 그대로 남는다.
--
--   꾸러미 전체를 서버가 들고 있으면, 부르는 쪽이 보내는 것은 번호 하나뿐이다.
--   보낼 것이 번호밖에 없으면 지어낼 것도 없다.
--
-- 수명
--   30분. 앞의 두 보관소와 같다.
--   쓰이는 순간 그 줄은 사라진다. 지우면서 꺼낸다.
--   상태 칸이 없다. 줄이 있으면 아직 안 쓴 것이고, 없으면 쓸 수 없는 것이다.
--
-- 이 표가 아는 것과 모르는 것
--   담는 것은 꾸러미 하나와, 그때 카드가 다루던 영역 목록의 지문 하나다.
--
--   영역 이름, 근거 판본, 판단 시점, 꾸러미 지문은 따로 칸을 두지 않는다.
--   그 값들은 이미 꾸러미 안에 있다. 밖에 한 번 더 적으면 주인이 둘이 되고,
--   언젠가 둘이 서로 달라진다.
--
--   활성 영역 지문만 밖에 둔다. 꾸러미 안에 없는 값이고,
--   꺼낼 때 그 자리에서 대조해야 하는 값이기 때문이다.
--
-- 담지 않는 것
--   사용자의 상황 문장, 사용자 id, 세션·기기 정보, 토큰,
--   OpenAI 원본 응답, 웹페이지 내용.
--   앞 단계의 번호도 담지 않는다. 보관소끼리 서로를 가리키지 않는다.
--
-- 이 표가 하지 않는 일
--   꾸러미 안을 들여다보지 않는다. 자료 수를 세지 않고, 근거를 검사하지 않고,
--   지문을 다시 계산하지 않는다.
--   그 판단은 이미 애플리케이션이 했다. 여기서 다시 하면 규칙의 주인이 둘이 된다.
--   DB가 맡는 일은 "검증을 마친 꾸러미를 30분간 서버 전용으로 보관하는 것"뿐이다.
--
-- 이 migration은 아직 서버에 적용하지 않았다.
-- 이 표를 읽거나 쓰는 실행 코드도 아직 없다.

-- private 스키마는 이미 있고 권한이 회수돼 있다. 없을 때만 만든다.
create schema if not exists private;

revoke all on schema private from public;
revoke all on schema private from anon, authenticated, service_role;

create table private.biblical_research_handoff (
  -- 줄의 이름은 서버가 만든 번호다. 부르는 쪽이 정하지 못한다.
  --
  -- 같은 꾸러미로 두 번 적으면 서로 다른 번호가 나온다.
  -- 번호 하나가 곧 한 번의 권한이고, 그 권한은 각자 따로 소비된다.
  handoff_id uuid primary key default gen_random_uuid(),

  created_at timestamptz not null default now(),
  -- 서버가 정한다. 부르는 쪽이 수명을 늘릴 수 없다.
  expires_at timestamptz not null,

  -- 꾸러미를 만들 때 카드가 다루던 영역 목록의 지문.
  -- 그 사이에 카드가 늘었다면 이 연구는 더 이상 맞지 않는다.
  --
  -- 이 값은 꾸러미 안에 없다. 꺼낼 때 대조해야 해서 밖에 따로 둔다.
  -- 지문 자체는 애플리케이션이 계산한다. 여기서 만들지 않는다.
  active_covered_hash text not null,

  -- 검증을 마친 근거 꾸러미 전체.
  -- 여기 담긴 것을 그대로 꺼내 쓴다. 부르는 쪽이 다시 보내지 않는다.
  handoff_payload jsonb not null,

  constraint biblical_research_handoff_expires_after_created
    check (expires_at > created_at),
  -- 앞의 두 보관소가 같은 값에 쓰는 조건과 같다. 새 형식을 만들지 않았다.
  constraint biblical_research_handoff_covered_hash_format
    check (active_covered_hash ~ '^[0-9a-f]{64}$')
);

comment on table private.biblical_research_handoff is
  '수집이 끝난 연구 근거 꾸러미를 최대 30분간 보관한다. Biblical Researcher가 번호 하나로 꺼내 쓰고, 꺼내는 순간 줄이 사라진다. 사용자 정보는 담지 않는다.';

-- 만료된 줄을 치울 때 쓴다.
create index biblical_research_handoff_expires_at_idx
  on private.biblical_research_handoff (expires_at);

-- 이 표는 아래 두 함수로만 접근한다.
alter table private.biblical_research_handoff enable row level security;
revoke all on table private.biblical_research_handoff from public;
revoke all on table private.biblical_research_handoff from anon, authenticated, service_role;

------------------------------------------------------------------
-- 꾸러미 적어 두기
------------------------------------------------------------------

create or replace function public.create_biblical_research_handoff(
  p_handoff jsonb,
  p_active_covered_hash text
)
returns uuid
language plpgsql
security definer
set search_path = private, pg_catalog
as $$
declare
  v_handoff_id uuid;
begin
  -- 지나간 꾸러미를 먼저 치운다. 이것 때문에 따로 도는 작업을 두지 않는다.
  delete from private.biblical_research_handoff
   where expires_at <= now();

  -- 받는 값은 둘뿐이다. 꾸러미 안의 값을 따로 받지 않는다.
  -- 따로 받으면 꾸러미와 어긋난 값이 들어올 수 있다.
  --
  -- 꾸러미 안을 들여다보지 않는다. 빈 값과 지문의 모양은 칸의 조건이 막는다.
  insert into private.biblical_research_handoff (
    expires_at,
    active_covered_hash,
    handoff_payload
  ) values (
    -- 수명은 서버가 정한다. 인자로 받지 않는다.
    now() + interval '30 minutes',
    p_active_covered_hash,
    p_handoff
  )
  returning handoff_id into v_handoff_id;

  -- 부르는 쪽에는 번호만 돌려준다. 꾸러미는 돌려주지 않는다.
  return v_handoff_id;
end;
$$;

comment on function public.create_biblical_research_handoff(jsonb, text) is
  '검증을 마친 근거 꾸러미 한 건을 적고 번호만 돌려준다. 번호는 서버가 만든다. 수명 30분은 서버가 정한다. 부를 때마다 새 줄이 생긴다.';

revoke all on function public.create_biblical_research_handoff(jsonb, text) from public;
revoke all on function public.create_biblical_research_handoff(jsonb, text)
  from anon, authenticated, service_role;
grant execute on function public.create_biblical_research_handoff(jsonb, text) to service_role;

------------------------------------------------------------------
-- 꾸러미 꺼내 쓰기 (한 번만)
------------------------------------------------------------------

create or replace function public.consume_biblical_research_handoff(
  p_handoff_id uuid,
  p_current_active_covered_hash text
)
returns jsonb
language plpgsql
security definer
set search_path = private, pg_catalog
as $$
declare
  v_handoff_payload jsonb;
begin
  delete from private.biblical_research_handoff
   where expires_at <= now();

  -- 지우면서 동시에 꺼낸다.
  --
  -- 지금 카드가 다루는 영역이 그때와 같아야 한다.
  -- 그 대조를 꺼낸 뒤에 하지 않고 지우는 조건에 함께 넣는다.
  -- 그래야 어긋났을 때 아무 줄도 지워지지 않고, 멀쩡한 꾸러미가 헛되이 타지 않는다.
  --
  -- 같은 번호로 두 번 부르면 두 번째는 지울 줄이 없다.
  -- 두 요청이 동시에 와도 한쪽만 줄을 가져간다.
  delete from private.biblical_research_handoff h
   where h.handoff_id = p_handoff_id
     and h.expires_at > now()
     and h.active_covered_hash = p_current_active_covered_hash
  returning h.handoff_payload into v_handoff_payload;

  -- 없는 번호, 만료된 꾸러미, 이미 쓴 꾸러미, 영역이 달라진 경우.
  -- 넷 다 빈 값이다. 어느 쪽인지 밖에서 구분할 수 없다.
  return v_handoff_payload;
end;
$$;

comment on function public.consume_biblical_research_handoff(uuid, text) is
  '번호가 맞고 아직 만료되지 않았으며 활성 영역이 그때와 같은 꾸러미를 지우면서 꺼낸다. 하나라도 어긋나면 아무것도 지우지 않고 빈 값이다. 왜 못 꺼냈는지는 알려주지 않는다.';

revoke all on function public.consume_biblical_research_handoff(uuid, text) from public;
revoke all on function public.consume_biblical_research_handoff(uuid, text)
  from anon, authenticated, service_role;
grant execute on function public.consume_biblical_research_handoff(uuid, text) to service_role;
