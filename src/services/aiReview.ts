import type { SupabaseClient } from "@supabase/supabase-js";
import type { TransactionType } from "../types/ledger.ts";
export type AISuggestion = { id: string; transaction_id: string; merchant: string; description: string;
  transaction_type: TransactionType; category: string; confidence: number; reason: string };
export async function loadAISuggestions(client: SupabaseClient): Promise<AISuggestion[]> {
  const { data, error } = await client.rpc("pending_ai_suggestions");
  if (error) throw error;
  return Array.isArray(data) ? data as AISuggestion[] : [];
}
export async function decideAISuggestion(client: SupabaseClient, id: string, action: "approve" | "remember" | "reject") {
  const { error } = await client.rpc("review_ai_suggestion", { suggestion_id: id, action });
  if (error) throw error;
}
export async function requestResidualAI(client: SupabaseClient) {
  const { data, error } = await client.functions.invoke("classify-residuals", { body: {} });
  if (error) throw new Error("AI non disponibile. I movimenti restano da verificare.");
  return data as { requested: number; groups: number; outcomes: Record<string, number> };
}
export async function rememberMerchant(client: SupabaseClient, transactionId: string, type: TransactionType, categoryId: string) {
  const { data, error } = await client.rpc("remember_transaction_merchant", { transaction_id: transactionId, decision_type: type, category_id: categoryId });
  if (error) throw error;
  return data as string;
}
