-- PR6: schema/functions only. No classification, backfill, or live ledger writes.
begin;
alter table public.transaction_classification_rules
  drop constraint transaction_classification_rules_match_field_check;
alter table public.transaction_classification_rules add constraint transaction_classification_rules_match_field_check
  check (match_field in ('description','merchant','provider_category','provider_operation','provider_details'));
alter table public.transaction_classification_rules add column target_transfer_account_id uuid
  references public.accounts(id) on delete restrict;
drop index public.import_rows_classification_provenance_idx;
create index import_rows_classification_provenance_idx
  on public.import_rows(user_id,matched_transaction_id,batch_id) where status in ('imported','duplicate');
create index transactions_residual_review_idx on public.transactions(user_id, account_id, transaction_date, id)
  where transaction_type='unclassified' and reconciliation_status <> 'ignored';

-- All matched provenance is consulted, including duplicates from later imports.
-- Missing/conflicting values never match a provider-field rule. Raw JSON stays server-side.
create function public.classification_metadata(transaction_id uuid)
returns jsonb language sql stable security invoker set search_path='' as $$
  select jsonb_build_object(
    'provider_category', case when count(distinct c)=1 then nullif(min(c),'') end,
    'provider_operation', case when count(distinct o)=1 then nullif(min(o),'') end,
    'provider_details', case when count(distinct d)=1 then nullif(min(d),'') end,
    'conflicting', count(distinct row(c,o,d)) > 1)
  from (
    select public.normalize_classification_text(r.raw_data->>'Categoria') c,
      public.normalize_classification_text(r.raw_data->>'Operazione') o,
      public.normalize_classification_text(r.raw_data->>'Dettagli completi') d
    from public.import_rows r join public.transactions t on t.id=r.matched_transaction_id
      join public.import_batches b on b.id=r.batch_id and b.user_id=t.user_id
    where t.id=transaction_id and t.user_id=(select auth.uid()) and r.user_id=t.user_id
      and r.status in ('imported','duplicate')
  ) provenance
$$;
revoke all on function public.classification_metadata(uuid) from public,anon;
grant execute on function public.classification_metadata(uuid) to authenticated;

create function public.validate_classification_decision(source_account uuid, decision_type text, category uuid, target_account uuid)
returns void language plpgsql stable security invoker set search_path='' as $$
declare source public.accounts; target public.accounts; category_kind text;
begin
  if auth.uid() is null then raise exception 'authentication required'; end if;
  if decision_type is null or decision_type not in
    ('unclassified','income','expense','refund','internal_transfer','investment_transfer','debt_principal','debt_interest','adjustment')
    then raise exception 'invalid transaction type'; end if;
  select * into source from public.accounts where id=source_account and user_id=auth.uid();
  if source.id is null then raise exception 'source account must belong to owner'; end if;
  if category is not null then
    select category_type into category_kind from public.transaction_categories where id=category and user_id=auth.uid();
    if category_kind is null then raise exception 'category must belong to owner'; end if;
    if (decision_type='income' and category_kind<>'income')
      or (decision_type in ('expense','refund','debt_interest') and category_kind<>'expense')
      or (decision_type='debt_principal' and category_kind<>'liability')
      or decision_type in ('internal_transfer','investment_transfer','unclassified')
      then raise exception 'category incompatible with transaction type'; end if;
  end if;
  if target_account is not null then
    select * into target from public.accounts where id=target_account and user_id=auth.uid();
    if target.id is null then raise exception 'target transfer account must belong to owner'; end if;
    if target.id=source.id then raise exception 'target transfer account must differ from source'; end if;
    if target.currency<>source.currency then raise exception 'transfer account currency incompatible'; end if;
    if decision_type not in ('internal_transfer','investment_transfer') then raise exception 'target requires transfer type'; end if;
  end if;
  if decision_type='investment_transfer' and (target.id is null or target.account_type<>'broker')
    then raise exception 'investment transfer requires broker target'; end if;
end $$;
revoke all on function public.validate_classification_decision(uuid,text,uuid,uuid) from public,anon;
grant execute on function public.validate_classification_decision(uuid,text,uuid,uuid) to authenticated;

create or replace function public.validate_classification_rule_ownership()
returns trigger language plpgsql security invoker set search_path='' as $$
declare kind text;
begin
  if new.account_id is not null and not exists(select 1 from public.accounts where id=new.account_id and user_id=new.user_id)
    then raise exception 'account must belong to classification rule owner'; end if;
  if new.target_category_id is not null then
    select category_type into kind from public.transaction_categories where id=new.target_category_id and user_id=new.user_id;
    if kind is null then raise exception 'category must belong to classification rule owner'; end if;
    if (new.target_transaction_type='income' and kind<>'income')
      or (new.target_transaction_type in ('expense','refund','debt_interest') and kind<>'expense')
      or (new.target_transaction_type='debt_principal' and kind<>'liability')
      or new.target_transaction_type in ('internal_transfer','investment_transfer','unclassified')
      then raise exception 'category incompatible with rule type'; end if;
  end if;
  if new.target_transfer_account_id is not null then
    if not exists(select 1 from public.accounts where id=new.target_transfer_account_id and user_id=new.user_id)
      then raise exception 'target transfer account must belong to classification rule owner'; end if;
    if new.target_transaction_type is null or new.target_transaction_type not in ('internal_transfer','investment_transfer')
      then raise exception 'target requires transfer type'; end if;
    if new.account_id=new.target_transfer_account_id then raise exception 'target transfer account must differ from source'; end if;
    if new.account_id is not null and exists(select 1 from public.accounts a join public.accounts b
      on b.id=new.target_transfer_account_id where a.id=new.account_id and a.currency<>b.currency)
      then raise exception 'transfer account currency incompatible'; end if;
  end if;
  if new.target_transaction_type='investment_transfer' and not exists(select 1 from public.accounts
    where id=new.target_transfer_account_id and user_id=new.user_id and account_type='broker')
    then raise exception 'investment transfer requires broker target'; end if;
  if public.normalize_classification_text(new.pattern)='' then raise exception 'empty normalized pattern'; end if;
  if new.match_field like 'provider_%' and nullif(btrim(new.parser_key),'') is null
    then raise exception 'provider rules require parser scope'; end if;
  return new;
end $$;

create function public.classification_rule_matches(tx public.transactions, rule public.transaction_classification_rules)
returns boolean language plpgsql stable security invoker set search_path='' as $$
declare value text; parser text; metadata jsonb;
begin
  if tx.user_id is distinct from auth.uid() or rule.user_id is distinct from auth.uid() or not rule.is_active
    or (rule.account_id is not null and rule.account_id<>tx.account_id) then return false; end if;
  select parser_key into parser from public.import_batches where id=tx.import_batch_id and user_id=auth.uid();
  if rule.parser_key is not null and rule.parser_key is distinct from parser then return false; end if;
  if (rule.amount_direction='debit' and tx.amount>=0) or (rule.amount_direction='credit' and tx.amount<=0)
    or (rule.target_transaction_type in ('expense','debt_principal','debt_interest') and tx.amount>=0)
    or (rule.target_transaction_type in ('income','refund') and tx.amount<=0) then return false; end if;
  if rule.target_transaction_type='investment_transfer' and rule.target_transfer_account_id is null then return false; end if;
  if rule.target_transfer_account_id is not null and not exists(select 1 from public.accounts a
    join public.accounts s on s.id=tx.account_id and s.user_id=auth.uid()
    where a.id=rule.target_transfer_account_id and a.user_id=auth.uid() and a.id<>s.id and a.currency=s.currency
      and (rule.target_transaction_type<>'investment_transfer' or a.account_type='broker')) then return false; end if;
  if rule.match_field like 'provider_%' then
    metadata := public.classification_metadata(tx.id);
    if (metadata->>'conflicting')::boolean then return false; end if;
  end if;
  value := case rule.match_field when 'description' then public.normalize_classification_text(tx.description)
    when 'merchant' then public.normalize_classification_text(tx.merchant)
    else metadata->>rule.match_field end;
  if nullif(value,'') is null then return false; end if;
  return case rule.match_operator
    when 'exact' then value=public.normalize_classification_text(rule.pattern)
    when 'contains' then strpos(value,public.normalize_classification_text(rule.pattern))>0
    when 'starts_with' then starts_with(value,public.normalize_classification_text(rule.pattern))
    else false end;
end $$;
revoke all on function public.classification_rule_matches(public.transactions,public.transaction_classification_rules) from public,anon;
grant execute on function public.classification_rule_matches(public.transactions,public.transaction_classification_rules) to authenticated;

-- Strict merchant boundaries, restricted to explicitly generic IsyBank provider buckets.
create function public.residual_provider_category_key(category text, operation text, description text)
returns text language plpgsql immutable security invoker set search_path='' as $$
declare c text:=public.normalize_classification_text(category);
  m text:=coalesce(nullif(public.normalize_classification_text(operation),''),public.normalize_classification_text(description));
begin
  if c not in ('','addebiti vari','altre uscite','famiglie varie','associazioni') then return null; end if;
  if m ~ '(^|[^[:alnum:]])(bonifico|prelievo|cash advance|revolut|visa direct|p2p|bancomat pay|pago ?pa|poste italiane|cofidis|rata finanziamento)($|[^[:alnum:]])'
    then return null; end if;
  if m ~ '^(pagamento( pos| online)?[ :*-]+)?(paypal[ *]+)?apple[.]com/bill($|[ *./-])' then return 'expense_subscriptions'; end if;
  if m ~ '^(pagamento( pos| online)?[ :*-]+)?(paypal[ *]+)?playstation($|[ *./-])' then return 'expense_leisure'; end if;
  if m ~ '^(pagamento( pos| online)?[ :*-]+)?cerved($|[ *./-])' then return 'expense_work'; end if;
  if m ~ '^costo carta($|[ :*./-])' then return 'expense_fees'; end if;
  if m ~ '^(pagamento( pos| online)?[ :*-]+)?(amazon prime|amzn prime)($|[ *./-])' then return 'expense_subscriptions'; end if;
  if m ~ '^(pagamento( pos| online)?[ :*-]+amazon([.]it|[.]com)?|amzn mktp)($|[ *./-])' then return 'expense_shopping'; end if;
  if m ~ '(^|[^[:alnum:]])caffetteria($|[^[:alnum:]])' then return 'expense_dining'; end if;
  return null;
end $$;
revoke all on function public.residual_provider_category_key(text,text,text) from public,anon;
grant execute on function public.residual_provider_category_key(text,text,text) to authenticated;

create or replace function public.classify_transactions(target_batch_id uuid default null)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  tx public.transactions;
  selected_rule public.transaction_classification_rules;
  transferred integer := 0;
  classified integer := 0;
  remaining integer := 0;
  parser text;
  metadata jsonb;
  metadata_variants integer;
  provider_category text;
  operation text;
  description text;
  system_category text;
  next_type text;
  next_category uuid;
  next_target uuid;
  target_count integer;
  next_status text;
  categorized integer;
  uncategorized integer;
  total_transfers integer;
begin
  if auth.uid() is null then raise exception 'authentication required'; end if;
  if target_batch_id is not null and not exists
    (select 1 from public.import_batches where id = target_batch_id and user_id = auth.uid()) then
    raise exception 'import batch not found';
  end if;

  -- Serialize classification runs for this owner, including runs restricted to different batches.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(auth.uid()::text, 5));

  -- Snapshot all compatible edges. Only vertices of degree one on both sides are safe.
  with eligible as (
    select t.* from public.transactions t
    where t.user_id = auth.uid()
      and coalesce(t.classification_method, '') not in ('manual','user_rule','transfer_match') and t.reconciliation_status <> 'ignored'
      and t.transfer_group_id is null
      and (t.transaction_type = 'unclassified' or (
        t.classification_method = 'provider_rule' and t.amount > 0
        and public.normalize_classification_text(t.description) like '%addebito in c/c salvo buon fine%'
        and exists(select 1 from public.import_batches ib where ib.id=t.import_batch_id
          and ib.user_id=auth.uid() and ib.parser_key='american_express_v1')
      ))
  ), candidates as (
    select a.id aid, b.id bid, a.account_id aa, b.account_id ba
    from eligible a join eligible b on b.user_id = a.user_id and b.id <> a.id
      and b.account_id <> a.account_id and b.amount = -a.amount
      and abs(b.transaction_date - a.transaction_date) <= 3
      and b.reconciliation_status <> 'ignored' and b.transfer_group_id is null
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
      join public.accounts ba_type on ba_type.id = c.ba and ba_type.user_id = auth.uid() and ba_type.currency=aa_type.currency
  ), updates as (
    update public.transactions t set
      category_id=null, transaction_type = s.transfer_type, transfer_account_id = case when t.id = s.aid then s.ba else s.aa end,
      transfer_group_id = s.group_id, reconciliation_status = 'confirmed', classification_method = 'transfer_match',
      classification_rule_id = null, classified_at = now()
    from safe s where t.id in (s.aid, s.bid) and t.user_id = auth.uid() returning t.id
  ) select count(*) / 2 into transferred from updates;

  -- Highest priority wins; ties are oldest rule then UUID. Text is lower/trim/collapsed whitespace.
  for tx in select * from public.transactions t
    where t.user_id = auth.uid() and (target_batch_id is null or t.import_batch_id = target_batch_id)
      and (t.transaction_type = 'unclassified' or t.classification_method = 'provider_rule')
      and coalesce(t.classification_method, '') not in ('manual','user_rule','transfer_match')
      and t.reconciliation_status <> 'ignored' and t.transfer_group_id is null
    order by t.transaction_date, t.id for update
  loop
    selected_rule := null;
    select r.* into selected_rule from public.transaction_classification_rules r
      where r.user_id=auth.uid() and public.classification_rule_matches(tx,r)
      order by r.priority desc,r.created_at,r.id limit 1;
    if selected_rule.id is not null then
      next_type := coalesce(selected_rule.target_transaction_type, tx.transaction_type);
      next_category := case when selected_rule.target_transaction_type is not null
        then selected_rule.target_category_id else coalesce(selected_rule.target_category_id,tx.category_id) end;
      -- Preserve legacy category-only rules, inferring a type only from a compatible category.
      if next_type='unclassified' and next_category is not null then
        select case when c.category_type='expense' and tx.amount<0 then 'expense'
          when c.category_type='income' and tx.amount>0 then 'income' else 'unclassified' end into next_type
          from public.transaction_categories c where c.id=next_category and c.user_id=auth.uid();
      end if;
      next_target := case when next_type in ('internal_transfer','investment_transfer') then selected_rule.target_transfer_account_id end;
      perform public.validate_classification_decision(tx.account_id,next_type,next_category,next_target);
      update public.transactions set transaction_type=next_type, category_id=next_category,
        transfer_account_id=next_target, transfer_group_id=null,
        reconciliation_status=case when next_type in ('internal_transfer','investment_transfer') and next_target is not null
          then 'confirmed' else 'pending' end,
        merchant=coalesce(selected_rule.target_merchant,merchant), classification_method='user_rule',
        classification_rule_id=selected_rule.id, classified_at=now()
        where id=tx.id and user_id=auth.uid();
      classified := classified+1;
    end if;
  end loop;

  -- Provider rules re-evaluate earlier sign-only results, without touching stronger decisions.
  for tx in select t.* from public.transactions t
    join public.import_batches ib on ib.id = t.import_batch_id and ib.user_id = auth.uid()
    where t.user_id = auth.uid() and (target_batch_id is null or t.import_batch_id = target_batch_id)
      and ib.parser_key in ('isybank_operations_v1','american_express_v1','isybank_card_v1')
      and (t.transaction_type = 'unclassified' or t.classification_method = 'provider_rule')
      and coalesce(t.classification_method, '') not in ('manual','user_rule','transfer_match')
      and t.reconciliation_status <> 'ignored' and t.transfer_group_id is null
      and not (t.transaction_type in ('internal_transfer','investment_transfer') and t.reconciliation_status = 'confirmed')
    order by t.transaction_date, t.id for update of t
  loop
    select ib.parser_key into parser from public.import_batches ib
      where ib.id = tx.import_batch_id and ib.user_id = auth.uid();
    metadata := public.classification_metadata(tx.id);
    metadata_variants := case when (metadata->>'conflicting')::boolean then 2 else 1 end;
    provider_category := coalesce(metadata->>'provider_category','');
    operation := coalesce(metadata->>'provider_operation','');
    description := public.normalize_classification_text(tx.description);
    system_category := null;
    next_type := 'unclassified'; next_category := null; next_target := null;
    next_status := 'pending';

    if metadata_variants > 1 then
      -- Conflicting provenance stays neutral even if the amount/description looks familiar.
      null;
    elsif parser = 'isybank_operations_v1' then
      if tx.amount<0 and description ~ '(^|[^[:alnum:]])(estinzione anticipata|restituzione prestito infruttifero)($|[^[:alnum:]])' then
        next_type := 'debt_principal';
      elsif (operation || ' ' || description) ~ '(^|[^[:alnum:]])salvadanaio($|[^[:alnum:]])' then
        select count(*), (array_agg(a.id))[1] into target_count, next_target
        from public.accounts a join public.accounts source on source.id = tx.account_id and source.user_id = auth.uid()
        where a.user_id = auth.uid() and a.is_active and a.account_type = 'savings' and a.id <> tx.account_id
          and a.currency = source.currency
          and public.classification_institution_key(source.institution) <> ''
          and public.classification_institution_key(a.institution) = public.classification_institution_key(source.institution);
        if target_count = 1 then next_type := 'internal_transfer'; end if;
      elsif strpos(description, 'trasferimento conto titoli') > 0 then
        select count(*), (array_agg(a.id))[1] into target_count, next_target from public.accounts a
          where a.user_id = auth.uid() and a.is_active and a.account_type = 'broker' and a.id <> tx.account_id;
        if target_count = 1 then next_type := 'investment_transfer'; end if;
      elsif provider_category = 'addebiti nexi e carte non del gruppo intesa sanpaolo'
        and (operation || ' ' || description) ~ '(^|[^[:alnum:]])american express($|[^[:alnum:]])' and tx.amount < 0 then
        select count(*), (array_agg(a.id))[1] into target_count, next_target from public.accounts a
          join public.accounts source on source.id = tx.account_id and source.user_id = auth.uid()
          where a.user_id = auth.uid() and a.is_active and a.account_type = 'credit_card' and a.id <> tx.account_id
            and a.currency = source.currency
            and public.normalize_classification_text(coalesce(a.institution, '') || ' ' || a.name) ~ '(^|[^[:alnum:]])(american express|amex)($|[^[:alnum:]])';
        if target_count = 1 then next_type := 'internal_transfer'; end if;
      elsif provider_category = 'addebito mia carta di credito' and tx.amount < 0 then
        select count(*), (array_agg(a.id))[1] into target_count, next_target
          from public.import_account_mappings m join public.accounts a on a.id = m.account_id and a.user_id = auth.uid()
          join public.accounts source on source.id = tx.account_id and source.user_id = auth.uid()
          where m.user_id = auth.uid() and m.parser_key = 'isybank_operations_v1'
            and a.is_active and a.account_type = 'credit_card' and a.id <> tx.account_id and a.currency = source.currency
            and public.classification_institution_key(source.institution) = 'isybank'
            and public.classification_institution_key(a.institution) = 'isybank';
        if target_count = 1 then next_type := 'internal_transfer'; end if;
      elsif provider_category = 'rimborsi spese e storni' and tx.amount > 0 then
        next_type := 'refund';
      elsif tx.amount < 0 then
        system_category := public.provider_category_key(parser, provider_category, null, description);
        if system_category is null then
          system_category := public.residual_provider_category_key(provider_category,operation,description);
        end if;
        if system_category is not null then next_type := 'expense'; end if;
      end if;
    elsif parser = 'american_express_v1' then
      if strpos(description, 'addebito in c/c salvo buon fine') > 0 then
        -- Explicit settlement, never a refund. Without a pair, a single checking account
        -- is required; multiple current accounts leave the target unknowable.
        if tx.amount > 0 then
          select count(*), (array_agg(a.id))[1] into target_count, next_target from public.accounts a
            join public.accounts source on source.id = tx.account_id and source.user_id = auth.uid()
            where a.user_id = auth.uid() and a.is_active and a.account_type = 'checking'
              and a.id <> tx.account_id and a.currency = source.currency;
          if target_count = 1 then next_type := 'internal_transfer'; end if;
        end if;
      elsif description ~ '^(banco di sardeg|poste italiane|pagopa)'
        or (description ~ '(^|[^[:alnum:]])(pago ?pa|bonifico|cash advance|prelievo contante|prelievo atm|atm withdrawal|revolut|visa direct|p2p|bancomat pay|cofidis|rata finanziamento|rate mutuo e finanziamento|rate prestiti)($|[^[:alnum:]])'
          and description !~ '^commissione prelievo contante($| )') then
        -- Explicit cash-advance candidates (BANCO DI SARDEG*, POSTE ITALIANE 07601),
        -- and ambiguous Poste/PagoPA/bank transfers never become consumption by sign.
        null;
      else
        next_type := case when tx.amount < 0 then 'expense' else 'refund' end;
        system_category := public.provider_category_key(parser, null, metadata ->> 'provider_details', description);
      end if;
    elsif parser = 'isybank_card_v1' then
      -- Existing card-statement behavior is unchanged; operations routing stays PR4.4-owned.
      next_type := case when tx.amount < 0 then 'expense' else 'refund' end;
    end if;

    if next_type in ('internal_transfer','investment_transfer') then
      next_status := 'confirmed';
    else
      next_target := null;
    end if;
    if system_category is not null then
      select c.id into next_category from public.transaction_categories c
        where c.user_id = auth.uid() and c.system_key = system_category and c.category_type = 'expense';
    end if;
    -- Audit timestamps/counters change only when the persisted decision changes.
    if row(tx.transaction_type, tx.category_id, tx.transfer_account_id, tx.reconciliation_status, tx.classification_method, tx.classification_rule_id)
      is distinct from row(next_type, next_category, next_target, next_status, 'provider_rule'::text, null::uuid) then
      update public.transactions set transaction_type = next_type, category_id = next_category,
        transfer_account_id = next_target, reconciliation_status = next_status,
        classification_method = 'provider_rule', classification_rule_id = null, classified_at = now()
        where id = tx.id and user_id = auth.uid();
      if next_type <> 'unclassified' then classified := classified + 1; end if;
      if next_type in ('internal_transfer','investment_transfer') then transferred := transferred + 1; end if;
    end if;
  end loop;

  select count(*) into remaining from public.transactions t where t.user_id = auth.uid()
    and (target_batch_id is null or t.import_batch_id = target_batch_id)
    and t.transaction_type = 'unclassified' and t.reconciliation_status <> 'ignored';
  select count(*) filter (where t.category_id is not null),
    count(*) filter (where t.transaction_type in ('expense','refund','income') and t.category_id is null),
    count(*) filter (where t.transaction_type in ('internal_transfer','investment_transfer'))
    into categorized, uncategorized, total_transfers from public.transactions t
    where t.user_id = auth.uid() and (target_batch_id is null or t.import_batch_id = target_batch_id)
      and t.reconciliation_status <> 'ignored';
  return jsonb_build_object('classified_count', classified, 'transfer_count', transferred, 'unclassified_count', remaining,
    'categorized_count', categorized, 'uncategorized_count', uncategorized, 'total_transfer_count', total_transfers);
end $$;
revoke all on function public.classify_transactions(uuid) from public, anon;
grant execute on function public.classify_transactions(uuid) to authenticated;


create function public.lock_classification_selection(transaction_ids uuid[])
returns void language plpgsql security invoker set search_path='' as $$
declare found_count integer;
begin
  if auth.uid() is null then raise exception 'authentication required'; end if;
  if coalesce(cardinality(transaction_ids),0) not between 1 and 500
    or array_position(transaction_ids,null) is not null
    or (select count(distinct id) from unnest(transaction_ids) id)<>cardinality(transaction_ids)
    then raise exception 'select 1 to 500 distinct transaction UUIDs'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(auth.uid()::text,5));
  perform id from public.transactions where id=any(transaction_ids) and user_id=auth.uid() order by id for update;
  get diagnostics found_count = row_count;
  if found_count<>cardinality(transaction_ids) then raise exception 'one or more transactions not owned or not found'; end if;
  if exists(select 1 from public.transactions where id=any(transaction_ids) and user_id=auth.uid()
    and (classification_method='transfer_match' or reconciliation_status='ignored' or transfer_group_id is not null))
    then raise exception 'protected transaction in selection'; end if;
end $$;
revoke all on function public.lock_classification_selection(uuid[]) from public,anon;
grant execute on function public.lock_classification_selection(uuid[]) to authenticated;

create function public.bulk_classify_transactions(transaction_ids uuid[], target_type text,
  target_category_id uuid default null, target_transfer_account_id uuid default null)
returns integer language plpgsql security invoker set search_path='' as $$
declare tx public.transactions; changed integer;
begin
  perform public.lock_classification_selection(transaction_ids);
  -- Validate every source before the single UPDATE. Check constraints also reject invalid signs atomically.
  for tx in select * from public.transactions where id=any(transaction_ids) and user_id=auth.uid() loop
    perform public.validate_classification_decision(tx.account_id,target_type,target_category_id,target_transfer_account_id);
  end loop;
  update public.transactions set transaction_type=target_type, category_id=target_category_id,
    transfer_account_id=target_transfer_account_id, transfer_group_id=null,
    reconciliation_status=case when target_type in ('internal_transfer','investment_transfer') and target_transfer_account_id is not null
      then 'confirmed' else 'pending' end,
    classification_method='manual', classification_rule_id=null, classified_at=now()
    where id=any(transaction_ids) and user_id=auth.uid();
  get diagnostics changed = row_count;
  return changed;
end $$;
revoke all on function public.bulk_classify_transactions(uuid[],text,uuid,uuid) from public,anon;
grant execute on function public.bulk_classify_transactions(uuid[],text,uuid,uuid) to authenticated;

create function public.create_classification_rule_and_apply(transaction_ids uuid[], rule_input jsonb)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare rule public.transaction_classification_rules; tx public.transactions; changed integer;
begin
  perform public.lock_classification_selection(transaction_ids);
  if exists(select 1 from public.transactions where id=any(transaction_ids) and user_id=auth.uid()
    and classification_method in ('manual','user_rule')) then raise exception 'manual or user_rule decision protected'; end if;
  if jsonb_typeof(rule_input) is distinct from 'object' or nullif(btrim(rule_input->>'name'),'') is null
    or nullif(rule_input->>'target_transaction_type','') is null then raise exception 'invalid rule input'; end if;
  -- Explicit columns: the caller cannot supply another user_id or audit/identity fields.
  insert into public.transaction_classification_rules(name,priority,account_id,parser_key,match_field,match_operator,
    pattern,amount_direction,target_transaction_type,target_category_id,target_transfer_account_id,target_merchant)
  values(rule_input->>'name',coalesce((rule_input->>'priority')::integer,100),
    nullif(rule_input->>'account_id','')::uuid,nullif(rule_input->>'parser_key',''),
    rule_input->>'match_field',coalesce(rule_input->>'match_operator','exact'),rule_input->>'pattern',
    coalesce(rule_input->>'amount_direction','any'),rule_input->>'target_transaction_type',
    nullif(rule_input->>'target_category_id','')::uuid,nullif(rule_input->>'target_transfer_account_id','')::uuid,
    nullif(rule_input->>'target_merchant','')) returning * into rule;
  for tx in select * from public.transactions where id=any(transaction_ids) and user_id=auth.uid() loop
    if not public.classification_rule_matches(tx,rule) then raise exception 'rule does not match every selected transaction'; end if;
  end loop;
  changed := public.bulk_classify_transactions(transaction_ids,rule.target_transaction_type,
    rule.target_category_id,rule.target_transfer_account_id);
  update public.transactions set classification_method='user_rule',classification_rule_id=rule.id,
    merchant=coalesce(rule.target_merchant,merchant) where id=any(transaction_ids) and user_id=auth.uid();
  return jsonb_build_object('rule_id',rule.id,'classified_count',changed);
end $$;
revoke all on function public.create_classification_rule_and_apply(uuid[],jsonb) from public,anon;
grant execute on function public.create_classification_rule_and_apply(uuid[],jsonb) to authenticated;

-- Server aggregation, bounded group pages and selection IDs. No raw_data leaves this RPC.
create function public.residual_review_groups(group_by text default 'provider_operation', page_limit integer default 50,
  page_offset integer default 0)
returns jsonb language plpgsql stable security invoker set search_path='' as $$
declare result jsonb;
begin
  if auth.uid() is null then raise exception 'authentication required'; end if;
  if group_by is null or group_by not in ('provider_category','provider_operation')
    or page_limit is null or page_limit not between 1 and 100 or page_offset is null or page_offset<0
    then raise exception 'invalid review page'; end if;
  with scoped as materialized (
    select t.id,t.amount,t.transaction_date,t.description,t.account_id,t.import_batch_id,t.user_id,
      public.classification_metadata(t.id) metadata
    from public.transactions t where t.user_id=(select auth.uid()) and t.transaction_type='unclassified'
      and t.reconciliation_status<>'ignored' and t.classification_method is distinct from 'transfer_match'
      and t.transfer_group_id is null
  ), residual as materialized (
    select t.id,t.amount,t.transaction_date,t.description,t.account_id,a.name account_name,a.currency,
      b.parser_key,t.metadata->>'provider_category' provider_category,
      case when group_by='provider_operation' then t.metadata->>'provider_operation' end provider_operation,
      (t.metadata->>'conflicting')::boolean metadata_conflicting
    from scoped t join public.accounts a on a.id=t.account_id and a.user_id=t.user_id
      left join public.import_batches b on b.id=t.import_batch_id and b.user_id=t.user_id
  ), ranked as (
    select *,row_number() over(partition by parser_key,account_id,provider_category,provider_operation,metadata_conflicting
      order by transaction_date,id) rn from residual
  ), grouped as (
    select parser_key,account_id,account_name,currency,provider_category,provider_operation,metadata_conflicting,
      md5(jsonb_build_array(parser_key,account_id,provider_category,provider_operation,metadata_conflicting)::text) group_key,
      count(*) transaction_count,sum(amount) total_amount,min(transaction_date) date_min,max(transaction_date) date_max,
      array_agg(id order by transaction_date,id) filter(where rn<=500) transaction_ids,
      array_agg(description order by transaction_date,id) filter(where rn<=3) examples
    from ranked group by parser_key,account_id,account_name,currency,provider_category,provider_operation,metadata_conflicting
  ), page as (
    select * from grouped order by transaction_count desc,group_key limit page_limit offset page_offset
  ) select jsonb_build_object('groups',coalesce((select jsonb_agg(to_jsonb(page) order by transaction_count desc,group_key) from page),'[]'::jsonb),
    'total_groups',(select count(*) from grouped),'unclassified_count',(select count(*) from residual)) into result;
  return result;
end $$;
revoke all on function public.residual_review_groups(text,integer,integer) from public,anon;
grant execute on function public.residual_review_groups(text,integer,integer) to authenticated;
commit;
