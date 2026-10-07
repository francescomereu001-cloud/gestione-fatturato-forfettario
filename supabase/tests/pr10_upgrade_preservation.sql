create schema pr10_upgrade;
insert into auth.users(id) values('10000000-0000-0000-0000-000000000010');
insert into public.invoices(user_id,numero,anno,lordo,netto,enasarco,incassata) values('10000000-0000-0000-0000-000000000010','preservation',2025,100,90,10,false);
insert into public.tax_payments(user_id,anno,importo,tipo) values('10000000-0000-0000-0000-000000000010',2025,20,'F24');
insert into public.tax_settings(user_id,anno,aliquota_imposta) values('10000000-0000-0000-0000-000000000010',2025,5);
create table pr10_upgrade.invoices as select to_jsonb(i) row from public.invoices i;
create table pr10_upgrade.payments as select to_jsonb(p) row from public.tax_payments p;
create table pr10_upgrade.settings as select to_jsonb(s) row from public.tax_settings s;
create table pr10_upgrade.ledger as select to_jsonb(t) row from public.transactions t;
