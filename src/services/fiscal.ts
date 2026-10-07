import type { SupabaseClient } from "@supabase/supabase-js";
import { ownedBy } from "../auth/ownership.ts";
import { blankFiscalSettings, type FiscalYearSettings, type FinancialTaxSummary, type TaxObligation, type FiscalAllocation } from "../types/fiscal.ts";
export async function loadFinancialTaxSummary(client: SupabaseClient, year: number): Promise<FinancialTaxSummary> {
  const { data, error } = await client.rpc("financial_tax_summary", { target_year: year });
  if (error) throw error;
  return data as FinancialTaxSummary;
}
export async function loadFiscalSettings(client: SupabaseClient, userId: string, year: number) {
  const { data, error } = await client.from("fiscal_year_settings").select("*").eq("user_id", userId).eq("tax_year", year).maybeSingle();
  if (error) throw error;
  return data ? data as FiscalYearSettings : blankFiscalSettings(year);
}
export async function saveFiscalSettings(client: SupabaseClient, userId: string, settings: FiscalYearSettings) {
  const { error } = await client.from("fiscal_year_settings").upsert(ownedBy(settings, userId), { onConflict: "user_id,tax_year" });
  if (error) throw error;
}
export async function loadTaxObligations(client: SupabaseClient, userId: string, year: number) {
  const { data, error } = await client.from("tax_liability_obligations").select("*").eq("user_id", userId).eq("report_year", year).order("due_date");
  if (error) throw error;
  return (data ?? []) as TaxObligation[];
}
export async function saveTaxObligation(client: SupabaseClient, userId: string, obligation: TaxObligation) {
  const payload = ownedBy(obligation, userId);
  const { error } = obligation.id
    ? await client.from("tax_liability_obligations").update(payload).eq("id", obligation.id).eq("user_id", userId)
    : await client.from("tax_liability_obligations").insert(payload);
  if (error) throw error;
}
export async function saveFiscalAllocation(client: SupabaseClient, userId: string, paymentId: string, allocation: FiscalAllocation) {
  // Allowlist metadata: never spread a legacy payment or edit its original amount/description/year/date.
  const { error } = await client.from("tax_payments").update({
    fiscal_allocation_status: allocation.fiscal_allocation_status, fiscal_tax_year: allocation.fiscal_tax_year,
    fiscal_payment_kind: allocation.fiscal_payment_kind, fiscal_payment_date: allocation.fiscal_payment_date,
    deductible_social_security: allocation.deductible_social_security, fiscal_obligation_id: allocation.fiscal_obligation_id,
    fiscal_allocation_note: allocation.fiscal_allocation_note,
  }).eq("id", paymentId).eq("user_id", userId);
  if (error) throw error;
}

export async function loadTaxPayments(client: SupabaseClient, userId: string) {
  const rows = [];
  for (let start=0; ; start+=500) {
    const {data,error}=await client.from('tax_payments').select('*').eq('user_id',userId).order('data',{ascending:false}).order('id').range(start,start+499);
    if(error) throw error;rows.push(...(data??[]));if(!data || data.length<500)break;
  }
  return rows;
}
