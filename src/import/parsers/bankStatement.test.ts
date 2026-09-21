import test from "node:test";
import assert from "node:assert/strict";
import { fingerprint, normalizeAmount, normalizeBankRows, parseBankCsv, readCsv, suggestColumnMapping } from "./bankStatement.ts";

test("normalizes international and signed amounts", () => {
  for (const [source, expected] of [["1.234,56", 1234.56], ["1,234.56", 1234.56], ["1234,56", 1234.56], ["1234.56", 1234.56], ["-1.234,56", -1234.56], ["-1,234.56", -1234.56], ["(1,234.56)", -1234.56]] as const) assert.equal(normalizeAmount(source), expected, source);
});

test("suggests mappings from known headers", () => {
  assert.deepEqual(suggestColumnMapping(["Data operazione", "Importo", "Causale"]), { transaction_date: "Data operazione", amount: "Importo", description: "Causale" });
});

test("manual mapping controls normalization", () => {
  const rows = [{ When: "21/09/2026", Value: "-12,50", Memo: "Bar" }];
  const [row] = normalizeBankRows(rows, { transaction_date: "When", amount: "Value", description: "Memo" });
  assert.deepEqual([row.transaction_date, row.amount, row.description, row.status], ["2026-09-21", -12.5, "Bar", "ready"]);
});

test("reads quoted CSV separately from mapping and normalization", () => {
  const read = readCsv('Data;Importo;Descrizione;ID\n21/09/2026;-12,50;"Bar, Roma";abc');
  assert.deepEqual(read.headers, ["Data", "Importo", "Descrizione", "ID"]);
  const [row] = parseBankCsv('Data;Importo;Descrizione;ID\n21/09/2026;-12,50;"Bar, Roma";abc');
  assert.equal(row.description, "Bar, Roma"); assert.equal(row.status, "ready");
});

test("fingerprint changes with each editable canonical field", () => {
  const base = { transaction_date: "2026-09-21", amount: 10, description: "Bonifico test" };
  assert.notEqual(fingerprint(base), fingerprint({ ...base, transaction_date: "2026-09-22" }));
  assert.notEqual(fingerprint(base), fingerprint({ ...base, amount: 11 }));
  assert.notEqual(fingerprint(base), fingerprint({ ...base, description: "Altro" }));
  assert.equal(fingerprint(base), fingerprint({ ...base, description: " BONIFICO   TEST " }));
});
