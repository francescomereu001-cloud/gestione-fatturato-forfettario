-- PR2: authenticated ownership. Existing financial rows intentionally remain unassigned.
begin;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.invoices add column if not exists user_id uuid default auth.uid();
alter table public.tax_payments add column if not exists user_id uuid default auth.uid();
alter table public.tax_settings add column if not exists user_id uuid default auth.uid();

-- PostgreSQL has no ADD CONSTRAINT IF NOT EXISTS. Check each table before adding the FK.
do $$
declare
  table_name text;
  constraint_name text;
begin
  foreach table_name in array array['invoices', 'tax_payments', 'tax_settings'] loop
    constraint_name := table_name || '_user_id_fkey';
    if not exists (
      select 1 from pg_constraint
      where conname = constraint_name
        and conrelid = format('public.%I', table_name)::regclass
    ) then
      execute format(
        'alter table public.%I add constraint %I foreign key (user_id) references auth.users(id)',
        table_name,
        constraint_name
      );
    end if;
  end loop;
end $$;

create index if not exists invoices_user_id_idx on public.invoices(user_id);
create index if not exists tax_payments_user_id_idx on public.tax_payments(user_id);
create index if not exists tax_settings_user_id_idx on public.tax_settings(user_id);

alter table public.profiles enable row level security;
alter table public.invoices enable row level security;
alter table public.tax_payments enable row level security;
alter table public.tax_settings enable row level security;

revoke all on public.invoices, public.tax_payments, public.tax_settings from anon;
grant select, insert, update, delete
  on public.invoices, public.tax_payments, public.tax_settings
  to authenticated;

drop policy if exists profiles_select_own on public.profiles;
drop policy if exists profiles_insert_own on public.profiles;
drop policy if exists profiles_update_own on public.profiles;
drop policy if exists profiles_delete_own on public.profiles;
create policy profiles_select_own on public.profiles for select to authenticated using ((select auth.uid()) = id);
create policy profiles_insert_own on public.profiles for insert to authenticated with check ((select auth.uid()) = id);
create policy profiles_update_own on public.profiles for update to authenticated using ((select auth.uid()) = id) with check ((select auth.uid()) = id);
create policy profiles_delete_own on public.profiles for delete to authenticated using ((select auth.uid()) = id);

do $$
declare
  table_name text;
  existing_policy record;
begin
  foreach table_name in array array['invoices', 'tax_payments', 'tax_settings'] loop
    for existing_policy in
      select policyname
      from pg_policies
      where schemaname = 'public' and tablename = table_name
    loop
      execute format('drop policy %I on public.%I', existing_policy.policyname, table_name);
    end loop;

    execute format('create policy %I on public.%I for select to authenticated using ((select auth.uid()) = user_id)', table_name || '_select_own', table_name);
    execute format('create policy %I on public.%I for insert to authenticated with check ((select auth.uid()) = user_id)', table_name || '_insert_own', table_name);
    execute format('create policy %I on public.%I for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id)', table_name || '_update_own', table_name);
    execute format('create policy %I on public.%I for delete to authenticated using ((select auth.uid()) = user_id)', table_name || '_delete_own', table_name);
  end loop;
end $$;

commit;

-- Rollback (manual, only after evaluating dependent application/data changes): drop the
-- policies and indexes above, disable RLS only if it was not previously enabled, drop
-- profiles, then drop each user_id FK and column. Keeping rollback manual prevents an
-- accidental migration from exposing financial data or destroying completed ownership.
