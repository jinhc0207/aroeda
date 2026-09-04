-- 아뢰다 · Coverage Gap 통계 (v1)
--
-- 목적: 지금 카드로 다룰 수 없는 상황(no_coverage)이 어떤 영역에서 얼마나 발생하는지만 센다.
--       앞으로 어떤 Scripture Card를 먼저 만들지 정하기 위한 자료다.
--
-- 이것은 사용자 수 통계가 아니다. "그 영역에서 no_coverage가 발생한 횟수"다.
--
-- 저장하지 않는 것
--   * 사용자가 쓴 상황 문장
--   * 사용자 id, auth uid, 세션/기기 식별자, IP, JWT
--   * 감정·신앙질문·기도유형 태그, 카드 id, OpenAI 응답
--
-- 저장하는 것은 날짜, 영역 이름, 횟수, 처음/마지막 시각뿐이다.
--
-- 아직 실행하지 않았다. 적용 시점은 사용자가 정한다.

create schema if not exists private;

-- private 스키마에는 아무도 직접 들어올 수 없다. service_role도 예외가 아니다.
-- 통계 증가는 아래 SECURITY DEFINER 함수 실행으로만 한다.
revoke all on schema private from public;
revoke all on schema private from anon, authenticated, service_role;

-- if not exists를 쓰지 않는다.
-- 예상하지 못한 같은 이름의 표가 이미 있으면 조용히 넘어가지 말고 실패해야 한다.
create table private.coverage_gap_daily (
  -- Asia/Seoul 기준 날짜 (v1은 대한민국 운영 기준으로 고정한다)
  bucket_date date not null,
  primary_domain text not null,
  -- 실제 발생 횟수다. 함수가 항상 1부터 넣으므로 0이나 음수가 될 일이 없다.
  gap_count bigint not null,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  primary key (bucket_date, primary_domain),
  constraint coverage_gap_count_positive check (gap_count > 0),
  -- 지금 카드가 없는 영역 8개만 기록한다. 그 밖의 값은 DB가 거부한다.
  constraint coverage_gap_domain_allowed check (
    primary_domain in (
      'loneliness_isolation',
      'family_parenting_conflict',
      'burnout_exhaustion',
      'spiritual_dryness',
      'financial_hardship',
      'chronic_illness',
      'relationship_conflict_forgiveness',
      'other_uncovered'
    )
  )
);

comment on table private.coverage_gap_daily is
  '날짜·영역별 no_coverage 발생 횟수. 사용자 문장과 식별자는 저장하지 않는다.';

-- 앱 클라이언트가 이 표를 직접 읽거나 쓰지 못하게 한다.
alter table private.coverage_gap_daily enable row level security;
revoke all on table private.coverage_gap_daily from public;
revoke all on table private.coverage_gap_daily from anon, authenticated, service_role;
-- 정책을 하나도 만들지 않는다. 정책이 없으면 일반 사용자는 아무 행에도 접근할 수 없다.

-- no_coverage 한 건을 기록한다.
--
-- 사용자 id를 인자로 받지 않고, auth.uid()도 저장하지 않는다.
-- 서버(Edge Function)만 실행한다. 로그인한 앱 사용자는 실행할 수 없다.
--
-- SECURITY DEFINER인 이유: 위 표는 아무 역할에도 권한이 없으므로,
-- 이 함수만 소유자 권한으로 횟수를 올린다. 하는 일은 카운터 증가뿐이다.
-- create or replace를 쓰지 않는다.
-- 같은 이름의 함수가 이미 있으면 덮어쓰지 말고 실패해야 한다.
create function public.record_coverage_gap(p_primary_domain text)
returns boolean
language plpgsql
security definer
set search_path = private, pg_catalog
as $$
declare
  today date := (now() at time zone 'Asia/Seoul')::date;
begin
  -- 허용된 영역이 아니면 아무것도 기록하지 않는다. (DB 쪽 2차 방어)
  if p_primary_domain is null or p_primary_domain not in (
    'loneliness_isolation',
    'family_parenting_conflict',
    'burnout_exhaustion',
    'spiritual_dryness',
    'financial_hardship',
    'chronic_illness',
    'relationship_conflict_forgiveness',
    'other_uncovered'
  ) then
    return false;
  end if;

  -- 같은 날짜·같은 영역이면 원자적으로 1 올린다. 동시에 들어와도 횟수를 잃지 않는다.
  insert into private.coverage_gap_daily as c (
    bucket_date, primary_domain, gap_count, first_seen_at, last_seen_at
  )
  values (today, p_primary_domain, 1, now(), now())
  on conflict (bucket_date, primary_domain) do update
    set gap_count = c.gap_count + 1,
        last_seen_at = now();
  -- first_seen_at은 처음 값을 그대로 둔다.

  return true;
end;
$$;

comment on function public.record_coverage_gap(text) is
  '날짜·영역별 no_coverage 횟수를 1 올린다. 사용자 정보는 받지도 저장하지도 않는다.';

-- 서버만 실행할 수 있게 한다. 앱 사용자(anon/authenticated)에게는 권한을 주지 않는다.
revoke all on function public.record_coverage_gap(text) from public;
revoke all on function public.record_coverage_gap(text) from anon, authenticated, service_role;
grant execute on function public.record_coverage_gap(text) to service_role;
