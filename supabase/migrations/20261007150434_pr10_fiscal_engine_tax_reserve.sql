-- PR10: additive metadata/schema only. No fiscal backfill, amount edits or recomputation writes.
begin;
-- Separate annual profiles avoid guessing the undocumented legacy tax_settings schema/uniqueness.
create table public.fiscal_year_settings (
 user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
 tax_year integer not null check(tax_year between 1900 and 2200),
 tax_regime text check(tax_regime in ('forfettario')),
 revenue_basis text check(revenue_basis in ('cash')),
 profitability_coefficient_pct numeric check(profitability_coefficient_pct between 0 and 100),
 substitute_tax_rate_pct numeric check(substitute_tax_rate_pct between 0 and 100),
 social_security_scheme text check(social_security_scheme in ('inps_merchants','inps_separate','none')),
 ordinary_social_rate_pct numeric check(ordinary_social_rate_pct between 0 and 100),
 minimum_social_income numeric check(minimum_social_income>=0),
 first_social_band numeric check(first_social_band>=0),
 additional_social_rate_pct numeric check(additional_social_rate_pct between 0 and 100),
 maximum_social_income numeric check(maximum_social_income>=0),
 maternity_contribution numeric check(maternity_contribution>=0),
 contribution_reduction_pct numeric check(contribution_reduction_pct between 0 and 100),
 activity_start_date date,
 activity_end_date date,
 parameter_period text check(parameter_period in ('annual','activity_period')),
 invoice_semantics text check(invoice_semantics in ('gross_less_enasarco','gross_with_other_net_adjustments')),
 enasarco_treatment text check(enasarco_treatment in ('not_applicable','withheld_deductible','withheld_not_deductible')),
 configuration_verified boolean not null default false,
 parameters_status text not null default 'estimated' check(parameters_status in ('confirmed','estimated')),
 year_finalized boolean not null default false,
 liability_schedule_verified boolean not null default false,
 source_note text,
 created_at timestamptz not null default now(),updated_at timestamptz not null default now(),
 primary key(user_id,tax_year),
 check(activity_end_date is null or activity_start_date is null or activity_end_date>=activity_start_date)
);

create table public.tax_liability_obligations (
 id uuid primary key default gen_random_uuid(),
 user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
 report_year integer not null check(report_year between 1900 and 2200),
 tax_year integer not null check(tax_year between 1900 and 2200),
 obligation_role text not null check(obligation_role in ('prior_year_balance','current_year_advance','other')),
 payment_kind text not null check(payment_kind in ('substitute_tax_balance','substitute_tax_advance','inps_minimum','inps_balance','inps_advance','other_contributions','other_f24')),
 amount numeric(18,2) not null check(amount>=0),
 due_date date,
 status text not null default 'estimated' check(status in ('confirmed','estimated')),
 description text not null,
 source_note text,
 created_at timestamptz not null default now(),updated_at timestamptz not null default now(),
 check((obligation_role='prior_year_balance' and tax_year<report_year)
  or (obligation_role='current_year_advance' and tax_year=report_year and payment_kind in ('substitute_tax_advance','inps_advance'))
  or (obligation_role='other' and tax_year<=report_year))
);
create index tax_obligations_owner_year_idx on public.tax_liability_obligations(user_id,report_year,tax_year);

alter table public.tax_payments
 add column fiscal_allocation_status text not null default 'unallocated' check(fiscal_allocation_status in ('unallocated','allocated')),
 add column fiscal_tax_year integer check(fiscal_tax_year between 1900 and 2200),
 add column fiscal_payment_kind text check(fiscal_payment_kind in ('substitute_tax_balance','substitute_tax_advance','inps_minimum','inps_balance','inps_advance','other_contributions','other_f24')),
 add column fiscal_payment_date date,
 add column deductible_social_security boolean,
 add column fiscal_obligation_id uuid references public.tax_liability_obligations(id) on delete restrict,
 add column fiscal_allocation_note text;
alter table public.tax_payments add constraint tax_payment_explicit_allocation_check check
 ((fiscal_allocation_status='unallocated' and fiscal_tax_year is null and fiscal_payment_kind is null
    and deductible_social_security is null and fiscal_obligation_id is null)
  or (fiscal_allocation_status='allocated' and fiscal_tax_year is not null and fiscal_payment_kind is not null
    and deductible_social_security is not null
    and (not deductible_social_security or fiscal_payment_kind in ('inps_minimum','inps_balance','inps_advance','other_contributions'))));
create index tax_payments_owner_competence_idx on public.tax_payments(user_id,fiscal_tax_year,fiscal_payment_kind) where fiscal_allocation_status='allocated';
create index tax_payments_obligation_idx on public.tax_payments(fiscal_obligation_id) where fiscal_obligation_id is not null;

alter table public.fiscal_year_settings enable row level security;
alter table public.tax_liability_obligations enable row level security;
revoke all on public.fiscal_year_settings,public.tax_liability_obligations from public,anon,authenticated;
grant select,insert,update,delete on public.fiscal_year_settings,public.tax_liability_obligations to authenticated;
do $$
declare table_name text;
begin
 foreach table_name in array array['fiscal_year_settings','tax_liability_obligations'] loop
  execute format('create policy %I on public.%I for select to authenticated using ((select auth.uid())=user_id)',table_name||'_select_own',table_name);
  execute format('create policy %I on public.%I for insert to authenticated with check ((select auth.uid())=user_id)',table_name||'_insert_own',table_name);
  execute format('create policy %I on public.%I for update to authenticated using ((select auth.uid())=user_id) with check ((select auth.uid())=user_id)',table_name||'_update_own',table_name);
  execute format('create policy %I on public.%I for delete to authenticated using ((select auth.uid())=user_id)',table_name||'_delete_own',table_name);
 end loop;
end $$;
create trigger fiscal_settings_updated_at before update on public.fiscal_year_settings for each row execute function public.set_ledger_updated_at();
create trigger tax_obligations_updated_at before update on public.tax_liability_obligations for each row execute function public.set_ledger_updated_at();
create function public.validate_fiscal_payment_link() returns trigger language plpgsql security invoker set search_path='' as $$
begin
 if new.fiscal_obligation_id is not null and not exists(select 1 from public.tax_liability_obligations
   where id=new.fiscal_obligation_id and user_id=new.user_id and tax_year=new.fiscal_tax_year and payment_kind=new.fiscal_payment_kind)
 then raise exception 'fiscal obligation must match payment owner, competence and kind'; end if;
 return new;
end $$;
revoke all on function public.validate_fiscal_payment_link() from public,anon,authenticated;
create trigger tax_payments_validate_fiscal_link before insert or update on public.tax_payments for each row execute function public.validate_fiscal_payment_link();
-- A linked obligation cannot silently change its competence/kind/owner.
create function public.validate_linked_fiscal_obligation() returns trigger language plpgsql security invoker set search_path='' as $$
begin
 if row(new.user_id,new.tax_year,new.payment_kind) is distinct from row(old.user_id,old.tax_year,old.payment_kind)
  and exists(select 1 from public.tax_payments where fiscal_obligation_id=old.id) then
  raise exception 'unlink payments before changing obligation competence or kind'; end if;
 return new;
end $$;
revoke all on function public.validate_linked_fiscal_obligation() from public,anon,authenticated;
create trigger tax_obligations_validate_link before update on public.tax_liability_obligations for each row execute function public.validate_linked_fiscal_obligation();

-- Safe adapters for legacy rows; malformed/missing values stay NULL, never an invented zero/date.
create function public.fiscal_numeric(value text) returns numeric language plpgsql immutable security invoker set search_path='' as $$
begin
 if value is null or value !~ '^-?[0-9]+([.][0-9]+)?$' or length(value)>40 then return null; end if;
 return value::numeric;
exception when numeric_value_out_of_range then return null;
end $$;
create function public.fiscal_date(value text) returns date language plpgsql immutable security invoker set search_path='' as $$
begin
 if value is null or value !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}($|T| )' then return null; end if;
 return substring(value from 1 for 10)::date;
exception when datetime_field_overflow or invalid_datetime_format then return null;
end $$;
create function public.fiscal_payment_family(kind text) returns text language sql immutable security invoker set search_path='' as $$
 select case when kind in ('substitute_tax_balance','substitute_tax_advance') then 'substitute_tax'
  when kind='inps_minimum' then 'social_minimum'
  when kind in ('inps_balance','inps_advance') then 'social_variable' else kind end
$$;
revoke all on function public.fiscal_numeric(text),public.fiscal_date(text),public.fiscal_payment_family(text) from public,anon;
grant execute on function public.fiscal_numeric(text),public.fiscal_date(text),public.fiscal_payment_family(text) to authenticated;

create function public.financial_tax_summary(target_year integer, as_of date default current_date)
returns jsonb language plpgsql stable security invoker set search_path='' as $$
declare
 profile public.fiscal_year_settings; missing text[]:='{}'; warnings text[]:='{}'; field_key text;
 year_start date; year_end date; cutoff date; activity_from date; activity_to date; partial_activity boolean;
 revenue_invoiced numeric:=0; revenue_collected numeric:=0; taxable_revenue numeric:=0; receivables numeric:=0;
 enasarco_withheld numeric:=0; enasarco_deductible numeric:=0; deductible_paid numeric:=0; deductible_applied numeric;
 forfettario_income numeric; tax_base numeric; substitute_due numeric; social_due numeric;
 social_minimum numeric; social_variable numeric; capped_social_income numeric; maternity numeric;
 social_paid numeric:=0; substitute_paid numeric:=0; allocated_amount numeric:=0; unallocated_amount numeric:=0;
 invoice_errors integer; payment_errors integer; unallocated_count integer; current_issued_net numeric:=0; current_issued_enasarco numeric:=0;
 total_liability numeric; already_paid numeric; future_obligations numeric; prior_balance numeric; advances numeric;
 schedule jsonb:='[]'; projection_state text; schedule_estimated boolean:=false;
begin
 if auth.uid() is null then raise exception 'authentication required'; end if;
 if target_year is null or target_year not between 1900 and 2200 or as_of is null then raise exception 'invalid fiscal year or date'; end if;
 year_start:=make_date(target_year,1,1);year_end:=make_date(target_year,12,31);cutoff:=least(as_of,current_date,year_end);
 select * into profile from public.fiscal_year_settings where user_id=(select auth.uid()) and tax_year=target_year;
 if profile.user_id is null then missing:=array_append(missing,'annual_fiscal_profile');
 else
  foreach field_key in array array['tax_regime','revenue_basis','profitability_coefficient_pct','substitute_tax_rate_pct',
    'social_security_scheme','activity_start_date','parameter_period','invoice_semantics','enasarco_treatment','source_note'] loop
   if nullif(btrim(to_jsonb(profile)->>field_key),'') is null then missing:=array_append(missing,field_key); end if;
  end loop;
  if profile.social_security_scheme<>'none' then
   foreach field_key in array array['ordinary_social_rate_pct','maximum_social_income','contribution_reduction_pct','maternity_contribution'] loop
    if to_jsonb(profile)->>field_key is null then missing:=array_append(missing,field_key); end if;
   end loop;
  end if;
  if profile.social_security_scheme='inps_merchants' then
   foreach field_key in array array['minimum_social_income','first_social_band','additional_social_rate_pct'] loop
    if to_jsonb(profile)->>field_key is null then missing:=array_append(missing,field_key); end if;
   end loop;
   if profile.minimum_social_income>profile.first_social_band or profile.first_social_band>profile.maximum_social_income then
    missing:=array_append(missing,'social_threshold_order'); end if;
  end if;
  if profile.social_security_scheme='inps_separate' and profile.contribution_reduction_pct<>0 then missing:=array_append(missing,'unsupported_separate_reduction'); end if;
  activity_from:=greatest(profile.activity_start_date,year_start); activity_to:=least(coalesce(profile.activity_end_date,year_end),year_end);
  partial_activity:=activity_from>year_start or activity_to<year_end;
  if partial_activity and profile.parameter_period is distinct from 'activity_period' then missing:=array_append(missing,'activity_period_parameters'); end if;
  if not profile.liability_schedule_verified then missing:=array_append(missing,'liability_schedule_verification'); end if;
  if not profile.configuration_verified then warnings:=array_append(warnings,'profile_not_verified'); end if;
 end if;

 -- Issued-year totals are distinct from collected-year cash basis, including cross-year collections.
 with rows as (select to_jsonb(i) j from public.invoices i where user_id=(select auth.uid())),
 parsed as (select j,public.fiscal_numeric(j->>'lordo') gross,public.fiscal_numeric(j->>'netto') net,
  public.fiscal_numeric(j->>'enasarco') enasarco,public.fiscal_date(j->>'data') issued,
  public.fiscal_date(j->>'data_incasso') collected,
  case when j->>'incassata' in ('true','false') then (j->>'incassata')::boolean end paid,
  public.fiscal_numeric(j->>'anno') legacy_year from rows),
 relevant as (select *,coalesce(extract(year from issued),legacy_year)=target_year in_year,
  paid and collected between year_start and cutoff cash_in_year from parsed)
 select coalesce(sum(gross) filter(where in_year and (issued<=cutoff or issued is null)),0),coalesce(sum(net) filter(where cash_in_year),0),
  coalesce(sum(gross) filter(where cash_in_year),0),coalesce(sum(enasarco) filter(where cash_in_year),0),
  coalesce(sum(net) filter(where issued<=cutoff and (not paid or collected>cutoff)),0),
  coalesce(sum(net) filter(where in_year and (issued<=cutoff or issued is null)),0),coalesce(sum(enasarco) filter(where in_year and (issued<=cutoff or issued is null)),0),
  count(*) filter(where (issued<=cutoff or in_year or cash_in_year) and (
    gross is null or net is null or enasarco is null or issued is null or paid is null
    or (paid and collected is null) or (paid and collected<issued)
    or (profile.invoice_semantics='gross_less_enasarco' and abs(gross-enasarco-net)>0.01)
    or (profile.enasarco_treatment='not_applicable' and enasarco<>0)
    or (gross>0 and (enasarco<0 or enasarco>gross or net<0))
    or (gross<0 and (enasarco>0 or net>0))))
 into revenue_invoiced,revenue_collected,taxable_revenue,enasarco_withheld,receivables,current_issued_net,current_issued_enasarco,invoice_errors from relevant;
 if invoice_errors>0 then missing:=array_append(missing,'invoice_cash_dates_or_amount_semantics'); end if;
 if profile.enasarco_treatment='withheld_deductible' then enasarco_deductible:=greatest(enasarco_withheld,0); end if;
 if taxable_revenue<0 then warnings:=array_append(warnings,'net_credit_note_revenue'); end if;

 with rows as (select p.*,to_jsonb(p) j from public.tax_payments p where user_id=(select auth.uid())),
 parsed as (select *,public.fiscal_numeric(j->>'importo') paid_amount,
  coalesce(fiscal_payment_date,public.fiscal_date(j->>'data')) paid_date,public.fiscal_numeric(j->>'anno') legacy_year from rows)
 select coalesce(sum(paid_amount) filter(where fiscal_allocation_status='allocated' and deductible_social_security and paid_date between year_start and cutoff),0),
  coalesce(sum(paid_amount) filter(where fiscal_allocation_status='allocated' and fiscal_tax_year=target_year and paid_date<=cutoff and fiscal_payment_kind in ('inps_minimum','inps_balance','inps_advance')),0),
  coalesce(sum(paid_amount) filter(where fiscal_allocation_status='allocated' and fiscal_tax_year=target_year and paid_date<=cutoff and fiscal_payment_kind in ('substitute_tax_balance','substitute_tax_advance')),0),
  coalesce(sum(paid_amount) filter(where fiscal_allocation_status='allocated' and paid_date between year_start and cutoff),0),
  coalesce(sum(paid_amount) filter(where fiscal_allocation_status='unallocated' and (paid_date between year_start and cutoff or (paid_date is null and legacy_year=target_year))),0),
  count(*) filter(where fiscal_allocation_status='unallocated' and (paid_date between year_start and cutoff or (paid_date is null and (legacy_year=target_year or legacy_year is null)))),
  count(*) filter(where (fiscal_tax_year=target_year or paid_date between year_start and cutoff or paid_date is null)
    and (paid_amount is null or paid_amount<0 or (fiscal_allocation_status='allocated' and paid_date is null)))
 into deductible_paid,social_paid,substitute_paid,allocated_amount,unallocated_amount,unallocated_count,payment_errors from parsed;
 if unallocated_count>0 then missing:=array_append(missing,'unallocated_tax_payments'); end if;
 if payment_errors>0 then missing:=array_append(missing,'payment_dates_or_amounts'); end if;
 -- Explicit confirmation avoids counting an ENASARCO withholding both in invoices and other-contribution F24.
 if profile.enasarco_treatment='withheld_deductible' and exists(select 1 from public.tax_payments p where p.user_id=auth.uid()
  and p.fiscal_allocation_status='allocated' and p.fiscal_payment_kind='other_contributions' and p.deductible_social_security
  and coalesce(p.fiscal_payment_date,public.fiscal_date(to_jsonb(p)->>'data')) between year_start and cutoff
  and nullif(btrim(p.fiscal_allocation_note),'') is null) then missing:=array_append(missing,'other_contribution_deduction_note'); end if;

 -- Missing profile parameters produce NULL fiscal numbers, not legacy/default guesses.
 if profile.user_id is not null and profile.profitability_coefficient_pct is not null and profile.substitute_tax_rate_pct is not null then
  forfettario_income:=round(greatest(taxable_revenue,0)*profile.profitability_coefficient_pct/100,2);
  deductible_applied:=least(forfettario_income,greatest(deductible_paid+enasarco_deductible,0));
  tax_base:=greatest(forfettario_income-deductible_applied,0);
  substitute_due:=round(tax_base*profile.substitute_tax_rate_pct/100,2);
  if profile.social_security_scheme='none' then social_minimum:=0;social_variable:=0;maternity:=0;
  elsif profile.social_security_scheme='inps_merchants' and profile.minimum_social_income is not null
    and profile.first_social_band is not null and profile.maximum_social_income is not null
    and profile.ordinary_social_rate_pct is not null and profile.additional_social_rate_pct is not null
    and profile.contribution_reduction_pct is not null and profile.maternity_contribution is not null then
   capped_social_income:=least(greatest(forfettario_income,profile.minimum_social_income),profile.maximum_social_income);
   maternity:=profile.maternity_contribution;
   social_minimum:=round(profile.minimum_social_income*profile.ordinary_social_rate_pct/100*(1-profile.contribution_reduction_pct/100)+maternity,2);
   social_variable:=round((greatest(capped_social_income-profile.minimum_social_income,0)*profile.ordinary_social_rate_pct/100
     +greatest(capped_social_income-profile.first_social_band,0)*profile.additional_social_rate_pct/100)*(1-profile.contribution_reduction_pct/100),2);
  elsif profile.social_security_scheme='inps_separate' and profile.maximum_social_income is not null and profile.ordinary_social_rate_pct is not null
    and profile.maternity_contribution is not null and profile.contribution_reduction_pct=0 then
   maternity:=profile.maternity_contribution;social_minimum:=maternity;
   social_variable:=round(least(forfettario_income,profile.maximum_social_income)*profile.ordinary_social_rate_pct/100,2);
  end if;
  if activity_to<activity_from and taxable_revenue<>0 then missing:=array_append(missing,'income_outside_activity_period'); end if;
  if activity_to<activity_from and taxable_revenue=0 then social_minimum:=0;social_variable:=0;maternity:=0; end if;
  social_due:=social_minimum+social_variable;
 end if;

 if social_due is not null and substitute_due is not null then
  -- Explicit cash obligations replace (never add twice to) the matching annual family estimate.
  -- Virtual undated rows hold the remainder. Prior balances require explicit owner input.
  with explicit as (select o.*,public.fiscal_payment_family(o.payment_kind) family from public.tax_liability_obligations o
    where o.user_id=(select auth.uid()) and o.report_year=target_year),
  annual as (select * from (values('substitute_tax',substitute_due,'substitute_tax_balance'),('social_minimum',social_minimum,'inps_minimum'),('social_variable',social_variable,'inps_balance')) v(family,amount,kind)),
  liabilities as (
   select id::text key,tax_year,payment_kind,family,obligation_role,amount,due_date,status,description from explicit
   union all select 'annual:'||a.family,target_year,a.kind,a.family,'annual_estimate',
    greatest(a.amount-coalesce((select sum(amount) from explicit e where e.tax_year=target_year and e.family=a.family),0),0),
    null,'estimated','Residuo stima annuale' from annual a),
  payments as (select p.*,public.fiscal_numeric(to_jsonb(p)->>'importo') amount,
    public.fiscal_payment_family(p.fiscal_payment_kind) family from public.tax_payments p where p.user_id=(select auth.uid())
    and public.fiscal_numeric(to_jsonb(p)->>'importo')>=0
    and p.fiscal_allocation_status='allocated' and coalesce(p.fiscal_payment_date,public.fiscal_date(to_jsonb(p)->>'data'))<=cutoff),
  linked as (select l.*,least(l.amount,coalesce((select sum(p.amount) from payments p where p.fiscal_obligation_id::text=l.key),0)) linked_paid from liabilities l),
  ranked as (select l.*,coalesce(sum(amount-linked_paid) over(partition by tax_year,family order by due_date nulls last,key
    rows between unbounded preceding and 1 preceding),0) earlier_remaining,
    coalesce((select sum(p.amount) from payments p where p.fiscal_obligation_id is null and p.fiscal_tax_year=l.tax_year and p.family=l.family),0) pool from linked l),
  covered as (select *,least(amount-linked_paid,greatest(pool-earlier_remaining,0)) pooled_paid from ranked),
  final as (select *,greatest(amount-linked_paid-pooled_paid,0) remaining from covered)
  select coalesce(sum(amount),0),coalesce(sum(linked_paid+pooled_paid),0),coalesce(sum(remaining),0),
    coalesce(sum(remaining) filter(where obligation_role='prior_year_balance'),0),
    coalesce(sum(remaining) filter(where obligation_role='current_year_advance'),0),
    coalesce(jsonb_agg(jsonb_build_object('key',key,'tax_year',tax_year,'payment_kind',payment_kind,'role',obligation_role,
      'amount',amount,'paid',linked_paid+pooled_paid,'remaining',remaining,'due_date',due_date,'status',status,'description',description)
      order by due_date nulls last,key) filter(where amount>0),'[]'::jsonb),
    coalesce(bool_or(status='estimated' and obligation_role<>'annual_estimate'),false)
   into total_liability,already_paid,future_obligations,prior_balance,advances,schedule,schedule_estimated from final;
 end if;
 if cardinality(missing)>0 then projection_state:='incomplete';
 elsif profile.configuration_verified and profile.parameters_status='confirmed' and profile.year_finalized
    and cutoff=year_end and current_date>=year_end and not schedule_estimated and cardinality(warnings)=0 then projection_state:='confirmed';
 else projection_state:='estimated'; end if;
 if projection_state='incomplete' then future_obligations:=null; end if;
 return jsonb_build_object('tax_year',target_year,'as_of',cutoff,'projection_status',projection_state,'tax_projection_status',projection_state,
  'calculated_at',now(),'missing_fields',to_jsonb(missing),'warnings',to_jsonb(warnings),
  'revenue_invoiced',round(revenue_invoiced,2),'revenue_collected',round(revenue_collected,2),'taxable_revenue',round(taxable_revenue,2),
  'receivables_uncollected',round(receivables,2),'net_invoiced',round(current_issued_net,2),'enasarco_invoiced',round(current_issued_enasarco,2),
  'enasarco_withheld',round(enasarco_withheld,2),'deductible_enasarco_withheld',round(enasarco_deductible,2),
  'forfettario_income',forfettario_income,'social_security_due_estimated',social_due,
  'social_security_minimum_due',social_minimum,'social_security_variable_due',social_variable,'maternity_due',maternity,
  'social_security_paid',round(social_paid,2),'deductible_social_security_paid',round(deductible_paid,2),
  'deductible_contributions_applied',deductible_applied,'substitute_tax_base',tax_base,
  'substitute_tax_due_estimated',substitute_due,'substitute_tax_paid',round(substitute_paid,2),
  'prior_year_balance_due',prior_balance,'current_year_advances_due',advances,'total_tax_liability',total_liability,
  'already_paid',already_paid,'allocated_payments_cash_year',round(allocated_amount,2),'unallocated_payments',round(unallocated_amount,2),
  'unallocated_payment_count',unallocated_count,'future_obligations',future_obligations,
  'required_tax_reserve',future_obligations,'tax_reserve_required',future_obligations,
  'reserved_tax_amount',null,'tax_reserve_gap',null,'schedule',schedule);
end $$;
revoke all on function public.financial_tax_summary(integer,date) from public,anon;
grant execute on function public.financial_tax_summary(integer,date) to authenticated;
commit;
