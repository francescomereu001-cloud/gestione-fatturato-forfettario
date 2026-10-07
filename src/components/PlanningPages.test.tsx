import assert from "node:assert/strict";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { SafeToSpendPanel } from "./PlanningPages.tsx";
import type { SafeToSpend } from "../types/planning.ts";
const summary = {
  as_of: "2026-10-07",
  horizon_end: "2026-10-31",
  total_liquidity: 20000,
  reserved_funds_total: 10000,
  free_liquidity: 10000,
  required_tax_reserve: 8000,
  tax_reserve_gap: 0,
  upcoming_essential_commitments: 500,
  upcoming_other_commitments: 200,
  total_planned_contributions: 400,
  safe_to_spend: 8900,
  safe_to_spend_raw: 8900,
  funding_shortfall: 0,
  funds_overallocated: false,
  status: "estimated",
  missing_fields: [],
  warnings: [],
} as unknown as SafeToSpend;
test("dashboard renders authoritative STS and supplied breakdown without reconstructing totals", () => {
  const html = renderToStaticMarkup(
    <SafeToSpendPanel summary={{ ...summary, safe_to_spend: 1234 }} />,
  );
  assert.match(html, /1234,00/);
  assert.match(html, /Stimato/);
  assert.match(html, /2026-10-31/);
  assert.match(html, /Gap fiscale/);
  assert.match(html, /Contributi programmati/);
});
test("incomplete STS shows missing information and never displays null as zero", () => {
  const html = renderToStaticMarkup(
    <SafeToSpendPanel
      summary={{
        ...summary,
        status: "incomplete",
        safe_to_spend: null,
        safe_to_spend_raw: null,
        tax_reserve_gap: null,
        missing_fields: ["tax_projection", "commitments_verified_through"],
      }}
    />,
  );
  assert.match(html, /Safe to Spend non disponibile/);
  assert.match(html, /configurazione e la verifica fiscale/);
  assert.match(html, /Verifica gli impegni/);
  assert.doesNotMatch(html, /safeToSpendValue[^>]*>[^<]*0,00/);
});
test("RPC failure displays unavailability without estimated fallback", () => {
  const html = renderToStaticMarkup(
    <SafeToSpendPanel summary={null} error="Calcolo non disponibile" />,
  );
  assert.match(html, /role="alert"/);
  assert.match(html, /Safe to Spend non disponibile/);
  assert.doesNotMatch(html, /0,00/);
});
test("over-allocation and negative raw remain visible alongside clamped operational amount", () => {
  const html = renderToStaticMarkup(
    <SafeToSpendPanel
      summary={{
        ...summary,
        funds_overallocated: true,
        funds_overallocation_amount: 2000,
        free_liquidity: -2000,
        safe_to_spend_raw: -5000,
        safe_to_spend: 0,
        funding_shortfall: 5000,
      }}
    />,
  );
  assert.match(html, /Fondi sovra-allocati/);
  assert.match(html, /Fabbisogno non coperto/);
  assert.match(html, /-5000,00/);
});

test("fund allocation form submits one RPC then reloads server summaries", async () => {
  const { JSDOM } = await import("jsdom");
  const { FundsPage } = await import("./PlanningPages.tsx");
  const dom = new JSDOM("<!doctype html><html><body></body></html>");
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    HTMLElement: dom.window.HTMLElement,
  });
  const { render, fireEvent, waitFor, cleanup } = await import(
    "@testing-library/react"
  );
  const calls: string[] = [];
  const fund = {
    id: "house",
    name: "Casa",
    system_key: "house",
    balance: 5000,
    target_amount: 10000,
    target_date: null,
    planned_monthly_contribution: 1000,
    priority: 0,
    is_active: true,
    progress_percentage: 50,
    contribution_gap: 400,
  };
  const client = {
    rpc: async (name: string, args: Record<string, unknown>) => {
      calls.push(name);
      if (name === "financial_allocate_fund") {
        assert.deepEqual(args, { fund_id: "house", amount: 600, note: null });
        return { data: "op", error: null };
      }
      return {
        data:
          name === "financial_fund_summary"
            ? [fund]
            : name === "financial_safe_to_spend"
              ? summary
              : null,
        error: null,
      };
    },
  } as unknown as import("@supabase/supabase-js").SupabaseClient;
  try {
    const view = render(<FundsPage client={client} userId="owner" />);
    await waitFor(() =>
      assert.equal(
        (view.getByRole("button", { name: "Alloca" }) as HTMLButtonElement)
          .disabled,
        false,
      ),
    );
    fireEvent.click(view.getByRole("button", { name: "Alloca" }));
    fireEvent.change(view.getByLabelText("Importo"), {
      target: { value: "600" },
    });
    fireEvent.submit(
      view
        .getByRole("button", { name: "Conferma movimento virtuale" })
        .closest("form")!,
    );
    await waitFor(() =>
      assert.equal(
        calls.filter((c) => c === "financial_fund_summary").length,
        2,
      ),
    );
    assert.equal(
      calls.filter((c) => c === "financial_allocate_fund").length,
      1,
    );
    assert.match(view.container.textContent ?? "", /allocazioni virtuali/);
  } finally {
    cleanup();
    dom.window.close();
  }
});
