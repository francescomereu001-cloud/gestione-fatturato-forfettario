import type * as XLSX from "xlsx";
import type { ImportRow } from "../../types/imports.ts";
import { fingerprint, normalizeAmount, normalizeDate, normalizedKey, sheetRows, tableAt } from "./bankStatement.ts";

export const ISYBANK_PARSER_KEY = "isybank_card_v1";

export function parseIsyBank(workbook: XLSX.WorkBook): ImportRow[] | null {
  const sheetName = workbook.SheetNames.find((name) => normalizedKey(name) === "lista movimenti");
  if (!sheetName) return null;
  const matrix = sheetRows(workbook, sheetName);
  const headerIndex = matrix.findIndex((cells) => {
    const keys = cells.map(normalizedKey);
    return keys.includes("data contabile") && keys.includes("data valuta") && keys.includes("descrizione")
      && keys.includes("accrediti") && keys.includes("addebiti");
  });
  if (headerIndex < 0) return null;
  const table = tableAt(matrix, headerIndex);
  return table.rows.filter((raw) => Object.values(raw).some((value) => String(value ?? "").trim())).map((raw_data, row_index) => {
    const field = (name: string) => raw_data[table.headers.find((header) => normalizedKey(header) === name) ?? ""];
    const booking_date = normalizeDate(field("data contabile"));
    const transaction_date = normalizeDate(field("data valuta")) ?? booking_date;
    const credit = normalizeAmount(field("accrediti"));
    const debit = normalizeAmount(field("addebiti"));
    const amount = credit !== null ? Math.abs(credit) : debit !== null ? -Math.abs(debit) : null;
    const description = String(field("descrizione") ?? "").trim() || null;
    const row: ImportRow = { row_index, transaction_date, booking_date, amount, description, merchant: null, external_id: null,
      dedupe_fingerprint: null, suggested_transaction_type: "unclassified", suggested_category_id: null,
      status: transaction_date && amount !== null && description ? "ready" : "error", raw_data };
    row.dedupe_fingerprint = row.status === "ready" ? fingerprint(row) : null;
    return row;
  });
}
