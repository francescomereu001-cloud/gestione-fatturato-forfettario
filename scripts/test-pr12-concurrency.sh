#!/usr/bin/env bash
# Disposable Docker database supplied by test-sql.sh only.
set -euo pipefail
container=$1
query() { docker exec -i "$container" psql -U postgres -v ON_ERROR_STOP=1; }
query <<'SQL'
insert into auth.users values('12000000-0000-0000-0000-000000000011');
set role authenticated;
select set_config('request.jwt.claim.sub','12000000-0000-0000-0000-000000000011',false);
select public.stage_invoice_import_batch('race-a.xls','aruba_invoice_report_v1','[{"raw_data":{},"normalized_data":{"numero":"race","data":"2025-01-01","cliente":"Synthetic","descrizione":"","lordo":100,"enasarco":10,"netto":90,"document_type":"invoice"}}]');
select public.stage_invoice_import_batch('race-b.xls','aruba_invoice_report_v1','[{"raw_data":{},"normalized_data":{"numero":"race","data":"2025-01-01","cliente":"Synthetic","descrizione":"","lordo":100,"enasarco":10,"netto":90,"document_type":"invoice"}}]');
SQL
worker() {
 query <<SQL
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub','12000000-0000-0000-0000-000000000011',true);
select public.commit_invoice_import_batch((select id from public.invoice_import_batches where file_name='$1'));
select pg_sleep(0.25);
commit;
SQL
}
worker race-a.xls >work/pr12-race-a.log 2>&1 & first=$!
worker race-b.xls >work/pr12-race-b.log 2>&1 & second=$!
wait "$first"
wait "$second"
query <<'SQL'
do $$ begin
 if (select count(*)<>1 from public.invoices where user_id='12000000-0000-0000-0000-000000000011') then raise exception 'concurrent imports duplicated invoice';end if;
 if (select sum(inserted_count)<>1 or sum(duplicate_count)<>1 or count(*)<>2 from public.invoice_import_batches where user_id='12000000-0000-0000-0000-000000000011' and status='committed') then raise exception 'concurrent counts incorrect';end if;
 raise notice 'PASS: concurrent invoice commits recheck identity; one inserts, one reports unchanged';
end $$;
SQL
