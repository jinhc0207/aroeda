-- 아뢰다 · Research Queue v1
--
-- 목적: "다음에 어떤 삶의 영역을 Scripture Card 연구 대상으로 살펴봐야 하는가"를
--       내부에서 관리하는 목록을 만든다.
--
-- 입력은 private.coverage_gap_daily의 익명 집계뿐이다.
-- no_coverage 한 건마다 과제를 만들지 않는다. 같은 영역은 하나의 과제로 모으고
-- 그 과제의 evidence(근거 수치)만 갱신한다.
--
-- 저장하지 않는 것
--   * 사용자가 쓴 상황 문장
--   * user id, auth uid, JWT, IP, 세션/기기 식별자
--   * OpenAI 원본 응답, 감정·신앙질문 태그, 기도 내용
--
-- 이번 단계에서 하지 않는 것
--   * 우선순위 점수 계산
--   * 성경본문 후보나 Scripture Card 생성
--   * 상태를 researching / completed로 자동 이동
--   * other_uncovered를 근거로 새 영역 이름이나 카드를 만드는 일
--
-- 아직 실행하지 않았다. 적용 시점은 사용자가 정한다.

create schema if not exists private;

revoke all on schema private from public;
revoke all on schema private from anon, authenticated, service_role;

-- if not exists를 쓰지 않는다.
-- 예상하지 못한 같은 이름의 표가 이미 있으면 조용히 넘어가지 말고 실패해야 한다.
create table private.content_research_queue (
  id uuid primary key default gen_random_uuid(),

  -- 연구 대상 영역 이름. coverage_gap_daily에 기록되는 8개와 같은 값만 쓴다.
  target_domain text not null,

  -- domain_expansion: 이미 알고 있는 영역인데 카드가 없는 경우
  -- taxonomy_discovery: other_uncovered. 분류 자체를 더 살펴봐야 하는 경우
  research_kind text not null,

  status text not null default 'queued',

  -- 근거 수치 스냅샷 (Asia/Seoul 날짜 기준)
  first_detected_date date not null,
  last_detected_date date not null,
  total_gap_count bigint not null,
  recent_7d_count bigint not null default 0,
  recent_30d_count bigint not null default 0,

  -- 근거가 몇 번 갱신되었는지
  evidence_version bigint not null default 1,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- 같은 영역 + 같은 종류의 과제는 하나만 존재한다. refresh를 여러 번 해도 늘어나지 않는다.
  constraint content_research_queue_target_unique unique (target_domain, research_kind),

  constraint content_research_queue_kind_allowed check (
    research_kind in ('domain_expansion', 'taxonomy_discovery')
  ),

  constraint content_research_queue_status_allowed check (
    status in ('queued', 'ready', 'researching', 'blocked', 'completed')
  ),

  -- 영역과 연구 종류가 어긋나지 않게 한다.
  -- other_uncovered는 언제나 taxonomy_discovery이고, 나머지 7개는 domain_expansion이다.
  constraint content_research_queue_domain_kind_match check (
    (
      research_kind = 'domain_expansion'
      and target_domain in (
        'loneliness_isolation',
        'family_parenting_conflict',
        'burnout_exhaustion',
        'spiritual_dryness',
        'financial_hardship',
        'chronic_illness',
        'relationship_conflict_forgiveness'
      )
    )
    or (research_kind = 'taxonomy_discovery' and target_domain = 'other_uncovered')
  ),

  constraint content_research_queue_counts_sane check (
    total_gap_count > 0
    and recent_7d_count >= 0
    and recent_30d_count >= 0
    and recent_7d_count <= recent_30d_count
    and recent_30d_count <= total_gap_count
  ),

  constraint content_research_queue_dates_sane check (first_detected_date <= last_detected_date)
);

comment on table private.content_research_queue is
  '영역별 Scripture Card 연구 과제와 근거 수치. 사용자 문장과 식별자는 저장하지 않는다.';

-- 앱 클라이언트가 이 표를 직접 읽거나 쓰지 못하게 한다. service_role도 직접 접근할 필요가 없다.
alter table private.content_research_queue enable row level security;
revoke all on table private.content_research_queue from public;
revoke all on table private.content_research_queue from anon, authenticated, service_role;
-- 정책을 하나도 만들지 않는다. 정책이 없으면 일반 사용자는 아무 행에도 접근할 수 없다.

-- Coverage Gap 집계를 읽어 연구 과제 목록을 갱신한다.
--
-- 인자가 없다. 사용자 id도 auth.uid()도 쓰지 않는다.
-- 읽는 곳은 private.coverage_gap_daily 하나, 쓰는 곳은 private.content_research_queue 하나뿐이다.
--
-- 여러 번 실행해도 같은 과제가 중복 생성되지 않는다(idempotent).
-- 상태(status)는 건드리지 않는다. researching/completed로 자동 이동시키지 않는다.
--
-- create or replace를 쓰지 않는다. 같은 이름의 함수가 이미 있으면 덮어쓰지 말고 실패해야 한다.
create function public.refresh_content_research_queue()
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
  'Coverage Gap 집계를 읽어 영역별 연구 과제의 근거 수치를 갱신한다. 사용자 정보는 다루지 않는다.';

-- 서버만 실행할 수 있게 한다.
revoke all on function public.refresh_content_research_queue() from public;
revoke all on function public.refresh_content_research_queue() from anon, authenticated, service_role;
grant execute on function public.refresh_content_research_queue() to service_role;
