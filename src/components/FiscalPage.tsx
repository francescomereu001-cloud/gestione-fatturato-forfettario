import { fiscalMoney } from "./ui/fiscalLabels";
import type { ReactNode } from "react";
import { useCallback, useEffect, useState } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import { Badge } from "./ui/Badge";
import { Button } from "./ui/Button";
import { StatCard } from "./ui/StatCard";
import { serverErrorMessage } from "../services/residualReview";
import { loadFiscalSettings, loadTaxObligations, saveFiscalSettings, saveTaxObligation } from "../services/fiscal";
import { blankFiscalSettings, fiscalPaymentKinds, fiscalPaymentLabels, type FinancialTaxSummary, type FiscalYearSettings, type TaxObligation } from "../types/fiscal";
import type { TaxSettings } from "../types/finance";

const statusLabels = { confirmed: "Confermato", estimated: "Stimato", incomplete: "Dati incompleti" };
const fieldLabels: Record<string, string> = {
  annual_fiscal_profile: "Profilo fiscale annuale", tax_regime: "Regime fiscale", revenue_basis: "Criterio di cassa",
  profitability_coefficient_pct: "Coefficiente di redditività %", substitute_tax_rate_pct: "Aliquota imposta sostitutiva %",
  social_security_scheme: "Gestione previdenziale", ordinary_social_rate_pct: "Aliquota previdenziale ordinaria %",
  minimum_social_income: "Minimale reddito previdenziale", first_social_band: "Prima fascia previdenziale",
  additional_social_rate_pct: "Aliquota aggiuntiva oltre prima fascia %", maximum_social_income: "Massimale previdenziale",
  maternity_contribution: "Contributo maternità", contribution_reduction_pct: "Riduzione contributiva % (0 se non prevista)",
  activity_start_date: "Data inizio attività", parameter_period: "Periodo dei parametri previdenziali", invoice_semantics: "Semantica lordo / ENASARCO / netto",
  enasarco_treatment: "Trattamento ENASARCO", source_note: "Fonte / note sui parametri", liability_schedule_verification: "Verifica saldi precedenti e scadenze/acconti",
  social_threshold_order: "Ordine minimale, prima fascia e massimale", activity_period_parameters: "Parametri espliciti per attività svolta solo in parte dell’anno",
  unsupported_separate_reduction: "La gestione separata richiede riduzione pari a zero", invoice_cash_dates_or_amount_semantics: "Date incasso e importi delle fatture da verificare",
  unallocated_tax_payments: "Competenza e tipo degli F24 non attribuiti", payment_dates_or_amounts: "Date e importi dei pagamenti da verificare",
  other_contribution_deduction_note: "Nota sugli altri contributi deducibili per evitare doppio ENASARCO", income_outside_activity_period: "Incassi fuori dal periodo di attività da verificare",
};
export function FiscalSummaryPanel({ summary, error = "", loading = false }: { summary: FinancialTaxSummary | null; error?: string; loading?: boolean }) {
  if (!summary) return <section className="panel" aria-busy={loading}><h3>Proiezione fiscale</h3><p role={error ? "alert" : "status"}>{error || (loading ? "Caricamento della proiezione fiscale…" : "Proiezione fiscale non disponibile.")}</p></section>;
  const cards: Array<[string, number | null]> = [
    ["Incassato fiscalmente rilevante", summary.taxable_revenue], ["Reddito forfettario", summary.forfettario_income],
    ["INPS stimata", summary.social_security_due_estimated], ["Contributi già pagati · competenza anno", summary.social_security_paid],
    ["Contributi deducibili versati nell’anno", summary.deductible_social_security_paid], ["Base imposta sostitutiva", summary.substitute_tax_base],
    ["Imposta sostitutiva stimata", summary.substitute_tax_due_estimated], ["F24 allocati · pagati nell’anno", summary.allocated_payments_cash_year],
    ["Saldi precedenti da coprire", summary.prior_year_balance_due], ["Acconti da coprire", summary.current_year_advances_due],
    ["Obbligazioni ancora da coprire", summary.future_obligations], ["Tax Reserve richiesta", summary.required_tax_reserve],
  ];
  return <section className="panel">
    <h3>Proiezione fiscale {summary.tax_year}</h3>
    <Badge variant={summary.projection_status === "confirmed" ? "success" : summary.projection_status === "incomplete" ? "danger" : "warning"}>{statusLabels[summary.projection_status]}</Badge>
    <p>Situazione al {summary.as_of}. La riserva richiesta copre obbligazioni non ancora pagate; non rappresenta disponibilità bancaria o denaro già accantonato.</p>
    {summary.missing_fields.length > 0 && <div className="notice" role="alert"><strong>Per completare la proiezione:</strong><ul>{summary.missing_fields.map(field => <li key={field}>{fieldLabels[field] ?? field}</li>)}</ul></div>}
    {summary.warnings.includes("profile_not_verified") && <p className="notice">Profilo non verificato: i parametri restano una stima.</p>}
    <div className="cards mini">{cards.map(([title, value]) => <StatCard key={title} title={title} value={fiscalMoney(value)} />)}</div>
    <p>Fatture emesse: {fiscalMoney(summary.revenue_invoiced)} · Denaro incassato al netto delle trattenute: {fiscalMoney(summary.revenue_collected)} · Crediti da incassare: {fiscalMoney(summary.receivables_uncollected)}</p>
    <p>ENASARCO già trattenuto: {fiscalMoney(summary.enasarco_withheld)} · Quota deducibile configurata: {fiscalMoney(summary.deductible_enasarco_withheld)}. Le trattenute non vengono accantonate una seconda volta.</p>
    <p>F24 non attribuiti: {fiscalMoney(summary.unallocated_payments)} ({summary.unallocated_payment_count}). Fondo fiscale riservato e differenza da colmare: non disponibili.</p>
    {summary.schedule.length > 0 && <div className="rows"><h4>Obbligazioni fiscali e previdenziali</h4>{summary.schedule.map(row => <div className="row" key={row.key}>
      <span>{row.description} · competenza {row.tax_year} · {fiscalPaymentLabels[row.payment_kind]} · {row.due_date || "Data non definita"} <Badge variant={row.status === "confirmed" ? "success" : "warning"}>{statusLabels[row.status]}</Badge></span>
      <span>{fiscalMoney(row.remaining)} da coprire · {fiscalMoney(row.paid)} coperti</span>
    </div>)}</div>}
  </section>;
}
const numericKeys = ["profitability_coefficient_pct", "substitute_tax_rate_pct", "ordinary_social_rate_pct", "minimum_social_income", "first_social_band", "additional_social_rate_pct", "maximum_social_income", "maternity_contribution", "contribution_reduction_pct"] as const;
function blankObligation(year: number): TaxObligation {
  return { report_year: year, tax_year: year, obligation_role: "other", payment_kind: "other_f24", amount: 0, due_date: null, status: "estimated", description: "", source_note: null };
}
export function FiscalPage({ client, userId, year, summary, error, loading, legacySettings, legacyEditor, onSaved }: {
  client: SupabaseClient; userId: string; year: number; summary: FinancialTaxSummary | null; error: string; loading: boolean;
  legacyEditor?: ReactNode; legacySettings?: TaxSettings; onSaved: () => Promise<void>;
}) {
  const [form, setForm] = useState(blankFiscalSettings(year));
  const [obligations, setObligations] = useState<TaxObligation[]>([]);
  const [obligation, setObligation] = useState(blankObligation(year));
  const [busy, setBusy] = useState(false); const [message, setMessage] = useState(""); const [loadError, setLoadError] = useState("");
  const reload = useCallback(async () => {
    try { const [settings, rows] = await Promise.all([loadFiscalSettings(client, userId, year), loadTaxObligations(client, userId, year)]); setForm(settings); setObligations(rows); setObligation(blankObligation(year)); setLoadError(""); }
    catch (reason) { setLoadError(serverErrorMessage(reason)); }
  }, [client, userId, year]);
  useEffect(() => {
    // Synchronize the selected owner/year with persisted configuration.
    void reload();
  }, [reload]);
  const save = async (schedule: boolean) => {
    setBusy(true); setMessage("");
    try {
      if (schedule) await saveTaxObligation(client, userId, { ...obligation, report_year: year });
      else await saveFiscalSettings(client, userId, { ...form, tax_year: year });
      await reload(); await onSaved(); setMessage(schedule ? "Obbligazione salvata" : "Profilo fiscale salvato");
    } catch (reason) { setMessage(serverErrorMessage(reason)); } finally { setBusy(false); }
  };
  const select = (key: keyof FiscalYearSettings, label: string, options: Array<[string, string]>) => <label className="field" key={key}>{label}<select value={String(form[key] ?? "")} disabled={busy} onChange={e => setForm({ ...form, [key]: e.target.value || null })}><option value="">Da configurare</option>{options.map(([value, text]) => <option key={value} value={value}>{text}</option>)}</select></label>;
  return <>
    <FiscalSummaryPanel summary={summary} error={error} loading={loading} />
    <section className="panel" aria-busy={busy}>
      <h3>Profilo e parametri fiscali {year}</h3>
      <p>Inserisci parametri riferiti a questo anno e confermati per la tua posizione. I campi vuoti non vengono sostituiti con aliquote presunte.</p>
      {(message || loadError) && <p className="notice" role={loadError ? "alert" : "status"}>{loadError || message}</p>}
      <div className="formGrid">
        {select("tax_regime", "Regime fiscale", [["forfettario", "Forfettario"]])}
        {select("revenue_basis", "Criterio ricavi", [["cash", "Cassa · solo compensi incassati"]])}
        {select("social_security_scheme", "Gestione previdenziale", [["inps_merchants", "INPS commercianti"], ["inps_separate", "INPS gestione separata"], ["none", "Nessuna contribuzione configurata"]])}
        {numericKeys.map(key => <label className="field" key={key}>{fieldLabels[key]}<input type="number" step="any" min="0" disabled={busy} value={form[key] ?? ""} onChange={e => setForm({ ...form, [key]: e.target.value === "" ? null : Number(e.target.value) })} /></label>)}
        <label className="field">Data inizio attività<input type="date" value={form.activity_start_date ?? ""} disabled={busy} onChange={e => setForm({ ...form, activity_start_date: e.target.value || null })} /></label>
        <label className="field">Data fine attività (se conclusa)<input type="date" value={form.activity_end_date ?? ""} disabled={busy} onChange={e => setForm({ ...form, activity_end_date: e.target.value || null })} /></label>
        {select("parameter_period", "Periodo dei parametri previdenziali", [["annual", "Intero anno"], ["activity_period", "Valori verificati per il periodo di attività"]])}
        {select("invoice_semantics", "Semantica fatture", [["gross_less_enasarco", "Lordo compenso · netto = lordo meno ENASARCO"], ["gross_with_other_net_adjustments", "Lordo compenso · netto con altre rettifiche esplicite"]])}
        {select("enasarco_treatment", "Trattamento ENASARCO", [["not_applicable", "Non applicabile"], ["withheld_deductible", "Già trattenuto e deducibile"], ["withheld_not_deductible", "Già trattenuto, non dedotto nella proiezione"]])}
        {select("parameters_status", "Stato dei parametri", [["estimated", "Stimati"], ["confirmed", "Confermati"]])}
        <label className="field">Fonte / note sui parametri<textarea value={form.source_note ?? ""} disabled={busy} onChange={e => setForm({ ...form, source_note: e.target.value || null })} /></label>
        {([ ["configuration_verified", "Ho verificato il profilo e l’applicabilità dei parametri"], ["liability_schedule_verified", "Ho verificato saldi precedenti e acconti/scadenze da coprire"], ["year_finalized", "Anno chiuso: ricavi e pagamenti verificati"] ] as const).map(([key, label]) => <label className="check" key={key}><input type="checkbox" checked={form[key]} disabled={busy} onChange={e => setForm({ ...form, [key]: e.target.checked })} />{label}</label>)}
      </div>
      <Button disabled={busy || Boolean(loadError)} onClick={() => void save(false)}>Salva profilo annuale</Button>
      {legacySettings && <details className="technicalDetails"><summary>Parametri fiscali legacy conservati</summary><p>Questi valori non alimentano la nuova proiezione finché non configuri il profilo annuale.</p><p>Imposta {legacySettings.aliquota_imposta}% · Coefficiente {legacySettings.coefficiente_redditivita}% · INPS {legacySettings.aliquota_inps}% · Minimale {fiscalMoney(legacySettings.minimale_inps)}</p>
        {legacyEditor}
        <Button variant="secondary" disabled={busy} onClick={() => setForm({ ...form, profitability_coefficient_pct: legacySettings.coefficiente_redditivita, substitute_tax_rate_pct: legacySettings.aliquota_imposta, ordinary_social_rate_pct: legacySettings.aliquota_inps, minimum_social_income: legacySettings.minimale_inps, configuration_verified: false, parameters_status: "estimated", source_note: "Parametri legacy da verificare; completare gestione, fasce, massimale e scadenze." })}>Copia parametri legacy nella bozza</Button></details>}
    </section>
    <section className="panel">
      <h3>Saldi precedenti, acconti e altre obbligazioni</h3><p>Inserisci importi e scadenze documentati. Gli acconti della stessa competenza non vengono sommati due volte alla stima annuale.</p>
      {obligations.map(row => <div className="row" key={row.id}><span>{row.description} · competenza {row.tax_year} · {fiscalMoney(row.amount)}</span><Button variant="ghost" disabled={busy} onClick={() => setObligation(row)}>Modifica {row.description}</Button></div>)}
      <div className="formGrid">
        <label className="field">Descrizione obbligazione<input value={obligation.description} onChange={e => setObligation({ ...obligation, description: e.target.value })} /></label>
        <label className="field">Anno di competenza obbligazione<input type="number" value={obligation.tax_year} onChange={e => setObligation({ ...obligation, tax_year: Number(e.target.value) })} /></label>
        <label className="field">Ruolo obbligazione<select value={obligation.obligation_role} onChange={e => setObligation({ ...obligation, obligation_role: e.target.value as TaxObligation["obligation_role"] })}><option value="prior_year_balance">Saldo di anni precedenti</option><option value="current_year_advance">Acconto di quest’anno</option><option value="other">Altra obbligazione</option></select></label>
        <label className="field">Tipo obbligazione<select value={obligation.payment_kind} onChange={e => setObligation({ ...obligation, payment_kind: e.target.value as TaxObligation["payment_kind"] })}>{fiscalPaymentKinds.map(kind => <option key={kind} value={kind}>{fiscalPaymentLabels[kind]}</option>)}</select></label>
        <label className="field">Importo obbligazione<input type="number" min="0" step="0.01" value={obligation.amount} onChange={e => setObligation({ ...obligation, amount: Number(e.target.value) })} /></label>
        <label className="field">Scadenza obbligazione<input type="date" value={obligation.due_date ?? ""} onChange={e => setObligation({ ...obligation, due_date: e.target.value || null })} /></label>
        <label className="field">Stato obbligazione<select value={obligation.status} onChange={e => setObligation({ ...obligation, status: e.target.value as TaxObligation["status"] })}><option value="estimated">Stimato</option><option value="confirmed">Confermato</option></select></label>
        <label className="field">Fonte obbligazione<input value={obligation.source_note ?? ""} onChange={e => setObligation({ ...obligation, source_note: e.target.value || null })} /></label>
      </div><Button disabled={busy || !obligation.description.trim() || Boolean(loadError)} onClick={() => void save(true)}>Salva obbligazione</Button>
      {obligation.id && <Button variant="ghost" disabled={busy} onClick={() => setObligation(blankObligation(year))}>Annulla modifica</Button>}
    </section>
  </>;
}
