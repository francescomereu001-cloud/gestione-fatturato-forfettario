import test from "node:test";
import assert from "node:assert/strict";
import * as XLSX from "xlsx";
import { parseIsyBankOperations } from "./isyBankOperations.ts";
import { detectBankImport } from "./bankImportRegistry.ts";
import { fingerprint } from "./bankStatement.ts";

const headers = ["Data", "Operazione", "Dettagli", "Conto o carta", "Contabilizzazione", "Categoria", "Valuta", "Importo"];
const movement = (date: unknown = "07/09/2025", amount: unknown = "-1.234,56") =>
  [date, "PAGAMENTO TEST", "Descrizione sintetica", "Conto sintetico", "Contabilizzato", "Spese sintetiche", "EUR", amount];
const workbook = (rows: unknown[][], name = "Foglio1") => {
  const result = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(result, XLSX.utils.aoa_to_sheet(rows), name);
  return result;
};

test("recognizes operations after metadata and excludes summaries and repeated headers", () => {
  const detected = detectBankImport(workbook([
    ["Lista Operazioni"], ["Saldo", 2000], ["Data", "Importo", "Descrizione"],
    ["06/10/2026", 1000, "Riepilogo sintetico"], [], headers,
    movement(), [], headers, ["Totale", "", "Riepilogo", "", "", "", "", 1000],
    movement("06/10/2026", "+2.000,00"),
  ]));
  assert.equal(detected.parserKey, "isybank_operations_v1");
  assert.equal(detected.providerLabel, "IsyBank");
  assert.equal(detected.compatibleAccountType, null);
  assert.equal(detected.generic, false);
  assert.equal(detected.rows.length, 2);
  assert.deepEqual(detected.rows.map((row) => [row.transaction_date, row.amount, row.row_index]), [
    ["2025-09-07", -1234.56, 0], ["2026-10-06", 2000, 1],
  ]);
});

test("maps canonical fields and preserves original bank metadata without classification", () => {
  const [row] = parseIsyBankOperations(workbook([headers, movement()]))!;
  assert.equal(row.description, "Descrizione sintetica");
  assert.equal(row.source_instrument, "Conto sintetico");
  assert.equal(row.merchant, "PAGAMENTO TEST");
  assert.equal(row.booking_date, null);
  assert.equal(row.external_id, null);
  assert.equal(row.suggested_transaction_type, "unclassified");
  assert.equal(row.suggested_category_id, null);
  assert.equal(row.status, "ready");
  assert.deepEqual(row.raw_data, Object.fromEntries(headers.map((header, index) => [header, movement()[index]])));
});

test("uses the existing deterministic fingerprint", () => {
  const source = workbook([headers, movement()]);
  const [first] = parseIsyBankOperations(source)!;
  const [second] = parseIsyBankOperations(source)!;
  assert.equal(first.dedupe_fingerprint, fingerprint(first));
  assert.equal(first.dedupe_fingerprint, second.dedupe_fingerprint);
});

test("normalizes header whitespace and case and finds the table in a later sheet", () => {
  const source = workbook([["Riepilogo", 999]]);
  XLSX.utils.book_append_sheet(source, XLSX.utils.aoa_to_sheet([
    headers.map((header) => `  ${header.toUpperCase().replaceAll(" ", "   ")}  `),
    movement(46286, -25), movement("06/10/2026", 50),
  ]), "Operazioni");
  const rows = parseIsyBankOperations(source)!;
  assert.deepEqual(rows.map((row) => [row.transaction_date, row.amount]), [["2026-09-21", -25], ["2026-10-06", 50]]);
});

test("returns null for incompatible tables even when the sheet is named ListaOperazioni", () => {
  for (const missing of headers) {
    assert.equal(parseIsyBankOperations(workbook([headers.filter((header) => header !== missing)], "ListaOperazioni")), null);
  }
  const source = workbook([["Data", "Operazione", "Dettagli", "Importo"], ["06/10/2026", "TEST", "TEST", -10]], "ListaOperazioni");
  assert.equal(parseIsyBankOperations(source), null);
  assert.equal(detectBankImport(source).parserKey, "generic_bank_v1");
});

test("keeps dated malformed movements visible as staging errors", () => {
  const rows = parseIsyBankOperations(workbook([headers,
    movement("06/10/2026", "non valido"),
    ["06/10/2026", "TEST", "", "", "Contabilizzato", "", "EUR", -10],
  ]))!;
  assert.equal(rows.length, 2);
  assert.ok(rows.every((row) => row.status === "error" && row.dedupe_fingerprint === null));
});

test("handles a synthetic 903-movement XLSX without importing five introductory rows", () => {
  const movements = Array.from({ length: 903 }, (_, index) =>
    movement(index === 0 ? "07/09/2025" : "06/10/2026", index % 2 ? 50 : -25));
  const source = workbook([["Lista Operazioni"], ["Saldo", 123], ["Periodo", "2025-2026"], ["Totale", 456], [], headers, ...movements]);
  const bytes = XLSX.write(source, { type: "buffer", bookType: "xlsx" });
  const detected = detectBankImport(XLSX.read(bytes, { type: "buffer" }));
  assert.equal(detected.rows.length, 903);
  assert.equal(detected.parserKey, "isybank_operations_v1");
  assert.equal(detected.rows[0].transaction_date, "2025-09-07");
  assert.equal(detected.rows.at(-1)!.transaction_date, "2026-10-06");
  assert.ok(detected.rows.every((row) => row.status === "ready" && row.description && row.dedupe_fingerprint));
  assert.deepEqual(detected.rows.map((row) => row.amount), movements.map((row) => row[7]));
});

test("extracts distinct instruments while retaining the exact original metadata", () => {
  const source = workbook([headers,
    ["06/10/2026", "TEST", "Synthetic checking", " Conto TEST / 00000001 ", "Contabilizzato", "", "EUR", -10],
    ["06/10/2026", "TEST", "Synthetic card", "Carta di credito **** 9999", "Contabilizzato", "", "EUR", -10],
  ]);
  const rows = parseIsyBankOperations(source)!;
  assert.deepEqual(rows.map((row) => row.source_instrument), ["Conto TEST / 00000001", "Carta di credito **** 9999"]);
  assert.equal(rows[0].raw_data["Conto o carta"], " Conto TEST / 00000001 ");
  assert.ok(rows.every((row) => row.target_account_id === null && row.suggested_transaction_type === "unclassified"));
});

test("missing instrument is a visible error even for an otherwise valid movement", () => {
  const rows = parseIsyBankOperations(workbook([headers, ["06/10/2026", "TEST", "Synthetic", "", "", "", "EUR", -10]]))!;
  assert.equal(rows[0].source_instrument, null);
  assert.equal(rows[0].status, "error");
});
