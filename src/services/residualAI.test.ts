import test from "node:test";
import assert from "node:assert/strict";
import { confidenceLevel, groupCandidates, modelPayload, parseModelResponse, runResidualBatch, validateProposal,
 type Candidate, type Policy, type Proposal } from "../../supabase/functions/_shared/residual-ai.ts";
const candidate: Candidate = { claim_id: "private-uuid", attempt_token: "private-attempt", fingerprint: "v1:cafe synthetic", normalized_merchant: "cafe synthetic", provider: "isybank_operations_v1", direction: "debit", currency: "EUR", account_type: "checking" };
const categories = [{ system_key: "expense_dining", category_type: "expense" }, { system_key: "income_other", category_type: "income" }];
const policy: Policy = { high: .98, medium: .7, batch_size: 40, hourly_limit: 80, logic_version: "test", model: "test-model" };
const proposal: Proposal = { proposed_transaction_type: "expense", proposed_category_system_key: "expense_dining", normalized_merchant: "cafe synthetic", confidence: .85, reason: "Merchant ristorazione", cannot_classify: false };
const output = (p: Proposal = proposal) => ({ suggestions: [{ index: 0, ...p }] });
test("payload allowlist excludes internal identifiers, exact amounts and raw financial fields", () => {
 const payload = modelPayload([[{ ...candidate, raw_data: { iban: "synthetic-private" }, amount: 100, account_id: "secret", description: "secret" } as Candidate]], categories);
 const json = JSON.stringify(payload);
 for (const excluded of ["private-uuid", "private-attempt", "v1:", "synthetic-private", "secret", "raw_data", "account_id", '"amount"']) assert.ok(!json.includes(excluded), excluded);
 assert.equal(payload.movements[0].description, "cafe synthetic");
});
test("same fingerprint groups across transactions; provider, direction, account type and currency stay separate", () => {
 assert.equal(groupCandidates([candidate, { ...candidate, claim_id: "second" }]).length, 1);
 for (const change of [{ provider: "american_express_v1" }, { direction: "credit" as const }, { account_type: "credit_card" }, { currency: "USD" }, { fingerprint: "v1:other" }]) assert.equal(groupCandidates([candidate, { ...candidate, ...change }]).length, 2);
});
test("unknown category, incompatible sign/type, transfers and additional output fields are rejected", () => {
 for (const change of [{ proposed_category_system_key: "invented" }, { proposed_transaction_type: "income" }, { proposed_transaction_type: "internal_transfer" }, { confidence: NaN }, { confidence: 1.1 }, { extra: "unsafe" }, { reason: "x".repeat(181) }]) assert.equal(validateProposal({ ...proposal, ...change }, candidate, categories), false);
 assert.equal(validateProposal(proposal, candidate, categories), true);
 assert.equal(validateProposal({ ...proposal, cannot_classify: true, proposed_transaction_type: null, proposed_category_system_key: null }, candidate, categories), true);
});
test("strict batch parsing rejects duplicate/missing/out-of-range indices and malformed envelope", () => {
 assert.equal(parseModelResponse({ suggestions: [{ index: 0, ...proposal }, { index: 0, ...proposal }] }, [[candidate], [candidate]], categories), null);
 for (const value of [null, { suggestions: [] }, { suggestions: [{ index: 2, ...proposal }] }, { ...output(), extra: true }]) assert.equal(parseModelResponse(value, [[candidate]], categories), null);
 assert.deepEqual(parseModelResponse(output(), [[candidate]], categories), [proposal]);
});
test("central thresholds: high only at .98, medium at .70 and ambiguous stays low", () => {
 assert.equal(confidenceLevel({ ...proposal, confidence: .98 }, policy), "high");
 assert.equal(confidenceLevel({ ...proposal, confidence: .979 }, policy), "medium");
 assert.equal(confidenceLevel({ ...proposal, confidence: .7 }, policy), "medium");
 assert.equal(confidenceLevel({ ...proposal, confidence: .699 }, policy), "low");
 assert.equal(confidenceLevel({ ...proposal, confidence: 1, cannot_classify: true }, policy), "low");
});
test("no deterministic residual means no AI call; duplicate merchant is requested only once", async () => {
 let asks = 0; let records = 0;
 const ask = async () => { asks++; return output(); };
 const record = async () => { records++; return "suggested"; };
 const empty = await runResidualBatch({ policy, categories, candidates: [] }, ask, record);
 assert.equal(empty.requested, 0); assert.equal(asks, 0);
 const result = await runResidualBatch({ policy, categories, candidates: [candidate, { ...candidate, claim_id: "second" }] }, ask, record);
 assert.equal(asks, 1); assert.equal(records, 2); assert.equal(result.groups, 1);
});
test("API error/timeout and invalid output never produce an applicable accounting proposal", async () => {
 for (const ask of [async () => { throw new Error("timeout"); }, async () => ({ hallucination: true }), async () => output({ ...proposal, proposed_category_system_key: "invented" })]) {
  const writes: unknown[] = [];
  await runResidualBatch({ policy, categories, candidates: [candidate] }, ask, async (_, p) => { writes.push(p); return "failed"; });
  assert.ok(writes.length === 1 && (writes[0] === null || JSON.stringify(writes[0]) === '{"invalid":true}'));
 }
});
test("valid high/medium/low are passed to authoritative SQL with original claims", async () => {
 for (const confidence of [.99, .8, .2]) {
  await runResidualBatch({ policy, categories, candidates: [candidate] }, async () => output({ ...proposal, confidence }), async (claim, p) => {
   assert.equal(claim.claim_id, candidate.claim_id); assert.equal(p && "confidence" in p ? p.confidence : null, confidence); return "expected";
  });
 }
});
test("bounded batches and unavailable categories cannot trigger unbounded model calls", async () => {
 let asks = 0;
 const ask = async () => { asks++; return output(); };
 await assert.rejects(runResidualBatch({ policy, categories, candidates: Array(41).fill(candidate) }, ask, async () => "unused"), /Unbounded/);
 await runResidualBatch({ policy, categories: [], candidates: [candidate] }, ask, async (_, p) => { assert.equal(p, null); return "failed"; });
 assert.equal(asks, 0);
});
