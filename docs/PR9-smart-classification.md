# PR9 — Smart Classification Engine, Merchant Memory & AI Residual Suggestions

## Architecture and existing behavior

Built from `main` at `5803eb2` (merged PR8, GitHub PR #15), after reviewing PR5 provider classification, PR6 residual RPCs, PR7 UI, and PR8 ledger period/date handling. This extends `classify_transactions` and `transaction_classification_rules`; it does not introduce a parallel classifier. The migration replaces the existing function definitions to add one memory phase and one exact match field. Import routing, deduplication, transfer matching criteria, balances, fiscal calculations and period-aware cashflow implementations are unchanged.

Execution order:

1. Existing conservative transfer reconciliation.
2. Existing personal rules, with their existing priority/creation-time/UUID ordering.
3. Exact remembered merchant rules, scoped by owner, parser, debit/credit and account type.
4. Existing PR5/PR6 provider classification and fallback rules.
5. On explicit **Analizza residui con AI** only: atomically claim eligible remaining `unclassified` transactions, group equivalent merchants and ask the model once.
6. Re-run the deterministic engine once inside the atomic persistence RPC; validate each proposal against current owner, ledger snapshot, merchant identity, category and direction.
7. Auto-apply valid high confidence; expose medium confidence in the existing Review Center; keep low, ambiguous, invalid and failed cases residual.

Precedence is `manual / transfer_match / existing user_rule > merchant_memory > provider fallback / AI`. Existing personal rules can supersede previous memory/AI results on an explicit deterministic classification run. Confirmed transfer groups, ignored rows and protected decisions never enter automatic memory/AI processing. The existing provider rules do not overwrite memory or AI results. Explicit user edits/confirmations continue to produce `manual`.

## Merchant normalization and memory

`merchant_fingerprint` is the central, SQL-tested immutable normalizer. It uses provider scope, merchant, provider operation and description, exact boundaries, lowercase and collapsed whitespace. It removes explicitly labelled trailing transaction/reference/terminal codes and trailing dates. Bounded `AMZN MKTP IT` and `AMAZON EU SARL` aliases share `v1:amazon-marketplace`; Amazon Prime stays distinct. Unknown named merchants use their remaining exact text; no fuzzy matching, broad prefix guessing or amount-based identity.

`transaction_merchant_fingerprint` adds provenance conflict checks and vetoes ambiguous transfer/cash/debt/payment-provider metadata. Unsupported providers, generic names, identifiers, IBAN-like strings, long digit sequences and ambiguous cash/transfer/debt text produce no identity and remain manual-review candidates. These conservative exclusions intentionally trade recall for fewer false positives.

Memory uses the existing rules table with `match_field = merchant_fingerprint`, exact matching, owner/parser/direction/account-type scope, category/type and existing audit timestamps. A partial unique index makes **remember** idempotent. Existing rule RLS, ownership validation, editor, priorities and activation/deletion remain in use. The extra nullable `memory_account_type` column records the one scope the existing table lacked. No merchant-memory table or historical fingerprint backfill is needed.

**Approva e ricorda** confirms the current transaction as manual and saves its deterministic rule. Future imports use `merchant_memory` with `classification_rule_id` referencing that rule. The Transactions editor also provides **Conferma categoria e ricorda merchant** for an explicit non-transfer classification. That action confirms type/category using the persisted imported merchant identity; it does not save other unsaved form edits. Rules can be edited, disabled or deleted in the existing editor. Revocation stops future matches and does not erase previously classified transactions.

## Migration and audit

Created with Supabase CLI `migration new pr9_smart_classification_engine`:

`supabase/migrations/20261007142215_pr9_smart_classification_engine.sql`

Additions:

- Extended `classification_method` with `merchant_memory` and `ai_suggestion`; legacy values remain valid.
- Extended rule match field, memory account-type scope, exact-memory constraints and identity index.
- `transaction_ai_suggestions`: owner/transaction FKs, one audited attempt lifecycle per transaction, claim/attempt token, normalized fingerprint, source account and ledger timestamp, proposed type/category, confidence, pinned model/logic version, creation/update/decision timestamps and state.
- Attempt counter and recent attempt timestamps enforce retry accounting and cost limits; terminal model decisions are never silently retried or overwritten.
- Owner/status index and read-only owner RLS for suggestions.
- Claim, batch persistence, review and explicit remember RPCs, plus central normalization and confidence policy helpers.

States distinguish `processing`, `suggested`, `auto_applied`, `approved`, `remembered`, `rejected`, `low`, `invalid`, `failed` and `stale`. Technical retries keep a cumulative attempt count and get a fresh attempt token; late responses cannot replace a newer attempt. Medium/high/low valid proposals retain category/type/confidence where present. A `cannot_classify` with null type/category records low confidence without a ledger decision. A malformed batch records invalid state; API errors record failed state. Audit stores no complete prompt or model response. The displayed short reason is a safe server-generated explanation based on the normalized merchant, not arbitrary model prose or a chain of thought.

The migration performs no classification, backfill or live ledger writes. Upgrade-preservation tests compare complete existing transactions, accounts, import rows and rules before/after schema application, excluding only the new nullable rule column.

## Edge Function and minimized model payload

`supabase/functions/classify-residuals/index.ts` implements authenticated `POST classify-residuals`. `verify_jwt = true`, plus server-side `auth.getUser(token)`. Request bodies cannot select another owner or supply transaction data. A user-JWT client performs the owner-scoped deterministic claim; a separate server-only service-role client submits a bounded validated batch. SDK version `2.104.1` and its Deno lockfile are committed.

One OpenAI request per nonempty eligible batch; zero requests when deterministic/provider/memory rules solve the candidates. Merchant grouping uses exact fingerprint, parser, direction, account type and currency. Database UUIDs remain server-side; the model identifies groups only by temporary batch indices.

Payload example (synthetic):

```json
{
  "movements": [{
    "index": 0,
    "normalized_merchant": "bistro horizon",
    "description": "bistro horizon",
    "provider": "isybank_operations_v1",
    "debit_credit": "debit",
    "currency": "EUR",
    "account_type": "checking"
  }],
  "allowed_categories": [{
    "system_key": "expense_dining",
    "category_type": "expense"
  }]
}
```

Description is deliberately the normalized merchant token, never the original bank description. Full provider category/operation/details are used locally for deterministic rules and ambiguity screening but are not sent to OpenAI. Category keys/types are drawn only from the owner's actual database categories.

Excluded: `raw_data`, original descriptions/import files, full provider metadata, IBAN/account/card numbers, database UUIDs, source account names/IDs, exact amounts, dates, balances, net worth, other-account data and secrets. Generic/ambiguous descriptions are not sent for speculative consumption inference.

Output uses OpenAI strict JSON Schema with exactly `index`, `proposed_transaction_type`, `proposed_category_system_key`, `normalized_merchant`, `confidence`, `reason`, `cannot_classify`. Only `expense`, `income`, `refund` or null are supported; they are a conservative subset of the database enum. Category enum comes from the actual owner categories. Transfers, debt and adjustments are deliberately excluded from AI decisions.

The server rejects malformed envelopes, missing/duplicate/out-of-range group indices, extra fields, unknown categories, incompatible category kinds/signs, invalid confidence and overly long prose. SQL repeats the validation independently before any ledger change. Model-generated merchant text never defines learned identity; the deterministic fingerprint is authoritative. Any invalid group invalidates the batch proposals conservatively, leaving transactions residual.

## Confidence and cost policy

Single authority: `residual_ai_policy()`.

| Setting | Value |
| --- | --- |
| High: eligible for automatic application | `confidence >= 0.98` |
| Medium: explicit confirmation required | `0.70 <= confidence < 0.98` |
| Low/ambiguous | `< 0.70` or `cannot_classify` |
| Maximum transactions per claim/persistence batch | 40 |
| Maximum attempted transactions per owner in rolling hour | 80, including technical retries |
| API timeout | 20 seconds |
| Technical retry cooldown | 15 minutes |
| Model snapshot | `gpt-4.1-mini-2025-04-14` |
| Logic version | `pr9-v1` |
| Maximum model completion | 6,000 tokens |

High confidence additionally requires all deterministic checks, unchanged source account/ledger timestamp/fingerprint, compatible category/type/sign and absence of protected/contradictory/transfer signals. Confidence is model-reported, not a calibrated guarantee.

Medium suggestions offer **Approva**, **Approva e ricorda**, **Rifiuta**. Approval affects only that transaction. Rejection changes audit state only, and prevents automatic re-sending. Low/invalid/rejected/stale decisions remain in ordinary review. Technical failures can retry after cooldown; claims prevent concurrent duplicate model calls. There is no background AI invocation on import, page load or deployment.

For N eligible transactions with G equivalent merchant groups, each bounded batch sends G examples, not N repeated examples. Learned merchants cost zero model calls. Worst case is one request per 40 candidates (last batch smaller), subject to the 80 attempted-transaction rolling-hour cap. Monetary cost depends on current model pricing, prompt length and response tokens; no live token usage/cost benchmark was performed.

## Security and ledger protection

Rule RLS remains owner scoped. Suggestions grant authenticated users owner-filtered SELECT only: browsers cannot insert/alter audit records or forge AI results. The service-only `record_residual_ai_batch` checks its bounded size and explicitly scopes every transaction, claim and category to the owner verified by the Edge Function. The per-result primitive is not callable by service/browser roles directly.

Exposed RPCs are invoker wrappers. Claim/review/audit writes use narrowly granted `SECURITY DEFINER` implementations in the non-exposed `financialmind_classification_private` schema because user clients have no direct audit write grants. Each private implementation uses an empty search path, explicit ownership/authentication checks and revoked PUBLIC/anon EXECUTE; the persistence endpoint is service-role only. Deterministic matching/validation helpers remain invoker functions. This is a deliberate scoped audit boundary, not a blanket RLS bypass for browser queries.

Owner advisory locks, row locks and fresh attempt tokens serialize classification/review/persistence. A manual decision during the API call, new deterministic solution, account change, changed merchant/provenance or incompatible category prevents application. No endpoint edits amount, transaction/booking dates, source account, opening balance, balance anchor, routing, deduplication, confirmed transfer groups or fiscal data. No target account is invented and no mirror transaction is created.

Keys are read only from Edge Function environment (`OPENAI_API_KEY`, Supabase runtime keys). They never enter frontend source, build outputs, responses or logs. AI outages leave the normal ledger and Review Center usable.

## Verification

Executed locally with synthetic fixtures; no production connection or paid OpenAI call:

- `npm test`: **122 tests passed**, including 14 new PR9 pipeline/UI tests and all prior auth/import/dedup/PR5/PR6/PR7/PR8 tests.
- `bash scripts/test-sql.sh`: **401 passing assertions** on disposable PostgreSQL 17; includes **69 PR9 behavioral assertions**, four PR9 upgrade-preservation assertions, and previous PR4.4/PR5/PR6/upgrade regressions.
- SQL covers normalization boundaries, memory/idempotence/revocation, owner/provider/account-type/direction scopes, protected rows, personal-rule precedence, genuine residual claims, schema/category/sign/transfer invalidity, high/medium/low, approve/remember/reject, stale metadata/manual decisions, actual service-role batch persistence, public privilege denial, retry tokens/cooldown and rate/batch limits.
- Node tests cover exact merchant grouping, minimized payload allowlist, structured response validation, API failures, no calls for empty deterministic residuals, confidence boundaries and all Review Center AI actions/outage handling.
- `npm run lint`: passed.
- `npm run build`: TypeScript and Vite passed; existing bundle-size warning remains.
- `deno check --config supabase/functions/classify-residuals/deno.json supabase/functions/classify-residuals/index.ts`: passed with strict types and locked SDK.
- `git diff --check`: passed.

## Modified files

- `supabase/migrations/20261007142215_pr9_smart_classification_engine.sql`
- `supabase/config.toml`
- `supabase/functions/classify-residuals/{index.ts,deno.json,deno.lock}`
- `supabase/functions/_shared/residual-ai.ts`
- `supabase/tests/{bootstrap.sql,pr9_smart_classification.sql,pr9_upgrade_preservation.sql,pr9_upgrade_verify.sql}`
- `scripts/test-sql.sh`
- `src/services/{aiReview.ts,residualAI.test.ts}`
- `src/types/{classification.ts,ledger.ts}`
- `src/components/{ClassificationRules.tsx,LedgerPages.tsx,ResidualReviewPage.tsx,ResidualReviewPage.test.tsx}`
- `src/components/ui/labels.ts`
- `docs/PR9-smart-classification.md`

## Rollout procedure (not executed)

1. Review/merge separately; this PR is not merged by the implementation agent.
2. On an isolated staging project with synthetic fixtures, review migration history and run `supabase db push --project-ref "$STAGING_REF" --dry-run --skip-vault`. Check the pending migrations explicitly; do not use `--include-all` blindly.
3. Apply the reviewed schema to staging with `supabase db push --project-ref "$STAGING_REF" --skip-vault`. It creates schema/functions only and runs no classification. Run Supabase security advisors against staging and review RPC grants/RLS.
4. Configure the staging OpenAI secret using an ignored local file: `supabase secrets set --project-ref "$STAGING_REF" --env-file .env.ai.staging.local`. Supabase runtime supplies its own server keys; do not create frontend variables for these secrets.
5. Deploy only this function: `supabase functions deploy classify-residuals --project-ref "$STAGING_REF"`. Keep JWT verification enabled. Test authenticated/unauthenticated/foreign-owner behavior on synthetic data, plus AI outage and stale decisions. Validate the pinned model availability/structured-output support and actual confidence behavior.
6. Deploy frontend after schema/function availability. Confirm ordinary Review Center still works independently of OpenAI and all memory/AI action labels appear correctly.
7. Following separate production authorization, repeat dry-run/schema/secrets/function/frontend steps against the intended production project. Schema deployment alone must not invoke `classify_transactions`, `claim_residual_ai_batch` or the Edge Function. No automatic production classification is part of this rollout.

Rollback of AI availability: remove/disable the deployed `classify-residuals` function or its OpenAI secret and revert the frontend if needed; deterministic classification and existing audit/memory remain. Disable any unwanted learned rules through the existing editor. Do not destructively drop audit data or downgrade the method constraint while new method values exist. A misclassified AI transaction can be explicitly corrected through the existing manual edit flow; preserve its audit record.

## Separate live-dataset validation (not executed)

Prefer a sanitized copy in an isolated project. Capture row counts, sums by account, balances, booking/transaction dates, confirmed transfer groups and PR8 period cashflows before enabling PR9. Run one explicit authenticated deterministic classification, then verify only permitted classification fields change; confirm protected rows stay byte-for-byte unchanged.

If an actual production trial is later explicitly authorized, begin with one owner and a single bounded batch through **Analizza residui con AI**. This action can classify historical residuals and valid high-confidence results automatically; it is not a dry run. Review the audit states and every proposed/applied decision, confirm a medium suggestion with remember, import a synthetic equivalent merchant in staging to verify no subsequent model call, and compare ledger invariants. Keep financial payloads and identifiers out of commits, CI artifacts and public logs. No real-dataset classification was executed for this PR.

## Residual risks

Conservative provider/name support intentionally leaves generic, unsupported, ambiguous and some uncategorized-but-already-classified card transactions for manual review. Merchant identity does not use fuzzy matching and cannot guarantee that two businesses with identical bank labels are distinct. Direction/parser/account-type isolation and explicit memory confirmation reduce that risk.

Model confidence is not calibrated; the 0.98 auto-apply threshold and merchant-only payload need a staging benchmark before a live rollout. Exact model availability/pricing, full hosted Edge HTTP integration and Supabase security advisors were not exercised against a linked hosted project. These require staging validation, not production operations from this task.

The deterministic engine runs before claiming and again before persistence, so very large ledgers need staging latency measurements. AI completion truncation, timeout, schema refusal or partial infrastructure failure produce no arbitrary fallback and leave movements residual. Terminal low/invalid/rejected/stale outcomes are intentionally not automatically re-sent; users can classify them manually. Existing Vite bundle-size warning remains outside PR9 scope.
