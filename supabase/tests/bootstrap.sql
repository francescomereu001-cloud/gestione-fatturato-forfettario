create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;
create schema auth;
create table auth.users(id uuid primary key);
create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
grant usage on schema auth to anon,authenticated;
grant execute on function auth.uid() to anon,authenticated;
create table public.invoices(id uuid primary key default gen_random_uuid(),
 numero text,data date,cliente text,descrizione text,lordo numeric,enasarco numeric,netto numeric,
 incassata boolean,data_incasso date,anno integer,categoria text,note text);
create table public.tax_payments(id uuid primary key default gen_random_uuid(),anno integer,data date,descrizione text,importo numeric,tipo text);
create table public.tax_settings(id uuid primary key default gen_random_uuid(),anno integer,aliquota_imposta numeric,coefficiente_redditivita numeric,aliquota_inps numeric,minimale_inps numeric);
