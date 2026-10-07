-- Preserve original rows across the additive migration, including explicit saldo anchor and F24.
insert into auth.users(id) values('10000000-0000-0000-0000-000000000011');
insert into public.accounts(user_id,name,account_type,opening_balance,balance_as_of)
 values('10000000-0000-0000-0000-000000000011','PR11 preservation','checking',1234.56,'2026-01-01');
insert into public.transactions(user_id,account_id,transaction_date,booking_date,amount,description,transaction_type)
 select user_id,id,'2026-02-01','2026-02-02',-12.34,'Preserve classification and dates','expense' from public.accounts where name='PR11 preservation';
insert into public.invoices(user_id,lordo,netto,incassata,anno,data) values('10000000-0000-0000-0000-000000000011',100,100,false,2026,'2026-01-01');
insert into public.tax_payments(user_id,anno,data,importo,descrizione,tipo) values('10000000-0000-0000-0000-000000000011',2026,'2026-01-01',50,'Original F24','F24');
create schema pr11_upgrade;
create table pr11_upgrade.rows(table_name text primary key,rows jsonb);
do $$ declare t record;data jsonb;begin
 for t in select tablename from pg_tables where schemaname='public' loop
 execute format('select coalesce(jsonb_agg(to_jsonb(x) order by to_jsonb(x)::text),''[]''::jsonb) from public.%I x',t.tablename) into data;
 insert into pr11_upgrade.rows values(t.tablename,data);
 end loop;
end $$;
