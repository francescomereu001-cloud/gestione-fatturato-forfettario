import assert from "node:assert/strict";
import { test } from "node:test";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  stageInvoiceImport,
  commitInvoiceImport,
  loadIncomeSummary,
  loadInvoiceImportRows,
  incomeError,
} from "./income.ts";
test("Income service delegates stage/commit and KPI authority to RPC without client owner or dedup", async () => {
  const calls: unknown[] = [];
  const client = {
    rpc: async (name: string, args: unknown) => {
      calls.push([name, args]);
      return { data: { id: "batch", net_income: 123.45 }, error: null };
    },
  } as unknown as SupabaseClient;
  await stageInvoiceImport(client, "aruba.xls", {
    parser_key: "aruba_invoice_report_v1",
    rows: [],
  });
  await commitInvoiceImport(client, "batch");
  const summary = await loadIncomeSummary(client, 2025);
  assert.equal(summary.net_income, 123.45);
  assert.deepEqual(calls, [
    [
      "stage_invoice_import_batch",
      {
        file_name: "aruba.xls",
        parser_key: "aruba_invoice_report_v1",
        rows: [],
      },
    ],
    ["commit_invoice_import_batch", { batch_id: "batch" }],
    ["financial_income_summary", { target_year: 2025 }],
  ]);
});
test("missing RPC, permission and failed commit produce distinct errors", async () => {
  assert.match(incomeError({ code: "PGRST202" }), /migration PR12/);
  assert.match(incomeError({ code: "42501" }), /Accesso negato/);
  const client = {
    rpc: async () => ({
      data: null,
      error: { code: "XX000", message: "Rollback test" },
    }),
  } as unknown as SupabaseClient;
  await assert.rejects(
    () => commitInvoiceImport(client, "batch"),
    (e: unknown) => (e as { message: string }).message === "Rollback test",
  );
});
test("import row preview paginates beyond API default limit and preserves ordering", async () => {
  const ranges: unknown[] = [];
  const chain = {
    select() {
      return this;
    },
    eq() {
      return this;
    },
    order() {
      return this;
    },
    async range(a: number, b: number) {
      ranges.push([a, b]);
      return {
        data: Array.from({ length: a === 0 ? 500 : 2 }, (_, i) => ({
          id: String(a + i),
        })),
        error: null,
      };
    },
  };
  const rows = await loadInvoiceImportRows(
    { from: () => chain } as unknown as SupabaseClient,
    "b",
  );
  assert.equal(rows.length, 502);
  assert.deepEqual(ranges, [
    [0, 499],
    [500, 999],
  ]);
});
