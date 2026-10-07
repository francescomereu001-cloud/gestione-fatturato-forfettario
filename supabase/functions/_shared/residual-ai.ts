// Shared server policy/validation module, also exercised by Node's test runner.
export type Candidate = {
  claim_id: string; attempt_token: string; fingerprint: string;
  normalized_merchant: string; provider: string; direction: "debit" | "credit";
  currency: string; account_type: string;
};
export type Category = { system_key: string; category_type: string };
export type Policy = { high: number; medium: number; batch_size: number; hourly_limit: number; logic_version: string; model: string };
export type Proposal = {
  proposed_transaction_type: "expense" | "income" | "refund" | null;
  proposed_category_system_key: string | null;
  normalized_merchant: string; confidence: number; reason: string; cannot_classify: boolean;
};
export type Batch = { policy: Policy; candidates: Candidate[]; categories: Category[] };
const proposalKeys = ["proposed_transaction_type", "proposed_category_system_key", "normalized_merchant", "confidence", "reason", "cannot_classify"];
export function validateProposal(value: unknown, candidate: Candidate, categories: Category[]): value is Proposal {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const p = value as Record<string, unknown>;
  if (Object.keys(p).length !== proposalKeys.length || proposalKeys.some(key => !(key in p))) return false;
  if (typeof p.confidence !== "number" || !Number.isFinite(p.confidence) || p.confidence < 0 || p.confidence > 1
    || typeof p.reason !== "string" || p.reason.length > 180
    || typeof p.normalized_merchant !== "string" || p.normalized_merchant.length > 100
    || typeof p.cannot_classify !== "boolean") return false;
  if (p.cannot_classify && p.proposed_transaction_type === null && p.proposed_category_system_key === null) return true;
  const category = categories.find(c => c.system_key === p.proposed_category_system_key);
  if (!category) return false;
  return (p.proposed_transaction_type === "expense" && candidate.direction === "debit" && category.category_type === "expense")
    || (p.proposed_transaction_type === "refund" && candidate.direction === "credit" && category.category_type === "expense")
    || (p.proposed_transaction_type === "income" && candidate.direction === "credit" && category.category_type === "income");
}
export function confidenceLevel(p: Proposal, policy: Policy): "high" | "medium" | "low" {
  return p.cannot_classify || p.confidence < policy.medium ? "low" : p.confidence < policy.high ? "medium" : "high";
}
export function groupCandidates(candidates: Candidate[]) {
  const groups = new Map<string, Candidate[]>();
  for (const candidate of candidates) {
    const key = JSON.stringify([candidate.fingerprint, candidate.provider, candidate.direction, candidate.account_type, candidate.currency]);
    const group = groups.get(key) ?? [];
    group.push(candidate); groups.set(key, group);
  }
  return [...groups.values()];
}
export function modelPayload(groups: Candidate[][], categories: Category[]) {
  // Deliberate allowlist: no UUIDs, amounts, raw_data, account/merchant fingerprints or arbitrary descriptions.
  return {
    movements: groups.map((group, index) => ({
      index, normalized_merchant: group[0].normalized_merchant, description: group[0].normalized_merchant,
      provider: group[0].provider, debit_credit: group[0].direction,
      currency: group[0].currency, account_type: group[0].account_type,
    })),
    allowed_categories: categories,
  };
}
export function responseSchema(categories: Category[]) {
  return {
    type: "object", additionalProperties: false, required: ["suggestions"], properties: {
      suggestions: { type: "array", items: {
        type: "object", additionalProperties: false, required: ["index", ...proposalKeys], properties: {
          index: { type: "integer" },
          proposed_transaction_type: { type: ["string", "null"], enum: ["expense", "income", "refund", null] },
          proposed_category_system_key: { type: ["string", "null"], enum: [...new Set(categories.map(c => c.system_key)), null] },
          normalized_merchant: { type: "string" }, confidence: { type: "number" },
          reason: { type: "string" }, cannot_classify: { type: "boolean" },
        },
      } },
    },
  };
}
export function parseModelResponse(value: unknown, groups: Candidate[][], categories: Category[]): Proposal[] | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const root = value as Record<string, unknown>;
  if (Object.keys(root).length !== 1 || !Array.isArray(root.suggestions) || root.suggestions.length !== groups.length) return null;
  const result: Proposal[] = [];
  const seen = new Set<number>();
  for (const entry of root.suggestions) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
    const { index, ...proposal } = entry;
    if (!Number.isInteger(index) || index < 0 || index >= groups.length || seen.has(index)
      || !validateProposal(proposal, groups[index][0], categories)) return null;
    seen.add(index); result[index] = proposal;
  }
  return result;
}
// Dependency injection exercises the actual orchestration without network or financial data.
export async function runResidualBatch(batch: Batch,
  ask: (payload: ReturnType<typeof modelPayload>, schema: ReturnType<typeof responseSchema>, policy: Policy) => Promise<unknown>,
  record: (candidate: Candidate, proposal: Proposal | { invalid: true } | null) => Promise<string>) {
  if (batch.candidates.length > batch.policy.batch_size) throw new Error("Unbounded batch");
  if (!batch.candidates.length) return { requested: 0, groups: 0, outcomes: {} as Record<string, number> };
  const groups = groupCandidates(batch.candidates);
  let proposals: Proposal[] | null = null;
  let invalid = false;
  try {
    if (batch.categories.length) {
      const response = await ask(modelPayload(groups, batch.categories), responseSchema(batch.categories), batch.policy);
      proposals = parseModelResponse(response, groups, batch.categories);
      invalid = proposals === null;
    }
  } catch { /* API failures leave claims residual and retryable after cooldown. */ }
  const outcomes: Record<string, number> = {};
  for (let i = 0; i < groups.length; i++) for (const candidate of groups[i]) {
    const status = await record(candidate, proposals?.[i] ?? (invalid ? { invalid: true } : null));
    outcomes[status] = (outcomes[status] ?? 0) + 1;
  }
  return { requested: batch.candidates.length, groups: groups.length, outcomes };
}
