import test from "node:test";
import assert from "node:assert/strict";
import { cashflowSummary } from "./calculations.ts";
import type { LedgerTransaction, TransactionType } from "../../types/ledger";

const item = (transaction_type: TransactionType, amount: number): LedgerTransaction => ({ account_id: "a", amount, transaction_date: "2026-01-01", description: "test", transaction_type, source: "manual", reconciliation_status: "confirmed" });

test("income and expenses produce cashflow", () => assert.deepEqual(cashflowSummary([item("income", 100), item("expense", -30)]), { income: 100, expenses: 30, cashflow: 70 }));
test("internal and broker transfers are economically neutral", () => assert.deepEqual(cashflowSummary([item("internal_transfer", -50), item("internal_transfer", 50), item("investment_transfer", -20)]), { income: 0, expenses: 0, cashflow: 0 }));
test("debt principal is neutral while interest is an expense", () => assert.deepEqual(cashflowSummary([item("debt_principal", -100), item("debt_interest", -5)]), { income: 0, expenses: 5, cashflow: -5 }));
test("refund reduces ordinary expenses", () => assert.deepEqual(cashflowSummary([item("expense", -50), item("refund", 20)]), { income: 0, expenses: 30, cashflow: -30 }));
