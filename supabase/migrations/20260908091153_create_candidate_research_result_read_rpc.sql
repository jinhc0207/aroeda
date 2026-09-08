-- 아뢰다 · Candidate Generation용 연구 결과 읽기 RPC
--
-- 무엇을 위한 것인가
--   글(Candidate)을 만들기 전에 모델에게 보여줄 연구 결과가 필요하다.
--
--   지금까지는 부르는 쪽이 연구 결과를 통째로 들고 와야 했다.
--   그러면 그 값이 정말 우리 Researcher가 만들어 보관한 것인지
--   모델을 부르기 전에는 확인할 방법이 없다.
--
--   지문을 맞춰 보는 것은 "보낸 내용과 보낸 지문이 서로 맞는가"만 증명한다.
--   "그 연구가 실제로 있었는가"는 증명하지 않는다.
--
--   실제로 그것을 붙잡는 자리는 글을 적어 둘 때의 이음(FK)뿐인데,
--   그 자리는 모델을 부르고 난 다음이다.
--
--     지문 확인 → 모델 호출(돈이 나감) → 조립 → 적어 두기(여기서 처음 걸림)
--
--   지어낸 연구 하나마다 유료 호출 한 번이 먼저 나간다는 뜻이다.
--   저장은 막히니 잘못된 글이 남지는 않는다. 그러나 돈은 이미 나갔다.
--
--   이 함수가 그 순서를 바꾼다.
--
--     지문으로 읽기(없으면 여기서 끝) → 지문 확인 → 모델 호출
--
-- 표를 여는 것이 아니다
--   private.research_result는 만들 때부터 닫혀 있다.
--   스키마를 쓸 권한도, 표를 읽을 권한도 service_role에게 없다.
--
--   그 정책을 그대로 둔다. 이 migration은 표의 권한을 하나도 건드리지 않는다.
--   앞서 Prioritizer 읽기 함수를 만들 때와 같은 방식으로, 좁은 함수 하나만 연다.
--
-- 이 함수가 하는 일
--   지문 하나를 받아 그 지문의 연구 결과 하나를 돌려준다. 그것뿐이다.
--
--   목록을 주지 않는다. 검색하지 않는다. 앞자리만 맞는 것을 찾지 않는다.
--   최근 것을 주지 않는다. 영역으로 찾지 않는다. 여러 개를 한 번에 주지 않는다.
--
--   이 함수로 보관소 안을 둘러볼 수 없다.
--   지문을 정확히 아는 사람만 그 한 건을 가져간다.
--
-- 근거 기록(provenance)을 주지 않는 이유
--   짐작이 아니다. Candidate Generation 계약이 provenance를
--   모델에게 보이면 안 되는 항목으로 이미 못 박아 두었다.
--   그러니 이 길이 그것을 실어 나를 이유가 없다.
--
--   사람이 근거를 보아야 하는 자리는 검토 꾸러미다. 그 길은 따로 있고,
--   그 길은 로그인한 검토자만 쓴다. 서버 열쇠로는 못 쓴다. 두 길을 섞지 않는다.
--
-- 줄 번호와 시각도 주지 않는다
--   그 둘은 보관에 대한 기록이지 연구 내용이 아니다.
--   모델에게 보여줄 것을 고르는 데 쓰이지 않는다.
--
-- 아직 서버에 적용하지 않았다. 적용 시점은 사용자가 정한다.
-- 이 함수를 부르는 실행 코드도 아직 없다.

------------------------------------------------------------------
-- 지문 하나로 연구 결과 한 건 읽기
------------------------------------------------------------------

-- create or replace를 쓰지 않는다.
-- 같은 이름의 함수가 이미 있으면 덮어쓰지 말고 실패해야 한다.
-- 덮어쓰기가 되면 권한이 붙은 함수의 속을 조용히 바꿀 수 있다.
--
-- 앞서 만든 Prioritizer 읽기 함수와 같은 규칙이다.
create function public.get_biblical_research_result_for_candidate_generation(
  p_research_result_hash text
)
returns jsonb
language sql
security definer
stable
set search_path = private, pg_catalog
as $$
  -- 두 가지를 본다.
  --
  --   하나. 받은 지문의 모양이 맞는가.
  --   둘.  그 지문의 줄이 있는가.
  --
  -- 첫 번째 조건은 표의 칸을 보지 않는다. 받은 값만 본다.
  -- 그래서 어떤 줄이 걸리는지를 넓히거나 좁히지 못한다. 막기만 한다.
  --
  -- 이 모양 검사의 주인은 애플리케이션 계약이다
  -- (research-result-store-contract.ts 의 RESEARCH_RESULT_HASH_FORMAT).
  -- 여기 있는 것은 그 사본이지 두 번째 주인이 아니다.
  -- 둘이 어긋났는지는 migration 시험이 대조한다.
  --
  -- 두 번째 조건은 정확히 같은 값인지만 본다.
  -- 앞자리 비교도, 부분 비교도, 목록 비교도 하지 않는다.
  --
  -- 몇 줄이 나올 수 있는가.
  --   result_hash 에 유일 조건(research_result_hash_unique)이 걸려 있다.
  --   같은 값으로 찾으면 나올 수 있는 줄은 많아야 하나다.
  --   그래서 여기서 건수를 따로 자르지 않는다. 자르지 않아도 하나다.
  --
  -- 없으면 아무것도 돌려주지 않는다.
  --   대신 다른 줄을 주지 않는다. 새로 적지 않는다. 다시 찾지 않는다.
  select r.result
    from private.research_result r
   where p_research_result_hash ~ '^rres_[0-9a-f]{64}$'
     and r.result_hash = p_research_result_hash;
$$;

comment on function public.get_biblical_research_result_for_candidate_generation(text) is
  '보관된 연구 결과 한 건을 정확한 지문 하나로 읽어 온다. 연구 결과 본문만 돌려주고 줄 번호와 시각과 근거 기록은 돌려주지 않는다. 아무것도 고치지 않는다.';

------------------------------------------------------------------
-- 권한
------------------------------------------------------------------

-- 서버만 부를 수 있게 한다. 표 자체의 권한은 그대로 둔다(직접 SELECT는 계속 불가능).
--
-- 새로 만든 함수는 기본으로 아무나 실행할 수 있다.
-- 그래서 먼저 전부 회수하고, 필요한 하나에만 준다.
revoke all on function public.get_biblical_research_result_for_candidate_generation(text) from public;
revoke all on function public.get_biblical_research_result_for_candidate_generation(text)
  from anon, authenticated, service_role;
grant execute on function public.get_biblical_research_result_for_candidate_generation(text) to service_role;
