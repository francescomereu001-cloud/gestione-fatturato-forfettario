import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { cleanup, fireEvent, render, within } from "@testing-library/react";
import { AppShell } from "./layout/AppShell.tsx";

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
// The real browser uses native modal focus trapping; JSDOM needs only a dialog lifecycle shim.
Object.defineProperty(dom.window.HTMLDialogElement.prototype, "showModal", {
  value: function (this: HTMLDialogElement) {
    this.open = true;
  },
});
Object.defineProperty(dom.window.HTMLDialogElement.prototype, "close", {
  value: function (this: HTMLDialogElement) {
    this.open = false;
    this.dispatchEvent(new dom.window.Event("close"));
  },
});
afterEach(cleanup);
function shell(onNavigate: (id: string) => void = () => {}) {
  return render(
    <AppShell
      activeTab="residual-review"
      onNavigate={onNavigate}
      email="synthetic@example.test"
      loading={false}
      onRefresh={() => {}}
      onLogout={() => {}}
    >
      <h1>Pagina corrente</h1>
    </AppShell>,
  );
}

test("FinancialMind shell groups navigation, exposes current page and disables future modules", () => {
  const view = shell();
  assert.ok(view.getAllByText("FinancialMind").length > 0);
  assert.equal(view.queryByText("Fatturato PRO"), null);
  const nav = view.getByRole("navigation", { name: "Navigazione principale" });
  for (const section of [
    "Overview",
    "Money",
    "Income & Taxes",
    "Planning",
    "Wealth",
    "System",
  ])
    assert.ok(within(nav).getAllByText(section).length > 0);
  assert.equal(
    within(nav)
      .getByRole("button", { name: "Da verificare" })
      .getAttribute("aria-current"),
    "page",
  );
  for (const future of [
    "Investimenti",
    "Patrimonio",
    "Debiti",
    "Report",
    "Documenti",
    "Impostazioni",
  ]) {
    assert.equal(
      (
        within(nav).getByRole("button", {
          name: `${future} Presto`,
        }) as HTMLButtonElement
      ).disabled,
      true,
    );
  }
});

test("existing navigation still emits the original state-based tab IDs", () => {
  const tabs: string[] = [];
  const view = shell((id) => tabs.push(id));
  fireEvent.click(view.getByRole("button", { name: "Conti" }));
  fireEvent.click(view.getByRole("button", { name: "Transazioni" }));
  fireEvent.click(view.getByRole("button", { name: "Income" }));
  assert.deepEqual(tabs, ["accounts", "transactions", "fatture"]);
});

test("mobile navigation opens as a named modal and closes after navigation", () => {
  const tabs: string[] = [];
  const view = shell((id) => tabs.push(id));
  const toggle = view.getByRole("button", { name: "Apri navigazione" });
  assert.equal(toggle.getAttribute("aria-expanded"), "false");
  fireEvent.click(toggle);
  const dialog = view.getByRole("dialog", { name: "Navigazione mobile" });
  assert.equal(toggle.getAttribute("aria-expanded"), "true");
  fireEvent.click(within(dialog).getByRole("button", { name: "Import" }));
  assert.deepEqual(tabs, ["bank-import"]);
  assert.equal(toggle.getAttribute("aria-expanded"), "false");
  assert.equal(view.queryByRole("dialog"), null);
});

test("global refresh and logout retain their callbacks and accessible names", () => {
  let refresh = 0;
  let logout = 0;
  const view = render(
    <AppShell
      activeTab="dashboard"
      onNavigate={() => {}}
      loading={false}
      onRefresh={() => refresh++}
      onLogout={() => logout++}
    >
      <h1>Overview</h1>
    </AppShell>,
  );
  fireEvent.click(view.getByRole("button", { name: "Aggiorna dati" }));
  fireEvent.click(view.getByRole("button", { name: "Esci" }));
  assert.equal(refresh, 1);
  assert.equal(logout, 1);
  assert.equal(
    view.getByRole("link", { name: "Vai al contenuto" }).getAttribute("href"),
    "#main-content",
  );
});

test("mobile drawer cycles keyboard focus across enabled navigation only", () => {
  const view = shell();
  fireEvent.click(view.getByRole("button", { name: "Apri navigazione" }));
  const dialog = view.getByRole("dialog", { name: "Navigazione mobile" });
  const first = within(dialog).getByRole("button", {
    name: "Chiudi navigazione",
  });
  const last = within(dialog).getByRole("button", {
    name: "Obiettivi",
  });
  last.focus();
  fireEvent.keyDown(last, { key: "Tab" });
  assert.equal(document.activeElement, first);
  first.focus();
  fireEvent.keyDown(first, { key: "Tab", shiftKey: true });
  assert.equal(document.activeElement, last);
});

test("Funds and Goals are enabled and emit their planning navigation IDs", () => {
  const tabs: string[] = [];
  const view = shell((id) => tabs.push(id));
  fireEvent.click(view.getByRole("button", { name: "Fondi" }));
  fireEvent.click(view.getByRole("button", { name: "Obiettivi" }));
  assert.deepEqual(tabs, ["funds", "goals"]);
});
