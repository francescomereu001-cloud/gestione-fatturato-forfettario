import * as XLSX from "xlsx";
import type { ImportRow } from "../../types/imports.ts";

export type RawBankRow = Record<string, unknown>;
export const mappingFields = ["transaction_date", "booking_date", "amount", "debit", "credit", "description", "merchant", "external_id"] as const;
export type MappingField = (typeof mappingFields)[number];
export type ColumnMapping = Partial<Record<MappingField, string>>;
export type ReadBankFile = { headers: string[]; rows: RawBankRow[] };

const aliases: Record<MappingField, readonly string[]> = {
  transaction_date: ["data", "data operazione", "transaction date", "date", "valuta"],
  booking_date: ["data contabile", "booking date", "data registrazione"],
  amount: ["importo", "amount", "ammontare", "valore"],
  credit: ["accredito", "entrate", "credit", "avere"],
  debit: ["addebito", "uscite", "debit", "dare"],
  description: ["descrizione", "causale", "description", "operazione"],
  merchant: ["beneficiario", "ordinante", "merchant", "controparte"],
  external_id: ["id", "id operazione", "transaction id", "numero operazione", "riferimento"],
};

const normalizedKey = (value: string) => value.trim().toLocaleLowerCase("it-IT").replace(/\s+/g, " ");
export function detectHeaders(rows: RawBankRow[]): string[] {
  return Array.from(new Set(rows.flatMap((row) => Object.keys(row))));
}
export function suggestColumnMapping(headers: string[]): ColumnMapping {
  return Object.fromEntries(mappingFields.flatMap((field) => {
    const header = headers.find((candidate) => aliases[field].includes(normalizedKey(candidate)));
    return header ? [[field, header]] : [];
  })) as ColumnMapping;
}

export function normalizeDate(value: unknown): string | null {
  if (value instanceof Date && !Number.isNaN(value.valueOf())) return value.toISOString().slice(0, 10);
  if (typeof value === "number") {
    const parsed = XLSX.SSF.parse_date_code(value);
    return parsed ? `${parsed.y}-${String(parsed.m).padStart(2, "0")}-${String(parsed.d).padStart(2, "0")}` : null;
  }
  const text = String(value ?? "").trim();
  if (!text) return null;
  const italian = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(text);
  if (italian) return `${italian[3]}-${italian[2].padStart(2, "0")}-${italian[1].padStart(2, "0")}`;
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : null;
}

export function normalizeAmount(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) && value !== 0 ? value : null;
  let text = String(value ?? "").trim().replace(/[^\d.,()\-+]/g, "");
  if (!text) return null;
  const negative = text.startsWith("-") || (text.startsWith("(") && text.endsWith(")"));
  text = text.replace(/[()+-]/g, "");
  const comma = text.lastIndexOf(","); const dot = text.lastIndexOf(".");
  if (comma >= 0 && dot >= 0) {
    const decimal = comma > dot ? "," : "."; const thousands = decimal === "," ? "." : ",";
    text = text.split(thousands).join("").replace(decimal, ".");
  } else if (comma >= 0) text = text.replace(/,/g, ".");
  const amount = Number(text);
  return Number.isFinite(amount) && amount !== 0 ? (negative ? -amount : amount) : null;
}

export function fingerprint(row: Pick<ImportRow, "transaction_date" | "amount" | "description">): string {
  const canonical = `${row.transaction_date ?? ""}|${Number(row.amount).toFixed(2)}|${(row.description ?? "").trim().toLocaleLowerCase("it-IT").replace(/\s+/g, " ")}`;
  let hash = 2166136261;
  for (let i = 0; i < canonical.length; i += 1) hash = Math.imul(hash ^ canonical.charCodeAt(i), 16777619);
  return `v1-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

export function normalizeBankRows(rows: RawBankRow[], mapping: ColumnMapping): ImportRow[] {
  const value = (row: RawBankRow, field: MappingField) => mapping[field] ? row[mapping[field]!] : undefined;
  return rows.filter((row) => Object.values(row).some((item) => String(item ?? "").trim())).map((raw_data, row_index) => {
    const direct = normalizeAmount(value(raw_data, "amount"));
    const credit = normalizeAmount(value(raw_data, "credit"));
    const debit = normalizeAmount(value(raw_data, "debit"));
    const amount = direct ?? (credit ? Math.abs(credit) : debit ? -Math.abs(debit) : null);
    const transaction_date = normalizeDate(value(raw_data, "transaction_date"));
    const description = String(value(raw_data, "description") ?? "").trim() || null;
    const row: ImportRow = {
      row_index, transaction_date, booking_date: normalizeDate(value(raw_data, "booking_date")), amount,
      description, merchant: String(value(raw_data, "merchant") ?? "").trim() || null,
      external_id: String(value(raw_data, "external_id") ?? "").trim() || null,
      dedupe_fingerprint: null, suggested_transaction_type: "unclassified", suggested_category_id: null,
      status: transaction_date && amount && description ? "ready" : "error", raw_data,
    };
    row.dedupe_fingerprint = row.status === "ready" ? fingerprint(row) : null;
    return row;
  });
}

function parseCsvLine(line: string, delimiter: string): string[] {
  const cells: string[] = []; let cell = ""; let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (char === '"' && quoted && line[i + 1] === '"') { cell += '"'; i += 1; }
    else if (char === '"') quoted = !quoted;
    else if (char === delimiter && !quoted) { cells.push(cell); cell = ""; }
    else cell += char;
  }
  cells.push(cell); return cells;
}

export function readCsv(text: string): ReadBankFile {
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/).filter((line) => line.trim());
  if (!lines.length) return { headers: [], rows: [] };
  const delimiter = (lines[0].match(/;/g)?.length ?? 0) >= (lines[0].match(/,/g)?.length ?? 0) ? ";" : ",";
  const headers = parseCsvLine(lines[0], delimiter).map((header) => header.trim());
  const rows = lines.slice(1).map((line) => Object.fromEntries(parseCsvLine(line, delimiter).map((cell, index) => [headers[index] ?? `column_${index}`, cell])));
  return { headers, rows };
}

export function readWorkbook(workbook: XLSX.WorkBook): ReadBankFile {
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const rows = sheet ? XLSX.utils.sheet_to_json<RawBankRow>(sheet, { raw: true, defval: "" }) : [];
  return { headers: detectHeaders(rows), rows };
}

// Compatibility helpers for callers that accept automatic mapping.
export function parseBankCsv(text: string): ImportRow[] { const read = readCsv(text); return normalizeBankRows(read.rows, suggestColumnMapping(read.headers)); }
export function parseBankWorkbook(workbook: XLSX.WorkBook): ImportRow[] { const read = readWorkbook(workbook); return normalizeBankRows(read.rows, suggestColumnMapping(read.headers)); }
