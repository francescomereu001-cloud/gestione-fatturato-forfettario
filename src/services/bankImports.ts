import type { SupabaseClient } from "@supabase/supabase-js";
import type { ImportRow } from "../types/imports.ts";
import type { AccountType, LedgerTransaction } from "../types/ledger.ts";

export async function sha256(data: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function possibleTransfer(transaction: LedgerTransaction, candidates: LedgerTransaction[]) {
  const day = Date.parse(`${transaction.transaction_date}T00:00:00Z`);
  if (transaction.reconciliation_status === "ignored" || transaction.transfer_group_id
    || ["internal_transfer", "investment_transfer"].includes(transaction.transaction_type)) return [];
  return candidates.filter((candidate) => candidate.id !== transaction.id
    && Boolean(transaction.user_id) && candidate.user_id === transaction.user_id
    && candidate.account_id !== transaction.account_id
    && Number(candidate.amount) === -Number(transaction.amount)
    && Math.abs(Date.parse(`${candidate.transaction_date}T00:00:00Z`) - day) <= 3 * 86_400_000
    && candidate.reconciliation_status !== "ignored"
    && !candidate.transfer_group_id
    && !["internal_transfer", "investment_transfer"].includes(candidate.transaction_type)
    && candidate.transaction_type === "unclassified");
}

export function transferTypeForAccounts(first: AccountType, second: AccountType): "internal_transfer" | "investment_transfer" {
  return first === "broker" || second === "broker" ? "investment_transfer" : "internal_transfer";
}

export function classifyDuplicate(row: ImportRow, externalIds: Set<string>, fingerprints: Set<string>): ImportRow["status"] {
  if (row.external_id && externalIds.has(row.external_id)) return "duplicate";
  if (row.dedupe_fingerprint && fingerprints.has(row.dedupe_fingerprint)) return "possible_duplicate";
  return row.status;
}

export async function createImportPreview(
  client: SupabaseClient, userId: string, accountId: string, file: File, rows: ImportRow[], fileData: ArrayBuffer,
): Promise<string> {
  const source_format = file.name.toLocaleLowerCase().endsWith(".csv") ? "csv" : "xlsx";
  const file_hash = await sha256(fileData);
  const previousBatch = await client.from("import_batches").select("id").eq("user_id", userId).eq("account_id", accountId).eq("file_hash", file_hash).neq("status", "cancelled").limit(1);
  if (previousBatch.error) throw previousBatch.error;
  if (previousBatch.data?.length) throw new Error("Questo file è già stato caricato per il conto selezionato.");
  const { data: batch, error: batchError } = await client.from("import_batches").insert({
    user_id: userId, account_id: accountId, filename: file.name, file_hash,
    source_format, parser_key: "generic_bank_v1", status: "preview", row_count: rows.length,
    error_count: rows.filter((row) => row.status === "error").length,
  }).select("id").single();
  if (batchError || !batch) throw batchError ?? new Error("Batch import non creato.");

  const externalIds = rows.flatMap((row) => row.external_id ? [row.external_id] : []);
  const fingerprints = rows.flatMap((row) => row.dedupe_fingerprint ? [row.dedupe_fingerprint] : []);
  const [existingTransactions, previousRows] = await Promise.all([
    externalIds.length ? client.from("transactions").select("id,external_id").eq("user_id", userId).eq("account_id", accountId).eq("source", "bank_import").in("external_id", externalIds) : Promise.resolve({ data: [], error: null }),
    fingerprints.length ? client.from("import_rows").select("dedupe_fingerprint,import_batches!inner(account_id)").eq("user_id", userId).eq("import_batches.account_id", accountId).in("dedupe_fingerprint", fingerprints).in("status", ["imported", "duplicate"]) : Promise.resolve({ data: [], error: null }),
  ]);
  if (existingTransactions.error || previousRows.error) throw existingTransactions.error ?? previousRows.error;
  const duplicateIds = new Set((existingTransactions.data ?? []).map((row) => row.external_id));
  const duplicateFingerprints = new Set((previousRows.data ?? []).map((row) => row.dedupe_fingerprint));
  const seenExternalIds = new Set<string>(duplicateIds);
  const seen = new Set<string>(duplicateFingerprints);
  const staged = rows.map((row) => {
    const status = classifyDuplicate(row, seenExternalIds, seen);
    if (row.external_id) seenExternalIds.add(row.external_id);
    if (row.dedupe_fingerprint) seen.add(row.dedupe_fingerprint);
    return { ...row, user_id: userId, batch_id: batch.id, status };
  });
  if (staged.length) {
    const { error } = await client.from("import_rows").insert(staged);
    if (error) { await client.from("import_batches").update({ status: "failed", notes: error.message }).eq("id", batch.id).eq("user_id", userId); throw error; }
  }
  const { error: counterError } = await client.from("import_batches").update({
    duplicate_count: staged.filter((row) => row.status === "duplicate").length,
    ignored_count: staged.filter((row) => row.status === "ignored").length,
    error_count: staged.filter((row) => row.status === "error").length,
  }).eq("id", batch.id).eq("user_id", userId);
  if (counterError) throw counterError;
  return batch.id;
}

export async function commitImportBatch(client: SupabaseClient, batchId: string): Promise<number> {
  const { data, error } = await client.rpc("commit_import_batch", { target_batch_id: batchId });
  if (error) throw error;
  return Number(data ?? 0);
}
