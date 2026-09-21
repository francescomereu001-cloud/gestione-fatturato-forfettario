import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { SupabaseClient } from "@supabase/supabase-js";
import { commitImportBatch } from "./bankImports.ts";

const sql = readFileSync("supabase/migrations/202609210001_pr4_bank_imports.sql", "utf8");
const commitBody = sql.slice(sql.indexOf("create function public.commit_import_batch"), sql.indexOf("-- Link only"));
const transferBody = sql.slice(sql.indexOf("create function public.link_transfer"), sql.indexOf("commit;", sql.indexOf("create function public.link_transfer")));

test("frontend commits a batch with one RPC and no row inserts", async () => {
  const calls: unknown[][] = [];
  const client = { rpc: async (...args: unknown[]) => { calls.push(args); return { data: 2, error: null }; } } as unknown as SupabaseClient;
  assert.equal(await commitImportBatch(client, "batch"), 2);
  assert.deepEqual(calls, [["commit_import_batch", { target_batch_id: "batch" }]]);
});

test("commit RPC is invoker/owner scoped, prevalidates, and performs all writes in one function", () => {
  assert.match(commitBody, /security invoker/i); assert.match(commitBody, /user_id = auth\.uid\(\) for update/i);
  assert.match(commitBody, /Validate the complete ready set before writing/i);
  assert.ok(commitBody.indexOf("one or more ready rows are invalid") < commitBody.indexOf("insert into public.transactions"));
  assert.match(commitBody, /set status = 'imported', matched_transaction_id = inserted_id/i);
  assert.match(commitBody, /status = 'completed', completed_at = now\(\)/i);
});

test("commit normalizes economic signs and keeps duplicate counters final", () => {
  assert.match(commitBody, /in \('income', 'refund'\) then abs\(ready_row.amount\)/i);
  assert.match(commitBody, /in \('expense', 'debt_interest', 'debt_principal'\) then -abs\(ready_row.amount\)/i);
  assert.match(commitBody, /duplicate_count = \(select count\(\*\).*status = 'duplicate'\)/is);
  assert.doesNotMatch(commitBody, /duplicate_count[^;]*possible_duplicate/is);
});

test("one invalid ready row raises before any transaction, providing all-or-zero commit semantics", () => {
  assert.match(commitBody, /if exists[\s\S]*raise exception 'one or more ready rows are invalid'/i);
  assert.equal((commitBody.match(/insert into public\.transactions/g) ?? []).length, 1);
  assert.doesNotMatch(commitBody, /exception\s+when/i);
});

test("transfer RPC validates target, ownership, ignored/link state and broker semantics", () => {
  assert.match(transferBody, /target_type not in \('internal_transfer', 'investment_transfer'\)/i);
  assert.match(transferBody, /user_id = auth\.uid\(\) for update/ig);
  assert.match(transferBody, /reconciliation_status = 'ignored'/i);
  assert.match(transferBody, /transfer_group_id is not null/i);
  assert.match(transferBody, /transaction_type <> 'unclassified'/i);
  assert.match(transferBody, /investment transfer requires exactly one broker account/i);
});
