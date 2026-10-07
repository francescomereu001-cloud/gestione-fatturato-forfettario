do $$ begin
 if exists((select row from pr10_upgrade.invoices except all select to_jsonb(i) from public.invoices i) union all (select to_jsonb(i) from public.invoices i except all select row from pr10_upgrade.invoices)) then raise exception 'PR10 changed legacy invoices'; end if;
 if exists((select row from pr10_upgrade.payments except all select to_jsonb(p)-array['fiscal_allocation_status','fiscal_tax_year','fiscal_payment_kind','fiscal_payment_date','deductible_social_security','fiscal_obligation_id','fiscal_allocation_note'] from public.tax_payments p)) then raise exception 'PR10 changed legacy payment fields'; end if;
 if exists((select row from pr10_upgrade.settings except all select to_jsonb(s) from public.tax_settings s) union all (select to_jsonb(s) from public.tax_settings s except all select row from pr10_upgrade.settings)) then raise exception 'PR10 changed legacy settings'; end if;
 if exists((select row from pr10_upgrade.ledger except all select to_jsonb(t) from public.transactions t) union all (select to_jsonb(t) from public.transactions t except all select row from pr10_upgrade.ledger)) then raise exception 'PR10 changed ledger'; end if;
 if exists(select 1 from public.tax_payments where fiscal_allocation_status<>'unallocated') then raise exception 'PR10 guessed legacy allocations'; end if;
end $$;
delete from public.invoices where user_id='10000000-0000-0000-0000-000000000010';
delete from public.tax_payments where user_id='10000000-0000-0000-0000-000000000010';
delete from public.tax_settings where user_id='10000000-0000-0000-0000-000000000010';
delete from auth.users where id='10000000-0000-0000-0000-000000000010';
drop schema pr10_upgrade cascade;
