-- 자동 Scripture Catalog validator가 신뢰할 수 있는 활성 카탈로그와 수요 집계를
-- 서버에서 한 번에 읽는 전용 RPC. 사용자 문장·사용자 번호·기기 정보는 받거나 돌려주지 않는다.

create function public.get_scripture_catalog_validation_context(
  p_evidence_kind text,
  p_subject_key text,
  p_window_start_date date,
  p_window_end_date date
)
returns jsonb
language plpgsql
stable
security definer
set search_path = private, pg_catalog
as $$
declare
  v_pointer private.scripture_catalog_active_pointer%rowtype;
  v_catalog jsonb;
  v_cells jsonb;
begin
  if p_evidence_kind is null
     or not (p_evidence_kind = any (array['weak_match', 'normalized_theme']))
     or p_subject_key is null
     or p_window_start_date is null
     or p_window_end_date is null
     or p_window_start_date > p_window_end_date
     or (p_window_end_date - p_window_start_date + 1) > 90
     or p_window_end_date >= (now() at time zone 'Asia/Seoul')::date then
    raise exception '검증 context 요청이 올바르지 않습니다.'
      using errcode = 'invalid_parameter_value';
  end if;

  if p_evidence_kind = 'weak_match' and p_subject_key !~ '^[a-z][a-z0-9_]{2,47}$' then
    raise exception '검증 context 요청이 올바르지 않습니다.'
      using errcode = 'invalid_parameter_value';
  end if;
  if p_evidence_kind = 'normalized_theme' and p_subject_key !~ '^sthm_[0-9a-f]{64}$' then
    raise exception '검증 context 요청이 올바르지 않습니다.'
      using errcode = 'invalid_parameter_value';
  end if;

  select * into v_pointer
    from private.scripture_catalog_active_pointer
   where singleton;
  if not found then
    raise exception '활성 카탈로그가 없습니다.'
      using errcode = 'no_data_found';
  end if;

  select catalog into v_catalog
    from private.scripture_catalog_version
   where version_hash = v_pointer.active_version_hash;
  if v_catalog is null then
    raise exception '활성 카탈로그가 없습니다.'
      using errcode = 'no_data_found';
  end if;

  if p_evidence_kind = 'weak_match' and not exists (
    select 1
      from jsonb_array_elements(v_catalog -> 'domains') as d(item)
     where item ->> 'id' = p_subject_key
  ) then
    raise exception '활성 카탈로그에 없는 영역입니다.'
      using errcode = 'invalid_parameter_value';
  end if;

  if p_evidence_kind = 'weak_match' then
    select coalesce(
      jsonb_agg(
        jsonb_build_object(
          'evidenceKind', 'weak_match',
          'subjectKey', domain_id,
          'bucketDate', bucket_date::text,
          'count', match_count
        ) order by bucket_date
      ),
      '[]'::jsonb
    ) into v_cells
      from private.scripture_demand_weak_match_daily
     where domain_id = p_subject_key
       and bucket_date between p_window_start_date and p_window_end_date;
  else
    select coalesce(
      jsonb_agg(
        jsonb_build_object(
          'evidenceKind', 'normalized_theme',
          'subjectKey', theme_fingerprint,
          'bucketDate', bucket_date::text,
          'count', theme_count
        ) order by bucket_date
      ),
      '[]'::jsonb
    ) into v_cells
      from private.scripture_demand_theme_daily
     where theme_fingerprint = p_subject_key
       and bucket_date between p_window_start_date and p_window_end_date;
  end if;

  return jsonb_build_object(
    'activeVersionHash', v_pointer.active_version_hash,
    'pointerRevision', v_pointer.pointer_revision,
    'baseCatalog', v_catalog,
    'demandCells', v_cells
  );
end;
$$;

comment on function public.get_scripture_catalog_validation_context(text, text, date, date) is
  '자동 validator가 활성 카탈로그와 한 수요 대상의 과거 날짜별 집계를 읽는다. 사용자 원문은 받거나 돌려주지 않는다.';

revoke all on function public.get_scripture_catalog_validation_context(text, text, date, date) from public;
revoke all on function public.get_scripture_catalog_validation_context(text, text, date, date)
  from anon, authenticated, service_role;
grant execute on function public.get_scripture_catalog_validation_context(text, text, date, date) to service_role;
