-- Synthetic-only assertions against the actual authoritative functions. Entire suite rolls back.
begin;
create function pg_temp.assert_true(condition boolean,label text) returns void language plpgsql as $$
begin if condition is distinct from true then raise exception 'FAIL: %',label;end if;raise notice 'PASS: %',label;end $$;
create function pg_temp.expect_error(statement text,message text,label text) returns void language plpgsql as $$
declare rejected boolean:=false;begin begin execute statement;exception when others then
 if strpos(sqlerrm,message)=0 then raise;end if;rejected:=true;end;perform pg_temp.assert_true(rejected,label);end $$;
select set_config('test.owner',gen_random_uuid()::text,true),set_config('test.other',gen_random_uuid()::text,true);
insert into auth.users values(current_setting('test.owner')::uuid),(current_setting('test.other')::uuid);
select set_config('request.jwt.claim.sub',current_setting('test.other'),true);
set local role authenticated;
select public.financial_bootstrap_funds();
select set_config('test.other_fund',(select id::text from public.financial_funds where system_key='house'),true);
select set_config('request.jwt.claim.sub',current_setting('test.owner'),true);
select public.financial_bootstrap_funds();select public.financial_bootstrap_funds();
select pg_temp.assert_true((select count(*)=5 from public.financial_funds),'bootstrap is idempotent and owner-scoped');
select pg_temp.assert_true((select count(*)=0 from public.fund_entries),'bootstrap never allocates');
select set_config('test.house',(select id::text from public.financial_funds where system_key='house'),true),
 set_config('test.tax',(select id::text from public.financial_funds where system_key='tax'),true),
 set_config('test.emergency',(select id::text from public.financial_funds where system_key='emergency'),true);
insert into public.accounts(name,account_type,opening_balance,balance_as_of) values('Main','checking',30000,current_date-10);
select set_config('test.account',(select id::text from public.accounts where name='Main'),true);
insert into public.accounts(name,account_type,opening_balance,include_in_liquidity) values('Excluded','broker',99999,false);
insert into public.accounts(name,account_type,opening_balance,is_active) values('Inactive','checking',99999,false);
insert into public.transactions(account_id,transaction_date,booking_date,amount,description,transaction_type,reconciliation_status) values
 (current_setting('test.account')::uuid,current_date-20,null,100,'before anchor','income','confirmed'),
 (current_setting('test.account')::uuid,current_date-10,null,100,'at anchor','income','confirmed'),
 (current_setting('test.account')::uuid,current_date+1,null,100,'future','income','confirmed'),
 (current_setting('test.account')::uuid,current_date-2,null,100,'ignored','income','ignored'),
 (current_setting('test.account')::uuid,current_date-20,current_date-1,200,'booking after anchor','income','confirmed'),
 (current_setting('test.account')::uuid,current_date-1,current_date+1,300,'future booking','income','confirmed');
select pg_temp.assert_true((public.financial_liquidity_summary()->>'total_liquidity')::numeric=30200,'anchor, booking precedence, ignored, future, excluded and inactive');
select pg_temp.assert_true((public.financial_liquidity_summary(current_date-11)->'missing_fields')<>'[]'::jsonb,'snapshot before anchor is explicitly incomplete');
insert into public.accounts(name,account_type,opening_balance) values('Second','checking',0);
insert into public.transactions(account_id,transaction_date,amount,description,transaction_type) values
 (current_setting('test.account')::uuid,current_date,-500,'transfer out','internal_transfer'),
 ((select id from public.accounts where name='Second'),current_date,500,'transfer in','internal_transfer');
select pg_temp.assert_true((public.financial_liquidity_summary()->>'total_liquidity')::numeric=30200,'internal bank transfer is neutral');
select pg_temp.assert_true(public.financial_safe_to_spend()->>'status'='incomplete' and public.financial_safe_to_spend()->'safe_to_spend'='null'::jsonb,'no fiscal profile or verification means null STS');
insert into public.fiscal_year_settings(tax_year,tax_regime,revenue_basis,profitability_coefficient_pct,substitute_tax_rate_pct,
 social_security_scheme,activity_start_date,parameter_period,invoice_semantics,enasarco_treatment,configuration_verified,parameters_status,liability_schedule_verified,source_note)
values(extract(year from current_date)::integer,'forfettario','cash',100,0,'none',current_date-interval '2 years','annual','gross_less_enasarco','not_applicable',true,'confirmed',true,'Synthetic no social obligations');
insert into public.financial_planning_settings(commitments_verified_through) values((date_trunc('month',current_date)+interval '1 month - 1 day')::date);
select pg_temp.assert_true((public.financial_safe_to_spend()->>'safe_to_spend')::numeric=30200,'baseline zero tax no commitments');
select pg_temp.assert_true(public.financial_safe_to_spend()->>'status'='estimated','ongoing PR10 fiscal projection propagates estimated');
select pg_temp.assert_true(public.financial_safe_to_spend()->'emergency_coverage_months'='null'::jsonb,'coverage has no inferred expense target');
select public.financial_allocate_fund(current_setting('test.tax')::uuid,10000);
insert into public.tax_liability_obligations(report_year,tax_year,obligation_role,payment_kind,amount,status,description)
values(extract(year from current_date)::integer,extract(year from current_date)::integer,'other','other_f24',8000,'confirmed','Synthetic explicit reserve');
select pg_temp.assert_true((public.financial_safe_to_spend()->>'safe_to_spend')::numeric=20200 and (public.financial_safe_to_spend()->>'tax_reserve_gap')::numeric=0,'10000 tax fund covers 8000 reserve without double counting');
select public.financial_release_fund(current_setting('test.tax')::uuid,6000);
select pg_temp.assert_true((public.financial_safe_to_spend()->>'tax_reserve_gap')::numeric=4000 and (public.financial_safe_to_spend()->>'safe_to_spend')::numeric=22200,'partially funded tax subtracts gap only');
select public.financial_release_fund(current_setting('test.tax')::uuid,4000);
select pg_temp.assert_true((public.financial_safe_to_spend()->>'tax_reserve_gap')::numeric=8000 and (public.financial_safe_to_spend()->>'safe_to_spend')::numeric=22200,'unfunded tax reserve gap');
select public.financial_allocate_fund(current_setting('test.house')::uuid,5000);
insert into public.financial_goals(name,goal_type,target_amount,target_date,linked_fund_id)
values('Casa','house',10000,current_date+90,current_setting('test.house')::uuid);
select pg_temp.assert_true((public.financial_goal_summary()->0->>'current_amount')::numeric=5000 and (public.financial_goal_summary()->0->>'progress_percentage')::numeric=50,'goal balance and progress derive from linked fund');
select pg_temp.assert_true((public.financial_goal_summary()->0->>'remaining_amount')::numeric=5000 and (public.financial_goal_summary()->0->>'days_remaining')::integer=90 and (public.financial_goal_summary()->0->>'required_monthly_pace')::numeric>0,'remaining, days and monthly pace server metrics');
select pg_temp.assert_true((public.financial_safe_to_spend()->>'safe_to_spend')::numeric=17200,'linked goal and informative pace never subtract house balance twice');
select pg_temp.expect_error($q$insert into public.financial_goals(name,goal_type,target_amount,linked_fund_id) values('Duplicate','house',5000,current_setting('test.house')::uuid)$q$,'duplicate key','one active goal per fund');
update public.financial_goals set status='paused';
select pg_temp.assert_true(public.financial_goal_summary()->0->'required_monthly_pace'='null'::jsonb,'paused goal has no active pace');
update public.financial_goals set status='active',target_amount=5000;
select pg_temp.assert_true((public.financial_goal_summary()->0->>'remaining_amount')::numeric=0 and (public.financial_goal_summary()->0->>'progress_percentage')::numeric=100,'achieved target');
update public.financial_goals set target_date=current_date-1,target_amount=10000;
select pg_temp.assert_true(public.financial_goal_summary()->0->'required_monthly_pace'='null'::jsonb,'overdue goal does not invent monthly pace');
select pg_temp.expect_error($q$select public.financial_release_fund(current_setting('test.house')::uuid,5001)$q$,'insufficient fund balance','insufficient source balance');
select pg_temp.expect_error($q$select public.financial_allocate_fund(current_setting('test.house')::uuid,30000)$q$,'insufficient free liquidity','allocation cannot exceed liquidity');
select pg_temp.expect_error($q$select public.financial_allocate_fund(current_setting('test.house')::uuid,0)$q$,'positive cents','zero allocation rejected');
select pg_temp.expect_error($q$select public.financial_allocate_fund(current_setting('test.house')::uuid,1.001)$q$,'positive cents','fractional cents rejected');
select pg_temp.expect_error($q$select public.financial_allocate_fund(current_setting('test.house')::uuid,'NaN'::numeric)$q$,'positive cents','NaN rejected');
select pg_temp.expect_error($q$select public.financial_transfer_fund(current_setting('test.house')::uuid,current_setting('test.other_fund')::uuid,1)$q$,'destination fund unavailable','transfer owner validation');
select pg_temp.assert_true((public.financial_safe_to_spend()->>'reserved_funds_total')::numeric=5000,'failed transfer creates no partial debit');
select public.financial_transfer_fund(current_setting('test.house')::uuid,current_setting('test.emergency')::uuid,1000);
select pg_temp.assert_true((public.financial_safe_to_spend()->>'reserved_funds_total')::numeric=5000 and (public.financial_safe_to_spend()->>'safe_to_spend')::numeric=17200,'virtual transfer preserves reserved total and STS');
select pg_temp.assert_true((select count(*)=2 and sum(amount)=0 from public.fund_entries where entry_type like 'transfer_%'),'transfer has coherent atomic paired entries');
select pg_temp.assert_true((select count(*)=8 from public.transactions),'fund operations create no bank transactions');

-- Force failure on the destination AFTER the debit insertion to verify transaction rollback.
reset role;
create function pg_temp.reject_destination() returns trigger language plpgsql as $$ begin
 if new.entry_type='transfer_in' and new.note='fail_second' then raise exception 'injected destination failure';end if;return new;end $$;
create trigger pr11_test_destination_failure before insert on public.fund_entries for each row execute function pg_temp.reject_destination();
set local role authenticated;
select pg_temp.expect_error($q$select public.financial_transfer_fund(current_setting('test.house')::uuid,current_setting('test.emergency')::uuid,100,'fail_second')$q$,'injected destination failure','destination write failure rolls back transfer');
select pg_temp.assert_true((select count(*)=2 and sum(amount)=0 from public.fund_entries where entry_type like 'transfer_%') and
 (select (value->>'balance')::numeric=4000 from jsonb_array_elements(public.financial_fund_summary()) where value->>'system_key'='house'),'failed second write leaves source and paired audit unchanged');
reset role;drop trigger pr11_test_destination_failure on public.fund_entries;set local role authenticated;

select pg_temp.expect_error($q$update public.financial_funds set is_active=false where id=current_setting('test.house')::uuid$q$,'release funded balance','funded balance cannot be hidden');
select pg_temp.expect_error($q$insert into public.fund_entries(fund_id,amount,entry_type,operation_id) values(current_setting('test.house')::uuid,5000,'allocation',gen_random_uuid())$q$,'permission denied','direct entry insertion denied');
select pg_temp.expect_error($q$update public.fund_entries set amount=99999$q$,'permission denied','entry audit cannot be rewritten');
select pg_temp.expect_error($q$delete from public.fund_entries$q$,'permission denied','entry audit cannot be deleted');
update public.financial_funds set planned_monthly_contribution=1000 where id=current_setting('test.emergency')::uuid;
select pg_temp.assert_true((public.financial_safe_to_spend()->>'emergency_contribution_gap')::numeric=1000,'transfers are not new monthly savings');
select public.financial_allocate_fund(current_setting('test.emergency')::uuid,600);
select pg_temp.assert_true((public.financial_safe_to_spend()->>'emergency_contribution_gap')::numeric=400 and (public.financial_safe_to_spend()->>'safe_to_spend')::numeric=16200,'600 allocated of 1000 reserves only 400');
select public.financial_release_fund(current_setting('test.emergency')::uuid,200);
select pg_temp.assert_true((public.financial_safe_to_spend()->>'emergency_contribution_gap')::numeric=600,'release reinstates monthly gap');
update public.financial_planning_settings set monthly_essential_expenses_target=700;
select pg_temp.assert_true((public.financial_safe_to_spend()->>'emergency_coverage_months')::numeric=2,'explicit expense target gives coverage in months');
insert into public.planned_cash_commitments(name,commitment_type,amount,due_date,start_date,is_essential)
values('Essential','essential',500,current_date,current_date,true),('Other','bill',200,current_date,current_date,false),
 ('Future','other',99999,current_date+40,current_date,false);
select pg_temp.assert_true((public.financial_safe_to_spend()->>'upcoming_essential_commitments')::numeric=500 and (public.financial_safe_to_spend()->>'upcoming_other_commitments')::numeric=200,'essential and other commitments within horizon only');
select pg_temp.assert_true((public.financial_safe_to_spend()->>'safe_to_spend')::numeric=15500,'commitments subtracted once');
update public.financial_planning_settings set commitments_verified_through=current_date-1;
select pg_temp.assert_true(public.financial_safe_to_spend()->>'status'='incomplete' and public.financial_safe_to_spend()->'safe_to_spend_raw'='null'::jsonb,'unverified commitments never present a fake number');
update public.financial_planning_settings set commitments_verified_through=current_date+366;
update public.fiscal_year_settings set liability_schedule_verified=false;
select pg_temp.assert_true(public.financial_safe_to_spend()->'tax_reserve_gap'='null'::jsonb and public.financial_safe_to_spend()->'safe_to_spend'='null'::jsonb,'incomplete fiscal projection blocks STS without fallback');
update public.fiscal_year_settings set liability_schedule_verified=true;
insert into public.planned_cash_commitments(name,commitment_type,amount,due_date,start_date,recurrence,end_date)
values('Month end','insurance',100,'2026-01-31','2026-01-01','monthly','2026-03-31');
select pg_temp.assert_true((public.financial_commitment_summary('2026-02-01','2026-02-28')->>'other')::numeric=100,'monthly 31st clamps to February month end');
select pg_temp.assert_true((public.financial_commitment_summary('2026-03-01','2026-03-31')->>'other')::numeric=100,'monthly clamp does not drift away from original day');
select pg_temp.assert_true((public.financial_commitment_summary('2026-04-01','2026-04-30')->>'other')::numeric=0,'monthly end_date respected');
-- Bank decline never rewrites reserved funds.
insert into public.transactions(account_id,transaction_date,amount,description,transaction_type)
values(current_setting('test.account')::uuid,current_date,-26200,'cash decline','expense');
select pg_temp.assert_true((public.financial_safe_to_spend()->>'total_liquidity')::numeric=4000 and (public.financial_safe_to_spend()->>'reserved_funds_total')::numeric=5400,'bank decline preserves virtual allocations');
select pg_temp.assert_true((public.financial_safe_to_spend()->>'free_liquidity')::numeric=-1400 and (public.financial_safe_to_spend()->>'funds_overallocation_amount')::numeric=1400 and (public.financial_safe_to_spend()->>'funds_overallocated')::boolean,'negative free liquidity and over-allocation deficit');
select pg_temp.assert_true((public.financial_safe_to_spend()->>'safe_to_spend')::numeric=0 and (public.financial_safe_to_spend()->>'safe_to_spend_raw')::numeric=-10700 and (public.financial_safe_to_spend()->>'funding_shortfall')::numeric=10700,'negative raw remains visible, STS clamps at zero with shortfall');
select pg_temp.expect_error($q$select public.financial_allocate_fund(current_setting('test.house')::uuid,1)$q$,'insufficient free liquidity','cannot allocate while overallocated');
select pg_temp.assert_true((select count(*)=0 from public.financial_funds where id=current_setting('test.other_fund')::uuid),'owner A cannot read B funds');
update public.financial_funds set name='Unauthorized' where id=current_setting('test.other_fund')::uuid;
select pg_temp.expect_error($q$insert into public.financial_goals(name,goal_type,target_amount,linked_fund_id) values('Foreign','house',1,current_setting('test.other_fund')::uuid)$q$,'foreign key','cross-owner goal linkage denied');
select pg_temp.expect_error($q$select public.financial_release_fund(current_setting('test.other_fund')::uuid,1)$q$,'source fund unavailable','RPC owner isolation');
select pg_temp.expect_error($q$select public.financial_safe_to_spend(current_date,current_date-1)$q$,'horizon','invalid horizon rejected');
select set_config('request.jwt.claim.sub',current_setting('test.other'),true);
select pg_temp.assert_true((select name='Casa' from public.financial_funds where id=current_setting('test.other_fund')::uuid),'A cannot update B funds');
select pg_temp.assert_true((public.financial_liquidity_summary()->>'total_liquidity')::numeric=0,'zero-liquidity owner');

insert into public.fiscal_year_settings(tax_year,tax_regime,revenue_basis,profitability_coefficient_pct,substitute_tax_rate_pct,
 social_security_scheme,activity_start_date,parameter_period,invoice_semantics,enasarco_treatment,configuration_verified,parameters_status,liability_schedule_verified,source_note)
values(extract(year from current_date)::integer,'forfettario','cash',100,0,'none',current_date-interval '2 years','annual','gross_less_enasarco','not_applicable',true,'confirmed',true,'Synthetic zero-liquidity profile');
insert into public.financial_planning_settings(commitments_verified_through) values(current_date+366);
select pg_temp.assert_true((public.financial_safe_to_spend()->>'safe_to_spend')::numeric=0 and (public.financial_safe_to_spend()->>'funding_shortfall')::numeric=0,'zero liquidity complete model gives real zero');
insert into public.fiscal_year_settings(tax_year,tax_regime,revenue_basis,profitability_coefficient_pct,substitute_tax_rate_pct,
 social_security_scheme,activity_start_date,parameter_period,invoice_semantics,enasarco_treatment,configuration_verified,parameters_status,liability_schedule_verified,year_finalized,source_note)
values(extract(year from current_date)::integer-1,'forfettario','cash',100,0,'none',current_date-interval '3 years','annual','gross_less_enasarco','not_applicable',true,'confirmed',true,true,'Synthetic finalized past year');
select pg_temp.assert_true(public.financial_safe_to_spend((date_trunc('year',current_date)-interval '1 day')::date)->>'status'='confirmed','finalized confirmed fiscal year plus verified horizon yields confirmed');
update public.financial_planning_settings set default_safe_to_spend_horizon=30;
select pg_temp.assert_true((public.financial_safe_to_spend()->>'horizon_end')::date=current_date+30,'server configurable rolling horizon');
insert into public.planned_cash_commitments(name,commitment_type,amount,due_date,start_date,status) values
 ('Completed','bill',100,current_date,current_date,'completed'),('Skipped','bill',100,current_date,current_date,'skipped'),('Cancelled','bill',100,current_date,current_date,'cancelled');
select pg_temp.assert_true((public.financial_safe_to_spend()->>'upcoming_other_commitments')::numeric=0,'completed skipped cancelled commitments excluded');
insert into public.financial_funds(name,planned_monthly_contribution) values('Custom',50);
select pg_temp.assert_true((public.financial_safe_to_spend(current_date,(date_trunc('month',current_date)+interval '2 months - 1 day')::date)->>'goals_contribution_gap')::numeric=100,'custom contribution includes each month touched by multi-month horizon');
select pg_temp.expect_error($q$update public.financial_funds set planned_monthly_contribution=10 where system_key='tax'$q$,'check constraint','tax fund cannot double-count configured contributions');
select pg_temp.expect_error($q$update public.financial_funds set target_amount='NaN'::numeric$q$,'check constraint','non-finite configured target rejected');

set local role anon;
select pg_temp.expect_error('select * from public.financial_funds','permission denied','anon table denied');
select pg_temp.expect_error('select public.financial_safe_to_spend()','permission denied','anon STS RPC denied');
select pg_temp.expect_error('select public.financial_bootstrap_funds()','permission denied','anon bootstrap denied');
reset role;
select pg_temp.assert_true(not exists(select 1 from pg_proc where pronamespace='public'::regnamespace and proname like 'financial_%' and prosecdef),'no public privileged financial RPC');
rollback;
