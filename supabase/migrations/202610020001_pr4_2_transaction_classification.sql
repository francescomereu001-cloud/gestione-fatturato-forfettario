-- PR4.2: deterministic, owner-scoped classification and conservative reconciliation.
begin;

create table public.transaction_classification_rules (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  name text not null,
  priority integer not null default 100,
  is_active boolean not null default true,
  account_id uuid references public.accounts(id) on delete cascade,
  parser_key text,
  match_field text not null check (match_field in ('description','merchant')),
  match_operator text not null check (match_operator in ('exact','contains','starts_with')),
  pattern text not null check (nullif(btrim(pattern), '') is not null),
  amount_direction text not null default 'any' check (amount_direction in ('any','debit','credit')),
  target_transaction_type text check (target_transaction_type is null or target_transaction_type in
    ('unclassified','income','expense','internal_transfer','investment_transfer','debt_principal','debt_interest','refund','adjustment')),
  target_category_id uuid references public.transaction_categories(id) on delete set null,
  target_merchant text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (target_transaction_type is not null or target_category_id is not null or target_merchant is not null)
);

alter table public.transactions add column classification_method text
  check (classification_method is null or classification_method in ('provider_rule','user_rule','transfer_match','manual'));
alter table public.transactions add column classification_rule_id uuid references public.transaction_classification_rules(id) on delete set null;
alter table public.transactions add column classified_at timestamptz;

create index classification_rules_owner_order_idx on public.transaction_classification_rules(user_id, is_active, priority desc, created_at, id);
alter table public.transaction_classification_rules enable row level security;
revoke all on public.transaction_classification_rules from anon, authenticated;
grant select, insert, update, delete on public.transaction_classification_rules to authenticated;
create policy classification_rules_select_own on public.transaction_classification_rules for select to authenticated using ((select auth.uid()) = user_id);
create policy classification_rules_insert_own on public.transaction_classification_rules for insert to authenticated with check ((select auth.uid()) = user_id);
create policy classification_rules_update_own on public.transaction_classification_rules for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy classification_rules_delete_own on public.transaction_classification_rules for delete to authenticated using ((select auth.uid()) = user_id);

create function public.validate_classification_rule_ownership() returns trigger language plpgsql set search_path = '' as $$
begin
  if new.account_id is not null and not exists (select 1 from public.accounts where id = new.account_id and user_id = new.user_id) then
    raise exception 'account must belong to classification rule owner';
  end if;
  if new.target_category_id is not null and not exists (select 1 from public.transaction_categories where id = new.target_category_id and user_id = new.user_id) then
    raise exception 'category must belong to classification rule owner';
  end if;
  return new;
end $$;
revoke all on function public.validate_classification_rule_ownership() from public, anon, authenticated;
create trigger classification_rules_validate_ownership before insert or update on public.transaction_classification_rules
  for each row execute function public.validate_classification_rule_ownership();
create trigger classification_rules_set_updated_at before update on public.transaction_classification_rules
  for each row execute function public.set_ledger_updated_at();

-- Phases are deliberately fixed: transfers, user rules, then provider fallbacks.
create function public.classify_transactions(target_batch_id uuid default null)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  tx public.transactions;
  selected_rule public.transaction_classification_rules;
  transferred integer := 0;
  classified integer := 0;
  remaining integer := 0;
begin
  if auth.uid() is null then raise exception 'authentication required'; end if;
  if target_batch_id is not null and not exists
    (select 1 from public.import_batches where id = target_batch_id and user_id = auth.uid()) then
    raise exception 'import batch not found';
  end if;

  -- Snapshot all compatible edges. Only vertices of degree one on both sides are safe.
  with eligible as (
    select t.* from public.transactions t
    where t.user_id = auth.uid()
      and t.classification_method is distinct from 'manual' and t.reconciliation_status <> 'ignored'
      and t.transfer_group_id is null and t.transaction_type = 'unclassified'
  ), candidates as (
    select a.id aid, b.id bid, a.account_id aa, b.account_id ba
    from eligible a join public.transactions b on b.user_id = a.user_id and b.id <> a.id
      and b.account_id <> a.account_id and b.amount = -a.amount
      and abs(b.transaction_date - a.transaction_date) <= 3
      and b.reconciliation_status <> 'ignored' and b.transfer_group_id is null
      and b.transaction_type = 'unclassified' and b.classification_method is distinct from 'manual'
    where a.id < b.id and (target_batch_id is null or a.import_batch_id = target_batch_id or b.import_batch_id = target_batch_id)
  ), degrees as (
    select id, count(*) degree from (
      select aid id from candidates union all select bid from candidates
    ) edges group by id
  ), safe as (
    select c.*, gen_random_uuid() group_id,
      case when (aa_type.account_type = 'broker') <> (ba_type.account_type = 'broker')
        then 'investment_transfer' else 'internal_transfer' end transfer_type
    from candidates c join degrees da on da.id = c.aid and da.degree = 1
      join degrees db on db.id = c.bid and db.degree = 1
      join public.accounts aa_type on aa_type.id = c.aa and aa_type.user_id = auth.uid()
      join public.accounts ba_type on ba_type.id = c.ba and ba_type.user_id = auth.uid()
  ), updates as (
    update public.transactions t set
      transaction_type = s.transfer_type, transfer_account_id = case when t.id = s.aid then s.ba else s.aa end,
      transfer_group_id = s.group_id, reconciliation_status = 'confirmed', classification_method = 'transfer_match',
      classification_rule_id = null, classified_at = now()
    from safe s where t.id in (s.aid, s.bid) and t.user_id = auth.uid() returning t.id
  ) select count(*) / 2 into transferred from updates;

  -- Highest priority wins; ties are oldest rule then UUID. Text is lower/trim/collapsed whitespace.
  for tx in select * from public.transactions t
    where t.user_id = auth.uid() and (target_batch_id is null or t.import_batch_id = target_batch_id)
      and t.transaction_type = 'unclassified' and t.classification_method is distinct from 'manual'
      and t.reconciliation_status <> 'ignored' and t.transfer_group_id is null
    order by t.transaction_date, t.id for update
  loop
    selected_rule := null;
    select r.* into selected_rule from public.transaction_classification_rules r
      left join public.import_batches ib on ib.id = tx.import_batch_id and ib.user_id = auth.uid()
      where r.user_id = auth.uid() and r.is_active
        and (r.account_id is null or r.account_id = tx.account_id)
        and (r.parser_key is null or r.parser_key = ib.parser_key)
        and (r.amount_direction = 'any' or (r.amount_direction = 'debit' and tx.amount < 0) or (r.amount_direction = 'credit' and tx.amount > 0))
        and (r.target_transaction_type is null
          or (r.target_transaction_type = 'expense' and tx.amount < 0)
          or (r.target_transaction_type in ('income','refund') and tx.amount > 0)
          or r.target_transaction_type not in ('expense','income','refund'))
        and case r.match_field when 'description' then
          case r.match_operator
            when 'exact' then regexp_replace(lower(btrim(tx.description)), '\\s+', ' ', 'g') = regexp_replace(lower(btrim(r.pattern)), '\\s+', ' ', 'g')
            when 'contains' then strpos(regexp_replace(lower(btrim(tx.description)), '\\s+', ' ', 'g'), regexp_replace(lower(btrim(r.pattern)), '\\s+', ' ', 'g')) > 0
            else regexp_replace(lower(btrim(tx.description)), '\\s+', ' ', 'g') like regexp_replace(lower(btrim(r.pattern)), '\\s+', ' ', 'g') || '%'
          end
        else case r.match_operator
            when 'exact' then regexp_replace(lower(btrim(coalesce(tx.merchant,''))), '\\s+', ' ', 'g') = regexp_replace(lower(btrim(r.pattern)), '\\s+', ' ', 'g')
            when 'contains' then strpos(regexp_replace(lower(btrim(coalesce(tx.merchant,''))), '\\s+', ' ', 'g'), regexp_replace(lower(btrim(r.pattern)), '\\s+', ' ', 'g')) > 0
            else regexp_replace(lower(btrim(coalesce(tx.merchant,''))), '\\s+', ' ', 'g') like regexp_replace(lower(btrim(r.pattern)), '\\s+', ' ', 'g') || '%'
          end end
      order by r.priority desc, r.created_at, r.id limit 1;
    if selected_rule.id is not null then
      update public.transactions set transaction_type = coalesce(selected_rule.target_transaction_type, transaction_type),
        category_id = coalesce(selected_rule.target_category_id, category_id), merchant = coalesce(selected_rule.target_merchant, merchant),
        classification_method = 'user_rule', classification_rule_id = selected_rule.id, classified_at = now()
        where id = tx.id and user_id = auth.uid();
      classified := classified + 1;
    end if;
  end loop;

  -- Provider-only rules never guess semantics for generic/current-account imports.
  with updated as (
    update public.transactions t set
      transaction_type = case when t.amount < 0 then 'expense' else 'refund' end,
      classification_method = 'provider_rule', classification_rule_id = null, classified_at = now()
    from public.import_batches b where t.import_batch_id = b.id and b.user_id = auth.uid() and t.user_id = auth.uid()
      and (target_batch_id is null or t.import_batch_id = target_batch_id)
      and t.transaction_type = 'unclassified' and t.classification_method is distinct from 'manual'
      and t.reconciliation_status <> 'ignored' and t.transfer_group_id is null
      and b.parser_key in ('american_express_v1','isybank_card_v1')
      and not (b.parser_key = 'american_express_v1' and t.amount > 0
        and regexp_replace(lower(btrim(t.description)), '\\s+', ' ', 'g') like '%addebito in c/c salvo buon fine%')
    returning t.id
  ) select classified + count(*) into classified from updated;

  select count(*) into remaining from public.transactions t where t.user_id = auth.uid()
    and (target_batch_id is null or t.import_batch_id = target_batch_id)
    and t.transaction_type = 'unclassified' and t.reconciliation_status <> 'ignored';
  return jsonb_build_object('classified_count', classified, 'transfer_count', transferred, 'unclassified_count', remaining);
end $$;
revoke all on function public.classify_transactions(uuid) from public, anon;
grant execute on function public.classify_transactions(uuid) to authenticated;

-- Manual confirmation uses the same complete audit trail as automatic matching.
create or replace function public.link_transfer(first_transaction_id uuid, second_transaction_id uuid, target_type text)
returns uuid language plpgsql security invoker set search_path = '' as $$
declare
  first_row public.transactions; second_row public.transactions; group_id uuid := gen_random_uuid();
  first_account_type text; second_account_type text;
begin
  if target_type not in ('internal_transfer', 'investment_transfer') then raise exception 'invalid transfer type'; end if;
  select * into first_row from public.transactions where id = first_transaction_id and user_id = auth.uid() for update;
  select * into second_row from public.transactions where id = second_transaction_id and user_id = auth.uid() for update;
  if first_row.id is null or second_row.id is null then raise exception 'transactions not found'; end if;
  if first_row.account_id = second_row.account_id or first_row.amount <> -second_row.amount
    or abs(first_row.transaction_date - second_row.transaction_date) > 3
    or first_row.reconciliation_status = 'ignored' or second_row.reconciliation_status = 'ignored'
    or first_row.transfer_group_id is not null or second_row.transfer_group_id is not null
    or first_row.transaction_type <> 'unclassified' or second_row.transaction_type <> 'unclassified'
    then raise exception 'transactions are not a conservative transfer match'; end if;
  select account_type into first_account_type from public.accounts where id = first_row.account_id and user_id = auth.uid();
  select account_type into second_account_type from public.accounts where id = second_row.account_id and user_id = auth.uid();
  if target_type = 'investment_transfer' and ((first_account_type = 'broker') = (second_account_type = 'broker'))
    then raise exception 'investment transfer requires exactly one broker account'; end if;
  if target_type = 'internal_transfer' and (first_account_type = 'broker' or second_account_type = 'broker')
    then raise exception 'broker pairs must use investment_transfer'; end if;
  update public.transactions set transaction_type = target_type, transfer_account_id = second_row.account_id,
    transfer_group_id = group_id, reconciliation_status = 'confirmed', classification_method = 'transfer_match', classification_rule_id = null, classified_at = now() where id = first_row.id and user_id = auth.uid();
  update public.transactions set transaction_type = target_type, transfer_account_id = first_row.account_id,
    transfer_group_id = group_id, reconciliation_status = 'confirmed', classification_method = 'transfer_match', classification_rule_id = null, classified_at = now() where id = second_row.id and user_id = auth.uid();
  return group_id;
end $$;
revoke all on function public.link_transfer(uuid, uuid, text) from public, anon;
grant execute on function public.link_transfer(uuid, uuid, text) to authenticated;


commit;
