import test from "node:test";
import assert from "node:assert/strict";
import { chunkValues, classifyDuplicate, createImportPreview, possibleTransfer, transferTypeForAccounts } from "./bankImports.ts";
import type { ImportRow } from "../types/imports.ts";
import type { LedgerTransaction } from "../types/ledger.ts";

const movement = (overrides: Partial<LedgerTransaction> = {}): LedgerTransaction => ({ id: crypto.randomUUID(), user_id: "u", account_id: "a", transaction_date: "2026-09-21", amount: -100, description: "test", transaction_type: "unclassified", source: "bank_import", reconciliation_status: "pending", ...overrides });
const row = (external_id: string | null, dedupe_fingerprint: string): ImportRow => ({ row_index: 0, transaction_date: "2026-09-21", booking_date: null, amount: 1, description: "x", merchant: null, external_id, dedupe_fingerprint, suggested_transaction_type: "unclassified", suggested_category_id: null, status: "ready", raw_data: {} });

test("external id is a certain duplicate while fingerprint is only possible", () => {
  assert.equal(classifyDuplicate(row("REF-A", "FP-X"), new Set(["REF-A"]), new Map()), "duplicate");
  assert.equal(classifyDuplicate(row("REF-B", "FP-X"), new Set(["REF-A"]), new Map([["FP-X", 1]])), "ready");
  assert.equal(classifyDuplicate(row(null, "FP-X"), new Set(), new Map([["FP-X", 1]])), "possible_duplicate");
});

test("chunkValues splits 245 values without loss or duplication", () => {
  const values = Array.from({ length: 245 }, (_, index) => index);
  const chunks = chunkValues(values, 100);
  assert.deepEqual(chunks.map((chunk) => chunk.length), [100, 100, 45]);
  assert.deepEqual(chunks.flat(), values);
});

test("transfer candidates are conservative", () => {
  const source = movement(); const valid = movement({ account_id: "b", amount: 100 });
  assert.deepEqual(possibleTransfer(source, [valid]), [valid]);
  assert.deepEqual(possibleTransfer({ ...source, reconciliation_status: "ignored" }, [valid]), []);
  assert.deepEqual(possibleTransfer(source, [{ ...valid, reconciliation_status: "ignored" }]), []);
  assert.deepEqual(possibleTransfer(source, [{ ...valid, transfer_group_id: "linked" }]), []);
  assert.deepEqual(possibleTransfer(source, [{ ...valid, transaction_type: "internal_transfer" }]), []);
  assert.deepEqual(possibleTransfer(source, [{ ...valid, user_id: "other" }]), []);
});

test("broker pairs are investments while cash, checking and credit-card pairs are internal", () => {
  assert.equal(transferTypeForAccounts("checking", "broker"), "investment_transfer");
  assert.equal(transferTypeForAccounts("checking", "savings"), "internal_transfer");
  assert.equal(transferTypeForAccounts("checking", "credit_card"), "internal_transfer");
});

test("preview persists the parser key selected by the registry", async () => {
  let insertedBatch: Record<string, unknown> | undefined;
  const updates: Record<string, unknown>[] = [];
  const builder = {
    select() { return this; }, eq() { return this; }, neq() { return this; }, limit() { return Promise.resolve({ data: [], error: null }); },
  };
  const client = { rpc: async () => ({ data: [], error: null }), from(table: string) {
    if (table === "import_batches") return {
      ...builder,
      insert(value: Record<string, unknown>) { insertedBatch = value; return { select: () => ({ single: async () => ({ data: { id: "batch-1" }, error: null }) }) }; },
      update(value: Record<string, unknown>) { updates.push(value); return { eq() { return this; }, then(resolve: (value: unknown) => void) { resolve({ error: null }); } }; },
    };
    throw new Error(`Unexpected table ${table}`);
  } };
  const file = new File(["synthetic"], "statement.xlsx");
  const id = await createImportPreview(client as never, "user-1", "account-1", file, [], await file.arrayBuffer(), "american_express_v1");
  assert.equal(id, "batch-1");
  assert.equal(insertedBatch?.parser_key, "american_express_v1");
  assert.equal(insertedBatch?.status, "processing");
  assert.equal(updates.at(-1)?.status, "preview");
});

function stagingClient(failRowInsert: boolean) {
  const batchUpdates: Record<string, unknown>[] = [];
  let insertedBatch: Record<string, unknown> | undefined;
  const emptyQuery = () => {
    const query = {
      select() { return this; }, eq() { return this; }, neq() { return this; }, in() { return this; },
      limit() { return Promise.resolve({ data: [], error: null }); },
      then(resolve: (value: unknown) => void) { resolve({ data: [], error: null }); },
    };
    return query;
  };
  const client = { rpc: async () => ({ data: [], error: null }), from(table: string) {
    if (table === "import_batches") return {
      ...emptyQuery(),
      insert(value: Record<string, unknown>) { insertedBatch = value; return { select: () => ({ single: async () => ({ data: { id: "batch-1" }, error: null }) }) }; },
      update(value: Record<string, unknown>) { batchUpdates.push(value); return emptyQuery(); },
    };
    if (table === "transactions") return emptyQuery();
    if (table === "import_rows") return {
      ...emptyQuery(),
      insert(values: unknown[]) { return { select: async () => failRowInsert
        ? { data: null, error: new Error("insert denied") }
        : { data: values.map((_, index) => ({ id: `row-${index}` })), error: null } }; },
    };
    throw new Error(`Unexpected table ${table}`);
  } };
  return { client, batchUpdates, get insertedBatch() { return insertedBatch; } };
}

test("preview becomes visible only after every staged row was persisted", async () => {
  const mock = stagingClient(false);
  const rows = [row("REF-A", "FP-A"), row("REF-B", "FP-B")];
  const file = new File(["synthetic-success"], "statement.xlsx");
  await createImportPreview(mock.client as never, "user-1", "account-1", file, rows, await file.arrayBuffer(), "american_express_v1");
  assert.equal(mock.insertedBatch?.status, "processing");
  assert.deepEqual(mock.batchUpdates.map((update) => update.status), ["preview"]);
});

test("failed staging marks the processing batch failed and never preview", async () => {
  const mock = stagingClient(true);
  const file = new File(["synthetic-failure"], "statement.xlsx");
  await assert.rejects(createImportPreview(mock.client as never, "user-1", "account-1", file, [row("REF-A", "FP-A")], await file.arrayBuffer(), "american_express_v1"), /insert denied/);
  assert.equal(mock.insertedBatch?.status, "processing");
  assert.deepEqual(mock.batchUpdates.map((update) => update.status), ["failed"]);
  assert.match(String(mock.batchUpdates[0]?.notes), /insert denied/);
});

for (const [history, occurrences, expected] of [
  [0, 1, ["ready"]], [0, 2, ["ready", "ready"]],
  [1, 1, ["possible_duplicate"]], [1, 2, ["possible_duplicate", "ready"]],
  [2, 2, ["possible_duplicate", "possible_duplicate"]],
  [2, 3, ["possible_duplicate", "possible_duplicate", "ready"]],
] as const) {
  test(`weak fingerprint history ${history} / new file ${occurrences} preserves excess multiplicity`, () => {
    const counts = new Map([["same", history]]);
    const results = Array.from({ length: occurrences }, () => classifyDuplicate(row(null, "same"), new Set(), counts));
    assert.deepEqual(results, expected);
  });
}

test("invalid or ignored rows do not consume historical multiplicity", () => {
  const counts = new Map([["same", 1]]);
  assert.equal(classifyDuplicate({ ...row(null, "same"), status: "error" }, new Set(), counts), "error");
  assert.equal(classifyDuplicate(row(null, "same"), new Set(), counts), "possible_duplicate");
});

test("preview dedup is account-scoped and keeps legacy fallback routing", async () => {
  const staged: ImportRow[] = [];
  const calls: Record<string, unknown>[] = [];
  const base = stagingClient(false);
  const client = {
    from(table: string) {
      if (table === "import_rows") return { insert(values: ImportRow[]) {
        staged.push(...values); return { select: async () => ({ data: values.map(() => ({ id: "row" })), error: null }) };
      } };
      return base.client.from(table);
    },
    async rpc(name: string, args: Record<string, unknown>) {
      assert.equal(name, "import_dedup_history"); calls.push(args);
      return { data: args.target_account === "checking" ? [{ dedupe_fingerprint: "same", occurrences: 1 }] : [], error: null };
    },
  };
  const file = new File(["synthetic-multi"], "statement.xlsx");
  await createImportPreview(client as never, "owner", "checking", file, [
    { ...row(null, "same"), row_index: 0 },
    { ...row(null, "same"), row_index: 1, target_account_id: "card" },
    { ...row(null, "same"), row_index: 2, target_account_id: "checking" },
  ], await file.arrayBuffer(), "generic_bank_v1");
  assert.deepEqual(staged.map((item) => item.status), ["possible_duplicate", "ready", "ready"]);
  assert.deepEqual(calls.map((item) => item.target_account), ["checking", "card"]);
});

test("new operations previews cannot bypass explicit instrument routing", async () => {
  const file = new File(["synthetic-unmapped"], "statement.xlsx");
  await assert.rejects(createImportPreview({} as never, "owner", "checking", file,
    [row(null, "same")], await file.arrayBuffer(), "isybank_operations_v1"), /strumento e un account/);
});
