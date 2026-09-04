-- 아뢰다 · Research Prioritizer용 읽기 전용 RPC
--
-- private.content_research_queue는 앱은 물론 service_role도 직접 읽을 수 없다.
-- 그 정책은 그대로 두고, 앞으로 내부 Prioritizer가 판단에 필요한 근거만 읽을 수 있는
-- 서버 전용 읽기 함수 하나를 추가한다.
--
-- 이 함수는
--   * 인자를 받지 않는다.
--   * auth.uid()를 쓰지 않는다.
--   * private.content_research_queue를 SELECT만 한다. 아무것도 고치지 않는다.
--   * 판단에 필요한 9개 값만 돌려준다. id, created_at, updated_at은 돌려주지 않는다.
--   * other_uncovered와 taxonomy_discovery는 결과에 넣지 않는다.
--
-- Edge Function 쪽 Eligibility Gate는 그대로 유지한다. 여기 필터는 이중 방어다.
--
-- 아직 실행하지 않았다. 적용 시점은 사용자가 정한다.

-- create or replace를 쓰지 않는다. 같은 이름의 함수가 이미 있으면 덮어쓰지 말고 실패해야 한다.
create function public.get_content_research_queue_for_prioritizer()
returns table (
  target_domain text,
  research_kind text,
  status text,
  total_gap_count bigint,
  recent_7d_count bigint,
  recent_30d_count bigint,
  first_detected_date date,
  last_detected_date date,
  evidence_version bigint
)
language sql
security definer
stable
set search_path = private, pg_catalog
as $$
  select
    q.target_domain,
    q.research_kind,
    q.status,
    q.total_gap_count,
    q.recent_7d_count,
    q.recent_30d_count,
    q.first_detected_date,
    q.last_detected_date,
    q.evidence_version
  from private.content_research_queue q
  where q.research_kind = 'domain_expansion'
    and q.status = 'queued'
    and q.total_gap_count > 0
    and q.evidence_version >= 1
    and q.target_domain in (
      'loneliness_isolation',
      'family_parenting_conflict',
      'burnout_exhaustion',
      'spiritual_dryness',
      'financial_hardship',
      'chronic_illness',
      'relationship_conflict_forgiveness'
    )
  order by q.target_domain asc;
$$;

comment on function public.get_content_research_queue_for_prioritizer() is
  'Research Prioritizer가 볼 수 있는 연구 과제 근거만 읽어 온다. 사용자 정보는 다루지 않고 아무것도 고치지 않는다.';

-- 서버만 실행할 수 있게 한다. 표 자체의 권한은 그대로 둔다(직접 SELECT는 계속 불가능).
revoke all on function public.get_content_research_queue_for_prioritizer() from public;
revoke all on function public.get_content_research_queue_for_prioritizer() from anon, authenticated, service_role;
grant execute on function public.get_content_research_queue_for_prioritizer() to service_role;
