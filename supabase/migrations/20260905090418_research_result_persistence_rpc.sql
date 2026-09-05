-- 아뢰다 · 연구 결과 적어 두기
--
-- 무엇을 위한 것인가
--   앞 migration이 연구 결과를 담을 표를 만들었다.
--   그런데 그 표에 닿는 길을 일부러 만들지 않았다. 권한이 모두 회수돼 있다.
--
--   이 함수가 그 하나뿐인 길이다.
--   앞의 보관소들과 같은 방식이다. 표를 직접 열어 주지 않고 함수 하나만 연다.
--
-- 왜 표를 직접 열지 않는가
--   표를 열어 주면 그 순간부터 무엇을 적을지 부르는 쪽이 정한다.
--   함수만 열면 무엇을 적을 수 있는지 서버가 정한다.
--   줄 번호와 적은 시각은 여기서 붙이고, 부르는 쪽은 정하지 못한다.
--
-- 같은 연구가 두 번 오면
--   그물이 끊겨 다시 보내는 일은 흔하다. 그때마다 줄이 늘어나면 안 된다.
--   그래서 세 갈래로 나눈다.
--
--     처음 보는 지문        → 새로 적고 새 번호를 준다
--     같은 지문 + 같은 내용  → 적지 않고 원래 번호를 준다
--     같은 지문 + 다른 내용  → 거절한다
--
--   세 번째가 중요하다.
--   지문이 같은데 내용이 다르다는 것은 둘 중 하나가 잘못됐다는 뜻이다.
--   그때 조용히 넘기면 어느 쪽이 진짜인지 아무도 모르게 된다.
--   덮어쓰지도 않고 삼키지도 않는다. 멈추고 알린다.
--
-- 지문은 여기서 계산하지 않는다
--   연구 결과의 지문은 애플리케이션이 만든다
--   (research-result-store-contract.ts의 computeResearchResultHash).
--
--   여기서 다시 계산하지 않는다. 같은 계산을 두 곳에 두면
--   두 곳이 언젠가 서로 다른 답을 내고, 그때 무엇이 맞는지 알 수 없다.
--
--   그래서 이 함수가 아는 것은 이만큼이다.
--     지문의 모양이 맞는가        — 표의 조건이 본다
--     같은 지문이 이미 있는가      — 표의 유일 조건이 본다
--     같은 지문이면 내용도 같은가  — 이 함수가 본다
--
--   "받은 지문이 정말 그 내용의 지문인가"는 보지 않는다.
--   그것은 부르기 전에 애플리케이션이 확인할 일이다.
--   이 함수는 부르는 쪽이 이미 검증을 마쳤다고 전제한다.
--
-- 이 함수가 하지 않는 일
--   고치지 않는다. 지우지 않는다. 비우지 않는다.
--   적고(INSERT), 겹칠 때 한 줄 읽는(SELECT) 것이 전부다.
--   앞 migration이 걸어 둔 방아쇠를 건드리지 않는다.
--
--   연구 내용 안을 들여다보지 않는다. 자료 수를 세지 않고 근거를 검사하지 않는다.
--   그 판단은 이미 애플리케이션의 계약이 했다.
--
-- 이 migration은 아직 서버에 적용하지 않았다.
-- 이 함수를 부르는 실행 코드도 아직 없다.

------------------------------------------------------------------
-- 연구 결과 한 건 적어 두기
------------------------------------------------------------------

create or replace function public.store_biblical_research_result(
  p_result_hash text,
  p_result jsonb,
  p_provenance jsonb
)
returns uuid
language plpgsql
security definer
set search_path = private, pg_catalog
as $$
declare
  v_research_result_id uuid;
  v_existing_result jsonb;
  v_existing_provenance jsonb;
begin
  -- 받는 값은 셋뿐이다. 줄 번호와 적은 시각은 서버가 붙인다.
  --
  -- 연구 결과 안의 값(영역 이름, 근거 판본, 근거 꾸러미 지문 등)을
  -- 따로 받지 않는다. 따로 받으면 결과와 어긋난 값이 들어올 수 있다.
  --
  -- 빈 값, 지문의 모양, 객체 여부는 표의 조건이 막는다. 여기서 다시 보지 않는다.
  insert into private.research_result (result_hash, result, provenance)
  values (p_result_hash, p_result, p_provenance)
  on conflict (result_hash) do nothing
  returning research_result_id into v_research_result_id;

  -- 처음 적힌 경우. 새 번호를 돌려준다.
  if v_research_result_id is not null then
    return v_research_result_id;
  end if;

  -- 여기까지 왔다면 같은 지문이 이미 있다는 뜻이다.
  -- 다시 보낸 것인지, 다른 내용인지 확인해야 한다.
  --
  -- 비교에 필요한 것만 읽는다. 적은 시각은 비교에 쓰지 않으므로 읽지 않는다.
  select research_result_id, result, provenance
    into v_research_result_id, v_existing_result, v_existing_provenance
    from private.research_result
   where result_hash = p_result_hash;

  -- 아주 드물게 그 사이 줄이 사라졌다면(있어서는 안 되는 일이다)
  -- 짐작해서 다시 적지 않는다. 멈춘다.
  if v_research_result_id is null then
    raise exception '연구 결과를 적지 못했습니다.'
      using errcode = 'internal_error';
  end if;

  -- 같은 지문에 같은 내용이면 다시 보낸 것이다.
  --
  -- jsonb 비교는 항목을 적은 순서를 따지지 않는다. 같은 내용이면 같다고 본다.
  -- 배열의 차례는 따진다. 연구에서 차례는 뜻을 가지므로 그래야 맞다.
  if v_existing_result = p_result and v_existing_provenance = p_provenance then
    return v_research_result_id;
  end if;

  -- 지문은 같은데 내용이 다르다. 둘 중 하나가 잘못됐다.
  --
  -- 덮어쓰지 않는다. 조용히 넘기지도 않는다.
  -- 무엇이 어떻게 다른지는 알리지 않는다. 저장된 내용이 오류 문구를 타고 나가면 안 된다.
  raise exception '같은 지문으로 다른 연구 결과가 들어왔습니다.'
    using errcode = 'unique_violation';
end;
$$;

comment on function public.store_biblical_research_result(text, jsonb, jsonb) is
  '검증을 마친 연구 결과 한 건을 적고 번호만 돌려준다. 같은 지문에 같은 내용이면 다시 적지 않고 원래 번호를 준다. 같은 지문에 다른 내용이면 거절한다. 지문을 여기서 다시 계산하지 않는다.';

revoke all on function public.store_biblical_research_result(text, jsonb, jsonb) from public;
revoke all on function public.store_biblical_research_result(text, jsonb, jsonb)
  from anon, authenticated, service_role;
grant execute on function public.store_biblical_research_result(text, jsonb, jsonb) to service_role;
