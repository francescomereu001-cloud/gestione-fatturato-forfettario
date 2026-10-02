import test from "node:test";
import assert from "node:assert/strict";
import { classifyDuplicate, createImportPreview, possibleTransfer, transferTypeForAccounts } from "./bankImports.ts";
import type { ImportRow } from "../types/imports.ts";
import type { LedgerTransaction } from "../types/ledger.ts";

const movement = (overrides: Partial<LedgerTransaction> = {}): LedgerTransaction => ({ id: crypto.randomUUID(), user_id: "u", account_id: "a", transaction_date: "2026-09-21", amount: -100, description: "test", transaction_type: "unclassified", source: "bank_import", reconciliation_status: "pending", ...overrides });
const row = (external_id: string | null, dedupe_fingerprint: string): ImportRow => ({ row_index: 0, transaction_date: "2026-09-21", booking_date: null, amount: 1, description: "x", merchant: null, external_id, dedupe_fingerprint, suggested_transaction_type: "unclassified", suggested_category_id: null, status: "ready", raw_data: {} });

test("external id is a certain duplicate while fingerprint is only possible", () => {
  assert.equal(classifyDuplicate(row("ext", "new"), new Set(["ext"]), new Set()), "duplicate");
  assert.equal(classifyDuplicate(row(null, "same"), new Set(), new Set(["same"])), "possible_duplicate");
});

test("transfer candidates are conservative", () => {
  const source = movement(); const valid = movement({ account_id: "b", amount: 100 });
  assert.deepEqual(possibleTransfer(source, [valid]), [valid]);
  assert.deepEqual(possibleTransfer({ ...source, reconciliation_status: "ignored" }, [valid]), []);
  assert.deepEqual(possibleTransfer(source, [{ ...valid, reconciliation_status: "ignored" }]), []);
  assert.deepEqual(possibleTransfer(source, [{ ...valid, transfer_group_id: "linked" }]), []);
  assert.deepEqual(possibleTransfer(source, [{ ...valid, transaction_type: "internal_transfer" }]), []);
  assert.deepEqual(possibleTransfer(source, [{ ...valid, user_id: "other" }]), []);
});

test("broker pairs are investments while cash, checking and credit-card pairs are internal", () => {
  assert.equal(transferTypeForAccounts("checking", "broker"), "investment_transfer");
  assert.equal(transferTypeForAccounts("checking", "savings"), "internal_transfer");
  assert.equal(transferTypeForAccounts("checking", "credit_card"), "internal_transfer");
});

test("preview persists the parser key selected by the registry", async () => {
  let insertedBatch: Record<string, unknown> | undefined;
  const builder = {
    select() { return this; }, eq() { return this; }, neq() { return this; }, limit() { return Promise.resolve({ data: [], error: null }); },
  };
  const client = { from(table: string) {
    if (table === "import_batches") return {
      ...builder,
      insert(value: Record<string, unknown>) { insertedBatch = value; return { select: () => ({ single: async () => ({ data: { id: "batch-1" }, error: null }) }) }; },
      update() { return { eq() { return this; }, then(resolve: (value: unknown) => void) { resolve({ error: null }); } }; },
    };
    throw new Error(`Unexpected table ${table}`);
  } };
  const file = new File(["synthetic"], "statement.xlsx");
  const id = await createImportPreview(client as never, "user-1", "account-1", file, [], await file.arrayBuffer(), "american_express_v1");
  assert.equal(id, "batch-1");
  assert.equal(insertedBatch?.parser_key, "american_express_v1");
});
