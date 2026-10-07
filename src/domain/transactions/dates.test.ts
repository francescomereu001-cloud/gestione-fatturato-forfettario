import test from "node:test";
import assert from "node:assert/strict";
import { effectiveTransactionDate, filterTransactionsByPeriod, transactionPeriod, localCalendarDate, unclassifiedCount } from "./dates.ts";
import { cashflowSummary } from "./calculations.ts";
import type { LedgerTransaction, TransactionType } from "../../types/ledger.ts";

const now = new Date(2026, 9, 7);
const row = (transaction_date: string, transaction_type: TransactionType = "income", amount = 100): LedgerTransaction => ({ account_id: "a", transaction_date, transaction_type, amount, description: "Synthetic", reconciliation_status: "confirmed", source: "manual" });

test("presets use inclusive local calendar boundaries", () => {
  assert.deepEqual(transactionPeriod("this_month", now), { from: "2026-10-01", to: "2026-10-31", error: null });
  assert.deepEqual(transactionPeriod("last_month", now), { from: "2026-09-01", to: "2026-09-30", error: null });
  assert.deepEqual(transactionPeriod("this_year", now), { from: "2026-01-01", to: "2026-12-31", error: null });
  assert.deepEqual(transactionPeriod("last_month", new Date(2026, 0, 1)), { from: "2025-12-01", to: "2025-12-31", error: null });
  assert.equal(transactionPeriod("this_month", new Date(2024, 1, 15)).to, "2024-02-29");
  assert.equal(localCalendarDate(new Date(2026, 9, 1, 0, 1)), "2026-10-01");
});

test("all and custom ranges validate and include both endpoints", () => {
  const rows = [row("2026-09-30"), row("2026-10-01"), row("2026-10-07"), row("2026-10-08")];
  assert.deepEqual(filterTransactionsByPeriod(rows, transactionPeriod("all", now)), rows);
  assert.deepEqual(filterTransactionsByPeriod(rows, transactionPeriod("custom", now, "2026-10-01", "2026-10-07")), rows.slice(1, 3));
  assert.equal(filterTransactionsByPeriod(rows, transactionPeriod("custom", now, "2026-10-07", "2026-10-07")).length, 1);
  for (const [from, to] of [["2026-10-08", "2026-10-01"], ["", ""], ["2026-02-30", "2026-10-01"]]) {
    const period = transactionPeriod("custom", now, from, to);
    assert.ok(period.error);
    assert.deepEqual(filterTransactionsByPeriod(rows, period), []);
  }
});

test("booking date takes precedence with historical null fallback", () => {
  const booked = { ...row("2026-09-30"), booking_date: "2026-10-01" };
  const later = { ...row("2026-10-31"), booking_date: "2026-11-01" };
  const historical = { ...row("2026-10-02"), booking_date: null };
  assert.equal(effectiveTransactionDate(booked), "2026-10-01");
  assert.deepEqual(filterTransactionsByPeriod([booked, later, historical], transactionPeriod("this_month", now)), [booked, historical]);
});

test("list, KPIs and residuals exclude out-of-period movements and preserve economic semantics", () => {
  const rows = [row("2026-10-01"), row("2026-10-31", "expense", -30), row("2026-10-07", "debt_interest", -5), row("2026-10-07", "refund", 10),
    ...(["unclassified", "internal_transfer", "investment_transfer", "debt_principal", "adjustment"] as const).map((type) => row("2026-10-07", type, -500)),
    row("2026-09-30", "income", 10000), row("2026-11-01", "expense", -10000), row("2026-09-30", "unclassified"),
    { ...row("2026-10-07", "unclassified"), reconciliation_status: "ignored" as const }];
  const shown = filterTransactionsByPeriod(rows, transactionPeriod("this_month", now));
  assert.equal(shown.length, 10);
  assert.deepEqual(cashflowSummary(shown), { income: 100, expenses: 25, cashflow: 75 });
  assert.equal(unclassifiedCount(shown), 1);
  const previous = filterTransactionsByPeriod(rows, transactionPeriod("last_month", now));
  assert.equal(previous.length, 2);
  assert.deepEqual(cashflowSummary(previous), { income: 10000, expenses: 0, cashflow: 10000 });
  assert.equal(filterTransactionsByPeriod(rows, transactionPeriod("this_year", now)).length, rows.length);
});
