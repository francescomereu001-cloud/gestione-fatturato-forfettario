import test from "node:test";
import assert from "node:assert/strict";
import * as XLSX from "xlsx";
import { detectBankImport } from "./bankImportRegistry.ts";
import { normalizeAmericanExpressDate } from "./americanExpress.ts";

const workbook = (sheets: Record<string, unknown[][]>) => {
  const result = XLSX.utils.book_new();
  for (const [name, rows] of Object.entries(sheets)) XLSX.utils.book_append_sheet(result, XLSX.utils.aoa_to_sheet(rows), name);
  return result;
};

test("detects IsyBank structurally after synthetic metadata and normalizes dates and signs", () => {
  const detected = detectBankImport(workbook({ "Lista Movimenti": [
    ["INTESTATARIO", "MARIO ROSSI"], ["Carta", "1234 **** **** 5678"], [],
    ["Data contabile", "Data valuta", "Descrizione", "Accrediti in valuta", "Accrediti", "Addebiti in valuta", "Addebiti"],
    ["22/09/2026", 46286, "ACQUISTO TEST", "", "", "", 25],
    ["23/09/2026", "23/09/2026", "ACCREDITO TEST", "", 100, "", ""],
  ] }));
  assert.equal(detected.parserKey, "isybank_card_v1");
  assert.equal(detected.compatibleAccountType, "checking");
  assert.deepEqual(detected.rows.map((row) => [row.transaction_date, row.booking_date, row.amount, row.external_id]), [
    ["2026-09-21", "2026-09-22", -25, null], ["2026-09-23", "2026-09-23", 100, null],
  ]);
});

test("detects Amex, reverses signs, keeps rows unclassified and ignores summary sheet", () => {
  const headers = ["Data", "Descrizione", "Importo", "Dettagli completi", "Compare sul tuo estratto conto come", "Indirizzo", "Città/Stato", "CAP", "Paese", "Riferimento", "Categoria"];
  const detected = detectBankImport(workbook({
    "Dettagli transazione": [["Export sintetico"], [], headers,
      ["09/30/2026", "ACQUISTO TEST", 100, "", "", "", "", "", "IT", "REF-SYN-001", "Altro"],
      ["09/12/2026", "ADDEBITO IN C/C SALVO BUON FINE", -500, "", "", "", "", "", "IT", "REF-SYN-002", "Altro"],
      ["01/02/2026", "RIMBORSO TEST", -20, "", "", "", "", "", "IT", "REF-SYN-003", "Altro"],
      ["02/30/2026", "DATA NON VALIDA", 10, "", "", "", "", "", "IT", "REF-SYN-004", "Altro"]],
    "Riepilogo transazioni": [["Data", "Descrizione", "Importo", "Riferimento"], ["04/09/2026", "NON IMPORTARE", 999, "REF-SYN-999"]],
  }));
  assert.equal(detected.parserKey, "american_express_v1");
  assert.equal(detected.compatibleAccountType, "credit_card");
  assert.deepEqual(detected.rows.map((row) => row.transaction_date), ["2026-09-30", "2026-09-12", "2026-01-02", null]);
  assert.deepEqual(detected.rows.map((row) => [row.amount, row.external_id, row.suggested_transaction_type]), [
    [-100, "REF-SYN-001", "unclassified"], [500, "REF-SYN-002", "unclassified"], [20, "REF-SYN-003", "unclassified"],
    [-10, "REF-SYN-004", "unclassified"],
  ]);
  assert.equal(detected.rows[3].status, "error");
  assert.equal(detected.rows.some((row) => row.description === "NON IMPORTARE"), false);
});

test("normalizes American Express dates as MM/DD/YYYY and rejects impossible dates", () => {
  assert.equal(normalizeAmericanExpressDate("09/30/2026"), "2026-09-30");
  assert.equal(normalizeAmericanExpressDate("09/12/2026"), "2026-09-12");
  assert.equal(normalizeAmericanExpressDate("01/02/2026"), "2026-01-02");
  assert.equal(normalizeAmericanExpressDate("02/30/2026"), null);
  assert.equal(normalizeAmericanExpressDate("13/01/2026"), null);
});

test("falls back to the generic parser for an unknown workbook regardless of filename", () => {
  const detected = detectBankImport(workbook({ Movimenti: [["Data", "Importo", "Descrizione"], ["01/10/2026", -10, "TEST"]] }));
  assert.equal(detected.parserKey, "generic_bank_v1");
  assert.equal(detected.generic, true);
  assert.equal(detected.rows[0].amount, -10);
});
