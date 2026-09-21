import test from "node:test";
import assert from "node:assert/strict";
import { accountBalance, totalLiquidity } from "./calculations.ts";
import type { Account, LedgerTransaction } from "../../types/ledger";

const account = (id: string, opening_balance: number, include_in_liquidity = true): Account => ({ id, name: id, account_type: "checking", currency: "EUR", opening_balance, is_active: true, include_in_liquidity });
const movement = (account_id: string, amount: number): LedgerTransaction => ({ account_id, amount, transaction_date: "2026-01-01", description: "test", transaction_type: "adjustment", source: "manual", reconciliation_status: "confirmed" });

test("account balance includes opening balance and non-ignored movements", () => {
  assert.equal(accountBalance(account("a", 100), [movement("a", 25), { ...movement("a", 50), reconciliation_status: "ignored" }]), 125);
});

test("balance anchor only includes movements after the closing date", () => {
  const anchored = { ...account("a", 2_000), balance_as_of: "2026-09-21" };
  assert.equal(accountBalance(anchored, [
    { ...movement("a", -100), transaction_date: "2026-09-20" },
    { ...movement("a", -50), transaction_date: "2026-09-22" },
  ]), 1_950);
});

test("total liquidity includes only active accounts configured for liquidity", () => {
  assert.equal(totalLiquidity([account("a", 100), account("b", 500, false)], [movement("a", 25), movement("b", 50)]), 125);
});
