-- PR4: auditable bank-statement staging, deduplication and reconciliation.
begin;

alter table public.accounts add column balance_as_of date;

-- Imported movements remain economically neutral until a person classifies them.
alter table public.transactions drop constraint transactions_transaction_type_check;
alter table public.transactions add constraint transactions_transaction_type_check check (transaction_type in
  ('unclassified','income','expense','internal_transfer','investment_transfer','debt_principal','debt_interest','refund','adjustment'));

create table public.import_batches (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  account_id uuid not null references public.accounts(id) on delete restrict,
  filename text,
  file_hash text,
  source_format text not null check (source_format in ('csv','xlsx')),
  parser_key text,
  status text not null default 'preview' check (status in ('preview','processing','completed','failed','cancelled')),
  row_count integer not null default 0 check (row_count >= 0),
  imported_count integer not null default 0 check (imported_count >= 0),
  duplicate_count integer not null default 0 check (duplicate_count >= 0),
  ignored_count integer not null default 0 check (ignored_count >= 0),
  error_count integer not null default 0 check (error_count >= 0),
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  notes text
);

create table public.import_rows (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  batch_id uuid not null references public.import_batches(id) on delete cascade,
  row_index integer not null check (row_index >= 0),
  transaction_date date,
  booking_date date,
  amount numeric,
  description text,
  merchant text,
  external_id text,
  dedupe_fingerprint text,
  suggested_transaction_type text check (suggested_transaction_type is null or suggested_transaction_type in
    ('unclassified','income','expense','internal_transfer','investment_transfer','debt_principal','debt_interest','refund','adjustment')),
  suggested_category_id uuid references public.transaction_categories(id) on delete set null,
  status text not null default 'pending' check (status in ('pending','ready','possible_duplicate','duplicate','imported','ignored','error')),
  matched_transaction_id uuid references public.transactions(id) on delete set null,
  raw_data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (batch_id, row_index)
);

alter table public.transactions add column import_batch_id uuid references public.import_batches(id) on delete set null;
alter table public.transactions drop constraint transactions_user_id_source_external_id_key;
create unique index transactions_external_id_source_account_uidx
  on public.transactions(user_id, account_id, source, external_id) where external_id is not null;

create index import_batches_user_created_idx on public.import_batches(user_id, created_at desc);
create index import_batches_account_idx on public.import_batches(account_id);
create unique index import_batches_file_account_uidx on public.import_batches(user_id, account_id, file_hash)
  where file_hash is not null and status <> 'cancelled';
create index import_rows_batch_status_idx on public.import_rows(batch_id, status);
create index import_rows_user_fingerprint_idx on public.import_rows(user_id, dedupe_fingerprint) where dedupe_fingerprint is not null;
create index transactions_import_batch_idx on public.transactions(import_batch_id) where import_batch_id is not null;

alter table public.import_batches enable row level security;
alter table public.import_rows enable row level security;
revoke all on public.import_batches, public.import_rows from anon, authenticated;
grant select, insert, update, delete on public.import_batches, public.import_rows to authenticated;

do $$
declare table_name text;
begin
  foreach table_name in array array['import_batches', 'import_rows'] loop
    execute format('create policy %I on public.%I for select to authenticated using ((select auth.uid()) = user_id)', table_name || '_select_own', table_name);
    execute format('create policy %I on public.%I for insert to authenticated with check ((select auth.uid()) = user_id)', table_name || '_insert_own', table_name);
    execute format('create policy %I on public.%I for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id)', table_name || '_update_own', table_name);
    execute format('create policy %I on public.%I for delete to authenticated using ((select auth.uid()) = user_id)', table_name || '_delete_own', table_name);
  end loop;
end $$;

create function public.validate_import_batch_ownership() returns trigger language plpgsql set search_path = '' as $$
begin
  if not exists (select 1 from public.accounts where id = new.account_id and user_id = new.user_id) then
    raise exception 'account must belong to import batch owner';
  end if;
  return new;
end $$;
revoke all on function public.validate_import_batch_ownership() from public, anon, authenticated;
create trigger import_batches_validate_ownership before insert or update on public.import_batches
  for each row execute function public.validate_import_batch_ownership();

create function public.validate_import_row_ownership() returns trigger language plpgsql set search_path = '' as $$
declare owner_account_id uuid;
begin
  select account_id into owner_account_id from public.import_batches where id = new.batch_id and user_id = new.user_id;
  if owner_account_id is null then raise exception 'batch must belong to import row owner'; end if;
  if new.suggested_category_id is not null and not exists
    (select 1 from public.transaction_categories where id = new.suggested_category_id and user_id = new.user_id)
    then raise exception 'category must belong to import row owner'; end if;
  if new.matched_transaction_id is not null and not exists
    (select 1 from public.transactions where id = new.matched_transaction_id and user_id = new.user_id)
    then raise exception 'transaction must belong to import row owner'; end if;
  return new;
end $$;
revoke all on function public.validate_import_row_ownership() from public, anon, authenticated;
create trigger import_rows_validate_ownership before insert or update on public.import_rows
  for each row execute function public.validate_import_row_ownership();

-- Extend PR3 validation: provenance batches must have the same owner and account.
create or replace function public.validate_transaction_ownership() returns trigger language plpgsql set search_path = '' as $$
begin
  if not exists (select 1 from public.accounts where id = new.account_id and user_id = new.user_id) then raise exception 'account must belong to transaction owner'; end if;
  if new.transfer_account_id is not null and not exists (select 1 from public.accounts where id = new.transfer_account_id and user_id = new.user_id) then raise exception 'transfer account must belong to transaction owner'; end if;
  if new.category_id is not null and not exists (select 1 from public.transaction_categories where id = new.category_id and user_id = new.user_id) then raise exception 'category must belong to transaction owner'; end if;
  if new.import_batch_id is not null and not exists
    (select 1 from public.import_batches where id = new.import_batch_id and user_id = new.user_id and account_id = new.account_id)
    then raise exception 'import batch must belong to transaction owner and account'; end if;
  return new;
end $$;

-- The two legs must be linked atomically; the function remains conservative and owner-scoped.
create function public.link_internal_transfer(first_transaction_id uuid, second_transaction_id uuid)
returns uuid language plpgsql set search_path = '' as $$
declare first_row public.transactions; second_row public.transactions; group_id uuid := gen_random_uuid();
begin
  select * into first_row from public.transactions where id = first_transaction_id and user_id = auth.uid() for update;
  select * into second_row from public.transactions where id = second_transaction_id and user_id = auth.uid() for update;
  if first_row.id is null or second_row.id is null then raise exception 'transactions not found'; end if;
  if first_row.account_id = second_row.account_id
    or first_row.amount <> -second_row.amount
    or abs(first_row.transaction_date - second_row.transaction_date) > 3
    or first_row.transaction_type <> 'unclassified'
    or second_row.transaction_type <> 'unclassified'
    then raise exception 'transactions are not a conservative transfer match'; end if;
  update public.transactions set transaction_type = 'internal_transfer', transfer_account_id = second_row.account_id,
    transfer_group_id = group_id, reconciliation_status = 'confirmed' where id = first_row.id;
  update public.transactions set transaction_type = 'internal_transfer', transfer_account_id = first_row.account_id,
    transfer_group_id = group_id, reconciliation_status = 'confirmed' where id = second_row.id;
  return group_id;
end $$;
revoke all on function public.link_internal_transfer(uuid, uuid) from public, anon;
grant execute on function public.link_internal_transfer(uuid, uuid) to authenticated;

commit;
