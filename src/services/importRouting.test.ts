import test from "node:test";
import assert from "node:assert/strict";
import { detectedInstruments, instrumentAccountType, loadImportMappings, normalizeInstrument, resolveInstrumentMappings, routeImportRows, saveImportMappings } from "./importRouting.ts";
import type { Account } from "../types/ledger.ts";
import type { ImportRow } from "../types/imports.ts";
import type { ImportAccountMapping } from "../types/imports.ts";

const accounts: Account[] = [
  { id: "checking", user_id: "owner", name: "Synthetic bank", account_type: "checking", currency: "EUR", opening_balance: 0, is_active: true, include_in_liquidity: true },
  { id: "card", user_id: "owner", name: "Synthetic card", account_type: "credit_card", currency: "EUR", opening_balance: 0, is_active: true, include_in_liquidity: false },
  { id: "foreign", user_id: "other", name: "Other bank", account_type: "checking", currency: "EUR", opening_balance: 0, is_active: true, include_in_liquidity: true },
];
const movement = (source: string, row_index = 0): ImportRow => ({
  source_instrument: source, row_index, transaction_date: "2026-01-01", booking_date: null,
  amount: -10, description: "Synthetic purchase", merchant: null, external_id: null,
  dedupe_fingerprint: "same", suggested_transaction_type: "unclassified", suggested_category_id: null,
  status: "ready", raw_data: { "Conto o carta": source },
});
const mapping: ImportAccountMapping = { user_id: "owner", parser_key: "isybank_operations_v1", source_instrument: "conto test", account_id: "checking" };

test("normalizes mapping keys and infers types without depending on card digits", () => {
  assert.equal(normalizeInstrument("  CONTO   test "), "conto test");
  assert.equal(instrumentAccountType("Carta di credito **** 9999"), "credit_card");
  assert.equal(instrumentAccountType("Conto test"), "checking");
  assert.equal(instrumentAccountType("Unknown instrument"), null);
});

test("groups single-account and multi-instrument files with exact counts", () => {
  const rows = [movement("Conto test"), movement(" CONTO  test ", 1), movement("Carta di credito **** 9999", 2)];
  assert.deepEqual(detectedInstruments(rows).map((item) => item.count), [2, 1]);
  assert.equal(detectedInstruments(rows.slice(0, 2)).length, 1);
});

test("existing mappings preselect only owned active compatible accounts", () => {
  assert.deepEqual(resolveInstrumentMappings([movement(" Conto TEST ")], [mapping], accounts, "owner"), { "conto test": "checking" });
  for (const change of [{ account_id: "foreign" }, { account_id: "card" }, { user_id: "other" }]) {
    assert.deepEqual(resolveInstrumentMappings([movement("Conto test")], [{ ...mapping, ...change }], accounts, "owner"), {});
  }
  assert.deepEqual(resolveInstrumentMappings([movement("Conto test")], [mapping], accounts.map((account) => ({ ...account, is_active: false })), "owner"), {});
});

test("missing mappings require explicit selection and never create accounts", () => {
  assert.deepEqual(resolveInstrumentMappings([movement("Conto test")], [], accounts, "owner"), {});
  assert.throws(() => routeImportRows([movement("Conto test")], {}, accounts, "owner"), /Seleziona/);
});

test("routes two instruments to different accounts in one batch", () => {
  const routed = routeImportRows([movement("Conto test"), movement("Carta di credito **** 9999", 1)],
    { "conto test": "checking", "carta di credito **** 9999": "card" }, accounts, "owner");
  assert.deepEqual(routed.map((row) => row.target_account_id), ["checking", "card"]);
  assert.ok(routed.every((row) => row.amount === -10 && row.suggested_transaction_type === "unclassified"));
});

test("rejects foreign/incompatible targets and missing source instruments", () => {
  for (const account of ["foreign", "card", "absent"]) {
    assert.throws(() => routeImportRows([movement("Conto test")], { "conto test": account }, accounts, "owner"));
  }
  assert.throws(() => routeImportRows([movement("")], {}, accounts, "owner"), /Strumento mancante/);
  assert.equal(routeImportRows([{ ...movement(""), status: "error" }], {}, accounts, "owner")[0].status, "error");
});

test("loads owner/parser scoped mappings and saves normalized associations", async () => {
  const filters: unknown[][] = [];
  let saved: unknown;
  const query = { select() { return this; }, eq(...args: unknown[]) { filters.push(args); return this; },
    then(resolve: (value: unknown) => void) { resolve({ data: [mapping], error: null }); } };
  const client = { from(table: string) { assert.equal(table, "import_account_mappings"); return { ...query,
    upsert(values: unknown, options: unknown) { saved = { values, options }; return Promise.resolve({ error: null }); } }; } };
  assert.deepEqual(await loadImportMappings(client as never, "owner", mapping.parser_key), [mapping]);
  assert.deepEqual(filters, [["user_id", "owner"], ["parser_key", mapping.parser_key]]);
  await saveImportMappings(client as never, "owner", mapping.parser_key, [{ ...movement(" CONTO   test "), target_account_id: "checking" }]);
  assert.deepEqual(saved, { values: [mapping], options: { onConflict: "user_id,parser_key,source_instrument" } });
});
