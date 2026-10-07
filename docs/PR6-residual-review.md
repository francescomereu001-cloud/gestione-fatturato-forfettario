# PR6 — Residual Review, Provider Rules v2 and Ambiguous Transaction Semantics

PR6 adds a Review Center for unclassified ledger movements. Groups are computed by PostgreSQL by parser, account/currency, provider category and optionally normalized provider operation. Each group exposes count, signed total, date range and up to three examples. Pages contain up to 50 groups; each selected group supplies at most 500 transaction IDs. For a larger group, review the first 500 and reload to continue. Provider JSON remains in `import_rows` and never reaches this view.

Users can apply a manual decision once, or atomically save and apply an exact rule scoped to the selected provider field, parser and account. Saving a category rule intentionally covers other operations with the same category, parser and account. Provider operation grouping supports recurring creditors and own-account counterparties without hardcoded identities. Withdrawals default to unclassified and carry a cash-reconciliation label; installments explain that principal and interest cannot be inferred.

## Database contract

Migration: `20261007084602_pr6_residual_review.sql`.

New rule fields: `provider_category`, `provider_operation`, `provider_details`. New nullable FK: `target_transfer_account_id` → `accounts`, with ownership validation. Existing RLS policies remain owner-scoped. Provider-field rules require a parser scope. Normalization collapses spaces/newlines and folds case; literal exact/contains/starts_with operators do not interpret SQL wildcards.

Metadata lookup considers every imported/duplicate row linked by `matched_transaction_id`, including later batches. Any conflicting normalized semantic tuple blocks provider-field rules and provider fallback. Missing metadata never matches. Metadata is not copied into transactions.

Public RPCs, all `SECURITY INVOKER`, with empty search paths and authenticated-only grants:

- `residual_review_groups(group_by, page_limit, page_offset)`: aggregate residual groups without raw JSON.
- `bulk_classify_transactions(transaction_ids, target_type, target_category_id, target_transfer_account_id)`: bounded, owner-checked, atomic manual classification. Rejects the entire selection for any foreign/missing/protected movement or invalid category/target; locks rows in UUID order and performs one set-based update.
- `create_classification_rule_and_apply(transaction_ids, rule_input)`: validates and inserts the owner-scoped rule, verifies every selected movement matches, and applies it atomically. Any error rolls back both the rule and all updates. Caller-supplied owner/audit fields are not inserted.
- Existing `classify_transactions(target_batch_id)` now uses the same matcher and semantic validation for user rules.

Internal transfers with no modeled counteraccount have a null target and pending reconciliation; a valid distinct owned target in the same currency yields confirmed reconciliation. Investment-transfer user rules require a broker target. Neither route creates a mirror nor a synthetic transfer group. Both remain outside economic cashflow. Changing type clears incompatible category/target/group fields; amounts, dates and source-account anchors are never rewritten by review RPCs.

Classifier precedence remains transfer match, manual, user rule, provider rule, unclassified. Manual, user-rule, ignored and matched/linked transactions are protected from automatic classification. A newly saved user rule can override provider classification, including confirmed one-sided provider transfers. Existing matched pairs remain protected. Repeated classification preserves audit fields when no decision changes.

## Deterministic provider additions

For IsyBank debits, explicit `estinzione anticipata` and `restituzione prestito infruttifero` become debt principal with no expense category. Generic provider buckets allow specific merchant fallbacks, using `Operazione` before description: Apple.com/bill → subscriptions, PlayStation (including explicit PayPal merchant) → leisure, Cerved → work, Costo Carta → fees, explicit Amazon merchant payment/AMZN MKTP → shopping, Amazon Prime → subscriptions, explicit caffetteria → dining. Word boundaries and transfer/cash/P2P guards prevent loose merchant substring matches. Existing specific provider categories retain precedence.

Generic received/outgoing bank transfers, withdrawals, financing installments, Revolut, Visa Direct/P2P/BANCOMAT Pay, ambiguous PagoPA/Poste and unrecognized Isy merchants remain neutral. AMEX ATM fees retain their existing expense-fees classification. No cash account, liability amortization model, AI, PDF import or dashboard redesign is introduced.

## Validation

Run `npm test`, `npm run lint`, `npm run build`, `git diff --check`, and `bash scripts/test-sql.sh`. The SQL runner creates a disposable PostgreSQL 17 container, simulates Supabase authenticated/anon roles and `auth.uid()`, applies every migration, executes an upgrade-preservation check and the PR4.4/PR5/PR6 suites, then removes the container. It never connects to a Supabase project. The bootstrap's minimal legacy invoice/auth tables are test scaffolding; core ledger/import/rule schemas and RLS come from repository migrations.

The upgrade check seeds a synthetic pre-PR6 ledger and verifies counts, complete transaction/account/import-row snapshots, existing rules (excluding their new nullable column) and audit fields are unchanged by the migration. Regression suites use synthetic fixtures and roll back. UI tests exercise actual rendered controls with React Testing Library and JSDOM, including server-error objects and post-classification reloads.

The migration contains schema/function/index changes only: it does not execute the classifier or modify ledger/provenance rows. No live migration or live classification was performed while preparing this PR. No personal financial data, bank identity, beneficiary, IBAN, BIC, live transaction UUID or live acceptance count is committed.

After deployment, apply the migration through the normal release process. A separate explicit classifier run can then classify deterministic cases. Review remaining groups through Review Center. Do not use zero residuals as an acceptance target.

Verified for this PR: **85 application/UI tests** and **328 SQL assertions** (45 PR4.4, 185 PR5, 94 PR6, 4 upgrade-preservation checks). Lint, production build and whitespace checks pass. The build retains its existing large-chunk advisory. Local Security Advisors on the PR6 schema reports zero issues. Read-only Security Advisors on the live project reports one pre-existing Auth warning: leaked-password protection disabled; no database changes or configuration changes were made there.
