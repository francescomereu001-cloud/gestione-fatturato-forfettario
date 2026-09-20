import type { LedgerTransaction } from "../../types/ledger.ts";

export type CashflowSummary = { income: number; expenses: number; cashflow: number };

export function cashflowSummary(transactions: LedgerTransaction[]): CashflowSummary {
  return transactions.filter((item) => item.reconciliation_status !== "ignored").reduce(
    (result, item) => {
      const amount = Number(item.amount);
      if (item.transaction_type === "income") result.income += Math.abs(amount);
      if (item.transaction_type === "expense" || item.transaction_type === "debt_interest") result.expenses += Math.abs(amount);
      if (item.transaction_type === "refund") result.expenses -= Math.abs(amount);
      result.cashflow = result.income - result.expenses;
      return result;
    },
    { income: 0, expenses: 0, cashflow: 0 },
  );
}
