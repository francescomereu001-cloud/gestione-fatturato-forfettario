import test from "node:test";
import assert from "node:assert/strict";
import { classifyDuplicate, possibleTransfer, transferTypeForAccounts } from "./bankImports.ts";
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
