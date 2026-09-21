import test from "node:test";
import assert from "node:assert/strict";
import { fingerprint, normalizeAmount, parseBankCsv } from "./bankStatement.ts";

test("normalizes Italian and signed amounts", () => {
  assert.equal(normalizeAmount("1.234,56 €"), 1234.56);
  assert.equal(normalizeAmount("-45,10"), -45.1);
});

test("parses quoted CSV into auditable staging rows", () => {
  const [row] = parseBankCsv('Data;Importo;Descrizione;ID\n21/09/2026;-12,50;"Bar, Roma";abc');
  assert.equal(row.transaction_date, "2026-09-21");
  assert.equal(row.amount, -12.5);
  assert.equal(row.description, "Bar, Roma");
  assert.equal(row.status, "ready");
  assert.deepEqual(row.raw_data, { Data: "21/09/2026", Importo: "-12,50", Descrizione: "Bar, Roma", ID: "abc" });
});

test("fingerprint is stable across description whitespace and case", () => {
  assert.equal(fingerprint({ transaction_date: "2026-09-21", amount: 10, description: " Bonifico  TEST " }), fingerprint({ transaction_date: "2026-09-21", amount: 10, description: "bonifico test" }));
});
