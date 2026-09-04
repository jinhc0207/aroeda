-- 아뢰다 · Research Queue v1 보강: 미래 날짜 제외
--
-- 앞선 마이그레이션(20260829120000)에서는 최근 7일/30일 집계에서만 오늘 이후 날짜를 걸렀다.
-- 이 마이그레이션은 그 범위를 넓혀, 미래 날짜의 coverage_gap_daily 행이
--   total_gap_count, first_detected_date, last_detected_date, recent_7d_count, recent_30d_count
-- 어느 근거에도 들어가지 않게 한다.
--
-- 실제 Supabase에는 이미 같은 변경이 적용되어 있다. 이 파일은 로컬 기록을 서버와 맞추기 위한 것이다.
--
-- 함수 정의만 교체한다. 표, 제약, RLS, 표 권한은 건드리지 않는다.

create or replace function public.refresh_content_research_queue()
returns jsonb
language plpgsql
security definer
set search_path = private, pg_catalog
as $$
declare
  today date := (now() at time zone 'Asia/Seoul')::date;
  touched integer := 0;
begin
  -- coverage_gap_daily가 비어 있으면 아무 과제도 만들지 않는다.
  insert into private.content_research_queue as q (
    target_domain,
    research_kind,
    status,
    first_detected_date,
    last_detected_date,
    total_gap_count,
    recent_7d_count,
    recent_30d_count
  )
  select
    g.primary_domain,
    case
      when g.primary_domain = 'other_uncovered' then 'taxonomy_discovery'
      else 'domain_expansion'
    end,
    -- other_uncovered는 count만으로 새 카드를 연구할 수 없다. 처음부터 막아 둔 상태로 만든다.
    case
      when g.primary_domain = 'other_uncovered' then 'blocked'
      else 'queued'
    end,
    min(g.bucket_date),
    max(g.bucket_date),
    sum(g.gap_count),
    -- 오늘 포함 7일 / 30일. 오늘 이후 날짜는 넣지 않는다.
    coalesce(sum(g.gap_count) filter (where g.bucket_date between today - 6 and today), 0),
    coalesce(sum(g.gap_count) filter (where g.bucket_date between today - 29 and today), 0)
  from private.coverage_gap_daily g
  -- 미래 날짜 행은 어떤 근거에도 넣지 않는다.
  where g.bucket_date <= today
  group by g.primary_domain
  on conflict (target_domain, research_kind) do update
    set first_detected_date = least(q.first_detected_date, excluded.first_detected_date),
        last_detected_date = greatest(q.last_detected_date, excluded.last_detected_date),
        total_gap_count = excluded.total_gap_count,
        recent_7d_count = excluded.recent_7d_count,
        recent_30d_count = excluded.recent_30d_count,
        evidence_version = q.evidence_version + 1,
        updated_at = now()
    -- 근거가 실제로 달라졌을 때만 갱신한다.
    -- 같은 자료로 refresh를 여러 번 해도 행은 그대로다(버전도 시각도 그대로).
    where q.total_gap_count is distinct from excluded.total_gap_count
       or q.recent_7d_count is distinct from excluded.recent_7d_count
       or q.recent_30d_count is distinct from excluded.recent_30d_count
       or q.first_detected_date is distinct from least(q.first_detected_date, excluded.first_detected_date)
       or q.last_detected_date is distinct from greatest(q.last_detected_date, excluded.last_detected_date);
  -- status는 그대로 둔다. 이번 단계에서는 자동으로 옮기지 않는다.
  -- other_uncovered가 refresh만으로 blocked에서 풀리지 않는다.

  get diagnostics touched = row_count;

  return jsonb_build_object('refreshed_at', now(), 'items_touched', touched);
end;
$$;

comment on function public.refresh_content_research_queue() is
  'Coverage Gap 집계를 읽어 영역별 연구 과제의 근거 수치를 갱신한다. 미래 날짜는 제외한다. 사용자 정보는 다루지 않는다.';

-- 함수를 교체했으므로 권한을 다시 명시한다. 서버만 실행할 수 있다.
revoke all on function public.refresh_content_research_queue() from public;
revoke all on function public.refresh_content_research_queue() from anon, authenticated, service_role;
grant execute on function public.refresh_content_research_queue() to service_role;
