-- PR5 executable PostgreSQL regression suite. Synthetic fixtures only; everything rolls back.
-- Apply repository migrations first, then: psql -v ON_ERROR_STOP=1 -f supabase/tests/pr5_provider_classification.sql
begin;
create function pg_temp.assert_true(condition boolean, label text) returns void language plpgsql as $$
begin
  if condition is distinct from true then raise exception 'FAIL: %', label; end if;
  raise notice 'PASS: %', label;
end $$;
create function pg_temp.expect_error(statement text, expected_message text, label text) returns void language plpgsql as $$
declare rejected boolean := false;
begin
  begin execute statement;
  exception when others then
    if strpos(sqlerrm, expected_message) = 0 then raise; end if;
    rejected := true;
  end;
  perform pg_temp.assert_true(rejected, label);
end $$;
select set_config('test.owner', gen_random_uuid()::text, true), set_config('test.other', gen_random_uuid()::text, true);
insert into auth.users(id) values (current_setting('test.owner')::uuid), (current_setting('test.other')::uuid);
-- Known local IDs are generated for each run; no production identifiers.
do $$
declare kind text; account_id uuid;
begin
  foreach kind in array array['checking','savings','broker','amex','isycard','second_savings','second_broker','second_amex','second_isycard'] loop
    account_id := gen_random_uuid();
    perform set_config('test.' || kind, account_id::text, true);
    insert into public.accounts(id, user_id, name, institution, account_type, is_active)
      values(account_id, current_setting('test.owner')::uuid, 'Synthetic ' || kind,
        case when kind like '%amex' then 'American Express' else 'IsyBank' end,
        case when kind like '%amex' or kind like '%isycard' then 'credit_card'
          when kind like '%savings' then 'savings' when kind like '%broker' then 'broker' else 'checking' end,
        kind not like 'second_%');
  end loop;
end $$;
insert into public.accounts(user_id, name, institution, account_type)
  values(current_setting('test.other')::uuid, 'Synthetic foreign savings', 'IsyBank','savings'),
    (current_setting('test.other')::uuid, 'Synthetic foreign broker','IsyBank','broker'),
    (current_setting('test.other')::uuid, 'Synthetic foreign amex','American Express','credit_card');
select set_config('request.jwt.claim.sub', current_setting('test.owner'), true);
set local role authenticated;
create temp table fixtures(label text primary key, tx_id uuid, expected_type text, expected_key text, expected_target uuid);
create function pg_temp.fixture(label text, parser text, raw jsonb, description text,
  expected_type text, expected_key text default null, amount numeric default null,
  method text default null, initial_type text default 'unclassified', account text default 'checking',
  expected_target text default null) returns uuid language plpgsql security invoker as $$
declare batch uuid; tx uuid; row_number integer;
begin
  select count(*) + 1 into row_number from fixtures;
  insert into public.import_batches(account_id, source_format, parser_key, row_count)
    values(current_setting('test.' || account)::uuid, 'xlsx', parser, 1) returning id into batch;
  insert into public.transactions(account_id, transaction_date, amount, description, transaction_type,
    classification_method, import_batch_id, source, classified_at)
    values(current_setting('test.' || account)::uuid, '2026-01-01', coalesce(amount, -1000-row_number),
      description, initial_type, method, batch, 'bank_import', case when method is not null then '2025-01-01'::timestamptz end)
    returning id into tx;
  insert into public.import_rows(batch_id, row_index, matched_transaction_id, raw_data, status)
    values(batch, 0, tx, raw, 'imported');
  insert into fixtures values(label, tx, expected_type, expected_key,
    case when expected_target is not null then current_setting('test.' || expected_target)::uuid end);
  return tx;
end $$;
insert into public.transaction_categories(name, category_type, system_key) values
  ('Synthetic auto', 'expense', 'expense_auto'),
  ('Synthetic dining', 'expense', 'expense_dining'),
  ('Synthetic fees', 'expense', 'expense_fees'),
  ('Synthetic fines', 'expense', 'expense_fines'),
  ('Synthetic food', 'expense', 'expense_food'),
  ('Synthetic gifts', 'expense', 'expense_gifts'),
  ('Synthetic health', 'expense', 'expense_health'),
  ('Synthetic home', 'expense', 'expense_home'),
  ('Synthetic insurance', 'expense', 'expense_insurance'),
  ('Synthetic leisure', 'expense', 'expense_leisure'),
  ('Synthetic personal', 'expense', 'expense_personal'),
  ('Synthetic shopping', 'expense', 'expense_shopping'),
  ('Synthetic subscriptions', 'expense', 'expense_subscriptions'),
  ('Synthetic taxes', 'expense', 'expense_taxes'),
  ('Synthetic tobacco', 'expense', 'expense_tobacco'),
  ('Synthetic transport', 'expense', 'expense_transport'),
  ('Synthetic travel', 'expense', 'expense_travel'),
  ('Synthetic work', 'expense', 'expense_work');
insert into public.import_account_mappings(parser_key,source_instrument,account_id) values ('isybank_operations_v1','Carta di credito synthetic',current_setting('test.isycard')::uuid);
select pg_temp.fixture('Isy Ristoranti e bar', 'isybank_operations_v1', jsonb_build_object('Categoria','Ristoranti e bar'), 'Synthetic debit', 'expense', 'expense_dining');
select pg_temp.fixture('Isy Tabaccai e simili', 'isybank_operations_v1', jsonb_build_object('Categoria','Tabaccai e simili'), 'Synthetic debit', 'expense', 'expense_tobacco');
select pg_temp.fixture('Isy Generi alimentari e supermercato', 'isybank_operations_v1', jsonb_build_object('Categoria','Generi alimentari e supermercato'), 'Synthetic debit', 'expense', 'expense_food');
select pg_temp.fixture('Isy Domiciliazioni e Utenze', 'isybank_operations_v1', jsonb_build_object('Categoria','Domiciliazioni e Utenze'), 'Synthetic debit', 'expense', 'expense_home');
select pg_temp.fixture('Isy Carburanti', 'isybank_operations_v1', jsonb_build_object('Categoria','Carburanti'), 'Synthetic debit', 'expense', 'expense_auto');
select pg_temp.fixture('Isy Imposte sul reddito e tasse varie', 'isybank_operations_v1', jsonb_build_object('Categoria','Imposte sul reddito e tasse varie'), 'Synthetic debit', 'expense', 'expense_taxes');
select pg_temp.fixture('Isy Viaggi e vacanze', 'isybank_operations_v1', jsonb_build_object('Categoria','Viaggi e vacanze'), 'Synthetic debit', 'expense', 'expense_travel');
select pg_temp.fixture('Isy Tempo libero varie', 'isybank_operations_v1', jsonb_build_object('Categoria','Tempo libero varie'), 'Synthetic debit', 'expense', 'expense_leisure');
select pg_temp.fixture('Isy Cura della persona', 'isybank_operations_v1', jsonb_build_object('Categoria','Cura della persona'), 'Synthetic debit', 'expense', 'expense_personal');
select pg_temp.fixture('Isy Trasporti, noleggi, taxi e parcheggi', 'isybank_operations_v1', jsonb_build_object('Categoria','Trasporti, noleggi, taxi e parcheggi'), 'Synthetic debit', 'expense', 'expense_transport');
select pg_temp.fixture('Isy Trasporti varie', 'isybank_operations_v1', jsonb_build_object('Categoria','Trasporti varie'), 'Synthetic debit', 'expense', 'expense_transport');
select pg_temp.fixture('Isy Spettacoli e musei', 'isybank_operations_v1', jsonb_build_object('Categoria','Spettacoli e musei'), 'Synthetic debit', 'expense', 'expense_leisure');
select pg_temp.fixture('Isy Manutenzione veicoli', 'isybank_operations_v1', jsonb_build_object('Categoria','Manutenzione veicoli'), 'Synthetic debit', 'expense', 'expense_auto');
select pg_temp.fixture('Isy Abbigliamento e accessori', 'isybank_operations_v1', jsonb_build_object('Categoria','Abbigliamento e accessori'), 'Synthetic debit', 'expense', 'expense_shopping');
select pg_temp.fixture('Isy Imposte, bolli e commissioni', 'isybank_operations_v1', jsonb_build_object('Categoria','Imposte, bolli e commissioni'), 'Synthetic debit', 'expense', 'expense_fees');
select pg_temp.fixture('Isy Farmacia', 'isybank_operations_v1', jsonb_build_object('Categoria','Farmacia'), 'Synthetic debit', 'expense', 'expense_health');
select pg_temp.fixture('Isy Casa varie', 'isybank_operations_v1', jsonb_build_object('Categoria','Casa varie'), 'Synthetic debit', 'expense', 'expense_home');
select pg_temp.fixture('Isy Multe', 'isybank_operations_v1', jsonb_build_object('Categoria','Multe'), 'Synthetic debit', 'expense', 'expense_fines');
select pg_temp.fixture('Isy Polizze', 'isybank_operations_v1', jsonb_build_object('Categoria','Polizze'), 'Synthetic debit', 'expense', 'expense_insurance');
select pg_temp.fixture('Isy Regali', 'isybank_operations_v1', jsonb_build_object('Categoria','Regali'), 'Synthetic debit', 'expense', 'expense_gifts');
select pg_temp.fixture('Isy TV, Internet, telefono', 'isybank_operations_v1', jsonb_build_object('Categoria','TV, Internet, telefono'), 'Synthetic debit', 'expense', 'expense_home');
select pg_temp.fixture('Isy Treno, aereo, nave', 'isybank_operations_v1', jsonb_build_object('Categoria','Treno, aereo, nave'), 'Synthetic debit', 'expense', 'expense_travel');
select pg_temp.fixture('Isy Hi-tech e informatica', 'isybank_operations_v1', jsonb_build_object('Categoria','Hi-tech e informatica'), 'Synthetic debit', 'expense', 'expense_shopping');
select pg_temp.fixture('Isy Corsi e sport', 'isybank_operations_v1', jsonb_build_object('Categoria','Corsi e sport'), 'Synthetic debit', 'expense', 'expense_leisure');
select pg_temp.fixture('Isy Cellulare', 'isybank_operations_v1', jsonb_build_object('Categoria','Cellulare'), 'Synthetic debit', 'expense', 'expense_home');
select pg_temp.fixture('Isy Pedaggi e Telepass', 'isybank_operations_v1', jsonb_build_object('Categoria','Pedaggi e Telepass'), 'Synthetic debit', 'expense', 'expense_auto');
select pg_temp.fixture('Isy Gas & energia elettrica', 'isybank_operations_v1', jsonb_build_object('Categoria','Gas & energia elettrica'), 'Synthetic debit', 'expense', 'expense_home');
select pg_temp.fixture('Isy Salute e benessere varie', 'isybank_operations_v1', jsonb_build_object('Categoria','Salute e benessere varie'), 'Synthetic debit', 'expense', 'expense_health');
select pg_temp.fixture('AMEX Ristoranti', 'american_express_v1', jsonb_build_object('Dettagli completi','Ristoranti', 'Categoria','Miscellaneous-Other'), 'Synthetic merchant', 'expense', 'expense_dining', method => 'provider_rule', initial_type => 'expense', account => 'amex');
select pg_temp.fixture('AMEX Fast Food', 'american_express_v1', jsonb_build_object('Dettagli completi','Fast Food', 'Categoria','Miscellaneous-Other'), 'Synthetic merchant', 'expense', 'expense_dining', method => 'provider_rule', initial_type => 'expense', account => 'amex');
select pg_temp.fixture('AMEX Bar, Tavola Calda, Pub', 'american_express_v1', jsonb_build_object('Dettagli completi','Bar, Tavola Calda, Pub', 'Categoria','Miscellaneous-Other'), 'Synthetic merchant', 'expense', 'expense_dining', method => 'provider_rule', initial_type => 'expense', account => 'amex');
select pg_temp.fixture('AMEX Stazioni di servizio', 'american_express_v1', jsonb_build_object('Dettagli completi','Stazioni di servizio', 'Categoria','Miscellaneous-Other'), 'Synthetic merchant', 'expense', 'expense_auto', method => 'provider_rule', initial_type => 'expense', account => 'amex');
select pg_temp.fixture('AMEX Stazioni di servizio Self Service', 'american_express_v1', jsonb_build_object('Dettagli completi','Stazioni di servizio Self Service', 'Categoria','Miscellaneous-Other'), 'Synthetic merchant', 'expense', 'expense_auto', method => 'provider_rule', initial_type => 'expense', account => 'amex');
select pg_temp.fixture('AMEX Supermercato', 'american_express_v1', jsonb_build_object('Dettagli completi','Supermercato', 'Categoria','Miscellaneous-Other'), 'Synthetic merchant', 'expense', 'expense_food', method => 'provider_rule', initial_type => 'expense', account => 'amex');
select pg_temp.fixture('AMEX Alimentari vari', 'american_express_v1', jsonb_build_object('Dettagli completi','Alimentari vari', 'Categoria','Miscellaneous-Other'), 'Synthetic merchant', 'expense', 'expense_food', method => 'provider_rule', initial_type => 'expense', account => 'amex');
select pg_temp.fixture('AMEX Alberghi', 'american_express_v1', jsonb_build_object('Dettagli completi','Alberghi', 'Categoria','Miscellaneous-Other'), 'Synthetic merchant', 'expense', 'expense_travel', method => 'provider_rule', initial_type => 'expense', account => 'amex');
select pg_temp.fixture('AMEX Abbigliamento', 'american_express_v1', jsonb_build_object('Dettagli completi','Abbigliamento', 'Categoria','Miscellaneous-Other'), 'Synthetic merchant', 'expense', 'expense_shopping', method => 'provider_rule', initial_type => 'expense', account => 'amex');
select pg_temp.fixture('AMEX Abbigliamento maschile e femminile', 'american_express_v1', jsonb_build_object('Dettagli completi','Abbigliamento maschile e femminile', 'Categoria','Miscellaneous-Other'), 'Synthetic merchant', 'expense', 'expense_shopping', method => 'provider_rule', initial_type => 'expense', account => 'amex');
select pg_temp.fixture('AMEX Abbigliamento Sportivo', 'american_express_v1', jsonb_build_object('Dettagli completi','Abbigliamento Sportivo', 'Categoria','Miscellaneous-Other'), 'Synthetic merchant', 'expense', 'expense_shopping', method => 'provider_rule', initial_type => 'expense', account => 'amex');
select pg_temp.fixture('AMEX Grandi magazzini', 'american_express_v1', jsonb_build_object('Dettagli completi','Grandi magazzini', 'Categoria','Miscellaneous-Other'), 'Synthetic merchant', 'expense', 'expense_shopping', method => 'provider_rule', initial_type => 'expense', account => 'amex');
select pg_temp.fixture('AMEX Autorimesse, Parcheggi, Garage', 'american_express_v1', jsonb_build_object('Dettagli completi','Autorimesse, Parcheggi, Garage', 'Categoria','Miscellaneous-Other'), 'Synthetic merchant', 'expense', 'expense_transport', method => 'provider_rule', initial_type => 'expense', account => 'amex');
select pg_temp.fixture('AMEX Biglietteria eventi sportivi e teatrali', 'american_express_v1', jsonb_build_object('Dettagli completi','Biglietteria eventi sportivi e teatrali', 'Categoria','Miscellaneous-Other'), 'Synthetic merchant', 'expense', 'expense_leisure', method => 'provider_rule', initial_type => 'expense', account => 'amex');
select pg_temp.fixture('AMEX Farmacia', 'american_express_v1', jsonb_build_object('Dettagli completi','Farmacia', 'Categoria','Miscellaneous-Other'), 'Synthetic merchant', 'expense', 'expense_health', method => 'provider_rule', initial_type => 'expense', account => 'amex');
select pg_temp.fixture('AMEX Ferrovie servizio passeggeri', 'american_express_v1', jsonb_build_object('Dettagli completi','Ferrovie servizio passeggeri', 'Categoria','Miscellaneous-Other'), 'Synthetic merchant', 'expense', 'expense_travel', method => 'provider_rule', initial_type => 'expense', account => 'amex');
select pg_temp.fixture('AMEX Noleggio barche', 'american_express_v1', jsonb_build_object('Dettagli completi','Noleggio barche', 'Categoria','Miscellaneous-Other'), 'Synthetic merchant', 'expense', 'expense_travel', method => 'provider_rule', initial_type => 'expense', account => 'amex');
select pg_temp.fixture('Merchant DELIVEROO ROMA', 'american_express_v1', '{}', 'DELIVEROO ROMA', 'expense', 'expense_dining', account => 'amex');
select pg_temp.fixture('Merchant MCDONALDS ROMA', 'american_express_v1', '{}', 'MCDONALDS ROMA', 'expense', 'expense_dining', account => 'amex');
select pg_temp.fixture('Merchant MC DONALD ROMA', 'american_express_v1', '{}', 'MC DONALD ROMA', 'expense', 'expense_dining', account => 'amex');
select pg_temp.fixture('Merchant RISTORANTE TEST', 'american_express_v1', '{}', 'RISTORANTE TEST', 'expense', 'expense_dining', account => 'amex');
select pg_temp.fixture('Merchant AUTOGRILL ROMA', 'american_express_v1', '{}', 'AUTOGRILL ROMA', 'expense', 'expense_dining', account => 'amex');
select pg_temp.fixture('Merchant BAR TEST', 'american_express_v1', '{}', 'BAR TEST', 'expense', 'expense_dining', account => 'amex');
select pg_temp.fixture('Merchant CAFFETTERIA TEST', 'american_express_v1', '{}', 'CAFFETTERIA TEST', 'expense', 'expense_dining', account => 'amex');
select pg_temp.fixture('Merchant CAFFÈ TEST', 'american_express_v1', '{}', 'CAFFÈ TEST', 'expense', 'expense_dining', account => 'amex');
select pg_temp.fixture('Merchant Q8 ROMA', 'american_express_v1', '{}', 'Q8 ROMA', 'expense', 'expense_auto', account => 'amex');
select pg_temp.fixture('Merchant ENI ROMA', 'american_express_v1', '{}', 'ENI ROMA', 'expense', 'expense_auto', account => 'amex');
select pg_temp.fixture('Merchant ESSO ROMA', 'american_express_v1', '{}', 'ESSO ROMA', 'expense', 'expense_auto', account => 'amex');
select pg_temp.fixture('Merchant TAMOIL ROMA', 'american_express_v1', '{}', 'TAMOIL ROMA', 'expense', 'expense_auto', account => 'amex');
select pg_temp.fixture('Merchant DISTRIBUTORE CARBURANTE TEST', 'american_express_v1', '{}', 'DISTRIBUTORE CARBURANTE TEST', 'expense', 'expense_auto', account => 'amex');
select pg_temp.fixture('Merchant IP STAZIONE TEST', 'american_express_v1', '{}', 'IP STAZIONE TEST', 'expense', 'expense_auto', account => 'amex');
select pg_temp.fixture('Merchant BOOKING.COM HOTEL', 'american_express_v1', '{}', 'BOOKING.COM HOTEL', 'expense', 'expense_travel', account => 'amex');
select pg_temp.fixture('Merchant HOTEL TEST', 'american_express_v1', '{}', 'HOTEL TEST', 'expense', 'expense_travel', account => 'amex');
select pg_temp.fixture('Merchant ALBERGO TEST', 'american_express_v1', '{}', 'ALBERGO TEST', 'expense', 'expense_travel', account => 'amex');
select pg_temp.fixture('Merchant SIXT ROMA', 'american_express_v1', '{}', 'SIXT ROMA', 'expense', 'expense_travel', account => 'amex');
select pg_temp.fixture('Merchant INDIE CAMPERS TEST', 'american_express_v1', '{}', 'INDIE CAMPERS TEST', 'expense', 'expense_travel', account => 'amex');
select pg_temp.fixture('Merchant UBER ROMA', 'american_express_v1', '{}', 'UBER ROMA', 'expense', 'expense_transport', account => 'amex');
select pg_temp.fixture('Merchant WWW.APCOA.IT TEST', 'american_express_v1', '{}', 'WWW.APCOA.IT TEST', 'expense', 'expense_transport', account => 'amex');
select pg_temp.fixture('Merchant SOGAER SPA PARCHEGGI', 'american_express_v1', '{}', 'SOGAER SPA PARCHEGGI', 'expense', 'expense_transport', account => 'amex');
select pg_temp.fixture('Merchant AMAZON PRIME', 'american_express_v1', '{}', 'AMAZON PRIME', 'expense', 'expense_subscriptions', account => 'amex');
select pg_temp.fixture('Merchant PLAYSTATION', 'american_express_v1', '{}', 'PLAYSTATION', 'expense', 'expense_leisure', account => 'amex');
select pg_temp.fixture('Merchant AMZN MKTP TEST', 'american_express_v1', '{}', 'AMZN MKTP TEST', 'expense', 'expense_shopping', account => 'amex');
select pg_temp.fixture('Merchant ZARA ROMA', 'american_express_v1', '{}', 'ZARA ROMA', 'expense', 'expense_shopping', account => 'amex');
select pg_temp.fixture('Merchant LA RINASCENTE ROMA', 'american_express_v1', '{}', 'LA RINASCENTE ROMA', 'expense', 'expense_shopping', account => 'amex');
select pg_temp.fixture('Merchant DECATHLON ROMA', 'american_express_v1', '{}', 'DECATHLON ROMA', 'expense', 'expense_shopping', account => 'amex');
select pg_temp.fixture('Merchant COMMISSIONE PRELIEVO CONTANTE', 'american_express_v1', '{}', 'COMMISSIONE PRELIEVO CONTANTE', 'expense', 'expense_fees', account => 'amex');
select pg_temp.fixture('Merchant IMPOSTA DI BOLLO', 'american_express_v1', '{}', 'IMPOSTA DI BOLLO', 'expense', 'expense_fees', account => 'amex');
select pg_temp.fixture('Merchant QUOTA ASSOCIATIVA MENSILE ESENTE DA IVA', 'american_express_v1', '{}', 'QUOTA ASSOCIATIVA MENSILE ESENTE DA IVA', 'expense', 'expense_fees', account => 'amex');
select pg_temp.fixture('Merchant OPENAI *CHATGPT', 'american_express_v1', '{}', 'OPENAI *CHATGPT', 'expense', 'expense_subscriptions', account => 'amex');
select pg_temp.fixture('Merchant CHATGPT', 'american_express_v1', '{}', 'CHATGPT', 'expense', 'expense_subscriptions', account => 'amex');
select pg_temp.fixture('Merchant CLAUDE.AI', 'american_express_v1', '{}', 'CLAUDE.AI', 'expense', 'expense_subscriptions', account => 'amex');
select pg_temp.fixture('Merchant ADOBE', 'american_express_v1', '{}', 'ADOBE', 'expense', 'expense_subscriptions', account => 'amex');
select pg_temp.fixture('Merchant ARUBA', 'american_express_v1', '{}', 'ARUBA', 'expense', 'expense_subscriptions', account => 'amex');
select pg_temp.fixture('Merchant CERVED', 'american_express_v1', '{}', 'CERVED', 'expense', 'expense_work', account => 'amex');
select pg_temp.fixture('Merchant EMERGENT', 'american_express_v1', '{}', 'EMERGENT', 'expense', 'expense_subscriptions', account => 'amex');
select pg_temp.fixture('Merchant PADDLE *EMERGENT', 'american_express_v1', '{}', 'PADDLE *EMERGENT', 'expense', 'expense_subscriptions', account => 'amex');
select pg_temp.fixture('Isy ambiguous Prelievi', 'isybank_operations_v1', jsonb_build_object('Categoria','Prelievi'), 'Synthetic ambiguous', 'unclassified', amount => null);
select pg_temp.fixture('Isy ambiguous Bonifici ricevuti', 'isybank_operations_v1', jsonb_build_object('Categoria','Bonifici ricevuti'), 'Synthetic ambiguous', 'unclassified', amount => 3000);
select pg_temp.fixture('Isy ambiguous Bonifici in uscita', 'isybank_operations_v1', jsonb_build_object('Categoria','Bonifici in uscita'), 'Synthetic ambiguous', 'unclassified', amount => null);
select pg_temp.fixture('Isy ambiguous Addebiti vari', 'isybank_operations_v1', jsonb_build_object('Categoria','Addebiti vari'), 'Synthetic ambiguous', 'unclassified', amount => null);
select pg_temp.fixture('Isy ambiguous Altre uscite', 'isybank_operations_v1', jsonb_build_object('Categoria','Altre uscite'), 'Synthetic ambiguous', 'unclassified', amount => null);
select pg_temp.fixture('Isy ambiguous Rate Mutuo e Finanziamento', 'isybank_operations_v1', jsonb_build_object('Categoria','Rate Mutuo e Finanziamento'), 'Synthetic ambiguous', 'unclassified', amount => null);
select pg_temp.fixture('Isy ambiguous Rate prestiti', 'isybank_operations_v1', jsonb_build_object('Categoria','Rate prestiti'), 'Synthetic ambiguous', 'unclassified', amount => null);
select pg_temp.fixture('Isy ambiguous Famiglie varie', 'isybank_operations_v1', jsonb_build_object('Categoria','Famiglie varie'), 'Synthetic ambiguous', 'unclassified', amount => null);
select pg_temp.fixture('Isy ambiguous Associazioni', 'isybank_operations_v1', jsonb_build_object('Categoria','Associazioni'), 'Synthetic ambiguous', 'unclassified', amount => null);
select pg_temp.fixture('Isy ambiguous Giroconti in uscita', 'isybank_operations_v1', jsonb_build_object('Categoria','Giroconti in uscita'), 'Synthetic ambiguous', 'unclassified', amount => null);
select pg_temp.fixture('Isy ambiguous Investimenti, BDR e Salvadanaio', 'isybank_operations_v1', jsonb_build_object('Categoria','Investimenti, BDR e Salvadanaio'), 'Synthetic ambiguous', 'unclassified', amount => null);
select pg_temp.fixture('Isy ambiguous Disinvestimenti, BDR e Salvadanaio', 'isybank_operations_v1', jsonb_build_object('Categoria','Disinvestimenti, BDR e Salvadanaio'), 'Synthetic ambiguous', 'unclassified', amount => null);
select pg_temp.fixture('AMEX ambiguous BANCO DI SARDEG TEST', 'american_express_v1', '{}', 'BANCO DI SARDEG TEST', 'unclassified', method => 'provider_rule', initial_type => 'expense', account => 'amex');
select pg_temp.fixture('AMEX ambiguous POSTE ITALIANE 07601', 'american_express_v1', '{}', 'POSTE ITALIANE 07601', 'unclassified', method => 'provider_rule', initial_type => 'expense', account => 'amex');
select pg_temp.fixture('AMEX ambiguous POSTE ITALIANE GENERIC', 'american_express_v1', '{}', 'POSTE ITALIANE GENERIC', 'unclassified', method => 'provider_rule', initial_type => 'expense', account => 'amex');
select pg_temp.fixture('AMEX ambiguous PagoPA TEST', 'american_express_v1', '{}', 'PagoPA TEST', 'unclassified', method => 'provider_rule', initial_type => 'expense', account => 'amex');
select pg_temp.fixture('AMEX ambiguous PAGO PA TEST', 'american_express_v1', '{}', 'PAGO PA TEST', 'unclassified', method => 'provider_rule', initial_type => 'expense', account => 'amex');
select pg_temp.fixture('AMEX ambiguous BONIFICO TEST', 'american_express_v1', '{}', 'BONIFICO TEST', 'unclassified', method => 'provider_rule', initial_type => 'expense', account => 'amex');
select pg_temp.fixture('AMEX ambiguous CASH ADVANCE TEST', 'american_express_v1', '{}', 'CASH ADVANCE TEST', 'unclassified', method => 'provider_rule', initial_type => 'expense', account => 'amex');
select pg_temp.fixture('AMEX ambiguous PRELIEVO CONTANTE TEST', 'american_express_v1', '{}', 'PRELIEVO CONTANTE TEST', 'unclassified', method => 'provider_rule', initial_type => 'expense', account => 'amex');
select pg_temp.fixture('Isy refund', 'isybank_operations_v1', '{"Categoria":"Rimborsi spese e storni"}', 'Synthetic refund', 'refund', amount => 4001);
select pg_temp.fixture('Isy contradictory credit', 'isybank_operations_v1', '{"Categoria":"Farmacia"}', 'Synthetic credit', 'unclassified', amount => 4002);
select pg_temp.fixture('AMEX refund', 'american_express_v1', '{}', 'Synthetic refund', 'refund', amount => 4003, account => 'amex');
select pg_temp.fixture('AMEX categorized refund', 'american_express_v1', '{"Dettagli completi":"Farmacia"}', 'Synthetic refund', 'refund', 'expense_health', 4004, account => 'amex');
select pg_temp.fixture('Salvadanaio', 'isybank_operations_v1', '{"Categoria":"Investimenti, BDR e Salvadanaio", "Operazione":"Accantonamento\nSalvadanaio"}', 'Synthetic saving', 'internal_transfer', expected_target => 'savings');
select pg_temp.fixture('Salvadanaio description', 'isybank_operations_v1', '{}', 'Versamento Salvadanaio', 'internal_transfer', expected_target => 'savings');
select pg_temp.fixture('Broker', 'isybank_operations_v1', '{}', 'Trasferimento conto titoli', 'investment_transfer', expected_target => 'broker');
select pg_temp.fixture('AMEX settlement Isy', 'isybank_operations_v1', '{"Categoria":"Addebiti Nexi e carte non del gruppo Intesa Sanpaolo"}', 'American Express Italia', 'internal_transfer', expected_target => 'amex');
select pg_temp.fixture('Isy card settlement', 'isybank_operations_v1', '{"Categoria":"Addebito mia carta di credito"}', 'Synthetic settlement', 'internal_transfer', expected_target => 'isycard');
select pg_temp.fixture('AMEX payment', 'american_express_v1', '{}', 'ADDEBITO IN C/C SALVO BUON FINE', 'internal_transfer', amount => 5001, account => 'amex', expected_target => 'checking');
select pg_temp.fixture('Generic unaffected', 'generic_bank_v1', '{"Categoria":"Farmacia", "Dettagli completi":"Ristoranti"}', 'DELIVEROO', 'unclassified');
select pg_temp.fixture('Card fallback unchanged', 'isybank_card_v1', '{}', 'Synthetic card', 'expense', account => 'isycard');
select pg_temp.fixture('Metadata precedence', 'american_express_v1', '{"Dettagli completi":"Supermercato"}', 'DELIVEROO', 'expense','expense_food', account => 'amex');
select pg_temp.fixture('Normalized metadata', 'isybank_operations_v1', '{"Categoria":"  RISTORANTI\n e\t  BAR  "}', 'Synthetic normalized', 'expense','expense_dining');
select pg_temp.fixture('Descriptor prefix', 'american_express_v1', '{"Dettagli completi":"  Farmacia\n Roma  "}', 'Synthetic metadata', 'expense','expense_health', account => 'amex');
select pg_temp.fixture('Unsafe IP', 'american_express_v1', '{}', 'IP', 'expense', account => 'amex');
select pg_temp.fixture('No merchant substring', 'american_express_v1', '{}', 'SHIP HOTELIER BOOKINGISH', 'expense', account => 'amex');
select pg_temp.fixture('No descriptor substring', 'american_express_v1', '{"Dettagli completi":"Farmaciatori"}', 'Synthetic unknown', 'expense', account => 'amex');
select pg_temp.fixture('Conflicting metadata', 'american_express_v1', '{"Dettagli completi":"Farmacia"}', 'DELIVEROO', 'unclassified', method => 'provider_rule', initial_type => 'expense', account => 'amex');
insert into public.import_rows(batch_id,row_index,matched_transaction_id,raw_data,status)
  select t.import_batch_id, 1, t.id, '{"Dettagli completi":"Ristoranti"}', 'imported' from fixtures f
    join public.transactions t on t.id=f.tx_id where f.label='Conflicting metadata';
-- Repeated agreeing normalized metadata is not a conflict.
insert into public.import_rows(batch_id,row_index,matched_transaction_id,raw_data,status)
  select t.import_batch_id, 1, t.id, '{"Categoria":"RISTORANTI E BAR"}', 'imported' from fixtures f
    join public.transactions t on t.id=f.tx_id where f.label='Normalized metadata';
select pg_temp.fixture('Manual protected', 'american_express_v1', '{"Dettagli completi":"Farmacia"}', 'DELIVEROO', 'expense', method => 'manual', initial_type => 'expense', account => 'amex');
select pg_temp.fixture('User rule protected', 'american_express_v1', '{"Dettagli completi":"Farmacia"}', 'DELIVEROO', 'expense', method => 'user_rule', initial_type => 'expense', account => 'amex');
select pg_temp.fixture('User neutral protected', 'american_express_v1', '{}', 'DELIVEROO', 'unclassified', method => 'user_rule', account => 'amex');
select pg_temp.fixture('Ignored protected', 'american_express_v1', '{}', 'DELIVEROO', 'unclassified', account => 'amex');
update public.transactions set reconciliation_status='ignored' where id=(select tx_id from fixtures where label='Ignored protected');
-- Nine existing settlement pairs plus one newly reconcilable pair.
do $$
declare i integer; a uuid; b uuid; g uuid;
begin
  for i in 1..10 loop
    a := pg_temp.fixture('Pair debit ' || i, 'isybank_operations_v1', '{}', 'American Express Italia','internal_transfer',
      amount => -50000-i, initial_type => case when i < 10 then 'internal_transfer' else 'unclassified' end,
      method => case when i < 10 then 'transfer_match' end, expected_target => 'amex');
    b := pg_temp.fixture('Pair credit ' || i, 'american_express_v1', '{}', 'ADDEBITO IN C/C SALVO BUON FINE','internal_transfer',
      amount => 50000+i, initial_type => case when i < 10 then 'internal_transfer' else 'refund' end,
      method => case when i < 10 then 'transfer_match' else 'provider_rule' end, account => 'amex', expected_target => 'checking');
    if i < 10 then
      g := gen_random_uuid();
      update public.transactions set transfer_group_id=g,transfer_account_id=current_setting('test.amex')::uuid,
        reconciliation_status='confirmed' where id=a;
      update public.transactions set transfer_group_id=g,transfer_account_id=current_setting('test.checking')::uuid,
        reconciliation_status='confirmed' where id=b;
    end if;
  end loop;
end $$;
create temp table protected_before as select t.id,to_jsonb(t) snapshot from public.transactions t
  where t.classification_method in ('manual','user_rule','transfer_match') or t.reconciliation_status='ignored';
create temp table anchors_before as select id, amount, account_id, transaction_date from public.transactions;
create temp table provenance_before as select id,to_jsonb(r) snapshot from public.import_rows r;
select public.classify_transactions();
-- Exercise the full RPC, rather than copying its mapping logic into TypeScript.
do $$
declare f record;
begin
  for f in select expected.*, t.transaction_type, c.system_key, t.transfer_account_id,
    t.reconciliation_status, t.transfer_group_id, t.classification_method, t.classified_at
    from fixtures expected join public.transactions t on t.id=expected.tx_id
    left join public.transaction_categories c on c.id=t.category_id loop
    perform pg_temp.assert_true(f.transaction_type=f.expected_type and f.system_key is not distinct from f.expected_key
      and f.transfer_account_id is not distinct from f.expected_target, f.label);
    if f.expected_target is not null and f.label not like 'Pair %' then
      perform pg_temp.assert_true(f.reconciliation_status='confirmed' and f.transfer_group_id is null
        and f.classification_method='provider_rule' and f.classified_at is not null, f.label || ' one-sided audit, no artificial group');
    end if;
  end loop;
end $$;
select pg_temp.assert_true(not exists(select 1 from protected_before b join public.transactions t on t.id=b.id
  where to_jsonb(t)<>b.snapshot), 'manual, user_rule, transfer_match and ignored rows unchanged');
select pg_temp.assert_true(not exists(select 1 from anchors_before b join public.transactions t on t.id=b.id
  where row(t.amount,t.account_id,t.transaction_date) is distinct from row(b.amount,b.account_id,b.transaction_date)), 'amounts, routing and dates unchanged');
select pg_temp.assert_true(not exists(select 1 from provenance_before b join public.import_rows r on r.id=b.id
  where to_jsonb(r)<>b.snapshot), 'raw_data and historical import rows unchanged');
select pg_temp.assert_true((select count(distinct transfer_group_id)=10 from public.transactions), 'existing nine pairs preserved and exactly one new pair');
select pg_temp.assert_true((select count(*) from public.transactions)=(select count(*) from anchors_before), 'no mirror transactions created');
create temp table first_run as select id,to_jsonb(t) snapshot from public.transactions t;
select pg_temp.assert_true((public.classify_transactions()->>'classified_count')::integer=0, 'second run changes zero classifications');
select pg_temp.assert_true((public.classify_transactions()->>'transfer_count')::integer=0, 'third run creates zero transfers');
select pg_temp.assert_true(not exists(select 1 from first_run b join public.transactions t on t.id=b.id
  where to_jsonb(t)<>b.snapshot), 'idempotent including audit timestamps and groups');
-- Rules added AFTER provider classification must override it. Newline and literal % are normalized safely.
insert into public.transaction_classification_rules(name,parser_key,match_field,match_operator,pattern,target_category_id)
  select 'Synthetic personal override','american_express_v1','description','starts_with','  DELIVEROO\n',id
    from public.transaction_categories where system_key='expense_work';
update public.transaction_classification_rules set pattern=E'  DELIVEROO\n';
select public.classify_transactions();
select pg_temp.assert_true((select t.classification_method='user_rule' and c.system_key='expense_work'
  from fixtures f join public.transactions t on t.id=f.tx_id join public.transaction_categories c on c.id=t.category_id
  where f.label='Merchant DELIVEROO ROMA'), 'late user rule overrides provider_rule');
select pg_temp.assert_true(not exists(select 1 from protected_before b join public.transactions t on t.id=b.id
  where to_jsonb(t)<>b.snapshot), 'late rule still preserves manual/user_rule/transfer_match');
insert into public.transaction_classification_rules(name,match_field,match_operator,pattern,target_transaction_type)
  values('Synthetic literal wildcard','description','starts_with','Synthetic %','expense');
select pg_temp.fixture('Literal wildcard', 'generic_bank_v1', '{}', 'Synthetic wildcard', 'unclassified');
select public.classify_transactions();
select pg_temp.assert_true((select t.transaction_type='unclassified' from fixtures f join public.transactions t on t.id=f.tx_id where f.label='Literal wildcard'), 'starts_with does not treat SQL wildcard as pattern');
-- Missing categories must not borrow a matching key from another owner.
reset role;
insert into public.transaction_categories(user_id,name,category_type,system_key)
  values(current_setting('test.other')::uuid,'Foreign tobacco','expense','expense_tobacco');
set local role authenticated;
delete from public.transaction_categories where system_key='expense_tobacco';
select pg_temp.fixture('Missing category','isybank_operations_v1','{"Categoria":"Tabaccai e simili"}','Synthetic missing','expense');
select public.classify_transactions();
select pg_temp.assert_true((select t.transaction_type='expense' and t.category_id is null from fixtures f join public.transactions t on t.id=f.tx_id where f.label='Missing category'), 'missing own category never borrows foreign UUID');
-- Ambiguous targets: second active savings/broker/AMEX/card and second PR4.4 mapping.
update public.accounts set is_active=true where name like 'Synthetic second_%';
insert into public.import_account_mappings(parser_key,source_instrument,account_id)
  values('isybank_operations_v1','Carta di credito second',current_setting('test.second_isycard')::uuid);
select pg_temp.fixture('Ambiguous savings','isybank_operations_v1','{}','Salvadanaio','unclassified');
select pg_temp.fixture('Ambiguous broker','isybank_operations_v1','{}','Trasferimento conto titoli','unclassified');
select pg_temp.fixture('Ambiguous AMEX','isybank_operations_v1','{"Categoria":"Addebiti Nexi e carte non del gruppo Intesa Sanpaolo"}','American Express Italia','unclassified');
select pg_temp.fixture('Ambiguous Isy card','isybank_operations_v1','{"Categoria":"Addebito mia carta di credito"}','Synthetic settlement','unclassified');
select public.classify_transactions();
select pg_temp.assert_true((select bool_and(t.transaction_type='unclassified' and t.transfer_account_id is null) from fixtures f join public.transactions t on t.id=f.tx_id where f.label like 'Ambiguous %'), 'all ambiguous targets remain unclassified');
select pg_temp.assert_true((select t.transaction_type='internal_transfer' and t.reconciliation_status='confirmed' from fixtures f join public.transactions t on t.id=f.tx_id where f.label='Salvadanaio'), 'confirmed provider transfer preserved when target set changes');
update public.accounts set is_active=false where account_type in ('savings','broker','credit_card');
select pg_temp.fixture('Absent savings','isybank_operations_v1','{}','Salvadanaio','unclassified');
select pg_temp.fixture('Absent broker','isybank_operations_v1','{}','Trasferimento conto titoli','unclassified');
select pg_temp.fixture('Absent AMEX','isybank_operations_v1','{"Categoria":"Addebiti Nexi e carte non del gruppo Intesa Sanpaolo"}','American Express Italia','unclassified');
select pg_temp.fixture('Absent Isy card','isybank_operations_v1','{"Categoria":"Addebito mia carta di credito"}','Synthetic settlement','unclassified');
select public.classify_transactions();
select pg_temp.assert_true((select bool_and(t.transaction_type='unclassified' and t.transfer_account_id is null) from fixtures f join public.transactions t on t.id=f.tx_id where f.label like 'Absent %'), 'absent targets remain unclassified');
-- Savings/card institution compatibility and multiple checking accounts are conservative.
update public.accounts set is_active=true where id in (current_setting('test.savings')::uuid,current_setting('test.isycard')::uuid);
update public.accounts set institution='Unrelated institution' where id in (current_setting('test.savings')::uuid,current_setting('test.isycard')::uuid);
select pg_temp.fixture('Incompatible savings','isybank_operations_v1','{}','Salvadanaio','unclassified');
select pg_temp.fixture('Incompatible Isy card','isybank_operations_v1','{"Categoria":"Addebito mia carta di credito"}','Synthetic settlement','unclassified');
insert into public.accounts(name,account_type,institution) values('Synthetic second checking','checking','Other bank');
select pg_temp.fixture('Ambiguous payment source','american_express_v1','{}','ADDEBITO IN C/C SALVO BUON FINE','unclassified',amount=>5002,account=>'amex');
select public.classify_transactions();
select pg_temp.assert_true((select bool_and(t.transaction_type='unclassified' and t.transfer_account_id is null) from fixtures f join public.transactions t on t.id=f.tx_id where f.label like 'Incompatible %' or f.label='Ambiguous payment source'), 'incompatible institution and ambiguous payment source are neutral');
-- Batch-scoped runs enrich only the requested batch (transfer counterpart matching excepted).
select pg_temp.fixture('Scoped yes','american_express_v1','{"Dettagli completi":"Farmacia"}','Synthetic scoped yes','expense','expense_health',account=>'amex');
select pg_temp.fixture('Scoped no','american_express_v1','{"Dettagli completi":"Farmacia"}','Synthetic scoped no','expense','expense_health',account=>'amex');
select public.classify_transactions((select t.import_batch_id from fixtures f join public.transactions t on t.id=f.tx_id where f.label='Scoped yes'));
select pg_temp.assert_true((select t.transaction_type='expense' from fixtures f join public.transactions t on t.id=f.tx_id where f.label='Scoped yes'), 'target batch is enriched');
select pg_temp.assert_true((select t.transaction_type='unclassified' from fixtures f join public.transactions t on t.id=f.tx_id where f.label='Scoped no'), 'unrequested batch is unchanged');
reset role;
select set_config('test.foreign_category',(select id::text from public.transaction_categories where user_id=current_setting('test.other')::uuid limit 1),true);
select set_config('test.foreign_account',(select id::text from public.accounts where user_id=current_setting('test.other')::uuid limit 1),true);
set local role authenticated;
select pg_temp.expect_error(format('insert into public.transaction_classification_rules(name,match_field,match_operator,pattern,target_category_id) values (%L,%L,%L,%L,%L)', 'Forbidden category','description','exact','Synthetic',current_setting('test.foreign_category')), 'category must belong','user rule cannot reference foreign category');
select pg_temp.expect_error(format('update public.transactions set category_id=%L where id=%L',current_setting('test.foreign_category'),(select tx_id::text from fixtures limit 1)), 'category must belong','transaction cannot reference foreign category');
select pg_temp.expect_error(format('update public.transactions set transfer_account_id=%L where id=%L',current_setting('test.foreign_account'),(select tx_id::text from fixtures limit 1)), 'transfer account must belong','transaction cannot reference foreign transfer target');
-- Caller cannot classify another owner's batch or access their staging/categories.
select set_config('test.foreign_batch',(select import_batch_id::text from public.transactions limit 1),true);
select set_config('request.jwt.claim.sub',current_setting('test.other'),true);
select pg_temp.assert_true((select count(*)=0 from public.transactions), 'RLS hides other owners transactions');
select pg_temp.assert_true((select count(*)=0 from public.import_rows), 'RLS hides other owners raw_data');
select pg_temp.assert_true((select count(*)=1 from public.transaction_categories), 'RLS scopes category lookup');
select pg_temp.expect_error(format('select public.classify_transactions(%L)', current_setting('test.foreign_batch')), 'import batch not found','foreign batch RPC rejected');
select pg_temp.assert_true((public.classify_transactions()->>'classified_count')::integer=0, 'foreign caller cannot classify original owners rows');
select set_config('request.jwt.claim.sub','',true);
select pg_temp.expect_error('select public.classify_transactions()','authentication required','missing identity rejected');
reset role;
select pg_temp.assert_true(not exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='public' and p.proname in ('normalize_classification_text','classification_institution_key','provider_category_key','classify_transactions') and p.prosecdef), 'all PR5 functions SECURITY INVOKER');
set local role anon;
select pg_temp.expect_error('select public.classify_transactions()','permission denied','anon cannot classify');
select pg_temp.expect_error('select public.normalize_classification_text(null)','permission denied','anon cannot normalize');
select pg_temp.expect_error('select public.provider_category_key(null,null,null,null)','permission denied','anon cannot call provider helper');
select pg_temp.expect_error('select public.classification_institution_key(null)','permission denied','anon cannot call institution helper');
reset role;
rollback;
