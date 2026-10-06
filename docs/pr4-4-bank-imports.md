# PR4.4: routing and counted deduplication

Apply `20261006152300_pr4_4_multi_instrument_imports.sql` before deploying the frontend.
No migration updates or deletes historical financial records.

## Behavior and compatibility

- IsyBank operations expose the original instrument on each staging row. The upload page groups instruments, loads owner/parser mappings, and asks only for missing associations. Creating the preview confirms and persists these associations.
- Keys are trimmed, lowercased, and whitespace-normalized. Checking instruments require `checking`; credit cards require `credit_card`. No account is created automatically. A liquidity warning is shown for selected credit cards included in liquidity.
- Every routed row has `target_account_id`. The batch account remains the fallback for older rows and single-account AMEX, IsyBank card and generic imports.
- The server revalidates account ownership, active state, instrument compatibility, and opening balance dates for all ready rows before insertion. Staging/category validation and transactional rollback remain in force.
- Dedup history counts distinct, existing transactions through imported rows, scoped to the caller and the transaction's actual account. Duplicate/preview rows do not inflate history; deleted transactions disappear from it. Aggregation happens in SQL, avoiding API row-limit truncation.
- Weak fingerprints consume historical counts. Excess identical occurrences stay ready, including identical siblings in a fresh file. Historical matches remain `possible_duplicate` for explicit review. Strong external IDs remain unique per owner/account/source.
- PR4.2 already uses each transaction's account for account-specific rules and reconciliation. IsyBank operations remain outside provider sign-based classification; no category mapping is introduced.

## Verification

Run `npm test`, `npm run lint`, `npm run build`, and `git diff --check`.
If the Node runner reports only test filenames, also run:

```sh
node --test --test-isolation=none src/auth/*.test.ts src/domain/*/*.test.ts src/import/parsers/*.test.ts src/services/*.test.ts
```

The SQL integration suite uses synthetic fixtures, generated UUIDs, authenticated/anon roles, and a final rollback:

```sh
psql "$LOCAL_TEST_DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/pr4_4_multi_instrument.sql
```

Use a disposable local database with the migrations applied and an administrator connection. The script uses SQL assertions, not the pgTAP runner. Verification in this PR used PostgreSQL 17 with a minimal local `auth.uid()` shim; a local Chromium smoke test also covered missing/persisted mappings, per-row preview routing, commit UI, and missing-account guidance with a simulated backend. Hosted Supabase/PostgREST still needs a staging smoke test before release.

## Later historical repair (separate operation)

Do not run a production repair as part of this migration. First inspect rows with parameterized queries under the affected owner's session:

```sql
select t.id, t.account_id, r.id as import_row_id, r.status,
       coalesce(r.source_instrument, r.raw_data ->> 'Conto o carta') as source_instrument,
       r.target_account_id, t.transaction_date, t.amount, t.description
from public.import_rows r
join public.transactions t on t.id = r.matched_transaction_id
where r.batch_id = $1 and t.import_batch_id = $1
  and r.user_id = auth.uid() and t.user_id = auth.uid()
order by r.row_index;
```

For a reviewed repair, lock the affected rows/transactions in one transaction. Resolve instruments using owner/parser mappings and verify that every target account belongs to the owner and has a compatible type. Update both the transaction account and staging `source_instrument`/`target_account_id`; preserve `matched_transaction_id`. The transaction ownership trigger permits a different account from the batch fallback. Dedup history then follows the corrected transaction account immediately.

Treat suspected historical duplicates individually. Date/amount/description equality alone is not evidence for deletion: compare multiplicity against the source file, inspect strong IDs and reconciliation/transfer links, and keep a reviewed audit record before any deletion or supersession. Take a backup and verify balances before explicitly committing a repair. No production batch identifier or financial source file belongs in this repository.

## Remaining limits

- Weak fingerprints intentionally require human review. Concurrent or old previews can become stale; this PR does not discard ambiguous movements at commit time.
- Mapping keys identify the exact normalized instrument text, not arbitrary bank-specific aliases. A renamed instrument asks for a new mapping.
- Account creation remains in Accounts; return and reload the file after creating a missing account.
