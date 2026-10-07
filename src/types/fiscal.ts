export const fiscalPaymentKinds = ["substitute_tax_balance", "substitute_tax_advance", "inps_minimum", "inps_balance", "inps_advance", "other_contributions", "other_f24"] as const;
export type FiscalPaymentKind = typeof fiscalPaymentKinds[number];
export const fiscalPaymentLabels: Record<FiscalPaymentKind, string> = {
  substitute_tax_balance: "Imposta sostitutiva · saldo", substitute_tax_advance: "Imposta sostitutiva · acconto",
  inps_minimum: "INPS · minimale", inps_balance: "INPS · saldo/conguaglio", inps_advance: "INPS · acconto",
  other_contributions: "Altri contributi", other_f24: "Altro F24",
};
export type FiscalYearSettings = {
  user_id?: string; tax_year: number; tax_regime: "forfettario" | null; revenue_basis: "cash" | null;
  profitability_coefficient_pct: number | null; substitute_tax_rate_pct: number | null;
  social_security_scheme: "inps_merchants" | "inps_separate" | "none" | null;
  ordinary_social_rate_pct: number | null; minimum_social_income: number | null; first_social_band: number | null;
  additional_social_rate_pct: number | null; maximum_social_income: number | null; maternity_contribution: number | null;
  contribution_reduction_pct: number | null; activity_start_date: string | null; activity_end_date: string | null;
  parameter_period: "annual" | "activity_period" | null;
  invoice_semantics: "gross_less_enasarco" | "gross_with_other_net_adjustments" | null;
  enasarco_treatment: "not_applicable" | "withheld_deductible" | "withheld_not_deductible" | null;
  configuration_verified: boolean; parameters_status: "confirmed" | "estimated"; year_finalized: boolean;
  liability_schedule_verified: boolean; source_note: string | null;
};
export const blankFiscalSettings = (year: number): FiscalYearSettings => ({
  tax_year: year, tax_regime: null, revenue_basis: null, profitability_coefficient_pct: null, substitute_tax_rate_pct: null,
  social_security_scheme: null, ordinary_social_rate_pct: null, minimum_social_income: null, first_social_band: null,
  additional_social_rate_pct: null, maximum_social_income: null, maternity_contribution: null, contribution_reduction_pct: null,
  activity_start_date: null, activity_end_date: null, parameter_period: null, invoice_semantics: null, enasarco_treatment: null,
  configuration_verified: false, parameters_status: "estimated", year_finalized: false, liability_schedule_verified: false, source_note: null,
});
export type TaxObligation = {
  id?: string; user_id?: string; report_year: number; tax_year: number;
  obligation_role: "prior_year_balance" | "current_year_advance" | "other";
  payment_kind: FiscalPaymentKind; amount: number; due_date: string | null;
  status: "confirmed" | "estimated"; description: string; source_note: string | null;
};
export type FiscalAllocation = {
  fiscal_allocation_status: "allocated" | "unallocated"; fiscal_tax_year: number | null;
  fiscal_payment_kind: FiscalPaymentKind | null; fiscal_payment_date: string | null;
  deductible_social_security: boolean | null; fiscal_obligation_id: string | null; fiscal_allocation_note: string | null;
};
export type TaxScheduleRow = { key: string; tax_year: number; payment_kind: FiscalPaymentKind; role: string;
  amount: number; paid: number; remaining: number; due_date: string | null; status: "confirmed" | "estimated"; description: string };
export type FinancialTaxSummary = {
  tax_year: number; as_of: string; projection_status: "confirmed" | "estimated" | "incomplete"; calculated_at: string;
  missing_fields: string[]; warnings: string[]; revenue_invoiced: number; revenue_collected: number; taxable_revenue: number;
  receivables_uncollected: number; net_invoiced: number; enasarco_invoiced: number; enasarco_withheld: number;
  deductible_enasarco_withheld: number; forfettario_income: number | null; social_security_due_estimated: number | null;
  social_security_minimum_due: number | null; social_security_variable_due: number | null; maternity_due: number | null;
  social_security_paid: number; deductible_social_security_paid: number; deductible_contributions_applied: number | null;
  substitute_tax_base: number | null; substitute_tax_due_estimated: number | null; substitute_tax_paid: number;
  prior_year_balance_due: number | null; current_year_advances_due: number | null; total_tax_liability: number | null;
  already_paid: number | null; allocated_payments_cash_year: number; unallocated_payments: number; unallocated_payment_count: number;
  future_obligations: number | null; required_tax_reserve: number | null; reserved_tax_amount: null; tax_reserve_gap: null;
  schedule: TaxScheduleRow[];
};
