-- Execute before PR6, in a disposable database bootstrapped with previous migrations.
create schema pr6_upgrade_test;
create function pr6_upgrade_test.prepare() returns void language plpgsql as $$
declare owner uuid:=gen_random_uuid(); account uuid:=gen_random_uuid(); batch uuid:=gen_random_uuid(); tx uuid:=gen_random_uuid();
begin
  insert into auth.users(id) values(owner);
  perform set_config('request.jwt.claim.sub',owner::text,false);
  insert into public.accounts(id,user_id,name,account_type,opening_balance,balance_as_of)
    values(account,owner,'Synthetic upgrade account','checking',1000,'2026-01-01');
  insert into public.import_batches(id,user_id,account_id,source_format,parser_key)
    values(batch,owner,account,'xlsx','isybank_operations_v1');
  insert into public.transactions(id,user_id,account_id,transaction_date,amount,description,transaction_type,import_batch_id,source)
    values(tx,owner,account,'2026-01-02',-10,'Apple.com/bill','unclassified',batch,'bank_import');
  insert into public.import_rows(user_id,batch_id,row_index,matched_transaction_id,raw_data,status)
    values(owner,batch,0,tx,'{"Categoria":"Addebiti vari","Operazione":"Apple.com/bill"}','imported');
  insert into public.transactions(user_id,account_id,transaction_date,amount,description,transaction_type,classification_method)
    values(owner,account,'2026-01-03',-11,'Synthetic protected manual','expense','manual'),
      (owner,account,'2026-01-04',-12,'Synthetic pending transfer','internal_transfer','provider_rule');
  insert into public.transaction_classification_rules(user_id,name,match_field,match_operator,pattern,target_transaction_type)
    values(owner,'Synthetic preexisting rule','description','exact','Synthetic match','expense');
end $$;
select pr6_upgrade_test.prepare();
create table pr6_upgrade_test.snapshots(entity text,id uuid,row_value jsonb);
insert into pr6_upgrade_test.snapshots select 'transactions',id,to_jsonb(t) from public.transactions t;
insert into pr6_upgrade_test.snapshots select 'accounts',id,to_jsonb(a) from public.accounts a;
insert into pr6_upgrade_test.snapshots select 'import_rows',id,to_jsonb(r) from public.import_rows r;
insert into pr6_upgrade_test.snapshots select 'rules',id,to_jsonb(r) from public.transaction_classification_rules r;
