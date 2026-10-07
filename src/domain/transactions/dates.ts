import type { LedgerTransaction } from "../../types/ledger.ts";

export function effectiveTransactionDate(transaction: Pick<LedgerTransaction, "booking_date" | "transaction_date">): string {
  return transaction.booking_date ?? transaction.transaction_date;
}

export function localCalendarDate(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

export function isCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(0);
  date.setFullYear(year, month - 1, day);
  return localCalendarDate(date) === value;
}

export type PeriodPreset = "this_month" | "last_month" | "this_year" | "all" | "custom";
export type DatePeriod = { from: string; to: string; error: string | null };

export function transactionPeriod(preset: PeriodPreset, now = new Date(), from = "", to = ""): DatePeriod {
  const year = now.getFullYear();
  const month = now.getMonth();
  if (preset === "all") return { from: "", to: "", error: null };
  if (preset === "custom") {
    const error = !isCalendarDate(from) || !isCalendarDate(to)
      ? "Inserisci Data da e Data a valide."
      : from > to ? "Data da deve essere precedente o uguale a Data a." : null;
    return { from, to, error };
  }
  const start = preset === "this_year" ? new Date(year, 0, 1) : new Date(year, month - (preset === "last_month" ? 1 : 0), 1);
  const end = preset === "this_year" ? new Date(year, 11, 31) : new Date(year, month + (preset === "last_month" ? 0 : 1), 0);
  return { from: localCalendarDate(start), to: localCalendarDate(end), error: null };
}

export function filterTransactionsByPeriod(transactions: LedgerTransaction[], period: DatePeriod): LedgerTransaction[] {
  if (period.error) return [];
  return transactions.filter((transaction) => {
    const date = effectiveTransactionDate(transaction);
    return (!period.from || date >= period.from) && (!period.to || date <= period.to);
  });
}

export function unclassifiedCount(transactions: LedgerTransaction[]): number {
  return transactions.filter((transaction) => transaction.transaction_type === "unclassified" && transaction.reconciliation_status !== "ignored").length;
}
