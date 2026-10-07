do $$ declare t record;data jsonb;begin
 for t in select * from pr11_upgrade.rows loop
 execute format('select coalesce(jsonb_agg(to_jsonb(x) order by to_jsonb(x)::text),''[]''::jsonb) from public.%I x',t.table_name) into data;
 if data is distinct from t.rows then raise exception 'PR11 altered original table %',t.table_name;end if;
 end loop;
 if exists(select 1 from public.financial_funds) or exists(select 1 from public.fund_entries) then raise exception 'PR11 must not bootstrap or allocate in migration';end if;
 raise notice 'PASS: PR11 preserves every original public table and creates no financial allocations';
end $$;
delete from public.transactions where user_id='10000000-0000-0000-0000-000000000011';
delete from public.accounts where user_id='10000000-0000-0000-0000-000000000011';
delete from public.invoices where user_id='10000000-0000-0000-0000-000000000011';
delete from public.tax_payments where user_id='10000000-0000-0000-0000-000000000011';
delete from auth.users where id='10000000-0000-0000-0000-000000000011';
drop schema pr11_upgrade cascade;
