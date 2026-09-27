-- 아뢰다 · 현재 카드 coverage와 Coverage Gap 기록 범위 정렬
--
-- 2026-09-15 카드 확장 뒤 17개 표준 영역에는 모두 카드가 3장씩 있다.
-- 기존 coverage_gap_daily의 7개 영역 행은 연구 이력으로 보존하고 CHECK 제약도 바꾸지 않는다.
-- 앞으로 새로 기록할 수 있는 실제 no_coverage 값만 other_uncovered로 좁힌다.

create or replace function public.record_coverage_gap(p_primary_domain text)
returns boolean
language plpgsql
security definer
set search_path = private, pg_catalog
as $$
declare
  today date := (now() at time zone 'Asia/Seoul')::date;
begin
  if p_primary_domain is distinct from 'other_uncovered' then
    return false;
  end if;

  insert into private.coverage_gap_daily as c (
    bucket_date, primary_domain, gap_count, first_seen_at, last_seen_at
  )
  values (today, p_primary_domain, 1, now(), now())
  on conflict (bucket_date, primary_domain) do update
    set gap_count = c.gap_count + 1,
        last_seen_at = now();

  return true;
end;
$$;

comment on function public.record_coverage_gap(text) is
  '현재 카드로 다루지 못한 분류 밖(other_uncovered) 횟수만 날짜별로 1 올린다. 과거 영역별 이력은 보존한다.';

revoke all on function public.record_coverage_gap(text) from public;
revoke all on function public.record_coverage_gap(text)
  from anon, authenticated, service_role;
grant execute on function public.record_coverage_gap(text) to service_role;
