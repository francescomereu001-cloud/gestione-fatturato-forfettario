-- PR3: owner-scoped accounts, explicit accounting classifications and reconciliation-ready transactions.
begin;

create table public.accounts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  name text not null,
  institution text,
  account_type text not null check (account_type in ('checking','savings','credit_card','broker','cash','technical','other')),
  currency text not null default 'EUR',
  opening_balance numeric not null default 0,
  is_active boolean not null default true,
  include_in_liquidity boolean not null default true,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.transaction_categories (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  name text not null,
  category_type text not null check (category_type in ('income','expense','transfer','asset','liability')),
  parent_id uuid references public.transaction_categories(id) on delete set null,
  system_key text,
  created_at timestamptz not null default now(),
  unique (user_id, system_key)
);

create table public.transactions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  account_id uuid not null references public.accounts(id) on delete restrict,
  transaction_date date not null,
  booking_date date,
  amount numeric not null check (
    amount <> 0
    and case
      when transaction_type in ('income', 'refund') then amount > 0
      when transaction_type in ('expense', 'debt_interest', 'debt_principal') then amount < 0
      else true
    end
  ),
  description text not null,
  merchant text,
  category_id uuid references public.transaction_categories(id) on delete set null,
  transaction_type text not null check (transaction_type in ('income','expense','internal_transfer','investment_transfer','debt_principal','debt_interest','refund','adjustment')),
  transfer_account_id uuid references public.accounts(id) on delete restrict,
  transfer_group_id uuid,
  source text not null default 'manual',
  external_id text,
  reconciliation_status text not null default 'pending' check (reconciliation_status in ('pending','confirmed','ignored')),
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, source, external_id)
);

create index accounts_user_id_idx on public.accounts(user_id);
create index transaction_categories_user_id_idx on public.transaction_categories(user_id);
create index transactions_user_date_idx on public.transactions(user_id, transaction_date desc);
create index transactions_account_id_idx on public.transactions(account_id);
create index transactions_transfer_group_id_idx on public.transactions(transfer_group_id) where transfer_group_id is not null;

alter table public.accounts enable row level security;
alter table public.transaction_categories enable row level security;
alter table public.transactions enable row level security;
revoke all on
  public.accounts,
  public.transaction_categories,
  public.transactions
from anon, authenticated;
grant select, insert, update, delete on public.accounts, public.transaction_categories, public.transactions to authenticated;

do $$
declare table_name text;
begin
  foreach table_name in array array['accounts', 'transaction_categories', 'transactions'] loop
    execute format('create policy %I on public.%I for select to authenticated using ((select auth.uid()) = user_id)', table_name || '_select_own', table_name);
    execute format('create policy %I on public.%I for insert to authenticated with check ((select auth.uid()) = user_id)', table_name || '_insert_own', table_name);
    execute format('create policy %I on public.%I for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id)', table_name || '_update_own', table_name);
    execute format('create policy %I on public.%I for delete to authenticated using ((select auth.uid()) = user_id)', table_name || '_delete_own', table_name);
  end loop;
end $$;

-- Cross-table ownership cannot be guaranteed by a simple FK, so validate every reference explicitly.
create function public.validate_transaction_ownership() returns trigger language plpgsql set search_path = '' as $$
begin
  if not exists (select 1 from public.accounts where id = new.account_id and user_id = new.user_id) then raise exception 'account must belong to transaction owner'; end if;
  if new.transfer_account_id is not null and not exists (select 1 from public.accounts where id = new.transfer_account_id and user_id = new.user_id) then raise exception 'transfer account must belong to transaction owner'; end if;
  if new.category_id is not null and not exists (select 1 from public.transaction_categories where id = new.category_id and user_id = new.user_id) then raise exception 'category must belong to transaction owner'; end if;
  return new;
end $$;
revoke all on function public.validate_transaction_ownership() from public, anon, authenticated;
create trigger transactions_validate_ownership before insert or update on public.transactions for each row execute function public.validate_transaction_ownership();

create function public.validate_category_parent_ownership() returns trigger language plpgsql set search_path = '' as $$
begin
  if new.parent_id is not null and not exists (select 1 from public.transaction_categories where id = new.parent_id and user_id = new.user_id) then raise exception 'parent category must belong to category owner'; end if;
  return new;
end $$;
revoke all on function public.validate_category_parent_ownership() from public, anon, authenticated;
create trigger categories_validate_parent before insert or update on public.transaction_categories for each row execute function public.validate_category_parent_ownership();

create function public.set_ledger_updated_at() returns trigger language plpgsql set search_path = '' as $$
begin
  new.updated_at = now();
  return new;
end $$;
revoke all on function public.set_ledger_updated_at() from public, anon, authenticated;
create trigger accounts_set_updated_at before update on public.accounts for each row execute function public.set_ledger_updated_at();
create trigger transactions_set_updated_at before update on public.transactions for each row execute function public.set_ledger_updated_at();

commit;
