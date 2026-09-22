------------------------------------------------------------------
-- 자동 Scripture Catalog — 후보 생성 증거의 불변 보관과 저장 RPC
--
-- 무엇을 보관하는가
--   TypeScript 계약(automatic-scripture-catalog-candidate-generation-evidence.ts)의
--   `CandidateGenerationEvidence` 한 건을, 그것이 가리키는 후보와 이어서 불변으로 적는다.
--
-- 이 보관소가 보장하는 것
--   1. 적힌 증거는 고칠 수도 지울 수도 없다(append-only 방아쇠).
--   2. 증거는 DB에 실제로 있는 후보에만 붙는다(외래 키).
--   3. 열 값과 JSON 안의 contractVersion·candidateHash·artifactHash가 서로 어긋날 수 없다.
--   4. 같은 artifactHash로 동일한 JSONB 값을 다시 보내면 멱등이다(공백·키 순서 같은
--      원문 바이트 차이는 jsonb 비교가 애초에 구분하지 않는다).
--   5. 같은 artifactHash에 다른 후보나 다른 JSON을 붙이면 거절한다.
--   6. anon·authenticated는 표도 RPC도 건드릴 수 없고, service_role도 표를 직접 읽거나
--      쓰지 못하며 허용된 저장 RPC만 실행할 수 있다.
--
-- 이 보관소가 보장하지 **않는** 것
--   - 증거가 실제 모델 호출에서 나왔다는 것. DB는 불변 보관과 후보 연결만 본다.
--     "저장됨"은 "실제 호출이 증명됨"이 아니다.
--   - TypeScript validator를 통과했다는 사실. 그것은 전자서명이 아니며 DB는 그 통과 여부를
--     확인하지 않는다. 증거를 쓸 수 있는 주체는 계약을 만족하는 내용을 지어낼 수 있다.
--   - artifactHash가 내용에서 실제로 나온 값이라는 것. 아래 "지문 재계산의 한계" 참고.
--
-- 지문 재계산의 한계 (중요)
--   JavaScript `canonicalJson`이 만드는 바이트열은 PostgreSQL의 `jsonb::text`와 같지 않다.
--   jsonb는 키를 (길이, 바이트) 순으로 다시 늘어놓고 중복 키를 버리며 수·유니코드 표기를
--   정규화한다. 게다가 이 프로젝트는 pgcrypto를 쓰지 않아 SQL 안에 SHA-256도 없다.
--   그래서 **DB는 artifactHash를 다시 계산하지 않는다.** 계산한 척도 하지 않는다.
--   대신 형식·필드 연결·충돌·멱등성을 엄격히 본다. 내용에서 지문이 실제로 나왔는지는
--   TypeScript 쪽 `validateCandidateGenerationEvidence`가 보며, 그 사실 자체는 여기에
--   기록되지 않는다.
--
-- cardinality: 후보 1 : 증거 N
--   사례 저작 모델은 결정적이지 않다. 같은 후보를 다시 돌리면 다른 문장이 나오고 따라서
--   다른 artifactHash가 나온다. 그 시도들은 모두 남아야 한다 — 하나만 남기려면 고치거나
--   지워야 하는데 그것이 바로 이 표가 막는 일이다. 그래서 기본 키는 artifactHash이고
--   candidateHash에는 unique를 걸지 않는다.
--
--   이 선택에는 검토 측면의 뜻도 있다. 시도가 전부 남으므로 "통과할 때까지 다시 돌린"
--   흔적이 나중에 보인다. 후보당 하나만 남겼다면 그 신호가 사라진다.
--
--   어느 증거가 검증·활성화에 쓰였는지는 이번 단계에서 정하지 않는다. 다음 단계가 정확한
--   artifactHash로 결속할 수 있도록 (artifact_hash, candidate_hash) 복합 unique만 미리 둔다.
--   기존 validation 표가 attestation을 위해 쓰는 것과 같은 방식이다.
--
-- 이번 단계에서 하지 않는 일
--   활성화 SQL은 이 증거를 아직 다시 확인하지 않는다. 자동 활성화는 계속 fail-closed다.
--   새 영역(new_domain_with_cards)용 동적 Analyzer manifest도 이번 범위가 아니다.
--   기존 7개 RPC와 활성화 함수의 동작은 건드리지 않는다.
------------------------------------------------------------------

------------------------------------------------------------------
-- 1. 표
------------------------------------------------------------------

create table private.scripture_catalog_candidate_generation_evidence (
  artifact_hash text primary key,
  candidate_hash text not null
    references private.scripture_catalog_candidate (candidate_hash)
    on delete restrict,
  evidence jsonb not null,
  created_at timestamptz not null default now(),

  constraint scripture_catalog_generation_evidence_artifact_format
    check (artifact_hash ~ '^sart_[0-9a-f]{64}$'),
  constraint scripture_catalog_generation_evidence_candidate_format
    check (candidate_hash ~ '^sccand_[0-9a-f]{64}$'),
  constraint scripture_catalog_generation_evidence_is_object
    check (jsonb_typeof(evidence) = 'object'),
  -- 열 값과 JSON이 어긋난 행은 어떤 경로로도 들어올 수 없다.
  constraint scripture_catalog_generation_evidence_matches_columns
    check (
      jsonb_exists(evidence, 'contractVersion')
      and evidence ->> 'contractVersion' = 'scripture-catalog-candidate-generation-evidence/v1'
      and jsonb_exists(evidence, 'candidateHash')
      and evidence ->> 'candidateHash' = candidate_hash
      and jsonb_exists(evidence, 'artifactHash')
      and evidence ->> 'artifactHash' = artifact_hash
    ),
  -- 다음 단계가 (증거, 후보) 짝을 외래 키로 결속할 수 있도록 미리 둔다.
  constraint scripture_catalog_generation_evidence_artifact_candidate_unique
    unique (artifact_hash, candidate_hash)
);

comment on table private.scripture_catalog_candidate_generation_evidence is
  '후보 생성 사례 증거 한 건. 후보 하나에 여러 시도가 남을 수 있다. 새로 적기만 한다. 저장은 실제 모델 호출을 증명하지 않는다.';

-- 후보별로 시도를 훑을 때 쓴다. candidate_hash는 unique가 아니다(1:N).
create index scripture_catalog_generation_evidence_candidate_idx
  on private.scripture_catalog_candidate_generation_evidence (candidate_hash, created_at);

-- 기존 append-only 방아쇠를 그대로 재사용한다.
create trigger scripture_catalog_generation_evidence_reject_mutation
before update or delete on private.scripture_catalog_candidate_generation_evidence
for each statement execute function private.reject_scripture_catalog_mutation();
create trigger scripture_catalog_generation_evidence_reject_truncate
before truncate on private.scripture_catalog_candidate_generation_evidence
for each statement execute function private.reject_scripture_catalog_mutation();

alter table private.scripture_catalog_candidate_generation_evidence enable row level security;
revoke all on table private.scripture_catalog_candidate_generation_evidence from public;
revoke all on table private.scripture_catalog_candidate_generation_evidence
  from anon, authenticated, service_role;

------------------------------------------------------------------
-- 2. 저장 RPC
--
-- security definer인 이유
--   service_role에는 private 표에 대한 권한이 하나도 없다(위에서 전부 회수했다).
--   그것이 이 설계의 핵심이다 — 열쇠를 가진 쪽도 표를 직접 만지지 못하고, 정해진 검사를
--   지나는 이 함수로만 적을 수 있다. 그래서 함수 소유자 권한으로 실행해야 한다.
--   search_path를 private, pg_catalog로 고정하고 모든 객체를 스키마로 한정해
--   호출자가 만든 동명 객체가 끼어들 수 없게 한다.
------------------------------------------------------------------

create function public.store_scripture_catalog_candidate_generation_evidence(
  p_artifact_hash text,
  p_candidate_hash text,
  p_evidence jsonb
)
returns text
language plpgsql
security definer
set search_path = private, pg_catalog
as $$
declare
  v_candidate private.scripture_catalog_candidate%rowtype;
  v_inserted_hash text;
  v_existing_candidate_hash text;
  v_existing_evidence jsonb;
begin
  -- (1) 형식과 JSON-인자 연결. 여기서 걸리면 아무 행도 만들지 않는다.
  if p_artifact_hash is null or p_artifact_hash !~ '^sart_[0-9a-f]{64}$'
     or p_candidate_hash is null or p_candidate_hash !~ '^sccand_[0-9a-f]{64}$'
     or p_evidence is null or jsonb_typeof(p_evidence) <> 'object'
     or p_evidence ->> 'contractVersion'
        is distinct from 'scripture-catalog-candidate-generation-evidence/v1'
     or p_evidence ->> 'candidateHash' is distinct from p_candidate_hash
     or p_evidence ->> 'artifactHash' is distinct from p_artifact_hash then
    raise exception '후보 생성 증거 요청이 올바르지 않습니다.'
      using errcode = 'invalid_parameter_value';
  end if;

  -- (2) 후보가 DB에 실제로 있어야 한다.
  select * into v_candidate
    from private.scripture_catalog_candidate
   where candidate_hash = p_candidate_hash;
  if not found then
    raise exception '후보가 없습니다.'
      using errcode = 'no_data_found';
  end if;

  -- (3) 증거가 주장하는 버전·연구 연결이 그 후보의 기록과 같아야 한다.
  --     지문을 다시 계산하지는 않는다(머리말의 "지문 재계산의 한계" 참고).
  if p_evidence ->> 'baseVersionHash' is distinct from v_candidate.base_version_hash
     or p_evidence ->> 'proposedVersionHash' is distinct from v_candidate.proposed_version_hash
     or p_evidence ->> 'sourceResearchResultHash'
        is distinct from v_candidate.source_research_result_hash then
    raise exception '후보 생성 증거가 후보와 이어지지 않습니다.'
      using errcode = 'check_violation';
  end if;

  -- (4) 먼저 넣어 본다. 여기서 먼저 SELECT로 "없다"고 본 뒤 따로 INSERT하면, 그 사이에
  --     같은 증거를 동시에 보낸 다른 호출이 끼어들 수 있다 — 둘 다 "없다"고 보고 둘 다
  --     INSERT를 시도해 한쪽이 기본 키 충돌로 실패한다. 그러면 "같은 증거 재전송은
  --     멱등"이라는 계약이 동시 요청에서 깨진다.
  --
  --     INSERT ... ON CONFLICT는 한 문장 안에서 충돌을 본다. 동시에 도달한 두 트랜잭션
  --     중 아직 커밋하지 않은 쪽이 있으면, PostgreSQL이 이 문장을 그 트랜잭션이 끝날
  --     때까지 기다리게 한다(행 잠금) — 그 대기를 우리가 따로 구현하지 않는다.
  insert into private.scripture_catalog_candidate_generation_evidence (
    artifact_hash, candidate_hash, evidence
  ) values (
    p_artifact_hash, p_candidate_hash, p_evidence
  )
  on conflict (artifact_hash) do nothing
  returning artifact_hash into v_inserted_hash;

  -- 이번 호출이 실제로 그 행을 넣었다.
  if v_inserted_hash is not null then
    return v_inserted_hash;
  end if;

  -- 넣지 못했다 — 같은 artifactHash가 이미 있다는 뜻이다. 방금 이 문장이 기다렸다가
  -- 넘어온 것일 수도 있으니, 위 INSERT 문장이 본 것을 그대로 믿지 않고 별도의 SQL
  -- 문장으로 다시 읽어 대조한다.
  select candidate_hash, evidence
    into v_existing_candidate_hash, v_existing_evidence
    from private.scripture_catalog_candidate_generation_evidence
   where artifact_hash = p_artifact_hash;

  if v_existing_candidate_hash is null then
    raise exception '후보 생성 증거를 적지 못했습니다.'
      using errcode = 'internal_error';
  end if;

  if v_existing_candidate_hash = p_candidate_hash and v_existing_evidence = p_evidence then
    return p_artifact_hash;
  end if;

  raise exception '같은 지문으로 다른 후보 생성 증거가 들어왔습니다.'
    using errcode = 'unique_violation';
end;
$$;

comment on function public.store_scripture_catalog_candidate_generation_evidence(text, text, jsonb) is
  '후보 생성 사례 증거 한 건을 후보에 이어 불변으로 적는다. 같은 내용 재전송은 멱등이다. 저장은 실제 모델 호출이나 validator 통과를 증명하지 않는다.';

revoke all on function public.store_scripture_catalog_candidate_generation_evidence(text, text, jsonb)
  from public;
revoke all on function public.store_scripture_catalog_candidate_generation_evidence(text, text, jsonb)
  from anon, authenticated, service_role;
grant execute on function public.store_scripture_catalog_candidate_generation_evidence(text, text, jsonb)
  to service_role;
