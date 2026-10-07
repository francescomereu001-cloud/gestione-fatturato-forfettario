import { useCallback, useEffect, useState } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { TaxPayment } from "../types/finance";
import { fiscalPaymentKinds, fiscalPaymentLabels, type FiscalAllocation, type TaxObligation } from "../types/fiscal";
import { loadTaxObligations, saveFiscalAllocation } from "../services/fiscal";
import { serverErrorMessage } from "../services/residualReview";
import { Button } from "./ui/Button";
import { Badge } from "./ui/Badge";
import { fiscalMoney } from "./ui/fiscalLabels";
export function FiscalPaymentAllocations({ client, userId, year, payments, onSaved }: {
  client: SupabaseClient; userId: string; year: number; payments: TaxPayment[]; onSaved: () => Promise<void>;
}) {
  const [selected, setSelected] = useState<TaxPayment | null>(null);
  const [allocation, setAllocation] = useState<FiscalAllocation>({ fiscal_allocation_status: "unallocated", fiscal_tax_year: null, fiscal_payment_kind: null, fiscal_payment_date: null, deductible_social_security: null, fiscal_obligation_id: null, fiscal_allocation_note: null });
  const [obligations, setObligations] = useState<TaxObligation[]>([]); const [message, setMessage] = useState(""); const [busy, setBusy] = useState(false);
  const reload = useCallback(async () => {
    try { setObligations(await loadTaxObligations(client, userId, year)); }
    catch (reason) { setMessage(serverErrorMessage(reason)); }
  }, [client, userId, year]);
  useEffect(() => {
    // Load only the selected owner's report-year schedule.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void reload();
  }, [reload]);
  const choose = (payment: TaxPayment) => {
    setSelected(payment); setMessage("");
    setAllocation({ fiscal_allocation_status: payment.fiscal_allocation_status ?? "unallocated", fiscal_tax_year: payment.fiscal_tax_year ?? null,
      fiscal_payment_kind: payment.fiscal_payment_kind ?? null, fiscal_payment_date: payment.fiscal_payment_date ?? payment.data ?? null,
      deductible_social_security: payment.deductible_social_security ?? false, fiscal_obligation_id: payment.fiscal_obligation_id ?? null, fiscal_allocation_note: payment.fiscal_allocation_note ?? null });
  };
  const save = async (unallocate: boolean) => {
    if (!selected?.id) return;
    setBusy(true);
    try {
      await saveFiscalAllocation(client, userId, selected.id, unallocate ? { fiscal_allocation_status: "unallocated", fiscal_tax_year: null, fiscal_payment_kind: null, fiscal_payment_date: null, deductible_social_security: null, fiscal_obligation_id: null, fiscal_allocation_note: null } : { ...allocation, fiscal_allocation_status: "allocated" });
      await onSaved(); setSelected(null); setMessage(unallocate ? "Attribuzione rimossa" : "Competenza fiscale attribuita");
    } catch (reason) { setMessage(serverErrorMessage(reason)); } finally { setBusy(false); }
  };
  const social = allocation.fiscal_payment_kind && ["inps_minimum", "inps_balance", "inps_advance", "other_contributions"].includes(allocation.fiscal_payment_kind);
  return <section className="panel" aria-busy={busy}><h3>Attribuzione F24 per competenza</h3><p>La data di versamento può differire dall’anno di competenza. Attribuisci solo i dati verificati; un pagamento può saldare un anno diverso da quello in cui è stato versato.</p>
    {message && <p className="notice" role="status">{message}</p>}
    {payments.map(payment => <div className="row" key={payment.id}><span>{payment.data} · {payment.descrizione} · {fiscalMoney(payment.importo)} <Badge variant={payment.fiscal_allocation_status === "allocated" ? "success" : "warning"}>{payment.fiscal_allocation_status === "allocated" ? `Competenza ${payment.fiscal_tax_year} · ${fiscalPaymentLabels[payment.fiscal_payment_kind!]}` : "Non attribuito"}</Badge></span><Button variant="ghost" disabled={busy} onClick={() => choose(payment)}>Attribuisci {payment.descrizione || payment.id}</Button></div>)}
    {selected && <><h4>{selected.descrizione}</h4><div className="formGrid">
      <label className="field">Anno di competenza F24<input type="number" min="1900" max="2200" value={allocation.fiscal_tax_year ?? ""} onChange={e => setAllocation({ ...allocation, fiscal_tax_year: e.target.value ? Number(e.target.value) : null, fiscal_obligation_id: null })} /></label>
      <label className="field">Tipo fiscale F24<select value={allocation.fiscal_payment_kind ?? ""} onChange={e => setAllocation({ ...allocation, fiscal_payment_kind: e.target.value as FiscalAllocation["fiscal_payment_kind"] || null, deductible_social_security: false, fiscal_obligation_id: null })}><option value="">Da verificare</option>{fiscalPaymentKinds.map(kind => <option key={kind} value={kind}>{fiscalPaymentLabels[kind]}</option>)}</select></label>
      <label className="field">Data fiscale del pagamento<input type="date" value={allocation.fiscal_payment_date ?? ""} onChange={e => setAllocation({ ...allocation, fiscal_payment_date: e.target.value || null })} /></label>
      <label className="field">Obbligazione specifica (facoltativa)<select value={allocation.fiscal_obligation_id ?? ""} onChange={e => setAllocation({ ...allocation, fiscal_obligation_id: e.target.value || null })}><option value="">Copertura per competenza e tipo</option>{obligations.filter(row => row.tax_year === allocation.fiscal_tax_year && row.payment_kind === allocation.fiscal_payment_kind).map(row => <option key={row.id} value={row.id}>{row.description}</option>)}</select></label>
      {social && <label className="check"><input type="checkbox" checked={allocation.deductible_social_security === true} onChange={e => setAllocation({ ...allocation, deductible_social_security: e.target.checked })} />Contributo obbligatorio deducibile nell’anno del pagamento</label>}
      <label className="field">Nota sull’attribuzione / deducibilità<textarea value={allocation.fiscal_allocation_note ?? ""} onChange={e => setAllocation({ ...allocation, fiscal_allocation_note: e.target.value || null })} /></label>
    </div><Button disabled={busy || !allocation.fiscal_tax_year || !allocation.fiscal_payment_kind || !allocation.fiscal_payment_date} onClick={() => void save(false)}>Conferma attribuzione</Button><Button variant="secondary" disabled={busy} onClick={() => void save(true)}>Mantieni non attribuito</Button></>}
  </section>;
}
