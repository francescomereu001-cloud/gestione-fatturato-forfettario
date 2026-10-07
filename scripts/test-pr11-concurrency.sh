#!/usr/bin/env bash
# Called only by test-sql.sh with its disposable local Docker database.
set -euo pipefail
container=$1
query() { docker exec -i "$container" psql -U postgres -v ON_ERROR_STOP=1; }
query <<'SQL'
insert into auth.users values('11000000-0000-0000-0000-000000000011');
insert into public.accounts(user_id,name,account_type,opening_balance) values('11000000-0000-0000-0000-000000000011','Race fixture','checking',100);
insert into public.financial_funds(id,user_id,name) values('11000000-0000-0000-0000-000000000012','11000000-0000-0000-0000-000000000011','Race fund');
SQL
worker() {
 query <<'SQL'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub','11000000-0000-0000-0000-000000000011',true);
select public.financial_allocate_fund('11000000-0000-0000-0000-000000000012',60);
select pg_sleep(0.25);
commit;
SQL
}
worker >work/pr11-race-a.log 2>&1 & first=$!
worker >work/pr11-race-b.log 2>&1 & second=$!
a=0;b=0
wait "$first" || a=$?
wait "$second" || b=$?
if [[ "$a" == 0 && "$b" != 0 ]]; then failed=work/pr11-race-b.log
elif [[ "$b" == 0 && "$a" != 0 ]]; then failed=work/pr11-race-a.log
else echo 'FAIL: exactly one concurrent allocation must succeed' >&2; exit 1; fi
rg -q 'insufficient free liquidity' "$failed"
query <<'SQL'
do $$ begin
 if (select count(*)<>1 or sum(amount)<>60 from public.fund_entries where user_id='11000000-0000-0000-0000-000000000011') then raise exception 'concurrent allocations overspent';end if;
 raise notice 'PASS: concurrent allocations serialize; one succeeds, one rejects without partial entry';
end $$;
delete from public.fund_entries where user_id='11000000-0000-0000-0000-000000000011';
delete from public.financial_funds where user_id='11000000-0000-0000-0000-000000000011';
delete from public.accounts where user_id='11000000-0000-0000-0000-000000000011';
delete from auth.users where id='11000000-0000-0000-0000-000000000011';
SQL
