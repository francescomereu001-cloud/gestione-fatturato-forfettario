insert into auth.users(id) values('10000000-0000-0000-0000-000000000012');
insert into public.invoices(user_id,numero,data,anno,cliente,descrizione,lordo,enasarco,netto,incassata,data_incasso)
 values('10000000-0000-0000-0000-000000000012','legacy','2025-01-01',2025,'Original','Keep all data',100,10,90,false,'2026-01-01');
insert into public.invoices(numero,data,lordo,enasarco,netto,incassata,pagata) values('unowned','2025-01-01',321,12,309,false,true);
insert into public.tax_payments(user_id,anno,data,importo,descrizione,tipo) values('10000000-0000-0000-0000-000000000012',2025,'2025-01-01',50,'Original F24','F24');
insert into public.tax_settings(user_id,anno,aliquota_imposta) values('10000000-0000-0000-0000-000000000012',2025,7);
insert into public.fiscal_year_settings(user_id,tax_year,source_note) values('10000000-0000-0000-0000-000000000012',2025,'Preserve profile');
insert into public.accounts(user_id,name,account_type,opening_balance,balance_as_of) values('10000000-0000-0000-0000-000000000012','PR12 original','checking',1234.56,'2025-01-01');
insert into public.transactions(user_id,account_id,transaction_date,amount,description,transaction_type) select user_id,id,'2025-01-02',-10,'Keep movement','expense' from public.accounts where name='PR12 original';
-- Existing PR11 entries are preserved too; create synthetic owner-specific entries via normal RPCs.
select set_config('request.jwt.claim.sub','10000000-0000-0000-0000-000000000012',false);
set role authenticated;
select public.financial_bootstrap_funds();
select public.financial_allocate_fund((select id from public.financial_funds where system_key='house'),100);
reset role;
select set_config('request.jwt.claim.sub','',false);
create schema pr12_upgrade;
create table pr12_upgrade.rows(table_name text primary key,rows jsonb);
do $$ declare t record;data jsonb;begin
 for t in select tablename from pg_tables where schemaname='public' loop
 execute format('select coalesce(jsonb_agg(to_jsonb(x) order by to_jsonb(x)::text),''[]''::jsonb) from public.%I x',t.tablename) into data;
 insert into pr12_upgrade.rows values(t.tablename,data);end loop;
end $$;
