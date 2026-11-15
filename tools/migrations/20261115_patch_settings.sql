-- Этап 6 (15 ноября): два экрана правят «Правила» одновременно — ни одна правка не теряется.
-- Раньше экран записывал все правила целиком, и последний записавший затирал чужую правку.
-- Теперь экран присылает только изменённые правила (js/store.js, saveSettings), а база дописывает их
-- к остальным одним действием. Применена к проекту molochny-mir миграцией patch_settings.
create or replace function public.patch_settings(patch jsonb) returns void
language sql security invoker set search_path = ''
as $$
  insert into public.app_settings (id, data, updated_at) values (1, coalesce(patch, '{}'::jsonb), now())
  on conflict (id) do update set data = coalesce(public.app_settings.data, '{}'::jsonb) || coalesce(excluded.data, '{}'::jsonb), updated_at = now();
$$;
grant execute on function public.patch_settings(jsonb) to anon, authenticated;
