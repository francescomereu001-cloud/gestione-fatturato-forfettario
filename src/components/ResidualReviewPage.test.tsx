import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import {
  cleanup,
  fireEvent,
  render,
  waitFor,
  within,
} from "@testing-library/react";
import type { SupabaseClient } from "@supabase/supabase-js";
import { ResidualReviewPage } from "./ResidualReviewPage.tsx";
import type { ResidualGroup } from "../services/residualReview.ts";

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "http://localhost",
});
Object.assign(globalThis, {
  window: dom.window,
  document: dom.window.document,
  HTMLElement: dom.window.HTMLElement,
  HTMLSelectElement: dom.window.HTMLSelectElement,
  Event: dom.window.Event,
  MouseEvent: dom.window.MouseEvent,
});
Object.defineProperty(globalThis, "navigator", {
  configurable: true,
  value: dom.window.navigator,
});
afterEach(cleanup);
const group: ResidualGroup = {
  group_key: "synthetic-group",
  parser_key: "isybank_operations_v1",
  account_id: "source",
  account_name: "Conto sintetico",
  currency: "EUR",
  provider_category: "bonifici ricevuti",
  provider_operation: "mittente sintetico",
  metadata_conflicting: false,
  transaction_count: 2,
  total_amount: 240,
  date_min: "2026-01-02",
  date_max: "2026-02-03",
  transaction_ids: ["synthetic-a", "synthetic-b"],
  examples: ["Esempio uno", "Esempio due"],
};
function mockClient(selectedGroup = group, failure: string | null = null) {
  const calls: Array<[string, Record<string, unknown>]> = [];
  let groups = [selectedGroup];
  const client = {
    from: (table: string) => ({
      select: () => ({
        eq: () => ({
          order: async () => ({
            data:
              table === "accounts"
                ? [
                    {
                      id: "source",
                      name: "Conto sintetico",
                      account_type: "checking",
                      currency: "EUR",
                    },
                    {
                      id: "target",
                      name: "Risparmio",
                      account_type: "savings",
                      currency: "EUR",
                    },
                    {
                      id: "broker",
                      name: "Broker sintetico",
                      account_type: "broker",
                      currency: "EUR",
                    },
                    {
                      id: "usd",
                      name: "USD sintetico",
                      account_type: "checking",
                      currency: "USD",
                    },
                  ]
                : [
                    {
                      id: "expense-category",
                      name: "Lavoro",
                      category_type: "expense",
                    },
                    {
                      id: "income-category",
                      name: "Compensi",
                      category_type: "income",
                    },
                  ],
            error: null,
          }),
        }),
      }),
    }),
    rpc: async (name: string, args: Record<string, unknown>) => {
      calls.push([name, args]);
      if (name === "residual_review_groups")
        return {
          data: {
            groups,
            total_groups: groups.length,
            unclassified_count: groups.length ? 2 : 0,
          },
          error: null,
        };
      if (failure) return { data: null, error: { message: failure } };
      groups = [];
      return {
        data:
          name === "bulk_classify_transactions"
            ? 2
            : { rule_id: "synthetic-rule", classified_count: 2 },
        error: null,
      };
    },
  } as unknown as SupabaseClient;
  return { client, calls };
}

test("review renders aggregate summaries and applies a manual group decision then reloads", async () => {
  const { client, calls } = mockClient();
  const view = render(
    <ResidualReviewPage client={client} userId="synthetic-owner" />,
  );
  fireEvent.click(
    await view.findByRole("button", { name: /mittente sintetico/ }),
  );
  const groupButton = view.getByRole("button", { name: /mittente sintetico/ });
  assert.ok(within(groupButton).getByText("2 movimenti"));
  assert.match(groupButton.textContent ?? "", /\+240,00\s*€/);
  assert.match(view.container.textContent ?? "", /2026-01-02 – 2026-02-03/);
  assert.ok(within(groupButton).getByText("bonifici ricevuti"));
  assert.ok(within(groupButton).getByText("IsyBank"));
  assert.ok(within(groupButton).getByText("mittente sintetico"));
  assert.ok(view.getByRole("heading", { name: "Classifica questo gruppo" }));
  assert.equal(
    (view.getByLabelText("Tipo di movimento") as HTMLSelectElement).value,
    "unclassified",
  );
  assert.equal(view.queryByLabelText("Conto di destinazione"), null);
  fireEvent.change(view.getByLabelText("Tipo di movimento"), {
    target: { value: "expense" },
  });
  fireEvent.change(view.getByLabelText("Categoria"), {
    target: { value: "expense-category" },
  });
  fireEvent.click(view.getByRole("button", { name: "Classifica gruppo" }));
  await view.findByText("2 movimenti classificati");
  assert.deepEqual(
    calls.find(([name]) => name === "bulk_classify_transactions"),
    [
      "bulk_classify_transactions",
      {
        transaction_ids: ["synthetic-a", "synthetic-b"],
        target_type: "expense",
        target_category_id: "expense-category",
        target_transfer_account_id: null,
      },
    ],
  );
  await waitFor(() => assert.ok(view.getByText("Tutto in ordine")));
  assert.equal(
    calls.filter(([name]) => name === "residual_review_groups").length,
    2,
  );
});

test("self-transfer can save an exact provider/account rule with no modeled target", async () => {
  const { client, calls } = mockClient();
  const view = render(
    <ResidualReviewPage client={client} userId="synthetic-owner" />,
  );
  fireEvent.click(
    await view.findByRole("button", { name: /mittente sintetico/ }),
  );
  fireEvent.change(view.getByLabelText("Tipo di movimento"), {
    target: { value: "internal_transfer" },
  });
  assert.equal(
    (view.getByLabelText("Conto di destinazione") as HTMLSelectElement).value,
    "",
  );
  assert.ok(view.getByText(/escluso da entrate e spese/));
  assert.equal(view.queryByLabelText("Categoria"), null);
  fireEvent.click(
    view.getByRole("button", { name: "Classifica e crea regola" }),
  );
  await view.findByText(/Regola salvata/);
  const rule = calls.find(
    ([name]) => name === "create_classification_rule_and_apply",
  )?.[1].rule_input as Record<string, unknown>;
  assert.equal(rule.match_field, "provider_operation");
  assert.equal(rule.match_operator, "exact");
  assert.equal(rule.parser_key, "isybank_operations_v1");
  assert.equal(rule.account_id, "source");
  assert.equal(rule.target_transaction_type, "internal_transfer");
  assert.equal(rule.target_transfer_account_id, null);
});

test("investment review requires a broker and filters source and incompatible currency accounts", async () => {
  const { client, calls } = mockClient();
  const view = render(
    <ResidualReviewPage client={client} userId="synthetic-owner" />,
  );
  fireEvent.click(
    await view.findByRole("button", { name: /mittente sintetico/ }),
  );
  fireEvent.change(view.getByLabelText("Tipo di movimento"), {
    target: { value: "investment_transfer" },
  });
  assert.equal(
    (
      view.getByRole("button", {
        name: "Classifica e crea regola",
      }) as HTMLButtonElement
    ).disabled,
    true,
  );
  const select = view.getByLabelText(
    "Conto di destinazione",
  ) as HTMLSelectElement;
  assert.deepEqual(
    Array.from(select.options).map((o) => o.value),
    ["", "broker"],
  );
  fireEvent.change(select, { target: { value: "broker" } });
  fireEvent.click(view.getByRole("button", { name: "Classifica gruppo" }));
  await view.findByText("2 movimenti classificati");
  assert.equal(
    calls.find(([name]) => name === "bulk_classify_transactions")?.[1]
      .target_transfer_account_id,
    "broker",
  );
});

test("server errors remain visible and do not reload or lose the review selection", async () => {
  const { client, calls } = mockClient(group, "Selezione protetta dal server");
  const view = render(
    <ResidualReviewPage client={client} userId="synthetic-owner" />,
  );
  fireEvent.click(
    await view.findByRole("button", { name: /mittente sintetico/ }),
  );
  fireEvent.change(view.getByLabelText("Tipo di movimento"), {
    target: { value: "income" },
  });
  assert.equal(
    (view.getByLabelText("Categoria") as HTMLSelectElement).options.length,
    2,
  );
  fireEvent.click(view.getByRole("button", { name: "Classifica gruppo" }));
  assert.equal(
    (await view.findByRole("alert")).textContent,
    "Selezione protetta dal server",
  );
  assert.ok(view.getByLabelText("Tipo di movimento"));
  assert.equal(
    calls.filter(([name]) => name === "residual_review_groups").length,
    1,
  );
});

test("withdrawals remain unclassified by default and conflicting provenance disables saved rules", async () => {
  const { client } = mockClient({
    ...group,
    provider_category: "prelievi",
    provider_operation: "prelievo atm",
    metadata_conflicting: true,
  });
  const view = render(
    <ResidualReviewPage client={client} userId="synthetic-owner" />,
  );
  fireEvent.click(
    await view.findByRole("button", {
      name: /Prelievi — da riconciliare con contanti/,
    }),
  );
  assert.equal(
    (view.getByLabelText("Tipo di movimento") as HTMLSelectElement).value,
    "unclassified",
  );
  assert.equal(
    (
      view.getByRole("button", {
        name: "Classifica e crea regola",
      }) as HTMLButtonElement
    ).disabled,
    true,
  );
  assert.equal(
    (
      view.getByRole("button", {
        name: "Classifica gruppo",
      }) as HTMLButtonElement
    ).disabled,
    false,
  );
});

test("provider category exact rules are available in category groups and debt explanation is visible", async () => {
  const { client, calls } = mockClient({
    ...group,
    provider_category: "rate mutuo e finanziamento",
    provider_operation: null,
  });
  const view = render(
    <ResidualReviewPage client={client} userId="synthetic-owner" />,
  );
  fireEvent.click(
    await view.findByRole("button", {
      name: /La rata può includere capitale e interessi/,
    }),
  );
  assert.equal(
    (
      view.getByLabelText(
        "Come riconoscere movimenti simili in futuro",
      ) as HTMLSelectElement
    ).value,
    "provider_category",
  );
  fireEvent.change(view.getByLabelText("Tipo di movimento"), {
    target: { value: "adjustment" },
  });
  fireEvent.click(
    view.getByRole("button", { name: "Classifica e crea regola" }),
  );
  await view.findByText(/Regola salvata/);
  assert.equal(
    (
      calls.find(
        ([name]) => name === "create_classification_rule_and_apply",
      )?.[1].rule_input as Record<string, unknown>
    ).match_field,
    "provider_category",
  );
});

test("switching provider grouping reloads the aggregate page and clears the selection", async () => {
  const { client, calls } = mockClient();
  const view = render(
    <ResidualReviewPage client={client} userId="synthetic-owner" />,
  );
  fireEvent.click(
    await view.findByRole("button", { name: /mittente sintetico/ }),
  );
  fireEvent.change(view.getByLabelText("Raggruppa per"), {
    target: { value: "provider_category" },
  });
  await waitFor(() =>
    assert.equal(
      calls.filter(([name]) => name === "residual_review_groups").length,
      2,
    ),
  );
  assert.equal(
    calls.filter(([name]) => name === "residual_review_groups").at(-1)?.[1]
      .group_by,
    "provider_category",
  );
  assert.equal(view.queryByLabelText("Tipo di movimento"), null);
});

test("initial loading errors never report a completed review queue", async () => {
  const { client } = mockClient();
  const originalRpc = client.rpc;
  client.rpc = (async (name: string, args: Record<string, unknown>) =>
    name === "residual_review_groups"
      ? { data: null, error: { message: "Errore sintetico di caricamento" } }
      : originalRpc(name, args)) as unknown as typeof client.rpc;
  const view = render(
    <ResidualReviewPage client={client} userId="synthetic-owner" />,
  );
  assert.ok(view.getByText("Caricamento…"));
  assert.equal(
    (await view.findByRole("alert")).textContent,
    "Errore sintetico di caricamento",
  );
  assert.ok(view.getByRole("heading", { name: "Movimenti non disponibili" }));
  assert.equal(view.queryByText("Tutto in ordine"), null);
});
