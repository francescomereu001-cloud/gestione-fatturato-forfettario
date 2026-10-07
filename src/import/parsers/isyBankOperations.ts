import { isCalendarDate } from "../../domain/transactions/dates.ts";
import type * as XLSX from "xlsx";
import type { ImportRow } from "../../types/imports.ts";
import { normalizeBankRows, normalizeDate, normalizedKey, sheetRows, tableAt } from "./bankStatement.ts";

export const ISYBANK_OPERATIONS_PARSER_KEY = "isybank_operations_v1";

// Require the full export signature to avoid claiming generic bank tables.
const requiredHeaders = ["data", "operazione", "dettagli", "conto o carta", "contabilizzazione", "categoria", "valuta", "importo"];

export function parseIsyBankOperations(workbook: XLSX.WorkBook): ImportRow[] | null {
  for (const sheetName of workbook.SheetNames) {
    const matrix = sheetRows(workbook, sheetName);
    const headerIndex = matrix.findIndex((cells) => {
      const keys = cells.map(normalizedKey);
      return requiredHeaders.every((header) => keys.includes(header));
    });
    if (headerIndex < 0) continue;
    const table = tableAt(matrix, headerIndex);
    const column = (key: string) => table.headers.find((header) => normalizedKey(header) === key)!;
    // Metadata, totals, blank rows and repeated headers have no movement date.
    // Keep dated rows with invalid amounts/details so staging can report errors.
    const movements = table.rows.filter((raw) => normalizeDate(raw[column("data")]) !== null);
    return normalizeBankRows(movements, {
      transaction_date: column("data"), booking_date: column("contabilizzazione"), amount: column("importo"),
      description: column("dettagli"), merchant: column("operazione"),
    }).map((row) => {
      const source_instrument = String(row.raw_data[column("conto o carta")] ?? "").trim() || null;
      return { ...row, booking_date: row.booking_date && isCalendarDate(row.booking_date) ? row.booking_date : null, source_instrument, target_account_id: null,
        status: source_instrument ? row.status : "error" };
    });
  }
  return null;
}
