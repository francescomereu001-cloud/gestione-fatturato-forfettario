-- PR11 depends on PR6 -> PR9 -> PR10. Additive planning layer; no bank ledger writes.
begin;
create schema if not exists financial_private;
revoke all on schema financial_private from public,anon;
grant usage on schema financial_private to authenticated;
create table public.financial_funds (
 id uuid primary key default gen_random_uuid(),user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
 system_key text check(system_key in ('tax','emergency','house','investments','large_purchases')),
 name text not null check(length(trim(name))>0),target_amount numeric(18,2) check(target_amount>0 and target_amount::text<>'NaN'),target_date date,
 planned_monthly_contribution numeric(18,2) check(planned_monthly_contribution>=0 and planned_monthly_contribution::text<>'NaN'),priority integer not null default 0,
 is_active boolean not null default true,created_at timestamptz not null default now(),updated_at timestamptz not null default now(),
 unique(user_id,id),unique(user_id,system_key),
 check(system_key is distinct from 'tax' or coalesce(planned_monthly_contribution,0)=0)
);
create table public.fund_entries (
 id uuid primary key default gen_random_uuid(),user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
 fund_id uuid not null,amount numeric(18,2) not null check(amount<>0 and amount::text<>'NaN'),effective_date date not null default current_date,
 entry_type text not null check(entry_type in ('allocation','release','transfer_in','transfer_out','adjustment')),
 note text,source text not null default 'manual',operation_id uuid not null,
 created_at timestamptz not null default now(),foreign key(user_id,fund_id) references public.financial_funds(user_id,id) on delete restrict,
 check((entry_type in ('allocation','transfer_in') and amount>0) or (entry_type in ('release','transfer_out') and amount<0) or entry_type='adjustment')
);
create index fund_entries_owner_fund_date_idx on public.fund_entries(user_id,fund_id,effective_date);
create table public.financial_goals (
 id uuid primary key default gen_random_uuid(),user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
 name text not null check(length(trim(name))>0),goal_type text not null check(goal_type in ('emergency','house','investment','purchase','custom')),
 target_amount numeric(18,2) not null check(target_amount>0 and target_amount::text<>'NaN'),target_date date,linked_fund_id uuid,priority integer not null default 0,
 status text not null default 'active' check(status in ('active','paused','achieved','cancelled')),
 created_at timestamptz not null default now(),updated_at timestamptz not null default now(),
 foreign key(user_id,linked_fund_id) references public.financial_funds(user_id,id) on delete restrict
);
create index financial_goals_owner_idx on public.financial_goals(user_id);
create unique index financial_goals_one_active_fund_idx on public.financial_goals(user_id,linked_fund_id) where status='active' and linked_fund_id is not null;
create table public.planned_cash_commitments (
 id uuid primary key default gen_random_uuid(),user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
 name text not null check(length(trim(name))>0),commitment_type text not null check(commitment_type in ('essential','debt_payment','bill','insurance','tax_other','other')),
 amount numeric(18,2) not null check(amount>0 and amount::text<>'NaN'),due_date date not null,recurrence text not null default 'once' check(recurrence in ('once','monthly')),
 start_date date not null,end_date date,is_essential boolean not null default false,
 status text not null default 'active' check(status in ('active','completed','skipped','cancelled')),note text,
 created_at timestamptz not null default now(),updated_at timestamptz not null default now(),
 check(due_date>=start_date),check(end_date is null or end_date>=due_date)
);
create index cash_commitments_owner_idx on public.planned_cash_commitments(user_id,status);
create table public.financial_planning_settings (
 user_id uuid primary key default auth.uid() references auth.users(id) on delete cascade,
 commitments_verified_through date,
 -- 0 = calendar month end; positive = rolling number of days, bounded to one year.
 default_safe_to_spend_horizon integer not null default 0 check(default_safe_to_spend_horizon between 0 and 366),
 monthly_essential_expenses_target numeric(18,2) check(monthly_essential_expenses_target>0 and monthly_essential_expenses_target::text<>'NaN'),
 updated_at timestamptz not null default now()
);
-- Entries are immutable and cannot be directly inserted through the Data API.
do $$ declare t text;begin
 foreach t in array array['financial_funds','fund_entries','financial_goals','planned_cash_commitments','financial_planning_settings'] loop
  execute format('alter table public.%I enable row level security',t);
  execute format('revoke all on public.%I from public,anon,authenticated',t);
  execute format('grant select on public.%I to authenticated',t);
  execute format('create policy %I on public.%I for select to authenticated using ((select auth.uid())=user_id)',t||'_select_own',t);
  if t<>'fund_entries' then
   execute format('grant insert,update on public.%I to authenticated',t);
   execute format('create policy %I on public.%I for insert to authenticated with check ((select auth.uid())=user_id)',t||'_insert_own',t);
   execute format('create policy %I on public.%I for update to authenticated using ((select auth.uid())=user_id) with check ((select auth.uid())=user_id)',t||'_update_own',t);
   execute format('create trigger %I before update on public.%I for each row execute function public.set_ledger_updated_at()',t||'_updated_at',t);
  end if;
 end loop;
end $$;
-- Metadata changes share the fund mutation lock; a funded reserve cannot be hidden by deactivation.
create function financial_private.guard_fund() returns trigger language plpgsql security invoker set search_path='' as $$
begin
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(new.user_id::text,11));
 if new.user_id<>old.user_id or new.system_key is distinct from old.system_key then raise exception 'fund owner and system key are immutable';end if;
 if not new.is_active and exists(select 1 from public.fund_entries where fund_id=new.id and user_id=new.user_id group by fund_id having sum(amount)<>0) then
  raise exception 'release funded balance before deactivating';end if;
 return new;
end $$;
revoke all on function financial_private.guard_fund() from public,anon,authenticated;
create trigger financial_funds_guard before update on public.financial_funds for each row execute function financial_private.guard_fund();
create function public.financial_bootstrap_funds() returns void language sql security invoker set search_path='' as $$
 insert into public.financial_funds(system_key,name) values
 ('tax','Fiscale'),('emergency','Emergenza'),('house','Casa'),('investments','Investimenti'),('large_purchases','Grandi acquisti')
 on conflict(user_id,system_key) do nothing;
$$;
create function public.financial_liquidity_summary(as_of date default current_date) returns jsonb
language sql stable security invoker set search_path='' as $$
 with balances as (
 select a.id,a.name,a.currency,a.balance_as_of,
 a.opening_balance+coalesce(sum(t.amount) filter(where t.reconciliation_status<>'ignored'
 and coalesce(t.booking_date,t.transaction_date)<=as_of
 and (a.balance_as_of is null or coalesce(t.booking_date,t.transaction_date)>a.balance_as_of)),0) balance
 from public.accounts a left join public.transactions t on t.account_id=a.id and t.user_id=a.user_id
 where a.user_id=(select auth.uid()) and a.is_active and a.include_in_liquidity group by a.id
 ) select jsonb_build_object('as_of',as_of,'total_liquidity',coalesce(sum(balance),0),
 'accounts',coalesce(jsonb_agg(to_jsonb(balances)),'[]'::jsonb),
 'missing_fields',coalesce(jsonb_agg('account_anchor_after_as_of:'||id) filter(where balance_as_of>as_of),'[]'::jsonb),
 'warnings',coalesce(jsonb_agg('unsupported_currency:'||id) filter(where currency<>'EUR'),'[]'::jsonb)) from balances;
$$;
create function public.financial_fund_summary(as_of date default current_date) returns jsonb
language sql stable security invoker set search_path='' as $$
 with funds as (
 select f.*,coalesce(sum(e.amount) filter(where e.effective_date<=as_of),0) balance,
 greatest(coalesce(sum(e.amount) filter(where e.effective_date between date_trunc('month',as_of)::date and as_of
 and e.entry_type in ('allocation','release')),0),0) allocations_this_month
 from public.financial_funds f left join public.fund_entries e on e.fund_id=f.id and e.user_id=f.user_id
 where f.user_id=(select auth.uid()) group by f.id
 ),metrics as (
 select funds.*,case when target_amount>0 then round(balance/target_amount*100,2) end progress_percentage,
 case when is_active and system_key is distinct from 'tax' then greatest(coalesce(planned_monthly_contribution,0)-allocations_this_month,0) else 0 end contribution_gap
 from funds
 ) select coalesce(jsonb_agg(to_jsonb(metrics) order by priority desc,name),'[]'::jsonb) from metrics;
$$;
create function public.financial_goal_summary(as_of date default current_date) returns jsonb
language sql stable security invoker set search_path='' as $$
 with funds as (select * from jsonb_to_recordset(public.financial_fund_summary(as_of)) as x(id uuid,name text,balance numeric)),
 metrics as (select g.*,f.name linked_fund_name,coalesce(f.balance,0) current_amount,
 greatest(g.target_amount-coalesce(f.balance,0),0) remaining_amount,
 round(coalesce(f.balance,0)/g.target_amount*100,2) progress_percentage,
 g.target_date-as_of days_remaining from public.financial_goals g left join funds f on f.id=g.linked_fund_id
 where g.user_id=(select auth.uid()))
 select coalesce(jsonb_agg(to_jsonb(metrics)||jsonb_build_object('required_monthly_pace',case
 when status<>'active' or target_date is null then null
 when remaining_amount=0 then 0
 when days_remaining<=0 then null
 else round(remaining_amount/greatest(days_remaining/30.4375,1),2) end) order by priority desc,name),'[]'::jsonb) from metrics;
$$;
-- The only privileged writer is private, necessary because entries have SELECT-only grants.
-- It explicitly scopes every query to auth.uid(), validates all arguments and never touches the ledger.
create function financial_private.move_funds(action text,source_fund uuid,destination_fund uuid,amount numeric,note text)
returns uuid language plpgsql volatile security definer set search_path='' as $$
declare owner_id uuid:=auth.uid();op uuid:=gen_random_uuid();available numeric;source_balance numeric;liquidity jsonb;
begin
 if owner_id is null then raise exception 'authentication required';end if;
 if action not in ('allocate','release','transfer') or action is null then raise exception 'invalid fund action';end if;
 if amount is null or amount<=0 or amount<>round(amount,2) or amount::text in ('NaN','Infinity','-Infinity') then raise exception 'amount must be positive cents';end if;
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(owner_id::text,11));
 if action in ('release','transfer') and not exists(select 1 from public.financial_funds where id=source_fund and user_id=owner_id and is_active) then raise exception 'source fund unavailable';end if;
 if action in ('allocate','transfer') and not exists(select 1 from public.financial_funds where id=destination_fund and user_id=owner_id and is_active) then raise exception 'destination fund unavailable';end if;
 if action='transfer' and source_fund=destination_fund then raise exception 'different funds required';end if;
 if action='allocate' then
  liquidity:=public.financial_liquidity_summary(current_date);
  if jsonb_array_length(liquidity->'missing_fields')>0 or jsonb_array_length(liquidity->'warnings')>0 then raise exception 'liquidity unavailable';end if;
  select (liquidity->>'total_liquidity')::numeric-coalesce(sum(e.amount),0) into available
   from public.fund_entries e join public.financial_funds f on f.id=e.fund_id and f.user_id=e.user_id
   where e.user_id=owner_id and f.is_active and e.effective_date<=current_date;
  if amount>available then raise exception 'insufficient free liquidity';end if;
 else
  select coalesce(sum(e.amount),0) into source_balance from public.fund_entries e where e.user_id=owner_id and e.fund_id=source_fund and e.effective_date<=current_date;
  if amount>source_balance then raise exception 'insufficient fund balance';end if;
 end if;
 if action in ('release','transfer') then
  insert into public.fund_entries(user_id,fund_id,amount,entry_type,note,operation_id) values(owner_id,source_fund,-amount,case when action='release' then 'release' else 'transfer_out' end,note,op);
 end if;
 if action in ('allocate','transfer') then
  insert into public.fund_entries(user_id,fund_id,amount,entry_type,note,operation_id) values(owner_id,destination_fund,amount,case when action='allocate' then 'allocation' else 'transfer_in' end,note,op);
 end if;
 return op;
end $$;
alter function financial_private.move_funds(text,uuid,uuid,numeric,text) owner to postgres;
revoke all on function financial_private.move_funds(text,uuid,uuid,numeric,text) from public,anon,authenticated;
grant execute on function financial_private.move_funds(text,uuid,uuid,numeric,text) to authenticated;
create function public.financial_allocate_fund(fund_id uuid,amount numeric,note text default null) returns uuid
language sql volatile security invoker set search_path='' as $$ select financial_private.move_funds('allocate',null,fund_id,amount,note) $$;
create function public.financial_release_fund(fund_id uuid,amount numeric,note text default null) returns uuid
language sql volatile security invoker set search_path='' as $$ select financial_private.move_funds('release',fund_id,null,amount,note) $$;
create function public.financial_transfer_fund(source_fund uuid,destination_fund uuid,amount numeric,note text default null) returns uuid
language sql volatile security invoker set search_path='' as $$ select financial_private.move_funds('transfer',source_fund,destination_fund,amount,note) $$;
create function public.financial_commitment_summary(as_of date,horizon_end date) returns jsonb
language sql stable security invoker set search_path='' as $$
 with occurrences as (
 select c.*,c.due_date occurrence_date from public.planned_cash_commitments c
 where c.user_id=(select auth.uid()) and c.status='active' and c.recurrence='once'
 union all
 select c.*,(m.month+ (least(extract(day from c.due_date)::integer,
 extract(day from (m.month+interval '1 month - 1 day'))::integer)-1)*interval '1 day')::date
 from public.planned_cash_commitments c cross join lateral
 generate_series(date_trunc('month',greatest(as_of,c.due_date)),date_trunc('month',horizon_end),interval '1 month') m(month)
 where c.user_id=(select auth.uid()) and c.status='active' and c.recurrence='monthly'
 ) select jsonb_build_object('essential',coalesce(sum(amount) filter(where is_essential or commitment_type='essential'),0),
 'other',coalesce(sum(amount) filter(where not is_essential and commitment_type<>'essential'),0),
 'occurrences',coalesce(jsonb_agg(to_jsonb(occurrences) order by occurrence_date),'[]'::jsonb))
 from occurrences where occurrence_date between as_of and horizon_end and occurrence_date>=start_date
 and (end_date is null or occurrence_date<=end_date);
$$;
create function public.financial_safe_to_spend(as_of date default current_date,horizon_end date default null)
returns jsonb language plpgsql stable security invoker set search_path='' as $$
declare settings public.financial_planning_settings;finish date;liquidity jsonb;funds jsonb;tax jsonb;commitments jsonb;
 reserved numeric;tax_balance numeric;emergency numeric;house numeric;free numeric;required numeric;gap numeric;
 emergency_gap numeric;investment_gap numeric;goal_gap numeric;contributions numeric;raw numeric;missing jsonb:='[]';warnings jsonb:='[]';result_status text;
begin
 if auth.uid() is null then raise exception 'authentication required';end if;
 if as_of is null then raise exception 'as_of required';end if;
 select * into settings from public.financial_planning_settings where user_id=(select auth.uid());
 finish:=coalesce(horizon_end,case when coalesce(settings.default_safe_to_spend_horizon,0)=0
 then (date_trunc('month',as_of)+interval '1 month - 1 day')::date else as_of+settings.default_safe_to_spend_horizon end);
 if finish<as_of or finish>as_of+366 then raise exception 'horizon must be within 366 days after as_of';end if;
 liquidity:=public.financial_liquidity_summary(as_of);funds:=public.financial_fund_summary(as_of);
 tax:=public.financial_tax_summary(extract(year from as_of)::integer,as_of);
 commitments:=public.financial_commitment_summary(as_of,finish);
 select coalesce(sum(balance) filter(where is_active),0),coalesce(sum(balance) filter(where system_key='tax'),0),
 coalesce(sum(balance) filter(where system_key='emergency'),0),coalesce(sum(balance) filter(where system_key='house'),0)
 into reserved,tax_balance,emergency,house from jsonb_to_recordset(funds) x(balance numeric,is_active boolean,system_key text);
 -- Current-month net allocations/releases satisfy contributions; virtual transfers do not create new savings.
 with gaps as (
 select x.system_key,greatest(coalesce(x.planned_monthly_contribution,0)-case when m.month=date_trunc('month',as_of) then x.allocations_this_month else 0 end,0) amount
 from jsonb_to_recordset(funds) x(system_key text,is_active boolean,planned_monthly_contribution numeric,allocations_this_month numeric)
 cross join generate_series(date_trunc('month',as_of),date_trunc('month',finish),interval '1 month') m(month)
 where x.is_active and x.system_key is distinct from 'tax'
 ) select coalesce(sum(amount) filter(where system_key='emergency'),0),coalesce(sum(amount) filter(where system_key='investments'),0),
 coalesce(sum(amount) filter(where system_key is null or system_key not in ('emergency','investments')),0) into emergency_gap,investment_gap,goal_gap from gaps;
 contributions:=emergency_gap+investment_gap+goal_gap;free:=(liquidity->>'total_liquidity')::numeric-reserved;
 required:=(tax->>'required_tax_reserve')::numeric;gap:=greatest(required-tax_balance,0);
 if tax->>'projection_status'='incomplete' or required is null then
  missing:=missing||jsonb_build_array('tax_projection')||coalesce(tax->'missing_fields','[]');gap:=null;
 end if;
 if settings.commitments_verified_through is null or settings.commitments_verified_through<finish then missing:=missing||jsonb_build_array('commitments_verified_through');end if;
 missing:=missing||coalesce(liquidity->'missing_fields','[]');
 if jsonb_array_length(liquidity->'warnings')>0 then missing:=missing||jsonb_build_array('liquidity_currency');end if;
 warnings:=coalesce(tax->'warnings','[]')||coalesce(liquidity->'warnings','[]');
 if reserved>(liquidity->>'total_liquidity')::numeric then warnings:=warnings||jsonb_build_array('funds_overallocated');end if;
 if jsonb_array_length(missing)>0 then result_status:='incomplete';raw:=null;
 else result_status:=case when tax->>'projection_status'='confirmed' then 'confirmed' else 'estimated' end;
 raw:=free-gap-(commitments->>'essential')::numeric-(commitments->>'other')::numeric-contributions;end if;
 return jsonb_build_object('as_of',as_of,'horizon_end',finish,'total_liquidity',(liquidity->>'total_liquidity')::numeric,
 'reserved_funds_total',reserved,'free_liquidity',free,'required_tax_reserve',required,'tax_fund_balance',tax_balance,'tax_reserve_gap',gap,
 'emergency_fund_balance',emergency,'house_fund_balance',house,
 'emergency_coverage_months',case when settings.monthly_essential_expenses_target>0 then round(emergency/settings.monthly_essential_expenses_target,2) end,
 'upcoming_essential_commitments',(commitments->>'essential')::numeric,'upcoming_other_commitments',(commitments->>'other')::numeric,
 'emergency_contribution_gap',emergency_gap,'goals_contribution_gap',goal_gap,'investment_contribution_gap',investment_gap,
 'total_planned_contributions',contributions,'safe_to_spend_raw',raw,
 'safe_to_spend',case when raw is not null then greatest(raw,0) end,'funding_shortfall',case when raw is not null then greatest(-raw,0) end,
 'funds_overallocated',reserved>(liquidity->>'total_liquidity')::numeric,'funds_overallocation_amount',greatest(reserved-(liquidity->>'total_liquidity')::numeric,0),
 'status',result_status,'missing_fields',missing,'warnings',warnings,'calculated_at',now(),'funds',funds,'commitments',commitments->'occurrences');
end $$;
do $$ declare f record;begin
 for f in select oid::regprocedure signature from pg_proc where pronamespace='public'::regnamespace
 and proname in ('financial_bootstrap_funds','financial_liquidity_summary','financial_fund_summary','financial_goal_summary',
 'financial_allocate_fund','financial_release_fund','financial_transfer_fund','financial_commitment_summary','financial_safe_to_spend') loop
 execute format('revoke all on function %s from public,anon,authenticated',f.signature);
 execute format('grant execute on function %s to authenticated',f.signature);
 end loop;
end $$;
commit;
