import type { SupabaseClient } from "@supabase/supabase-js";
import type { ClassificationRule } from "../types/classification.ts";
import type { Account, TransactionCategory, TransactionType } from "../types/ledger.ts";

export type ReviewGrouping = "provider_category" | "provider_operation";
export type ResidualGroup = {
  group_key: string; parser_key: string | null; account_id: string; account_name: string; currency: string;
  provider_category: string | null; provider_operation: string | null; metadata_conflicting: boolean;
  transaction_count: number; total_amount: number; date_min: string; date_max: string;
  transaction_ids: string[]; examples: string[];
};
export type ReviewPage = { groups: ResidualGroup[]; total_groups: number; unclassified_count: number };
export type ReviewDecision = { transaction_type: TransactionType; category_id: string | null; transfer_account_id: string | null };
export const blankReviewDecision = (): ReviewDecision => ({ transaction_type: "unclassified", category_id: null, transfer_account_id: null });
export const isTransferType = (type: TransactionType | null) => type === "internal_transfer" || type === "investment_transfer";
export function categoriesForDecision(type: TransactionType | null, categories: TransactionCategory[]) {
  if (!type) return categories;
  if (isTransferType(type) || type === "unclassified") return [];
  const kind = type === "income" ? "income" : type === "debt_principal" ? "liability" : type === "adjustment" ? null : "expense";
  return categories.filter(category => !kind || category.category_type === kind);
}
export function transferTargets(group: ResidualGroup, type: TransactionType, accounts: Account[]) {
  return accounts.filter(a => a.id !== group.account_id && a.currency === group.currency && (type !== "investment_transfer" || a.account_type === "broker"));
}
export function reviewHint(group: ResidualGroup): string | null {
  const text = `${group.provider_category ?? ""} ${group.provider_operation ?? ""} ${group.examples.join(" ")}`.toLowerCase();
  if (/preliev|cash advance|atm withdrawal/.test(text)) return "Prelievi — da riconciliare con contanti";
  if (/rate mutuo|rate prestiti|finanziamento|cofidis/.test(text)) return "La rata può includere capitale e interessi. Non viene classificata automaticamente.";
  return null;
}
export function serverErrorMessage(reason: unknown): string {
  if (typeof reason === "object" && reason !== null && "message" in reason && typeof reason.message === "string") return reason.message;
  return "Operazione non completata.";
}
export async function loadResidualGroups(client: SupabaseClient, grouping: ReviewGrouping, offset = 0): Promise<ReviewPage> {
  const { data, error } = await client.rpc("residual_review_groups", { group_by: grouping, page_limit: 50, page_offset: offset });
  if (error) throw error;
  return data as ReviewPage;
}
export async function loadReviewOptions(client: SupabaseClient, userId: string) {
  const [accounts, categories] = await Promise.all([
    client.from("accounts").select("id,name,currency,account_type,is_active").eq("user_id", userId).order("name"),
    client.from("transaction_categories").select("id,name,category_type").eq("user_id", userId).order("name"),
  ]);
  if (accounts.error || categories.error) throw accounts.error || categories.error;
  return { accounts: (accounts.data ?? []) as Account[], categories: (categories.data ?? []) as TransactionCategory[] };
}
export async function applyReviewOnce(client: SupabaseClient, ids: string[], decision: ReviewDecision): Promise<number> {
  const { data, error } = await client.rpc("bulk_classify_transactions", {
    transaction_ids: ids, target_type: decision.transaction_type,
    target_category_id: decision.category_id, target_transfer_account_id: decision.transfer_account_id,
  });
  if (error) throw error;
  return data as number;
}
export function exactReviewRule(group: ResidualGroup, decision: ReviewDecision, field: ReviewGrouping): ClassificationRule {
  const pattern = group[field];
  if (!group.parser_key || !pattern || group.metadata_conflicting) throw new Error("Metadata mancanti o conflittuali: applica solo a questi movimenti.");
  return { name: `Revisione ${pattern}`, priority: 100, is_active: true, account_id: group.account_id,
    parser_key: group.parser_key, match_field: field, match_operator: "exact", pattern,
    amount_direction: "any", target_transaction_type: decision.transaction_type, target_category_id: decision.category_id,
    target_transfer_account_id: decision.transfer_account_id, target_merchant: null };
}
export async function saveReviewRule(client: SupabaseClient, group: ResidualGroup, decision: ReviewDecision, field: ReviewGrouping) {
  const { data, error } = await client.rpc("create_classification_rule_and_apply", {
    transaction_ids: group.transaction_ids, rule_input: exactReviewRule(group, decision, field),
  });
  if (error) throw error;
  return data as { rule_id: string; classified_count: number };
}
