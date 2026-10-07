begin;
create function pg_temp.assert_true(condition boolean,label text) returns void language plpgsql as $$
begin if condition is distinct from true then raise exception 'FAIL: %',label;end if;raise notice 'PASS: %',label;end $$;
create function pg_temp.expect_error(statement text,message text,label text) returns void language plpgsql as $$
declare rejected boolean:=false;begin begin execute statement;exception when others then if strpos(sqlerrm,message)=0 then raise;end if;rejected:=true;end;perform pg_temp.assert_true(rejected,label);end $$;
select set_config('test.owner',gen_random_uuid()::text,true),set_config('test.other',gen_random_uuid()::text,true);
insert into auth.users values(current_setting('test.owner')::uuid),(current_setting('test.other')::uuid);
select set_config('request.jwt.claim.sub',current_setting('test.owner'),true);
set local role authenticated;
create function pg_temp.doc(num text,gross numeric default 1000,held numeric default 100,net numeric default 900,kind text default 'invoice',issued date default current_date)
 returns jsonb language sql as $$select jsonb_build_object('numero',num,'data',issued,'cliente','Synthetic customer','descrizione','Project','lordo',gross,'enasarco',held,'netto',net,'document_type',kind)$$;
create function pg_temp.rows(docs jsonb) returns jsonb language sql as $$select jsonb_agg(jsonb_build_object('normalized_data',d,'raw_data',d,'row_index',n)) from jsonb_array_elements(docs) with ordinality x(d,n)$$;
create function pg_temp.stage(docs jsonb) returns uuid language sql as $$select (public.stage_invoice_import_batch('synthetic.xls','aruba_invoice_report_v1',pg_temp.rows(docs))->>'id')::uuid$$;
select set_config('test.year',extract(year from current_date)::text,true);
select set_config('test.batch',pg_temp.stage(jsonb_build_array(pg_temp.doc('1')) )::text,true);
select pg_temp.assert_true((select count(*)=0 from public.invoices),'stage never inserts invoices');
select pg_temp.assert_true((select status='new' from public.invoice_import_rows),'server classifies new row');
select public.commit_invoice_import_batch(current_setting('test.batch')::uuid);
select pg_temp.assert_true((select lordo=1000 and enasarco=100 and netto=900 and incassata and data_incasso=data from public.invoices),'first import preserves ENASARCO and applies collected policy');
select pg_temp.assert_true((public.commit_invoice_import_batch(current_setting('test.batch')::uuid)->>'inserted_count')::integer=1 and (select count(*)=1 from public.invoices),'commit retries idempotent');
select set_config('test.repeat',pg_temp.stage(jsonb_build_array(pg_temp.doc('1')))::text,true);
select pg_temp.assert_true((select status='existing_unchanged' from public.invoice_import_rows where batch_id=current_setting('test.repeat')::uuid),'existing unchanged separated from in-file duplicate');
select public.commit_invoice_import_batch(current_setting('test.repeat')::uuid);
select pg_temp.assert_true((select count(*)=1 from public.invoices),'second identical report inserts zero');
select set_config('test.cumulative',pg_temp.stage(jsonb_build_array(pg_temp.doc('1'),pg_temp.doc('2',2000,200,1800),pg_temp.doc('2',2000,200,1800),pg_temp.doc('1',1200,100,1100),pg_temp.doc('CN1',100,10,90,'credit_note')))::text,true);
select pg_temp.assert_true((select count(*)=1 from public.invoice_import_rows where batch_id=current_setting('test.cumulative')::uuid and status='exact_duplicate'),'in-file exact duplicate');
select pg_temp.assert_true((select count(*)=1 from public.invoice_import_rows where batch_id=current_setting('test.cumulative')::uuid and status='conflict'),'changed document conflict');
select public.commit_invoice_import_batch(current_setting('test.cumulative')::uuid);
select pg_temp.assert_true((select count(*)=3 from public.invoices),'cumulative report inserts new invoice and credit only');
select pg_temp.assert_true((select lordo=1000 from public.invoices where numero='1'),'conflict never overwrites');
select pg_temp.assert_true((select lordo=-100 and enasarco=-10 and netto=-90 from public.invoices where numero='CN1'),'credit contributes signed amounts');
select pg_temp.assert_true((public.financial_income_summary(current_setting('test.year')::integer)->>'gross_invoiced')::numeric=2900,'gross total includes credit reduction');
select pg_temp.assert_true((public.financial_income_summary(current_setting('test.year')::integer)->>'enasarco_withheld')::numeric=290,'ENASARCO total');
select pg_temp.assert_true((public.financial_income_summary(current_setting('test.year')::integer)->>'net_income')::numeric=2610,'net total');
select pg_temp.assert_true((public.financial_income_summary(current_setting('test.year')::integer)->>'invoice_count')::integer=3,'document count');
select pg_temp.assert_true((public.financial_income_summary(current_setting('test.year')::integer)->>'credit_notes_total')::numeric=-100,'credit note total');
select pg_temp.assert_true((select sum((value->>'gross')::numeric)=2900 from jsonb_array_elements(public.financial_income_summary(current_setting('test.year')::integer)->'monthly')),'monthly breakdown agrees with server total');
select pg_temp.assert_true((public.financial_income_summary(current_setting('test.year')::integer)->>'conflict_count')::integer=1,'committed import conflicts visible in Income');
-- Legacy row payment flags remain untouched while policy applies in read model.
insert into public.invoices(numero,data,anno,cliente,lordo,enasarco,netto,incassata,data_incasso) values('legacy',current_date,extract(year from current_date),'Old',100,10,90,false,current_date+100);
select pg_temp.assert_true((public.financial_tax_summary(current_setting('test.year')::integer)->>'taxable_revenue')::numeric=3000,'legacy unpaid and future collection never exclude valid issued gross');
select pg_temp.assert_true((select not incassata and data_incasso=current_date+100 from public.invoices where numero='legacy'),'legacy flags and dates remain preserved');
select pg_temp.assert_true((public.financial_tax_summary(current_setting('test.year')::integer)->>'enasarco_withheld')::numeric=300,'fiscal uses documentary ENASARCO');
insert into public.fiscal_year_settings(tax_year,tax_regime,revenue_basis,profitability_coefficient_pct,substitute_tax_rate_pct,social_security_scheme,ordinary_social_rate_pct,maximum_social_income,maternity_contribution,contribution_reduction_pct,activity_start_date,parameter_period,invoice_semantics,enasarco_treatment,configuration_verified,parameters_status,liability_schedule_verified,source_note)
 values(current_setting('test.year')::integer,'forfettario','cash',80,10,'inps_separate',20,100000,0,0,'2020-01-01','annual','gross_less_enasarco','withheld_deductible',true,'confirmed',true,'Synthetic only');
select pg_temp.assert_true((public.financial_tax_summary(current_setting('test.year')::integer)->>'forfettario_income')::numeric=2400,'configured forfettario coefficient');
select pg_temp.assert_true((public.financial_tax_summary(current_setting('test.year')::integer)->>'social_security_due_estimated')::numeric=480,'configured INPS');
select pg_temp.assert_true((public.financial_tax_summary(current_setting('test.year')::integer)->>'substitute_tax_due_estimated')::numeric=210,'withheld ENASARCO deducted once');
select pg_temp.assert_true((public.financial_tax_summary(current_setting('test.year')::integer)->>'required_tax_reserve')::numeric=690,'tax reserve from PR10 formula');
insert into public.accounts(name,account_type,opening_balance,balance_as_of) values('Synthetic bank','checking',10000,current_date-1);
insert into public.financial_planning_settings(commitments_verified_through) values((date_trunc('month',current_date)+interval '1 month - 1 day')::date);
select public.financial_bootstrap_funds();
select pg_temp.assert_true((public.financial_safe_to_spend()->>'safe_to_spend')::numeric=9310,'Safe to Spend consumes required tax reserve');
select public.financial_allocate_fund((select id from public.financial_funds where system_key='tax'),100);
select pg_temp.assert_true((public.financial_safe_to_spend()->>'safe_to_spend')::numeric=9310,'PR11 tax fund never double counted');
select public.commit_invoice_import_batch(pg_temp.stage(jsonb_build_array(pg_temp.doc('3'))));
select pg_temp.assert_true((public.financial_tax_summary(current_setting('test.year')::integer)->>'required_tax_reserve')::numeric=920,'new invoice updates tax reserve');
select pg_temp.assert_true((public.financial_safe_to_spend()->>'safe_to_spend')::numeric=9080,'import -> fiscal -> reserve -> Safe to Spend');
insert into public.transactions(account_id,transaction_date,amount,description,transaction_type) select id,current_date,1000,'Same invoice bank receipt','income' from public.accounts;
select pg_temp.assert_true((public.financial_tax_summary(current_setting('test.year')::integer)->>'taxable_revenue')::numeric=4000,'bank deposit creates no second income');
insert into public.tax_payments(anno,data,importo,descrizione,tipo) values(current_setting('test.year')::integer,current_date,50,'Unknown F24','F24');
select pg_temp.assert_true(public.financial_tax_summary(current_setting('test.year')::integer)->'required_tax_reserve'='null'::jsonb and (public.financial_tax_summary(current_setting('test.year')::integer)->>'unallocated_payments')::numeric=50,'unallocated F24 leaves projection incomplete instead of reducing reserve');
update public.tax_payments set fiscal_allocation_status='allocated',fiscal_tax_year=current_setting('test.year')::integer,fiscal_payment_kind='substitute_tax_advance',deductible_social_security=false;
select pg_temp.assert_true((public.financial_tax_summary(current_setting('test.year')::integer)->>'required_tax_reserve')::numeric=870,'allocated F24 reduces correct liability');
-- Document mismatch retained and warned, no silent correction or arbitrary exclusion.
select public.commit_invoice_import_batch(pg_temp.stage(jsonb_build_array(pg_temp.doc('mismatch',100,10,85))));
select pg_temp.assert_true((select netto=85 from public.invoices where numero='mismatch'),'discrepant net preserved');
select pg_temp.assert_true((select warning_codes @> ARRAY['gross_enasarco_net_mismatch'] from public.invoice_import_rows where normalized_data->>'numero'='mismatch'),'server recomputes warnings');
select pg_temp.assert_true(public.financial_tax_summary(current_setting('test.year')::integer)->'required_tax_reserve'<>'null'::jsonb,'cent discrepancy does not reject valid documentary income');
-- Stable SDI evidence detects changed number/date/customer rather than inserting a second document.
select public.commit_invoice_import_batch(pg_temp.stage(jsonb_build_array(pg_temp.doc('sdi')||jsonb_build_object('source_document_id','synthetic-sdi'))));
select set_config('test.sdi',pg_temp.stage(jsonb_build_array(pg_temp.doc('sdi-renamed')||jsonb_build_object('source_document_id','synthetic-sdi')))::text,true);
select pg_temp.assert_true((select status='conflict' from public.invoice_import_rows where batch_id=current_setting('test.sdi')::uuid),'SDI catches changed document identity fields');
select public.commit_invoice_import_batch(current_setting('test.sdi')::uuid);
select pg_temp.assert_true((select count(*)=1 from public.invoices where source_document_id='synthetic-sdi'),'SDI conflict creates no second income');
-- Stage cannot trust client owner, payment flags, audit counts or warnings.
select set_config('test.forged',pg_temp.stage(jsonb_build_array(pg_temp.doc('forged')||jsonb_build_object('user_id',current_setting('test.other'),'incassata',false)))::text,true);
select public.commit_invoice_import_batch(current_setting('test.forged')::uuid);
select pg_temp.assert_true((select user_id=current_setting('test.owner')::uuid and incassata from public.invoices where numero='forged'),'owner and collected policy derived server-side');
-- A different commit between preview and commit is handled without stale browser dedup.
select set_config('test.stale',pg_temp.stage(jsonb_build_array(pg_temp.doc('stale')))::text,true);
select public.commit_invoice_import_batch(pg_temp.stage(jsonb_build_array(pg_temp.doc('stale'))));
select pg_temp.assert_true((public.commit_invoice_import_batch(current_setting('test.stale')::uuid)->>'inserted_count')::integer=0,'commit rechecks stale preview');
-- Invalid normalized rows are audited, not partially inserted.
select set_config('test.invalid',pg_temp.stage(jsonb_build_array(pg_temp.doc('invalid')||jsonb_build_object('data','2025-02-31')))::text,true);
select pg_temp.assert_true((public.commit_invoice_import_batch(current_setting('test.invalid')::uuid)->>'rejected_count')::integer=1,'invalid date audited as rejected');
-- Confirmed real-export policy: server derives withholding from gross/net and records provenance.
select public.commit_invoice_import_batch(pg_temp.stage(jsonb_build_array(pg_temp.doc('delta',100,999,90)||jsonb_build_object('enasarco_source','document_gross_net_delta'))));
select pg_temp.assert_true((select enasarco=10 and import_metadata->>'enasarco_source'='document_gross_net_delta' from public.invoices where numero='delta'),'confirmed gross/net delta is authoritative and audited');
-- Unknown ENASARCO in malformed/unsupported payload does not invent zero/difference.
select public.commit_invoice_import_batch(pg_temp.stage(jsonb_build_array(pg_temp.doc('missing',100,null,90))));
select pg_temp.assert_true((select enasarco is null and netto=90 from public.invoices where numero='missing'),'unknown withholding remains null');
select pg_temp.assert_true(public.financial_income_summary(current_setting('test.year')::integer)->'enasarco_withheld'='null'::jsonb,'unknown withholding never yields misleading aggregate');
select pg_temp.assert_true(public.financial_tax_summary(current_setting('test.year')::integer)->'required_tax_reserve'='null'::jsonb,'missing documentary value keeps fiscal projection incomplete');
-- Fail AFTER first invoice insert to prove transaction-wide rollback and retryable staged audit.
reset role;
create function pg_temp.fail_invoice() returns trigger language plpgsql as $$begin if new.numero='fail_second' then raise exception 'injected failure';end if;return new;end$$;
create trigger pr12_fail before insert on public.invoices for each row execute function pg_temp.fail_invoice();
set local role authenticated;
select set_config('test.fail',pg_temp.stage(jsonb_build_array(pg_temp.doc('first_atomic'),pg_temp.doc('fail_second')))::text,true);
select pg_temp.expect_error($q$select public.commit_invoice_import_batch(current_setting('test.fail')::uuid)$q$,'injected failure','atomic rollback');
select pg_temp.assert_true((select count(*)=0 from public.invoices where numero in ('first_atomic','fail_second')),'first insert rolled back');
select pg_temp.assert_true((select status='staged' from public.invoice_import_batches where id=current_setting('test.fail')::uuid),'failed batch remains staged');
select pg_temp.expect_error($q$update public.invoice_import_rows set status='inserted'$q$,'permission denied','audit cannot be forged');
select pg_temp.expect_error($q$update public.invoice_import_batches set inserted_count=999$q$,'permission denied','batch counts immutable to client');
select set_config('test.invoice',(select id::text from public.invoices limit 1),true);
select set_config('request.jwt.claim.sub',current_setting('test.other'),true);
select pg_temp.assert_true((select count(*)=0 from public.invoices),'foreign invoice inaccessible');
select pg_temp.assert_true((select count(*)=0 from public.invoice_import_batches),'foreign batch inaccessible');
select pg_temp.assert_true((select count(*)=0 from public.invoice_import_rows),'foreign rows inaccessible');
select pg_temp.expect_error($q$select public.commit_invoice_import_batch(current_setting('test.batch')::uuid)$q$,'batch unavailable','foreign commit rejected');
select pg_temp.assert_true((public.financial_income_summary(current_setting('test.year')::integer)->>'gross_invoiced')::numeric=0,'summary owner isolation');
select pg_temp.expect_error($q$select financial_private.invoice_import('commit',current_setting('test.batch')::uuid)$q$,'batch unavailable','private writer has same owner check');
reset role;set local role anon;
select pg_temp.expect_error($q$select public.financial_income_summary(2026)$q$,'permission denied','anon summary denied');
select pg_temp.expect_error($q$select public.stage_invoice_import_batch('x','aruba_invoice_report_v1','[]')$q$,'permission denied','anon stage denied');
select pg_temp.expect_error($q$select public.commit_invoice_import_batch(current_setting('test.batch')::uuid)$q$,'permission denied','anon commit denied');
select pg_temp.expect_error($q$select * from public.invoice_import_batches$q$,'permission denied','anon audit denied');
rollback;
