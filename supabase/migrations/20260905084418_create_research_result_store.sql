-- 아뢰다 · 연구 결과 보관소
--
-- 무엇을 위한 것인가
--   지금 Biblical Researcher는 연구를 마치면 결과를 HTTP 응답으로 돌려주고 끝난다.
--   서버에는 아무것도 남지 않는다. 연구가 끝나는 순간 결과가 사라진다.
--
--   그래서 사람이 나중에 그 연구를 읽고 검수할 수도 없고,
--   "이 말은 무엇을 보고 나온 것인가"를 물을 수도 없다.
--
--   이 표는 그 결과를 남긴다.
--
-- 왜 근거까지 함께 담는가
--   연구 결과에는 어떤 근거를 썼는지 번호만 적혀 있다.
--   그런데 그 번호가 가리키는 근거 꾸러미는 한 번 꺼내 쓰면 지워지고,
--   30분이면 만료된다. 자료를 따로 담아 두는 표도 없다.
--
--   결과만 남기면 번호는 남지만 가리킬 대상이 없어진다.
--   그래서 연구 결과 안에 없는 사실만 골라 함께 얼려 둔다.
--
-- 담는 것과 담지 않는 것
--   담는 것은 연구 결과 하나와 근거 기록 하나, 그리고 그 결과의 지문 하나다.
--
--   영역 이름, 근거 판본, 우선순위 스냅샷 번호, 근거 꾸러미 지문, 연구 질문은
--   따로 칸을 두지 않는다. 그 값들은 이미 연구 결과 안에 있다.
--   밖에 한 번 더 적으면 주인이 둘이 되고, 언젠가 둘이 서로 달라진다.
--
--   담지 않는 것: 사용자의 상황 문장, 사용자가 적은 기도, 사용자 id, 세션 정보,
--   토큰, OpenAI 원본 응답, 웹페이지 내용, 성경 본문 글자.
--   앞 단계의 번호도 담지 않는다. 그 표들은 사라지는 표라서,
--   이 표가 그것을 가리키면 사라질 때 함께 끌려갈 수 있다.
--
--   사용자에게 보여줄 문구와 게시 상태도 여기 없다.
--   그것은 다음 계층(게시 콘텐츠)의 몫이다. 여기서 섞지 않는다.
--
-- 이 표가 하지 않는 일
--   연구 내용 안을 들여다보지 않는다.
--   본문 위치를 세지 않고, 근거를 검사하지 않고, 지문을 다시 계산하지 않는다.
--   그 판단은 이미 애플리케이션의 계약(research-result-store-contract.ts)이 했다.
--   여기서 다시 하면 규칙의 주인이 둘이 된다.
--
--   DB가 맡는 일은 "검증을 마친 연구 한 건을 고쳐 쓰지 않고 보관하는 것"뿐이다.
--
-- 지문에 대해
--   결과 지문(rres_)은 같은 연구가 두 번 들어오는 것을 막는 열쇠다.
--   지문은 내용이 바뀌었는지 알려 줄 뿐, 바꾸지 못하게 막지는 않는다.
--   실제로 못 바꾸게 하는 일은 아래 방아쇠와 권한이 맡는다.
--
-- 이 migration은 아직 서버에 적용하지 않았다.
-- 이 표를 읽거나 쓰는 실행 코드도 아직 없다.

-- private 스키마는 이미 있고 권한이 회수돼 있다. 없을 때만 만든다.
create schema if not exists private;

revoke all on schema private from public;
revoke all on schema private from anon, authenticated, service_role;

------------------------------------------------------------------
-- 고쳐 쓰지 못하게 막는 방아쇠
------------------------------------------------------------------

-- 이 표는 새로 적기만 한다.
--
-- 주석으로 "고치지 마시오"라고 적어 두는 것만으로는 부족하다.
-- 실수로 한 줄을 고치면 그때 무엇을 보고 판단했는지 영원히 알 수 없게 된다.
-- 그래서 DB가 직접 거절한다.
--
-- 이 함수는 남의 권한을 빌리지 않는다(security definer 아님).
-- 하는 일이 오류를 내는 것뿐이라 빌릴 이유가 없다.
-- 오류 문구에 저장된 내용을 담지 않는다.
create or replace function private.reject_research_result_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception '연구 결과 보관소는 새로 적기만 합니다. 고치거나 지울 수 없습니다.'
    using errcode = 'restrict_violation';
end;
$$;

comment on function private.reject_research_result_mutation() is
  '연구 결과 보관소의 UPDATE / DELETE / TRUNCATE 를 거절한다. 저장된 내용은 오류 문구에 담지 않는다.';

------------------------------------------------------------------
-- 표
------------------------------------------------------------------

create table private.research_result (
  -- 줄의 이름은 서버가 만든 번호다. 부르는 쪽이 정하지 못한다.
  -- 아래 결과 지문과 역할이 다르다. 이것은 "몇 번째 줄인가"이고,
  -- 결과 지문은 "어떤 연구인가"이다.
  research_result_id uuid primary key default gen_random_uuid(),

  -- 보관한 시각. 연구 내용이 아니라 보관에 대한 기록이다.
  -- 결과 지문을 계산할 때 이 값은 들어가지 않는다.
  created_at timestamptz not null default now(),

  -- 연구 결과 하나의 지문. 애플리케이션이 계산한다. 여기서 만들지 않는다.
  -- 같은 연구가 두 번 들어오는 것을 막는 열쇠다.
  result_hash text not null,

  -- 검증을 마친 연구 결과 전체(BiblicalResearchResult).
  result jsonb not null,

  -- 연구 결과 안에 없어서 함께 얼려 두는 사실(ResearchResultProvenance).
  -- 영역 설명, 그때 이미 다루던 영역들, 자료와 근거, 수집 단계의 남은 질문.
  provenance jsonb not null,

  -- 애플리케이션 계약(RESEARCH_RESULT_HASH_FORMAT)과 같은 모양이다.
  -- 근거 꾸러미 지문(evset_)과 앞머리가 다르다. 둘을 바꿔 넣으면 여기서 걸린다.
  constraint research_result_hash_format
    check (result_hash ~ '^rres_[0-9a-f]{64}$'),

  -- 같은 연구는 한 번만 남는다. 다시 보내도 늘어나지 않는다.
  constraint research_result_hash_unique
    unique (result_hash),

  -- 모양만 본다. 안에 무엇이 들어 있어야 하는지는 여기서 정하지 않는다.
  constraint research_result_is_object
    check (jsonb_typeof(result) = 'object'),
  constraint research_result_provenance_is_object
    check (jsonb_typeof(provenance) = 'object'),

  -- 빈 껍데기를 허용하면 "근거를 함께 남긴다"는 약속이 무력해진다.
  -- 그래서 비어 있지 않다는 것까지만 본다. 항목 하나하나는 보지 않는다.
  constraint research_result_not_empty
    check (result <> '{}'::jsonb),
  constraint research_result_provenance_not_empty
    check (provenance <> '{}'::jsonb)
);

comment on table private.research_result is
  '검증을 마친 연구 결과 한 건과, 그 연구가 무엇을 보고 나왔는지 확인할 수 있는 최소 근거를 함께 남긴다. 새로 적기만 하고 고치거나 지우지 않는다. 사용자 정보와 게시용 문구는 담지 않는다.';

comment on column private.research_result.result_hash is
  '연구 결과 내용으로 계산한 지문. 같은 연구가 두 번 들어오지 않게 하는 열쇠다.';

comment on column private.research_result.provenance is
  '연구 결과 안에 없는 근거 사실. 근거 꾸러미가 사라진 뒤 결과와 어긋나지 않았는지 다시 확인할 때 쓴다.';

------------------------------------------------------------------
-- 고쳐 쓰기 막기
------------------------------------------------------------------

-- 한 줄씩 막는다.
create trigger research_result_reject_row_mutation
before update or delete on private.research_result
for each row
execute function private.reject_research_result_mutation();

-- 표를 통째로 비우는 길도 막는다. 줄 단위 방아쇠는 이때 돌지 않기 때문이다.
create trigger research_result_reject_truncate
before truncate on private.research_result
for each statement
execute function private.reject_research_result_mutation();

------------------------------------------------------------------
-- 권한
------------------------------------------------------------------

-- 앞의 보관소들과 같은 방식이다.
-- 이 표에 닿는 길을 이번 단계에서 만들지 않는다.
-- 실제로 어떻게 적고 읽을지는 다음 단계에서 정한다.
--
-- 권한을 회수하는 것과 고쳐 쓰지 못하게 막는 것은 서로 다른 일이다.
-- 권한은 "누가 손댈 수 있는가"를 정하고, 위의 방아쇠는 "무엇을 할 수 있는가"를 정한다.
-- 둘 다 필요하다.
alter table private.research_result enable row level security;
revoke all on table private.research_result from public;
revoke all on table private.research_result from anon, authenticated, service_role;
