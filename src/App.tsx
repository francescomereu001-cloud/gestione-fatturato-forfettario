import {
  PlanningOverview,
  FundsPage,
  GoalsPage,
} from "./components/PlanningPages";
import { fiscalMoney } from "./components/ui/fiscalLabels";
import {
  type FormEvent,
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { Session } from "@supabase/supabase-js";
import { loadFinancialTaxSummary, loadTaxPayments } from "./services/fiscal";
import type { FinancialTaxSummary } from "./types/fiscal";
import { FiscalPage } from "./components/FiscalPage";
import {
  loadIncomeSummary,
  loadIncomeInvoices,
  incomeError,
} from "./services/income";
import type { IncomeSummary } from "./types/income";
import { sessionGateState } from "./auth/ownership";
import { supabase, supabaseConfigError } from "./supabase";
import type { Invoice, TaxPayment } from "./types/finance";
import { AccountsPage, TransactionsPage } from "./components/LedgerPages";
import { BankImportPage } from "./components/BankImportPage";
import { ResidualReviewPage } from "./components/ResidualReviewPage";
import { AppShell } from "./components/layout/AppShell";
import { PageHeader } from "./components/layout/PageHeader";
import { LoginPage } from "./components/layout/LoginPage";
import { Brand } from "./components/layout/Sidebar";
import { StatCard as Card } from "./components/ui/StatCard";
import "./App.css";

const IncomePage = lazy(() =>
  import("./components/income/IncomePage").then((module) => ({
    default: module.IncomePage,
  })),
);
const InvoiceImportPage = lazy(() =>
  import("./components/income/InvoiceImportPage").then((module) => ({
    default: module.InvoiceImportPage,
  })),
);
const TaxPaymentsPage = lazy(() =>
  import("./components/taxes/TaxPaymentsPage").then((module) => ({
    default: module.TaxPaymentsPage,
  })),
);

const currentYear = new Date().getFullYear();

export default function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [restoringSession, setRestoringSession] = useState(Boolean(supabase));

  useEffect(() => {
    if (!supabase) {
      return;
    }

    void supabase.auth.getSession().then(({ data, error }) => {
      if (error)
        console.error(
          "Impossibile ripristinare la sessione Supabase:",
          error.message,
        );
      setSession(data.session);
      setRestoringSession(false);
    });

    const { data } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      setSession(nextSession);
      setRestoringSession(false);
    });

    return () => data.subscription.unsubscribe();
  }, []);

  const gate = sessionGateState(restoringSession, session?.user.id);
  if (gate === "loading")
    return <AuthStatus message="Ripristino della sessione…" />;
  if (supabaseConfigError) return <AuthStatus message={supabaseConfigError} />;
  if (gate === "anonymous" || !session) return <Login />;

  return <PrivateApp key={session.user.id} session={session} />;
}

function Login() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");

  const login = async (event: FormEvent) => {
    event.preventDefault();
    if (!supabase) return;
    setSubmitting(true);
    setErrorMessage("");
    const { error } = await supabase.auth.signInWithPassword({
      email,
      password,
    });
    if (error) setErrorMessage(error.message);
    setSubmitting(false);
  };

  return (
    <LoginPage
      email={email}
      password={password}
      submitting={submitting}
      errorMessage={errorMessage}
      onEmailChange={setEmail}
      onPasswordChange={setPassword}
      onSubmit={login}
    />
  );
}

function AuthStatus({ message }: { message: string }) {
  return (
    <main className="authPage">
      <div className="authCard">
        <Brand />
        <p role="status">{message}</p>
      </div>
    </main>
  );
}

function PrivateApp({ session }: { session: Session }) {
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [payments, setPayments] = useState<TaxPayment[]>([]);
  const [income, setIncome] = useState<IncomeSummary | null>(null);
  const [incomeMessage, setIncomeMessage] = useState("");
  const [fiscalSummary, setFiscalSummary] =
    useState<FinancialTaxSummary | null>(null);
  const [fiscalError, setFiscalError] = useState("");
  const [planningRefresh, setPlanningRefresh] = useState(0);
  const [selectedYear, setSelectedYear] = useState(currentYear);
  const [activeTab, setActiveTab] = useState("dashboard");
  const [loading, setLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");
  const refreshVersion = useRef(0);
  const loadAll = useCallback(async () => {
    if (!supabase) return;
    const version = ++refreshVersion.current;
    setLoading(true);
    setErrorMessage("");
    const [inv, pay, fiscal, incomeResult] = await Promise.all([
      loadIncomeInvoices(supabase, session.user.id)
        .then((data) => ({ data, error: null }))
        .catch((error) => ({ data: [], error })),
      loadTaxPayments(supabase, session.user.id)
        .then((data) => ({ data, error: null }))
        .catch((error) => ({ data: [], error })),
      loadFinancialTaxSummary(supabase, selectedYear)
        .then((data) => ({ data, error: "" }))
        .catch((reason) => ({ data: null, error: incomeError(reason) })),
      loadIncomeSummary(supabase, selectedYear)
        .then((data) => ({ data, error: "" }))
        .catch((reason) => ({ data: null, error: incomeError(reason) })),
    ]);
    if (version !== refreshVersion.current) return;
    setErrorMessage(inv.error?.message || pay.error?.message || "");
    setFiscalSummary(fiscal.data);
    setFiscalError(fiscal.error);
    setIncome(incomeResult.data);
    setIncomeMessage(incomeResult.error);
    setInvoices(inv.data ?? []);
    setPayments(pay.data ?? []);
    setPlanningRefresh((value) => value + 1);
    setLoading(false);
  }, [session.user.id, selectedYear]);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadAll();
  }, [loadAll]);
  const years = useMemo(
    () =>
      Array.from(
        new Set([
          currentYear,
          ...Array.from({ length: 6 }, (_, i) => currentYear - 4 + i),
          ...invoices
            .map((i) => Number(i.data?.slice(0, 4) || i.anno))
            .filter(Boolean),
          ...payments
            .flatMap((p) => [p.anno, Number(p.fiscal_tax_year)])
            .filter(Boolean),
        ]),
      ).sort((a, b) => b - a),
    [invoices, payments],
  );
  const fiscal =
    fiscalSummary?.tax_year === selectedYear ? fiscalSummary : null;
  const titles: Record<string, string> = {
    dashboard: "Overview",
    fatture: "Income",
    fiscale: "Taxes",
    pagamenti: "Tax Payments / F24",
    import: "Import Income",
  };
  return (
    <AppShell
      activeTab={activeTab}
      onNavigate={setActiveTab}
      email={session.user.email}
      loading={loading}
      onRefresh={() => void loadAll()}
      onLogout={() => void supabase?.auth.signOut()}
    >
      {titles[activeTab] && (
        <PageHeader
          title={titles[activeTab]}
          eyebrow={
            activeTab === "dashboard"
              ? "Liquidità e pianificazione"
              : "Income & Taxes"
          }
          description={
            activeTab === "dashboard"
              ? "Safe to Spend e riepilogo annuale."
              : "Fatture, profilo fiscale annuale e pagamenti attribuiti."
          }
          action={
            <label className="field">
              Anno
              <select
                value={selectedYear}
                onChange={(e) => setSelectedYear(Number(e.target.value))}
              >
                {years.map((y) => (
                  <option key={y}>{y}</option>
                ))}
              </select>
            </label>
          }
        />
      )}
      {errorMessage && (
        <div className="notice" role="alert">
          {errorMessage}
        </div>
      )}
      <Suspense fallback={<p role="status">Caricamento pagina…</p>}>
        {activeTab === "dashboard" && (
          <>
            {supabase && (
              <PlanningOverview
                client={supabase}
                userId={session.user.id}
                refreshKey={planningRefresh}
              />
            )}
            <section className="cards">
              <Card
                title="Netto percepito anno"
                value={fiscalMoney(income?.net_income)}
              />
              <Card
                title="Tax Reserve richiesta"
                value={fiscalMoney(fiscal?.required_tax_reserve)}
              />
            </section>
            {fiscalError && <p role="alert">{fiscalError}</p>}
          </>
        )}
        {activeTab === "funds" && supabase && (
          <FundsPage client={supabase} userId={session.user.id} />
        )}
        {activeTab === "goals" && supabase && (
          <GoalsPage client={supabase} userId={session.user.id} />
        )}
        {activeTab === "accounts" && supabase && (
          <AccountsPage client={supabase} userId={session.user.id} />
        )}
        {activeTab === "transactions" && supabase && (
          <TransactionsPage client={supabase} userId={session.user.id} />
        )}
        {activeTab === "residual-review" && supabase && (
          <ResidualReviewPage client={supabase} userId={session.user.id} />
        )}
        {activeTab === "bank-import" && supabase && (
          <BankImportPage client={supabase} userId={session.user.id} />
        )}
        {activeTab === "fatture" && supabase && (
          <IncomePage
            client={supabase}
            summary={income?.tax_year === selectedYear ? income : null}
            invoices={invoices.filter(
              (i) => Number(i.data?.slice(0, 4) || i.anno) === selectedYear,
            )}
            error={incomeMessage}
            onSaved={loadAll}
          />
        )}
        {activeTab === "import" && supabase && (
          <InvoiceImportPage client={supabase} onSaved={loadAll} />
        )}
        {activeTab === "fiscale" && supabase && (
          <FiscalPage
            key={`${session.user.id}:${selectedYear}`}
            client={supabase}
            userId={session.user.id}
            year={selectedYear}
            summary={fiscal}
            error={fiscalError}
            loading={loading}
            onSaved={loadAll}
          />
        )}
        {activeTab === "pagamenti" && supabase && (
          <TaxPaymentsPage
            key={`${session.user.id}:${selectedYear}`}
            client={supabase}
            userId={session.user.id}
            year={selectedYear}
            payments={payments.filter(
              (p) =>
                p.anno === selectedYear || p.fiscal_tax_year === selectedYear,
            )}
            onSaved={loadAll}
          />
        )}
      </Suspense>
    </AppShell>
  );
}
