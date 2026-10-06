import { useCallback, useEffect, useState } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import { amountDirections, matchFields, matchOperators, type ClassificationRule } from "../types/classification";
import { transactionTypes, type Account, type TransactionCategory } from "../types/ledger";
import { loadClassificationRules } from "../services/classification";

const blankRule = (): ClassificationRule => ({ name: "", priority: 100, is_active: true, account_id: null, parser_key: null,
  match_field: "description", match_operator: "contains", pattern: "", amount_direction: "any",
  target_transaction_type: null, target_category_id: null, target_merchant: null });

export function ClassificationRules({ client, userId, accounts, categories, suggested, onSuggestionHandled }: {
  client: SupabaseClient; userId: string; accounts: Account[]; categories: TransactionCategory[];
  suggested?: ClassificationRule | null; onSuggestionHandled?: () => void;
}) {
  const [rules, setRules] = useState<ClassificationRule[]>([]); const [form, setForm] = useState(blankRule()); const [message, setMessage] = useState("");
  const reload = useCallback(async () => setRules(await loadClassificationRules(client, userId)), [client, userId]);
  useEffect(() => {
    // The async loader synchronizes this editor with persisted rules.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void reload();
  }, [reload]);
  useEffect(() => { if (suggested) {
    // A confirmed transaction edit intentionally seeds the rule editor.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setForm(suggested); onSuggestionHandled?.();
  } }, [suggested, onSuggestionHandled]);
  const save = async () => {
    const payload = { ...form, user_id: userId, pattern: form.pattern.trim() };
    const query = form.id ? client.from("transaction_classification_rules").update(payload).eq("id", form.id).eq("user_id", userId) : client.from("transaction_classification_rules").insert(payload);
    const { error } = await query; setMessage(error?.message ?? "Regola salvata. Sarà applicata alla prossima classificazione.");
    if (!error) { setForm(blankRule()); await reload(); }
  };
  const remove = async (rule: ClassificationRule) => { if (rule.id) { await client.from("transaction_classification_rules").delete().eq("id", rule.id).eq("user_id", userId); await reload(); } };
  const toggle = async (rule: ClassificationRule) => { if (rule.id) { await client.from("transaction_classification_rules").update({ is_active: !rule.is_active }).eq("id", rule.id).eq("user_id", userId); await reload(); } };
  return <div className="mt"><h3>Regole di classificazione</h3><p className="muted">Priorità più alta applicata per prima; a parità vince la regola più vecchia.</p>{message && <div className="notice">{message}</div>}
    <div className="formGrid compact"><label className="field">Nome<input value={form.name} onChange={e => setForm({ ...form, name: e.target.value })}/></label><label className="field">Conto<select value={form.account_id ?? ""} onChange={e => setForm({ ...form, account_id: e.target.value || null })}><option value="">Tutti</option>{accounts.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}</select></label><label className="field">Provider<input placeholder="es. american_express_v1" value={form.parser_key ?? ""} onChange={e => setForm({ ...form, parser_key: e.target.value || null })}/></label><label className="field">Campo<select value={form.match_field} onChange={e => setForm({ ...form, match_field: e.target.value as ClassificationRule["match_field"] })}>{matchFields.map(v => <option key={v}>{v}</option>)}</select></label><label className="field">Operatore<select value={form.match_operator} onChange={e => setForm({ ...form, match_operator: e.target.value as ClassificationRule["match_operator"] })}>{matchOperators.map(v => <option key={v}>{v}</option>)}</select></label><label className="field">Pattern<input value={form.pattern} onChange={e => setForm({ ...form, pattern: e.target.value })}/></label><label className="field">Direzione<select value={form.amount_direction} onChange={e => setForm({ ...form, amount_direction: e.target.value as ClassificationRule["amount_direction"] })}>{amountDirections.map(v => <option key={v}>{v}</option>)}</select></label><label className="field">Tipo destinazione<select value={form.target_transaction_type ?? ""} onChange={e => setForm({ ...form, target_transaction_type: (e.target.value || null) as ClassificationRule["target_transaction_type"] })}><option value="">Non modificare</option>{transactionTypes.map(v => <option key={v}>{v}</option>)}</select></label><label className="field">Categoria<select value={form.target_category_id ?? ""} onChange={e => setForm({ ...form, target_category_id: e.target.value || null })}><option value="">Non modificare</option>{categories.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label><label className="field">Merchant canonico<input value={form.target_merchant ?? ""} onChange={e => setForm({ ...form, target_merchant: e.target.value || null })}/></label><label className="field">Priorità<input type="number" value={form.priority} onChange={e => setForm({ ...form, priority: Number(e.target.value) })}/></label><label className="check"><input type="checkbox" checked={form.is_active} onChange={e => setForm({ ...form, is_active: e.target.checked })}/> Attiva</label></div>
    <button className="primary" disabled={!form.name.trim() || !form.pattern.trim()} onClick={() => void save()}>{form.id ? "Aggiorna regola" : "Crea regola"}</button>{form.id && <button className="ghost" onClick={() => setForm(blankRule())}>Annulla</button>}
    <div className="ledgerTable mt">{rules.map(rule => <div className="ledgerRow" key={rule.id}><span><b>{rule.name}</b><small>{rule.match_field} {rule.match_operator} “{rule.pattern}”</small></span><span>Priorità {rule.priority}</span><span>{rule.target_transaction_type ?? "tipo invariato"}</span><span>{rule.is_active ? "Attiva" : "Disattiva"}</span><span><button className="ghost" onClick={() => setForm(rule)}>Modifica</button><button className="ghost" onClick={() => void toggle(rule)}>{rule.is_active ? "Disattiva" : "Attiva"}</button><button className="iconBtn" onClick={() => void remove(rule)}>Elimina</button></span></div>)}</div>
  </div>;
}
