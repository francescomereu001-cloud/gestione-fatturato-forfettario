import test from "node:test";
import assert from "node:assert/strict";
import { possibleTransfer } from "./bankImports.ts";
import type { LedgerTransaction } from "../types/ledger.ts";

const movement = (account_id: string, transaction_date: string, amount: number): LedgerTransaction => ({ account_id, transaction_date, amount, description: "test", transaction_type: "unclassified", source: "bank_import", reconciliation_status: "pending" });
test("transfer suggestions require another own account, opposite exact amount and at most three days", () => {
  const source = movement("a", "2026-09-21", -100);
  assert.deepEqual(possibleTransfer(source, [movement("b", "2026-09-23", 100), movement("b", "2026-09-23", 99), movement("b", "2026-09-30", 100), movement("a", "2026-09-21", 100)]), [movement("b", "2026-09-23", 100)]);
});
