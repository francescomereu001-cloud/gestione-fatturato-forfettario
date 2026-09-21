import type { TransactionType } from "./ledger.ts";

export const importRowStatuses = ["pending", "ready", "possible_duplicate", "duplicate", "imported", "ignored", "error"] as const;
export type ImportRowStatus = (typeof importRowStatuses)[number];

export type ImportBatch = {
  id: string; user_id: string; account_id: string; filename: string | null;
  file_hash: string | null; source_format: "csv" | "xlsx"; parser_key: string | null;
  status: "preview" | "processing" | "completed" | "failed" | "cancelled";
  row_count: number; imported_count: number; duplicate_count: number;
  ignored_count: number; error_count: number; created_at?: string; completed_at?: string | null;
  notes?: string | null;
};

export type ImportRow = {
  id?: string; user_id?: string; batch_id?: string; row_index: number;
  transaction_date: string | null; booking_date: string | null; amount: number | null;
  description: string | null; merchant: string | null; external_id: string | null;
  dedupe_fingerprint: string | null; suggested_transaction_type: TransactionType | null;
  suggested_category_id: string | null; status: ImportRowStatus;
  matched_transaction_id?: string | null; raw_data: Record<string, unknown>;
};
