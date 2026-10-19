# Invoice detail, corrections and import resolution

Income previously displayed read-only invoice rows. Reimported corrections were stored as conflicts without any way to apply them. The parser's gross/net delta therefore did not repair historical invoice amounts.

## User flow

1. In Income, click the invoice number to open its detail.
2. Review total document, ENASARCO, net payable and description.
3. Either edit the amounts, or enable `Ricalcola ENASARCO = totale documento − netto a pagare` and provide a reason. The checkbox previews the delta; the server recomputes it on save.
4. Alternatively, compare a committed import conflict with the current invoice and choose `Applica import` or `Mantieni esistente`, with a reason. These actions use saved/current report values, not unsaved form changes.
5. Review before/after values in the history. Income and fiscal summaries reload using the existing App callback.

A row with no unique linked invoice cannot be auto-resolved. Applying an import refuses differing identity fields or contradictory rows for the same identity in one batch. Numeric corrections intentionally preserve invoice number, date, customer, original source metadata, payment flags and document identity. Credit notes use signed amounts. Other explicitly documented net adjustments can still be recorded manually; existing mismatch warnings remain in force.

## Database and rollout

Apply `20261019135901_invoice_edit_and_conflict_resolution.sql` **before** releasing the frontend. It is additive and makes no historical monetary changes. It adds:

- `invoices.edit_version` plus a trigger that advances it on every update;
- owner-isolated, client-read-only `invoice_revisions` with before/after snapshots and reason;
- invoker `invoice_detail` and `save_invoice_correction` RPCs;
- a private privileged writer using the same owner advisory lock as the importer, explicit ownership checks, optimistic version comparison, input validation and atomic audit;
- resolved import row states, with batch conflict/update counts refreshed atomically.

Original raw import data is retained. Existing committed batches can be resolved through each linked invoice; no new upload is necessary. A manual edit does not implicitly dismiss historical conflicts. Applying or keeping a row resolves only that row, leaving other conflicts available for explicit review. Repeating commit on a committed batch does not revert corrections. Reimporting corrected identical documents remains idempotent.

PR #20 only records a legacy ownership backfill. This change neither depends on that PR nor assigns ownership. Already owned legacy documents are editable. Ownerless documents remain inaccessible until ownership has been established separately.

Deployment of the migration does not itself correct production data. The user applies each reviewed correction from the new detail panel. Do not replace all zero withholdings blindly: some invoices legitimately have no delta.

## Validation

- 151 TypeScript/React tests passed, including interactive delta preview, RPC save, summary refresh, conflict application and stale-version errors.
- Build and ESLint pass (existing Vite large-chunk warning remains).
- All migrations applied to an isolated PGlite PostgreSQL runtime; existing PR12 SQL suite and `invoice_corrections.sql` pass. New SQL tests cover audit, server-side delta, signed credits, invalid values, stale writes, cross-owner access, committed conflict resolution, keep-existing, counts, duplicate-free reimport and commit retry.
- The standard Docker/PostgreSQL runner now includes the new SQL suite. Docker and a listening PostgreSQL server are unavailable in this execution environment; multi-connection concurrency tests and CLI security advisors were not executed here. Owner locking is reused from the importer and stale-write checks were executed in PostgreSQL.
- No production database writes or automatic data repair were performed.

## Acceptance

An owned legacy invoice with total 1000, net 900 and recorded ENASARCO 0 can be opened and corrected to ENASARCO 100. It retains its ID and original gross/net, records its previous values, and immediately contributes 100 to the server summary. An imported conflict with net 850 can instead be reviewed and applied as ENASARCO 150; a second identical import creates no duplicate.
