begin;
create or replace function pg_temp.assert_true(condition boolean,label text) returns void language plpgsql as $$
begin if condition is distinct from true then raise exception 'FAIL: %',label;end if;end $$;
create or replace function pg_temp.expect_error(statement text,message text,label text) returns void language plpgsql as $$
declare rejected boolean:=false;begin begin execute statement;exception when others then if strpos(sqlerrm,message)=0 then raise;end if;rejected:=true;end;perform pg_temp.assert_true(rejected,label);end $$;
select set_config('test.owner',gen_random_uuid()::text,true),set_config('test.other',gen_random_uuid()::text,true);
insert into auth.users values(current_setting('test.owner')::uuid),(current_setting('test.other')::uuid);
select set_config('request.jwt.claim.sub',current_setting('test.owner'),true);
set local role authenticated;
insert into public.invoices(numero,data,anno,cliente,descrizione,lordo,enasarco,netto)
values('repair',current_date,extract(year from current_date),'Test','Original',1000,0,900),('credit',current_date,extract(year from current_date),'Test','Credit',-100,0,-90);
select set_config('test.id',(select id::text from public.invoices where numero='repair'),true);
select pg_temp.assert_true((public.invoice_detail(current_setting('test.id')::uuid)->'invoice'->>'edit_version')::integer=0,'legacy detail is editable');
select public.save_invoice_correction(current_setting('test.id')::uuid,0,'recalculate','{"lordo":1000,"netto":900,"enasarco":999,"descrizione":"Corrected"}','Recover ENASARCO');
select pg_temp.assert_true((select enasarco=100 and lordo=1000 and netto=900 and edit_version=1 from public.invoices where numero='repair'),'server recomputes delta; preserves gross and net');
select pg_temp.assert_true((select count(*)=1 from public.invoice_revisions where (before_data->>'enasarco')::numeric=0 and (after_data->>'enasarco')::numeric=100),'before and after audit');
select pg_temp.expect_error(format('select public.save_invoice_correction(%L,0,''manual'',''{"lordo":1,"enasarco":0,"netto":1}'',''stale'')',current_setting('test.id')),'modificata','stale writes refused');
select pg_temp.expect_error(format('select public.save_invoice_correction(%L,1,''manual'',''{"lordo":1000,"enasarco":-1,"netto":900}'',''bad'')',current_setting('test.id')),'Importi non validi','invalid sign refused');
select pg_temp.expect_error(format('select public.save_invoice_correction(%L,1,''manual'',''{"lordo":1000.001,"enasarco":0,"netto":900}'',''bad'')',current_setting('test.id')),'Importi non validi','fractional cents refused');
select public.save_invoice_correction((select id from public.invoices where numero='credit'),0,'recalculate','{"lordo":-100,"netto":-90}','Credit delta');
select pg_temp.assert_true((select enasarco=-10 from public.invoices where numero='credit'),'credit delta stays negative');

select set_config('test.batch',(public.stage_invoice_import_batch('repair.xls','aruba_invoice_report_v1',jsonb_build_array(jsonb_build_object('raw_data','{}'::jsonb,'normalized_data',jsonb_build_object(
 'numero','repair','cliente','Test','data',current_date,'descrizione','Report','lordo',1000,'netto',850,'enasarco',150,'document_type','invoice','enasarco_source','document_gross_net_delta'))))->>'id'),true);
select public.commit_invoice_import_batch(current_setting('test.batch')::uuid);
select set_config('test.row',(select id::text from public.invoice_import_rows where batch_id=current_setting('test.batch')::uuid),true);
select pg_temp.assert_true(jsonb_array_length(public.invoice_detail(current_setting('test.id')::uuid)->'conflicts')=1,'historical conflict visible');
select public.save_invoice_correction(current_setting('test.id')::uuid,1,'apply_import','{}','Use documentary report',current_setting('test.row')::uuid);
select pg_temp.assert_true((select enasarco=150 and netto=850 and descrizione='Report' and edit_version=2 from public.invoices where numero='repair'),'applies server staged values');
select pg_temp.assert_true((select conflict_count=0 and updated_count=1 from public.invoice_import_batches where id=current_setting('test.batch')::uuid),'batch counters reflect resolution');
select pg_temp.assert_true((public.financial_income_summary(extract(year from current_date)::integer)->>'conflict_count')::integer=0,'resolved conflict no longer blocks summary');
select pg_temp.assert_true((public.financial_income_summary(extract(year from current_date)::integer)->>'enasarco_withheld')::numeric=140,'authoritative summary updated including signed credit');
select public.commit_invoice_import_batch(current_setting('test.batch')::uuid);
select pg_temp.assert_true((select edit_version=2 from public.invoices where numero='repair'),'commit retry does not undo edit');
-- A new reimport matches the corrected row, without duplicates.
select set_config('test.repeat',(public.stage_invoice_import_batch('repair.xls','aruba_invoice_report_v1',jsonb_build_array(jsonb_build_object('raw_data','{}'::jsonb,'normalized_data',jsonb_build_object(
 'numero','repair','cliente','Test','data',current_date,'descrizione','Report','lordo',1000,'netto',850,'enasarco',150,'document_type','invoice','enasarco_source','document_gross_net_delta'))))->>'id'),true);
select public.commit_invoice_import_batch(current_setting('test.repeat')::uuid);
select pg_temp.assert_true((select duplicate_count=1 from public.invoice_import_batches where id=current_setting('test.repeat')::uuid),'repeat matches corrected document');
-- Keep-existing also closes a conflict, without changing money.
select set_config('test.keep',(public.stage_invoice_import_batch('older.xls','aruba_invoice_report_v1',jsonb_build_array(jsonb_build_object('raw_data','{}'::jsonb,'normalized_data',jsonb_build_object(
 'numero','repair','cliente','Test','data',current_date,'descrizione','Old report','lordo',1000,'netto',900,'enasarco',100,'document_type','invoice'))))->>'id'),true);
select public.commit_invoice_import_batch(current_setting('test.keep')::uuid);
select public.save_invoice_correction(current_setting('test.id')::uuid,2,'keep_existing','{}','Outdated report',(select id from public.invoice_import_rows where batch_id=current_setting('test.keep')::uuid));
select pg_temp.assert_true((select enasarco=150 and netto=850 from public.invoices where numero='repair'),'keep preserves amounts');
select pg_temp.assert_true((select status='resolved_kept' from public.invoice_import_rows where batch_id=current_setting('test.keep')::uuid),'keep resolves row');
select pg_temp.assert_true((select count(*)=2 from public.invoices),'no duplicate invoices');
select pg_temp.expect_error('delete from public.invoice_revisions','permission denied','client cannot erase audit');
select set_config('request.jwt.claim.sub',current_setting('test.other'),true);
select pg_temp.expect_error(format('select public.invoice_detail(%L)',current_setting('test.id')),'non disponibile','other owner cannot view');
select pg_temp.expect_error(format('select public.save_invoice_correction(%L,3,''recalculate'',''{"lordo":1000,"netto":900}'',''cross owner'')',current_setting('test.id')),'non disponibile','other owner cannot edit');
select pg_temp.assert_true((select count(*)=0 from public.invoice_revisions),'audit isolated by owner');
reset role;
select set_config('request.jwt.claim.sub','',true);
select pg_temp.expect_error(format('select public.save_invoice_correction(%L,3,''recalculate'',''{"lordo":1000,"netto":900}'',''anonymous'')',current_setting('test.id')),'authentication required','missing auth refused');
rollback;
