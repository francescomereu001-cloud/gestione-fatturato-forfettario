import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  Commitment,
  Fund,
  Goal,
  PlanningSettings,
  SafeToSpend,
} from "../types/planning.ts";
async function rpc<T>(
  client: SupabaseClient,
  name: string,
  args: Record<string, unknown> = {},
): Promise<T> {
  const { data, error } = await client.rpc(name, args);
  if (error) throw error;
  if (data === null && name !== "financial_bootstrap_funds")
    throw new Error("Risposta di pianificazione non disponibile");
  return data as T;
}
export const loadSafeToSpend = (client: SupabaseClient) =>
  rpc<SafeToSpend>(client, "financial_safe_to_spend");
export const loadFunds = (client: SupabaseClient) =>
  rpc<Fund[]>(client, "financial_fund_summary");
export const loadGoals = (client: SupabaseClient) =>
  rpc<Goal[]>(client, "financial_goal_summary");
export const bootstrapFunds = (client: SupabaseClient) =>
  rpc<void>(client, "financial_bootstrap_funds");
export async function moveFund(
  client: SupabaseClient,
  action: "allocate" | "release" | "transfer",
  fundId: string,
  amount: number,
  destination?: string,
  note?: string,
) {
  return rpc<string>(
    client,
    `financial_${action}_fund`,
    action === "transfer"
      ? {
          source_fund: fundId,
          destination_fund: destination,
          amount,
          note: note || null,
        }
      : { fund_id: fundId, amount, note: note || null },
  );
}
export async function saveFund(
  client: SupabaseClient,
  userId: string,
  fund: Fund,
) {
  const { error } = await client
    .from("financial_funds")
    .update({
      name: fund.name,
      target_amount: fund.target_amount,
      target_date: fund.target_date,
      planned_monthly_contribution: fund.planned_monthly_contribution,
      priority: fund.priority,
      is_active: fund.is_active,
    })
    .eq("id", fund.id)
    .eq("user_id", userId);
  if (error) throw error;
}
export async function saveGoal(
  client: SupabaseClient,
  userId: string,
  goal: Goal,
) {
  const payload = {
    user_id: userId,
    name: goal.name,
    goal_type: goal.goal_type,
    target_amount: goal.target_amount,
    target_date: goal.target_date,
    linked_fund_id: goal.linked_fund_id,
    priority: goal.priority,
    status: goal.status,
  };
  const { error } = goal.id
    ? await client
        .from("financial_goals")
        .update(payload)
        .eq("id", goal.id)
        .eq("user_id", userId)
    : await client.from("financial_goals").insert(payload);
  if (error) throw error;
}
export async function loadPlanningConfig(
  client: SupabaseClient,
  userId: string,
) {
  const [settings, commitments] = await Promise.all([
    client
      .from("financial_planning_settings")
      .select("*")
      .eq("user_id", userId)
      .maybeSingle(),
    client
      .from("planned_cash_commitments")
      .select("*")
      .eq("user_id", userId)
      .order("due_date"),
  ]);
  if (settings.error) throw settings.error;
  if (commitments.error) throw commitments.error;
  return {
    settings: (settings.data ?? {
      commitments_verified_through: null,
      default_safe_to_spend_horizon: 0,
      monthly_essential_expenses_target: null,
    }) as PlanningSettings,
    commitments: (commitments.data ?? []) as Commitment[],
  };
}
export async function savePlanningSettings(
  client: SupabaseClient,
  userId: string,
  settings: PlanningSettings,
) {
  const { error } = await client
    .from("financial_planning_settings")
    .upsert(
      {
        user_id: userId,
        commitments_verified_through: settings.commitments_verified_through,
        default_safe_to_spend_horizon: settings.default_safe_to_spend_horizon,
        monthly_essential_expenses_target:
          settings.monthly_essential_expenses_target,
      },
      { onConflict: "user_id" },
    );
  if (error) throw error;
}
export async function saveCommitment(
  client: SupabaseClient,
  userId: string,
  item: Commitment,
) {
  const payload = {
    user_id: userId,
    name: item.name,
    commitment_type: item.commitment_type,
    amount: item.amount,
    due_date: item.due_date,
    recurrence: item.recurrence,
    start_date: item.start_date,
    end_date: item.end_date,
    is_essential: item.is_essential,
    status: item.status,
    note: item.note,
  };
  const { error } = item.id
    ? await client
        .from("planned_cash_commitments")
        .update(payload)
        .eq("id", item.id)
        .eq("user_id", userId)
    : await client.from("planned_cash_commitments").insert(payload);
  if (error) throw error;
}
