import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { SupabaseClient } from "@supabase/supabase-js";
import { classifyTransactions, matchesText, normalizeMatchText } from "./classification.ts";

const migration = readFileSync(new URL("../../supabase/migrations/202610020001_pr4_2_transaction_classification.sql", import.meta.url), "utf8");

test("classification text matching is normalized and supports only deterministic operators", () => {
  assert.equal(normalizeMatchText("  Supermercato   ESEMPIO "), "supermercato esempio");
  assert.equal(matchesText("Supermercato Esempio Roma", "supermercato esempio", "starts_with"), true);
  assert.equal(matchesText("Pagamento SUPERMERCATO   Esempio", "supermercato esempio", "contains"), true);
  assert.equal(matchesText("  Rimborso ", "rimborso", "exact"), true);
  assert.equal(matchesText("Rimborso carta", "rimborso", "exact"), false);
});

test("migration fixes processing order and provider-specific conservative fallbacks", () => {
  const transfer = migration.indexOf("Snapshot all compatible edges");
  const rules = migration.indexOf("Highest priority wins");
  const provider = migration.indexOf("Provider-only rules");
  assert.ok(transfer > 0 && transfer < rules && rules < provider);
  assert.match(migration, /american_express_v1/);
  assert.match(migration, /isybank_card_v1/);
  assert.match(migration, /addebito in c\/c salvo buon fine/);
  assert.doesNotMatch(migration, /generic_bank_v1'\)/);
});

test("migration protects manual, ignored, linked, same-account and ambiguous movements", () => {
  assert.match(migration, /classification_method is distinct from 'manual'/);
  assert.match(migration, /reconciliation_status <> 'ignored'/);
  assert.match(migration, /transfer_group_id is null/);
  assert.match(migration, /b\.account_id <> a\.account_id/);
  assert.match(migration, /da\.degree = 1/);
  assert.match(migration, /db\.degree = 1/);
});

test("rules are owner scoped, validate references, and use deterministic priority", () => {
  assert.match(migration, /r\.user_id = auth\.uid\(\)/);
  assert.match(migration, /account must belong to classification rule owner/);
  assert.match(migration, /category must belong to classification rule owner/);
  assert.match(migration, /order by r\.priority desc, r\.created_at, r\.id/);
  assert.match(migration, /security invoker/);
});

test("classification stays server-owned and preserves the RPC summary", async () => {
  const summary = { classified_count: 8, transfer_count: 2, unclassified_count: 3,
    categorized_count: 6, uncategorized_count: 2, total_transfer_count: 4 };
  const calls: unknown[] = [];
  const client = { rpc: async (...args: unknown[]) => { calls.push(args); return { data: summary, error: null }; } } as unknown as SupabaseClient;
  assert.deepEqual(await classifyTransactions(client, "synthetic-batch"), summary);
  assert.deepEqual(calls, [["classify_transactions", { target_batch_id: "synthetic-batch" }]]);
});

test("classification surfaces server failures", async () => {
  const client = { rpc: async () => ({ data: null, error: new Error("synthetic rejected batch") }) } as unknown as SupabaseClient;
  await assert.rejects(classifyTransactions(client), /synthetic rejected batch/);
});
