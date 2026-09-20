import test from "node:test";
import assert from "node:assert/strict";
import { accountPayload, internalTransferPayloads, transactionPayload } from "./ledger.ts";

test("ledger payloads always carry authenticated ownership", () => {
  assert.equal(accountPayload({ name: "Banca", account_type: "checking", currency: "EUR", opening_balance: 0, is_active: true, include_in_liquidity: true }, "owner").user_id, "owner");
  assert.equal(transactionPayload({ account_id: "a", transaction_date: "2026-01-01", amount: 1, description: "x", transaction_type: "income", source: "import", reconciliation_status: "pending" }, "owner").user_id, "owner");
});

test("internal transfer payloads create linked and opposite legs", () => {
  const legs = internalTransferPayloads({ account_id: "a", transfer_account_id: "b", transaction_date: "2026-01-01", amount: 20, description: "giroconto", transaction_type: "internal_transfer", source: "manual", reconciliation_status: "confirmed" }, "owner", "group");
  assert.deepEqual(legs.map(({ account_id, transfer_account_id, amount, transfer_group_id }) => ({ account_id, transfer_account_id, amount, transfer_group_id })), [{ account_id: "a", transfer_account_id: "b", amount: -20, transfer_group_id: "group" }, { account_id: "b", transfer_account_id: "a", amount: 20, transfer_group_id: "group" }]);
});
