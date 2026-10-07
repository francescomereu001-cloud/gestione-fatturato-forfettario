import { useCallback, useEffect, useMemo, useState } from "react";
import { Plus, Save, Trash2, Landmark } from "lucide-react";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  accountBalance,
  totalLiquidity,
} from "../domain/accounts/calculations";
import { filterTransactionsByPeriod, transactionPeriod, unclassifiedCount, type PeriodPreset } from "../domain/transactions/dates";
import { cashflowSummary } from "../domain/transactions/calculations";
import {
  accountPayload,
  internalTransferPayloads,
  loadLedger,
  transactionPayload,
} from "../services/ledger";
import {
  possibleTransfer,
  transferTypeForAccounts,
} from "../services/bankImports";
import {
  classifyTransactions,
  normalizeMatchText,
} from "../services/classification";
import type { ClassificationRule } from "../types/classification";
import { PageHeader } from "./layout/PageHeader";
import { Badge } from "./ui/Badge";
import { EmptyState } from "./ui/EmptyState";
import { StatCard } from "./ui/StatCard";
import {
  accountTypeLabels,
  classificationLabels,
  reconciliationLabels,
  transactionTypeLabels,
  money,
} from "./ui/labels";
import { ClassificationRules } from "./ClassificationRules";
import {
  accountTypes,
  reconciliationStatuses,
  transactionTypes,
  type Account,
  type LedgerTransaction,
  type TransactionCategory,
} from "../types/ledger";

const euro = (value: number) =>
  new Intl.NumberFormat("it-IT", { style: "currency", currency: "EUR" }).format(
    value,
  );
const blankAccount = (): Account => ({
  name: "",
  institution: "",
  account_type: "checking",
  currency: "EUR",
  opening_balance: 0,
  balance_as_of: null,
  is_active: true,
  include_in_liquidity: true,
  notes: "",
});
const blankTransaction = (): LedgerTransaction => ({
  account_id: "",
  transaction_date: new Date().toISOString().slice(0, 10),
  amount: 0,
  description: "",
  category_id: null,
  transaction_type: "expense",
  source: "manual",
  reconciliation_status: "pending",
});

function useLedger(client: SupabaseClient, userId: string) {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [transactions, setTransactions] = useState<LedgerTransaction[]>([]);
  const [categories, setCategories] = useState<TransactionCategory[]>([]);
  const [error, setError] = useState("");
  const reload = useCallback(async () => {
    try {
      const data = await loadLedger(client, userId);
      setAccounts(data.accounts);
      setTransactions(data.transactions);
      setCategories(data.categories as TransactionCategory[]);
      setError("");
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "Errore caricamento contabilità.",
      );
    }
  }, [client, userId]);
  useEffect(() => {
    // The async loader synchronizes this view with the authenticated Supabase ledger.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void reload();
  }, [reload]);
  return { accounts, transactions, categories, error, reload };
}

export function AccountsPage({
  client,
  userId,
}: {
  client: SupabaseClient;
  userId: string;
}) {
  const ledger = useLedger(client, userId);
  const [form, setForm] = useState<Account>(blankAccount());
  const save = async () => {
    const payload = accountPayload(form, userId);
    const query = form.id
      ? client
          .from("accounts")
          .update(payload)
          .eq("id", form.id)
          .eq("user_id", userId)
      : client.from("accounts").insert(payload);
    const { error } = await query;
    if (!error) {
      setForm(blankAccount());
      await ledger.reload();
    }
  };
  const deactivate = async (account: Account) => {
    await client
      .from("accounts")
      .update({ is_active: false })
      .eq("id", account.id)
      .eq("user_id", userId);
    await ledger.reload();
  };
  return (
    <section className="pageStack">
      <PageHeader
        title="Conti"
        eyebrow="Il tuo denaro"
        description="I tuoi conti, le carte e i saldi di riferimento."
      />
      <div className="cards mini">
        <StatCard
          icon={<Landmark />}
          title="Liquidità totale calcolata"
          value={euro(totalLiquidity(ledger.accounts, ledger.transactions))}
        />
      </div>
      {ledger.error && (
        <div className="notice" role="alert">
          {ledger.error}
        </div>
      )}
      <div className="accountsList">
        {ledger.accounts.length === 0 ? (
          <div className="panel">
            <EmptyState
              title="Il tuo primo conto"
              description="Aggiungi un conto per iniziare a organizzare i tuoi movimenti."
            />
          </div>
        ) : (
          ledger.accounts.map((account) => (
            <div className="card accountRow" key={account.id}>
              <div className="accountIdentity">
                <span className="accountIcon" aria-hidden="true">
                  <Landmark size={22} />
                </span>
                <div>
                  <p className="accountName">{account.name}</p>
                  <p className="muted">
                    {account.institution || "Istituto non indicato"}
                  </p>
                  <div className="accountMetadata">
                    <Badge>{accountTypeLabels[account.account_type]}</Badge>
                    <Badge variant={account.is_active ? "success" : "neutral"}>
                      {account.is_active ? "Attivo" : "Disattivato"}
                    </Badge>
                  </div>
                </div>
              </div>
              <div>
                <p className="accountBalance amount">
                  {euro(accountBalance(account, ledger.transactions))}
                </p>
                <p className="accountAnchor">
                  {account.balance_as_of
                    ? `Saldo di riferimento al ${account.balance_as_of}`
                    : "Data saldo da indicare"}
                </p>
                <p className="accountMetadata">
                  {account.include_in_liquidity
                    ? "Incluso nella liquidità"
                    : "Escluso dalla liquidità"}
                </p>
              </div>
              <div className="rowActions">
                <button className="secondary" onClick={() => setForm(account)}>
                  Modifica
                </button>
                {account.is_active && (
                  <button
                    className="iconBtn"
                    aria-label={`Disattiva ${account.name}`}
                    title="Disattiva"
                    onClick={() => deactivate(account)}
                  >
                    <Trash2 size={16} />
                  </button>
                )}
              </div>
            </div>
          ))
        )}
      </div>
      <details className="panel accountForm" open={Boolean(form.id)}>
        <summary>{form.id ? "Modifica conto" : "Aggiungi un conto"}</summary>
        <div className="mt">
          <div className="formGrid compact">
            <label className="field">
              Nome
              <input
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
              />
            </label>
            <label className="field">
              Istituto
              <input
                value={form.institution ?? ""}
                onChange={(e) =>
                  setForm({ ...form, institution: e.target.value })
                }
              />
            </label>
            <label className="field">
              Tipo
              <select
                value={form.account_type}
                onChange={(e) => {
                  const account_type = e.target
                    .value as Account["account_type"];
                  setForm({
                    ...form,
                    account_type,
                    include_in_liquidity:
                      account_type === "credit_card"
                        ? false
                        : form.include_in_liquidity,
                  });
                }}
              >
                {accountTypes.map((type) => (
                  <option key={type} value={type}>
                    {accountTypeLabels[type]}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              Saldo iniziale di riferimento
              <input
                type="number"
                value={form.opening_balance}
                onChange={(e) =>
                  setForm({ ...form, opening_balance: Number(e.target.value) })
                }
              />
            </label>
            <label className="field">
              Saldo alla chiusura del
              <input
                type="date"
                value={form.balance_as_of ?? ""}
                onChange={(e) =>
                  setForm({ ...form, balance_as_of: e.target.value || null })
                }
              />
            </label>
            <label className="check">
              <input
                type="checkbox"
                checked={form.include_in_liquidity}
                onChange={(e) =>
                  setForm({ ...form, include_in_liquidity: e.target.checked })
                }
              />{" "}
              Include in liquidità
            </label>
          </div>
          <button className="primary" onClick={save}>
            <Save size={18} />
            {form.id ? "Aggiorna" : "Crea conto"}
          </button>
        </div>
      </details>
    </section>
  );
}

export function TransactionsPage({
  client,
  userId,
}: {
  client: SupabaseClient;
  userId: string;
}) {
  const ledger = useLedger(client, userId);
  const [form, setForm] = useState<LedgerTransaction>(blankTransaction());
  const [accountFilter, setAccountFilter] = useState("");
  const [typeFilter, setTypeFilter] = useState("");
  const [classificationFilter, setClassificationFilter] = useState("");
  const [periodPreset, setPeriodPreset] = useState<PeriodPreset>("this_month");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const period = transactionPeriod(periodPreset, new Date(), dateFrom, dateTo);
  const { from, to, error: periodError } = period;
  const periodTransactions = useMemo(
    () => filterTransactionsByPeriod(ledger.transactions, { from, to, error: periodError }),
    [ledger.transactions, from, to, periodError],
  );
  const [message, setMessage] = useState("");
  const [saveAsRule, setSaveAsRule] = useState(false);
  const [suggestedRule, setSuggestedRule] = useState<ClassificationRule | null>(
    null,
  );
  const shown = useMemo(
    () =>
      periodTransactions.filter(
        (item) =>
          (!accountFilter || item.account_id === accountFilter) &&
          (!typeFilter || item.transaction_type === typeFilter) &&
          (!classificationFilter ||
            (classificationFilter === "unclassified" &&
              item.transaction_type === "unclassified") ||
            (classificationFilter === "automatic" &&
              ["provider_rule", "user_rule"].includes(
                item.classification_method ?? "",
              )) ||
            (classificationFilter === "manual" &&
              item.classification_method === "manual") ||
            (classificationFilter === "transfer" &&
              item.classification_method === "transfer_match")),
      ),
    [periodTransactions, accountFilter, typeFilter, classificationFilter],
  );
  const summary = cashflowSummary(shown);
  const residualCount = unclassifiedCount(periodTransactions.filter((item) => !accountFilter || item.account_id === accountFilter));
  const save = async () => {
    const payload = transactionPayload(form, userId);
    const query = form.id
      ? client
          .from("transactions")
          .update(payload)
          .eq("id", form.id)
          .eq("user_id", userId)
      : client
          .from("transactions")
          .insert(
            form.transaction_type === "internal_transfer"
              ? internalTransferPayloads(form, userId)
              : payload,
          );
    const { error } = await query;
    if (!error) {
      if (saveAsRule)
        setSuggestedRule({
          name: `Regola ${form.merchant || form.description}`,
          priority: 100,
          is_active: true,
          account_id: null,
          parser_key: null,
          match_field: "description",
          match_operator: "contains",
          pattern: normalizeMatchText(form.merchant || form.description),
          amount_direction: Number(form.amount) < 0 ? "debit" : "credit",
          target_transaction_type: form.transaction_type,
          target_category_id: form.category_id ?? null,
          target_transfer_account_id: [
            "internal_transfer",
            "investment_transfer",
          ].includes(form.transaction_type)
            ? (form.transfer_account_id ?? null)
            : null,
          target_merchant: form.merchant ?? null,
        });
      setSaveAsRule(false);
      setForm(blankTransaction());
      await ledger.reload();
    } else setMessage(error.message);
  };
  const remove = async (item: LedgerTransaction) => {
    if (!item.id) return;
    const query = client.from("transactions").delete().eq("user_id", userId);
    if (item.transfer_group_id)
      query.eq("transfer_group_id", item.transfer_group_id);
    else query.eq("id", item.id);
    await query;
    await ledger.reload();
  };
  const linkTransfer = async (
    item: LedgerTransaction,
    match: LedgerTransaction,
    targetType: "internal_transfer" | "investment_transfer",
  ) => {
    if (!item.id || !match.id) return;
    await client.rpc("link_transfer", {
      first_transaction_id: item.id,
      second_transaction_id: match.id,
      target_type: targetType,
    });
    await ledger.reload();
  };
  const runClassification = async () => {
    try {
      const result = await classifyTransactions(client);
      setMessage(
        `${result.classified_count} classificate · ${result.transfer_count} trasferimenti riconciliati · ${result.unclassified_count} ancora da verificare · ${result.categorized_count} categorizzate · ${result.uncategorized_count} senza categoria · ${result.total_transfer_count} trasferimenti totali`,
      );
      await ledger.reload();
    } catch (reason) {
      setMessage(
        reason instanceof Error
          ? reason.message
          : "Classificazione non completata.",
      );
    }
  };
  return (
    <section className="pageStack">
      <PageHeader
        title="Transazioni"
        eyebrow="Il tuo denaro"
        description="Ogni movimento, nel suo contesto."
        action={
          <button
            className="secondary"
            onClick={() => void runClassification()}
          >
            Classifica e riconcilia
          </button>
        }
      />
      {message && (
        <div className="notice" role="status">
          {message}
        </div>
      )}
      <div className="filterBar transactionFilters">
        <label className="field">
          Periodo
          <select value={periodPreset} onChange={(event) => setPeriodPreset(event.target.value as PeriodPreset)}>
            <option value="this_month">Questo mese</option>
            <option value="last_month">Mese scorso</option>
            <option value="this_year">Anno corrente</option>
            <option value="all">Tutto</option>
            <option value="custom">Personalizzato</option>
          </select>
        </label>
        {periodPreset === "custom" && <>
          <label className="field">Data da<input type="date" value={dateFrom} onChange={(event) => setDateFrom(event.target.value)} /></label>
          <label className="field">Data a<input type="date" value={dateTo} onChange={(event) => setDateTo(event.target.value)} /></label>
        </>}
      </div>
      {period.error && <div className="notice" role="alert">{period.error}</div>}
      <div className="cards mini">
        <StatCard title="Entrate del periodo" value={euro(summary.income)} />
        <StatCard title="Uscite del periodo" value={euro(summary.expenses)} />
        <StatCard title="Cashflow economico del periodo" value={euro(summary.cashflow)} />
      </div>
      <p>Entrate meno uscite economiche nel periodo selezionato. I trasferimenti tra tuoi conti non incidono sul cashflow.</p>
      {residualCount > 0 && <div className="notice" role="status">
        {residualCount} movimenti del periodo devono ancora essere classificati. Il cashflow economico potrebbe essere incompleto.
      </div>}
      {ledger.error && (
        <div className="notice" role="alert">
          {ledger.error}
        </div>
      )}
      <details className="panel transactionForm" open={Boolean(form.id)}>
        <summary>
          {form.id ? "Modifica movimento" : "Registra un movimento"}
        </summary>
        <div className="mt">
          <div className="formGrid">
            <label className="field">
              Data
              <input
                type="date"
                value={form.transaction_date}
                onChange={(e) =>
                  setForm({ ...form, transaction_date: e.target.value })
                }
              />
            </label>
            <label className="field">
              Conto
              <select
                value={form.account_id}
                onChange={(e) =>
                  setForm({ ...form, account_id: e.target.value })
                }
              >
                <option value="">Seleziona</option>
                {ledger.accounts.map((a) => (
                  <option value={a.id} key={a.id}>
                    {a.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              Descrizione
              <input
                value={form.description}
                onChange={(e) =>
                  setForm({ ...form, description: e.target.value })
                }
              />
            </label>
            <label className="field">
              Merchant
              <input
                value={form.merchant ?? ""}
                onChange={(e) =>
                  setForm({ ...form, merchant: e.target.value || null })
                }
              />
            </label>
            <label className="field">
              Importo (+ entrata, − uscita)
              <input
                type="number"
                value={form.amount}
                onChange={(e) =>
                  setForm({ ...form, amount: Number(e.target.value) })
                }
              />
            </label>
            <label className="field">
              Tipo
              <select
                value={form.transaction_type}
                onChange={(e) =>
                  setForm({
                    ...form,
                    transaction_type: e.target
                      .value as LedgerTransaction["transaction_type"],
                  })
                }
              >
                {transactionTypes.map((type) => (
                  <option key={type} value={type}>
                    {transactionTypeLabels[type]}
                  </option>
                ))}
              </select>
            </label>
            {form.transaction_type === "internal_transfer" && (
              <label className="field">
                Conto destinazione
                <select
                  value={form.transfer_account_id ?? ""}
                  onChange={(e) =>
                    setForm({
                      ...form,
                      transfer_account_id: e.target.value || null,
                    })
                  }
                >
                  <option value="">Seleziona</option>
                  {ledger.accounts
                    .filter((a) => a.id !== form.account_id)
                    .map((a) => (
                      <option value={a.id} key={a.id}>
                        {a.name}
                      </option>
                    ))}
                </select>
              </label>
            )}
            <label className="field">
              Categoria
              <select
                value={form.category_id ?? ""}
                onChange={(e) =>
                  setForm({ ...form, category_id: e.target.value || null })
                }
              >
                <option value="">Nessuna</option>
                {ledger.categories.map((c) => (
                  <option value={c.id} key={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              Riconciliazione
              <select
                value={form.reconciliation_status}
                onChange={(e) =>
                  setForm({
                    ...form,
                    reconciliation_status: e.target
                      .value as LedgerTransaction["reconciliation_status"],
                  })
                }
              >
                {reconciliationStatuses.map((v) => (
                  <option key={v} value={v}>
                    {reconciliationLabels[v]}
                  </option>
                ))}
              </select>
            </label>
            {form.id && (
              <label className="check">
                <input
                  type="checkbox"
                  checked={saveAsRule}
                  onChange={(e) => setSaveAsRule(e.target.checked)}
                />{" "}
                Salva anche come regola (da confermare)
              </label>
            )}
          </div>
          <button
            className="primary"
            disabled={
              !form.account_id ||
              !form.description ||
              (form.transaction_type === "internal_transfer" &&
                !form.transfer_account_id)
            }
            onClick={() => void save()}
          >
            <Plus size={18} />
            {form.id ? "Aggiorna" : "Registra"}
          </button>
        </div>
      </details>
      <div className="panel">
        <div className="filterBar transactionFilters">
          <label className="field">
            Conto
            <select
              value={accountFilter}
              onChange={(e) => setAccountFilter(e.target.value)}
            >
              <option value="">Tutti i conti</option>
              {ledger.accounts.map((a) => (
                <option value={a.id} key={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            Tipo di movimento
            <select
              value={typeFilter}
              onChange={(e) => setTypeFilter(e.target.value)}
            >
              <option value="">Tutti i tipi</option>
              {transactionTypes.map((type) => (
                <option key={type} value={type}>
                  {transactionTypeLabels[type]}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            Classificazione
            <select
              value={classificationFilter}
              onChange={(e) => setClassificationFilter(e.target.value)}
            >
              <option value="">Tutte le classificazioni</option>
              <option value="unclassified">Non classificati</option>
              <option value="automatic">Automatici</option>
              <option value="manual">Manuali</option>
              <option value="transfer">Trasferimenti</option>
            </select>
          </label>
        </div>
        {shown.length === 0 ? (
          <EmptyState
            title="Nessun movimento da mostrare"
            description="Prova altri filtri o importa il tuo estratto conto."
          />
        ) : (
          <div
            className="ledgerTable"
            tabIndex={0}
            role="region"
            aria-label="Elenco transazioni"
          >
            <table className="transactionTable">
              <thead>
                <tr>
                  {[
                    "Data",
                    "Descrizione",
                    "Conto",
                    "Categoria",
                    "Tipo",
                    "Importo",
                    "Stato",
                    "Azioni",
                  ].map((column) => (
                    <th scope="col" key={column}>
                      {column}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {shown.map((item) => {
                  const matches =
                    item.transaction_type === "unclassified"
                      ? possibleTransfer(item, ledger.transactions)
                      : [];
                  const match = matches.length === 1 ? matches[0] : null;
                  const sourceType = ledger.accounts.find(
                    (account) => account.id === item.account_id,
                  )?.account_type;
                  const destinationType = match
                    ? ledger.accounts.find(
                        (account) => account.id === match.account_id,
                      )?.account_type
                    : undefined;
                  const targetType =
                    sourceType && destinationType
                      ? transferTypeForAccounts(sourceType, destinationType)
                      : "internal_transfer";
                  return (
                    <tr key={item.id}>
                      <td>{item.transaction_date}</td>
                      <td className="descriptionCell">
                        <strong>{item.description}</strong>
                        <small>
                          {item.merchant || "Controparte non indicata"}
                        </small>
                        {match && (
                          <small>
                            Possibile trasferimento:{" "}
                            {
                              ledger.accounts.find(
                                (a) => a.id === match.account_id,
                              )?.name
                            }
                          </small>
                        )}
                      </td>
                      <td>
                        {
                          ledger.accounts.find((a) => a.id === item.account_id)
                            ?.name
                        }
                      </td>
                      <td>
                        {ledger.categories.find(
                          (c) => c.id === item.category_id,
                        )?.name || "Nessuna categoria"}
                      </td>
                      <td>
                        <Badge
                          variant={
                            item.transaction_type === "unclassified"
                              ? "warning"
                              : "neutral"
                          }
                        >
                          {transactionTypeLabels[item.transaction_type]}
                        </Badge>
                      </td>
                      <td
                        className={`amountCell amount ${["internal_transfer", "investment_transfer"].includes(item.transaction_type) ? "muted" : item.transaction_type === "income" || item.transaction_type === "refund" ? "text-success" : item.transaction_type === "expense" || item.transaction_type === "debt_interest" ? "text-danger" : ""}`}
                      >
                        {money(Number(item.amount), "EUR", true)}
                      </td>
                      <td>
                        <Badge
                          variant={
                            item.reconciliation_status === "confirmed"
                              ? "success"
                              : item.reconciliation_status === "pending"
                                ? "warning"
                                : "neutral"
                          }
                        >
                          {reconciliationLabels[item.reconciliation_status]}
                        </Badge>
                        <small>
                          {item.classification_method
                            ? classificationLabels[item.classification_method]
                            : "Non classificata"}
                        </small>
                      </td>
                      <td>
                        <div className="rowActions">
                          {match && (
                            <button
                              className="ghost"
                              onClick={() =>
                                void linkTransfer(item, match, targetType)
                              }
                            >
                              {targetType === "investment_transfer"
                                ? "Conferma investimento"
                                : "Conferma giroconto"}
                            </button>
                          )}
                          {!item.transfer_group_id && (
                            <button
                              className="ghost"
                              onClick={() => setForm(item)}
                            >
                              Modifica
                            </button>
                          )}
                          <button
                            className="iconBtn"
                            aria-label={`Elimina movimento ${item.description}`}
                            onClick={() => void remove(item)}
                          >
                            <Trash2 size={16} />
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
      <div className="panel">
        <ClassificationRules
          client={client}
          userId={userId}
          accounts={ledger.accounts}
          categories={ledger.categories}
          suggested={suggestedRule}
          onSuggestionHandled={() => setSuggestedRule(null)}
        />
      </div>
    </section>
  );
}
