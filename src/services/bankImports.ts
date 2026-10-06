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

export function classifyDuplicate(row: ImportRow, externalIds: Set<string>, fingerprints: Map<string, number>): ImportRow["status"] {
  if (row.status !== "ready") return row.status;
  if (row.external_id) return externalIds.has(row.external_id) ? "duplicate" : row.status;
  if (row.dedupe_fingerprint) {
    const remaining = fingerprints.get(row.dedupe_fingerprint) ?? 0;
    if (remaining > 0) {
      fingerprints.set(row.dedupe_fingerprint, remaining - 1);
      return "possible_duplicate";
    }
  }
  return row.status;
}

export function chunkValues<T>(values: T[], size = 100): T[][] {
  if (!Number.isInteger(size) || size < 1) throw new Error("La dimensione dei chunk deve essere positiva.");
  const chunks: T[][] = [];
  for (let index = 0; index < values.length; index += size) chunks.push(values.slice(index, index + size));
  return chunks;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object" && "message" in error) return String(error.message);
  return "errore sconosciuto";
}

export async function createImportPreview(
  client: SupabaseClient, userId: string, accountId: string, file: File, rows: ImportRow[], fileData: ArrayBuffer, parserKey: string,
): Promise<string> {
  if (parserKey === "isybank_operations_v1" && rows.some((row) => row.status === "ready" && (!row.source_instrument || !row.target_account_id))) {
    throw new Error("Ogni movimento IsyBank deve avere uno strumento e un account associato prima della preview.");
  }
  const source_format = file.name.toLocaleLowerCase().endsWith(".csv") ? "csv" : "xlsx";
  const file_hash = await sha256(fileData);
  const previousBatch = await client.from("import_batches").select("id").eq("user_id", userId).eq("account_id", accountId).eq("file_hash", file_hash).neq("status", "cancelled").limit(1);
  if (previousBatch.error) throw previousBatch.error;
  if (previousBatch.data?.length) throw new Error("Questo file è già stato caricato per il conto selezionato.");
  const { data: batch, error: batchError } = await client.from("import_batches").insert({
    user_id: userId, account_id: accountId, filename: file.name, file_hash,
    source_format, parser_key: parserKey, status: "processing", row_count: rows.length,
    error_count: rows.filter((row) => row.status === "error").length,
  }).select("id").single();
  if (batchError || !batch) throw batchError ?? new Error("Batch import non creato.");

  try {
    // Query one account at a time; the server aggregates history before API row limits.
    const staged: ImportRow[] = [];
    const accountIds = [...new Set(rows.map((row) => row.target_account_id ?? accountId))];
    for (const targetAccountId of accountIds) {
      const accountRows = rows.filter((row) => (row.target_account_id ?? accountId) === targetAccountId);
      const externalIds = [...new Set(accountRows.flatMap((row) => row.external_id ? [row.external_id] : []))];
      const fingerprints = [...new Set(accountRows.flatMap((row) => row.dedupe_fingerprint ? [row.dedupe_fingerprint] : []))];
      const duplicateIds = new Set<string>();
      const duplicateFingerprints = new Map<string, number>();
      for (const values of chunkValues(externalIds)) {
        const result = await client.rpc("import_dedup_history", { target_account: targetAccountId, external_ids: values, fingerprints: [] });
        if (result.error) throw result.error;
        for (const existing of result.data ?? []) if (existing.external_id) duplicateIds.add(existing.external_id);
      }
      for (const values of chunkValues(fingerprints)) {
        const result = await client.rpc("import_dedup_history", { target_account: targetAccountId, external_ids: [], fingerprints: values });
        if (result.error) throw result.error;
        for (const existing of result.data ?? []) if (existing.dedupe_fingerprint) duplicateFingerprints.set(existing.dedupe_fingerprint, Number(existing.occurrences));
      }
      for (const row of accountRows) {
        const status = classifyDuplicate(row, duplicateIds, duplicateFingerprints);
        // Strong provider IDs are unique; weak fingerprints do not suppress siblings.
        if (row.status === "ready" && row.external_id) duplicateIds.add(row.external_id);
        staged.push({ ...row, user_id: userId, batch_id: batch.id, status });
      }
    }
    staged.sort((first, second) => first.row_index - second.row_index);

    let persistedCount = 0;
    for (const chunk of chunkValues(staged)) {
      const result = await client.from("import_rows").insert(chunk).select("id");
      if (result.error) throw result.error;
      persistedCount += result.data?.length ?? 0;
    }
    if (persistedCount !== staged.length) throw new Error(`Staging incompleto: salvate ${persistedCount} righe su ${staged.length}.`);

    const { error: counterError } = await client.from("import_batches").update({
      status: "preview",
      duplicate_count: staged.filter((row) => row.status === "duplicate").length,
      ignored_count: staged.filter((row) => row.status === "ignored").length,
      error_count: staged.filter((row) => row.status === "error").length,
    }).eq("id", batch.id).eq("user_id", userId);
    if (counterError) throw counterError;
    return batch.id;
  } catch (error) {
    await client.from("import_batches").update({ status: "failed", notes: `Staging non completato: ${errorMessage(error)}` }).eq("id", batch.id).eq("user_id", userId);
    throw error;
  }
}

export async function cancelImportBatch(client: SupabaseClient, userId: string, batchId: string): Promise<void> {
  const { data, error } = await client.from("import_batches").update({ status: "cancelled" })
    .eq("id", batchId).eq("user_id", userId).neq("status", "completed").select("id").maybeSingle();
  if (error) throw error;
  if (!data) throw new Error("Un import completato non può essere annullato.");
}

export async function commitImportBatch(client: SupabaseClient, batchId: string): Promise<number> {
  const { data, error } = await client.rpc("commit_import_batch", { target_batch_id: batchId });
  if (error) throw error;
  return Number(data ?? 0);
}
