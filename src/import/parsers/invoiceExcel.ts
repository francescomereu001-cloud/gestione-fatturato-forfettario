import { XLSX } from "./workbook";
import type { WorkBook } from "xlsx";
import type { Invoice } from "../../types/finance";
import {
  arubaParserKey,
  type InvoiceParseResult,
  type InvoiceDocument,
} from "../../types/income";
const normalize = (v: unknown) =>
  String(v ?? "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ");
const portalRequired = [
  "Numero",
  "Nome file",
  "ID SdI",
  "Data documento",
  "Tipo documento",
  "Cliente",
  "Totale documento",
  "Netto a pagare",
  "Incassi",
  "Data incasso",
  "Stato",
];
const required = [
  "N. fattura",
  "Società",
  "Data fattura",
  "Descrizione del progetto",
  "Totale fattura",
  "ENASARCO",
  "Netto a pagare (ENASARCO)",
];
export class InvoiceParseError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}
function amount(v: unknown): number | null {
  if (typeof v === "number")
    return Number.isFinite(v) && Math.abs(v) < 1e12 ? v : null;
  const s = String(v ?? "")
    .trim()
    .replace(/[€\s\u00a0]/g, "");
  if (!/^-?(?:\d+|\d{1,3}(?:\.\d{3})+)(?:,\d{1,2})?$/.test(s)) return null;
  const n = Number(s.replace(/\./g, "").replace(",", "."));
  return Number.isFinite(n) && Math.abs(n) < 1e12 ? n : null;
}
function date(v: unknown): string | null {
  if (typeof v === "number") {
    const d = XLSX.SSF.parse_date_code(v);
    return d ? date(`${d.d}/${d.m}/${d.y}`) : null;
  }
  if (v instanceof Date)
    return Number.isNaN(v.getTime())
      ? null
      : date(`${v.getUTCDate()}/${v.getUTCMonth() + 1}/${v.getUTCFullYear()}`);
  const s = String(v ?? "").trim();
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m && !iso) return null;
  const y = Number(m ? m[3] : iso![1]),
    mo = Number(m ? m[2] : iso![2]),
    d = Number(m ? m[1] : iso![3]);
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return y >= 1900 &&
    y <= 2200 &&
    dt.getUTCFullYear() === y &&
    dt.getUTCMonth() === mo - 1 &&
    dt.getUTCDate() === d
    ? dt.toISOString().slice(0, 10)
    : null;
}
export function parseArubaInvoiceWorkbook(
  workbook: WorkBook,
): InvoiceParseResult {
  let nonEmpty = false;
  let recognized = false;
  let partial: string[] | null = null;
  const result: InvoiceParseResult = { parser_key: arubaParserKey, rows: [] };
  for (const name of workbook.SheetNames) {
    const sheet = workbook.Sheets[name];
    if (!sheet) continue;
    const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
      header: 1,
      defval: "",
      raw: true,
    });
    nonEmpty ||= rows.some((r) => r.some((c) => normalize(c)));
    const headerIndex = rows.findIndex((r) => {
      const h = r.map(normalize);
      const matches = required.filter((c) => h.includes(normalize(c)));
      const portalMatches = portalRequired.filter((c) =>
        h.includes(normalize(c)),
      );
      if (portalMatches.length >= 4)
        partial = portalRequired.filter((c) => !h.includes(normalize(c)));
      if (matches.length >= 3)
        partial = required.filter((c) => !h.includes(normalize(c)));
      return (
        matches.length === required.length ||
        portalRequired.every((c) => h.includes(normalize(c)))
      );
    });
    if (headerIndex < 0) continue;
    recognized = true;
    const headers = rows[headerIndex].map(normalize);
    const portal = portalRequired.every((c) => headers.includes(normalize(c)));
    if (
      new Set(headers.filter((h) => h)).size !== headers.filter((h) => h).length
    )
      throw new InvoiceParseError(
        "ambiguous_header",
        "Intestazioni duplicate: verifica il report Aruba.",
      );
    const cols = (
      portal
        ? [
            "Numero",
            "Cliente",
            "Data documento",
            "",
            "Totale documento",
            "ENASARCO",
            "Netto a pagare",
          ]
        : required
    ).map((h) => headers.indexOf(normalize(h)));
    const sdiCol = headers.indexOf("id sdi");
    const typeCol = headers.indexOf("tipo documento");
    for (let i = headerIndex + 1; i < rows.length; i++) {
      const r = rows[i];
      if (!r.some((c) => normalize(c))) continue;
      const [num, customer, issued, description, gross, held, net] = cols.map(
        (c) => r[c],
      );
      if (
        ["totale", "totali", "totale generale"].includes(normalize(num)) ||
        (!normalize(num) &&
          ["totale", "totali", "totale generale"].includes(normalize(customer)))
      )
        continue;
      const raw_data = {
        sheet: name,
        cells: r.map((v) => (v instanceof Date ? v.toISOString() : v)),
      };
      let g = amount(gross),
        e = portal && cols[5] < 0 ? null : amount(held),
        n = amount(net);
      const data = date(issued);
      const warnings: string[] = [];
      const type = typeCol >= 0 ? normalize(r[typeCol]) : "";
      const credit = [
        "td04",
        "nota di credito",
        "nota di credito td04",
        "nota di credito - td04",
      ].includes(type);
      const knownType =
        !type ||
        credit ||
        ["td01", "fattura", "fattura td01", "fattura - td01"].includes(type);
      if (
        !normalize(num) ||
        !normalize(customer) ||
        !data ||
        g === null ||
        (!portal && e === null) ||
        n === null ||
        !knownType
      ) {
        result.rows.push({
          row_index: result.rows.length + 1,
          raw_data: { ...raw_data, excel_row: i + 1 },
          normalized_data: null,
          warning_codes: [],
          rejection_code: !knownType
            ? "unsupported_document_type"
            : "invalid_required_values",
        });
        continue;
      }
      const enasarco_source =
        portal && cols[5] < 0 ? "document_gross_net_delta" : "document_column";
      // Explicit FinancialMind policy: the entire gross/net difference is ENASARCO.
      if (enasarco_source === "document_gross_net_delta")
        e = Math.round((g - n) * 100) / 100;
      if (credit) {
        g = -Math.abs(g);
        e = e === null ? null : -Math.abs(e);
        n = -Math.abs(n);
      }
      const document_type: InvoiceDocument["document_type"] = credit
        ? "credit_note"
        : g < 0 || n < 0
          ? "signed_adjustment"
          : "invoice";
      if (document_type === "signed_adjustment")
        warnings.push("signed_document_type_unverified");
      if (e === null) warnings.push("enasarco_missing_in_source");
      if (e !== null && Math.abs(g - e - n) > 0.020001)
        warnings.push("gross_enasarco_net_mismatch");
      if (
        e !== null &&
        ((g > 0 && (e < 0 || n < 0)) || (g < 0 && (e > 0 || n > 0)))
      )
        warnings.push("amount_sign_mismatch");
      result.rows.push({
        row_index: result.rows.length + 1,
        raw_data: { ...raw_data, excel_row: i + 1 },
        normalized_data: {
          numero: String(num).trim(),
          cliente: String(customer).trim(),
          data,
          descrizione: String(description ?? "").trim(),
          lordo: g,
          enasarco: e,
          netto: n,
          document_type,
          enasarco_source,
          ...(sdiCol >= 0 && normalize(r[sdiCol])
            ? { source_document_id: String(r[sdiCol]).trim() }
            : {}),
        },
        warning_codes: warnings,
      });
    }
  }
  if (!nonEmpty)
    throw new InvoiceParseError("empty_workbook", "Il workbook è vuoto.");
  if (!result.rows.length) {
    if ((partial as string[] | null)?.length)
      throw new InvoiceParseError(
        "missing_columns",
        `Colonne Aruba obbligatorie mancanti: ${(partial as unknown as string[]).join(", ")}.`,
      );
    if (recognized)
      throw new InvoiceParseError(
        "no_document_rows",
        "Intestazioni Aruba riconosciute, ma nessuna riga documento presente.",
      );
    throw new InvoiceParseError(
      "not_aruba",
      "Formato non Aruba: intestazioni del report fatture inviate non riconosciute.",
    );
  }
  return result;
}
/** Deprecated compatibility adapter; application imports use audited staging. */
export function parseInvoiceWorkbook(
  workbook: WorkBook,
  fileName: string,
): Invoice[] {
  return parseArubaInvoiceWorkbook(workbook).rows.flatMap((r) =>
    r.normalized_data
      ? [
          {
            ...r.normalized_data,
            incassata: true,
            data_incasso: r.normalized_data.data,
            anno: Number(r.normalized_data.data.slice(0, 4)),
            categoria:
              r.normalized_data.document_type === "credit_note"
                ? "Nota di credito"
                : "Import Aruba",
            note: `Import da file: ${fileName}`,
          },
        ]
      : [],
  );
}
