import test from "node:test";
import assert from "node:assert/strict";
import { accountPayload, internalTransferPayloads, normalizeTransactionAmount, transactionPayload } from "./ledger.ts";
import { accountBalance } from "../domain/accounts/calculations.ts";
import { cashflowSummary } from "../domain/transactions/calculations.ts";
import type { LedgerTransaction, TransactionType } from "../types/ledger.ts";

const transaction = (transaction_type: TransactionType, amount: number): LedgerTransaction => ({ account_id: "a", transaction_date: "2026-01-01", amount, description: "test", transaction_type, source: "manual", reconciliation_status: "confirmed" });

test("ledger payloads always carry authenticated ownership", () => {
  assert.equal(accountPayload({ name: "Banca", account_type: "checking", currency: "EUR", opening_balance: 0, is_active: true, include_in_liquidity: true }, "owner").user_id, "owner");
  assert.equal(transactionPayload({ account_id: "a", transaction_date: "2026-01-01", amount: 1, description: "x", transaction_type: "income", source: "import", reconciliation_status: "pending" }, "owner").user_id, "owner");
});

test("internal transfer payloads create linked and opposite legs", () => {
  const legs = internalTransferPayloads({ account_id: "a", transfer_account_id: "b", transaction_date: "2026-01-01", amount: 20, description: "giroconto", transaction_type: "internal_transfer", source: "manual", reconciliation_status: "confirmed" }, "owner", "group");
  assert.deepEqual(legs.map(({ account_id, transfer_account_id, amount, transfer_group_id }) => ({ account_id, transfer_account_id, amount, transfer_group_id })), [{ account_id: "a", transfer_account_id: "b", amount: -20, transfer_group_id: "group" }, { account_id: "b", transfer_account_id: "a", amount: 20, transfer_group_id: "group" }]);
});

test("canonical signs are enforced for deterministic transaction types", () => {
  assert.equal(normalizeTransactionAmount(transaction("expense", 100)), -100);
  assert.equal(normalizeTransactionAmount(transaction("income", -100)), 100);
  assert.equal(normalizeTransactionAmount(transaction("refund", -25)), 25);
  assert.equal(normalizeTransactionAmount(transaction("debt_interest", 10)), -10);
  assert.equal(normalizeTransactionAmount(transaction("debt_principal", 50)), -50);
  assert.throws(() => normalizeTransactionAmount(transaction("adjustment", 0)), /diverso da zero/);
});

test("normalized signs keep account balance and economic cashflow coherent", () => {
  const rows = [transaction("income", -100), transaction("expense", 30), transaction("refund", -10)].map(item => transactionPayload(item, "owner"));
  const account = { id: "a", name: "Conto", account_type: "checking" as const, currency: "EUR", opening_balance: 20, is_active: true, include_in_liquidity: true };
  assert.equal(accountBalance(account, rows), 100);
  assert.deepEqual(cashflowSummary(rows), { income: 100, expenses: 20, cashflow: 80 });
});
