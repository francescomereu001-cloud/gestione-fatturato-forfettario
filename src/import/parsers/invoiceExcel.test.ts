import assert from "node:assert/strict";
import { test } from "node:test";
import { XLSX } from "./workbook.ts";
import {
  parseArubaInvoiceWorkbook,
  parseInvoiceWorkbook,
  InvoiceParseError,
} from "./invoiceExcel.ts";
const header = [
  "N. fattura",
  "Società",
  "Data fattura",
  "Descrizione del progetto",
  "Totale fattura",
  "ENASARCO",
  "Netto a pagare (ENASARCO)",
  "Tipo documento",
];
const portal = [
  "Numero",
  "Nome file",
  "ID SdI",
  "Data invio",
  "Data documento",
  "Tipo documento",
  "Tipo cliente",
  "Cliente",
  "P.IVA",
  "Codice Fiscale",
  "Indirizzo telematico",
  "Metodo di pagamento",
  "Totale imponibile",
  "Totale escluso IVA (N1)",
  "Totale non soggetto IVA (N2)",
  "Totale non imponibile IVA (N3)",
  "Totale esente IVA (N4)",
  "Totale regime del margine/IVA non esposta (N5)",
  "Totale inversione contabile (N6)",
  "Totale importo assoggettato ad IVA assolta in altro stato UE (N7)",
  "Totale IVA",
  "Totale documento",
  "Netto a pagare",
  "Incassi",
  "Data incasso",
  "Stato",
];
function book(rows: unknown[][]) {
  const w = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    w,
    XLSX.utils.aoa_to_sheet(rows),
    "FattureInviate",
  );
  return w;
}
for (const bookType of ["xls", "xlsx"] as const)
  test(`Aruba ${bookType}: exact headers, offset, Italian values, numeric/serial, ENASARCO, duplicates, credit and totals`, () => {
    const w = book([
      ["Report fatture"],
      [],
      header,
      [
        "1",
        "Cliente Uno",
        "10/02/2025",
        "Progetto",
        "1.234,56 €",
        "100,00",
        "1.134,56",
        "TD01",
      ],
      ["2", "Cliente Due", 45700, "", 200, 20, 180, "TD04"],
      ["3", "Cliente Due", "11/02/2025", "", 0, 0, 0, ""],
      [
        "1",
        "Cliente Uno",
        "10/02/2025",
        "Progetto",
        1234.56,
        100,
        1134.56,
        "TD01",
      ],
      ["Totale", "", "", "", 1434.56],
      [],
      ["4", "Cliente", "31/02/2025", "", 1, 0, 1, "TD01"],
      ["5", "Cliente", "12/02/2025", "", 10, 1, 8, "TD01"],
    ]);
    const parsed = parseArubaInvoiceWorkbook(
      XLSX.read(XLSX.write(w, { type: "buffer", bookType }), {
        type: "buffer",
      }),
    );
    assert.equal(parsed.rows.length, 6);
    assert.deepEqual(parsed.rows[0].normalized_data, {
      numero: "1",
      cliente: "Cliente Uno",
      data: "2025-02-10",
      descrizione: "Progetto",
      lordo: 1234.56,
      enasarco: 100,
      netto: 1134.56,
      document_type: "invoice",
      enasarco_source: "document_column",
    });
    assert.equal(parsed.rows[1].normalized_data?.lordo, -200);
    assert.equal(parsed.rows[1].normalized_data?.enasarco, -20);
    assert.equal(parsed.rows[1].normalized_data?.netto, -180);
    assert.equal(parsed.rows[2].normalized_data?.netto, 0);
    assert.equal(parsed.rows[4].normalized_data, null);
    assert.deepEqual(parsed.rows[5].warning_codes, [
      "gross_enasarco_net_mismatch",
    ]);
    const legacy = parseInvoiceWorkbook(w, "fixture.xls");
    assert.equal(legacy[0].incassata, true);
    assert.equal(legacy[0].data_incasso, legacy[0].data);
  });
test("real export schema: TD04 and SDI identity; confirmed policy derives absent ENASARCO from documentary gross/net delta", () => {
  const row = (type: string, gross: number, net: number, id: string) => [
    "FPR 1/25",
    "synthetic.xml",
    id,
    45700,
    45700,
    type,
    "Privato",
    "Cliente sintetico",
    "000",
    "000",
    "TEST",
    "MP05",
    0,
    0,
    gross,
    0,
    0,
    0,
    0,
    0,
    0,
    gross,
    net,
    "Non incassata",
    "",
    "Consegnata",
  ];
  const result = parseArubaInvoiceWorkbook(
    book([
      portal,
      row("Fattura - TD01", 1000, 950, "synthetic-1"),
      row("Nota di credito - TD04", -100, -100, "synthetic-2"),
    ]),
  );
  assert.equal(result.rows[0].normalized_data?.enasarco, 50);
  assert.equal(result.rows[0].normalized_data?.netto, 950);
  assert.equal(
    result.rows[0].normalized_data?.source_document_id,
    "synthetic-1",
  );
  assert.deepEqual(result.rows[0].warning_codes, []);
  assert.equal(
    result.rows[0].normalized_data?.enasarco_source,
    "document_gross_net_delta",
  );
  assert.equal(result.rows[1].normalized_data?.document_type, "credit_note");
  assert.equal(result.rows[1].normalized_data?.lordo, -100);
});
test("case, accents and whitespace vary minimally; exact aliases only", () => {
  assert.equal(
    parseArubaInvoiceWorkbook(
      book([
        header.map(
          (h) => " " + h.toUpperCase().replace("SOCIETÀ", "SOCIETA") + "  ",
        ),
        ["1", "X", "1/1/2025", "", 1, 0, 1, ""],
      ]),
    ).rows.length,
    1,
  );
  assert.throws(
    () =>
      parseArubaInvoiceWorkbook(
        book([
          ["Not Numero", "Not Cliente", "Totale documento"],
          ["1", "x", 100],
        ]),
      ),
    (e: unknown) => e instanceof InvoiceParseError && e.code === "not_aruba",
  );
});
test("structured errors distinguish empty workbook, missing columns and no data", () => {
  assert.throws(
    () => parseArubaInvoiceWorkbook(book([])),
    (e: unknown) =>
      e instanceof InvoiceParseError && e.code === "empty_workbook",
  );
  assert.throws(
    () =>
      parseArubaInvoiceWorkbook(
        book([header.slice(0, 5), ["1", "X", "1/1/2025", "", 100]]),
      ),
    (e: unknown) =>
      e instanceof InvoiceParseError && e.code === "missing_columns",
  );
  assert.throws(
    () => parseArubaInvoiceWorkbook(book([header])),
    (e: unknown) =>
      e instanceof InvoiceParseError && e.code === "no_document_rows",
  );
});
test("empty cells never invent zero; negative without explicit type is retained and flagged", () => {
  const p = parseArubaInvoiceWorkbook(
    book([
      header,
      ["1", "X", "1/1/2025", "", "", 0, 0, ""],
      ["2", "X", "1/1/2025", "nota di credito", -100, -10, -90, ""],
    ]),
  );
  assert.equal(p.rows[0].normalized_data, null);
  assert.equal(p.rows[1].normalized_data?.document_type, "signed_adjustment");
  assert.equal(p.rows[1].normalized_data?.lordo, -100);
  assert.deepEqual(p.rows[1].warning_codes, [
    "signed_document_type_unverified",
  ]);
});
