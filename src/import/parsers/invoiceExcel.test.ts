import assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as XLSX from "xlsx";
import { parseInvoiceWorkbook } from "./invoiceExcel.ts";

describe("parseInvoiceWorkbook", () => {
  it("normalizza fatture e note di credito senza accedere al database", () => {
    const sheet = XLSX.utils.aoa_to_sheet([
      ["Numero", "Data documento", "Cliente", "Tipo documento", "Totale documento", "Netto a pagare", "Stato incasso"],
      ["1", "10/02/2026", "Cliente Uno", "TD01", "1.000,00 €", "900,00 €", "Incassata"],
      ["2", "11/02/2026", "Cliente Due", "Nota di credito TD04", 200, 180, ""],
    ]);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, sheet, "Fatture");

    const result = parseInvoiceWorkbook(workbook, "fatture.xlsx");

    assert.equal(result.length, 2);
    assert.deepEqual(
      { numero: result[0].numero, lordo: result[0].lordo, netto: result[0].netto, incassata: result[0].incassata },
      { numero: "1", lordo: 1_000, netto: 900, incassata: true },
    );
    assert.deepEqual(
      { lordo: result[1].lordo, netto: result[1].netto, categoria: result[1].categoria },
      { lordo: -200, netto: -180, categoria: "Nota di credito" },
    );
    assert.equal(result[0].note, "Import da file: fatture.xlsx");
  });
});
