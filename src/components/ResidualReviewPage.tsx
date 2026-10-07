import { useCallback, useEffect, useState } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import { transactionTypes, type Account, type TransactionCategory, type TransactionType } from "../types/ledger";
import { applyReviewOnce, blankReviewDecision, categoriesForDecision, isTransferType, loadResidualGroups, loadReviewOptions,
  reviewHint, saveReviewRule, serverErrorMessage, transferTargets,
  type ResidualGroup, type ReviewDecision, type ReviewGrouping, type ReviewPage } from "../services/residualReview";

export function ResidualReviewPage({ client, userId }: { client: SupabaseClient; userId: string }) {
  const [page, setPage] = useState<ReviewPage>({ groups: [], total_groups: 0, unclassified_count: 0 });
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [categories, setCategories] = useState<TransactionCategory[]>([]);
  const [grouping, setGrouping] = useState<ReviewGrouping>("provider_operation");
  const [offset, setOffset] = useState(0);
  const [selected, setSelected] = useState<ResidualGroup | null>(null);
  const [decision, setDecision] = useState<ReviewDecision>(blankReviewDecision);
  const [ruleField, setRuleField] = useState<ReviewGrouping>("provider_operation");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const [next, options] = await Promise.all([loadResidualGroups(client, grouping, offset), loadReviewOptions(client, userId)]);
      setPage(next); setAccounts(options.accounts); setCategories(options.categories); setError("");
    } catch (reason) { setError(serverErrorMessage(reason)); }
    finally { setLoading(false); }
  }, [client, userId, grouping, offset]);
  useEffect(() => {
    // Load the owner-scoped aggregate page when its grouping or pagination changes.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void reload();
  }, [reload]);
  const selectGroup = (group: ResidualGroup) => {
    setSelected(group); setDecision(blankReviewDecision()); setError(""); setMessage("");
    setRuleField(group.provider_operation ? "provider_operation" : "provider_category");
  };
  const apply = async (saveRule: boolean) => {
    if (!selected) return;
    setBusy(true); setError(""); setMessage("");
    try {
      const count = saveRule ? (await saveReviewRule(client, selected, decision, ruleField)).classified_count
        : await applyReviewOnce(client, selected.transaction_ids, decision);
      setMessage(`${count} movimenti aggiornati.${saveRule ? " Regola salvata per i prossimi import." : ""}`);
      setSelected(null); await reload();
    } catch (reason) { setError(serverErrorMessage(reason)); }
    finally { setBusy(false); }
  };
  const canSaveRule = selected?.parser_key && selected[ruleField] && !selected.metadata_conflicting;
  const invalidTarget = decision.transaction_type === "investment_transfer" && !decision.transfer_account_id;
  return <section className="panel">
    <h3>Review Center</h3>
    <p className="muted">{page.unclassified_count} movimenti da verificare · {page.total_groups} gruppi. Una decisione ambigua può restare non classificata.</p>
    {error && <div className="notice" role="alert">{error}</div>}
    {message && <p role="status">{message}</p>}
    <div className="filterBar">
      <label className="field">Raggruppa per<select aria-label="Raggruppa per" value={grouping} disabled={busy} onChange={e => {
        setGrouping(e.target.value as ReviewGrouping); setOffset(0); setSelected(null);
      }}><option value="provider_operation">Operazione provider / creditore</option><option value="provider_category">Categoria provider</option></select></label>
      <button className="ghost" disabled={busy || loading} onClick={() => { setSelected(null); void reload(); }}>Aggiorna residui</button>
    </div>
    {loading ? <p role="status">Caricamento…</p> : page.groups.length === 0 ? <p>Nessun residuo in questa pagina.</p> :
      <div className="reviewGroups">{page.groups.map(group => <button type="button" className={`reviewGroup ${selected?.group_key === group.group_key ? "selected" : ""}`}
        aria-pressed={selected?.group_key === group.group_key} key={group.group_key} disabled={busy} onClick={() => selectGroup(group)}>
        <strong>{reviewHint(group) || group.provider_operation || group.provider_category || "Metadata provider non disponibili"}</strong>
        <span>{group.transaction_count} movimenti · {new Intl.NumberFormat("it-IT", { style: "currency", currency: group.currency }).format(Number(group.total_amount))} · {group.date_min} – {group.date_max}</span>
        <span>Provider: {group.parser_key || "—"} · Conto: {group.account_name}</span>
        <span>Categoria provider: {group.provider_category || "—"}</span>
        <span>Operazione provider: {group.provider_operation || "—"}</span>
        {group.metadata_conflicting && <span>Provenance conflittuale: verifica manuale.</span>}
        {group.examples.map((example, i) => <small key={i}>{example}</small>)}
      </button>)}</div>}
    <div className="filterBar mt"><button disabled={offset === 0 || busy || loading} onClick={() => { setOffset(Math.max(0, offset - 50)); setSelected(null); }}>Precedenti</button>
      <button disabled={offset + 50 >= page.total_groups || busy || loading} onClick={() => { setOffset(offset + 50); setSelected(null); }}>Successivi</button></div>
    {selected && <div className="mt">
      <h4>Revisione del gruppo · {selected.transaction_ids.length} movimenti selezionati</h4>
      {selected.transaction_count > selected.transaction_ids.length && <p>Il gruppo contiene {selected.transaction_count} movimenti. Questa azione aggiorna i primi 500; aggiorna i residui per continuare.</p>}
      {reviewHint(selected) && <p className="notice">{reviewHint(selected)}</p>}
      <div className="formGrid compact">
        <label className="field">Transaction type<select value={decision.transaction_type} disabled={busy} onChange={e => setDecision({ transaction_type: e.target.value as TransactionType, category_id: null, transfer_account_id: null })}>
          {transactionTypes.map(type => <option key={type} value={type}>{type}</option>)}
        </select></label>
        {categoriesForDecision(decision.transaction_type, categories).length > 0 && <label className="field">Categoria<select value={decision.category_id ?? ""} disabled={busy} onChange={e => setDecision({ ...decision, category_id: e.target.value || null })}>
          <option value="">Nessuna</option>{categoriesForDecision(decision.transaction_type, categories).map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select></label>}
        {isTransferType(decision.transaction_type) && <label className="field">Controconto<select value={decision.transfer_account_id ?? ""} disabled={busy} onChange={e => setDecision({ ...decision, transfer_account_id: e.target.value || null })}>
          <option value="">{decision.transaction_type === "internal_transfer" ? "Conto non modellato — pending" : "Seleziona broker"}</option>
          {transferTargets(selected, decision.transaction_type, accounts).map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
        </select></label>}
        <label className="field">Campo della regola<select value={ruleField} disabled={busy} onChange={e => setRuleField(e.target.value as ReviewGrouping)}>
          {selected.provider_operation && <option value="provider_operation">Operazione provider</option>}
          {selected.provider_category && <option value="provider_category">Categoria provider</option>}
        </select></label>
      </div>
      {isTransferType(decision.transaction_type) && <p className="muted">{decision.transfer_account_id ? "Trasferimento confermato verso il controconto scelto." : decision.transaction_type === "investment_transfer" ? "Seleziona il conto broker per il trasferimento di investimento." : "Trasferimento interno noto, controconto non ancora modellato: riconciliazione pending."}</p>}
      <p className="muted">Salvando una regola, il campo scelto deve corrispondere esattamente per questo provider e conto.</p>
      <div className="filterBar"><button className="primary" disabled={busy || invalidTarget} onClick={() => void apply(false)}>Applica solo a questi movimenti</button>
        <button className="primary" disabled={busy || invalidTarget || !canSaveRule} onClick={() => void apply(true)}>Applica e salva regola</button></div>
    </div>}
  </section>;
}
