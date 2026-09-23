-- 사용자용 Edge Function이 활성 카탈로그 포인터와 그 카탈로그를 한 스냅샷으로 읽는다.
-- 사용자 문장·식별자·자격 증명은 입력이나 출력에 없다.

create function public.get_active_scripture_catalog_runtime()
returns jsonb
language sql
stable
security definer
set search_path = private, pg_catalog
as $$
  select jsonb_build_object(
    'activeVersionHash', p.active_version_hash,
    'pointerRevision', p.pointer_revision,
    'catalog', v.catalog
  )
    from private.scripture_catalog_active_pointer as p
    join private.scripture_catalog_version as v
      on v.version_hash = p.active_version_hash
   where p.singleton
$$;

comment on function public.get_active_scripture_catalog_runtime() is
  '사용자용 Edge Function이 활성 포인터와 정확히 같은 버전의 카탈로그를 원자적으로 읽는다.';

revoke all on function public.get_active_scripture_catalog_runtime() from public;
revoke all on function public.get_active_scripture_catalog_runtime()
  from anon, authenticated, service_role;
grant execute on function public.get_active_scripture_catalog_runtime() to service_role;
