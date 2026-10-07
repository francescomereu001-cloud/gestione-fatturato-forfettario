import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  IncomeSummary,
  InvoiceImportBatch,
  InvoiceImportRow,
  InvoiceParseResult,
} from "../types/income";
export function incomeError(reason: unknown): string {
  const e = reason as { code?: string; message?: string };
  if (e?.code === "PGRST202" || e?.code === "42883")
    return "Servizio Income non disponibile: la migration PR12 deve essere applicata.";
  if (e?.code === "42501" || e?.code === "PGRST301")
    return "Accesso negato: verifica la sessione e i permessi del tuo account.";
  return (
    e?.message ||
    "Operazione Income fallita. Riprova; nessun commit parziale è stato effettuato."
  );
}
export async function loadIncomeSummary(
  client: SupabaseClient,
  year: number,
): Promise<IncomeSummary> {
  const { data, error } = await client.rpc("financial_income_summary", {
    target_year: year,
  });
  if (error) throw error;
  return data as IncomeSummary;
}
export async function stageInvoiceImport(
  client: SupabaseClient,
  fileName: string,
  parsed: InvoiceParseResult,
): Promise<InvoiceImportBatch> {
  const { data, error } = await client.rpc("stage_invoice_import_batch", {
    file_name: fileName,
    parser_key: parsed.parser_key,
    rows: parsed.rows,
  });
  if (error) throw error;
  return data as InvoiceImportBatch;
}
export async function loadInvoiceImportRows(
  client: SupabaseClient,
  batchId: string,
): Promise<InvoiceImportRow[]> {
  // Paginate: Supabase defaults to 1000 rows; never silently truncate preview/audit.
  const rows: InvoiceImportRow[] = [];
  for (let start = 0; ; start += 500) {
    const { data, error } = await client
      .from("invoice_import_rows")
      .select("*")
      .eq("batch_id", batchId)
      .order("row_index")
      .range(start, start + 499);
    if (error) throw error;
    rows.push(...(data ?? []));
    if (!data || data.length < 500) break;
  }
  return rows;
}
export async function commitInvoiceImport(
  client: SupabaseClient,
  batchId: string,
): Promise<InvoiceImportBatch> {
  const { data, error } = await client.rpc("commit_invoice_import_batch", {
    batch_id: batchId,
  });
  if (error) throw error;
  return data as InvoiceImportBatch;
}
export async function loadIncomeInvoices(
  client: SupabaseClient,
  userId: string,
) {
  const rows = [];
  for (let start = 0; ; start += 500) {
    const { data, error } = await client
      .from("invoices")
      .select("*")
      .eq("user_id", userId)
      .order("data", { ascending: false })
      .order("id")
      .range(start, start + 499);
    if (error) throw error;
    rows.push(...(data ?? []));
    if (!data || data.length < 500) break;
  }
  return rows;
}
