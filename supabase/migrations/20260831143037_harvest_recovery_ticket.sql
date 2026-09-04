-- 아뢰다 · Recovery Ticket 저장소
--
-- 무엇을 위한 것인가
--   Source Harvester의 2단계(Verification)가 받은 주소를 충분히 열어 보지 못하고 끝났을 때,
--   그때까지의 결과를 잠깐 맡아 두었다가 "남은 주소만 마저 확인하는" 두 번째 요청에서
--   꺼내 쓰기 위한 임시 보관소다.
--
-- 왜 표가 필요한가
--   "정확히 한 번만 쓸 수 있다"를 보장하려면 서버에 상태가 있어야 한다.
--   상태 없이 발급한 표를 재사용하지 못하게 막을 방법은 없다.
--
-- 수명
--   만들어지고 30분 안에 한 번 쓰이거나, 안 쓰이면 버려진다.
--   쓰이는 순간 그 줄은 DB에서 사라진다(DELETE ... RETURNING).
--   그래서 pending/processing/completed 같은 상태 칸이 없다.
--   줄이 있으면 아직 안 쓴 것이고, 없으면 쓸 수 없는 것이다.
--
-- 담지 않는 것
--   사용자의 상황 문장, 사용자 id, 세션·기기 정보, 토큰,
--   OpenAI 원본 응답, 웹페이지 내용, Prioritizer의 점수·이유·확신.
--   연구 작업의 진행 상태만 담는다.
--
-- 이 migration은 아직 서버에 적용하지 않았다.

-- private 스키마는 이미 있고 권한이 회수돼 있다. 없을 때만 만든다.
create schema if not exists private;

revoke all on schema private from public;
revoke all on schema private from anon, authenticated, service_role;

create table private.harvest_recovery_ticket (
  recovery_id uuid primary key default gen_random_uuid(),

  created_at timestamptz not null default now(),
  -- 서버가 정한다. 부르는 쪽이 수명을 늘릴 수 없다.
  expires_at timestamptz not null,

  -- 어느 연구를 이어서 하는지. 두 번째 요청이 이 값을 바꿀 수 없다.
  target_domain text not null,
  evidence_version bigint not null,
  prioritizer_snapshot_id text not null,

  -- 표를 만들 때 카드가 다루던 영역 목록의 지문.
  -- 두 번째 요청 때 달라져 있으면 그 표를 쓰지 않는다.
  active_covered_hash text not null,

  -- 1단계에서 실제로 발견된 주소와, 2단계가 실제로 열어 본 주소.
  discovered_urls text[] not null,
  primary_inspected_urls text[] not null,

  -- 2단계가 실제로 열어 본 주소에 대해서만 쓴 초안.
  -- 열어 보지 않은 주소의 자료 설명은 여기에 담기지 않는다.
  primary_draft jsonb not null,

  -- 도구를 어디에 몇 번 썼는지. 숫자 6개뿐이다.
  primary_tool_counts jsonb not null,

  constraint harvest_recovery_ticket_expires_after_created
    check (expires_at > created_at),
  constraint harvest_recovery_ticket_snapshot_format
    check (prioritizer_snapshot_id ~ '^snap_[0-9a-f]{64}$'),
  constraint harvest_recovery_ticket_covered_hash_format
    check (active_covered_hash ~ '^[0-9a-f]{64}$'),
  constraint harvest_recovery_ticket_evidence_version_positive
    check (evidence_version >= 1),
  -- 빈 배열 {}에서 array_length()는 개수 0이 아니라 "없음"(NULL)을 돌려준다.
  -- CHECK는 NULL을 통과로 보므로 빈 배열이 그대로 들어간다.
  -- cardinality()는 빈 배열에 0을 돌려주므로 실제로 막힌다.
  constraint harvest_recovery_ticket_discovered_not_empty
    check (cardinality(discovered_urls) >= 1),
  constraint harvest_recovery_ticket_inspected_not_null
    check (primary_inspected_urls is not null)
);

comment on table private.harvest_recovery_ticket is
  '남은 주소를 마저 확인하는 두 번째 요청을 위해 1단계 결과를 최대 30분간 보관한다. 한 번 쓰이면 줄이 삭제된다. 사용자 정보는 담지 않는다.';

-- 만료된 표를 치울 때 쓴다.
create index harvest_recovery_ticket_expires_at_idx
  on private.harvest_recovery_ticket (expires_at);

-- 이 표는 아래 두 함수로만 접근한다.
alter table private.harvest_recovery_ticket enable row level security;
revoke all on table private.harvest_recovery_ticket from public;
revoke all on table private.harvest_recovery_ticket from anon, authenticated, service_role;

------------------------------------------------------------------
-- 표 만들기
------------------------------------------------------------------

create or replace function public.create_harvest_recovery_ticket(
  p_target_domain text,
  p_evidence_version bigint,
  p_prioritizer_snapshot_id text,
  p_active_covered_hash text,
  p_discovered_urls text[],
  p_primary_inspected_urls text[],
  p_primary_draft jsonb,
  p_primary_tool_counts jsonb
)
returns uuid
language plpgsql
security definer
set search_path = private, pg_catalog
as $$
declare
  v_recovery_id uuid;
begin
  -- 지나간 표를 먼저 치운다. 이것 때문에 따로 도는 작업을 두지 않는다.
  delete from private.harvest_recovery_ticket
   where expires_at <= now();

  insert into private.harvest_recovery_ticket (
    expires_at,
    target_domain,
    evidence_version,
    prioritizer_snapshot_id,
    active_covered_hash,
    discovered_urls,
    primary_inspected_urls,
    primary_draft,
    primary_tool_counts
  ) values (
    -- 수명은 서버가 정한다. 인자로 받지 않는다.
    now() + interval '30 minutes',
    p_target_domain,
    p_evidence_version,
    p_prioritizer_snapshot_id,
    p_active_covered_hash,
    p_discovered_urls,
    p_primary_inspected_urls,
    p_primary_draft,
    p_primary_tool_counts
  )
  returning recovery_id into v_recovery_id;

  -- 부르는 쪽에는 id만 돌려준다. 주소나 자료 설명은 돌려주지 않는다.
  return v_recovery_id;
end;
$$;

comment on function public.create_harvest_recovery_ticket(
  text, bigint, text, text, text[], text[], jsonb, jsonb
) is
  '표를 하나 만들고 id만 돌려준다. 수명 30분은 서버가 정한다. 만료된 표는 이때 함께 치운다.';

revoke all on function public.create_harvest_recovery_ticket(
  text, bigint, text, text, text[], text[], jsonb, jsonb
) from public;
revoke all on function public.create_harvest_recovery_ticket(
  text, bigint, text, text, text[], text[], jsonb, jsonb
) from anon, authenticated, service_role;
grant execute on function public.create_harvest_recovery_ticket(
  text, bigint, text, text, text[], text[], jsonb, jsonb
) to service_role;

------------------------------------------------------------------
-- 표 쓰기 (한 번만)
------------------------------------------------------------------

create or replace function public.consume_harvest_recovery_ticket(
  p_recovery_id uuid
)
returns table (
  target_domain text,
  evidence_version bigint,
  prioritizer_snapshot_id text,
  active_covered_hash text,
  discovered_urls text[],
  primary_inspected_urls text[],
  primary_draft jsonb,
  primary_tool_counts jsonb
)
language plpgsql
security definer
set search_path = private, pg_catalog
as $$
begin
  delete from private.harvest_recovery_ticket
   where expires_at <= now();

  -- 지우면서 동시에 꺼낸다.
  -- 같은 id로 두 번 부르면 두 번째는 지울 줄이 없으므로 아무것도 돌려주지 않는다.
  -- 두 요청이 동시에 와도 한쪽만 줄을 가져간다.
  return query
  delete from private.harvest_recovery_ticket t
   where t.recovery_id = p_recovery_id
     and t.expires_at > now()
  returning
    t.target_domain,
    t.evidence_version,
    t.prioritizer_snapshot_id,
    t.active_covered_hash,
    t.discovered_urls,
    t.primary_inspected_urls,
    t.primary_draft,
    t.primary_tool_counts;
end;
$$;

comment on function public.consume_harvest_recovery_ticket(uuid) is
  '표를 지우면서 내용을 꺼낸다. 없는 id, 만료된 id, 이미 쓴 id는 모두 똑같이 빈 결과다. 어느 쪽인지 밖에 알려주지 않는다.';

revoke all on function public.consume_harvest_recovery_ticket(uuid) from public;
revoke all on function public.consume_harvest_recovery_ticket(uuid) from anon, authenticated, service_role;
grant execute on function public.consume_harvest_recovery_ticket(uuid) to service_role;
