import type * as XLSX from "xlsx";
import type { ImportRow } from "../../types/imports.ts";
import { fingerprint, normalizeAmount, normalizeDate, normalizedKey, sheetRows, tableAt } from "./bankStatement.ts";

export const AMERICAN_EXPRESS_PARSER_KEY = "american_express_v1";

export function parseAmericanExpress(workbook: XLSX.WorkBook): ImportRow[] | null {
  const sheetName = workbook.SheetNames.find((name) => normalizedKey(name) === "dettagli transazione");
  if (!sheetName) return null;
  const matrix = sheetRows(workbook, sheetName);
  const headerIndex = matrix.findIndex((cells) => {
    const keys = cells.map(normalizedKey);
    return keys.includes("data") && keys.includes("descrizione") && keys.includes("importo") && keys.includes("riferimento");
  });
  if (headerIndex < 0) return null;
  const table = tableAt(matrix, headerIndex);
  return table.rows.filter((raw) => Object.values(raw).some((value) => String(value ?? "").trim())).map((raw_data, row_index) => {
    const field = (name: string) => raw_data[table.headers.find((header) => normalizedKey(header) === name) ?? ""];
    const transaction_date = normalizeDate(field("data"));
    const rawAmount = normalizeAmount(field("importo"));
    const amount = rawAmount === null ? null : -rawAmount;
    const description = String(field("descrizione") ?? "").trim() || null;
    const external_id = String(field("riferimento") ?? "").trim() || null;
    const row: ImportRow = { row_index, transaction_date, booking_date: null, amount, description, merchant: null, external_id,
      dedupe_fingerprint: null, suggested_transaction_type: "unclassified", suggested_category_id: null,
      status: transaction_date && amount !== null && description ? "ready" : "error", raw_data };
    row.dedupe_fingerprint = row.status === "ready" ? fingerprint(row) : null;
    return row;
  });
}
