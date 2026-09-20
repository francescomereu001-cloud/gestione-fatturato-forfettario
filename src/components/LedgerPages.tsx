import { useCallback, useEffect, useMemo, useState } from "react";
import { Plus, Save, Trash2 } from "lucide-react";
import type { SupabaseClient } from "@supabase/supabase-js";
import { accountBalance, totalLiquidity } from "../domain/accounts/calculations";
import { cashflowSummary } from "../domain/transactions/calculations";
import { accountPayload, internalTransferPayloads, loadLedger, transactionPayload } from "../services/ledger";
import { accountTypes, reconciliationStatuses, transactionTypes, type Account, type LedgerTransaction, type TransactionCategory } from "../types/ledger";

const euro = (value: number) => new Intl.NumberFormat("it-IT", { style: "currency", currency: "EUR" }).format(value);
const blankAccount = (): Account => ({ name: "", institution: "", account_type: "checking", currency: "EUR", opening_balance: 0, is_active: true, include_in_liquidity: true, notes: "" });
const blankTransaction = (): LedgerTransaction => ({ account_id: "", transaction_date: new Date().toISOString().slice(0, 10), amount: 0, description: "", category_id: null, transaction_type: "expense", source: "manual", reconciliation_status: "pending" });

function useLedger(client: SupabaseClient, userId: string) {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [transactions, setTransactions] = useState<LedgerTransaction[]>([]);
  const [categories, setCategories] = useState<TransactionCategory[]>([]);
  const [error, setError] = useState("");
  const reload = useCallback(async () => {
    try { const data = await loadLedger(client, userId); setAccounts(data.accounts); setTransactions(data.transactions); setCategories(data.categories as TransactionCategory[]); setError(""); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Errore caricamento contabilità."); }
  }, [client, userId]);
  useEffect(() => {
    // The async loader synchronizes this view with the authenticated Supabase ledger.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void reload();
  }, [reload]);
  return { accounts, transactions, categories, error, reload };
}

export function AccountsPage({ client, userId }: { client: SupabaseClient; userId: string }) {
  const ledger = useLedger(client, userId);
  const [form, setForm] = useState<Account>(blankAccount());
  const save = async () => {
    const payload = accountPayload(form, userId);
    const query = form.id ? client.from("accounts").update(payload).eq("id", form.id).eq("user_id", userId) : client.from("accounts").insert(payload);
    const { error } = await query; if (!error) { setForm(blankAccount()); await ledger.reload(); }
  };
  const deactivate = async (account: Account) => { await client.from("accounts").update({ is_active: false }).eq("id", account.id).eq("user_id", userId); await ledger.reload(); };
  return <section className="panel"><h3>Accounts</h3><p className="muted">Liquidità totale calcolata: <strong>{euro(totalLiquidity(ledger.accounts, ledger.transactions))}</strong></p>{ledger.error && <div className="notice">{ledger.error}</div>}
    <div className="formGrid compact"><label className="field">Nome<input value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} /></label><label className="field">Istituto<input value={form.institution ?? ""} onChange={e => setForm({ ...form, institution: e.target.value })} /></label><label className="field">Tipo<select value={form.account_type} onChange={e => setForm({ ...form, account_type: e.target.value as Account["account_type"] })}>{accountTypes.map(type => <option key={type}>{type}</option>)}</select></label><label className="field">Saldo iniziale<input type="number" value={form.opening_balance} onChange={e => setForm({ ...form, opening_balance: Number(e.target.value) })} /></label><label className="check"><input type="checkbox" checked={form.include_in_liquidity} onChange={e => setForm({ ...form, include_in_liquidity: e.target.checked })} /> Include in liquidità</label></div>
    <button className="primary" onClick={save}><Save size={18} />{form.id ? "Aggiorna" : "Crea conto"}</button>
    <div className="ledgerTable mt">{ledger.accounts.map(account => <div className="ledgerRow" key={account.id}><span><b>{account.name}</b><small>{account.institution || "—"}</small></span><span>{account.account_type}</span><span>{euro(accountBalance(account, ledger.transactions))}</span><span>{account.include_in_liquidity ? "Inclusa" : "Esclusa"}</span><span><button className="ghost" onClick={() => setForm(account)}>Modifica</button> {account.is_active && <button className="iconBtn" title="Disattiva" onClick={() => deactivate(account)}><Trash2 size={16}/></button>}</span></div>)}</div>
  </section>;
}

export function TransactionsPage({ client, userId }: { client: SupabaseClient; userId: string }) {
  const ledger = useLedger(client, userId); const [form, setForm] = useState<LedgerTransaction>(blankTransaction()); const [accountFilter, setAccountFilter] = useState(""); const [typeFilter, setTypeFilter] = useState("");
  const shown = useMemo(() => ledger.transactions.filter(item => (!accountFilter || item.account_id === accountFilter) && (!typeFilter || item.transaction_type === typeFilter)), [ledger.transactions, accountFilter, typeFilter]);
  const summary = cashflowSummary(shown);
  const save = async () => { const payload = transactionPayload(form, userId); const query = form.id ? client.from("transactions").update(payload).eq("id", form.id).eq("user_id", userId) : client.from("transactions").insert(form.transaction_type === "internal_transfer" ? internalTransferPayloads(form, userId) : payload); const { error } = await query; if (!error) { setForm(blankTransaction()); await ledger.reload(); } };
  const remove = async (item: LedgerTransaction) => { if (!item.id) return; const query = client.from("transactions").delete().eq("user_id", userId); if (item.transfer_group_id) query.eq("transfer_group_id", item.transfer_group_id); else query.eq("id", item.id); await query; await ledger.reload(); };
  return <section className="panel"><h3>Transactions</h3><div className="cards mini"><div className="card"><p>Entrate</p><h2>{euro(summary.income)}</h2></div><div className="card"><p>Uscite economiche</p><h2>{euro(summary.expenses)}</h2></div><div className="card"><p>Cashflow</p><h2>{euro(summary.cashflow)}</h2></div></div>{ledger.error && <div className="notice">{ledger.error}</div>}
    <div className="formGrid"><label className="field">Data<input type="date" value={form.transaction_date} onChange={e => setForm({ ...form, transaction_date: e.target.value })}/></label><label className="field">Conto<select value={form.account_id} onChange={e => setForm({ ...form, account_id: e.target.value })}><option value="">Seleziona</option>{ledger.accounts.map(a => <option value={a.id} key={a.id}>{a.name}</option>)}</select></label><label className="field">Descrizione<input value={form.description} onChange={e => setForm({ ...form, description: e.target.value })}/></label><label className="field">Importo (+ entrata, − uscita)<input type="number" value={form.amount} onChange={e => setForm({ ...form, amount: Number(e.target.value) })}/></label><label className="field">Tipo<select value={form.transaction_type} onChange={e => setForm({ ...form, transaction_type: e.target.value as LedgerTransaction["transaction_type"] })}>{transactionTypes.map(type => <option key={type}>{type}</option>)}</select></label>{form.transaction_type === "internal_transfer" && <label className="field">Conto destinazione<select value={form.transfer_account_id ?? ""} onChange={e => setForm({ ...form, transfer_account_id: e.target.value || null })}><option value="">Seleziona</option>{ledger.accounts.filter(a => a.id !== form.account_id).map(a => <option value={a.id} key={a.id}>{a.name}</option>)}</select></label>}<label className="field">Categoria<select value={form.category_id ?? ""} onChange={e => setForm({ ...form, category_id: e.target.value || null })}><option value="">Nessuna</option>{ledger.categories.map(c => <option value={c.id} key={c.id}>{c.name}</option>)}</select></label><label className="field">Riconciliazione<select value={form.reconciliation_status} onChange={e => setForm({ ...form, reconciliation_status: e.target.value as LedgerTransaction["reconciliation_status"] })}>{reconciliationStatuses.map(s => <option key={s}>{s}</option>)}</select></label></div><button className="primary" disabled={!form.account_id || !form.description || (form.transaction_type === "internal_transfer" && !form.transfer_account_id)} onClick={save}><Plus size={18}/>{form.id ? "Aggiorna" : "Registra"}</button>
    <div className="filterBar mt"><select value={accountFilter} onChange={e => setAccountFilter(e.target.value)}><option value="">Tutti i conti</option>{ledger.accounts.map(a => <option value={a.id} key={a.id}>{a.name}</option>)}</select><select value={typeFilter} onChange={e => setTypeFilter(e.target.value)}><option value="">Tutti i tipi</option>{transactionTypes.map(type => <option key={type}>{type}</option>)}</select></div>
    <div className="ledgerTable">{shown.map(item => <div className="ledgerRow transaction" key={item.id}><span>{item.transaction_date}</span><span><b>{item.description}</b><small>{ledger.accounts.find(a => a.id === item.account_id)?.name}</small></span><span>{item.transaction_type}</span><span>{euro(Number(item.amount))}</span><span>{item.reconciliation_status}</span><span>{!item.transfer_group_id && <button className="ghost" onClick={() => setForm(item)}>Modifica</button>} <button className="iconBtn" onClick={() => remove(item)}><Trash2 size={16}/></button></span></div>)}</div>
  </section>;
}
