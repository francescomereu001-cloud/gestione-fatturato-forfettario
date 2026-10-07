-- Synthetic fiscal integration tests, never a real taxpayer profile. Everything rolls back.
begin;
create function pg_temp.assert_true(condition boolean,label text) returns void language plpgsql as $$
begin if condition is distinct from true then raise exception 'FAIL: %',label; end if; raise notice 'PASS: %',label;end $$;
create function pg_temp.expect_error(statement text,message text,label text) returns void language plpgsql as $$
declare rejected boolean:=false;
begin begin execute statement;exception when others then if strpos(sqlerrm,message)=0 then raise;end if;rejected:=true;end;
 perform pg_temp.assert_true(rejected,label);end $$;
select set_config('test.owner',gen_random_uuid()::text,true),set_config('test.other',gen_random_uuid()::text,true);
insert into auth.users values(current_setting('test.owner')::uuid),(current_setting('test.other')::uuid);
select set_config('request.jwt.claim.sub',current_setting('test.owner'),true);
set local role authenticated;
select pg_temp.assert_true(public.financial_tax_summary(2026)->>'projection_status'='incomplete','missing profile is incomplete');
select pg_temp.assert_true(public.financial_tax_summary(2026)->'required_tax_reserve'='null'::jsonb,'no profile never produces a misleading reserve');
-- Configurable synthetic thresholds, deliberately not annual legal defaults.
insert into public.fiscal_year_settings(tax_year,tax_regime,revenue_basis,profitability_coefficient_pct,substitute_tax_rate_pct,
 social_security_scheme,ordinary_social_rate_pct,minimum_social_income,first_social_band,additional_social_rate_pct,
 maximum_social_income,maternity_contribution,contribution_reduction_pct,activity_start_date,parameter_period,
 invoice_semantics,enasarco_treatment,configuration_verified,parameters_status,liability_schedule_verified,source_note)
values(2026,'forfettario','cash',78,15,'inps_merchants',24,10000,20000,1,30000,7.44,0,'2020-01-01','annual',
 'gross_less_enasarco','not_applicable',true,'confirmed',true,'Synthetic parameters only');
select pg_temp.assert_true((public.financial_tax_summary(2026)->>'social_security_due_estimated')::numeric=2407.44,'zero revenue still owes configured merchant minimum and maternity');
select pg_temp.assert_true((public.financial_tax_summary(2026)->>'substitute_tax_due_estimated')::numeric=0,'zero revenue has zero substitute tax');
select pg_temp.assert_true(public.financial_tax_summary(2026)->>'projection_status'='estimated','current-year projection never claims final certainty');
select pg_temp.assert_true(public.financial_tax_summary(2026)->'reserved_tax_amount'='null'::jsonb and public.financial_tax_summary(2026)->'tax_reserve_gap'='null'::jsonb,'fund balance and gap unavailable until Funds');

create function pg_temp.revenue(gross numeric,collected boolean default true,invoice_date date default '2026-01-01',collection_date date default '2026-01-02',net numeric default null,enasarco numeric default 0)
returns void language sql as $$
 insert into public.invoices(lordo,netto,enasarco,incassata,data,data_incasso,anno)
 values(gross,coalesce(net,gross-enasarco),enasarco,collected,invoice_date,case when collected then collection_date end,extract(year from invoice_date)::integer)
$$;
select pg_temp.revenue(10000);
select pg_temp.revenue(5000,false);
select pg_temp.assert_true((public.financial_tax_summary(2026)->>'revenue_invoiced')::numeric=15000,'issued revenue remains distinct from cash revenue');
select pg_temp.assert_true((public.financial_tax_summary(2026)->>'taxable_revenue')::numeric=10000,'uncollected invoices excluded from cash tax base');
select pg_temp.assert_true((public.financial_tax_summary(2026)->>'receivables_uncollected')::numeric=5000,'receivables remain visible separately');
select pg_temp.assert_true((public.financial_tax_summary(2026)->>'forfettario_income')::numeric=7800,'78 percent coefficient applies to collected gross only');
select pg_temp.assert_true((public.financial_tax_summary(2026)->>'substitute_tax_due_estimated')::numeric=1170,'15 percent substitute tax');
update public.fiscal_year_settings set substitute_tax_rate_pct=5 where tax_year=2026;
select pg_temp.assert_true((public.financial_tax_summary(2026)->>'substitute_tax_due_estimated')::numeric=390,'5 percent substitute tax');
update public.fiscal_year_settings set substitute_tax_rate_pct=15 where tax_year=2026;
select pg_temp.revenue(1000,true,'2025-12-01','2026-02-01');
select pg_temp.assert_true((public.financial_tax_summary(2026)->>'taxable_revenue')::numeric=11000,'prior-issued invoice collected this year is taxable this year');
select pg_temp.assert_true((public.financial_tax_summary(2026)->>'revenue_invoiced')::numeric=15000,'prior-issued invoice not added to current issued total');
select pg_temp.revenue(2000,true,'2026-03-01','2027-01-01');
select pg_temp.assert_true((public.financial_tax_summary(2026)->>'taxable_revenue')::numeric=11000,'future collection excluded at snapshot cutoff');

-- Independent threshold cases isolate previdenza math from invoice cash transitions.
delete from public.invoices;
update public.fiscal_year_settings set profitability_coefficient_pct=100 where tax_year=2026;
select pg_temp.revenue(9999);
select pg_temp.assert_true((public.financial_tax_summary(2026)->>'social_security_due_estimated')::numeric=2407.44,'income below minimum uses minimum');
update public.invoices set lordo=10000,netto=10000;
select pg_temp.assert_true((public.financial_tax_summary(2026)->>'social_security_variable_due')::numeric=0,'income equal to minimum has no excess contribution');
update public.invoices set lordo=15000,netto=15000;
select pg_temp.assert_true((public.financial_tax_summary(2026)->>'social_security_due_estimated')::numeric=3607.44,'income between minimum and first band uses ordinary rate');
update public.invoices set lordo=25000,netto=25000;
select pg_temp.assert_true((public.financial_tax_summary(2026)->>'social_security_due_estimated')::numeric=6057.44,'above first band adds 1 percent only on excess band');
update public.invoices set lordo=40000,netto=40000;
select pg_temp.assert_true((public.financial_tax_summary(2026)->>'social_security_due_estimated')::numeric=7307.44,'maximum contribution income caps both ordinary and additional shares');
update public.fiscal_year_settings set contribution_reduction_pct=35 where tax_year=2026;
select pg_temp.assert_true((public.financial_tax_summary(2026)->>'social_security_due_estimated')::numeric=4752.44,'explicit 35 percent reduction applies once, maternity remains unreduced');
select pg_temp.assert_true((public.financial_tax_summary(2026)->>'maternity_due')::numeric=7.44,'maternity is separate from INPS ordinary rate');
update public.fiscal_year_settings set contribution_reduction_pct=0,profitability_coefficient_pct=78 where tax_year=2026;
update public.invoices set lordo=10000,netto=10000;

-- Paid mandatory contributions deduct in cash year, even when the competence year is prior.
insert into public.tax_payments(anno,data,importo,tipo,descrizione,fiscal_allocation_status,fiscal_tax_year,fiscal_payment_kind,deductible_social_security)
values(2026,'2026-03-01',1000,'F24','Synthetic prior INPS','allocated',2025,'inps_balance',true);
select pg_temp.assert_true((public.financial_tax_summary(2026)->>'deductible_social_security_paid')::numeric=1000,'prior-year INPS paid this year is cash deductible when explicitly marked');
select pg_temp.assert_true((public.financial_tax_summary(2026)->>'substitute_tax_base')::numeric=6800,'paid contributions reduce substitute-tax base');
select pg_temp.assert_true((public.financial_tax_summary(2026)->>'substitute_tax_due_estimated')::numeric=1020,'substitute tax uses net deductible base');
select pg_temp.assert_true((public.financial_tax_summary(2026)->>'social_security_paid')::numeric=0,'prior-year contribution payment does not cover current-year INPS');
insert into public.tax_payments(anno,data,importo,tipo,descrizione,fiscal_allocation_status,fiscal_tax_year,fiscal_payment_kind,deductible_social_security)
values(2026,'2026-03-02',200,'F24','Synthetic tax payment','allocated',2026,'substitute_tax_advance',false),
 (2026,'2026-03-03',300,'F24','Synthetic irrelevant F24','allocated',2026,'other_f24',false);
select pg_temp.assert_true((public.financial_tax_summary(2026)->>'deductible_social_security_paid')::numeric=1000,'other F24 and substitute tax never deducted as social contributions');
select pg_temp.assert_true((public.financial_tax_summary(2026)->>'substitute_tax_paid')::numeric=200,'current advance covers current substitute tax');
select pg_temp.assert_true((public.financial_tax_summary(2026)->>'required_tax_reserve')::numeric=3227.44,'reserve subtracts only compatible year/component payments');
insert into public.tax_payments(anno,data,importo,tipo,descrizione) values(2026,'2026-04-01',400,'F24','Synthetic ambiguous F24');
select pg_temp.assert_true(public.financial_tax_summary(2026)->>'projection_status'='incomplete','ambiguous F24 keeps projection incomplete');
select pg_temp.assert_true(public.financial_tax_summary(2026)->'required_tax_reserve'='null'::jsonb,'ambiguous payment never silently lowers reserve');
select pg_temp.assert_true((public.financial_tax_summary(2026)->>'unallocated_payments')::numeric=400,'unallocated F24 remains separately visible');
delete from public.tax_payments where fiscal_allocation_status='unallocated';
update public.tax_payments set importo=20000 where fiscal_payment_kind='inps_balance';
select pg_temp.assert_true((public.financial_tax_summary(2026)->>'substitute_tax_base')::numeric=0,'deduction cannot exceed permitted income');
select pg_temp.assert_true((public.financial_tax_summary(2026)->>'substitute_tax_due_estimated')::numeric=0,'deduction overflow never produces negative tax');
update public.tax_payments set importo=1000 where fiscal_payment_kind='inps_balance';

-- Prior-year balance is explicit; current advances are part of the current annual family, not additive twice.
insert into public.tax_liability_obligations(report_year,tax_year,obligation_role,payment_kind,amount,due_date,status,description)
values(2026,2025,'prior_year_balance','substitute_tax_balance',500,'2026-06-30','confirmed','Synthetic prior tax balance') returning id as prior_id \gset
insert into public.tax_liability_obligations(report_year,tax_year,obligation_role,payment_kind,amount,due_date,status,description)
values(2026,2026,'current_year_advance','substitute_tax_advance',600,'2026-11-30','confirmed','Synthetic current advance') returning id as advance_id \gset
select pg_temp.assert_true((public.financial_tax_summary(2026)->>'prior_year_balance_due')::numeric=500,'prior-year balance stays a distinct future cash obligation');
select pg_temp.assert_true((public.financial_tax_summary(2026)->>'current_year_advances_due')::numeric=400,'allocated current advance offsets matching scheduled family');
select pg_temp.assert_true((public.financial_tax_summary(2026)->>'required_tax_reserve')::numeric=3727.44,'advance schedule does not double count annual tax liability');
insert into public.tax_payments(anno,data,importo,tipo,descrizione,fiscal_allocation_status,fiscal_tax_year,fiscal_payment_kind,deductible_social_security,fiscal_obligation_id)
values(2026,'2026-06-01',700,'F24','Synthetic prior balance payment','allocated',2025,'substitute_tax_balance',false,:'prior_id');
select pg_temp.assert_true((public.financial_tax_summary(2026)->>'prior_year_balance_due')::numeric=0,'payment above specific obligation caps its coverage at that obligation');
select pg_temp.assert_true((public.financial_tax_summary(2026)->>'required_tax_reserve')::numeric=3227.44,'overpayment of prior tax never offsets current tax or INPS');
select pg_temp.assert_true((public.financial_tax_summary(2026)->>'already_paid')::numeric=700,'already-paid liability coverage is capped and includes correct components');
update public.tax_liability_obligations set amount=1500 where id=:'advance_id';
select pg_temp.assert_true((public.financial_tax_summary(2026)->>'required_tax_reserve')::numeric=3707.44,'larger explicit advance raises family cash requirement without adding full annual estimate again');
select pg_temp.expect_error(format('update public.tax_liability_obligations set tax_year=2024 where id=%L',:'prior_id'),'unlink payments','linked obligation competence cannot silently change');

-- ENASARCO: gross taxable compensation, withheld amount is cash deduction only when configured.
delete from public.tax_payments;
delete from public.tax_liability_obligations;
delete from public.invoices;
update public.fiscal_year_settings set enasarco_treatment='withheld_deductible' where tax_year=2026;
select pg_temp.revenue(10000,true,'2026-01-01','2026-01-02',9000,1000);
select pg_temp.assert_true((public.financial_tax_summary(2026)->>'revenue_collected')::numeric=9000,'actual net collection excludes withheld ENASARCO');
select pg_temp.assert_true((public.financial_tax_summary(2026)->>'taxable_revenue')::numeric=10000,'tax revenue uses gross commission, not net after ENASARCO');
select pg_temp.assert_true((public.financial_tax_summary(2026)->>'substitute_tax_base')::numeric=6800,'ENASARCO deduction occurs once after profitability coefficient');
select pg_temp.assert_true((public.financial_tax_summary(2026)->>'required_tax_reserve')::numeric=3427.44,'already withheld ENASARCO is not added to cash reserve');
update public.fiscal_year_settings set enasarco_treatment='withheld_not_deductible' where tax_year=2026;
select pg_temp.assert_true((public.financial_tax_summary(2026)->>'substitute_tax_base')::numeric=7800,'explicit nondeductible withholding never deducted automatically');
update public.invoices set enasarco=0;
select pg_temp.assert_true(public.financial_tax_summary(2026)->>'projection_status'='incomplete','legacy importer gross/net discrepancy cannot be invented as ENASARCO');
update public.fiscal_year_settings set invoice_semantics='gross_with_other_net_adjustments' where tax_year=2026;
select pg_temp.assert_true(public.financial_tax_summary(2026)->>'projection_status'='estimated','explicit net-adjustment semantics permit a transparent estimate');
update public.invoices set data_incasso=null;
select pg_temp.assert_true(public.financial_tax_summary(2026)->>'projection_status'='incomplete','paid invoice without collection date remains incomplete');
update public.invoices set data_incasso='2026-01-02';
update public.fiscal_year_settings set activity_start_date='2026-07-01' where tax_year=2026;
select pg_temp.assert_true(public.financial_tax_summary(2026)->'missing_fields' @> '["activity_period_parameters"]','partial activity needs explicitly adjusted period parameters');
update public.fiscal_year_settings set activity_start_date='2020-01-01',liability_schedule_verified=false where tax_year=2026;
select pg_temp.assert_true(public.financial_tax_summary(2026)->'required_tax_reserve'='null'::jsonb,'unreviewed prior balances and advances block reserve');
update public.fiscal_year_settings set liability_schedule_verified=true,configuration_verified=false where tax_year=2026;
select pg_temp.assert_true(public.financial_tax_summary(2026)->>'projection_status'='estimated','complete but unverified parameters remain estimated');

-- Same synthetic legacy fixture as tax.test.ts: mathematical differences are expected.
delete from public.invoices;
update public.fiscal_year_settings set invoice_semantics='gross_less_enasarco',enasarco_treatment='withheld_deductible',configuration_verified=true where tax_year=2026;
select pg_temp.revenue(10000,true,'2026-01-01','2026-01-02',9000,1000);
select pg_temp.revenue(5000,false,'2026-01-03',null,4500,500);
insert into public.tax_payments(anno,data,importo,tipo,fiscal_allocation_status,fiscal_tax_year,fiscal_payment_kind,deductible_social_security)
values(2026,'2026-03-01',1000,'F24','allocated',2026,'inps_minimum',true);
select pg_temp.assert_true((public.financial_tax_summary(2026)->>'substitute_tax_due_estimated')::numeric=870,'legacy fixture comparison: cash basis and both explicit paid deductions produce tax 870 versus legacy 1755');
select pg_temp.assert_true((public.financial_tax_summary(2026)->>'required_tax_reserve')::numeric=2277.44,'legacy fixture comparison: reserve 2277.44 versus legacy residual 3563');
update public.fiscal_year_settings set maximum_social_income=null where tax_year=2026;
select pg_temp.assert_true(public.financial_tax_summary(2026)->'required_tax_reserve'='null'::jsonb,'missing mandatory cap blocks reserve');
update public.fiscal_year_settings set maximum_social_income=30000 where tax_year=2026;
-- Closed past year can be confirmed only with explicitly finalized verified parameters.
insert into public.fiscal_year_settings(tax_year,tax_regime,revenue_basis,profitability_coefficient_pct,substitute_tax_rate_pct,social_security_scheme,activity_start_date,parameter_period,invoice_semantics,enasarco_treatment,configuration_verified,parameters_status,year_finalized,liability_schedule_verified,source_note)
values(2025,'forfettario','cash',78,15,'none','2020-01-01','annual','gross_less_enasarco','withheld_deductible',true,'confirmed',true,true,'Synthetic closed year');
select pg_temp.assert_true(public.financial_tax_summary(2025)->>'projection_status'='confirmed','closed verified finalized year can be confirmed');
select pg_temp.assert_true((public.financial_tax_summary(2025)->>'social_security_due_estimated')::numeric=0,'explicit none social scheme produces no contributions');
update public.fiscal_year_settings set social_security_scheme='inps_separate',ordinary_social_rate_pct=26,maximum_social_income=30000,maternity_contribution=0,contribution_reduction_pct=0 where tax_year=2025;
select pg_temp.assert_true(public.financial_tax_summary(2025)->>'projection_status'='confirmed','explicit complete separate-management configuration supported');
update public.fiscal_year_settings set contribution_reduction_pct=35 where tax_year=2025;
select pg_temp.assert_true(public.financial_tax_summary(2025)->'required_tax_reserve'='null'::jsonb,'unsupported separate-management reduction blocks reserve');

-- Owner isolation and privilege boundaries.
insert into public.tax_liability_obligations(report_year,tax_year,obligation_role,payment_kind,amount,description)
values(2026,2026,'current_year_advance','substitute_tax_advance',100,'Owner A obligation') returning id as advance_id \gset
select set_config('request.jwt.claim.sub',current_setting('test.other'),true);
select pg_temp.assert_true((select count(*)=0 from public.fiscal_year_settings),'annual profile RLS isolates owners');
select pg_temp.assert_true((select count(*)=0 from public.invoices),'invoice RLS isolates owners');
select pg_temp.assert_true((public.financial_tax_summary(2026)->>'taxable_revenue')::numeric=0,'owner B calculation never uses owner A invoices');
select pg_temp.assert_true(public.financial_tax_summary(2026)->>'projection_status'='incomplete','owner B does not inherit owner A profile');
insert into public.fiscal_year_settings(tax_year) values(2026);
select pg_temp.assert_true((select count(*)=1 from public.fiscal_year_settings where tax_year=2026),'different owners can independently configure same year');
select pg_temp.assert_true((select count(*)=0 from public.tax_liability_obligations),'obligation RLS isolates owners');
with changed as (update public.fiscal_year_settings set source_note='foreign overwrite' where user_id=current_setting('test.owner')::uuid returning *) select pg_temp.assert_true((select count(*)=0 from changed),'foreign profile update cannot touch rows');
with removed as (delete from public.tax_liability_obligations where user_id=current_setting('test.owner')::uuid returning *) select pg_temp.assert_true((select count(*)=0 from removed),'foreign obligation deletion cannot touch rows');
select pg_temp.expect_error(format('insert into public.fiscal_year_settings(user_id,tax_year) values(%L,2025)',current_setting('test.owner')),'row-level security','cannot create a foreign profile');
select pg_temp.expect_error(format('insert into public.tax_payments(anno,data,importo,fiscal_allocation_status,fiscal_tax_year,fiscal_payment_kind,deductible_social_security,fiscal_obligation_id) values(2026,%L,20,%L,2026,%L,false,%L)',
 '2026-01-01','allocated','substitute_tax_advance',:'advance_id'),'must match payment owner','cross-owner obligation links rejected');
select pg_temp.assert_true(not has_function_privilege('anon','public.financial_tax_summary(integer,date)','EXECUTE'),'anonymous fiscal RPC access revoked');
select pg_temp.assert_true(not (select prosecdef from pg_proc where oid='public.financial_tax_summary(integer,date)'::regprocedure),'fiscal RPC is SECURITY INVOKER');
select set_config('request.jwt.claim.sub','',true);
select pg_temp.expect_error('select public.financial_tax_summary(2026)','authentication required','missing JWT owner cannot calculate');
rollback;
