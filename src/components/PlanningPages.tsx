import { useCallback, useEffect, useState, type ReactNode } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  bootstrapFunds,
  loadFunds,
  loadGoals,
  loadPlanningConfig,
  loadSafeToSpend,
  moveFund,
  saveCommitment,
  saveFund,
  saveGoal,
  savePlanningSettings,
} from "../services/planning";
import type {
  Commitment,
  Fund,
  Goal,
  PlanningSettings,
  SafeToSpend,
} from "../types/planning";
import { fiscalMoney } from "./ui/fiscalLabels";
import { StatCard } from "./ui/StatCard";
import { PageHeader } from "./layout/PageHeader";
const statuses: Record<string, string> = {
  active: "Attivo",
  paused: "In pausa",
  achieved: "Raggiunto",
  cancelled: "Annullato",
  completed: "Completato",
  skipped: "Saltato",
  confirmed: "Confermato",
  estimated: "Stimato",
  incomplete: "Dati incompleti",
};
const missingLabels: Record<string, string> = {
  tax_projection:
    "Completa la configurazione e la verifica fiscale nella pagina Fiscale.",
  commitments_verified_through:
    "Verifica gli impegni fino alla fine dell’orizzonte.",
  liquidity_currency:
    "Sono presenti conti in valute non supportate: verifica la liquidità.",
};
function explanation(key: string) {
  return (
    missingLabels[key] ??
    (key.startsWith("account_anchor_after_as_of:")
      ? "Il saldo iniziale di un conto è successivo alla data richiesta."
      : `Dato fiscale da verificare: ${key.replaceAll("_", " ")}`)
  );
}
function errorText(error: unknown) {
  return error instanceof Error
    ? error.message
    : typeof error === "object" && error && "message" in error
      ? String(error.message)
      : "Operazione non riuscita. Riprova.";
}
function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="field">
      {label}
      {children}
    </label>
  );
}
const optionalAmount = (value: string) => (value === "" ? null : Number(value));
export function SafeToSpendPanel({
  summary,
  error = "",
  loading = false,
}: {
  summary: SafeToSpend | null;
  error?: string;
  loading?: boolean;
}) {
  const ready =
    summary &&
    summary.status !== "incomplete" &&
    summary.safe_to_spend !== null;
  return (
    <section className="panel safeToSpendPanel" aria-label="Safe to Spend">
      <div className="safeToSpendHeader">
        <div>
          <p className="eyebrow">Pianificazione della liquidità</p>
          <h2>Safe to Spend</h2>
        </div>
        <span>
          {summary
            ? statuses[summary.status]
            : loading
              ? "Caricamento"
              : "Non disponibile"}
        </span>
      </div>
      <p>
        Disponibile da spendere senza utilizzare denaro già destinato ad altri
        scopi
      </p>
      <p className="safeToSpendValue">
        {ready
          ? fiscalMoney(summary.safe_to_spend)
          : "Safe to Spend non disponibile"}
      </p>
      {error && <p role="alert">{error}</p>}
      {summary && (
        <>
          <p>
            Fotografia al {summary.as_of} · Orizzonte fino al{" "}
            {summary.horizon_end}
          </p>
          {!ready && (
            <ul>
              {summary.missing_fields.map((key, index) => (
                <li key={`${key}:${index}`}>{explanation(key)}</li>
              ))}
            </ul>
          )}
          {summary.funds_overallocated && (
            <p className="planningWarning" role="alert">
              Fondi sovra-allocati:{" "}
              {fiscalMoney(summary.funds_overallocation_amount)} oltre la
              liquidità disponibile. Libera o rivedi le allocazioni.
            </p>
          )}
          {(summary.funding_shortfall ?? 0) > 0 && (
            <p role="alert">
              Fabbisogno non coperto: {fiscalMoney(summary.funding_shortfall)}
            </p>
          )}
          <dl className="planningBreakdown">
            <dt>Liquidità totale</dt>
            <dd>{fiscalMoney(summary.total_liquidity)}</dd>
            <dt>− Fondi già riservati</dt>
            <dd>{fiscalMoney(summary.reserved_funds_total)}</dd>
            <dt>Liquidità libera prima degli obblighi</dt>
            <dd>{fiscalMoney(summary.free_liquidity)}</dd>
            <dt>− Gap fiscale</dt>
            <dd>{fiscalMoney(summary.tax_reserve_gap)}</dd>
            <dt>− Impegni essenziali fino a fine periodo</dt>
            <dd>{fiscalMoney(summary.upcoming_essential_commitments)}</dd>
            <dt>− Altri impegni fino a fine periodo</dt>
            <dd>{fiscalMoney(summary.upcoming_other_commitments)}</dd>
            <dt>− Contributi programmati ancora mancanti</dt>
            <dd>{fiscalMoney(summary.total_planned_contributions)}</dd>
            <dt>Risultato prima del limite a zero</dt>
            <dd>{fiscalMoney(summary.safe_to_spend_raw)}</dd>
            <dt>= Safe to Spend</dt>
            <dd>
              {ready ? fiscalMoney(summary.safe_to_spend) : "Non disponibile"}
            </dd>
          </dl>
          <p className="muted">
            Il dato riflette le configurazioni verificate nell’orizzonte; altre
            spese possono emergere. La Tax Reserve segue il motore fiscale
            dell’anno della fotografia.
          </p>
          {summary.warnings.length > 0 && (
            <details>
              <summary>Avvertenze del calcolo</summary>
              <ul>
                {summary.warnings.map((warning, i) => (
                  <li key={i}>
                    {warning === "funds_overallocated"
                      ? "Allocazioni superiori alla liquidità."
                      : warning.replaceAll("_", " ")}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </>
      )}
    </section>
  );
}
export function PlanningOverview({
  client,
  userId,
  refreshKey = 0,
}: {
  client: SupabaseClient;
  userId: string;
  refreshKey?: number;
}) {
  const [summary, setSummary] = useState<SafeToSpend | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let cancelled = false;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLoading(true);
    setSummary(null);
    setError("");
    loadSafeToSpend(client)
      .then((data) => {
        if (!cancelled) setSummary(data);
      })
      .catch(() => {
        if (!cancelled)
          setError(
            "Calcolo non disponibile. Aggiorna i dati o verifica la disponibilità del servizio.",
          );
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [client, userId, refreshKey, revision]);
  return (
    <>
      <SafeToSpendPanel summary={summary} error={error} loading={loading} />
      <section className="cards planningKpis">
        <StatCard
          title="Liquidità totale"
          value={fiscalMoney(summary?.total_liquidity)}
        />
        <StatCard
          title="Liquidità libera"
          value={fiscalMoney(summary?.free_liquidity)}
        />
        <StatCard
          title="Tax Reserve"
          value={fiscalMoney(summary?.required_tax_reserve)}
        />
        <StatCard
          title="Fondo Emergenza"
          value={fiscalMoney(summary?.emergency_fund_balance)}
        />
        <StatCard
          title="Fondo Casa"
          value={fiscalMoney(summary?.house_fund_balance)}
        />
      </section>
      {summary?.emergency_coverage_months !== null &&
        summary?.emergency_coverage_months !== undefined && (
          <p>
            Copertura emergenza: {summary.emergency_coverage_months} mesi
            rispetto al target essenziale inserito.
          </p>
        )}
      <PlanningConfiguration
        client={client}
        userId={userId}
        onSaved={() => setRevision((r) => r + 1)}
      />
    </>
  );
}
export function FundsPage({
  client,
  userId,
}: {
  client: SupabaseClient;
  userId: string;
}) {
  const [funds, setFunds] = useState<Fund[]>([]);
  const [summary, setSummary] = useState<SafeToSpend | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(true);
  const [editor, setEditor] = useState<Fund | null>(null);
  const [movement, setMovement] = useState<{
    fund: Fund;
    action: "allocate" | "release" | "transfer";
  } | null>(null);
  const [amount, setAmount] = useState("");
  const [destination, setDestination] = useState("");
  const [note, setNote] = useState("");
  const load = useCallback(async () => {
    setBusy(true);
    setError("");
    try {
      await bootstrapFunds(client);
      const [f, s] = await Promise.all([
        loadFunds(client),
        loadSafeToSpend(client),
      ]);
      setFunds(f);
      setSummary(s);
    } catch (e) {
      setError(errorText(e));
      setSummary(null);
    } finally {
      setBusy(false);
    }
  }, [client]);
  useEffect(() => {
    // Load the authenticated server snapshot on mount.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);
  async function perform(task: () => Promise<unknown>) {
    setBusy(true);
    setError("");
    try {
      await task();
      setEditor(null);
      setMovement(null);
      await load();
    } catch (e) {
      setError(errorText(e));
      setBusy(false);
    }
  }
  return (
    <>
      <PageHeader
        title="Fondi"
        eyebrow="Pianificazione"
        description="I fondi sono allocazioni virtuali della tua liquidità. Non spostano denaro tra conti bancari."
      />
      {error && <p role="alert">{error}</p>}
      <section className="cards">
        <StatCard
          title="Liquidità totale"
          value={fiscalMoney(summary?.total_liquidity)}
        />
        <StatCard
          title="Totale allocato"
          value={fiscalMoney(summary?.reserved_funds_total)}
        />
        <StatCard
          title="Liquidità libera"
          value={fiscalMoney(summary?.free_liquidity)}
        />
      </section>
      {summary?.funds_overallocated && (
        <p className="planningWarning" role="alert">
          Fondi sovra-allocati di{" "}
          {fiscalMoney(summary.funds_overallocation_amount)}. Nessun fondo è
          stato modificato automaticamente.
        </p>
      )}
      {busy && <p role="status">Aggiornamento fondi…</p>}
      <div className="planningGrid">
        {funds.map((fund) => (
          <section className="panel" key={fund.id}>
            <h2>
              {fund.name} {!fund.is_active && "(Inattivo)"}
            </h2>
            <p className="amount">{fiscalMoney(fund.balance)}</p>
            <dl className="planningBreakdown">
              <dt>Target</dt>
              <dd>{fiscalMoney(fund.target_amount)}</dd>
              <dt>Progresso</dt>
              <dd>
                {fund.progress_percentage === null
                  ? "Non configurato"
                  : `${fund.progress_percentage}%`}
              </dd>
              <dt>Data target</dt>
              <dd>{fund.target_date ?? "Non configurata"}</dd>
              <dt>Contributo mensile</dt>
              <dd>{fiscalMoney(fund.planned_monthly_contribution)}</dd>
              <dt>Gap del mese</dt>
              <dd>{fiscalMoney(fund.contribution_gap)}</dd>
            </dl>
            {fund.progress_percentage !== null && (
              <progress
                max="100"
                value={fund.progress_percentage}
                aria-label={`Progresso ${fund.name}`}
              />
            )}
            <div className="planningActions">
              {(["allocate", "release", "transfer"] as const).map((action) => (
                <button
                  className="secondary"
                  key={action}
                  disabled={busy || !fund.is_active}
                  onClick={() => {
                    setMovement({ fund, action });
                    setEditor(null);
                    setAmount("");
                    setNote("");
                    setDestination("");
                  }}
                >
                  {action === "allocate"
                    ? "Alloca"
                    : action === "release"
                      ? "Libera"
                      : "Sposta tra fondi"}
                </button>
              ))}
              <button
                className="secondary"
                disabled={busy}
                onClick={() => {
                  setEditor({ ...fund });
                  setMovement(null);
                }}
              >
                Modifica {fund.name}
              </button>
            </div>
          </section>
        ))}
      </div>
      {movement && (
        <form
          className="panel"
          onSubmit={(e) => {
            e.preventDefault();
            void perform(() =>
              moveFund(
                client,
                movement.action,
                movement.fund.id,
                Number(amount),
                destination,
                note,
              ),
            );
          }}
        >
          <h3>
            {movement.action === "allocate"
              ? "Alloca a"
              : movement.action === "release"
                ? "Libera da"
                : "Sposta da"}{" "}
            {movement.fund.name}
          </h3>
          <div className="formGrid">
            <Field label="Importo">
              <input
                required
                type="number"
                min="0.01"
                step="0.01"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
              />
            </Field>
            {movement.action === "transfer" && (
              <Field label="Fondo destinazione">
                <select
                  required
                  value={destination}
                  onChange={(e) => setDestination(e.target.value)}
                >
                  <option value="">Seleziona fondo</option>
                  {funds
                    .filter((f) => f.is_active && f.id !== movement.fund.id)
                    .map((f) => (
                      <option key={f.id} value={f.id}>
                        {f.name}
                      </option>
                    ))}
                </select>
              </Field>
            )}
            <Field label="Nota">
              <input value={note} onChange={(e) => setNote(e.target.value)} />
            </Field>
          </div>
          <button className="primary" disabled={busy}>
            Conferma movimento virtuale
          </button>
          <button
            className="secondary"
            type="button"
            onClick={() => setMovement(null)}
          >
            Annulla
          </button>
        </form>
      )}
      {editor && (
        <form
          className="panel"
          onSubmit={(e) => {
            e.preventDefault();
            void perform(() => saveFund(client, userId, editor));
          }}
        >
          <h3>Modifica fondo</h3>
          <div className="formGrid">
            <Field label="Nome fondo">
              <input
                required
                value={editor.name}
                onChange={(e) => setEditor({ ...editor, name: e.target.value })}
              />
            </Field>
            <Field label="Target importo">
              <input
                type="number"
                min="0.01"
                step="0.01"
                value={editor.target_amount ?? ""}
                onChange={(e) =>
                  setEditor({
                    ...editor,
                    target_amount: optionalAmount(e.target.value),
                  })
                }
              />
            </Field>
            <Field label="Data target">
              <input
                type="date"
                value={editor.target_date ?? ""}
                onChange={(e) =>
                  setEditor({ ...editor, target_date: e.target.value || null })
                }
              />
            </Field>
            <Field label="Contributo mensile programmato">
              <input
                disabled={editor.system_key === "tax"}
                type="number"
                min="0"
                step="0.01"
                value={editor.planned_monthly_contribution ?? ""}
                onChange={(e) =>
                  setEditor({
                    ...editor,
                    planned_monthly_contribution: optionalAmount(
                      e.target.value,
                    ),
                  })
                }
              />
            </Field>
            <Field label="Priorità">
              <input
                type="number"
                value={editor.priority}
                onChange={(e) =>
                  setEditor({ ...editor, priority: Number(e.target.value) })
                }
              />
            </Field>
            <Field label="Fondo attivo">
              <input
                type="checkbox"
                checked={editor.is_active}
                onChange={(e) =>
                  setEditor({ ...editor, is_active: e.target.checked })
                }
              />
            </Field>
          </div>
          {editor.system_key === "tax" && (
            <p>
              Il fondo fiscale usa il gap della Tax Reserve; non aggiunge un
              contributo mensile duplicato.
            </p>
          )}
          <button className="primary" disabled={busy}>
            Salva fondo
          </button>
          <button
            type="button"
            className="secondary"
            onClick={() => setEditor(null)}
          >
            Annulla
          </button>
        </form>
      )}
    </>
  );
}
const blankGoal: Goal = {
  name: "",
  goal_type: "custom",
  target_amount: 0,
  target_date: null,
  linked_fund_id: null,
  priority: 0,
  status: "active",
};
export function GoalsPage({
  client,
  userId,
}: {
  client: SupabaseClient;
  userId: string;
}) {
  const [goals, setGoals] = useState<Goal[]>([]);
  const [funds, setFunds] = useState<Fund[]>([]);
  const [editor, setEditor] = useState<Goal | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(true);
  const load = useCallback(async () => {
    setBusy(true);
    try {
      await bootstrapFunds(client);
      const [g, f] = await Promise.all([loadGoals(client), loadFunds(client)]);
      setGoals(g);
      setFunds(f);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }, [client]);
  useEffect(() => {
    // Load the authenticated server snapshot on mount.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);
  async function save(goal: Goal) {
    setBusy(true);
    setError("");
    try {
      await saveGoal(client, userId, goal);
      setEditor(null);
      await load();
    } catch (e) {
      setError(errorText(e));
      setBusy(false);
    }
  }
  return (
    <>
      <PageHeader
        title="Obiettivi"
        eyebrow="Pianificazione"
        description="Ogni obiettivo collegato usa il saldo del suo fondo. Il passo mensile è indicativo e non riduce da solo Safe to Spend."
        action={
          <button
            className="primary"
            disabled={busy}
            onClick={() => setEditor({ ...blankGoal })}
          >
            Nuovo obiettivo
          </button>
        }
      />
      {error && <p role="alert">{error}</p>}
      {busy && <p role="status">Aggiornamento obiettivi…</p>}
      {!busy && goals.length === 0 && (
        <p>Nessun obiettivo. Crea il primo e collegalo a un fondo.</p>
      )}
      <div className="planningGrid">
        {goals.map((goal) => (
          <section className="panel" key={goal.id}>
            <h2>{goal.name}</h2>
            <p>
              {statuses[goal.status]} · Fondo:{" "}
              {goal.linked_fund_name ?? "Non collegato"}
            </p>
            <progress
              max="100"
              value={goal.progress_percentage ?? 0}
              aria-label={`Progresso ${goal.name}`}
            />
            <dl className="planningBreakdown">
              <dt>Target</dt>
              <dd>{fiscalMoney(goal.target_amount)}</dd>
              <dt>Saldo corrente</dt>
              <dd>{fiscalMoney(goal.current_amount)}</dd>
              <dt>Completamento</dt>
              <dd>{goal.progress_percentage}%</dd>
              <dt>Residuo</dt>
              <dd>{fiscalMoney(goal.remaining_amount)}</dd>
              <dt>Data target</dt>
              <dd>{goal.target_date ?? "Non configurata"}</dd>
              <dt>Giorni rimanenti</dt>
              <dd>{goal.days_remaining ?? "Non disponibili"}</dd>
              <dt>Passo mensile indicativo</dt>
              <dd>{fiscalMoney(goal.required_monthly_pace)}</dd>
            </dl>
            <div className="planningActions">
              <button
                className="secondary"
                disabled={busy}
                onClick={() => setEditor({ ...goal })}
              >
                Modifica {goal.name}
              </button>
              {goal.status === "active" && (
                <button
                  className="secondary"
                  disabled={busy}
                  onClick={() => void save({ ...goal, status: "paused" })}
                >
                  Pausa
                </button>
              )}
              {goal.status === "paused" && (
                <button
                  className="secondary"
                  disabled={busy}
                  onClick={() => void save({ ...goal, status: "active" })}
                >
                  Riprendi
                </button>
              )}
              <button
                className="secondary"
                disabled={busy}
                onClick={() => setEditor({ ...goal, status: "achieved" })}
              >
                Chiudi
              </button>
            </div>
          </section>
        ))}
      </div>
      {editor && (
        <form
          className="panel"
          onSubmit={(e) => {
            e.preventDefault();
            void save(editor);
          }}
        >
          <h3>{editor.id ? "Modifica obiettivo" : "Crea obiettivo"}</h3>
          <div className="formGrid">
            <Field label="Nome obiettivo">
              <input
                required
                value={editor.name}
                onChange={(e) => setEditor({ ...editor, name: e.target.value })}
              />
            </Field>
            <Field label="Tipo obiettivo">
              <select
                value={editor.goal_type}
                onChange={(e) =>
                  setEditor({ ...editor, goal_type: e.target.value })
                }
              >
                {Object.entries({
                  emergency: "Emergenza",
                  house: "Casa",
                  investment: "Investimento",
                  purchase: "Acquisto",
                  custom: "Personalizzato",
                }).map(([k, v]) => (
                  <option key={k} value={k}>
                    {v}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Importo target">
              <input
                required
                type="number"
                min="0.01"
                step="0.01"
                value={editor.target_amount || ""}
                onChange={(e) =>
                  setEditor({
                    ...editor,
                    target_amount: Number(e.target.value),
                  })
                }
              />
            </Field>
            <Field label="Data obiettivo">
              <input
                type="date"
                value={editor.target_date ?? ""}
                onChange={(e) =>
                  setEditor({ ...editor, target_date: e.target.value || null })
                }
              />
            </Field>
            <Field label="Fondo collegato">
              <select
                value={editor.linked_fund_id ?? ""}
                onChange={(e) =>
                  setEditor({
                    ...editor,
                    linked_fund_id: e.target.value || null,
                  })
                }
              >
                <option value="">Nessuno (saldo non tracciato)</option>
                {funds.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Priorità obiettivo">
              <input
                type="number"
                value={editor.priority}
                onChange={(e) =>
                  setEditor({ ...editor, priority: Number(e.target.value) })
                }
              />
            </Field>
            <Field label="Stato obiettivo">
              <select
                value={editor.status}
                onChange={(e) =>
                  setEditor({ ...editor, status: e.target.value })
                }
              >
                {["active", "paused", "achieved", "cancelled"].map((s) => (
                  <option key={s} value={s}>
                    {statuses[s]}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          <p>
            Un solo obiettivo attivo può utilizzare un fondo; un saldo non viene
            duplicato.
          </p>
          <button className="primary" disabled={busy}>
            Salva obiettivo
          </button>
          <button
            className="secondary"
            type="button"
            onClick={() => setEditor(null)}
          >
            Annulla
          </button>
        </form>
      )}
    </>
  );
}
const blankCommitment: Commitment = {
  name: "",
  commitment_type: "essential",
  amount: 0,
  due_date: "",
  recurrence: "once",
  start_date: "",
  end_date: null,
  is_essential: true,
  status: "active",
  note: null,
};
function PlanningConfiguration({
  client,
  userId,
  onSaved,
}: {
  client: SupabaseClient;
  userId: string;
  onSaved: () => void;
}) {
  const [settings, setSettings] = useState<PlanningSettings | null>(null);
  const [items, setItems] = useState<Commitment[]>([]);
  const [editor, setEditor] = useState<Commitment | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(true);
  const load = useCallback(async () => {
    try {
      const c = await loadPlanningConfig(client, userId);
      setSettings(c.settings);
      setItems(c.commitments);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }, [client, userId]);
  useEffect(() => {
    // Load the authenticated server snapshot on mount.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);
  async function persist(task: () => Promise<unknown>) {
    setBusy(true);
    setError("");
    try {
      await task();
      setEditor(null);
      await load();
      onSaved();
    } catch (e) {
      setError(errorText(e));
      setBusy(false);
    }
  }
  return (
    <details className="panel">
      <summary>Configura e verifica gli impegni di cassa</summary>
      <p>
        Inserisci gli obblighi futuri e verifica l’orizzonte. Non duplicare qui
        imposte già comprese nella Tax Reserve, né spese già registrate nel
        saldo bancario.
      </p>
      {error && <p role="alert">{error}</p>}
      {busy && <p role="status">Aggiornamento configurazione…</p>}
      {settings && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void persist(() => savePlanningSettings(client, userId, settings));
          }}
        >
          <div className="formGrid">
            <Field label="Impegni verificati fino al">
              <input
                type="date"
                value={settings.commitments_verified_through ?? ""}
                onChange={(e) =>
                  setSettings({
                    ...settings,
                    commitments_verified_through: e.target.value || null,
                  })
                }
              />
            </Field>
            <Field label="Orizzonte in giorni (0 = fine mese)">
              <input
                type="number"
                min="0"
                max="366"
                value={settings.default_safe_to_spend_horizon}
                onChange={(e) =>
                  setSettings({
                    ...settings,
                    default_safe_to_spend_horizon: Number(e.target.value),
                  })
                }
              />
            </Field>
            <Field label="Target mensile spese essenziali verificato">
              <input
                type="number"
                min="0.01"
                step="0.01"
                value={settings.monthly_essential_expenses_target ?? ""}
                onChange={(e) =>
                  setSettings({
                    ...settings,
                    monthly_essential_expenses_target: optionalAmount(
                      e.target.value,
                    ),
                  })
                }
              />
            </Field>
          </div>
          <p>
            Salvando la data di verifica confermi di aver controllato tutti gli
            impegni noti fino a quella data. Il target essenziale serve solo
            alla copertura emergenza.
          </p>
          <button className="primary" disabled={busy}>
            Salva verifica e configurazione
          </button>
        </form>
      )}
      <h3>Impegni pianificati</h3>
      {items.length === 0 && (
        <p>
          Nessun impegno inserito. Verifica esplicitamente se non sono previsti
          obblighi nell’orizzonte.
        </p>
      )}
      {items.map((item) => (
        <div className="planningCommitment" key={item.id}>
          <span>
            {item.name} · {fiscalMoney(item.amount)} · {item.due_date} ·{" "}
            {item.recurrence === "monthly" ? "Mensile" : "Una volta"} ·{" "}
            {statuses[item.status]}
          </span>
          <button
            className="secondary"
            disabled={busy}
            onClick={() => setEditor({ ...item })}
          >
            Modifica {item.name}
          </button>
        </div>
      ))}
      <button
        className="secondary"
        disabled={busy}
        onClick={() => setEditor({ ...blankCommitment })}
      >
        Nuovo impegno
      </button>
      {editor && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void persist(() => saveCommitment(client, userId, editor));
          }}
        >
          <div className="formGrid">
            <Field label="Nome impegno">
              <input
                required
                value={editor.name}
                onChange={(e) => setEditor({ ...editor, name: e.target.value })}
              />
            </Field>
            <Field label="Tipo impegno">
              <select
                value={editor.commitment_type}
                onChange={(e) =>
                  setEditor({ ...editor, commitment_type: e.target.value })
                }
              >
                {Object.entries({
                  essential: "Essenziale",
                  debt_payment: "Rata debito",
                  bill: "Bolletta",
                  insurance: "Assicurazione",
                  tax_other: "Altra imposta non inclusa nella Tax Reserve",
                  other: "Altro",
                }).map(([k, v]) => (
                  <option key={k} value={k}>
                    {v}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Importo impegno">
              <input
                required
                type="number"
                min="0.01"
                step="0.01"
                value={editor.amount || ""}
                onChange={(e) =>
                  setEditor({ ...editor, amount: Number(e.target.value) })
                }
              />
            </Field>
            <Field label="Scadenza / prima scadenza">
              <input
                required
                type="date"
                value={editor.due_date}
                onChange={(e) =>
                  setEditor({ ...editor, due_date: e.target.value })
                }
              />
            </Field>
            <Field label="Ricorrenza">
              <select
                value={editor.recurrence}
                onChange={(e) =>
                  setEditor({ ...editor, recurrence: e.target.value })
                }
              >
                <option value="once">Una volta</option>
                <option value="monthly">Mensile</option>
              </select>
            </Field>
            <Field label="Data inizio">
              <input
                required
                type="date"
                value={editor.start_date}
                onChange={(e) =>
                  setEditor({ ...editor, start_date: e.target.value })
                }
              />
            </Field>
            <Field label="Data fine">
              <input
                type="date"
                value={editor.end_date ?? ""}
                onChange={(e) =>
                  setEditor({ ...editor, end_date: e.target.value || null })
                }
              />
            </Field>
            <Field label="Essenziale">
              <input
                type="checkbox"
                checked={editor.is_essential}
                onChange={(e) =>
                  setEditor({ ...editor, is_essential: e.target.checked })
                }
              />
            </Field>
            <Field label="Stato impegno">
              <select
                value={editor.status}
                onChange={(e) =>
                  setEditor({ ...editor, status: e.target.value })
                }
              >
                {["active", "completed", "skipped", "cancelled"].map((s) => (
                  <option key={s} value={s}>
                    {statuses[s]}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Nota impegno">
              <input
                value={editor.note ?? ""}
                onChange={(e) =>
                  setEditor({ ...editor, note: e.target.value || null })
                }
              />
            </Field>
          </div>
          <p>
            Per ricorrenze mensili lo stato vale per tutta la serie. Per saltare
            o completare una singola rata, chiudi la serie alla rata precedente
            e crea la successiva. Il giorno è quello della prima scadenza,
            limitato all’ultimo giorno del mese.
          </p>
          <button className="primary" disabled={busy}>
            Salva impegno
          </button>
          <button
            className="secondary"
            type="button"
            onClick={() => setEditor(null)}
          >
            Annulla
          </button>
        </form>
      )}
    </details>
  );
}
