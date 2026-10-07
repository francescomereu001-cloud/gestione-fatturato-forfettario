-- Additive PR12. No legacy-row rewrite; documentary numeric columns remain canonical.
begin;
create schema if not exists financial_private;
alter table public.invoices
 add column document_type text check(document_type in ('invoice','credit_note','signed_adjustment')),
 add column source_document_id text,
 add column source text,
 add column parser_key text,
 add column import_batch_id uuid,
 add column source_fingerprint text,
 add column imported_at timestamptz,
 add column import_metadata jsonb;
alter table public.invoices add constraint invoices_id_owner_unique unique(id,user_id);
create table public.invoice_import_batches(
 id uuid primary key default gen_random_uuid(), user_id uuid not null references auth.users(id),
 file_name text not null, parser_key text not null, source text not null default 'aruba',
 imported_at timestamptz, row_count integer not null default 0, inserted_count integer not null default 0,
 updated_count integer not null default 0, duplicate_count integer not null default 0,
 rejected_count integer not null default 0, conflict_count integer not null default 0,
 status text not null default 'staged' check(status in ('staged','committed')),
 metadata jsonb not null default '{}', created_at timestamptz not null default now(), unique(id,user_id)
);
create table public.invoice_import_rows(
 id uuid primary key default gen_random_uuid(), user_id uuid not null references auth.users(id), batch_id uuid not null,
 row_index integer not null check(row_index>0), raw_data jsonb not null, normalized_data jsonb,
 status text not null check(status in ('new','existing_unchanged','exact_duplicate','conflict','rejected','inserted')),
 invoice_id uuid, fingerprint text, identity_key text, warning_codes text[] not null default '{}',
 rejection_code text, created_at timestamptz not null default now(),
 foreign key(batch_id,user_id) references public.invoice_import_batches(id,user_id),
 foreign key(invoice_id,user_id) references public.invoices(id,user_id), unique(batch_id,row_index)
);
alter table public.invoices add constraint invoice_import_batch_owner_fk foreign key(import_batch_id,user_id) references public.invoice_import_batches(id,user_id);
create index invoice_import_batches_owner_idx on public.invoice_import_batches(user_id,created_at desc);
create index invoice_import_rows_owner_batch_idx on public.invoice_import_rows(user_id,batch_id);
create index invoice_import_rows_invoice_idx on public.invoice_import_rows(invoice_id,user_id);
create index invoices_import_batch_idx on public.invoices(import_batch_id,user_id);
create index invoices_owner_document_idx on public.invoices(user_id,numero);
alter table public.invoice_import_batches enable row level security;
alter table public.invoice_import_rows enable row level security;
revoke all on public.invoice_import_batches,public.invoice_import_rows from public,anon,authenticated;
grant select on public.invoice_import_batches,public.invoice_import_rows to authenticated;
create policy invoice_import_batches_read on public.invoice_import_batches for select to authenticated using((select auth.uid())=user_id);
create policy invoice_import_rows_read on public.invoice_import_rows for select to authenticated using((select auth.uid())=user_id);
create function public.lock_invoice_owner() returns trigger language plpgsql security invoker set search_path='' as $$
begin
 perform pg_advisory_xact_lock(hashtextextended('invoice_import:'||coalesce(new.user_id,old.user_id)::text,0));
 if tg_op='DELETE' then return old; end if; return new;
end $$;
revoke all on function public.lock_invoice_owner() from public,anon,authenticated;
create trigger invoices_serialize_owner before insert or update or delete on public.invoices for each row execute function public.lock_invoice_owner();
-- Privileged writer stays private: clients cannot mutate immutable staging/audit/counts.
-- Explicit owner check on every path. Public RPCs remain SECURITY INVOKER.
create function financial_private.invoice_import(action text, batch uuid, filename text default null, parser text default null, input_rows jsonb default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
 owner_id uuid:=auth.uid(); b public.invoice_import_batches; r public.invoice_import_rows; item jsonb; doc jsonb;
 g numeric; e numeric; n numeric; issued date; identity text; fp text; match_id uuid; matches integer;
 existing jsonb; seen jsonb:='{}'; warnings text[]; row_status text; idx integer:=0;
begin
 if owner_id is null then raise exception 'authentication required' using errcode='42501'; end if;
 perform pg_advisory_xact_lock(hashtextextended('invoice_import:'||owner_id::text,0));
 if action='stage' then
  if parser is null or parser not in ('aruba_invoice_report_v1','manual_invoice_v1') or filename is null or length(filename)>500
    or jsonb_typeof(input_rows) is distinct from 'array' or jsonb_array_length(input_rows) not between 1 and 10000 then raise exception 'invalid import payload'; end if;
  insert into public.invoice_import_batches(user_id,file_name,parser_key,source,row_count)
   values(owner_id,filename,parser,case when parser='manual_invoice_v1' then 'manual' else 'aruba' end,jsonb_array_length(input_rows)) returning * into b;
  for item in select value from jsonb_array_elements(input_rows) loop
   idx:=idx+1; doc:=item->'normalized_data'; warnings:='{}';
   if doc is not null and doc<>'null'::jsonb then
    issued:=public.fiscal_date(doc->>'data');g:=public.fiscal_numeric(doc->>'lordo');e:=public.fiscal_numeric(doc->>'enasarco');n:=public.fiscal_numeric(doc->>'netto');
    -- Confirmed FinancialMind business policy; documentary column retains precedence.
    if doc->>'enasarco_source'='document_gross_net_delta' then e:=g-n; end if;
    if issued is null or extract(year from issued) not between 1900 and 2200 or g is null or (e is null and parser<>'aruba_invoice_report_v1') or n is null
      or abs(g)>=1e12 or abs(e)>=1e12 or abs(n)>=1e12 or g<>round(g,2) or e<>round(e,2) or n<>round(n,2)
      or coalesce(length(btrim(doc->>'numero')),0) not between 1 and 200 or coalesce(length(btrim(doc->>'cliente')),0) not between 1 and 500
      or length(coalesce(doc->>'source_document_id',''))>200 or length(coalesce(doc->>'descrizione',''))>4000
      or coalesce(doc->>'document_type','') not in ('invoice','credit_note','signed_adjustment') then doc:=null;
    else
     if doc->>'document_type'='credit_note' then g:=-abs(g);e:=-abs(e);n:=-abs(n); end if;
     if e is null then warnings:=array_append(warnings,'enasarco_missing_in_source'); end if;
     if abs(g-e-n)>0.02 then warnings:=array_append(warnings,'gross_enasarco_net_mismatch'); end if;
     if doc->>'document_type'='signed_adjustment' then warnings:=array_append(warnings,'signed_document_type_unverified'); end if;
     if (g>0 and (e<0 or n<0)) or (g<0 and (e>0 or n>0)) then warnings:=array_append(warnings,'amount_sign_mismatch'); end if;
     doc:=jsonb_build_object('numero',btrim(doc->>'numero'),'data',issued,'cliente',btrim(doc->>'cliente'),
       'descrizione',coalesce(doc->>'descrizione',''),'lordo',g,'enasarco',e,'netto',n,'document_type',doc->>'document_type')||case when nullif(doc->>'source_document_id','') is not null then jsonb_build_object('source_document_id',doc->>'source_document_id') else '{}'::jsonb end
      ||case when doc->>'enasarco_source' in ('document_column','document_gross_net_delta') then jsonb_build_object('enasarco_source',doc->>'enasarco_source') else '{}'::jsonb end;
    end if;
   else doc:=null; end if;
   insert into public.invoice_import_rows(user_id,batch_id,row_index,raw_data,normalized_data,status,warning_codes,rejection_code)
     values(owner_id,b.id,idx,coalesce(item->'raw_data','{}'),doc,case when doc is null then 'rejected' else 'new' end,warnings,
       case when doc is null then coalesce(item->>'rejection_code','invalid_required_values') end);
  end loop;
 elsif action='commit' then
  select * into b from public.invoice_import_batches where id=batch and user_id=owner_id for update;
  if b.id is null then raise exception 'batch unavailable for current owner' using errcode='42501'; end if;
  if b.status='committed' then return to_jsonb(b); end if;
 else raise exception 'invalid import action'; end if;
 -- Re-evaluate against current authoritative invoices both at preview and at commit.
 for r in select * from public.invoice_import_rows where batch_id=b.id and user_id=owner_id order by row_index loop
  if r.normalized_data is null then continue; end if;
  doc:=r.normalized_data;
  identity:=md5(coalesce(nullif(doc->>'source_document_id',''),jsonb_build_array(lower(btrim(doc->>'numero')),extract(year from (doc->>'data')::date),doc->>'document_type')::text));
  fp:=md5(doc::text);match_id:=null;
  if seen ? identity then
   row_status:=case when seen->>identity=fp then 'exact_duplicate' else 'conflict' end;
  else
   select count(*), (array_agg(i.id order by i.id))[1] into matches,match_id from public.invoices i
    where i.user_id=owner_id and ((i.source_document_id is not null and i.source_document_id=doc->>'source_document_id') or (lower(btrim(i.numero))=lower(btrim(doc->>'numero'))
     and extract(year from public.fiscal_date(to_jsonb(i)->>'data'))=extract(year from (doc->>'data')::date)
     and coalesce(i.document_type,case when i.categoria='Nota di credito' then 'credit_note' when public.fiscal_numeric(to_jsonb(i)->>'lordo')<0 then 'signed_adjustment' else 'invoice' end)=doc->>'document_type'));
   if matches=0 then row_status:='new';
   elsif matches>1 then row_status:='conflict';
   else
    select jsonb_build_object('numero',btrim(i.numero),'data',public.fiscal_date(to_jsonb(i)->>'data'), 'cliente',btrim(i.cliente),
      'descrizione',coalesce(i.descrizione,''),'lordo',public.fiscal_numeric(to_jsonb(i)->>'lordo'),
      'enasarco',public.fiscal_numeric(to_jsonb(i)->>'enasarco'),'netto',public.fiscal_numeric(to_jsonb(i)->>'netto'),'document_type',doc->>'document_type')
     into existing from public.invoices i where id=match_id and user_id=owner_id;
    row_status:=case when existing=doc-ARRAY['source_document_id','enasarco_source'] then 'existing_unchanged' else 'conflict' end;
   end if;
   seen:=seen||jsonb_build_object(identity,fp);
  end if;
  if action='commit' and row_status='new' then
   insert into public.invoices(user_id,numero,data,cliente,descrizione,lordo,enasarco,netto,incassata,data_incasso,anno,categoria,
    document_type,source_document_id,source,parser_key,import_batch_id,source_fingerprint,imported_at,import_metadata)
   values(owner_id,doc->>'numero',(doc->>'data')::date,doc->>'cliente',doc->>'descrizione',(doc->>'lordo')::numeric,
    (doc->>'enasarco')::numeric,(doc->>'netto')::numeric,true,(doc->>'data')::date,extract(year from (doc->>'data')::date),
    case when doc->>'document_type'='credit_note' then 'Nota di credito' else 'Import Income' end,doc->>'document_type',doc->>'source_document_id',b.source,b.parser_key,b.id,fp,now(),jsonb_build_object('warning_codes',r.warning_codes,'enasarco_source',doc->>'enasarco_source')) returning id into match_id;
   row_status:='inserted';
  end if;
  update public.invoice_import_rows set status=row_status,invoice_id=match_id,fingerprint=fp,identity_key=identity where id=r.id and user_id=owner_id;
 end loop;
 update public.invoice_import_batches set
  inserted_count=(select count(*) from public.invoice_import_rows where batch_id=b.id and status in ('new','inserted')),
  duplicate_count=(select count(*) from public.invoice_import_rows where batch_id=b.id and status in ('exact_duplicate','existing_unchanged')),
  rejected_count=(select count(*) from public.invoice_import_rows where batch_id=b.id and status='rejected'),
  conflict_count=(select count(*) from public.invoice_import_rows where batch_id=b.id and status='conflict'),
  status=case when action='commit' then 'committed' else 'staged' end,imported_at=case when action='commit' then now() end
 where id=b.id and user_id=owner_id returning * into b;
 return to_jsonb(b);
end $$;
alter function financial_private.invoice_import(text,uuid,text,text,jsonb) owner to postgres;
revoke all on function financial_private.invoice_import(text,uuid,text,text,jsonb) from public,anon,authenticated;
grant usage on schema financial_private to authenticated;
grant execute on function financial_private.invoice_import(text,uuid,text,text,jsonb) to authenticated;
create function public.stage_invoice_import_batch(file_name text, parser_key text, rows jsonb) returns jsonb
 language sql security invoker set search_path='' as $$ select financial_private.invoice_import('stage',null,file_name,parser_key,rows) $$;
create function public.commit_invoice_import_batch(batch_id uuid) returns jsonb
 language sql security invoker set search_path='' as $$ select financial_private.invoice_import('commit',batch_id) $$;
revoke all on function public.stage_invoice_import_batch(text,text,jsonb),public.commit_invoice_import_batch(uuid) from public,anon;
grant execute on function public.stage_invoice_import_batch(text,text,jsonb),public.commit_invoice_import_batch(uuid) to authenticated;
-- Read-only policy projection preserves all historical stored payment flags/dates/amounts.
create view public.financial_income_invoices with(security_invoker=true) as
 select i.id,i.user_id,i.numero,public.fiscal_date(to_jsonb(i)->>'data') document_date,i.cliente,i.descrizione,
 public.fiscal_numeric(to_jsonb(i)->>'lordo') gross_amount,public.fiscal_numeric(to_jsonb(i)->>'enasarco') enasarco_amount,
 public.fiscal_numeric(to_jsonb(i)->>'netto') net_amount,
 coalesce(i.document_type,case when i.categoria='Nota di credito' then 'credit_note' when public.fiscal_numeric(to_jsonb(i)->>'lordo')<0 then 'signed_adjustment' else 'invoice' end) document_type,
 coalesce(i.source,'legacy') source, true incassata,public.fiscal_date(to_jsonb(i)->>'data') data_incasso
 from public.invoices i;
revoke all on public.financial_income_invoices from public,anon;
grant select on public.financial_income_invoices to authenticated;
create function public.financial_income_summary(target_year integer,as_of date default current_date)
returns jsonb language plpgsql stable security invoker set search_path='' as $$
declare result jsonb; cutoff date; first_day date; invalid_count integer; conflicts integer; warning_count integer;
begin
 if auth.uid() is null then raise exception 'authentication required' using errcode='42501'; end if;
 if target_year is null or target_year not between 1900 and 2200 or as_of is null then raise exception 'invalid income year or date'; end if;
 first_day:=make_date(target_year,1,1);cutoff:=least(as_of,current_date,make_date(target_year,12,31));
 select count(*) into invalid_count from public.financial_income_invoices where user_id=auth.uid()
  and (document_date is null or (document_date between first_day and cutoff and (gross_amount is null or enasarco_amount is null or net_amount is null)));
 select count(*) filter(where r.status='conflict'),count(*) filter(where cardinality(r.warning_codes)>0)
 into conflicts,warning_count from public.invoice_import_rows r join public.invoice_import_batches b on b.id=r.batch_id and b.user_id=r.user_id
 where r.user_id=auth.uid() and b.status='committed' and (public.fiscal_date(r.normalized_data->>'data') between first_day and cutoff);
 select jsonb_build_object('tax_year',target_year,'as_of',cutoff,'gross_invoiced',coalesce(sum(gross_amount),0),
  'gross_collected',coalesce(sum(gross_amount),0),'enasarco_withheld',case when count(*) filter(where enasarco_amount is null)>0 then null else coalesce(sum(enasarco_amount),0) end,'net_income',coalesce(sum(net_amount),0),
  'invoice_count',count(*),'credit_notes_total',coalesce(sum(gross_amount) filter(where document_type='credit_note'),0),
  'first_invoice_date',min(document_date),'last_invoice_date',max(document_date)) into result
 from public.financial_income_invoices where user_id=auth.uid() and document_date between first_day and cutoff;
 return result||jsonb_build_object('invalid_invoice_count',invalid_count,'conflict_count',coalesce(conflicts,0),'warning_count',coalesce(warning_count,0),
 'source_status',case when invalid_count>0 then 'incomplete' when coalesce(conflicts,0)+coalesce(warning_count,0)>0 then 'needs_review' else 'available' end,
 'latest_import',(select to_jsonb(b) from public.invoice_import_batches b where user_id=auth.uid() order by created_at desc,id desc limit 1),
 'monthly',(select jsonb_agg(jsonb_build_object('month',m,'gross',coalesce(x.gross,0),'enasarco',case when x.cnt is null then 0 else x.held end,'net',coalesce(x.net,0),'invoice_count',coalesce(x.cnt,0)) order by m)
 from generate_series(1,12) m left join (select extract(month from document_date)::integer as month_number,sum(gross_amount) gross,case when count(*) filter(where enasarco_amount is null)>0 then null else sum(enasarco_amount) end held,sum(net_amount) net,count(*) cnt
 from public.financial_income_invoices where user_id=auth.uid() and document_date between first_day and cutoff group by 1) x on x.month_number=m));
end $$;
revoke all on function public.financial_income_summary(integer,date) from public,anon;
grant execute on function public.financial_income_summary(integer,date) to authenticated;

-- Preserve PR10 formula; only replace collection-date policy. Mismatches are documentary warnings.
create or replace function public.financial_tax_summary(target_year integer, as_of date default current_date)
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

 -- PR12: issued document date is the collection date, without rewriting legacy invoices.
 with rows as (select to_jsonb(i) j from public.invoices i where user_id=(select auth.uid())),
 parsed as (select j,public.fiscal_numeric(j->>'lordo') gross,public.fiscal_numeric(j->>'netto') net,
  public.fiscal_numeric(j->>'enasarco') enasarco,public.fiscal_date(j->>'data') issued,
  public.fiscal_date(j->>'data') collected,
  true paid,
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
        or (profile.enasarco_treatment='not_applicable' and enasarco<>0)
    or (gross>0 and (enasarco<0 or enasarco>gross or net<0))
    or (gross<0 and (enasarco>0 or net>0))))
 into revenue_invoiced,revenue_collected,taxable_revenue,enasarco_withheld,receivables,current_issued_net,current_issued_enasarco,invoice_errors from relevant;
 if invoice_errors>0 then missing:=array_append(missing,'invoice_cash_dates_or_amount_semantics'); end if;
 if exists(select 1 from public.financial_income_invoices where user_id=auth.uid() and document_date between year_start and cutoff and enasarco_amount is null) then
  enasarco_withheld:=null; current_issued_enasarco:=null; missing:=array_append(missing,'invoice_enasarco_missing');
 end if;
 if profile.enasarco_treatment='withheld_deductible' then enasarco_deductible:=greatest(enasarco_withheld,0); end if;
 if taxable_revenue<0 then warnings:=array_append(warnings,'net_credit_note_revenue'); end if;
 if exists(select 1 from public.financial_income_invoices where user_id=auth.uid() and document_date between year_start and cutoff and abs(gross_amount-enasarco_amount-net_amount)>0.02) then
  warnings:=array_append(warnings,'invoice_amount_mismatch');
 end if;
 if exists(select 1 from public.invoice_import_rows r join public.invoice_import_batches b on b.id=r.batch_id and b.user_id=r.user_id
   where r.user_id=auth.uid() and b.status='committed' and r.status='conflict' and public.fiscal_date(r.normalized_data->>'data') between year_start and cutoff) then
  warnings:=array_append(warnings,'invoice_import_conflicts');
 end if;

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

commit;
