import type { SupabaseClient } from "@supabase/supabase-js";
import { ownedBy } from "../auth/ownership.ts";
import type { Account, LedgerTransaction } from "../types/ledger.ts";

export async function loadLedger(client: SupabaseClient, userId: string) {
  const [accounts, transactions, categories] = await Promise.all([
    client.from("accounts").select("*").eq("user_id", userId).order("name"),
    client.from("transactions").select("*").eq("user_id", userId).order("transaction_date", { ascending: false }),
    client.from("transaction_categories").select("*").eq("user_id", userId).order("name"),
  ]);
  const error = accounts.error || transactions.error || categories.error;
  if (error) throw error;
  let categoryRows = categories.data ?? [];
  if (!categoryRows.length) {
    const defaults = [
      ["Compensi", "income", "income_compensation"], ["Casa e utenze", "expense", "expense_home"],
      ["Alimentari", "expense", "expense_food"], ["Trasferimenti", "transfer", "transfer_internal"],
      ["Investimenti", "asset", "asset_investments"], ["Debiti", "liability", "liability_debt"],
    ].map(([name, category_type, system_key]) => ownedBy({ name, category_type, system_key }, userId));
    const seeded = await client.from("transaction_categories").upsert(defaults, { onConflict: "user_id,system_key" }).select("*");
    if (seeded.error) throw seeded.error;
    categoryRows = seeded.data ?? [];
  }
  return { accounts: (accounts.data ?? []) as Account[], transactions: (transactions.data ?? []) as LedgerTransaction[], categories: categoryRows };
}

export function accountPayload(account: Account, userId: string) {
  return ownedBy({ ...account, opening_balance: Number(account.opening_balance) }, userId);
}

export function normalizeTransactionAmount(transaction: LedgerTransaction): number {
  const amount = Number(transaction.amount);
  if (amount === 0) throw new Error("L'importo deve essere diverso da zero.");
  if (transaction.transaction_type === "income" || transaction.transaction_type === "refund") return Math.abs(amount);
  if (["expense", "debt_interest", "debt_principal"].includes(transaction.transaction_type)) return -Math.abs(amount);
  return amount;
}

export function transactionPayload(transaction: LedgerTransaction, userId: string) {
  return ownedBy({ ...transaction, amount: normalizeTransactionAmount(transaction), source: "manual" }, userId);
}

export function internalTransferPayloads(transaction: LedgerTransaction, userId: string, groupId: string = crypto.randomUUID()) {
  if (!transaction.transfer_account_id || transaction.transfer_account_id === transaction.account_id) throw new Error("Seleziona due conti diversi per il trasferimento.");
  const amount = Math.abs(Number(transaction.amount));
  const common = { ...transaction, transaction_type: "internal_transfer" as const, transfer_group_id: groupId };
  return [
    transactionPayload({ ...common, amount: -amount }, userId),
    transactionPayload({ ...common, account_id: transaction.transfer_account_id, transfer_account_id: transaction.account_id, amount }, userId),
  ];
}
