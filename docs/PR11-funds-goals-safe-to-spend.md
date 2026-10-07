# PR11 — Virtual Funds, Goals & Server-Side Safe to Spend

## Preliminary analysis and boundaries

Base: upstream `main` at `33604310cdee98a3cb569725b0b5b0f219ca8dff`, including merged PR10 (#17). Migration order is **PR6 → PR9 → PR10 → PR11**. PR11 requires the real PR10 `financial_tax_summary(integer,date)`, annual profiles and liability schedule. It does not duplicate or modify the fiscal engine and cannot be deployed as a workaround for production missing PR9/PR10.

`src/domain/accounts/calculations.ts` uses opening balance plus signed non-ignored transactions strictly after the account's balance anchor, with `booking_date ?? transaction_date`. `totalLiquidity` includes only active accounts selected for liquidity. Its historical UI behavior remains unchanged. The new SQL summary follows the same semantics with an explicit snapshot cutoff; no opening balance/anchor is automatically rewritten. A snapshot before an opening anchor cannot reconstruct an earlier balance and therefore blocks Safe to Spend. Non-EUR included accounts block the new KPI instead of silently adding different currencies without exchange rates.

PR8 cashflow classifies economic income/expenses independently of account balances. Internal bank transfers remain signed pairs that cancel across included accounts; no transfer classifications or groups change. PR5–PR9 import, review, rules, merchant memory and residual AI remain untouched. PR7 AppShell and navigation are retained, with only Funds and Goals enabled; Investments, Assets and Liabilities remain `Presto`. The fiscal dashboard, original invoice/F24 access and fiscal-year selector remain; Safe to Spend always refers to the server's current snapshot and its fiscal year, independently of that historical reporting selector.

## Architecture and schema

All monetary arithmetic uses PostgreSQL `numeric`. React consumes authoritative liquidity/fund/goal/Safe to Spend results and performs only display formatting. Free liquidity is derived because a separate editable free fund would duplicate bank/reserve state and require synchronization.

| Table | Main fields and integrity |
| --- | --- |
| `financial_funds` | Owner, nullable unique system key, name, nullable target/date/monthly contribution, priority, active flag, timestamps. Standard keys: tax, emergency, house, investments, large_purchases. Custom funds are supported by the schema. No stored balance. Owner/system key cannot be reassigned; deactivate only after releasing the entire balance. |
| `fund_entries` | Owner/fund composite FK, signed cent amount, effective date, allocation/release/transfer_in/transfer_out/adjustment type, note, source, immutable creation timestamp, operation UUID. Balance is the sum through the snapshot date. No authenticated direct writes/deletes. |
| `financial_goals` | Owner, name/type, positive target, date, nullable linked fund, priority, active/paused/achieved/cancelled state, timestamps. Composite owner/fund FK and partial unique index for one active goal per fund. No independent goal balance. |
| `planned_cash_commitments` | Owner, name/type, positive amount, first due date, once/monthly recurrence, start/end dates, essential flag, active/completed/skipped/cancelled state, note, timestamps. No full debt model or RRULE engine. |
| `financial_planning_settings` | Owner PK, commitments verification-through date, configurable horizon (0 = calendar month end; 1–366 = rolling days), optional explicitly entered monthly essential expense target, updated timestamp. |

No allocation/backfill runs in the migration. An authenticated idempotent bootstrap creates the five standard funds with zero balances on entering Funds/Goals. It never creates entries or bank transactions. Custom fund management UI and arbitrary adjustments are deferred; the corresponding schema permits future expansion without creating a second balance.

Public RPCs are SECURITY INVOKER with an empty search path:

* `financial_liquidity_summary(as_of)`: included-account balances, total and snapshot/currency blockers.
* `financial_fund_summary(as_of)`: balances, target progress, actual monthly net allocations and gaps.
* `financial_goal_summary(as_of)`: linked balance, target, remaining amount, progress, signed days remaining and indicative required monthly pace. Unlinked goals have no tracked savings and current amount zero. Paused/closed or undated goals have no required pace; expired unmet goals also return NULL pace. Meeting a target does not silently change the user's status.
* `financial_commitment_summary(as_of,horizon_end)`: essential/other totals and individual occurrences.
* `financial_safe_to_spend(as_of,horizon_end)`: authoritative snapshot, breakdown, status, blockers/warnings, raw value, operational value and shortfall; also fund/commitment details for display.
* `financial_allocate_fund`, `financial_release_fund`, `financial_transfer_fund`: validated atomic operations, positive whole cents, active owned funds, sufficient source/free balance. Transfer uses paired opposite entries with one operation UUID.
* `financial_bootstrap_funds`: idempotent metadata-only setup.

## Formula and anti-double-counting

```text
reserved_funds_total = sum(active fund balances through as_of)
free_liquidity = total_liquidity - reserved_funds_total

tax_reserve_gap = max(PR10.required_tax_reserve - tax_fund_balance, 0)

current-month fund gap = max(planned monthly contribution
                            - max(net allocation/release entries this month, 0), 0)

raw = free_liquidity
      - tax_reserve_gap
      - upcoming essential commitments
      - upcoming other commitments
      - planned fund contribution gaps

safe_to_spend = max(raw, 0)
funding_shortfall = max(-raw, 0)
```

Tax fund balances are already excluded by reserved funds; only an uncovered tax gap is additionally subtracted. The tax fund cannot also configure monthly contributions, avoiding an overlapping reserve. Goals never enter the formula independently of their funds, and their indicative monthly pace is not a configured commitment.

Contributions include emergency, investments, house/large purchases and custom active funds. Current-month allocation entries count once; releases reinstate the gap conservatively, including releases of older reserves. Transfers do not create fresh savings or contribution credit; this prevents a reserve transfer from masquerading as a new allocation. For a multi-month horizon the server reserves the remaining current-month contribution plus the full contribution for **every later calendar month touched**. There is no day proration. Plans express configured commitments independently of goal achievement; users can edit them explicitly.

Example: liquidity €30,000, tax fund €10,000, house fund €5,000 and required tax reserve €8,000 give free liquidity €15,000 and tax gap €0. With essential obligations €500 and a €1,000 monthly contribution already satisfied by €600, raw/Safe to Spend €14,100 (the €600 is part of the €5,000 fund balance). Neither the €8,000 fiscal reserve nor the €5,000 linked goal balance is subtracted twice.

Monthly commitments retain the original first-due-day, clamped to month end (31 January → 28 February → 31 March), bounded by start/first due/end dates and the inclusive snapshot/horizon. Once-only dates are inclusive too. Status applies to the whole schedule: completing/skipping a single monthly occurrence requires ending the old series before that occurrence and creating the next series. Users must mark settled obligations appropriately; the UI warns against re-entering expenses already reflected in bank liquidity and taxes already covered by PR10. Occurrence-level payment reconciliation is outside PR11.

## Confidence, emergency coverage and over-allocation

* `incomplete`: PR10 is incomplete/reserve NULL, commitments are not explicitly verified through the horizon, or included liquidity has an unsupported currency/anchor newer than the snapshot. Safe to Spend, raw and funding shortfall are NULL, never fake zero. Required fiscal fields and planning blockers remain visible.
* `estimated`: all indispensable sources are present and verified for the horizon, while PR10 remains estimated (e.g. ongoing year).
* `confirmed`: all planning inputs are verified and PR10 is confirmed, including a finalized fiscal year. This means configured-source completeness, not a guarantee that no other expense will emerge.

With liquidity €10,000 and reserved funds €12,000, free liquidity stays −€2,000, funds_overallocated is true and over-allocation amount is €2,000. Entries are never silently changed. A complete model clamps operational spending to zero, retains the negative raw and shows the full shortfall. An incomplete model still reports over-allocation but leaves unknown spending/shortfall NULL.

Emergency coverage is balance / explicitly entered positive monthly essential-expense target. Missing target yields NULL. Historical transactions never infer essential expenses. This target is informational and does not subtract again from Safe to Spend.

## Security and concurrency

All five tables enable RLS; SELECT/INSERT/UPDATE policies combine authenticated role and `auth.uid()` ownership. Anonymous/PUBLIC grants are revoked. Owner/FK indexes avoid scanning unrelated owners. Cross-owner fund/goal/entry links are denied by composite FKs. Entries are SELECT-only for authenticated users, preventing clients from bypassing validation, creating unmatched transfer rows or rewriting audit history. There are no public SECURITY DEFINER functions added.

The sole privileged writer is `financial_private.move_funds`, explicitly owned by postgres, in a non-exposed schema with minimal schema/function grants, empty search path and explicit authentication/owner checks on every query. This privilege is necessary to write immutable entries while clients have no INSERT/UPDATE/DELETE grants. Public invoker wrappers call it; direct SQL invocation retains exactly the same validations. Do not expose `financial_private` in the Data API. No user metadata/JWT owner argument authorizes access.

An owner-scoped transaction advisory lock serializes fund mutations and metadata changes. The concurrent allocation test submits two €60 requests against €100 and asserts one success/one insufficiency error with exactly one €60 entry. Bank ledger updates are independent; subsequent/outside bank changes may create over-allocation and are reported instead of rewriting funds. Read RPCs use a consistent statement snapshot; configuration/read results are not a durable guarantee of future bank availability.

## Files and migration

Migration, generated with Supabase CLI 2.120.0:
`supabase/migrations/20261007215647_pr11_funds_goals_safe_to_spend.sql`.

* `src/types/planning.ts`, `src/services/planning.ts`: typed RPC/configuration boundary and write allowlists (no fund/goal balance writes).
* `src/components/PlanningPages.tsx`: dominant STS panel, server KPI cards, Funds/Goals actions, commitment/verification controls and explicit unknown/shortfall states.
* `src/App.tsx`, `src/components/layout/navigation.ts`, `src/styles/components.css`: existing shell integration, refreshed dashboard and responsive planning styles.
* `src/services/planning.test.ts`, `src/components/PlanningPages.test.tsx`, `src/components/AppShell.test.tsx`: service authority, null/error behavior, interactive allocation refresh, navigation/focus regression.
* `supabase/tests/pr11_planning.sql`: liquidity, funds, goals, tax/gap/over-allocation, recurrence, security and configuration integration tests.
* `supabase/tests/pr11_upgrade_preservation.sql`, `supabase/tests/pr11_upgrade_verify.sql`: compare every original public-table row before/after the migration, including synthetic original invoice/F24/ledger/anchor data, and assert no automatic reserves.
* `scripts/test-pr11-concurrency.sh`, `scripts/test-sql.sh`: disposable local database runner, original regression suites and concurrent allocation validation.
* This document records architecture, boundaries, numerical semantics, validation and rollout.

## Validation

Run from repository root:

```sh
npm ci
npm test
npm run lint
npm run build
PR10_RUN_ADVISORS=1 bash scripts/test-sql.sh
```

The SQL runner applies the full migration chain to a disposable PostgreSQL 17 container and rolls back synthetic test suites. Security Advisors use only the Docker loopback database URL, never a linked hosted project. Before/after advisory errors: **0 / 0**, new errors **0**. SQL: **543 passing assertions**, including the original **474 PR4–PR10 assertions**, migration preservation and concurrent atomicity. TypeScript is part of the build. The existing Vite bundle-size advisory remains; it does not fail the build. Node: **138 tests passed**, zero failures (including all existing PR4–PR10 regressions). Lint, TypeScript and production build passed.

Documentation checked: current Supabase changelog, the recent PostgreSQL update and Data API exposure changes, and current RLS/function docs. The migration explicitly grants exposed-table access with RLS and leaves the private schema unexposed.

## Residual risks and production rollout

Planning depends on user-entered commitments, correct paid/completed status, annual PR10 profiles and accurate bank opening anchors. Tax reserve is PR10's earned/explicit annual requirement for the snapshot year, not invented future turnover/tax forecasts. Future-year tax obligations are not guessed for horizons crossing a year boundary. Multi-month contribution and whole-series recurrence semantics above must be reviewed with users. There is no FX conversion, historical versioning of fund configuration/account activity, occurrence-level reconciliation, spending authorization, automatic allocation or full liabilities module. Existing bundle-size warning remains.

1. Review and merge only after normal approval; this task does **not** merge.
2. Inspect production migration history and actual legacy invoice/F24 columns; PR9/PR10 are known to be pending. Test the exact production-compatible upgrade on isolated staging first, with snapshots and Security Advisors.
3. Apply pending migrations in strict order **PR6 → PR9 → PR10 → PR11**, using the existing approved deployment procedure. Do not apply PR11 alone or duplicate its fiscal dependency.
4. Run staging SQL regression/integrity checks, verify RLS/grants/private schema exposure and compare before/after advisors.
5. Deploy the frontend only after the RPC/schema chain exists. If a RPC is missing, UI displays unavailable instead of reconstructing central figures.
6. Enter/verify real fiscal profiles and commitments manually; let authenticated users bootstrap zero funds, then explicitly choose allocations. No legacy financial backfill or real allocation is part of deployment.
7. Smoke-test login, unavailable/estimated state, fund operations, linked goal and dashboard refresh with an approved test owner. Monitor errors/over-allocation. If frontend rollback is needed, restore the previous build and retain additive tables/audit entries; never delete user entries as a rollback.

No production migrations, hosted database writes, real allocations or merge were performed during development.
