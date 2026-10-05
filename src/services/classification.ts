import type { SupabaseClient } from "@supabase/supabase-js";
import type { ClassificationResult, ClassificationRule } from "../types/classification.ts";

export function normalizeMatchText(value: string | null | undefined): string {
  return (value ?? "").trim().toLocaleLowerCase().replace(/\s+/g, " ");
}

export function matchesText(value: string | null | undefined, pattern: string, operator: ClassificationRule["match_operator"]): boolean {
  const normalized = normalizeMatchText(value); const expected = normalizeMatchText(pattern);
  if (operator === "exact") return normalized === expected;
  if (operator === "starts_with") return normalized.startsWith(expected);
  return normalized.includes(expected);
}

export async function classifyTransactions(client: SupabaseClient, batchId: string | null = null): Promise<ClassificationResult> {
  const { data, error } = await client.rpc("classify_transactions", { target_batch_id: batchId });
  if (error) throw error;
  return data as ClassificationResult;
}

export async function loadClassificationRules(client: SupabaseClient, userId: string): Promise<ClassificationRule[]> {
  const { data, error } = await client.from("transaction_classification_rules").select("*").eq("user_id", userId)
    .order("priority", { ascending: false }).order("created_at").order("id");
  if (error) throw error;
  return (data ?? []) as ClassificationRule[];
}
