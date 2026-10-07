import type { TransactionType } from "./ledger.ts";

export const matchFields = ["description", "merchant", "provider_category", "provider_operation", "provider_details"] as const;
export const matchOperators = ["exact", "contains", "starts_with"] as const;
export const amountDirections = ["any", "debit", "credit"] as const;

export type ClassificationRule = {
  id?: string; user_id?: string; name: string; priority: number; is_active: boolean;
  account_id: string | null; parser_key: string | null;
  match_field: (typeof matchFields)[number]; match_operator: (typeof matchOperators)[number];
  pattern: string; amount_direction: (typeof amountDirections)[number];
  target_transaction_type: TransactionType | null; target_category_id: string | null;
  target_transfer_account_id: string | null; target_merchant: string | null; created_at?: string; updated_at?: string;
};

export type ClassificationResult = { classified_count: number; transfer_count: number; unclassified_count: number; categorized_count: number; uncategorized_count: number; total_transfer_count: number };
