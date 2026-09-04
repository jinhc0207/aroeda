-- 아뢰다 · Prioritizer 판단 보관소
--
-- 무엇을 위한 것인가
--   Research Prioritizer가 "다음에 연구할 영역은 이것"이라고 합의하면,
--   그 판단이 지금은 HTTP 응답으로 나가고 그대로 사라진다.
--   Source Harvester는 부르는 쪽이 적어 보낸 네 값을 모양만 보고 실행한다.
--
--   그래서 다른 영역에서 나온 멀쩡한 모양의 판단 시점 id를 새 영역에 붙여도
--   서버가 그것이 틀렸다는 것을 알 방법이 없다.
--   대조할 원본이 어디에도 남아 있지 않기 때문이다.
--
--   이 표는 그 원본을 서버가 갖고 있게 한다.
--
-- 왜 판단 시점 id만으로는 안 되는가
--   판단 시점 id는 "그때 후보 목록과 활성 영역이 이러했다"를 가리킨다.
--   무엇이 선택됐는지는 담고 있지 않다. 그 값은 평가자를 부르기 전에 계산되고,
--   추천은 그 뒤에 나오기 때문이다.
--   그래서 선택 결과를 따로 적어 두어야 한다.
--
-- 왜 넘겨줌마다 번호가 따로 필요한가
--   판단 시점 id는 후보 상태에서 계산한 값이다. 후보 상태가 같으면 나중에 또 같은 값이 나온다.
--   그것을 줄의 이름으로 쓰면, 한 번 쓰고 지운 뒤 같은 상태에서 새 판단이 적힐 때
--   그 줄이 옛 이름과 똑같은 이름을 갖게 된다.
--   그러면 오래전에 받아 둔 넘겨줌으로 이번에 새로 적힌 판단을 가져갈 수 있다.
--
--   그래서 줄의 이름은 서버가 만든 번호(decision_id)로 둔다.
--   판단 시점 id는 이름이 아니라 함께 대조하는 정보로 남는다.
--
-- 수명
--   30분. 오래된 판단으로 새 연구를 시작하지 않기 위해서다.
--   쓰이는 순간 그 줄은 사라진다. 지우면서 맞았는지를 판정한다.
--   상태 칸이 없다. 줄이 있으면 아직 안 쓴 것이고, 없으면 쓸 수 없는 것이다.
--
-- 담지 않는 것
--   평가자의 점수·이유·확신, OpenAI 원본 응답,
--   사용자의 상황 문장, 사용자 id, 세션·기기 정보, 토큰.
--   "어느 영역을 어느 근거 판본으로 연구하기로 했는가"만 담는다.
--
-- 이 migration은 아직 서버에 적용하지 않았다.
-- 이 표를 읽거나 쓰는 실행 코드도 아직 없다.

create schema if not exists private;

revoke all on schema private from public;
revoke all on schema private from anon, authenticated, service_role;

create table private.prioritizer_decision (
  -- 이 줄의 이름은 서버가 만든 번호다. 부르는 쪽이 정하지 못한다.
  --
  -- 왜 판단 시점 id를 이름으로 쓰지 않는가:
  --   판단 시점 id는 후보 상태에서 계산한 값이라, 후보 상태가 같으면 나중에 또 나온다.
  --   그것을 이름으로 쓰면 "지난번 넘겨줌"과 "이번 넘겨줌"이 같은 이름을 갖는다.
  --   그러면 오래전에 받아 둔 넘겨줌으로 이번에 새로 적힌 판단을 가져갈 수 있다.
  --
  --   번호를 매번 새로 만들면 그 둘이 서로 다른 것이 된다.
  --   넘겨줌 한 건에 이름 하나. 그 이름은 한 번만 쓰인다.
  decision_id uuid primary key default gen_random_uuid(),

  created_at timestamptz not null default now(),
  -- 서버가 정한다. 부르는 쪽이 수명을 늘릴 수 없다.
  expires_at timestamptz not null,

  -- 어느 판단 시점에서 나온 합의인지. 이제 이름이 아니라 따라다니는 정보다.
  -- 같은 값이 여러 줄에 있을 수 있다. 넘겨줌마다 줄이 따로 생기기 때문이다.
  prioritizer_snapshot_id text not null,

  -- 합의로 선택된 영역과 그 근거 판본.
  target_domain text not null,
  evidence_version bigint not null,

  -- 판단할 때 카드가 다루던 영역 목록의 지문.
  -- 그 사이에 카드가 늘었다면 이 판단은 더 이상 맞지 않는다.
  active_covered_hash text not null,

  constraint prioritizer_decision_expires_after_created
    check (expires_at > created_at),
  constraint prioritizer_decision_snapshot_format
    check (prioritizer_snapshot_id ~ '^snap_[0-9a-f]{64}$'),
  constraint prioritizer_decision_covered_hash_format
    check (active_covered_hash ~ '^[0-9a-f]{64}$'),
  constraint prioritizer_decision_evidence_version_positive
    check (evidence_version >= 1),

  -- 연구 대상 영역만 들어올 수 있다.
  -- 목록을 여기 적는 것은 content_research_queue와 같은 방식이다.
  -- 코드의 RESEARCHABLE_DOMAINS와 어긋나면 시험이 잡는다.
  constraint prioritizer_decision_target_domain_allowed check (
    target_domain in (
      'loneliness_isolation',
      'family_parenting_conflict',
      'burnout_exhaustion',
      'spiritual_dryness',
      'financial_hardship',
      'chronic_illness',
      'relationship_conflict_forgiveness'
    )
  )
);

comment on table private.prioritizer_decision is
  'Prioritizer 합의 결과를 최대 30분간 보관한다. Source Harvester가 시작하기 전에 한 번 대조하고 소비한다. 평가자의 점수·이유와 사용자 정보는 담지 않는다.';

-- 만료된 줄을 치울 때 쓴다.
create index prioritizer_decision_expires_at_idx
  on private.prioritizer_decision (expires_at);

-- 이 표는 아래 두 함수로만 접근한다.
alter table private.prioritizer_decision enable row level security;
revoke all on table private.prioritizer_decision from public;
revoke all on table private.prioritizer_decision from anon, authenticated, service_role;

------------------------------------------------------------------
-- 판단 적어 두기
------------------------------------------------------------------

create or replace function public.create_prioritizer_decision(
  p_prioritizer_snapshot_id text,
  p_target_domain text,
  p_evidence_version bigint,
  p_active_covered_hash text
)
returns uuid
language plpgsql
security definer
set search_path = private, pg_catalog
as $$
declare
  v_decision_id uuid;
begin
  -- 지나간 판단을 먼저 치운다. 이것 때문에 따로 도는 작업을 두지 않는다.
  delete from private.prioritizer_decision
   where expires_at <= now();

  -- 넘겨줌마다 새 줄이다.
  -- 같은 판단 시점에서 다시 합의가 나와도 앞의 줄을 덮거나 막지 않는다.
  -- 두 줄은 서로 다른 번호를 갖고, 각자 자기 번호로만 쓰인다.
  insert into private.prioritizer_decision (
    expires_at,
    prioritizer_snapshot_id,
    target_domain,
    evidence_version,
    active_covered_hash
  ) values (
    -- 수명은 서버가 정한다. 인자로 받지 않는다.
    now() + interval '30 minutes',
    p_prioritizer_snapshot_id,
    p_target_domain,
    p_evidence_version,
    p_active_covered_hash
  )
  returning decision_id into v_decision_id;

  -- 부르는 쪽에는 번호만 돌려준다. 표의 내용은 돌려주지 않는다.
  return v_decision_id;
end;
$$;

comment on function public.create_prioritizer_decision(text, text, bigint, text) is
  '합의된 판단 한 건을 적고 번호만 돌려준다. 번호는 서버가 만든다. 수명 30분은 서버가 정한다. 부를 때마다 새 줄이 생긴다.';

revoke all on function public.create_prioritizer_decision(text, text, bigint, text) from public;
revoke all on function public.create_prioritizer_decision(text, text, bigint, text)
  from anon, authenticated, service_role;
grant execute on function public.create_prioritizer_decision(text, text, bigint, text) to service_role;

------------------------------------------------------------------
-- 판단 대조하고 쓰기 (한 번만)
------------------------------------------------------------------

create or replace function public.consume_prioritizer_decision(
  p_decision_id uuid,
  p_prioritizer_snapshot_id text,
  p_target_domain text,
  p_evidence_version bigint,
  p_active_covered_hash text
)
returns boolean
language plpgsql
security definer
set search_path = private, pg_catalog
as $$
declare
  v_deleted integer;
begin
  delete from private.prioritizer_decision
   where expires_at <= now();

  -- 번호와 따라다니는 값 넷이 모두 맞고 아직 만료되지 않은 줄만 지우면서 가져간다.
  --
  -- 번호는 그 줄 하나만 가리킨다(primary key).
  -- 그래서 오래전에 받아 둔 번호는 그때 그 줄만 가리키고, 그 줄은 이미 사라졌다.
  -- 같은 판단 시점에서 새로 적힌 줄은 번호가 다르므로 옛 번호로는 닿지 않는다.
  --
  -- 하나라도 어긋나면 아무것도 지우지 않는다.
  -- 그래서 틀린 요청이 멀쩡한 판단을 망가뜨리지 못한다.
  --
  -- 같은 번호로 두 번 부르면 두 번째는 지울 줄이 없다.
  -- 두 요청이 동시에 와도 한쪽만 줄을 가져간다.
  delete from private.prioritizer_decision d
   where d.decision_id = p_decision_id
     and d.prioritizer_snapshot_id = p_prioritizer_snapshot_id
     and d.target_domain = p_target_domain
     and d.evidence_version = p_evidence_version
     and d.active_covered_hash = p_active_covered_hash
     and d.expires_at > now();

  get diagnostics v_deleted = row_count;

  -- 맞았는지만 알려준다.
  -- 없는 번호인지, 영역이 다른지, 만료됐는지는 밖에서 구분할 수 없다.
  return v_deleted = 1;
end;
$$;

comment on function public.consume_prioritizer_decision(uuid, text, text, bigint, text) is
  '번호와 값 넷이 모두 맞는 판단을 지우면서 참을 돌려준다. 어긋나면 아무것도 지우지 않고 거짓이다. 없는 번호, 만료된 판단, 이미 쓴 판단은 모두 똑같이 거짓이다.';

revoke all on function public.consume_prioritizer_decision(uuid, text, text, bigint, text) from public;
revoke all on function public.consume_prioritizer_decision(uuid, text, text, bigint, text)
  from anon, authenticated, service_role;
grant execute on function public.consume_prioritizer_decision(uuid, text, text, bigint, text) to service_role;
