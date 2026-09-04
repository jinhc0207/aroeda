-- 아뢰다 · OpenAI 사용량 제한 (V1)
--
-- 목적: OpenAI 비용 악용 방지. 추천 품질이나 점수와는 아무 관계가 없다.
--
-- 원칙
--   * 횟수는 서버에서만 센다. 앱이 조작되어도 서버가 막는다.
--   * analyze-situation과 recommend-scripture가 같은 quota를 함께 쓴다.
--   * 사용자 상황 문장, 분석 결과, 태그, 카드, 기도 내용, 토큰, IP는 저장하지 않는다.
--   * 사용자당 상태 row 하나만 둔다. 요청마다 기록을 쌓지 않는다.
--
-- V1 기본값: 1시간에 10회, 24시간에 30회 (두 제한을 동시에 적용)
-- 이 숫자는 출시 전 실제 비용과 사용 패턴을 보고 조정한다.
-- 바꿀 때는 아래 두 상수(hour_limit, day_limit)만 고치면 된다.
--
-- 아직 실행하지 않았다. 적용 시점은 사용자가 정한다.

create schema if not exists private;

-- 이 스키마는 서버 전용이다. 클라이언트에게 접근 권한을 주지 않는다.
revoke all on schema private from anon, authenticated;

create table if not exists private.openai_rate_limit_state (
  user_id uuid primary key references auth.users (id) on delete cascade,
  hour_started_at timestamptz not null default now(),
  hour_count integer not null default 0,
  day_started_at timestamptz not null default now(),
  day_count integer not null default 0,
  updated_at timestamptz not null default now()
);

comment on table private.openai_rate_limit_state is
  '사용자별 OpenAI 호출 횟수 상태. 상황 문장이나 분석 결과는 저장하지 않는다.';

-- 클라이언트가 이 테이블을 직접 읽거나 쓰지 못하게 한다.
alter table private.openai_rate_limit_state enable row level security;
revoke all on table private.openai_rate_limit_state from anon, authenticated;
-- 정책을 하나도 만들지 않는다. 정책이 없으면 일반 사용자는 아무 행에도 접근할 수 없다.

-- 사용량을 한 번 소비한다.
--
-- user_id를 인자로 받지 않는다. 반드시 지금 로그인한 사용자(auth.uid())만 기준으로 한다.
-- 다른 사람의 UUID를 넘겨 quota를 소비하거나 조회할 수 없다.
--
-- SECURITY DEFINER인 이유: 위 테이블은 클라이언트 권한으로는 접근할 수 없기 때문에,
-- 이 함수만 소유자 권한으로 상태를 갱신한다. 대신 함수가 하는 일은 자기 자신의 카운트 증가뿐이다.
create or replace function public.consume_openai_quota()
returns jsonb
language plpgsql
security definer
set search_path = private, pg_catalog
as $$
declare
  hour_limit constant integer := 10;   -- 1시간 제한
  day_limit  constant integer := 30;   -- 24시간 제한
  uid uuid;
  now_ts timestamptz := now();
  state private.openai_rate_limit_state%rowtype;
  hour_start timestamptz;
  hour_used integer;
  day_start timestamptz;
  day_used integer;
  hour_blocked boolean := false;
  day_blocked boolean := false;
  hour_wait integer := 0;
  day_wait integer := 0;
  retry_after integer := 0;
  allowed boolean := false;
begin
  uid := auth.uid();

  if uid is null then
    -- 로그인하지 않은 요청은 사용량을 소비하지도, 통과시키지도 않는다.
    return jsonb_build_object('allowed', false, 'reason', 'no_user', 'retry_after_seconds', 0);
  end if;

  insert into private.openai_rate_limit_state as s (user_id, hour_started_at, day_started_at, updated_at)
  values (uid, now_ts, now_ts, now_ts)
  on conflict (user_id) do nothing;

  -- 같은 사용자의 동시 요청이 제한을 우회하지 못하도록 행을 잠근다.
  select * into state from private.openai_rate_limit_state where user_id = uid for update;

  -- 시간이 지난 window는 새로 시작한다.
  if now_ts >= state.hour_started_at + interval '1 hour' then
    hour_start := now_ts;
    hour_used := 0;
  else
    hour_start := state.hour_started_at;
    hour_used := state.hour_count;
  end if;

  if now_ts >= state.day_started_at + interval '24 hours' then
    day_start := now_ts;
    day_used := 0;
  else
    day_start := state.day_started_at;
    day_used := state.day_count;
  end if;

  -- 두 제한을 각각 확인한다.
  hour_blocked := hour_used >= hour_limit;
  day_blocked := day_used >= day_limit;

  if hour_blocked or day_blocked then
    allowed := false;

    -- Retry-After는 실제로 다시 요청이 허용되는 시점이어야 한다.
    -- 둘 다 막혀 있으면 두 대기시간 중 더 긴 쪽을 돌려준다.
    hour_wait := ceil(extract(epoch from (hour_start + interval '1 hour' - now_ts)))::integer;
    day_wait := ceil(extract(epoch from (day_start + interval '24 hours' - now_ts)))::integer;

    if hour_blocked then
      retry_after := greatest(retry_after, hour_wait);
    end if;

    if day_blocked then
      retry_after := greatest(retry_after, day_wait);
    end if;

    retry_after := greatest(1, retry_after);
  else
    allowed := true;
    hour_used := hour_used + 1;
    day_used := day_used + 1;
  end if;

  update private.openai_rate_limit_state
  set hour_started_at = hour_start,
      hour_count = hour_used,
      day_started_at = day_start,
      day_count = day_used,
      updated_at = now_ts
  where user_id = uid;

  return jsonb_build_object(
    'allowed', allowed,
    'retry_after_seconds', retry_after,
    'hour_remaining', greatest(0, hour_limit - hour_used),
    'day_remaining', greatest(0, day_limit - day_used)
  );
end;
$$;

comment on function public.consume_openai_quota() is
  'OpenAI 호출 전에 사용량을 한 번 소비한다. 현재 로그인한 사용자만 기준으로 하며 결과에 사용자 정보를 담지 않는다.';

-- 로그인한 사용자만 실행할 수 있다. 익명 방문자(anon)와 public에는 권한을 주지 않는다.
revoke all on function public.consume_openai_quota() from public, anon;
grant execute on function public.consume_openai_quota() to authenticated;
