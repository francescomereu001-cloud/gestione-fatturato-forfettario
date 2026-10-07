-- PR9: additive schema/function changes only; no ledger writes or backfill.
begin;
-- Privileged audit implementations are outside the exposed API schema.
create schema financialmind_classification_private;
revoke all on schema financialmind_classification_private from public,anon,authenticated,service_role;
grant usage on schema financialmind_classification_private to authenticated,service_role;
alter table public.transactions drop constraint transactions_classification_method_check;
alter table public.transactions add constraint transactions_classification_method_check check
 (classification_method is null or classification_method in ('provider_rule','user_rule','manual','transfer_match','merchant_memory','ai_suggestion'));
alter table public.transaction_classification_rules drop constraint transaction_classification_rules_match_field_check;
alter table public.transaction_classification_rules add constraint transaction_classification_rules_match_field_check check
 (match_field in ('description','merchant','provider_category','provider_operation','provider_details','merchant_fingerprint'));
alter table public.transaction_classification_rules add column memory_account_type text;
alter table public.transaction_classification_rules add constraint merchant_memory_scope_check check
 (match_field <> 'merchant_fingerprint' or (match_operator='exact' and parser_key is not null
  and target_transaction_type is not null and memory_account_type is not null
  and amount_direction in ('debit','credit') and memory_account_type in
   ('checking','savings','credit_card','broker','cash','technical','other')
  and target_transaction_type in ('expense','income','refund') and target_category_id is not null
  and target_transfer_account_id is null and target_merchant is null));
create unique index classification_memory_identity_idx on public.transaction_classification_rules
 (user_id,parser_key,amount_direction,memory_account_type,pattern) where match_field='merchant_fingerprint';

-- Central conservative normalizer. No fuzzy matching; unknown merchant text stays exact.
-- Version in the identity allows deliberate future normalization changes.
create function public.merchant_fingerprint(parser text, merchant text, description text, operation text default null,
 conflicting boolean default false) returns text language plpgsql immutable security invoker set search_path='' as $$
declare value text; all_text text;
begin
 if conflicting or parser is null or parser not in ('isybank_operations_v1','isybank_card_v1','american_express_v1') then return null; end if;
 all_text:=public.normalize_classification_text(coalesce(merchant,'')||' '||coalesce(description,'')||' '||coalesce(operation,''));
 if all_text ~ '(^|[^[:alnum:]])(bonifico|prelievo|cash advance|atm withdrawal|revolut|visa direct|p2p|bancomat pay|pago ?pa|poste italiane|cofidis|mutuo|prestito|finanziamento|salvadanaio|trasferimento|iban|addebito in c/c)($|[^[:alnum:]])'
  or all_text ~ '[a-z]{2}[0-9]{2}[a-z0-9]{11,}' then return null; end if;
 value:=public.normalize_classification_text(coalesce(nullif(btrim(merchant),''),
  case when parser='isybank_operations_v1' and nullif(btrim(operation),'') is not null then operation end,description));
 value:=regexp_replace(value,'^pagamento( pos| online)?[ :*-]+','','i');
 if value ~ '^(amzn mktp it|amazon eu sarl)($|[ *./-])' then return 'v1:amazon-marketplace'; end if;
 -- Remove only explicitly labelled variable references and trailing dates/terminal numbers.
 value:=regexp_replace(value,'[ ,;]+(ref(erence)?|riferimento|transazione|terminal(e)?|tid)[ :#=-]+[a-z0-9-]+$','','i');
 value:=regexp_replace(value,'[ ,;]+[0-9]{2}[/.-][0-9]{2}[/.-][0-9]{2,4}$','','i');
 value:=public.normalize_classification_text(value);
 if length(value)<4 or length(value)>100 or value !~ '[[:alpha:]]'
  or value ~ '^(pagamento|pagamento pos|acquisto|carta|addebito|operazione|altre uscite|addebiti vari|unknown|sconosciuto|merchant)$'
  or length(regexp_replace(value,'[^0-9]','','g'))>=8 or value ~ '[[:alnum:]._%+-]+@[[:alnum:].-]+' then return null; end if;
 return 'v1:'||value;
end $$;
revoke all on function public.merchant_fingerprint(text,text,text,text,boolean) from public,anon;
grant execute on function public.merchant_fingerprint(text,text,text,text,boolean) to authenticated,service_role;

create function public.transaction_merchant_fingerprint(tx public.transactions)
returns text language sql stable security invoker set search_path='' as $$
 select case when coalesce(m->>'provider_category','')||' '||coalesce(m->>'provider_details','') ~
   '(bonific|preliev|trasferiment|mutuo|prestit|finanziament|cofidis|cash advance|pago ?pa|versament|giroconto|ricarica|revolut|visa direct|bancomat pay|addebito mia carta|addebiti nexi|saldo carta)' then null
   else public.merchant_fingerprint(b.parser_key,tx.merchant,tx.description,
   m->>'provider_operation',coalesce((m->>'conflicting')::boolean,false)) end
 from public.import_batches b cross join lateral public.classification_metadata(tx.id) m
 where b.id=tx.import_batch_id and b.user_id=auth.uid() and tx.user_id=auth.uid()
$$;
revoke all on function public.transaction_merchant_fingerprint(public.transactions) from public,anon;
grant execute on function public.transaction_merchant_fingerprint(public.transactions) to authenticated,service_role;
create or replace function public.classification_rule_matches(tx public.transactions, rule public.transaction_classification_rules)
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
  if rule.match_field='merchant_fingerprint' then
    return rule.match_operator='exact' and rule.pattern=public.transaction_merchant_fingerprint(tx)
      and exists(select 1 from public.accounts where id=tx.account_id and user_id=auth.uid() and account_type=rule.memory_account_type);
  end if;
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
      and coalesce(t.classification_method, '') not in ('manual','user_rule','transfer_match','merchant_memory','ai_suggestion') and t.reconciliation_status <> 'ignored'
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
      and (t.transaction_type = 'unclassified' or t.classification_method in ('provider_rule','merchant_memory','ai_suggestion'))
      and coalesce(t.classification_method, '') not in ('manual','user_rule','transfer_match')
      and t.reconciliation_status <> 'ignored' and t.transfer_group_id is null
    order by t.transaction_date, t.id for update
  loop
    selected_rule := null;
    select r.* into selected_rule from public.transaction_classification_rules r
      where r.user_id=auth.uid() and r.match_field<>'merchant_fingerprint' and public.classification_rule_matches(tx,r)
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

  -- Remembered owner/provider/direction/account-type identities precede provider fallbacks.
  for tx in select * from public.transactions t
    where t.user_id=auth.uid() and (target_batch_id is null or t.import_batch_id=target_batch_id)
      and (t.transaction_type='unclassified' or t.classification_method='provider_rule')
      and coalesce(t.classification_method,'') not in ('manual','user_rule','transfer_match','merchant_memory','ai_suggestion')
      and t.reconciliation_status<>'ignored' and t.transfer_group_id is null
      and not (t.transaction_type in ('internal_transfer','investment_transfer') and t.reconciliation_status='confirmed')
    order by t.transaction_date,t.id for update
  loop
    select r.* into selected_rule from public.transaction_classification_rules r
      where r.user_id=auth.uid() and r.match_field='merchant_fingerprint' and public.classification_rule_matches(tx,r)
      order by r.priority desc,r.created_at,r.id limit 1;
    if selected_rule.id is not null then
      perform public.validate_classification_decision(tx.account_id,selected_rule.target_transaction_type,selected_rule.target_category_id,null);
      update public.transactions set transaction_type=selected_rule.target_transaction_type,
        category_id=selected_rule.target_category_id,transfer_account_id=null,
        classification_method='merchant_memory',classification_rule_id=selected_rule.id,classified_at=now()
      where id=tx.id and user_id=auth.uid();
      classified:=classified+1;
    end if;
  end loop;

  -- Provider rules re-evaluate earlier sign-only results, without touching stronger decisions.
  for tx in select t.* from public.transactions t
    join public.import_batches ib on ib.id = t.import_batch_id and ib.user_id = auth.uid()
    where t.user_id = auth.uid() and (target_batch_id is null or t.import_batch_id = target_batch_id)
      and ib.parser_key in ('isybank_operations_v1','american_express_v1','isybank_card_v1')
      and (t.transaction_type = 'unclassified' or t.classification_method = 'provider_rule')
      and coalesce(t.classification_method, '') not in ('manual','user_rule','transfer_match','merchant_memory','ai_suggestion')
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


-- Minimal audit structure; memory continues to live in existing classification rules.
create table public.transaction_ai_suggestions (
 id uuid primary key default gen_random_uuid(),
 user_id uuid not null references auth.users(id) on delete cascade,
 transaction_id uuid not null unique references public.transactions(id) on delete cascade,
 fingerprint text not null,
 parser_key text not null,
 direction text not null check(direction in ('debit','credit')),
 account_type text not null,
 currency text not null,
 source_account_id uuid not null references public.accounts(id) on delete cascade,
 source_updated_at timestamptz not null,
 proposed_transaction_type text check(proposed_transaction_type in ('expense','income','refund')),
 proposed_category_id uuid references public.transaction_categories(id) on delete set null,
 confidence numeric check(confidence between 0 and 1),
 normalized_merchant text,
 reason text,
 model text not null,
 logic_version text not null,
 status text not null check(status in ('processing','suggested','auto_applied','approved','remembered','rejected','low','invalid','failed','stale')),
 attempt_token uuid not null default gen_random_uuid(),
 attempt_times timestamptz[] not null default array[now()],
 attempt_count integer not null default 1,
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 decided_at timestamptz,
 check(length(coalesce(reason,''))<=180),
 check(length(coalesce(normalized_merchant,''))<=100)
);
create index transaction_ai_suggestions_owner_status_idx on public.transaction_ai_suggestions(user_id,status,updated_at);
alter table public.transaction_ai_suggestions enable row level security;
revoke all on public.transaction_ai_suggestions from public,anon,authenticated;
grant select on public.transaction_ai_suggestions to authenticated;
grant all on public.transaction_ai_suggestions to service_role;
create policy ai_suggestions_read_own on public.transaction_ai_suggestions for select to authenticated using ((select auth.uid())=user_id);

-- Single authority for confidence, cost and batch policy, shared by SQL and Edge Function.
create function public.residual_ai_policy() returns jsonb language sql immutable set search_path='' as $$
 select '{"high":0.98,"medium":0.70,"batch_size":40,"hourly_limit":80,"logic_version":"pr9-v1","model":"gpt-4.1-mini-2025-04-14"}'::jsonb
$$;
revoke all on function public.residual_ai_policy() from public,anon;
grant execute on function public.residual_ai_policy() to authenticated,service_role;

-- Claims prevent overlapping calls and keep rejected/low/invalid decisions from being resent.
-- Reclaim only technical failures or timed-out processing after 15 minutes.
create function financialmind_classification_private.claim_residual_ai_batch() returns jsonb language plpgsql security definer set search_path='' as $$
declare tx public.transactions; m jsonb; fp text; parser text; acct public.accounts;
 claim public.transaction_ai_suggestions; candidates jsonb:='[]'; policy jsonb:=public.residual_ai_policy(); count_claimed integer:=0; budget integer;
begin
 if auth.uid() is null then raise exception 'authentication required'; end if;
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(auth.uid()::text,5));
 perform public.classify_transactions(null);
 select greatest(0,(policy->>'hourly_limit')::integer-count(*)::integer) into budget
 from public.transaction_ai_suggestions s cross join lateral unnest(s.attempt_times) tried_at
 where s.user_id=auth.uid() and tried_at>now()-interval '1 hour';
 for tx in select t.* from public.transactions t
   where t.user_id=auth.uid() and t.transaction_type='unclassified'
    and coalesce(t.classification_method,'') not in ('manual','user_rule','transfer_match','merchant_memory','ai_suggestion')
    and t.reconciliation_status<>'ignored' and t.transfer_group_id is null and t.transfer_account_id is null
    and t.amount<>0
    and not exists(select 1 from public.transaction_ai_suggestions s where s.transaction_id=t.id
      and (s.status not in ('failed','processing') or s.updated_at>now()-interval '15 minutes'))
   order by t.transaction_date,t.id for update
 loop
  exit when count_claimed>=least((policy->>'batch_size')::integer,budget);
  m:=public.classification_metadata(tx.id);
  if coalesce((m->>'conflicting')::boolean,false) then continue; end if;
  fp:=public.transaction_merchant_fingerprint(tx);
  if fp is null then continue; end if;
  -- The shared fingerprint helper also vetoes contradictory category/details metadata.
  select * into acct from public.accounts where id=tx.account_id and user_id=auth.uid();
  select parser_key into parser from public.import_batches where id=tx.import_batch_id and user_id=auth.uid();
  insert into public.transaction_ai_suggestions(user_id,transaction_id,fingerprint,parser_key,direction,account_type,currency,source_account_id,source_updated_at,model,logic_version,status)
  values(auth.uid(),tx.id,fp,parser,case when tx.amount<0 then 'debit' else 'credit' end,acct.account_type,acct.currency,tx.account_id,tx.updated_at,
    policy->>'model',policy->>'logic_version','processing')
  on conflict(transaction_id) do update set status='processing',attempt_token=gen_random_uuid(),updated_at=now(),
   attempt_count=transaction_ai_suggestions.attempt_count+1,
   source_account_id=excluded.source_account_id,source_updated_at=excluded.source_updated_at,
   attempt_times=array(select tried_at from unnest(transaction_ai_suggestions.attempt_times) tried_at where tried_at>now()-interval '1 hour')||now()
  returning * into claim;
  -- Only the canonical merchant token leaves this RPC, never raw descriptions or provider_details.
  candidates:=candidates||jsonb_build_array(jsonb_build_object('claim_id',claim.id,'attempt_token',claim.attempt_token,
    'fingerprint',fp,'normalized_merchant',substring(fp from 4),'provider',parser,
    'direction',claim.direction,'currency',acct.currency,'account_type',acct.account_type));
  count_claimed:=count_claimed+1;
 end loop;
 return jsonb_build_object('policy',policy,'candidates',candidates,'categories',coalesce((select jsonb_agg(jsonb_build_object(
  'system_key',system_key,'category_type',category_type)) from public.transaction_categories
  where user_id=auth.uid() and system_key is not null and category_type in ('income','expense')),'[]'::jsonb));
end $$;
revoke all on function financialmind_classification_private.claim_residual_ai_batch() from public,anon;
grant execute on function financialmind_classification_private.claim_residual_ai_batch() to authenticated;

-- A trusted Edge Function is the only caller allowed to persist model output.
-- Explicit owner from verified getUser(), no owner supplied by the browser.
create function financialmind_classification_private.record_residual_ai_result(owner_id uuid, claim_id uuid, attempt uuid, proposal jsonb)
returns text language plpgsql security definer set search_path='' as $$
declare s public.transaction_ai_suggestions; tx public.transactions; cat public.transaction_categories;
 valid boolean:=false; schema_valid boolean:=false; confidence_value numeric; next_status text; policy jsonb:=public.residual_ai_policy();
begin
 if owner_id is null then raise exception 'owner required'; end if;
 perform set_config('request.jwt.claim.sub',owner_id::text,true);
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(owner_id::text,5));
 select * into s from public.transaction_ai_suggestions where id=claim_id and user_id=owner_id for update;
 if s.id is null or s.status<>'processing' or s.attempt_token<>attempt then return 'stale'; end if;
 select * into tx from public.transactions where id=s.transaction_id and user_id=owner_id for update;
 if tx.id is null or tx.transaction_type<>'unclassified' or tx.reconciliation_status='ignored'
  or coalesce(tx.classification_method,'') in ('manual','user_rule','transfer_match','merchant_memory','ai_suggestion')
  or tx.transfer_group_id is not null or tx.transfer_account_id is not null
  or tx.account_id<>s.source_account_id or tx.updated_at<>s.source_updated_at
  or public.transaction_merchant_fingerprint(tx) is distinct from s.fingerprint
  or (case when tx.amount<0 then 'debit' else 'credit' end)<>s.direction
  or not exists(select 1 from public.accounts where id=tx.account_id and user_id=owner_id and account_type=s.account_type and currency=s.currency)
 then next_status:='stale';
 elsif proposal is null then next_status:='failed';
 else
  -- Defensive SQL validation independently repeats the Edge schema and enum checks.
  if jsonb_typeof(proposal)='object' and (select count(*) from jsonb_object_keys(proposal))=6
   and proposal ?& array['proposed_transaction_type','proposed_category_system_key','normalized_merchant','confidence','reason','cannot_classify']
   and jsonb_typeof(proposal->'proposed_transaction_type') in ('string','null')
   and jsonb_typeof(proposal->'proposed_category_system_key') in ('string','null')
   and jsonb_typeof(proposal->'confidence')='number'
   and jsonb_typeof(proposal->'cannot_classify')='boolean'
   and jsonb_typeof(proposal->'reason')='string' and length(proposal->>'reason')<=180
   and jsonb_typeof(proposal->'normalized_merchant')='string' and length(proposal->>'normalized_merchant')<=100
  then
   schema_valid:=true;
   confidence_value:=(proposal->>'confidence')::numeric;
   select * into cat from public.transaction_categories where user_id=owner_id and system_key=proposal->>'proposed_category_system_key';
   valid:=coalesce(confidence_value between 0 and 1 and cat.id is not null
    and ((proposal->>'proposed_transaction_type'='expense' and tx.amount<0 and cat.category_type='expense')
     or (proposal->>'proposed_transaction_type'='refund' and tx.amount>0 and cat.category_type='expense')
     or (proposal->>'proposed_transaction_type'='income' and tx.amount>0 and cat.category_type='income')),false);
  end if;
  if proposal->>'cannot_classify'='true' and proposal->'proposed_transaction_type'='null'::jsonb
    and proposal->'proposed_category_system_key'='null'::jsonb and confidence_value between 0 and 1 then next_status:='low';
  elsif not valid then next_status:='invalid';
  elsif (proposal->>'cannot_classify')::boolean or confidence_value<(policy->>'medium')::numeric then next_status:='low';
  elsif confidence_value<(policy->>'high')::numeric then next_status:='suggested';
  else next_status:='auto_applied'; end if;
 end if;
 if schema_valid and confidence_value between 0 and 1 then
  update public.transaction_ai_suggestions set confidence=confidence_value,normalized_merchant=substring(s.fingerprint from 4),
    reason=case when next_status='low' then 'Il modello richiede una verifica manuale.' else 'Proposta basata sul merchant normalizzato; verifica la categoria.' end where id=s.id;
 end if;
 if valid then
  update public.transaction_ai_suggestions set proposed_transaction_type=proposal->>'proposed_transaction_type',proposed_category_id=cat.id,
    confidence=confidence_value,normalized_merchant=substring(s.fingerprint from 4),
    -- Do not persist model-generated financial identifiers or untrusted prose.
    reason=case when next_status='low' then 'Il modello richiede una verifica manuale.' else 'Proposta basata sul merchant normalizzato; verifica la categoria.' end
  where id=s.id;
 end if;
 update public.transaction_ai_suggestions set status=next_status,updated_at=now(),
  decided_at=case when next_status='auto_applied' then now() end where id=s.id;
 if next_status='auto_applied' then
  perform public.validate_classification_decision(tx.account_id,proposal->>'proposed_transaction_type',cat.id,null);
  update public.transactions set transaction_type=proposal->>'proposed_transaction_type',category_id=cat.id,
    classification_method='ai_suggestion',classification_rule_id=null,classified_at=now()
   where id=tx.id and user_id=owner_id;
 end if;
 return next_status;
end $$;
revoke all on function financialmind_classification_private.record_residual_ai_result(uuid,uuid,uuid,jsonb) from public,anon,authenticated;
-- Internal primitive; only the bounded batch endpoint below is service-callable.
create function financialmind_classification_private.record_residual_ai_batch(owner_id uuid, results jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare entry jsonb; outcome text; outcomes jsonb:='{}';
begin
 if owner_id is null or jsonb_typeof(results) is distinct from 'array'
   or jsonb_array_length(results)>(public.residual_ai_policy()->>'batch_size')::integer then raise exception 'invalid batch'; end if;
 perform set_config('request.jwt.claim.sub',owner_id::text,true);
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(owner_id::text,5));
 -- One deterministic recheck for the entire batch immediately before atomic persistence.
 perform public.classify_transactions(null);
 for entry in select value from jsonb_array_elements(results) loop
  outcome:=financialmind_classification_private.record_residual_ai_result(owner_id,(entry->>'claim_id')::uuid,(entry->>'attempt_token')::uuid,
    nullif(entry->'proposal','null'::jsonb));
  outcomes:=jsonb_set(outcomes,array[outcome],to_jsonb(coalesce((outcomes->>outcome)::integer,0)+1));
 end loop;
 return outcomes;
end $$;
revoke all on function financialmind_classification_private.record_residual_ai_batch(uuid,jsonb) from public,anon,authenticated;
grant execute on function financialmind_classification_private.record_residual_ai_batch(uuid,jsonb) to service_role;

-- Save a confirmed one-transaction decision into the existing editable rule system.
create function public.remember_transaction_merchant(transaction_id uuid, decision_type text, category_id uuid)
returns uuid language plpgsql security invoker set search_path='' as $$
declare tx public.transactions; fp text; parser text; acct_type text; rule_id uuid;
begin
 perform public.lock_classification_selection(array[transaction_id]);
 select * into tx from public.transactions where id=transaction_id and user_id=auth.uid();
 if decision_type not in ('expense','income','refund') or category_id is null then raise exception 'memory requires a category and non-transfer decision'; end if;
 perform public.validate_classification_decision(tx.account_id,decision_type,category_id,null);
 fp:=public.transaction_merchant_fingerprint(tx);
 if fp is null then raise exception 'merchant too ambiguous to remember'; end if;
 select parser_key into parser from public.import_batches where id=tx.import_batch_id and user_id=auth.uid();
 select account_type into acct_type from public.accounts where id=tx.account_id and user_id=auth.uid();
 insert into public.transaction_classification_rules(name,priority,parser_key,match_field,match_operator,pattern,
   amount_direction,memory_account_type,target_transaction_type,target_category_id)
 values('Merchant: '||substring(fp from 4),100,parser,'merchant_fingerprint','exact',fp,
   case when tx.amount<0 then 'debit' else 'credit' end,acct_type,decision_type,category_id)
 on conflict(user_id,parser_key,amount_direction,memory_account_type,pattern) where match_field='merchant_fingerprint'
 do update set target_transaction_type=excluded.target_transaction_type,target_category_id=excluded.target_category_id,is_active=true
 returning id into rule_id;
 perform public.bulk_classify_transactions(array[tx.id],decision_type,category_id,null);
 -- This explicit confirmation remains manual; future matching decisions use merchant_memory.
 return rule_id;
end $$;
revoke all on function public.remember_transaction_merchant(uuid,text,uuid) from public,anon;
grant execute on function public.remember_transaction_merchant(uuid,text,uuid) to authenticated;

create function financialmind_classification_private.review_ai_suggestion(suggestion_id uuid, action text) returns void
language plpgsql security definer set search_path='' as $$
declare s public.transaction_ai_suggestions; tx public.transactions;
begin
 if auth.uid() is null then raise exception 'authentication required'; end if;
 if action is null or action not in ('approve','remember','reject') then raise exception 'invalid review action'; end if;
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(auth.uid()::text,5));
 select * into s from public.transaction_ai_suggestions where id=suggestion_id and user_id=auth.uid() for update;
 if s.id is null or s.status<>'suggested' then raise exception 'suggestion not pending or not owned'; end if;
 select * into tx from public.transactions where id=s.transaction_id and user_id=auth.uid() for update;
 if action<>'reject' then
  if tx.id is null or tx.account_id<>s.source_account_id or tx.updated_at<>s.source_updated_at
    or not exists(select 1 from public.transaction_categories where id=s.proposed_category_id and user_id=auth.uid())
    or tx.transaction_type<>'unclassified' or coalesce(tx.classification_method,'') in ('manual','user_rule','transfer_match','merchant_memory','ai_suggestion')
    or tx.reconciliation_status='ignored' or tx.transfer_group_id is not null or tx.transfer_account_id is not null
    or public.transaction_merchant_fingerprint(tx) is distinct from s.fingerprint
    or (case when tx.amount<0 then 'debit' else 'credit' end)<>s.direction
    or not exists(select 1 from public.accounts where id=tx.account_id and user_id=auth.uid() and account_type=s.account_type and currency=s.currency)
   then raise exception 'transaction changed or protected'; end if;
  if action='remember' then perform public.remember_transaction_merchant(tx.id,s.proposed_transaction_type,s.proposed_category_id);
  else perform public.bulk_classify_transactions(array[tx.id],s.proposed_transaction_type,s.proposed_category_id,null); end if;
 end if;
 update public.transaction_ai_suggestions set status=case action when 'approve' then 'approved' when 'remember' then 'remembered' else 'rejected' end,
   decided_at=now(),updated_at=now() where id=s.id and user_id=auth.uid();
end $$;
revoke all on function financialmind_classification_private.review_ai_suggestion(uuid,text) from public,anon;
grant execute on function financialmind_classification_private.review_ai_suggestion(uuid,text) to authenticated;

create function public.pending_ai_suggestions() returns jsonb language sql stable security invoker set search_path='' as $$
 select coalesce(jsonb_agg(jsonb_build_object('id',s.id,'transaction_id',t.id,'merchant',s.normalized_merchant,
  'description',t.description,'transaction_type',s.proposed_transaction_type,'category',c.name,
  'confidence',s.confidence,'reason',s.reason) order by s.created_at,s.id),'[]'::jsonb)
 from (select * from public.transaction_ai_suggestions where user_id=auth.uid() and status='suggested'
  order by created_at,id limit 50) s
 join public.transactions t on t.id=s.transaction_id and t.user_id=auth.uid()
 join public.transaction_categories c on c.id=s.proposed_category_id and c.user_id=auth.uid()
 where t.transaction_type='unclassified' and coalesce(t.classification_method,'') not in ('manual','user_rule','transfer_match','merchant_memory','ai_suggestion')
  and t.reconciliation_status<>'ignored' and t.transfer_group_id is null and t.transfer_account_id is null
$$;
revoke all on function public.pending_ai_suggestions() from public,anon;
grant execute on function public.pending_ai_suggestions() to authenticated;
-- Exposed RPCs are invoker wrappers; private implementations enforce audit ownership.
create function public.claim_residual_ai_batch() returns jsonb
language sql security invoker set search_path='' as $$ select financialmind_classification_private.claim_residual_ai_batch() $$;
revoke all on function public.claim_residual_ai_batch() from public,anon;
grant execute on function public.claim_residual_ai_batch() to authenticated;
create function public.record_residual_ai_batch(owner_id uuid, results jsonb) returns jsonb
language sql security invoker set search_path='' as $$ select financialmind_classification_private.record_residual_ai_batch(owner_id,results) $$;
revoke all on function public.record_residual_ai_batch(uuid,jsonb) from public,anon,authenticated;
grant execute on function public.record_residual_ai_batch(uuid,jsonb) to service_role;
create function public.review_ai_suggestion(suggestion_id uuid, action text) returns void
language sql security invoker set search_path='' as $$ select financialmind_classification_private.review_ai_suggestion(suggestion_id,action) $$;
revoke all on function public.review_ai_suggestion(uuid,text) from public,anon;
grant execute on function public.review_ai_suggestion(uuid,text) to authenticated;
commit;
