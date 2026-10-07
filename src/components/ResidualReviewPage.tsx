import { useCallback, useEffect, useState } from "react";
import {
  ArrowRight,
  Check,
  CircleCheck,
  ChevronLeft,
  ChevronRight,
  RefreshCw,
  Landmark,
  LoaderCircle,
} from "lucide-react";
import { PageHeader } from "./layout/PageHeader";
import { Badge } from "./ui/Badge";
import { Button } from "./ui/Button";
import { EmptyState } from "./ui/EmptyState";
import {
  dateRange,
  money,
  providerLabel,
  transactionTypeLabels,
} from "./ui/labels";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  transactionTypes,
  type Account,
  type TransactionCategory,
  type TransactionType,
} from "../types/ledger";
import {
  applyReviewOnce,
  blankReviewDecision,
  categoriesForDecision,
  isTransferType,
  loadResidualGroups,
  loadReviewOptions,
  reviewHint,
  saveReviewRule,
  serverErrorMessage,
  transferTargets,
  type ResidualGroup,
  type ReviewDecision,
  type ReviewGrouping,
  type ReviewPage,
} from "../services/residualReview";

export function ResidualReviewPage({
  client,
  userId,
}: {
  client: SupabaseClient;
  userId: string;
}) {
  const [page, setPage] = useState<ReviewPage>({
    groups: [],
    total_groups: 0,
    unclassified_count: 0,
  });
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [categories, setCategories] = useState<TransactionCategory[]>([]);
  const [grouping, setGrouping] =
    useState<ReviewGrouping>("provider_operation");
  const [offset, setOffset] = useState(0);
  const [selected, setSelected] = useState<ResidualGroup | null>(null);
  const [decision, setDecision] = useState<ReviewDecision>(blankReviewDecision);
  const [ruleField, setRuleField] =
    useState<ReviewGrouping>("provider_operation");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const [next, options] = await Promise.all([
        loadResidualGroups(client, grouping, offset),
        loadReviewOptions(client, userId),
      ]);
      setPage(next);
      setAccounts(options.accounts);
      setCategories(options.categories);
      setError("");
    } catch (reason) {
      setError(serverErrorMessage(reason));
    } finally {
      setLoading(false);
    }
  }, [client, userId, grouping, offset]);
  useEffect(() => {
    // Load the owner-scoped aggregate page when its grouping or pagination changes.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void reload();
  }, [reload]);
  const selectGroup = (group: ResidualGroup) => {
    setSelected(group);
    setDecision(blankReviewDecision());
    setError("");
    setMessage("");
    setRuleField(
      group.provider_operation ? "provider_operation" : "provider_category",
    );
  };
  const apply = async (saveRule: boolean) => {
    if (!selected) return;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const count = saveRule
        ? (await saveReviewRule(client, selected, decision, ruleField))
            .classified_count
        : await applyReviewOnce(client, selected.transaction_ids, decision);
      setMessage(
        `${count} movimenti classificati${saveRule ? " · Regola salvata" : ""}`,
      );
      setSelected(null);
      await reload();
    } catch (reason) {
      setError(serverErrorMessage(reason));
    } finally {
      setBusy(false);
    }
  };
  const canSaveRule =
    selected?.parser_key &&
    selected[ruleField] &&
    !selected.metadata_conflicting;
  const invalidTarget =
    decision.transaction_type === "investment_transfer" &&
    !decision.transfer_account_id;
  return (
    <section className="reviewPage" aria-busy={loading || busy}>
      <PageHeader
        title="Movimenti da verificare"
        eyebrow="Il tuo denaro"
        description={
          loading
            ? "Caricamento dei movimenti…"
            : error && page.groups.length === 0
              ? "Movimenti non disponibili al momento."
              : `${page.unclassified_count} movimenti richiedono una decisione · ${page.total_groups} gruppi`
        }
      />
      {error && (
        <div className="notice" role="alert">
          {error}
        </div>
      )}
      {message && (
        <div className="successBanner" role="status">
          <CircleCheck size={18} aria-hidden="true" />
          {message}
        </div>
      )}
      <div className="reviewToolbar">
        <label className="field">
          Raggruppa per
          <select
            aria-label="Raggruppa per"
            value={grouping}
            disabled={busy}
            onChange={(e) => {
              setGrouping(e.target.value as ReviewGrouping);
              setOffset(0);
              setSelected(null);
            }}
          >
            <option value="provider_operation">Controparte / operazione</option>
            <option value="provider_category">Categoria bancaria</option>
          </select>
        </label>
        <div className="reviewToolbarMeta">
          <span>{page.total_groups} gruppi</span>
          <Button
            variant="secondary"
            disabled={busy || loading}
            onClick={() => {
              setSelected(null);
              void reload();
            }}
          >
            <RefreshCw size={15} aria-hidden="true" />
            Aggiorna residui
          </Button>
        </div>
      </div>
      <div className="reviewLayout">
        <div>
          {loading ? (
            <div className="reviewLoading panel" role="status">
              <LoaderCircle className="spin" size={20} aria-hidden="true" />
              Caricamento…
            </div>
          ) : error && page.groups.length === 0 ? (
            <div className="panel">
              <EmptyState
                title="Movimenti non disponibili"
                description="Aggiorna i residui per riprovare."
              />
            </div>
          ) : page.groups.length === 0 ? (
            <div className="panel">
              <EmptyState
                complete={page.unclassified_count === 0}
                title={
                  page.unclassified_count === 0
                    ? "Tutto in ordine"
                    : "Nessun gruppo in questa pagina"
                }
                description={
                  page.unclassified_count === 0
                    ? "Non ci sono movimenti che richiedono revisione."
                    : "Usa la paginazione per tornare agli altri gruppi."
                }
              />
            </div>
          ) : (
            <div className="reviewGroups">
              {page.groups.map((group) => (
                <button
                  type="button"
                  className={`reviewGroup ${selected?.group_key === group.group_key ? "selected" : ""}`}
                  aria-pressed={selected?.group_key === group.group_key}
                  key={group.group_key}
                  disabled={busy}
                  onClick={() => selectGroup(group)}
                >
                  <span className="reviewGroupTitle">
                    <strong>
                      {reviewHint(group) ||
                        group.provider_operation ||
                        group.provider_category ||
                        "Movimenti da verificare"}
                    </strong>
                    {selected?.group_key === group.group_key ? (
                      <Check
                        className="reviewSelectionMark"
                        size={17}
                        aria-hidden="true"
                      />
                    ) : (
                      <ArrowRight
                        size={16}
                        className="muted"
                        aria-hidden="true"
                      />
                    )}
                  </span>
                  <span className="reviewMetrics">
                    <span>{group.transaction_count} movimenti</span>
                    <span
                      className={`reviewTotal amount ${Number(group.total_amount) > 0 ? "text-success" : ""}`}
                    >
                      {money(Number(group.total_amount), group.currency, true)}
                    </span>
                    <span className="reviewDates">
                      {dateRange(group.date_min, group.date_max)}
                    </span>
                  </span>
                  <span className="reviewBadges">
                    <Badge>{providerLabel(group.parser_key)}</Badge>
                    {group.provider_category && (
                      <Badge>{group.provider_category}</Badge>
                    )}
                    <Badge variant="warning">Da verificare</Badge>
                  </span>
                  <span className="reviewAccount">{group.account_name}</span>
                  {group.metadata_conflicting && (
                    <span className="reviewDecisionHelp">
                      Informazioni bancarie non coerenti: verifica manuale.
                    </span>
                  )}
                  <span className="reviewExamples">
                    <span className="reviewExamplesLabel">
                      Esempi di movimento
                    </span>
                    {group.examples.slice(0, 3).map((example, i) => (
                      <span key={i}>{example}</span>
                    ))}
                  </span>
                </button>
              ))}
            </div>
          )}
          <div className="reviewPagination">
            <Button
              variant="ghost"
              disabled={offset === 0 || busy || loading}
              onClick={() => {
                setOffset(Math.max(0, offset - 50));
                setSelected(null);
              }}
            >
              <ChevronLeft size={15} aria-hidden="true" />
              Precedenti
            </Button>
            <span>
              {page.total_groups === 0
                ? "0 gruppi"
                : `${offset + 1}–${Math.min(offset + 50, page.total_groups)} di ${page.total_groups} gruppi`}
            </span>
            <Button
              variant="ghost"
              disabled={offset + 50 >= page.total_groups || busy || loading}
              onClick={() => {
                setOffset(offset + 50);
                setSelected(null);
              }}
            >
              Successivi
              <ChevronRight size={15} aria-hidden="true" />
            </Button>
          </div>
        </div>
        <div className="panel reviewDecision">
          {selected ? (
            <>
              <h2 className="reviewDecisionTitle">Classifica questo gruppo</h2>
              <div className="reviewDecisionSummary">
                <strong>
                  {selected.provider_operation ||
                    selected.provider_category ||
                    "Gruppo selezionato"}
                </strong>
                <div className="reviewMetrics">
                  <span>
                    {selected.transaction_ids.length} movimenti selezionati
                  </span>
                  <span className="reviewTotal amount">
                    {money(
                      Number(selected.total_amount),
                      selected.currency,
                      true,
                    )}
                  </span>
                </div>
                <div className="reviewMetaGrid">
                  <span>
                    <Landmark size={12} aria-hidden="true" />{" "}
                    {selected.account_name} ·{" "}
                    {providerLabel(selected.parser_key)}
                  </span>
                  <span>{dateRange(selected.date_min, selected.date_max)}</span>
                </div>
              </div>
              {selected.transaction_count > selected.transaction_ids.length && (
                <p className="notice">
                  Il gruppo contiene {selected.transaction_count} movimenti.
                  Questa azione aggiorna i primi 500; aggiorna i residui per
                  continuare.
                </p>
              )}
              {reviewHint(selected) && (
                <p className="notice">{reviewHint(selected)}</p>
              )}
              <div className="formGrid">
                <label className="field">
                  Tipo di movimento
                  <select
                    value={decision.transaction_type}
                    disabled={busy}
                    onChange={(e) =>
                      setDecision({
                        transaction_type: e.target.value as TransactionType,
                        category_id: null,
                        transfer_account_id: null,
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
                {categoriesForDecision(decision.transaction_type, categories)
                  .length > 0 && (
                  <label className="field">
                    Categoria
                    <select
                      value={decision.category_id ?? ""}
                      disabled={busy}
                      onChange={(e) =>
                        setDecision({
                          ...decision,
                          category_id: e.target.value || null,
                        })
                      }
                    >
                      <option value="">Nessuna</option>
                      {categoriesForDecision(
                        decision.transaction_type,
                        categories,
                      ).map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
                {isTransferType(decision.transaction_type) && (
                  <label className="field">
                    Conto di destinazione
                    <select
                      value={decision.transfer_account_id ?? ""}
                      disabled={busy}
                      onChange={(e) =>
                        setDecision({
                          ...decision,
                          transfer_account_id: e.target.value || null,
                        })
                      }
                    >
                      <option value="">
                        {decision.transaction_type === "internal_transfer"
                          ? "Conto non ancora presente"
                          : "Seleziona un broker"}
                      </option>
                      {transferTargets(
                        selected,
                        decision.transaction_type,
                        accounts,
                      ).map((a) => (
                        <option key={a.id} value={a.id}>
                          {a.name}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
              </div>
              {isTransferType(decision.transaction_type) && (
                <p className="reviewDecisionHelp">
                  {decision.transfer_account_id
                    ? "Il trasferimento sarà confermato con il conto scelto."
                    : decision.transaction_type === "investment_transfer"
                      ? "Seleziona un conto broker per continuare."
                      : "Il movimento sarà escluso da entrate e spese, ma resterà da riconciliare."}
                </p>
              )}
              <div className="ruleRecognition">
                <label className="field">
                  Come riconoscere movimenti simili in futuro
                  <select
                    aria-label="Come riconoscere movimenti simili in futuro"
                    value={ruleField}
                    disabled={busy}
                    onChange={(e) =>
                      setRuleField(e.target.value as ReviewGrouping)
                    }
                  >
                    {selected.provider_operation && (
                      <option value="provider_operation">
                        Stessa controparte / operazione
                      </option>
                    )}
                    {selected.provider_category && (
                      <option value="provider_category">
                        Stessa categoria bancaria
                      </option>
                    )}
                    {!selected.provider_operation &&
                      !selected.provider_category && (
                        <option value={ruleField}>
                          Informazioni non disponibili
                        </option>
                      )}
                  </select>
                  <small>
                    La regola riconoscerà una corrispondenza esatta, per questa
                    banca e questo conto.
                  </small>
                </label>
              </div>
              {!canSaveRule && (
                <p className="reviewDecisionHelp">
                  Per questo gruppo puoi applicare la decisione una volta. Non
                  ci sono informazioni bancarie sufficienti per creare una
                  regola.
                </p>
              )}
              <div className="reviewActions">
                <Button
                  disabled={busy || invalidTarget}
                  onClick={() => void apply(false)}
                >
                  {busy && (
                    <LoaderCircle
                      className="spin"
                      size={16}
                      aria-hidden="true"
                    />
                  )}
                  {busy ? "Classificazione…" : "Classifica gruppo"}
                </Button>
                <Button
                  variant="secondary"
                  disabled={busy || invalidTarget || !canSaveRule}
                  onClick={() => void apply(true)}
                >
                  Classifica e crea regola
                </Button>
              </div>
              <details className="technicalDetails">
                <summary>Mostra dettagli tecnici</summary>
                <dl>
                  <dt>Parser</dt>
                  <dd>{selected.parser_key || "—"}</dd>
                  <dt>Categoria provider</dt>
                  <dd>{selected.provider_category || "—"}</dd>
                  <dt>Operazione provider</dt>
                  <dd>{selected.provider_operation || "—"}</dd>
                  <dt>Periodo</dt>
                  <dd>
                    {selected.date_min} – {selected.date_max}
                  </dd>
                </dl>
              </details>
            </>
          ) : (
            <EmptyState
              title="Una decisione alla volta"
              description="Seleziona un gruppo per vedere i dettagli e scegliere come classificarlo."
            />
          )}
        </div>
      </div>
    </section>
  );
}
