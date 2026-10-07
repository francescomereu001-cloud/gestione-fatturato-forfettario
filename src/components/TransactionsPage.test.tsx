import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import type { SupabaseClient } from "@supabase/supabase-js";
import { localCalendarDate } from "../domain/transactions/dates.ts";
import type { LedgerTransaction } from "../types/ledger.ts";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost" });
Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement });
Object.defineProperty(globalThis, "navigator", { configurable: true, value: dom.window.navigator });
const { cleanup, fireEvent, render, waitFor, within } = await import("@testing-library/react");
const { TransactionsPage } = await import("./LedgerPages.tsx");
afterEach(cleanup);

function mockClient(rows: LedgerTransaction[]) {
  return { from(table: string) {
    const result = { data: table === "transactions" ? rows : [], error: null };
    const query = { select: () => query, eq: () => query, order: () => query, upsert: async () => ({ error: null }), then: (resolve: (value: typeof result) => unknown) => Promise.resolve(result).then(resolve) };
    return query;
  } } as unknown as SupabaseClient;
}

test("period controls keep table and cards aligned, validate custom range and expose hidden residuals", async () => {
  const now = new Date();
  const current = localCalendarDate(new Date(now.getFullYear(), now.getMonth(), 1));
  const previous = localCalendarDate(new Date(now.getFullYear(), now.getMonth() - 1, 1));
  const movement = (id: string, date: string, amount: number, type: LedgerTransaction["transaction_type"]): LedgerTransaction => ({ id, account_id: "a", transaction_date: date, amount, transaction_type: type, description: id, reconciliation_status: "confirmed", source: "manual" });
  const view = render(<TransactionsPage userId="synthetic" client={mockClient([
    movement("Current income", current, 100, "income"), movement("Previous income", previous, 900, "income"), movement("Needs classification", current, -50, "unclassified"),
  ])} />);
  await waitFor(() => assert.ok(view.getByText("Current income")));
  const period = view.getByLabelText("Periodo") as HTMLSelectElement;
  const income = () => within(view.getByText("Entrate del periodo").closest(".card") as HTMLElement).getByRole("heading").textContent;
  assert.equal(period.value, "this_month");
  assert.equal(view.queryByText("Previous income"), null);
  assert.match(income()!, /100,00/);
  assert.ok(view.getByText(/1 movimenti del periodo/));
  fireEvent.change(view.getByLabelText("Tipo di movimento"), { target: { value: "income" } });
  assert.equal(view.queryByText("Needs classification"), null);
  assert.ok(view.getByText(/1 movimenti del periodo/));
  fireEvent.change(period, { target: { value: "last_month" } });
  assert.ok(view.getByText("Previous income"));
  assert.equal(view.queryByText("Current income"), null);
  assert.equal(view.queryByText(/movimenti del periodo devono/), null);
  assert.match(income()!, /900,00/);
  fireEvent.change(period, { target: { value: "all" } });
  assert.ok(view.getByText("Current income"));
  assert.ok(view.getByText("Previous income"));
  fireEvent.change(period, { target: { value: "custom" } });
  assert.ok(view.getByRole("alert"));
  fireEvent.change(view.getByLabelText("Data da"), { target: { value: current } });
  fireEvent.change(view.getByLabelText("Data a"), { target: { value: previous } });
  assert.match(view.getByRole("alert").textContent!, /precedente o uguale/);
  assert.equal(view.queryByText("Current income"), null);
  assert.match(income()!, /0,00/);
  fireEvent.change(view.getByLabelText("Data a"), { target: { value: current } });
  assert.equal(view.queryByRole("alert"), null);
  assert.ok(view.getByText("Current income"));
  assert.equal(view.queryByText("Previous income"), null);
  assert.match(income()!, /100,00/);
});
