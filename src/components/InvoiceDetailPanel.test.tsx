import assert from "node:assert/strict";
import { test } from "node:test";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { InvoiceCorrection, InvoiceDetail } from "../types/income";
import { InvoiceDetailPanel } from "./income/InvoiceDetailPanel";

test("invoice detail previews delta, saves through RPC, refreshes and resolves imports with version checks", async () => {
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
  const detail: InvoiceDetail = {
    invoice: {
      id: "i",
      edit_version: 0,
      numero: "1",
      data: "2026-01-01",
      cliente: "Test",
      lordo: 1000,
      enasarco: 0,
      netto: 900,
    },
    conflicts: [
      {
        id: "r",
        row_index: 1,
        status: "conflict",
        invoice_id: "i",
        fingerprint: "fp",
        file_name: "report.xls",
        raw_data: {},
        warning_codes: [],
        normalized_data: {
          numero: "1",
          data: "2026-01-01",
          cliente: "Test",
          descrizione: "Report",
          lordo: 1000,
          enasarco: 150,
          netto: 850,
          document_type: "invoice",
        },
      },
    ],
    revisions: [],
  };
  const saves: InvoiceCorrection[] = [];
  let refreshed = 0;
  let fail = false;
  const client = {
    rpc: async (name: string, args: InvoiceCorrection) => {
      if (name === "invoice_detail")
        return { data: structuredClone(detail), error: null };
      assert.equal(name, "save_invoice_correction");
      if (fail)
        return {
          data: null,
          error: {
            message: "La fattura è stata modificata: riapri il dettaglio",
          },
        };
      saves.push(args);
      detail.invoice.edit_version++;
      if (args.edit_action === "apply_import") {
        detail.invoice.netto = 850;
        detail.invoice.enasarco = 150;
        detail.conflicts = [];
      } else {
        detail.invoice.enasarco = args.amounts.lordo - args.amounts.netto;
      }
      return { data: structuredClone(detail.invoice), error: null };
    },
  } as unknown as SupabaseClient;
  const view = render(
    <InvoiceDetailPanel
      client={client}
      invoiceId="i"
      onSaved={async () => {
        refreshed++;
      }}
      onClose={() => {}}
    />,
  );
  try {
    await waitFor(() => assert.ok(view.getByLabelText("Totale documento")));
    assert.equal(
      view
        .getByRole("button", { name: "Salva correzione" })
        .hasAttribute("disabled"),
      true,
    );
    fireEvent.click(view.getByRole("checkbox"));
    assert.equal(
      (view.getByLabelText("ENASARCO") as HTMLInputElement).value,
      "100",
    );
    fireEvent.change(
      view.getByLabelText("Motivo della modifica o della risoluzione"),
      { target: { value: "Recovery" } },
    );
    fireEvent.click(view.getByRole("button", { name: "Salva correzione" }));
    await waitFor(() => assert.equal(refreshed, 1));
    assert.equal(saves[0].edit_action, "recalculate");
    assert.equal(saves[0].expected_version, 0);
    assert.equal(saves[0].amounts.enasarco, 100);
    await waitFor(() => assert.ok(view.getByText(/Modifica salvata/)));
    fireEvent.change(
      view.getByLabelText("Motivo della modifica o della risoluzione"),
      { target: { value: "Use report" } },
    );
    fireEvent.click(
      view.getByRole("button", { name: "Applica import della riga 1" }),
    );
    await waitFor(() => assert.equal(refreshed, 2));
    assert.equal(saves[1].edit_action, "apply_import");
    assert.equal(saves[1].expected_version, 1);
    assert.equal(saves[1].conflict_row, "r");
    await waitFor(() =>
      assert.ok(view.getByText("Nessun conflitto collegato a questa fattura.")),
    );
    fail = true;
    fireEvent.change(
      view.getByLabelText("Motivo della modifica o della risoluzione"),
      { target: { value: "Stale" } },
    );
    fireEvent.click(view.getByRole("button", { name: "Salva correzione" }));
    await waitFor(() =>
      assert.match(
        view.getByRole("alert").textContent ?? "",
        /riapri il dettaglio/,
      ),
    );
    assert.equal(refreshed, 2);
  } finally {
    cleanup();
    dom.window.close();
  }
});
