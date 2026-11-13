-- Этап 0 (13 ноября): эталонный план.
-- Таблица base_plan хранит один эталонный план (id = 1). Читать и писать её с сайта нельзя:
-- правила доступа (RLS) включены, а разрешений нет. Её читает только reset_demo().
-- Так никто из жюри не может испортить эталон, даже имея ключ сайта.
create table if not exists public.base_plan (
  id integer primary key check (id = 1),
  assignment jsonb not null,
  summary jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);
alter table public.base_plan enable row level security;
revoke all on public.base_plan from anon, authenticated;

-- «Сбросить демо»: исходные заказы и машины, правила по умолчанию, отметок нет,
-- черновик плана — эталонный план (автор 'base'), утверждённого плана нет.
create or replace function public.reset_demo()
 returns void
 language plpgsql
 security definer
 set search_path to ''
as $function$
begin
  delete from public.orders where true;
  insert into public.orders select * from public.seed_orders;
  delete from public.vehicles where true;
  insert into public.vehicles select * from public.seed_vehicles;
  delete from public.app_settings where true;
  delete from public.plans where true;
  delete from public.driver_events where true;
  insert into public.plans (id, assignment, summary, author, updated_at)
    select 'draft', b.assignment, b.summary, 'base', now() from public.base_plan b where b.id = 1;
end;
$function$;
