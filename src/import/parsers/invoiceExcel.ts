import * as XLSX from "xlsx";
import type { Invoice } from "../../types/finance";

const normalize = (value: unknown) =>
  String(value ?? "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ");

const parseAmount = (value: unknown): number => {
  if (typeof value === "number") return value;
  const normalized = String(value ?? "")
    .replace(/[€\s]/g, "")
    .replace(/\./g, "")
    .replace(",", ".")
    .replace(/[^\d.-]/g, "");
  const amount = Number(normalized);
  return Number.isFinite(amount) ? amount : 0;
};

const parseExcelDate = (value: unknown): string | undefined => {
  if (!value) return undefined;

  if (typeof value === "number") {
    const date = XLSX.SSF.parse_date_code(value);
    if (!date) return undefined;
    return `${date.y}-${String(date.m).padStart(2, "0")}-${String(date.d).padStart(2, "0")}`;
  }

  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString().slice(0, 10);
  }

  const text = String(value).trim();
  const italianDate = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (italianDate) {
    return `${italianDate[3]}-${italianDate[2].padStart(2, "0")}-${italianDate[1].padStart(2, "0")}`;
  }

  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString().slice(0, 10);
};

export function parseInvoiceWorkbook(workbook: XLSX.WorkBook, fileName: string): Invoice[] {
  const invoices: Invoice[] = [];

  workbook.SheetNames.forEach((sheetName) => {
    const rows: unknown[][] = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], {
      header: 1,
      defval: "",
      raw: true,
    });
    const headerRowIndex = rows.findIndex((row) => {
      const joined = row.map(normalize).join(" | ");
      return joined.includes("numero") && joined.includes("cliente") &&
        (joined.includes("totale documento") || joined.includes("netto a pagare") || joined.includes("totale fattura"));
    });
    if (headerRowIndex === -1) return;

    const headers = rows[headerRowIndex].map(normalize);
    const findColumn = (...names: string[]) =>
      headers.findIndex((header) => names.some((name) => header === normalize(name) || header.includes(normalize(name))));
    const columns = {
      numero: findColumn("Numero", "N. fattura", "Numero fattura"),
      data: findColumn("Data documento", "Data fattura", "Data"),
      cliente: findColumn("Cliente", "Società", "Societa"),
      tipo: findColumn("Tipo documento"),
      totale: findColumn("Totale documento", "Totale fattura"),
      netto: findColumn("Netto a pagare", "Netto a pagare (ENASARCO)", "Netto"),
      incassi: findColumn("Incassi", "Stato incasso"),
      dataIncasso: findColumn("Data incasso"),
      stato: findColumn("Stato"),
      descrizione: findColumn("Descrizione del progetto", "Descrizione"),
    };

    rows.slice(headerRowIndex + 1).forEach((row) => {
      const numero = row[columns.numero];
      const cliente = row[columns.cliente];
      const tipoDocumento = columns.tipo >= 0 ? row[columns.tipo] : "";
      const data = parseExcelDate(row[columns.data]);
      const lordo = columns.totale >= 0 ? parseAmount(row[columns.totale]) : 0;
      const netto = columns.netto >= 0 ? parseAmount(row[columns.netto]) || lordo : lordo;
      if (!numero || !cliente || !data || (!lordo && !netto) || normalize(numero).includes("totale")) return;

      const isNotaCredito = normalize(tipoDocumento).includes("nota") || normalize(tipoDocumento).includes("td04");
      const sign = isNotaCredito ? -1 : 1;
      const incassi = columns.incassi >= 0 ? normalize(row[columns.incassi]) : "";
      const stato = columns.stato >= 0 ? normalize(row[columns.stato]) : "";
      const descrizione = columns.descrizione >= 0 && row[columns.descrizione]
        ? row[columns.descrizione]
        : tipoDocumento || "Fattura elettronica";

      invoices.push({
        numero: String(numero).trim(),
        data,
        cliente: String(cliente).trim(),
        descrizione: String(descrizione).trim(),
        lordo: Math.abs(lordo || netto) * sign,
        enasarco: 0,
        netto: Math.abs(netto || lordo) * sign,
        incassata: incassi.includes("incassat") || stato.includes("incassat"),
        data_incasso: columns.dataIncasso >= 0 ? parseExcelDate(row[columns.dataIncasso]) : undefined,
        anno: new Date(data).getFullYear(),
        categoria: isNotaCredito ? "Nota di credito" : "Import portale FE",
        note: `Import da file: ${fileName}`,
      });
    });
  });

  return invoices;
}
