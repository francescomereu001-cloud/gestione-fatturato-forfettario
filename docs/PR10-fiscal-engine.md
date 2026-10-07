# PR10 — Fiscal Engine Hardening, Tax Reserve & Tax Liability Schedule

## Audit and architecture

The former `src/domain/calculations/tax.ts` computed income from every invoice passed by the frontend (filtered by invoice `anno`), including unpaid invoices. It applied the profitability coefficient and substitute-tax rate without deducting paid mandatory social contributions. INPS was a single rate on `max(income, minimum)`, with no upper band, cap, maternity or explicit reduction. Every F24 lowered the residual regardless of tax competence or component. Default settings inferred 5%/15% from the calendar year. `netto || lordo` treated a legitimate zero net amount as missing. The displayed post-tax availability was not a verified bank balance.

The historical implementation and its tests remain solely for compatibility/comparison. App no longer imports it or its defaults. `financial_tax_summary(target_year, as_of)` is the numerical source of truth; it is deterministic for a fixed owner, date and database snapshot, apart from the informational calculation timestamp. It reads owner-visible invoices, annual configuration, payment metadata and explicit obligations. It performs no writes, model calls or production backfills. A failed RPC displays an unavailable projection while invoices and payments remain accessible.

Legacy DDL for invoices, tax settings and F24 was absent from exported migrations. The disposable test bootstrap describes the fields used by the existing application; production tables are not recreated. JSON adapters accept valid decimal numbers and ISO dates, leaving malformed/missing values incomplete. Existing invoice import, deduplication, ledger, classification, AI review and legacy F24 registration remain intact.

The Excel parser records document gross and net payable, but sets ENASARCO to zero. A gross/net difference therefore cannot automatically be called ENASARCO. Users must verify original semantics; the profile can explicitly attest gross compensation with other net adjustments. The engine never changes imported amounts.

## Additive schema and ownership

Migration: `20261007150434_pr10_fiscal_engine_tax_reserve.sql`, generated with `supabase migration new`.

* `fiscal_year_settings`: composite owner/year primary key. Nullable draft parameters, explicit cash regime, coefficient, tax rate, social scheme, rate, minimum, first band, additional rate, applicable cap, maternity, reduction, activity dates, period semantics, invoice/ENASARCO treatment, source, estimated/confirmed state, verification/finalization flags. Separate from legacy settings to avoid assuming their original uniqueness constraints.
* `tax_liability_obligations`: owner, report year, tax competence, prior balance/current advance/other role, component, amount, optional due date, estimated/confirmed state and source. Unknown due dates remain unknown.
* `tax_payments`: additive allocation status (default `unallocated`), competence, kind, explicit payment-date metadata, explicit deductible-social flag, optional linked obligation and explanation. Original amount, year, date, description and type remain untouched by the allocation service.

Owner policies cover SELECT/INSERT/UPDATE/DELETE; anonymous privileges are revoked. The RPC/helpers use SECURITY INVOKER and an empty search path; `auth.uid()` determines ownership, never a caller-supplied owner. Links require matching owner, competence and exact component. Linked competence/component changes are rejected until payments are unlinked. No Funds or Safe to Spend objects are introduced.

## Formula and numerical semantics

All arithmetic is PostgreSQL `numeric`, with fiscal components rounded to cents.

1. Fiscal revenue `C` is the signed gross compensation of paid invoices whose collection date is in the selected calendar year and on/before the snapshot date. Prior-year invoices collected this year are included; current invoices paid next year are excluded. Credit notes remain signed. `R = round(max(C,0) × coefficient / 100, 2)`.
2. `Dpaid` includes explicitly allocated mandatory contributions actually paid in the selected calendar year, even with prior tax competence. It excludes substitute tax and unrelated F24. Configured deductible ENASARCO withholding `E` is added once. `D = min(R, max(Dpaid + E, 0))`; tax base `B = max(R − D, 0)`; substitute tax `T = round(B × tax_rate / 100, 2)`. Excess contributions do not create negative tax; any separate personal-return excess deduction is outside this projection.
3. For configured INPS merchants, let minimum `m`, first band `f`, applicable cap `M`, ordinary rate `r`, additional rate `a`, reduction fraction `q`, maternity `h`, and capped income `I = min(max(R,m),M)`. Minimum component `Smin = round(m × r × (1−q) + h, 2)`. Excess component `Svar = round((max(I−m,0) × r + max(I−f,0) × a) × (1−q), 2)`. `S = Smin + Svar`. Maternity is not reduced. Rates in these formulas are fractions, while stored inputs are percentages.
4. Separate-management support uses the explicitly configured capped income/rate and maternity, with reduction restricted to zero. `none` is an explicit zero-contribution profile. Neither selection is inferred from imports.
5. Current-year explicit obligations replace matching portions of the annual family estimate. Family total is `max(annual estimate, sum(explicit current-family obligations))`, avoiding addition of the same advance twice. Prior balances and other obligations are added separately. Payments cover matching competence/family only; minimum INPS remains separate from variable INPS. Linked payments are capped to their obligation and excess never spills. Unlinked, explicitly allocated payments cover matching residual rows in deterministic due-date/key order. Reserve is the sum of nonnegative uncovered obligations.

The reserve covers accrued annual estimates and explicitly entered obligations, including future due dates; it is not a forecast of unearned future turnover or a statutory automatic advance calculator. A schedule-verification flag explicitly confirms that prior balances and known advance requirements have been reviewed. No prior-year balance or advance percentage/date is guessed.

## KPI contract

| KPI | Meaning |
|---|---|
| `revenue_invoiced`, `net_invoiced`, `enasarco_invoiced` | Issued-year totals through snapshot, separate from tax cash basis |
| `revenue_collected` | Actual net invoice cash collected in year |
| `taxable_revenue` | Gross fiscal compensation collected in year |
| `receivables_uncollected` | Outstanding net invoices issued through snapshot, including earlier years |
| `forfettario_income` | Gross fiscal compensation times configured coefficient |
| `social_security_due_estimated` | Annual/explicit activity-period INPS estimate |
| `social_security_paid` | Raw compatible allocated INPS payments of selected competence through snapshot |
| `deductible_social_security_paid` | Explicit mandatory contributions paid in selected cash year |
| `deductible_enasarco_withheld` | Configured deductible withholding, not another cash obligation |
| `substitute_tax_base`, `substitute_tax_due_estimated` | Income after eligible deductions; resulting substitute tax |
| `substitute_tax_paid` | Allocated tax payments of selected competence |
| `allocated_payments_cash_year` | All allocated F24 paid in cash year; informational, not blanket reserve credit |
| `prior_year_balance_due`, `current_year_advances_due` | Uncovered explicit schedule components |
| `total_tax_liability`, `already_paid` | Schedule requirement and compatible capped coverage |
| `future_obligations`, `required_tax_reserve` | Uncovered obligations; NULL when incomplete |
| `unallocated_payments`, `unallocated_payment_count` | Ambiguous relevant F24, never silently credited |
| `reserved_tax_amount`, `tax_reserve_gap` | Always NULL until a future Funds implementation |
| `projection_status`, `missing_fields`, `warnings`, `schedule` | Overall confidence, blockers and auditable row details |

`incomplete`: missing indispensable profile fields, invalid cash dates/amount semantics, relevant unallocated F24, unverified schedule or unsupported configuration. Some auditable subtotals remain visible, but reserve/future obligations are NULL. `estimated`: complete ongoing-year or unverified profile / estimated obligations. `confirmed`: closed, explicitly finalized year with verified confirmed parameters and no blockers, estimated explicit obligations or warnings. This is configured-data certainty, not official filing certification.

## Synthetic legacy/new comparison

The existing `tax.test.ts` fixture and PR10 SQL comparison use the same issued invoices: gross 10,000/net 9,000/withheld 1,000 collected, plus gross 5,000/net 4,500/withheld 500 unpaid. Coefficient 78%, tax 15%, INPS 24%, minimum 10,000, first band 20,000, cap 30,000, maternity 7.44; no reduction. These are synthetic test parameters, not annual legal defaults. The historical F24 1,000 is explicitly allocated to current-year mandatory INPS minimum in the new fixture; ENASARCO is explicitly deductible.

| Value | Legacy | New RPC |
|---|---:|---:|
| Issued gross | 15,000 | 15,000 |
| Net collected | 9,000 | 9,000 |
| Gross fiscal cash | Implicitly 15,000 | 10,000 |
| Forfettario income | 11,700 | 7,800 |
| Tax base | 11,700 | 5,800 |
| Substitute tax | 1,755 | 870 |
| INPS | 2,808 | 2,407.44 |
| Covered current obligation | 1,000 indiscriminately | 1,000 INPS minimum |
| Residual / reserve | 3,563 | 2,277.44 |

Differences follow from unpaid revenue exclusion, paid-contribution deduction, explicitly deductible already-withheld ENASARCO and separate maternity. They are asserted independently in Node's preserved legacy fixture and the live SQL RPC tests; matching old incorrect totals is not a goal.

## Validation and rollout

`bash scripts/test-sql.sh` starts a disposable PostgreSQL 17 Docker database, applies every migration and runs PR4–PR9 plus PR10 suites. Before/after PR10 snapshots assert original invoices, F24 fields, settings and ledger preservation, and verify historical F24 remain unallocated. All fiscal fixtures roll back. `PR10_RUN_ADVISORS=1 bash scripts/test-sql.sh` additionally runs Supabase CLI security advisors before/after on loopback only. Node tests cover RPC authority, ownership/metadata allowlist, absent rate defaults and incomplete/failure UI. Run `npm test`, `npm run lint`, `npm run build` (includes TypeScript).

This PR is not merged and its migration has not been applied to production. After review, verify actual legacy column types/schema and deployment compatibility on staging, apply the additive migration before the frontend, then enter verified annual profiles and manually allocate legacy F24. No automatic historical calculation or rewrite occurs. Without the RPC, the deployed frontend shows fiscal unavailability and keeps original invoice/payment access.

Verified in the isolated environment: **127 Node tests**, **474 SQL assertions** (including all existing regression suites), migration preservation checks, lint, TypeScript and production build. Security advisor errors: **before 0 / after 0 / new 0**. The existing Vite bundle-size warning remains. No linked hosted database was accessed.

## Residual risks and missing taxpayer facts

The model requires verification of regime eligibility, correct coefficient/rate (including personal 5% eligibility), previdential registration, seniority-dependent cap, reductions and sources, gross/net/ENASARCO semantics, actual cash dates, contribution deductibility, activity period and existing obligations. Partial-year activity requires explicitly verified effective-period thresholds/maternity; no universal proration is guessed because caps differ by registration history. Other business income, special exempt merchant classes, household tax deductions, regime exit/entry consequences, VAT, interest/penalties and official return reconciliation are not automatically modeled. Do not mark configuration verified if those facts make this model inapplicable. Current-year estimates change with further receipts/payments; annualization is not invented. ENASARCO is a withholding model only, not an automatic ENASARCO rate/minimum/cap assessment; additional unwithheld obligations must be entered explicitly. Deductible other-contribution F24 alongside ENASARCO require an explanation to avoid double counting; the engine cannot independently validate documentary identity.

Official references checked for semantics, not installed as defaults:
* [INPS circular 14, 9 February 2026](https://www.inps.it/content/dam/inps-site/it/scorporati/circolari-e-messaggi/2026/02/Circolare_15162/Allegati/16561_Circolare-numero-14-del-09-02-2026.pdf): annual merchant parameters, upper band, seniority-dependent cap, maternity and applicability distinctions.
* [Agenzia delle Entrate, quadro LM](https://infoprecompilata.agenziaentrate.gov.it/portale/web/guest/quadro-lm): cash-basis forfettario income and paid mandatory-contribution deduction. Portal page access was restricted; indexed official explanatory material was consulted.
