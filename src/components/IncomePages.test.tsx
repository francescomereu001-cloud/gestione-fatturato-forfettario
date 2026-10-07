import assert from "node:assert/strict";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { IncomePage } from "./income/IncomePage";
import { InvoiceImportPage } from "./income/InvoiceImportPage";
import { TaxPaymentsPage } from "./taxes/TaxPaymentsPage";
test("missing Income RPC never falls back to browser invoice sums", () => {
  const html = renderToStaticMarkup(
    <IncomePage
      client={{} as SupabaseClient}
      summary={null}
      invoices={[{ id: "x", lordo: 9999, netto: 9999 }]}
      error="migration PR12 mancante"
      onSaved={async () => {}}
    />,
  );
  assert.match(html, /role="alert"/);
  assert.match(html, /migration PR12 mancante/);
  assert.match(html, /Non disponibile/);
  assert.match(html, /non aggiungono reddito/);
});
test("dedicated Aruba import explains preview, collection policy and conflict preservation", () => {
  const html = renderToStaticMarkup(
    <InvoiceImportPage
      client={{} as SupabaseClient}
      onSaved={async () => {}}
    />,
  );
  assert.match(html, /preview/);
  assert.match(html, /incassata alla data documento/);
  assert.match(html, /conflitti conservano/);
});
test("F24 registration starts explicitly unallocated and explains reserve semantics", () => {
  const html = renderToStaticMarkup(
    <TaxPaymentsPage
      client={{} as SupabaseClient}
      userId="u"
      year={2025}
      payments={[]}
      onSaved={async () => {}}
    />,
  );
  assert.match(html, /Registra F24 non attribuito/);
  assert.match(html, /non riduce la Tax Reserve/);
});
test("Aruba preview stages first, commits once and refreshes authoritative summaries", async () => {
  const { JSDOM } = await import("jsdom");
  const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    url: "http://localhost",
  });
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    HTMLElement: dom.window.HTMLElement,
  });
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: dom.window.navigator,
  });
  const { render, fireEvent, waitFor, cleanup } =
    await import("@testing-library/react");
  const XLSX = (await import("xlsx")).default;
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    wb,
    XLSX.utils.aoa_to_sheet([
      [
        "N. fattura",
        "Società",
        "Data fattura",
        "Descrizione del progetto",
        "Totale fattura",
        "ENASARCO",
        "Netto a pagare (ENASARCO)",
      ],
      ["1", "Cliente sintetico", "01/01/2025", "", 100, 10, 90],
    ]),
    "Report",
  );
  const bytes = XLSX.write(wb, { type: "array", bookType: "xls" });
  const calls: string[] = [];
  let refreshed = 0;
  const batch = {
    id: "b",
    file_name: "synthetic.xls",
    status: "staged",
    row_count: 1,
    inserted_count: 1,
    duplicate_count: 0,
    conflict_count: 0,
    rejected_count: 0,
  };
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
    async range() {
      return {
        data: [
          {
            id: "r",
            row_index: 1,
            status: calls.includes("commit_invoice_import_batch")
              ? "inserted"
              : "new",
            normalized_data: {
              numero: "1",
              data: "2025-01-01",
              cliente: "Cliente sintetico",
              lordo: 100,
              enasarco: 10,
              netto: 90,
            },
            warning_codes: [],
          },
        ],
        error: null,
      };
    },
  };
  const client = {
    rpc: async (name: string) => {
      calls.push(name);
      return {
        data:
          name === "stage_invoice_import_batch"
            ? batch
            : { ...batch, status: "committed" },
        error: null,
      };
    },
    from: (table: string) => {
      assert.equal(table, "invoice_import_rows");
      return chain;
    },
  } as unknown as SupabaseClient;
  const view = render(
    <InvoiceImportPage
      client={client}
      onSaved={async () => {
        refreshed++;
      }}
    />,
  );
  try {
    fireEvent.change(view.getByLabelText(/Report fatture inviate/), {
      target: {
        files: [
          {
            name: "synthetic.xls",
            size: bytes.byteLength,
            arrayBuffer: async () => bytes,
          },
        ],
      },
    });
    await waitFor(() =>
      assert.ok(
        view.getByRole("button", {
          name: "Conferma import delle nuove fatture",
        }),
      ),
    );
    assert.deepEqual(calls, ["stage_invoice_import_batch"]);
    assert.equal(refreshed, 0);
    fireEvent.click(
      view.getByRole("button", { name: "Conferma import delle nuove fatture" }),
    );
    await waitFor(() => assert.equal(refreshed, 1));
    assert.deepEqual(calls, [
      "stage_invoice_import_batch",
      "commit_invoice_import_batch",
    ]);
    await waitFor(() => assert.ok(view.getByText(/Commit completato/)));
  } finally {
    cleanup();
    dom.window.close();
  }
});
