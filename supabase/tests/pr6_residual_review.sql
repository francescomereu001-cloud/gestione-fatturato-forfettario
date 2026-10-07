-- PR6 executable PostgreSQL regression suite. Synthetic fixtures only; everything rolls back.
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
select pg_temp.fixture('Debt extinction','isybank_operations_v1','{"Categoria":"Bonifici in uscita"}','ESTINZIONE   ANTICIPATA finanziamento','debt_principal');
select pg_temp.fixture('Debt return','isybank_operations_v1','{"Categoria":"Bonifici in uscita"}',E'Restituzione\nprestito infruttifero','debt_principal');
select pg_temp.fixture('Apple','isybank_operations_v1','{"Categoria":"Addebiti vari","Operazione":"Apple.com/bill"}','Synthetic unknown','expense','expense_subscriptions');
select pg_temp.fixture('PlayStation','isybank_operations_v1','{"Categoria":"Altre uscite","Operazione":"PayPal *PlayStation"}','Synthetic unknown','expense','expense_leisure');
select pg_temp.fixture('Cerved','isybank_operations_v1','{"Categoria":"Famiglie varie","Operazione":"Pagamento Cerved"}','Synthetic unknown','expense','expense_work');
select pg_temp.fixture('Card cost','isybank_operations_v1','{"Categoria":"Addebiti vari","Operazione":"Costo Carta"}','Synthetic unknown','expense','expense_fees');
select pg_temp.fixture('Amazon explicit','isybank_operations_v1','{"Categoria":"Altre uscite","Operazione":"Pagamento Amazon.it"}','Synthetic unknown','expense','expense_shopping');
select pg_temp.fixture('Amazon Prime','isybank_operations_v1','{"Categoria":"Altre uscite","Operazione":"Amazon Prime"}','Synthetic unknown','expense','expense_subscriptions');
select pg_temp.fixture('Cafe','isybank_operations_v1','{"Categoria":"Famiglie varie","Operazione":"Caffetteria sintetica"}','Synthetic unknown','expense','expense_dining');
select pg_temp.fixture('Description fallback','isybank_operations_v1','{"Categoria":"Addebiti vari"}','Apple.com/bill','expense','expense_subscriptions');
select pg_temp.fixture('Operation precedes description','isybank_operations_v1','{"Categoria":"Addebiti vari","Operazione":"Ambiguous merchant"}','Apple.com/bill','unclassified');
select pg_temp.fixture('Merchant token in transfer not expense','isybank_operations_v1','{"Categoria":"Addebiti vari","Operazione":"Bonifico in uscita Caffetteria"}','Synthetic unknown','unclassified');
select pg_temp.fixture('Strong category precedes fallback','isybank_operations_v1','{"Categoria":"Farmacia","Operazione":"Apple.com/bill"}','Synthetic unknown','expense','expense_health');
-- Each ambiguous token is tested against both IsyBank and AMEX.
do $$
declare pattern text; provider text;
begin
  foreach provider in array array['isybank_operations_v1','american_express_v1'] loop
    foreach pattern in array array['Revolut','PayPal Visa Direct','P2P person transfer','BANCOMAT Pay persona',
      'Bonifico ricevuto','Bonifico in uscita','Prelievo contante','Prelievo ATM','Cofidis rata finanziamento','PagoPA','Poste Italiane'] loop
      -- AMEX financing should be explicitly neutral, too.
      perform pg_temp.fixture(provider || ' ' || pattern,provider,'{}',pattern,'unclassified',
        amount=>case when pattern='Bonifico ricevuto' then 20000+(select count(*) from fixtures) else null end,
        account=>case when provider='american_express_v1' then 'amex' else 'checking' end);
    end loop;
  end loop;
end $$;
select pg_temp.fixture('Generic Amazon substring','isybank_operations_v1','{"Categoria":"Addebiti vari","Operazione":"NotAmazonlike"}','Synthetic unknown','unclassified');
select pg_temp.fixture('Generic card substring','isybank_operations_v1','{"Categoria":"Addebiti vari","Operazione":"card"}','Synthetic unknown','unclassified');
select pg_temp.fixture('Amazon no payment','isybank_operations_v1','{"Categoria":"Addebiti vari","Operazione":"Amazon"}','Synthetic unknown','unclassified');
select pg_temp.fixture('Prelievi merchant not expense','isybank_operations_v1','{"Categoria":"Prelievi","Operazione":"Apple.com/bill"}','Prelievo cardless','unclassified');
select pg_temp.fixture('Financing merchant not expense','isybank_operations_v1','{"Categoria":"Rate Mutuo e Finanziamento","Operazione":"Apple.com/bill"}','Cofidis','unclassified');
select pg_temp.fixture('ATM fee preserved','american_express_v1','{}','Commissione prelievo contante','expense','expense_fees',account=>'amex');
select public.classify_transactions();
do $$
declare f record;
begin
  for f in select e.*,t.transaction_type,c.system_key,t.transfer_account_id from fixtures e
    join public.transactions t on t.id=e.tx_id left join public.transaction_categories c on c.id=t.category_id loop
    perform pg_temp.assert_true(f.transaction_type=f.expected_type and f.system_key is not distinct from f.expected_key
      and f.transfer_account_id is null,f.label);
  end loop;
end $$;
create temp table after_provider as select id,to_jsonb(t) snapshot from public.transactions t;
select pg_temp.assert_true((public.classify_transactions()->>'classified_count')::integer=0,'provider second run idempotent');
select pg_temp.assert_true(not exists(select 1 from after_provider a join public.transactions t on t.id=a.id where to_jsonb(t)<>a.snapshot),'provider timestamps idempotent');
-- Fresh residuals for exact metadata/scoping/conflict tests.
select pg_temp.fixture('Operation exact','isybank_operations_v1','{"Categoria":"Bonifici ricevuti","Operazione":"  Mittente\n Sintetico  "}','Synthetic received','unclassified',amount=>21001);
select pg_temp.fixture('Operation exact future','isybank_operations_v1','{"Categoria":"Bonifici ricevuti","Operazione":"Mittente Sintetico"}','Synthetic future','unclassified',amount=>21002);
select pg_temp.fixture('Operation wrong parser','generic_bank_v1','{"Categoria":"Bonifici ricevuti","Operazione":"Mittente Sintetico"}','Synthetic wrong parser','unclassified',amount=>21003);
select pg_temp.fixture('Operation wrong account','isybank_operations_v1','{"Categoria":"Bonifici ricevuti","Operazione":"Mittente Sintetico"}','Synthetic wrong account','unclassified',amount=>21004,account=>'savings');
select pg_temp.fixture('Operation conflict','isybank_operations_v1','{"Categoria":"Bonifici ricevuti","Operazione":"Mittente Sintetico"}','Synthetic conflict','unclassified',amount=>21005);
select pg_temp.fixture('Operation missing','isybank_operations_v1','{"Categoria":"Bonifici ricevuti"}','Mittente Sintetico','unclassified',amount=>21006);
-- Conflicting later duplicate provenance, in a DIFFERENT import batch.
select set_config('test.duplicate_batch',gen_random_uuid()::text,true);
insert into public.import_batches(id,account_id,source_format,parser_key) values(current_setting('test.duplicate_batch')::uuid,current_setting('test.checking')::uuid,'xlsx','isybank_operations_v1');
insert into public.import_rows(batch_id,row_index,matched_transaction_id,raw_data,status)
  select current_setting('test.duplicate_batch')::uuid,999,tx_id,
    '{"Categoria":"Bonifici ricevuti","Operazione":"Altro Mittente"}','duplicate' from fixtures where label='Operation conflict';
-- Explicit batch is not important: the lookup must use every matched provenance row.
create temp table selection_anchor as select id,amount,transaction_date,account_id from public.transactions;
select public.create_classification_rule_and_apply(array[(select tx_id from fixtures where label='Operation exact')],
  jsonb_build_object('name','Synthetic self-transfer','match_field','provider_operation','pattern',E' MITTENTE\n SINTETICO ',
    'parser_key','isybank_operations_v1','account_id',current_setting('test.checking'),'target_transaction_type','internal_transfer'));
select pg_temp.assert_true((select transaction_type='internal_transfer' and reconciliation_status='pending' and transfer_account_id is null
  and transfer_group_id is null and category_id is null and classification_method='user_rule' and classified_at is not null
  from public.transactions where id=(select tx_id from fixtures where label='Operation exact')),'self-transfer null target pending, no mirror/group');
select public.classify_transactions();
select pg_temp.assert_true((select transaction_type='internal_transfer' and reconciliation_status='pending' from public.transactions
  where id=(select tx_id from fixtures where label='Operation exact future')),'saved rule applies to future matching operation');
select pg_temp.assert_true((select bool_and(t.transaction_type='unclassified') from fixtures f join public.transactions t on t.id=f.tx_id
  where f.label in ('Operation wrong parser','Operation wrong account','Operation conflict','Operation missing')),'parser/account scope, conflicting later provenance and missing metadata stay neutral');
select pg_temp.fixture('Whole tuple conflict','isybank_operations_v1','{"Categoria":"Bonifici ricevuti","Operazione":"Mittente Sintetico"}','Synthetic tuple conflict','unclassified',amount=>21007);
insert into public.import_rows(batch_id,row_index,matched_transaction_id,raw_data,status)
  select t.import_batch_id,1,t.id,'{"Categoria":"Altra categoria","Operazione":"Mittente Sintetico"}','imported'
  from fixtures f join public.transactions t on t.id=f.tx_id where f.label='Whole tuple conflict';
select public.classify_transactions();
select pg_temp.assert_true((select transaction_type='unclassified' from public.transactions where id=(select tx_id from fixtures where label='Whole tuple conflict')),
  'any conflicting semantic provenance blocks metadata rule');
-- Provider category and provider details matching.
select pg_temp.fixture('Category exact','isybank_operations_v1','{"Categoria":"  Prelievi\n ","Operazione":"Synthetic ATM"}','Synthetic withdrawal','unclassified');
insert into public.transaction_classification_rules(name,parser_key,match_field,match_operator,pattern,target_transaction_type)
  values('Synthetic withdrawals','isybank_operations_v1','provider_category','exact','prelievi','internal_transfer');
select pg_temp.fixture('Details exact','american_express_v1','{"Dettagli completi":"  Synthetic\n Detail "}','Synthetic details','unclassified',account=>'amex');
insert into public.transaction_classification_rules(name,parser_key,match_field,match_operator,pattern,target_transaction_type)
  values('Synthetic detail','american_express_v1','provider_details','exact','synthetic detail','adjustment');
select public.classify_transactions();
select pg_temp.assert_true((select transaction_type='internal_transfer' and reconciliation_status='pending' from public.transactions
  where id=(select tx_id from fixtures where label='Category exact')),'provider category exact normalized');
select pg_temp.assert_true((select transaction_type='adjustment' from public.transactions where id=(select tx_id from fixtures where label='Details exact')),'provider details exact normalized');
-- Late rule overrides provider expense and confirmed one-sided provider transfer.
select public.create_classification_rule_and_apply(array[(select tx_id from fixtures where label='Apple')],
  jsonb_build_object('name','Synthetic merchant override','match_field','provider_operation','pattern','Apple.com/bill',
    'parser_key','isybank_operations_v1','target_transaction_type','internal_transfer','target_transfer_account_id',current_setting('test.savings')));
select pg_temp.assert_true((select transaction_type='internal_transfer' and transfer_account_id=current_setting('test.savings')::uuid
  and category_id is null and reconciliation_status='confirmed' and classification_method='user_rule' from public.transactions
  where id=(select tx_id from fixtures where label='Apple')),'provider expense overridable and stale expense category cleared');
select pg_temp.fixture('Transfer to expense','isybank_operations_v1','{}','Synthetic override transfer','internal_transfer',method=>'provider_rule',initial_type=>'internal_transfer');
update public.transactions set reconciliation_status='confirmed',transfer_account_id=current_setting('test.savings')::uuid
  where id=(select tx_id from fixtures where label='Transfer to expense');
insert into public.transaction_classification_rules(name,match_field,match_operator,pattern,target_transaction_type,target_category_id)
  select 'Synthetic transfer override','description','exact','Synthetic override transfer','expense',id
  from public.transaction_categories where system_key='expense_work';
select public.classify_transactions();
select pg_temp.assert_true((select transaction_type='expense' and category_id is not null and transfer_account_id is null
  and transfer_group_id is null and reconciliation_status='pending' from public.transactions
  where id=(select tx_id from fixtures where label='Transfer to expense')),'confirmed provider transfer overridable; stale target cleared');
-- Transfer target validation and ownership on direct rule INSERT.
reset role;
select set_config('test.foreign_account',(select id::text from public.accounts where user_id=current_setting('test.other')::uuid limit 1),true);
insert into public.transaction_categories(user_id,name,category_type) values(current_setting('test.other')::uuid,'Synthetic foreign expense','expense');
select set_config('test.foreign_category',(select id::text from public.transaction_categories where user_id=current_setting('test.other')::uuid limit 1),true);
insert into public.transactions(user_id,account_id,transaction_date,amount,description,transaction_type)
  values(current_setting('test.other')::uuid,current_setting('test.foreign_account')::uuid,'2026-01-01',-123456,'Synthetic foreign movement','unclassified');
select set_config('test.foreign_tx',(select id::text from public.transactions where user_id=current_setting('test.other')::uuid limit 1),true);
set local role authenticated;
select pg_temp.expect_error(format('insert into public.transaction_classification_rules(name,match_field,match_operator,pattern,target_transaction_type,target_transfer_account_id) values (%L,%L,%L,%L,%L,%L)',
 'Foreign target','description','exact','Synthetic','internal_transfer',current_setting('test.foreign_account')),'target transfer account must belong','foreign rule target rejected');
select pg_temp.expect_error('insert into public.transaction_classification_rules(name,match_field,match_operator,pattern,target_transaction_type) values (''No broker'',''description'',''exact'',''Synthetic'',''investment_transfer'')','requires broker target','investment rule requires target');
select pg_temp.expect_error(format('insert into public.transaction_classification_rules(name,match_field,match_operator,pattern,target_transaction_type,target_transfer_account_id) values (%L,%L,%L,%L,%L,%L)',
 'Non broker','description','exact','Synthetic','investment_transfer',current_setting('test.savings')),'requires broker target','investment rule rejects non broker');
select pg_temp.expect_error('insert into public.transaction_classification_rules(name,match_field,match_operator,pattern,target_transaction_type) values (''No parser'',''provider_operation'',''exact'',''Synthetic'',''internal_transfer'')','require parser scope','provider field requires parser');
-- Bounded atomic bulk: 20 movements, preserve all financial anchors.
create temp table bulk_ids(id uuid primary key);
insert into bulk_ids select pg_temp.fixture('Bulk '||i,'generic_bank_v1','{}','Synthetic bulk '||i,'unclassified') from generate_series(1,20) i;
create temp table bulk_before as select t.id,t.amount,t.transaction_date,t.account_id from public.transactions t;
select pg_temp.assert_true(public.bulk_classify_transactions((select array_agg(id) from bulk_ids),'expense',
  (select id from public.transaction_categories where system_key='expense_work'))=20,'bulk 20 own transactions');
select pg_temp.assert_true((select bool_and(classification_method='manual' and classified_at is not null and category_id is not null)
  from public.transactions where id in(select id from bulk_ids)),'bulk manual audit fields');
select pg_temp.assert_true(not exists(select 1 from bulk_before a join public.transactions t on t.id=a.id
  where row(t.amount,t.transaction_date,t.account_id) is distinct from row(a.amount,a.transaction_date,a.account_id)),'bulk preserves amounts dates and account anchor');
create temp table bulk_snapshot as select id,to_jsonb(t) snapshot from public.transactions t;
-- Error subtransactions must leave EVERY selected row unchanged.
select pg_temp.expect_error(format('select public.bulk_classify_transactions(array[%L::uuid,%L::uuid],%L)',(select id from bulk_ids limit 1),current_setting('test.foreign_tx'),'adjustment'),'not owned or not found','mixed ownership selection fails entirely');
select pg_temp.expect_error(format('select public.bulk_classify_transactions(array[%L::uuid],%L,%L)',(select id from bulk_ids limit 1),'expense',current_setting('test.foreign_category')),'category must belong','foreign category rejected');
select pg_temp.expect_error(format('select public.bulk_classify_transactions(array[%L::uuid],%L,null,%L)',(select id from bulk_ids limit 1),'internal_transfer',current_setting('test.foreign_account')),'target transfer account must belong','foreign target bulk rejected');
select pg_temp.expect_error(format('select public.bulk_classify_transactions(array[%L::uuid],%L,null,%L)',(select id from bulk_ids limit 1),'internal_transfer',current_setting('test.checking')),'must differ from source','same source target rejected');
select pg_temp.expect_error(format('select public.bulk_classify_transactions(array[%L::uuid],%L)',(select id from bulk_ids limit 1),'investment_transfer'),'requires broker target','investment bulk requires broker');
select pg_temp.expect_error(format('select public.bulk_classify_transactions(array[%L::uuid],%L,%L)',(select id from bulk_ids limit 1),'debt_principal',(select id from public.transaction_categories where system_key='expense_work')),'category incompatible','debt principal rejects expense category');
select pg_temp.expect_error(format('select public.bulk_classify_transactions(array[%L::uuid],%L)',(select id from bulk_ids limit 1),'income'),'violates check constraint','bulk cannot change amount sign');
select pg_temp.expect_error('select public.bulk_classify_transactions(array[]::uuid[],''expense'')','1 to 500','empty bulk rejected');
select pg_temp.expect_error('select public.bulk_classify_transactions(array(select gen_random_uuid() from generate_series(1,501)),''expense'')','1 to 500','oversized bulk rejected');
select pg_temp.assert_true(not exists(select 1 from bulk_snapshot b join public.transactions t on t.id=b.id where to_jsonb(t)<>b.snapshot),'invalid bulk leaves no partial updates');
-- Protected rows in a mixed selection abort, including audit fields.
select pg_temp.fixture('Protected transfer','generic_bank_v1','{}','Synthetic protected','internal_transfer',method=>'transfer_match',initial_type=>'internal_transfer');
select pg_temp.fixture('Protected ignored','generic_bank_v1','{}','Synthetic ignored','unclassified');
update public.transactions set reconciliation_status='ignored' where id=(select tx_id from fixtures where label='Protected ignored');
select pg_temp.expect_error(format('select public.bulk_classify_transactions(array[%L::uuid,%L::uuid],%L)',(select id from bulk_ids limit 1),
  (select tx_id from fixtures where label='Protected transfer'),'adjustment'),'protected transaction','one transfer_match aborts entire bulk');
select pg_temp.expect_error(format('select public.bulk_classify_transactions(array[%L::uuid,%L::uuid],%L)',(select id from bulk_ids limit 1),
  (select tx_id from fixtures where label='Protected ignored'),'adjustment'),'protected transaction','one ignored aborts entire bulk');
select pg_temp.assert_true(not exists(select 1 from bulk_snapshot b join public.transactions t on t.id=b.id where to_jsonb(t)<>b.snapshot),'protected bulk also has no partial changes');
-- Create+apply rollback also removes the newly inserted rule.
select set_config('test.rule_count',(select count(*)::text from public.transaction_classification_rules),true);
select pg_temp.expect_error(format('select public.create_classification_rule_and_apply(array[%L::uuid],%L::jsonb)',
  (select tx_id from fixtures where label='Operation missing'),'{"name":"Invalid atomic rule","match_field":"provider_operation","pattern":"No match","parser_key":"isybank_operations_v1","target_transaction_type":"internal_transfer"}'),
  'does not match every','rule match failure atomic');
select pg_temp.assert_true((select count(*)::text=current_setting('test.rule_count') from public.transaction_classification_rules),'failed apply leaves no saved rule');
select pg_temp.expect_error(format('select public.create_classification_rule_and_apply(array[%L::uuid],%L::jsonb)',
  (select id from bulk_ids limit 1),'{"name":"Manual override","match_field":"description","pattern":"Synthetic","target_transaction_type":"expense"}'),
  'decision protected','saved rule cannot override manual');
-- Confirmed broker transfer with no artificial mirror.
select pg_temp.fixture('Broker rule','generic_bank_v1','{}','Synthetic broker pattern','unclassified');
select public.create_classification_rule_and_apply(array[(select tx_id from fixtures where label='Broker rule')],
  jsonb_build_object('name','Synthetic broker','match_field','description','pattern','Synthetic broker pattern',
    'target_transaction_type','investment_transfer','target_transfer_account_id',current_setting('test.broker')));
select pg_temp.assert_true((select transaction_type='investment_transfer' and transfer_account_id=current_setting('test.broker')::uuid
  and reconciliation_status='confirmed' and transfer_group_id is null from public.transactions where id=(select tx_id from fixtures where label='Broker rule')),'broker rule confirmed without mirror/group');
insert into public.accounts(name,account_type,currency) values('Synthetic USD','checking','USD');
select pg_temp.expect_error(format('select public.bulk_classify_transactions(array[%L::uuid],%L,null,%L)',(select id from bulk_ids limit 1),'internal_transfer',
  (select id from public.accounts where name='Synthetic USD')),'currency incompatible','incompatible target currency rejected');
select pg_temp.expect_error(format('select public.bulk_classify_transactions(array[%L::uuid,%L::uuid],%L)',
  (select id from bulk_ids limit 1),(select id from bulk_ids limit 1),'expense'),'distinct transaction UUIDs','duplicate UUIDs rejected');
-- Aggregate groups must expose summaries without raw provenance. Manual unclassified may be reviewed once again.
select pg_temp.fixture('Review ATM a','isybank_operations_v1','{"Categoria":"Prelievi","Operazione":"Synthetic ATM group"}','Synthetic ATM first','unclassified',amount=>-71001);
select pg_temp.fixture('Review ATM b','isybank_operations_v1','{"Categoria":"Prelievi","Operazione":"Synthetic ATM group"}','Synthetic ATM second','unclassified',amount=>-71002);
update public.transactions set transaction_date='2026-02-01' where id=(select tx_id from fixtures where label='Review ATM b');
create temp table review_response as select public.residual_review_groups() value;
select pg_temp.assert_true(exists(select 1 from review_response,jsonb_array_elements(value->'groups') g
  where g->>'provider_operation'='synthetic atm group' and (g->>'transaction_count')::integer=2
    and (g->>'total_amount')::numeric=-142003 and g->>'date_min'='2026-01-01' and g->>'date_max'='2026-02-01'
    and jsonb_array_length(g->'examples')=2 and g->>'provider_category'='prelievi'),'review count total date examples metadata');
select pg_temp.assert_true((select value::text not like '%raw_data%' from review_response),'no raw_data in aggregate response');
select pg_temp.assert_true(jsonb_array_length(public.residual_review_groups('provider_category',1,0)->'groups')=1,'review group pagination bounded');
select pg_temp.expect_error('select public.residual_review_groups(''description'')','invalid review page','invalid grouping rejected');
-- A large review group returns its full count/total, but no more than 500 selection IDs.
insert into public.transactions(account_id,transaction_date,amount,description,transaction_type,source)
  select current_setting('test.checking')::uuid,'2026-03-01',-80000-i,'Synthetic large group','unclassified','manual'
  from generate_series(1,501) i;
select pg_temp.assert_true(exists(select 1 from jsonb_array_elements(public.residual_review_groups()->'groups') g
  where (g->>'transaction_count')::integer=501 and jsonb_array_length(g->'transaction_ids')=500 and jsonb_array_length(g->'examples')=3),
  'large group full count with capped selection and examples');
-- Remove only the synthetic load fixture before classifier fixture-count assertions.
delete from public.transactions where description='Synthetic large group';
create temp table protected_before as select id,to_jsonb(t) snapshot from public.transactions t where classification_method in ('manual','transfer_match') or reconciliation_status='ignored';
select public.classify_transactions();
select pg_temp.assert_true(not exists(select 1 from protected_before a join public.transactions t on t.id=a.id where to_jsonb(t)<>a.snapshot),'manual transfer_match ignored preserved by classifier');
create temp table final_snapshot as select id,to_jsonb(t) snapshot from public.transactions t;
select pg_temp.assert_true((public.classify_transactions()->>'classified_count')::integer=0,'user rule second run idempotent');
select pg_temp.assert_true(not exists(select 1 from final_snapshot a join public.transactions t on t.id=a.id where to_jsonb(t)<>a.snapshot),'user rule audit fields idempotent');
select pg_temp.assert_true((select count(*) from fixtures)=(select count(*) from public.transactions),'no mirrors or automatic transactions');
select pg_temp.assert_true(not exists(select 1 from selection_anchor a join public.transactions t on t.id=a.id
  where row(t.amount,t.transaction_date,t.account_id) is distinct from row(a.amount,a.transaction_date,a.account_id)),'rules preserve financial anchors');
select set_config('request.jwt.claim.sub',current_setting('test.other'),true);
select pg_temp.assert_true((public.residual_review_groups()->>'unclassified_count')::integer=1
  and (public.residual_review_groups()->'groups'->0->'transaction_ids'->>0)=current_setting('test.foreign_tx'),'review RLS returns only callers own ledger');
select pg_temp.expect_error(format('select public.bulk_classify_transactions(array[%L::uuid],%L)',(select id from bulk_ids limit 1),'expense'),'not owned','foreign owner bulk rejected');
select set_config('request.jwt.claim.sub','',true);
select pg_temp.expect_error('select public.residual_review_groups()','authentication required','review requires auth');
reset role;
select pg_temp.assert_true(not exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='public' and p.proname in ('classification_metadata','validate_classification_decision',
    'validate_classification_rule_ownership','classification_rule_matches','residual_provider_category_key','classify_transactions',
    'lock_classification_selection','bulk_classify_transactions','create_classification_rule_and_apply','residual_review_groups') and p.prosecdef),'all PR6 functions invoker');
set local role anon;
select pg_temp.expect_error('select public.residual_review_groups()','permission denied','anon review revoked');
select pg_temp.expect_error('select public.bulk_classify_transactions(array[]::uuid[],''expense'')','permission denied','anon bulk revoked');
select pg_temp.expect_error('select public.create_classification_rule_and_apply(array[]::uuid[],''{}'')','permission denied','anon rule apply revoked');
reset role;
rollback;
