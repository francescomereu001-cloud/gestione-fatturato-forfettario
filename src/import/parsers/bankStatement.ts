import * as XLSX from "xlsx";
import type { ImportRow } from "../../types/imports.ts";

type RawRow = Record<string, unknown>;
const aliases = {
  transaction_date: ["data", "data operazione", "transaction date", "date", "valuta"],
  booking_date: ["data contabile", "booking date", "data registrazione"],
  amount: ["importo", "amount", "ammontare", "valore"],
  credit: ["accredito", "entrate", "credit", "avere"],
  debit: ["addebito", "uscite", "debit", "dare"],
  description: ["descrizione", "causale", "description", "operazione"],
  merchant: ["beneficiario", "ordinante", "merchant", "controparte"],
  external_id: ["id", "id operazione", "transaction id", "numero operazione", "riferimento"],
} as const;

const normalizedKey = (value: string) => value.trim().toLocaleLowerCase("it-IT").replace(/\s+/g, " ");
function get(row: RawRow, names: readonly string[]) {
  const key = Object.keys(row).find((candidate) => names.includes(normalizedKey(candidate)));
  return key ? row[key] : undefined;
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
  let text = String(value ?? "").trim().replace(/[€\s]/g, "");
  if (!text) return null;
  const negative = /^-/.test(text) || /^\(.*\)$/.test(text);
  text = text.replace(/[()-]/g, "");
  if (text.includes(",")) text = text.replace(/\./g, "").replace(",", ".");
  const amount = Number(text);
  return Number.isFinite(amount) && amount !== 0 ? (negative ? -amount : amount) : null;
}

export function fingerprint(row: Pick<ImportRow, "transaction_date" | "amount" | "description">): string {
  const canonical = `${row.transaction_date ?? ""}|${Number(row.amount).toFixed(2)}|${(row.description ?? "").trim().toLocaleLowerCase("it-IT").replace(/\s+/g, " ")}`;
  let hash = 2166136261;
  for (let i = 0; i < canonical.length; i += 1) hash = Math.imul(hash ^ canonical.charCodeAt(i), 16777619);
  return `v1-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

export function normalizeBankRows(rows: RawRow[]): ImportRow[] {
  return rows.filter((row) => Object.values(row).some((value) => String(value ?? "").trim())).map((raw_data, row_index) => {
    const direct = normalizeAmount(get(raw_data, aliases.amount));
    const credit = normalizeAmount(get(raw_data, aliases.credit));
    const debit = normalizeAmount(get(raw_data, aliases.debit));
    const amount = direct ?? (credit ? Math.abs(credit) : debit ? -Math.abs(debit) : null);
    const transaction_date = normalizeDate(get(raw_data, aliases.transaction_date));
    const description = String(get(raw_data, aliases.description) ?? "").trim() || null;
    const row: ImportRow = {
      row_index, transaction_date, booking_date: normalizeDate(get(raw_data, aliases.booking_date)), amount,
      description, merchant: String(get(raw_data, aliases.merchant) ?? "").trim() || null,
      external_id: String(get(raw_data, aliases.external_id) ?? "").trim() || null,
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

export function parseBankCsv(text: string): ImportRow[] {
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/).filter((line) => line.trim());
  if (!lines.length) return [];
  const delimiter = (lines[0].match(/;/g)?.length ?? 0) >= (lines[0].match(/,/g)?.length ?? 0) ? ";" : ",";
  const headers = parseCsvLine(lines[0], delimiter);
  return normalizeBankRows(lines.slice(1).map((line) => Object.fromEntries(parseCsvLine(line, delimiter).map((value, index) => [headers[index] ?? `column_${index}`, value]))));
}

export function parseBankWorkbook(workbook: XLSX.WorkBook): ImportRow[] {
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  return sheet ? normalizeBankRows(XLSX.utils.sheet_to_json<RawRow>(sheet, { raw: true, defval: "" })) : [];
}
