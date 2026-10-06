import type { SupabaseClient } from "@supabase/supabase-js";
import { ownedBy } from "../auth/ownership.ts";
import type { Account, LedgerTransaction } from "../types/ledger.ts";

export async function loadLedger(client: SupabaseClient, userId: string) {
  const defaults = [
    ["Compensi", "income", "income_compensation"], ["Altre entrate", "income", "income_other"],
    ["Alimentari", "expense", "expense_food"], ["Ristoranti e bar", "expense", "expense_dining"],
    ["Casa e utenze", "expense", "expense_home"], ["Trasporti", "expense", "expense_transport"],
    ["Auto e carburante", "expense", "expense_auto"], ["Viaggi", "expense", "expense_travel"],
    ["Shopping", "expense", "expense_shopping"], ["Salute", "expense", "expense_health"],
    ["Cura personale", "expense", "expense_personal"], ["Abbonamenti e servizi digitali", "expense", "expense_subscriptions"],
    ["Tempo libero", "expense", "expense_leisure"], ["Lavoro e professione", "expense", "expense_work"],
    ["Commissioni e spese bancarie", "expense", "expense_fees"], ["Tasse e contributi", "expense", "expense_taxes"],
    ["Tabacchi", "expense", "expense_tobacco"], ["Assicurazioni", "expense", "expense_insurance"],
    ["Multe e sanzioni", "expense", "expense_fines"], ["Regali", "expense", "expense_gifts"],
    ["Altro", "expense", "expense_other"], ["Trasferimenti", "transfer", "transfer_internal"],
    ["Investimenti", "asset", "asset_investments"], ["Debiti", "liability", "liability_debt"],
  ].map(([name, category_type, system_key]) => ownedBy({ name, category_type, system_key }, userId));
  const seeded = await client.from("transaction_categories").upsert(defaults, { onConflict: "user_id,system_key", ignoreDuplicates: true });
  if (seeded.error) throw seeded.error;
  const [accounts, transactions, categories] = await Promise.all([
    client.from("accounts").select("*").eq("user_id", userId).order("name"),
    client.from("transactions").select("*").eq("user_id", userId).order("transaction_date", { ascending: false }),
    client.from("transaction_categories").select("*").eq("user_id", userId).order("name"),
  ]);
  const error = accounts.error || transactions.error || categories.error;
  if (error) throw error;
  return { accounts: (accounts.data ?? []) as Account[], transactions: (transactions.data ?? []) as LedgerTransaction[], categories: categories.data ?? [] };
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
  return ownedBy({ ...transaction, amount: normalizeTransactionAmount(transaction), source: transaction.source || "manual",
    classification_method: "manual" as const, classification_rule_id: null, classified_at: new Date().toISOString() }, userId);
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
