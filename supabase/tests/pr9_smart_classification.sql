-- Executable PR9 integration tests, synthetic-only and rolled back.
begin;
create function pg_temp.assert_true(condition boolean, label text) returns void language plpgsql as $$
begin
 if condition is distinct from true then raise exception 'FAIL: %',label; end if;
 raise notice 'PASS: %',label;
end $$;
create function pg_temp.expect_error(statement text, message text, label text) returns void language plpgsql as $$
declare rejected boolean:=false;
begin
 begin execute statement; exception when others then
  if strpos(sqlerrm,message)=0 then raise; end if; rejected:=true;
 end;
 perform pg_temp.assert_true(rejected,label);
end $$;
select set_config('test.owner',gen_random_uuid()::text,true),set_config('test.other',gen_random_uuid()::text,true);
insert into auth.users values(current_setting('test.owner')::uuid),(current_setting('test.other')::uuid);
insert into public.accounts(user_id,name,account_type) values(current_setting('test.owner')::uuid,'Synthetic PR9','checking') returning set_config('test.account',id::text,true);
insert into public.accounts(user_id,name,account_type) values(current_setting('test.other')::uuid,'Synthetic Other','checking') returning set_config('test.other_account',id::text,true);
select set_config('request.jwt.claim.sub',current_setting('test.owner'),true);
set local role authenticated;
insert into public.transaction_categories(name,category_type,system_key) values('Synthetic dining','expense','expense_dining') returning set_config('test.category',id::text,true);
insert into public.transaction_categories(name,category_type,system_key) values('Synthetic work','expense','expense_work') returning set_config('test.work',id::text,true);
create temp table fixtures(label text primary key,tx_id uuid);
create function pg_temp.fixture(label text, description text, amount numeric default -31, method text default null,
 parser text default 'isybank_operations_v1', status text default 'pending') returns uuid language plpgsql as $$
declare batch uuid; tx uuid;
begin
 insert into public.import_batches(account_id,source_format,parser_key,row_count)
 values(current_setting('test.account')::uuid,'xlsx',parser,1) returning id into batch;
 insert into public.transactions(account_id,transaction_date,description,amount,transaction_type,classification_method,import_batch_id,source,reconciliation_status)
 values(current_setting('test.account')::uuid,'2026-01-01',description,amount,'unclassified',method,batch,'bank_import',status) returning id into tx;
 insert into public.import_rows(batch_id,row_index,matched_transaction_id,raw_data,status)
 values(batch,0,tx,'{"Categoria":"Addebiti vari","Dettagli completi":"synthetic only"}','imported');
 insert into fixtures values(label,tx);return tx;
end $$;
select pg_temp.assert_true(public.merchant_fingerprint('isybank_operations_v1',null,'AMZN MKTP IT*AB12C3')=public.merchant_fingerprint('isybank_operations_v1',null,'AMZN MKTP IT XYZ789'),'Amazon references share identity');
select pg_temp.assert_true(public.merchant_fingerprint('isybank_operations_v1',null,'AMAZON EU SARL')='v1:amazon-marketplace','bounded Amazon alias');
select pg_temp.assert_true(public.merchant_fingerprint('isybank_operations_v1',null,'Amazon prime')<>'v1:amazon-marketplace','Prime not merged with marketplace');
select pg_temp.assert_true(public.merchant_fingerprint('isybank_operations_v1',null,'AMZN MKTP ITALIA')<>'v1:amazon-marketplace','alias boundary prevents false positive');
select pg_temp.assert_true(public.merchant_fingerprint('isybank_operations_v1',null,'Pagamento POS Bistro Lumen REF AB123')=public.merchant_fingerprint('isybank_operations_v1',null,'pagamento pos BISTRO  LUMEN ref ZZ999'),'explicit references and whitespace normalized');
select pg_temp.assert_true(public.merchant_fingerprint('isybank_operations_v1',null,'Bistro Lumen 01/02/2026')='v1:bistro lumen','trailing date normalized');
select pg_temp.assert_true(public.merchant_fingerprint('isybank_operations_v1',null,'Bistro Lumen')<>public.merchant_fingerprint('isybank_operations_v1',null,'Bistro Luna'),'different merchants not merged');
select pg_temp.assert_true(public.merchant_fingerprint('isybank_operations_v1',null,'Pagamento POS') is null,'generic merchant has no fingerprint');
select pg_temp.assert_true(public.merchant_fingerprint('isybank_operations_v1',null,'Bonifico Mario Synthetic') is null,'transfer not merchant');
select pg_temp.assert_true(public.merchant_fingerprint('isybank_operations_v1',null,'Synthetic IT60X0542811101000000123456') is null,'IBAN not merchant');
select pg_temp.assert_true(public.merchant_fingerprint(null,null,'Bistro Lumen') is null,'missing provider fails closed');
select pg_temp.assert_true(public.merchant_fingerprint('unsupported',null,'Bistro Lumen') is null,'unsupported provider fails closed');
select pg_temp.assert_true(public.merchant_fingerprint('isybank_operations_v1',null,'Bistro Lumen',null,true) is null,'conflicting provenance fails closed');

select pg_temp.fixture('learn','Bistro Lumen REF A123');
select public.remember_transaction_merchant((select tx_id from fixtures where label='learn'),'expense',current_setting('test.category')::uuid) as rule_id \gset
select pg_temp.assert_true((select classification_method='manual' and category_id=current_setting('test.category')::uuid from public.transactions where id=(select tx_id from fixtures where label='learn')),'remember confirms current transaction manually');
select public.remember_transaction_merchant((select tx_id from fixtures where label='learn'),'expense',current_setting('test.category')::uuid);
select pg_temp.assert_true((select count(*)=1 from public.transaction_classification_rules where match_field='merchant_fingerprint'),'remember is idempotent');
select pg_temp.fixture('future','Bistro Lumen REF B456',-45);
select pg_temp.fixture('manual','Bistro Lumen REF M001',-52,'manual');
select pg_temp.fixture('user_rule','Bistro Lumen REF M002',-53,'user_rule');
select pg_temp.fixture('transfer_match','Bistro Lumen REF M003',-54,'transfer_match');
select pg_temp.fixture('ignored','Bistro Lumen REF M004',-55,null,'isybank_operations_v1','ignored');
select pg_temp.fixture('opposite','Bistro Lumen REF C789',12);
select pg_temp.fixture('other_provider','Bistro Lumen REF D789',-72,null,'american_express_v1');
select public.classify_transactions();
select pg_temp.assert_true((select classification_method='merchant_memory' and transaction_type='expense' and category_id=current_setting('test.category')::uuid and amount=-45 and transaction_date='2026-01-01' from public.transactions where id=(select tx_id from fixtures where label='future')),'future merchant uses memory with ledger values preserved');
select pg_temp.assert_true((select count(*)=0 from public.transaction_ai_suggestions),'memory makes no AI calls');
select pg_temp.assert_true((select bool_and(transaction_type='unclassified') from public.transactions where id in(select tx_id from fixtures where label in('manual','user_rule','transfer_match','ignored'))),'all protected decisions untouched');
select pg_temp.assert_true((select transaction_type='unclassified' from public.transactions where id=(select tx_id from fixtures where label='opposite')),'direction scope prevents expense on credit');
select pg_temp.assert_true((select classification_method='provider_rule' from public.transactions where id=(select tx_id from fixtures where label='other_provider')),'provider scope prevents memory cross-provider match');
update public.transaction_classification_rules set memory_account_type='credit_card' where id=:'rule_id'::uuid;
select pg_temp.assert_true(not public.classification_rule_matches(t,r),'account type scope respected') from public.transactions t cross join public.transaction_classification_rules r where t.id=(select tx_id from fixtures where label='future') and r.id=:'rule_id'::uuid;
update public.transaction_classification_rules set memory_account_type='checking' where id=:'rule_id'::uuid;
-- Existing personal rule wins over memory, even with lower numeric priority.
insert into public.transaction_classification_rules(name,priority,match_field,match_operator,pattern,amount_direction,target_transaction_type,target_category_id)
 values('Personal priority',1,'description','starts_with','Bistro Lumen','debit','expense',current_setting('test.work')::uuid);
select pg_temp.fixture('personal','Bistro Lumen REF E111',-82);
select public.classify_transactions();
select pg_temp.assert_true((select classification_method='user_rule' and category_id=current_setting('test.work')::uuid from public.transactions where id=(select tx_id from fixtures where label='personal')),'personal rule beats memory priority');

select pg_temp.fixture('provider','Apple.com/bill',-83);
select pg_temp.fixture('high','Bistro Solaris',-84);
select pg_temp.fixture('medium','Bistro Horizon',-85);
select pg_temp.fixture('low','Bistro Meadow',-86);
select pg_temp.fixture('invalid','Bistro Atlas',-87);
select pg_temp.fixture('api_error','Bistro Cedar',-88);
select pg_temp.fixture('sign','Bistro Maple',-89);
select pg_temp.fixture('transfer','Bistro Ivy',-90);
select pg_temp.fixture('changed','Bistro Oak',-91);
select pg_temp.fixture('null_ambiguous','Bistro Willow',-92);
select pg_temp.fixture('approve','Bistro Halley',-102);
select pg_temp.fixture('reject','Bistro Comet',-103);
select pg_temp.fixture('malformed','Bistro Meteor',-104);
select pg_temp.fixture('null_type','Bistro Astral',-105);
select pg_temp.fixture('details_changed','Bistro Cosmo',-109);
select pg_temp.fixture('incoming_transfer','Synthetic Named Sender',111);
update public.import_rows set raw_data=raw_data||'{"Categoria":"Bonifici ricevuti"}'::jsonb where matched_transaction_id=(select tx_id from fixtures where label='incoming_transfer');
select pg_temp.fixture('generic','Pagamento POS',-93);
select pg_temp.fixture('ambiguous','Prelievo ATM Synthetic',-94);
select public.claim_residual_ai_batch() as claimed \gset
select pg_temp.assert_true((:'claimed'::jsonb->'candidates') @> '[{"normalized_merchant":"bistro solaris"}]','only true deterministic residuals are claimed');
select pg_temp.assert_true(not (:'claimed'::jsonb->'candidates') @> '[{"normalized_merchant":"apple.com/bill"}]','provider match not sent to AI');
select pg_temp.assert_true(not (:'claimed'::jsonb->'candidates') @> '[{"normalized_merchant":"bistro lumen","direction":"debit"}]','remembered merchant not sent to AI');
select pg_temp.assert_true((select count(*)=0 from public.transaction_ai_suggestions s where transaction_id in(select tx_id from fixtures where label in('generic','ambiguous','incoming_transfer','manual','user_rule','transfer_match','ignored'))),'generic and protected rows never claimed');
select pg_temp.assert_true(jsonb_array_length(public.claim_residual_ai_batch()->'candidates')=0,'concurrent/repeated request cannot reclaim processing batch');
select pg_temp.assert_true(not (:'claimed' like '%raw_data%' or :'claimed' like '%account_id%' or :'claimed' like '%amount%' or :'claimed' like '%Dettagli%'),'claim payload contains no raw financial fields');
select pg_temp.expect_error(format('select financialmind_classification_private.record_residual_ai_result(%L,null,null,null)',current_setting('test.owner')),'permission denied','authenticated cannot forge AI output');
select pg_temp.expect_error('insert into public.transaction_ai_suggestions(user_id,transaction_id,fingerprint,parser_key,direction,account_type,currency,model,logic_version,status) values(null,null,null,null,null,null,null,null,null,null)','permission denied','authenticated cannot forge audit rows');
-- Stale protection between model request and persistence.
update public.transactions set classification_method='manual' where id=(select tx_id from fixtures where label='changed');
update public.import_rows set raw_data=raw_data||'{"Dettagli completi":"bonifico ambiguo"}'::jsonb where matched_transaction_id=(select tx_id from fixtures where label='details_changed');
reset role;
create function pg_temp.record(fixture_label text, confidence numeric, category text default 'expense_dining', type text default 'expense', cannot boolean default false)
returns text language plpgsql as $$
declare s public.transaction_ai_suggestions;
begin
 select a.* into s from public.transaction_ai_suggestions a join fixtures f on f.tx_id=a.transaction_id where f.label=fixture_label;
 return financialmind_classification_private.record_residual_ai_result(current_setting('test.owner')::uuid,s.id,s.attempt_token,
  jsonb_build_object('proposed_transaction_type',type,'proposed_category_system_key',category,'normalized_merchant','synthetic',
    'confidence',confidence,'reason','Merchant sintetico','cannot_classify',cannot));
end $$;
select pg_temp.assert_true(pg_temp.record('approve',.8)='suggested','approval case creates medium suggestion');
select pg_temp.assert_true(pg_temp.record('reject',.8)='suggested','rejection case creates medium suggestion');
select pg_temp.assert_true(pg_temp.record('null_type',.99,'expense_dining',null)='invalid','null type with category cannot auto apply');
select pg_temp.assert_true(financialmind_classification_private.record_residual_ai_result(current_setting('test.owner')::uuid,s.id,s.attempt_token,'{"bad":true}')='invalid','invalid response schema rejected') from public.transaction_ai_suggestions s join fixtures f on f.tx_id=s.transaction_id where f.label='malformed';
select pg_temp.assert_true(pg_temp.record('high',.99)='auto_applied','high confidence valid output auto applies');
select pg_temp.assert_true(pg_temp.record('medium',.85)='suggested','medium confidence remains suggestion');
select pg_temp.assert_true(pg_temp.record('low',.3)='low','low confidence stays residual');
select pg_temp.assert_true(pg_temp.record('invalid',.99,'invented')='invalid','nonexistent category rejected');
select pg_temp.assert_true(pg_temp.record('sign',.99,'expense_dining','refund')='invalid','incompatible sign rejected');
select pg_temp.assert_true(pg_temp.record('transfer',.99,'expense_dining','internal_transfer')='invalid','invented transfer rejected');
select pg_temp.assert_true(pg_temp.record('details_changed',.99)='stale','contradictory metadata added during model request invalidates proposal');
select pg_temp.assert_true(pg_temp.record('changed',.99)='stale','manual decision during AI request protected');
select pg_temp.assert_true(pg_temp.record('null_ambiguous',.99,null,null,true)='low','cannot_classify null decision remains low');
select pg_temp.assert_true(financialmind_classification_private.record_residual_ai_result(current_setting('test.owner')::uuid,s.id,s.attempt_token,null)='failed','API failure stays residual') from public.transaction_ai_suggestions s join fixtures f on f.tx_id=s.transaction_id where f.label='api_error';
set local role authenticated;
select pg_temp.assert_true((select classification_method='ai_suggestion' and category_id=current_setting('test.category')::uuid and amount=-84 from public.transactions where id=(select tx_id from fixtures where label='high')),'auto-applied result provenance and amount preserved');
select pg_temp.assert_true((select bool_and(transaction_type='unclassified') from public.transactions where id in(select tx_id from fixtures where label in('low','medium','invalid','sign','transfer','changed','api_error','null_ambiguous'))),'non-high or invalid decisions leave ledger residual');
select pg_temp.assert_true(jsonb_array_length(public.pending_ai_suggestions())=3,'Review Center returns pending medium suggestion');
select public.review_ai_suggestion((select id from public.transaction_ai_suggestions where transaction_id=(select tx_id from fixtures where label='approve')),'approve');
select pg_temp.assert_true((select status='approved' and decided_at is not null from public.transaction_ai_suggestions where transaction_id=(select tx_id from fixtures where label='approve')),'one-transaction approval audited');
select pg_temp.assert_true((select classification_method='manual' and transaction_type='expense' from public.transactions where id=(select tx_id from fixtures where label='approve')),'approval produces protected manual decision');
select public.review_ai_suggestion((select id from public.transaction_ai_suggestions where transaction_id=(select tx_id from fixtures where label='reject')),'reject');
select pg_temp.assert_true((select status='rejected' and decided_at is not null from public.transaction_ai_suggestions where transaction_id=(select tx_id from fixtures where label='reject')),'rejection audited');
select pg_temp.assert_true((select transaction_type='unclassified' from public.transactions where id=(select tx_id from fixtures where label='reject')),'rejection never changes ledger');
select public.review_ai_suggestion((select id from public.transaction_ai_suggestions where transaction_id=(select tx_id from fixtures where label='medium')),'remember');
select pg_temp.assert_true((select status='remembered' and decided_at is not null from public.transaction_ai_suggestions where transaction_id=(select tx_id from fixtures where label='medium')),'approval and remember audited');
select pg_temp.fixture('ai_learned_future','Bistro Horizon REF ABC123',-95);
select public.classify_transactions();
select pg_temp.assert_true((select classification_method='merchant_memory' from public.transactions where id=(select tx_id from fixtures where label='ai_learned_future')),'AI confirmation teaches deterministic memory for future imports');
select pg_temp.expect_error(format('select public.review_ai_suggestion(%L,%L)',(select id from public.transaction_ai_suggestions where transaction_id=(select tx_id from fixtures where label='medium')),'approve'),'not pending','double approval rejected');

update public.transaction_classification_rules set is_active=false where match_field='merchant_fingerprint' and pattern='v1:bistro horizon';
select pg_temp.fixture('revoked','Bistro Horizon REF DEF789',-107);
select public.classify_transactions();
select pg_temp.assert_true((select transaction_type='unclassified' from public.transactions where id=(select tx_id from fixtures where label='revoked')),'revoked memory stops future classification');
update public.transaction_classification_rules set is_active=true where match_field='merchant_fingerprint' and pattern='v1:bistro horizon';
select public.classify_transactions();
select pg_temp.assert_true((select classification_method='merchant_memory' from public.transactions where id=(select tx_id from fixtures where label='revoked')),'reactivating memory works deterministically');
select pg_temp.fixture('service_valid','Bistro Nebula',-108);
select public.claim_residual_ai_batch();
select jsonb_build_array(jsonb_build_object('claim_id',s.id,'attempt_token',s.attempt_token,'proposal',
  jsonb_build_object('proposed_transaction_type','expense','proposed_category_system_key','expense_dining',
    'normalized_merchant','bistro nebula','confidence',.99,'reason','Merchant sintetico','cannot_classify',false))) as service_results
 from public.transaction_ai_suggestions s join fixtures f on f.tx_id=s.transaction_id where f.label='service_valid' \gset
set local role service_role;
select pg_temp.assert_true(public.record_residual_ai_batch(current_setting('test.owner')::uuid,:'service_results'::jsonb)='{"auto_applied":1}'::jsonb,'actual service role can persist bounded batch');
set local role authenticated;
select pg_temp.assert_true(not has_function_privilege('authenticated','public.record_residual_ai_batch(uuid,jsonb)','EXECUTE'),'browser cannot invoke privileged AI batch');
select pg_temp.assert_true(not has_function_privilege('anon','public.claim_residual_ai_batch()','EXECUTE'),'anonymous cannot claim residuals');
select pg_temp.assert_true(not has_function_privilege('anon','public.review_ai_suggestion(uuid,text)','EXECUTE'),'anonymous cannot approve suggestions');
-- Scope: another owner has the same merchant but never inherits the decision or audit.
select set_config('request.jwt.claim.sub',current_setting('test.other'),true);
select pg_temp.assert_true((select count(*)=0 from public.transaction_ai_suggestions),'audit RLS owner isolation');
select pg_temp.assert_true((select count(*)=0 from public.transaction_classification_rules),'memory RLS owner isolation');
select pg_temp.expect_error(format('select public.review_ai_suggestion(%L,%L)',(select id from public.transaction_ai_suggestions limit 1),'approve'),'not pending','foreign owner cannot approve suggestion');
select set_config('test.account',current_setting('test.other_account'),true);
select pg_temp.fixture('foreign_future','Bistro Horizon REF ABC456',-96);
select public.classify_transactions();
select pg_temp.assert_true((select transaction_type='unclassified' from public.transactions where id=(select tx_id from fixtures where label='foreign_future')),'same merchant does not share learning across owners');
-- A technical failure can retry only after cooldown, with a fresh attempt token.
select set_config('request.jwt.claim.sub',current_setting('test.owner'),true);
reset role;
update public.transaction_ai_suggestions set updated_at=now()-interval '16 minutes',
 attempt_times=array[now()-interval '16 minutes'] where transaction_id=(select tx_id from fixtures where label='api_error');
select attempt_token as previous_attempt from public.transaction_ai_suggestions where transaction_id=(select tx_id from fixtures where label='api_error') \gset
set local role authenticated;
select public.claim_residual_ai_batch();
select pg_temp.assert_true((select status='processing' and attempt_count=2 and attempt_token<>:'previous_attempt'::uuid from public.transaction_ai_suggestions where transaction_id=(select tx_id from fixtures where label='api_error')),'technical retry uses cooldown and new attempt token');
reset role;
select pg_temp.assert_true(financialmind_classification_private.record_residual_ai_result(current_setting('test.owner')::uuid,s.id,:'previous_attempt'::uuid,null)='stale','late result from previous attempt cannot overwrite fresh claim') from public.transaction_ai_suggestions s where transaction_id=(select tx_id from fixtures where label='api_error');
set local role authenticated;
-- Cost/batch policy remains bounded on many different synthetic merchants.
select set_config('request.jwt.claim.sub',current_setting('test.owner'),true);
select set_config('test.account',(select id::text from public.accounts where user_id=current_setting('test.owner')::uuid limit 1),true);
select pg_temp.fixture('limit-'||i,'Synthetic Merchant number '||i,-200-i) from generate_series(1,90) i;
select public.claim_residual_ai_batch() as limited \gset
select pg_temp.assert_true(jsonb_array_length(:'limited'::jsonb->'candidates')=40,'batch size never exceeds central limit');
select public.claim_residual_ai_batch() as second_limited \gset
select pg_temp.assert_true(jsonb_array_length(:'second_limited'::jsonb->'candidates')<40,'hourly attempt budget caps next batch');
select pg_temp.assert_true(jsonb_array_length(public.claim_residual_ai_batch()->'candidates')=0,'hourly limit prevents extra model calls');
rollback;
