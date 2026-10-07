import test from "node:test";
import assert from "node:assert/strict";
import { categoriesForDecision, exactReviewRule, serverErrorMessage } from "./residualReview.ts";
import type { ResidualGroup } from "./residualReview.ts";

test("provider rules cannot be generated for missing or conflicting provenance", () => {
  const group = { parser_key: "isybank_operations_v1", account_id: "synthetic", provider_category: null, provider_operation: null, metadata_conflicting: false } as ResidualGroup;
  const decision = { transaction_type: "internal_transfer" as const, category_id: null, transfer_account_id: null };
  assert.throws(() => exactReviewRule(group, decision, "provider_operation"), /Metadata mancanti/);
  assert.throws(() => exactReviewRule({ ...group, provider_operation: "synthetic", metadata_conflicting: true }, decision, "provider_operation"), /conflittuali/);
});

test("review category choices never offer expense categories for debt principal or transfers", () => {
  const categories = [{ id: "expense", name: "Expense", category_type: "expense" as const }, { id: "debt", name: "Debt", category_type: "liability" as const }];
  assert.deepEqual(categoriesForDecision("debt_principal", categories).map(c => c.id), ["debt"]);
  assert.deepEqual(categoriesForDecision("internal_transfer", categories), []);
  assert.deepEqual(categoriesForDecision("unclassified", categories), []);
});

test("Supabase error objects preserve the server message", () => {
  assert.equal(serverErrorMessage({ message: "Synthetic rejection", code: "P0001" }), "Synthetic rejection");
});

test("internal transfers with an unmodeled target remain excluded from economic cashflow", async () => {
  const { cashflowSummary } = await import("../domain/transactions/calculations.ts");
  assert.deepEqual(cashflowSummary([{ account_id: "synthetic", amount: 500, transaction_date: "2026-01-01",
    description: "Synthetic self-transfer", transaction_type: "internal_transfer", transfer_account_id: null,
    source: "bank_import", reconciliation_status: "pending" }]), { income: 0, expenses: 0, cashflow: 0 });
});
