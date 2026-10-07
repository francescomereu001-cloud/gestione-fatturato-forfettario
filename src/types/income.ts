import type { Invoice } from "./finance";
export const arubaParserKey = "aruba_invoice_report_v1";
export type InvoiceDocument = {
  numero: string;
  data: string;
  cliente: string;
  descrizione: string;
  lordo: number;
  enasarco: number | null;
  netto: number;
  source_document_id?: string;
  enasarco_source?: "document_column" | "document_gross_net_delta";
  document_type: "invoice" | "credit_note" | "signed_adjustment";
};
export type ParsedInvoiceRow = {
  row_index: number;
  raw_data: Record<string, unknown>;
  normalized_data: InvoiceDocument | null;
  warning_codes: string[];
  rejection_code?: string;
};
export type InvoiceParseResult = {
  parser_key: string;
  rows: ParsedInvoiceRow[];
};
export type InvoiceImportRow = ParsedInvoiceRow & {
  id: string;
  status:
    | "new"
    | "existing_unchanged"
    | "exact_duplicate"
    | "conflict"
    | "rejected"
    | "inserted";
  invoice_id: string | null;
  fingerprint: string | null;
};
export type InvoiceImportBatch = {
  id: string;
  file_name: string;
  status: "staged" | "committed";
  row_count: number;
  inserted_count: number;
  updated_count: number;
  duplicate_count: number;
  rejected_count: number;
  conflict_count: number;
  imported_at: string | null;
  created_at: string;
};
export type IncomeSummary = {
  tax_year: number;
  as_of: string;
  gross_invoiced: number;
  gross_collected: number;
  enasarco_withheld: number | null;
  net_income: number;
  invoice_count: number;
  credit_notes_total: number;
  first_invoice_date: string | null;
  last_invoice_date: string | null;
  source_status: "incomplete" | "needs_review" | "available";
  invalid_invoice_count: number;
  warning_count: number;
  conflict_count: number;
  monthly: Array<{
    month: number;
    gross: number;
    enasarco: number | null;
    net: number;
    invoice_count: number;
  }>;
  latest_import: InvoiceImportBatch | null;
};
export type IncomeInvoice = Invoice & {
  document_type?: string;
  source?: string;
  parser_key?: string;
  import_batch_id?: string;
};
