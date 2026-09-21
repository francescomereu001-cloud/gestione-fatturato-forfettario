import type { SupabaseClient } from "@supabase/supabase-js";
import type { ImportBatch, ImportRow } from "../types/imports.ts";
import type { LedgerTransaction } from "../types/ledger.ts";

export async function sha256(data: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function possibleTransfer(transaction: Pick<LedgerTransaction, "account_id" | "transaction_date" | "amount">, candidates: LedgerTransaction[]) {
  const day = Date.parse(`${transaction.transaction_date}T00:00:00Z`);
  return candidates.filter((candidate) => candidate.account_id !== transaction.account_id
    && Number(candidate.amount) === -Number(transaction.amount)
    && Math.abs(Date.parse(`${candidate.transaction_date}T00:00:00Z`) - day) <= 3 * 86_400_000);
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
  const seen = new Set<string>();
  const staged = rows.map((row) => {
    const duplicate = Boolean((row.external_id && duplicateIds.has(row.external_id))
      || (row.dedupe_fingerprint && (duplicateFingerprints.has(row.dedupe_fingerprint) || seen.has(row.dedupe_fingerprint))));
    if (row.dedupe_fingerprint) seen.add(row.dedupe_fingerprint);
    return { ...row, user_id: userId, batch_id: batch.id, status: duplicate && row.status === "ready" ? "possible_duplicate" : row.status };
  });
  if (staged.length) {
    const { error } = await client.from("import_rows").insert(staged);
    if (error) { await client.from("import_batches").update({ status: "failed", notes: error.message }).eq("id", batch.id).eq("user_id", userId); throw error; }
  }
  return batch.id;
}

export async function importReadyRows(client: SupabaseClient, userId: string, batch: ImportBatch, rows: ImportRow[]) {
  const ready = rows.filter((row) => row.status === "ready");
  await client.from("import_batches").update({ status: "processing" }).eq("id", batch.id).eq("user_id", userId);
  let imported = 0; let errors = 0;
  for (const row of ready) {
    const { data, error } = await client.from("transactions").insert({
      user_id: userId, account_id: batch.account_id, transaction_date: row.transaction_date,
      booking_date: row.booking_date, amount: row.amount, description: row.description,
      merchant: row.merchant, transaction_type: row.suggested_transaction_type ?? "unclassified",
      category_id: row.suggested_category_id, source: "bank_import", external_id: row.external_id,
      reconciliation_status: "pending", import_batch_id: batch.id,
    }).select("id").single();
    if (error || !data) { errors += 1; await client.from("import_rows").update({ status: "error" }).eq("id", row.id).eq("user_id", userId); }
    else { imported += 1; await client.from("import_rows").update({ status: "imported", matched_transaction_id: data.id }).eq("id", row.id).eq("user_id", userId); }
  }
  const duplicate_count = rows.filter((row) => row.status === "duplicate" || row.status === "possible_duplicate").length;
  const ignored_count = rows.filter((row) => row.status === "ignored").length;
  await client.from("import_batches").update({ status: errors ? "failed" : "completed", imported_count: imported, duplicate_count, ignored_count, error_count: errors + rows.filter((row) => row.status === "error").length, completed_at: new Date().toISOString() }).eq("id", batch.id).eq("user_id", userId);
  return { imported, errors };
}
