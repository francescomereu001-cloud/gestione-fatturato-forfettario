import assert from "node:assert/strict";
import { test } from "node:test";
import type { SupabaseClient } from "@supabase/supabase-js";
import { loadSafeToSpend, moveFund, saveFund, saveGoal } from "./planning.ts";
import type { Fund, Goal } from "../types/planning.ts";
test("STS service calls server without owner, client formulas or fiscal-year override", async () => {
  const client = {
    rpc: async (name: string, args: unknown) => {
      assert.equal(name, "financial_safe_to_spend");
      assert.deepEqual(args, {});
      return {
        data: { safe_to_spend: null, status: "incomplete" },
        error: null,
      };
    },
  } as unknown as SupabaseClient;
  assert.equal((await loadSafeToSpend(client)).safe_to_spend, null);
});
test("STS errors propagate without fake zero or percentage fallback", async () => {
  const client = {
    rpc: async () => ({ data: null, error: new Error("unavailable") }),
  } as unknown as SupabaseClient;
  await assert.rejects(loadSafeToSpend(client), /unavailable/);
});
test("fund movement uses a single atomic RPC with positive amount and paired server transfer", async () => {
  const calls: unknown[] = [];
  const client = {
    rpc: async (name: string, args: unknown) => {
      calls.push([name, args]);
      return { data: "operation", error: null };
    },
  } as unknown as SupabaseClient;
  await moveFund(client, "allocate", "house", 600);
  await moveFund(client, "release", "house", 100);
  await moveFund(client, "transfer", "house", 200, "emergency", "Note");
  assert.deepEqual(calls, [
    ["financial_allocate_fund", { fund_id: "house", amount: 600, note: null }],
    ["financial_release_fund", { fund_id: "house", amount: 100, note: null }],
    [
      "financial_transfer_fund",
      {
        source_fund: "house",
        destination_fund: "emergency",
        amount: 200,
        note: "Note",
      },
    ],
  ]);
});
test("fund metadata save never writes balance, system key or ledger", async () => {
  const client = {
    from: (table: string) => {
      assert.equal(table, "financial_funds");
      return {
        update: (payload: Record<string, unknown>) => {
          assert.equal(payload.name, "Casa");
          assert.equal("balance" in payload, false);
          assert.equal("system_key" in payload, false);
          const query = {
            eq: () => query,
            then: (resolve: (v: unknown) => void) => resolve({ error: null }),
          };
          return query;
        },
      };
    },
  } as unknown as SupabaseClient;
  await saveFund(client, "owner", {
    id: "house",
    name: "Casa",
    balance: 99999,
    system_key: "house",
  } as Fund);
});
test("goal metadata save cannot inject independent progress or balances", async () => {
  const client = {
    from: (table: string) => {
      assert.equal(table, "financial_goals");
      return {
        insert: async (payload: Record<string, unknown>) => {
          assert.equal("current_amount" in payload, false);
          assert.equal("progress_percentage" in payload, false);
          assert.equal(payload.user_id, "owner");
          return { error: null };
        },
      };
    },
  } as unknown as SupabaseClient;
  await saveGoal(client, "owner", {
    name: "Casa",
    current_amount: 99999,
    progress_percentage: 99,
  } as Goal);
});
