-- Run as the local database administrator AFTER applying migrations.
-- Synthetic fixtures only. Every fixture/helper is rolled back.
-- psql -v ON_ERROR_STOP=1 -f supabase/tests/pr4_4_multi_instrument.sql
begin;

create function pg_temp.assert_true(condition boolean, label text) returns void
language plpgsql as $$
begin
  if condition is distinct from true then raise exception 'FAIL: %', label; end if;
  raise notice 'PASS: %', label;
end $$;
create function pg_temp.expect_error(statement text, expected_message text, label text) returns void
language plpgsql as $$
declare rejected boolean := false;
begin
  begin
    execute statement;
  exception when others then
    if strpos(sqlerrm, expected_message) = 0 then raise; end if;
    rejected := true;
  end;
  perform pg_temp.assert_true(rejected, label);
end $$;

select set_config('test.owner', gen_random_uuid()::text, true),
       set_config('test.other', gen_random_uuid()::text, true),
       set_config('test.checking', gen_random_uuid()::text, true),
       set_config('test.card', gen_random_uuid()::text, true),
       set_config('test.foreign', gen_random_uuid()::text, true),
       set_config('test.multi', gen_random_uuid()::text, true),
       set_config('test.legacy', gen_random_uuid()::text, true),
       set_config('test.invalid', gen_random_uuid()::text, true),
       set_config('test.collision', gen_random_uuid()::text, true);
insert into auth.users(id) values (current_setting('test.owner')::uuid), (current_setting('test.other')::uuid);
insert into public.accounts(id, user_id, name, account_type, include_in_liquidity) values
  (current_setting('test.checking')::uuid, current_setting('test.owner')::uuid, 'Synthetic checking', 'checking', true),
  (current_setting('test.card')::uuid, current_setting('test.owner')::uuid, 'Synthetic card', 'credit_card', false),
  (current_setting('test.foreign')::uuid, current_setting('test.other')::uuid, 'Synthetic foreign', 'checking', true);

select set_config('request.jwt.claim.sub', current_setting('test.owner'), true);
set local role authenticated;

insert into public.import_account_mappings(parser_key, source_instrument, account_id)
values ('isybank_operations_v1', '  CONTO   TEST  ', current_setting('test.checking')::uuid);
select pg_temp.assert_true((select source_instrument = 'conto test' from public.import_account_mappings),
  'mapping key canonicalized on server');
select pg_temp.expect_error(
  format('insert into public.import_account_mappings(parser_key, source_instrument, account_id) values (%L, %L, %L)',
    'isybank_operations_v1', 'conto test', current_setting('test.checking')),
  'duplicate key', 'normalized mapping uniqueness');
select pg_temp.expect_error(
  format('insert into public.import_account_mappings(parser_key, source_instrument, account_id) values (%L, %L, %L)',
    'isybank_operations_v1', 'Conto foreign', current_setting('test.foreign')),
  'mapping account', 'foreign account mapping rejected');
select pg_temp.expect_error(
  format('insert into public.import_account_mappings(parser_key, source_instrument, account_id) values (%L, %L, %L)',
    'isybank_operations_v1', 'Carta di credito **** 9999', current_setting('test.checking')),
  'mapping account', 'incompatible card mapping rejected');
select pg_temp.expect_error(
  format('update public.import_account_mappings set user_id = %L', current_setting('test.other')),
  'mapping account', 'mapping cannot change ownership');
update public.import_account_mappings set source_instrument = 'Conto TEST';
select pg_temp.assert_true((select count(*) = 1 from public.import_account_mappings), 'owner can update and read mapping');

insert into public.import_batches(id, account_id, source_format, parser_key, row_count) values
  (current_setting('test.multi')::uuid, current_setting('test.checking')::uuid, 'xlsx', 'isybank_operations_v1', 3),
  (current_setting('test.legacy')::uuid, current_setting('test.checking')::uuid, 'csv', 'generic_bank_v1', 1),
  (current_setting('test.invalid')::uuid, current_setting('test.checking')::uuid, 'xlsx', 'isybank_operations_v1', 2),
  (current_setting('test.collision')::uuid, current_setting('test.checking')::uuid, 'csv', 'generic_bank_v1', 2);
insert into public.import_rows(batch_id, row_index, transaction_date, amount, description,
  suggested_transaction_type, status, source_instrument, target_account_id, dedupe_fingerprint, external_id) values
  (current_setting('test.multi')::uuid, 0, '2026-01-01', -10, 'Synthetic identical', 'unclassified', 'ready',
    'Conto test', current_setting('test.checking')::uuid, 'identical', null),
  (current_setting('test.multi')::uuid, 1, '2026-01-01', -10, 'Synthetic identical', 'unclassified', 'ready',
    'Carta di credito **** 9999', current_setting('test.card')::uuid, 'identical', null),
  (current_setting('test.multi')::uuid, 2, '2026-01-01', -10, 'Synthetic identical', 'unclassified', 'ready',
    'Conto test', current_setting('test.checking')::uuid, 'identical', null),
  (current_setting('test.legacy')::uuid, 0, '2026-01-02', -20, 'Synthetic legacy', 'unclassified', 'ready',
    null, null, 'legacy', 'synthetic-external-id'),
  (current_setting('test.invalid')::uuid, 0, '2026-01-03', -30, 'Synthetic valid', 'unclassified', 'ready',
    'Conto test', current_setting('test.checking')::uuid, 'valid', null),
  (current_setting('test.invalid')::uuid, 1, '2026-01-03', -30, 'Synthetic missing target', 'unclassified', 'ready',
    'Carta di credito **** 9999', null, 'missing', null),
  (current_setting('test.collision')::uuid, 0, '2026-01-04', -40, 'Synthetic first', 'unclassified', 'ready',
    null, null, 'collision', 'synthetic-collision'),
  (current_setting('test.collision')::uuid, 1, '2026-01-04', -40, 'Synthetic second', 'unclassified', 'ready',
    null, null, 'collision', 'synthetic-collision');

select pg_temp.expect_error(
  format('update public.import_rows set target_account_id = %L where batch_id = %L',
    current_setting('test.foreign'), current_setting('test.invalid')),
  'target account', 'foreign target rejected during staging');
select pg_temp.expect_error(
  format('update public.import_rows set target_account_id = %L where batch_id = %L and row_index = 1',
    current_setting('test.checking'), current_setting('test.invalid')),
  'target account', 'card to checking routing rejected');
select pg_temp.assert_true(public.commit_import_batch(current_setting('test.multi')::uuid) = 3, 'multi-account commit imports all rows');
select pg_temp.assert_true((select count(*) = 2 from public.transactions where account_id = current_setting('test.checking')::uuid),
  'two identical real checking movements coexist');
select pg_temp.assert_true((select count(*) = 1 from public.transactions where account_id = current_setting('test.card')::uuid),
  'card movement routed to card');
select pg_temp.assert_true((select imported_count = 3 and status = 'completed' from public.import_batches where id = current_setting('test.multi')::uuid),
  'commit counters finalized atomically');
select pg_temp.assert_true(public.commit_import_batch(current_setting('test.legacy')::uuid) = 1, 'legacy null target uses batch account');
select pg_temp.assert_true((select account_id = current_setting('test.checking')::uuid from public.transactions
  where import_batch_id = current_setting('test.legacy')::uuid), 'legacy fallback account preserved');
select pg_temp.assert_true((select occurrences = 2 from public.import_dedup_history(current_setting('test.checking')::uuid, '{}', '{identical}')),
  'history multiplicity is two for checking');
select pg_temp.assert_true((select occurrences = 1 from public.import_dedup_history(current_setting('test.card')::uuid, '{}', '{identical}')),
  'history scoped to card account');
select pg_temp.assert_true((select occurrences = 1 from public.import_dedup_history(current_setting('test.checking')::uuid, '{synthetic-external-id}', '{}')),
  'strong external ID history uses actual transactions');
insert into public.import_rows(batch_id, row_index, status, dedupe_fingerprint)
values (current_setting('test.multi')::uuid, 3, 'duplicate', 'identical');
select pg_temp.assert_true((select occurrences = 2 from public.import_dedup_history(current_setting('test.checking')::uuid, '{}', '{identical}')),
  'duplicate staging rows do not inflate history');
select pg_temp.expect_error(
  format('select public.commit_import_batch(%L)', current_setting('test.invalid')),
  'target accounts', 'missing target rejects complete commit');
select pg_temp.assert_true((select count(*) = 0 from public.transactions where import_batch_id = current_setting('test.invalid')::uuid),
  'preflight failure inserts zero transactions');
select pg_temp.assert_true((select status = 'preview' and imported_count = 0 from public.import_batches where id = current_setting('test.invalid')::uuid),
  'preflight failure leaves batch unchanged');
update public.import_rows set target_account_id = current_setting('test.card')::uuid
  where batch_id = current_setting('test.invalid')::uuid and row_index = 1;
update public.accounts set is_active = false where id = current_setting('test.card')::uuid;
select pg_temp.expect_error(
  format('select public.commit_import_batch(%L)', current_setting('test.invalid')),
  'target accounts', 'inactive target rejects commit');
update public.accounts set is_active = true, opening_balance = 50 where id = current_setting('test.card')::uuid;
select pg_temp.expect_error(
  format('select public.commit_import_batch(%L)', current_setting('test.invalid')),
  'balance dates', 'balance date required for every effective account');
update public.accounts set opening_balance = 0 where id = current_setting('test.card')::uuid;
-- Simulate stale account ownership/type between staging and commit.
reset role;
update public.accounts set user_id = current_setting('test.other')::uuid where id = current_setting('test.card')::uuid;
set local role authenticated;
select pg_temp.expect_error(
  format('select public.commit_import_batch(%L)', current_setting('test.invalid')),
  'target accounts', 'commit rechecks account ownership after staging');
reset role;
update public.accounts set user_id = current_setting('test.owner')::uuid, account_type = 'cash'
  where id = current_setting('test.card')::uuid;
set local role authenticated;
select pg_temp.expect_error(
  format('select public.commit_import_batch(%L)', current_setting('test.invalid')),
  'target accounts', 'commit rechecks instrument compatibility after staging');
update public.accounts set account_type = 'credit_card' where id = current_setting('test.card')::uuid;
update public.import_rows set amount = 0 where batch_id = current_setting('test.invalid')::uuid and row_index = 1;
select pg_temp.expect_error(
  format('select public.commit_import_batch(%L)', current_setting('test.invalid')),
  'ready rows are invalid', 'one invalid numeric row rejects whole commit');
update public.import_rows set amount = -30 where batch_id = current_setting('test.invalid')::uuid and row_index = 1;
update public.import_batches set row_count = 3 where id = current_setting('test.invalid')::uuid;
select pg_temp.expect_error(
  format('select public.commit_import_batch(%L)', current_setting('test.invalid')),
  'staging is incomplete', 'incomplete staging rejects commit');
update public.import_batches set row_count = 2 where id = current_setting('test.invalid')::uuid;
select pg_temp.assert_true((select count(*) = 0 from public.transactions where import_batch_id = current_setting('test.invalid')::uuid),
  'all target and numeric preflight failures insert zero transactions');
select pg_temp.expect_error(
  format('select public.commit_import_batch(%L)', current_setting('test.collision')),
  'duplicate key', 'late external ID violation rolls back complete commit');
select pg_temp.assert_true((select count(*) = 0 from public.transactions where import_batch_id = current_setting('test.collision')::uuid),
  'late failure leaves zero transactions');
select pg_temp.assert_true((select count(*) = 2 from public.import_rows where batch_id = current_setting('test.collision')::uuid and status = 'ready'),
  'late failure rolls back staging updates');
select pg_temp.expect_error(
  format('select public.import_dedup_history(%L, %L, %L)', current_setting('test.foreign'), '{}', '{identical}'),
  'dedup account', 'foreign dedup lookup rejected');
select pg_temp.expect_error(
  format('insert into public.transactions(account_id, transaction_date, amount, description, transaction_type) values (%L, %L, -1, %L, %L)',
    current_setting('test.foreign'), '2026-01-01', 'Synthetic forbidden', 'unclassified'),
  'account must belong', 'transaction ownership validation remains enforced');

-- PR4.2 sees the actual routed accounts and leaves operations conservative.
select public.classify_transactions(current_setting('test.multi')::uuid);
select pg_temp.assert_true((select bool_and(transaction_type = 'unclassified') from public.transactions
  where import_batch_id = current_setting('test.multi')::uuid), 'IsyBank operations are not classified by amount sign');

-- A correction of a historical account immediately changes history scope.
update public.transactions set account_id = current_setting('test.card')::uuid
  where import_batch_id = current_setting('test.legacy')::uuid;
select pg_temp.assert_true((select count(*) = 0 from public.import_dedup_history(current_setting('test.checking')::uuid, '{}', '{legacy}')),
  'rerouting removes transaction from former account history');
select pg_temp.assert_true((select occurrences = 1 from public.import_dedup_history(current_setting('test.card')::uuid, '{}', '{legacy}')),
  'rerouting moves transaction into actual account history');

select set_config('request.jwt.claim.sub', current_setting('test.other'), true);
select pg_temp.assert_true((select count(*) = 0 from public.import_account_mappings), 'other owner cannot read mappings');
update public.import_account_mappings set parser_key = 'forbidden';
delete from public.import_account_mappings;
select pg_temp.expect_error(
  format('insert into public.import_account_mappings(user_id, parser_key, source_instrument, account_id) values (%L, %L, %L, %L)',
    current_setting('test.owner'), 'generic_bank_v1', 'unknown', current_setting('test.foreign')),
  'mapping account', 'other owner cannot insert mappings for original owner');
select pg_temp.expect_error(
  format('select public.commit_import_batch(%L)', current_setting('test.invalid')),
  'not found', 'foreign batch commit rejected');
select pg_temp.expect_error(
  format('insert into public.transactions(account_id, transaction_date, amount, description, transaction_type, import_batch_id) values (%L, %L, -1, %L, %L, %L)',
    current_setting('test.foreign'), '2026-01-01', 'Synthetic forbidden provenance', 'unclassified', current_setting('test.multi')),
  'import batch must belong', 'transaction cannot reference another owners batch');
select set_config('request.jwt.claim.sub', current_setting('test.owner'), true);
select pg_temp.assert_true((select count(*) = 1 from public.import_account_mappings), 'other owner could neither update nor delete mapping');
delete from public.import_account_mappings;
select pg_temp.assert_true((select count(*) = 0 from public.import_account_mappings), 'owner can delete mapping');

reset role;
set local role anon;
select pg_temp.expect_error('select * from public.import_account_mappings', 'permission denied', 'anon cannot access mappings');
select pg_temp.expect_error('select public.commit_import_batch(gen_random_uuid())', 'permission denied', 'anon cannot call commit');
select pg_temp.expect_error('select public.import_dedup_history(gen_random_uuid(), array[]::text[], array[]::text[])',
  'permission denied', 'anon cannot call dedup RPC');
reset role;
rollback;
