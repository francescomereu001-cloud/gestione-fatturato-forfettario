-- PR4.4: explicit instrument routing, persistent mappings and counted history.
-- No historical rows are updated or deleted by this migration.
begin;

alter table public.import_rows
  add column source_instrument text,
  add column target_account_id uuid references public.accounts(id) on delete restrict;
create index import_rows_target_account_idx on public.import_rows(target_account_id)
  where target_account_id is not null;
create index import_rows_imported_account_fingerprint_idx
  on public.import_rows(user_id, target_account_id, dedupe_fingerprint, matched_transaction_id)
  where status = 'imported' and dedupe_fingerprint is not null;

create function public.normalize_import_instrument(value text)
returns text language sql immutable strict security invoker set search_path = ''
as $$ select lower(btrim(regexp_replace(value, '[[:space:]]+', ' ', 'g'))) $$;
revoke all on function public.normalize_import_instrument(text) from public, anon;
grant execute on function public.normalize_import_instrument(text) to authenticated;

create function public.import_instrument_account_type(value text)
returns text language sql immutable security invoker set search_path = ''
as $$ select case
  when public.normalize_import_instrument(value) ~ '^carta di credito( |$)' then 'credit_card'
  when public.normalize_import_instrument(value) ~ '^conto( |$)' then 'checking'
  else null end $$;
revoke all on function public.import_instrument_account_type(text) from public, anon;
grant execute on function public.import_instrument_account_type(text) to authenticated;

-- Persist canonical keys; labels/original metadata stay on import_rows/raw_data.
create table public.import_account_mappings (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  parser_key text not null check (nullif(btrim(parser_key), '') is not null),
  source_instrument text not null check (nullif(btrim(source_instrument), '') is not null),
  account_id uuid not null references public.accounts(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(user_id, parser_key, source_instrument)
);
alter table public.import_account_mappings enable row level security;
revoke all on public.import_account_mappings from public, anon, authenticated;
grant select, insert, update, delete on public.import_account_mappings to authenticated;
create policy import_account_mappings_select_own on public.import_account_mappings
  for select to authenticated using ((select auth.uid()) = user_id);
create policy import_account_mappings_insert_own on public.import_account_mappings
  for insert to authenticated with check ((select auth.uid()) = user_id);
create policy import_account_mappings_update_own on public.import_account_mappings
  for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy import_account_mappings_delete_own on public.import_account_mappings
  for delete to authenticated using ((select auth.uid()) = user_id);

create function public.validate_import_account_mapping()
returns trigger language plpgsql security invoker set search_path = '' as $$
begin
  new.source_instrument := public.normalize_import_instrument(new.source_instrument);
  new.updated_at := now();
  if not exists (select 1 from public.accounts a where a.id = new.account_id and a.user_id = new.user_id
    and a.is_active
    and (new.parser_key <> 'isybank_operations_v1'
      or public.import_instrument_account_type(new.source_instrument) is null
      or a.account_type = public.import_instrument_account_type(new.source_instrument)))
    then raise exception 'mapping account must belong to owner and be compatible'; end if;
  return new;
end $$;
revoke all on function public.validate_import_account_mapping() from public, anon, authenticated;
create trigger import_account_mappings_validate before insert or update on public.import_account_mappings
  for each row execute function public.validate_import_account_mapping();

-- Count actual ledger transactions, not prior preview/duplicate rows.
-- The transaction's CURRENT account also handles later audited historical rerouting.
create function public.import_dedup_history(target_account uuid, external_ids text[], fingerprints text[])
returns table(external_id text, dedupe_fingerprint text, occurrences bigint)
language plpgsql security invoker set search_path = '' as $$
begin
  if not exists (select 1 from public.accounts where id = target_account and user_id = auth.uid())
    then raise exception 'dedup account must belong to caller'; end if;
  return query
    select t.external_id, null::text, count(*)
    from public.transactions t where t.user_id = auth.uid() and t.account_id = target_account
      and t.source = 'bank_import' and t.external_id = any(external_ids)
    group by t.external_id
    union all
    select null::text, history.dedupe_fingerprint, count(*)
    from (
      select distinct t.id, r.dedupe_fingerprint
      from public.import_rows r join public.transactions t on t.id = r.matched_transaction_id
      where r.user_id = auth.uid() and t.user_id = auth.uid() and t.account_id = target_account
        and r.status = 'imported' and r.dedupe_fingerprint = any(fingerprints)
    ) history group by history.dedupe_fingerprint;
end $$;
revoke all on function public.import_dedup_history(uuid, text[], text[]) from public, anon;
grant execute on function public.import_dedup_history(uuid, text[], text[]) to authenticated;

create or replace function public.validate_import_row_ownership() returns trigger language plpgsql security invoker set search_path = '' as $$
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

  if new.target_account_id is not null and not exists (
    select 1 from public.accounts a where a.id = new.target_account_id and a.user_id = new.user_id
      and (public.import_instrument_account_type(new.source_instrument) is null
        or a.account_type = public.import_instrument_account_type(new.source_instrument))
  ) then raise exception 'target account must belong to row owner and be compatible'; end if;
  return new;
end $$;
create or replace function public.validate_transaction_ownership() returns trigger language plpgsql security invoker set search_path = '' as $$
begin
  if not exists (select 1 from public.accounts where id = new.account_id and user_id = new.user_id) then raise exception 'account must belong to transaction owner'; end if;
  if new.transfer_account_id is not null and not exists (select 1 from public.accounts where id = new.transfer_account_id and user_id = new.user_id) then raise exception 'transfer account must belong to transaction owner'; end if;
  if new.category_id is not null and not exists (select 1 from public.transaction_categories where id = new.category_id and user_id = new.user_id) then raise exception 'category must belong to transaction owner'; end if;
  if new.import_batch_id is not null and not exists
    (select 1 from public.import_batches where id = new.import_batch_id and user_id = new.user_id)
    then raise exception 'import batch must belong to transaction owner'; end if;
  return new;
end $$;

create or replace function public.commit_import_batch(target_batch_id uuid)
returns integer language plpgsql security invoker set search_path = '' as $$
declare
  owned_batch public.import_batches;
  ready_row public.import_rows;
  inserted_id uuid;
  imported_total integer := 0;
  final_amount numeric;
begin
  select * into owned_batch from public.import_batches
    where id = target_batch_id and user_id = auth.uid() for update;
  if owned_batch.id is null then raise exception 'import batch not found'; end if;
  if owned_batch.status <> 'preview' then raise exception 'import batch is not commit-ready'; end if;
  perform 1 from public.import_rows where batch_id = owned_batch.id and user_id = auth.uid() for update;


  -- Lock all effective accounts in stable order; validate routing before any insert.
  perform a.id from public.accounts a where a.user_id = auth.uid() and a.id in
    (select coalesce(r.target_account_id, owned_batch.account_id) from public.import_rows r
      where r.batch_id = owned_batch.id and r.user_id = auth.uid() and r.status = 'ready')
    order by a.id for share;
  if exists (
    select 1 from public.import_rows r where r.batch_id = owned_batch.id and r.user_id = auth.uid() and r.status = 'ready'
      and ((nullif(btrim(r.source_instrument), '') is not null and r.target_account_id is null)
        or not exists (select 1 from public.accounts a
          where a.id = coalesce(r.target_account_id, owned_batch.account_id) and a.user_id = auth.uid()
            and a.is_active
            and (public.import_instrument_account_type(r.source_instrument) is null
              or a.account_type = public.import_instrument_account_type(r.source_instrument))
            and (a.opening_balance = 0 or a.balance_as_of is not null)))
  ) then raise exception 'one or more ready rows have missing, invalid or incompatible target accounts or balance dates'; end if;
  if (select count(*) from public.import_rows where batch_id = owned_batch.id and user_id = auth.uid()) <> owned_batch.row_count
    then raise exception 'import staging is incomplete'; end if;

  -- Validate the complete ready set before writing the first transaction.
  if exists (select 1 from public.import_rows where batch_id = owned_batch.id and user_id = auth.uid() and status = 'ready'
    and (transaction_date is null or amount is null or amount = 0 or nullif(btrim(description), '') is null
      or suggested_transaction_type is null
      or suggested_transaction_type not in ('unclassified','income','expense','internal_transfer','investment_transfer','debt_principal','debt_interest','refund','adjustment')))
    then raise exception 'one or more ready rows are invalid'; end if;
  if exists (select 1 from public.import_rows r where r.batch_id = owned_batch.id and r.user_id = auth.uid() and r.status = 'ready'
    and r.suggested_category_id is not null and not exists
      (select 1 from public.transaction_categories c where c.id = r.suggested_category_id and c.user_id = auth.uid()))
    then raise exception 'one or more categories do not belong to batch owner'; end if;

  for ready_row in select * from public.import_rows
    where batch_id = owned_batch.id and user_id = auth.uid() and status = 'ready'
    order by row_index for update
  loop
    final_amount := case
      when ready_row.suggested_transaction_type in ('income', 'refund') then abs(ready_row.amount)
      when ready_row.suggested_transaction_type in ('expense', 'debt_interest', 'debt_principal') then -abs(ready_row.amount)
      else ready_row.amount
    end;
    insert into public.transactions (
      user_id, account_id, transaction_date, booking_date, amount, description, merchant,
      category_id, transaction_type, source, external_id, reconciliation_status, import_batch_id
    ) values (
      auth.uid(), coalesce(ready_row.target_account_id, owned_batch.account_id), ready_row.transaction_date, ready_row.booking_date,
      final_amount, btrim(ready_row.description), ready_row.merchant, ready_row.suggested_category_id,
      ready_row.suggested_transaction_type, 'bank_import', ready_row.external_id, 'pending', owned_batch.id
    ) returning id into inserted_id;
    update public.import_rows set status = 'imported', matched_transaction_id = inserted_id
      where id = ready_row.id and user_id = auth.uid();
    imported_total := imported_total + 1;
  end loop;

  update public.import_batches set
    status = 'completed', completed_at = now(),
    imported_count = (select count(*) from public.import_rows where batch_id = owned_batch.id and status = 'imported'),
    duplicate_count = (select count(*) from public.import_rows where batch_id = owned_batch.id and status = 'duplicate'),
    ignored_count = (select count(*) from public.import_rows where batch_id = owned_batch.id and status = 'ignored'),
    error_count = (select count(*) from public.import_rows where batch_id = owned_batch.id and status = 'error')
    where id = owned_batch.id and user_id = auth.uid();
  return imported_total;
end $$;
revoke all on function public.commit_import_batch(uuid) from public, anon;
grant execute on function public.commit_import_batch(uuid) to authenticated;


commit;
