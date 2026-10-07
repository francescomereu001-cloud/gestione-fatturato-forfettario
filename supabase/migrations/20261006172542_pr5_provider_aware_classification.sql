-- PR5: provider-aware deterministic classification. No live classification runs here.
begin;

create function public.normalize_classification_text(value text)
returns text language sql immutable security invoker set search_path = ''
as $$ select lower(btrim(regexp_replace(coalesce(value, ''), '[[:space:]]+', ' ', 'g'))) $$;
revoke all on function public.normalize_classification_text(text) from public, anon;
grant execute on function public.normalize_classification_text(text) to authenticated;

-- Known institution aliases only; unknown/missing institutions do not match savings/cards.
create function public.classification_institution_key(value text)
returns text language sql immutable security invoker set search_path = '' as $$
  select case public.normalize_classification_text(value)
    when 'isy bank' then 'isybank' when 'isybank' then 'isybank'
    when 'intesa sanpaolo' then 'isybank'
    else public.normalize_classification_text(value) end
$$;
revoke all on function public.classification_institution_key(text) from public, anon;
grant execute on function public.classification_institution_key(text) to authenticated;

-- Pure metadata/merchant lookup. Account/type semantics stay in the server RPC below.
create function public.provider_category_key(parser text, category text, details text, description text)
returns text language plpgsql immutable security invoker set search_path = '' as $$
declare
  c text := public.normalize_classification_text(category);
  d text := public.normalize_classification_text(details);
  merchant text := public.normalize_classification_text(description);
begin
  if parser = 'isybank_operations_v1' then
    return case c
      when 'ristoranti e bar' then 'expense_dining'
      when 'tabaccai e simili' then 'expense_tobacco'
      when 'generi alimentari e supermercato' then 'expense_food'
      when 'domiciliazioni e utenze' then 'expense_home'
      when 'carburanti' then 'expense_auto'
      when 'imposte sul reddito e tasse varie' then 'expense_taxes'
      when 'viaggi e vacanze' then 'expense_travel'
      when 'tempo libero varie' then 'expense_leisure'
      when 'cura della persona' then 'expense_personal'
      when 'trasporti, noleggi, taxi e parcheggi' then 'expense_transport'
      when 'trasporti varie' then 'expense_transport'
      when 'spettacoli e musei' then 'expense_leisure'
      when 'manutenzione veicoli' then 'expense_auto'
      when 'abbigliamento e accessori' then 'expense_shopping'
      when 'imposte, bolli e commissioni' then 'expense_fees'
      when 'farmacia' then 'expense_health'
      when 'casa varie' then 'expense_home'
      when 'multe' then 'expense_fines'
      when 'polizze' then 'expense_insurance'
      when 'regali' then 'expense_gifts'
      when 'tv, internet, telefono' then 'expense_home'
      when 'treno, aereo, nave' then 'expense_travel'
      when 'hi-tech e informatica' then 'expense_shopping'
      when 'corsi e sport' then 'expense_leisure'
      when 'cellulare' then 'expense_home'
      when 'pedaggi e telepass' then 'expense_auto'
      when 'gas & energia elettrica' then 'expense_home'
      when 'salute e benessere varie' then 'expense_health'
      else null end;
  elsif parser = 'american_express_v1' then
    -- Full descriptors or a descriptor followed by provider detail; no substring guessing.
    if d ~ '^(ristoranti|fast food|bar, tavola calda, pub)($|[ :;,./-])' then return 'expense_dining'; end if;
    if d ~ '^(stazioni di servizio( self service)?)($|[ :;,./-])' then return 'expense_auto'; end if;
    if d ~ '^(supermercato|alimentari vari)($|[ :;,./-])' then return 'expense_food'; end if;
    if d ~ '^(alberghi|ferrovie servizio passeggeri|noleggio barche)($|[ :;,./-])' then return 'expense_travel'; end if;
    if d ~ '^(abbigliamento( maschile e femminile| sportivo)?|grandi magazzini)($|[ :;,./-])' then return 'expense_shopping'; end if;
    if d ~ '^(autorimesse, parcheggi, garage)($|[ :;,./-])' then return 'expense_transport'; end if;
    if d ~ '^(biglietteria eventi sportivi e teatrali)($|[ :;,./-])' then return 'expense_leisure'; end if;
    if d ~ '^(farmacia)($|[ :;,./-])' then return 'expense_health'; end if;
    if merchant ~ '^(deliveroo|mc ?donald(s|''s)?|autogrill|ristorante|bar|caffetteria|caff[eè])($|[ *./-])' then return 'expense_dining'; end if;
    if merchant ~ '^(q8|eni|esso|tamoil|distributore carburante)($|[ *./-])|^ip (stazione|carburanti|distributore)($|[ ./-])' then return 'expense_auto'; end if;
    if merchant ~ '^(booking([.]com)?|hotel|albergo|sixt|indie campers)($|[ *./-])' then return 'expense_travel'; end if;
    if merchant ~ '^(uber|www[.]apcoa[.]it|sogaer spa parcheggi)($|[ *./-])' then return 'expense_transport'; end if;
    if merchant ~ '^amazon prime($|[ *./-])' then return 'expense_subscriptions'; end if;
    if merchant ~ '^playstation($|[ *./-])' then return 'expense_leisure'; end if;
    if merchant ~ '^(amzn mktp|zara|la rinascente|decathlon)($|[ *./-])' then return 'expense_shopping'; end if;
    if merchant ~ '^(commissione prelievo contante|imposta di bollo|quota associativa mensile esente da iva)($|[ ./-])' then return 'expense_fees'; end if;
    -- SaaS (OpenAI/ChatGPT, Claude, Adobe, Aruba, Emergent) uses subscriptions;
    -- Cerved uses professional services. These labels imply no tax deductibility.
    if merchant ~ '^(openai|chatgpt|claude[.]ai|adobe|aruba|emergent|paddle[ *]+emergent)($|[ *./-])' then return 'expense_subscriptions'; end if;
    if merchant ~ '^cerved($|[ *./-])' then return 'expense_work'; end if;
  end if;
  return null;
end $$;
revoke all on function public.provider_category_key(text, text, text, text) from public, anon;
grant execute on function public.provider_category_key(text, text, text, text) to authenticated;

-- Provenance remains in staging. This index supports the per-transaction metadata lookup.
create index import_rows_classification_provenance_idx
  on public.import_rows(user_id, matched_transaction_id, batch_id) where status = 'imported';

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
      and (t.transaction_type = 'unclassified' or t.classification_method = 'provider_rule')
      and coalesce(t.classification_method, '') not in ('manual','user_rule','transfer_match')
      and not (t.transaction_type in ('internal_transfer','investment_transfer') and t.reconciliation_status = 'confirmed')
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
        and case r.match_operator
          when 'exact' then public.normalize_classification_text(case r.match_field when 'description' then tx.description else tx.merchant end) = public.normalize_classification_text(r.pattern)
          when 'contains' then strpos(public.normalize_classification_text(case r.match_field when 'description' then tx.description else tx.merchant end), public.normalize_classification_text(r.pattern)) > 0
          else starts_with(public.normalize_classification_text(case r.match_field when 'description' then tx.description else tx.merchant end), public.normalize_classification_text(r.pattern))
        end
      order by r.priority desc, r.created_at, r.id limit 1;
    if selected_rule.id is not null then
      update public.transactions set transaction_type = coalesce(selected_rule.target_transaction_type, transaction_type),
        category_id = coalesce(selected_rule.target_category_id, category_id), merchant = coalesce(selected_rule.target_merchant, merchant),
        classification_method = 'user_rule', classification_rule_id = selected_rule.id, classified_at = now()
        where id = tx.id and user_id = auth.uid();
      classified := classified + 1;
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
    -- Require a unique normalized semantic tuple, not an arbitrary raw row. Multiple
    -- imported provenance rows agreeing on metadata are safe; conflicting rows are not.
    select count(*) into metadata_variants from (
      select distinct public.normalize_classification_text(r.raw_data ->> 'Categoria'),
        public.normalize_classification_text(r.raw_data ->> 'Dettagli completi'),
        public.normalize_classification_text(r.raw_data ->> 'Operazione')
      from public.import_rows r where r.matched_transaction_id = tx.id and r.user_id = auth.uid()
        and r.batch_id = tx.import_batch_id and r.status = 'imported'
    ) variants;
    metadata := '{}';
    if metadata_variants = 1 then
      select r.raw_data into metadata from public.import_rows r
        where r.matched_transaction_id = tx.id and r.user_id = auth.uid()
          and r.batch_id = tx.import_batch_id and r.status = 'imported'
        order by r.row_index, r.id limit 1;
    end if;
    provider_category := public.normalize_classification_text(metadata ->> 'Categoria');
    operation := public.normalize_classification_text(metadata ->> 'Operazione');
    description := public.normalize_classification_text(tx.description);
    system_category := null;
    next_type := 'unclassified'; next_category := null; next_target := null;
    next_status := 'pending';

    if metadata_variants > 1 then
      -- Conflicting provenance stays neutral even if the amount/description looks familiar.
      null;
    elsif parser = 'isybank_operations_v1' then
      if (operation || ' ' || description) ~ '(^|[^[:alnum:]])salvadanaio($|[^[:alnum:]])' then
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
        or (description ~ '(^|[^[:alnum:]])(pago ?pa|bonifico|cash advance|prelievo contante)($|[^[:alnum:]])'
          and description !~ '^commissione prelievo contante($| )') then
        -- Explicit cash-advance candidates (BANCO DI SARDEG*, POSTE ITALIANE 07601),
        -- and ambiguous Poste/PagoPA/bank transfers never become consumption by sign.
        null;
      else
        next_type := case when tx.amount < 0 then 'expense' else 'refund' end;
        system_category := public.provider_category_key(parser, null, metadata ->> 'Dettagli completi', description);
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

commit;
