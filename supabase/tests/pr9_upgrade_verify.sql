do $$
declare entity text; changed boolean;
begin
  foreach entity in array array['transactions','accounts','import_rows','rules'] loop
    execute format('select exists(select 1 from pr9_upgrade_test.snapshots s full join public.%I t on t.id=s.id
      where (s.entity=%L or s.entity is null) and (s.id is null or t.id is null or s.row_value is distinct from (to_jsonb(t)-%L)))',
      case when entity='rules' then 'transaction_classification_rules' else entity end,entity,
      case when entity='rules' then 'memory_account_type' else '__no_column__' end) into changed;
    if changed then raise exception 'FAIL: PR9 migration changed %',entity; end if;
    raise notice 'PASS: PR9 migration preserves % including counts and audit fields',entity;
  end loop;
end $$;
drop schema pr9_upgrade_test cascade;
-- Clear only the synthetic upgrade seed so regression-suite counts stay independent.
-- This script is exclusively for the disposable database created by scripts/test-sql.sh.
delete from public.import_rows;
delete from public.transactions;
delete from public.transaction_classification_rules;
delete from public.import_batches;
delete from public.accounts;
delete from auth.users;
