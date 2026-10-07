import { PlanningOverview, FundsPage, GoalsPage } from "./components/PlanningPages";
import { fiscalMoney } from "./components/ui/fiscalLabels";
import { type FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import {
  Euro,
  Receipt,
  PiggyBank,
  Upload,
  Plus,
  Trash2,
  Save,
  AlertTriangle,
} from "lucide-react";
import {
  ResponsiveContainer,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
} from "recharts";
import * as XLSX from "xlsx";
import { loadFinancialTaxSummary } from "./services/fiscal";
import type { FinancialTaxSummary } from "./types/fiscal";
import { FiscalPage, FiscalSummaryPanel } from "./components/FiscalPage";
import { FiscalPaymentAllocations } from "./components/FiscalPaymentAllocations";
import { ownedBy, sessionGateState } from "./auth/ownership";
import { parseInvoiceWorkbook } from "./import/parsers/invoiceExcel";
import { supabase, supabaseConfigError } from "./supabase";
import type { Invoice, TaxPayment, TaxSettings } from "./types/finance";
import { AccountsPage, TransactionsPage } from "./components/LedgerPages";
import { BankImportPage } from "./components/BankImportPage";
import { ResidualReviewPage } from "./components/ResidualReviewPage";
import { AppShell } from "./components/layout/AppShell";
import { PageHeader } from "./components/layout/PageHeader";
import { LoginPage } from "./components/layout/LoginPage";
import { Brand } from "./components/layout/Sidebar";
import { StatCard as Card } from "./components/ui/StatCard";
import "./App.css";

const euro = (n: number) =>
  new Intl.NumberFormat("it-IT", {
    style: "currency",
    currency: "EUR",
  }).format(Number.isFinite(n) ? n : 0);

const currentYear = new Date().getFullYear();


export default function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [restoringSession, setRestoringSession] = useState(Boolean(supabase));

  useEffect(() => {
    if (!supabase) {
      return;
    }

    void supabase.auth.getSession().then(({ data, error }) => {
      if (error) console.error("Impossibile ripristinare la sessione Supabase:", error.message);
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
  if (gate === "loading") return <AuthStatus message="Ripristino della sessione…" />;
  if (supabaseConfigError) return <AuthStatus message={supabaseConfigError} />;
  if (gate === "anonymous" || !session) return <Login />;

  return <PrivateApp session={session} />;
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
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) setErrorMessage(error.message);
    setSubmitting(false);
  };

  return <LoginPage email={email} password={password} submitting={submitting} errorMessage={errorMessage}
    onEmailChange={setEmail} onPasswordChange={setPassword} onSubmit={login} />;
}

function AuthStatus({ message }: { message: string }) {
  return <main className="authPage"><div className="authCard"><Brand /><p role="status">{message}</p></div></main>;
}

function PrivateApp({ session }: { session: Session }) {
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [payments, setPayments] = useState<TaxPayment[]>([]);
  const [fiscalSummary, setFiscalSummary] = useState<FinancialTaxSummary | null>(null);
  const [fiscalError, setFiscalError] = useState("");
  const [planningRefresh, setPlanningRefresh] = useState(0);
  const [settings, setSettings] = useState<TaxSettings[]>([]);
  const [selectedYear, setSelectedYear] = useState(currentYear);
  const [activeTab, setActiveTab] = useState("dashboard");
  const [loading, setLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");

  const [invoiceForm, setInvoiceForm] = useState<Invoice>({
    numero: "",
    data: new Date().toISOString().slice(0, 10),
    cliente: "",
    descrizione: "",
    lordo: 0,
    enasarco: 0,
    netto: 0,
    incassata: true,
    data_incasso: new Date().toISOString().slice(0, 10),
    anno: currentYear,
    categoria: "Provvigioni",
    note: "",
  });

  const [paymentForm, setPaymentForm] = useState<TaxPayment>({
    anno: selectedYear,
    data: new Date().toISOString().slice(0, 10),
    descrizione: "",
    importo: 0,
    tipo: "F24",
  });

  const loadAll = useCallback(async () => {
    if (!supabase) {
      setErrorMessage(supabaseConfigError || "Configurazione Supabase non valida.");
      return;
    }

    setLoading(true);
    setErrorMessage("");

    const [inv, pay, set, fiscal] = await Promise.all([
      supabase.from("invoices").select("*").eq("user_id", session.user.id).order("data", { ascending: false }),
      supabase.from("tax_payments").select("*").eq("user_id", session.user.id).order("data", { ascending: false }),
      supabase.from("tax_settings").select("*").eq("user_id", session.user.id).order("anno", { ascending: false }),
      loadFinancialTaxSummary(supabase, selectedYear).then(data => ({ data, error: "" })).catch(() => ({ data: null, error: "Proiezione fiscale non disponibile. Fatture e pagamenti restano consultabili." })),
    ]);

    if (inv.error || pay.error || set.error) {
      setErrorMessage(
        inv.error?.message || pay.error?.message || set.error?.message || "Errore caricamento dati."
      );
      setLoading(false);
      return;
    }

    setPlanningRefresh(value => value + 1);
    setFiscalSummary(fiscal.data);
    setFiscalError(fiscal.error);
    setInvoices(inv.data ?? []);
    setPayments(pay.data ?? []);
    setSettings(set.data ?? []);
    setLoading(false);
  }, [session.user.id, selectedYear]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadAll();
  }, [loadAll]);

  const yearSettings = settings.find((s) => s.anno === selectedYear);
  const fiscal = fiscalSummary?.tax_year === selectedYear ? fiscalSummary : null;

  const invoicesYear = invoices.filter((i) => Number(i.anno) === selectedYear);
  const paymentsYear = payments.filter((p) => Number(p.anno) === selectedYear);

  const monthlyData = useMemo(() => {
    const months = Array.from({ length: 12 }, (_, i) => ({
      mese: new Date(2024, i, 1).toLocaleString("it-IT", { month: "short" }),
      fatturato: 0,
    }));

    invoicesYear.forEach((i) => {
      if (!i.data) return;
      const m = new Date(i.data).getMonth();
      if (months[m]) months[m].fatturato += Number(i.lordo || 0);
    });

    return months;
  }, [invoicesYear]);

  const years = useMemo(() => {
    const all = new Set([
      currentYear,
      ...Array.from({ length: 6 }, (_, i) => currentYear - 4 + i),
      ...payments.map(p => Number(p.fiscal_tax_year)).filter(Boolean),
      ...invoices.map((i) => Number(i.anno)).filter(Boolean),
      ...settings.map((s) => Number(s.anno)).filter(Boolean),
    ]);

    return Array.from(all).sort((a, b) => b - a);
  }, [invoices, settings, payments]);

  const saveInvoice = async () => {
    if (!supabase) return;
    const payload = ownedBy({
      ...invoiceForm,
      anno: invoiceForm.data ? new Date(invoiceForm.data).getFullYear() : selectedYear,
      lordo: Number(invoiceForm.lordo || 0),
      enasarco: Number(invoiceForm.enasarco || 0),
      netto:
        Number(invoiceForm.netto || 0) ||
        Number(invoiceForm.lordo || 0) - Number(invoiceForm.enasarco || 0),
    }, session.user.id);

    await supabase.from("invoices").insert(payload);

    setInvoiceForm({
      numero: "",
      data: new Date().toISOString().slice(0, 10),
      cliente: "",
      descrizione: "",
      lordo: 0,
      enasarco: 0,
      netto: 0,
      incassata: true,
      data_incasso: new Date().toISOString().slice(0, 10),
      anno: selectedYear,
      categoria: "Provvigioni",
      note: "",
    });

    loadAll();
  };

  const deleteInvoice = async (id?: string) => {
    if (!supabase) return;
    if (!id) return;
    await supabase.from("invoices").delete().eq("id", id).eq("user_id", session.user.id);
    loadAll();
  };

  const savePayment = async () => {
    if (!supabase) return;
    await supabase.from("tax_payments").insert(ownedBy({
      ...paymentForm,
      anno: selectedYear,
      importo: Number(paymentForm.importo || 0),
    }, session.user.id));

    setPaymentForm({
      anno: selectedYear,
      data: new Date().toISOString().slice(0, 10),
      descrizione: "",
      importo: 0,
      tipo: "F24",
    });

    loadAll();
  };

  const saveSettings = async () => {
    if (!supabase || !yearSettings) return;
    const payload = ownedBy({ ...yearSettings, anno: selectedYear }, session.user.id);
    const query = yearSettings.id
      ? supabase.from("tax_settings").update(payload).eq("id", yearSettings.id).eq("user_id", session.user.id)
      : supabase.from("tax_settings").insert(payload);
    const { error } = await query;
    if (error) setErrorMessage(error.message);

    loadAll();
  };

  const updateSetting = (field: keyof TaxSettings, value: number) => {
    const exists = settings.find((s) => s.anno === selectedYear);

    if (exists) {
      setSettings(
        settings.map((s) =>
          s.anno === selectedYear ? { ...s, [field]: value } : s
        )
      );
    } else {
      return;
    }
  };

  const importExcel = async (file: File) => {
    if (!supabase) return;
    const data = await file.arrayBuffer();
    const workbook = XLSX.read(data, { cellDates: true });
    const rowsToInsert = parseInvoiceWorkbook(workbook, file.name);

    if (!rowsToInsert.length) {
      alert("Nessuna fattura valida trovata. Il formato del file non è stato riconosciuto.");
      return;
    }

    for (let i = 0; i < rowsToInsert.length; i += 500) {
      const chunk = rowsToInsert.slice(i, i + 500).map((row) => ownedBy(row, session.user.id));
      const { error } = await supabase.from("invoices").insert(chunk);

      if (error) {
        alert(`Errore durante import: ${error.message}`);
        return;
      }
    }

    await loadAll();
    alert(`Import completato: ${rowsToInsert.length} documenti caricati.`);
  };

  return (
    <AppShell activeTab={activeTab} onNavigate={setActiveTab} email={session.user.email} loading={loading}
      onRefresh={() => void loadAll()} onLogout={() => void supabase?.auth.signOut()}>
      {["dashboard", "fatture", "fiscale", "pagamenti", "import"].includes(activeTab) && <PageHeader
        title={({ dashboard: "Overview", fatture: "Entrate", fiscale: "Fiscale", pagamenti: "F24 / Pagamenti", import: "Import fatture Excel" } as Record<string, string>)[activeTab]}
        eyebrow={activeTab === "dashboard" ? "Liquidità e pianificazione" : "Entrate e tasse"}
        description={({ dashboard: "Safe to Spend e pianificazione attuale, seguiti dai riepiloghi fiscali dell’anno selezionato.", fatture: "Le tue fatture e gli incassi, in un unico spazio.", fiscale: "Parametri e previsioni per il tuo anno fiscale.", pagamenti: "Tieni traccia dei versamenti e degli adempimenti fiscali.", import: "Carica il report del tuo portale di fatturazione." } as Record<string, string>)[activeTab]}
        action={<label className="field">Anno fiscale<select value={selectedYear} onChange={e => setSelectedYear(Number(e.target.value))}>{years.map(y => <option key={y}>{y}</option>)}</select></label>} />}
        {errorMessage ? <div className="notice" role="alert">{errorMessage}</div> : null}

        {activeTab === "dashboard" && (
          <>
            {supabase && <PlanningOverview client={supabase} userId={session.user.id} refreshKey={planningRefresh} />}
            <section className="cards">
              <Card icon={<Euro />} title="Fatturato anno" value={fiscalMoney(fiscal?.revenue_invoiced)} />
              <Card icon={<Receipt />} title="Incassato netto" value={fiscalMoney(fiscal?.revenue_collected)} />
              <Card icon={<PiggyBank />} title="Imposta sostitutiva stimata" value={fiscalMoney(fiscal?.substitute_tax_due_estimated)} />
              <Card icon={<AlertTriangle />} title="Tax Reserve richiesta" value={fiscalMoney(fiscal?.required_tax_reserve)} danger={(fiscal?.required_tax_reserve ?? 0) > 0} />
            </section>
            <section className="panel">
              <h3>Andamento mensile fatturato emesso</h3>
              <ResponsiveContainer width="100%" height={280}><BarChart data={monthlyData}><CartesianGrid strokeDasharray="3 3" /><XAxis dataKey="mese" /><YAxis /><Tooltip formatter={(v) => euro(Number(v ?? 0))} /><Bar dataKey="fatturato" fill="var(--fm-primary)" radius={[8, 8, 0, 0]} /></BarChart></ResponsiveContainer>
            </section>
            <FiscalSummaryPanel summary={fiscal} error={fiscalError} loading={loading} />
          </>
        )}

        {activeTab === "funds" && supabase && <FundsPage client={supabase} userId={session.user.id} />}
        {activeTab === "goals" && supabase && <GoalsPage client={supabase} userId={session.user.id} />}
        {activeTab === "accounts" && supabase && <AccountsPage client={supabase} userId={session.user.id} />}
        {activeTab === "transactions" && supabase && <TransactionsPage client={supabase} userId={session.user.id} />}
        {activeTab === "residual-review" && supabase && <ResidualReviewPage client={supabase} userId={session.user.id} />}
        {activeTab === "bank-import" && supabase && <BankImportPage client={supabase} userId={session.user.id} />}

        {activeTab === "fatture" && (
          <section className="panel">
            <h3>Inserisci nuova fattura</h3>

            <div className="formGrid">
              <Input label="Numero fattura" value={invoiceForm.numero} onChange={(v) => setInvoiceForm({ ...invoiceForm, numero: v })} />
              <Input label="Data fattura" type="date" value={invoiceForm.data} onChange={(v) => setInvoiceForm({ ...invoiceForm, data: v })} />
              <Input label="Cliente / società" value={invoiceForm.cliente} onChange={(v) => setInvoiceForm({ ...invoiceForm, cliente: v })} />
              <Input label="Descrizione" value={invoiceForm.descrizione} onChange={(v) => setInvoiceForm({ ...invoiceForm, descrizione: v })} />
              <Input label="Lordo fattura" type="number" value={invoiceForm.lordo} onChange={(v) => setInvoiceForm({ ...invoiceForm, lordo: Number(v) })} />
              <Input label="ENASARCO" type="number" value={invoiceForm.enasarco} onChange={(v) => setInvoiceForm({ ...invoiceForm, enasarco: Number(v) })} />
              <Input label="Netto a pagare" type="number" value={invoiceForm.netto} onChange={(v) => setInvoiceForm({ ...invoiceForm, netto: Number(v) })} />

              <label className="field">
                Categoria
                <select value={invoiceForm.categoria} onChange={(e) => setInvoiceForm({ ...invoiceForm, categoria: e.target.value })}>
                  <option>Provvigioni</option>
                  <option>Premi</option>
                  <option>Polizze</option>
                  <option>Consulenze</option>
                  <option>Altro</option>
                </select>
              </label>
            </div>

            <button className="primary" onClick={saveInvoice}>
              <Save size={18} /> Salva fattura
            </button>

            <h3 className="mt">Fatture {selectedYear}</h3>

            <div className="table">
              <div className="thead">
                <span>Data</span><span>N.</span><span>Cliente</span><span>Lordo</span><span>Netto</span><span></span>
              </div>

              {invoicesYear.map((i) => (
                <div className="tr" key={i.id}>
                  <span>{i.data}</span>
                  <span>{i.numero}</span>
                  <span>{i.cliente}</span>
                  <span>{euro(Number(i.lordo || 0))}</span>
                  <span>{euro(Number(i.netto || 0))}</span>
                  <button className="iconBtn" aria-label={`Elimina fattura ${i.numero}`} onClick={() => deleteInvoice(i.id)}>
                    <Trash2 size={16} />
                  </button>
                </div>
              ))}
            </div>
          </section>
        )}

        {activeTab === "fiscale" && supabase && <FiscalPage key={`${session.user.id}:${selectedYear}`} client={supabase} userId={session.user.id} year={selectedYear}
          summary={fiscal} error={fiscalError} loading={loading} legacySettings={yearSettings} onSaved={loadAll}
          legacyEditor={yearSettings && <><div className="formGrid">
            <Input label="Aliquota imposta legacy %" type="number" value={yearSettings.aliquota_imposta} onChange={v => updateSetting("aliquota_imposta", Number(v))} />
            <Input label="Coefficiente legacy %" type="number" value={yearSettings.coefficiente_redditivita} onChange={v => updateSetting("coefficiente_redditivita", Number(v))} />
            <Input label="Aliquota INPS legacy %" type="number" value={yearSettings.aliquota_inps} onChange={v => updateSetting("aliquota_inps", Number(v))} />
            <Input label="Minimale INPS legacy" type="number" value={yearSettings.minimale_inps} onChange={v => updateSetting("minimale_inps", Number(v))} />
          </div><button className="secondary" onClick={() => void saveSettings()}>Salva solo impostazioni legacy</button></>} />}

        {activeTab === "pagamenti" && (
          <>
          <section className="panel">
            <h3>F24 e pagamenti fiscali</h3>

            <div className="formGrid">
              <Input label="Data pagamento" type="date" value={paymentForm.data} onChange={(v) => setPaymentForm({ ...paymentForm, data: v })} />
              <Input label="Descrizione" value={paymentForm.descrizione} onChange={(v) => setPaymentForm({ ...paymentForm, descrizione: v })} />
              <Input label="Importo" type="number" value={paymentForm.importo} onChange={(v) => setPaymentForm({ ...paymentForm, importo: Number(v) })} />

              <label className="field">
                Tipo
                <select value={paymentForm.tipo} onChange={(e) => setPaymentForm({ ...paymentForm, tipo: e.target.value })}>
                  <option>F24</option>
                  <option>Saldo imposta</option>
                  <option>Acconto imposta</option>
                  <option>INPS fisso</option>
                  <option>INPS eccedente</option>
                  <option>Altro</option>
                </select>
              </label>
            </div>

            <button className="primary" onClick={savePayment}>
              <Plus size={18} /> Inserisci pagamento
            </button>

            <h3 className="mt">Pagamenti inseriti {selectedYear}</h3>

            <div className="table small">
              {paymentsYear.map((p) => (
                <div className="tr" key={p.id}>
                  <span>{p.data}</span>
                  <span>{p.tipo}</span>
                  <span>{p.descrizione}</span>
                  <span>{euro(Number(p.importo || 0))}</span>
                </div>
              ))}
            </div>
          </section>
          {supabase && <FiscalPaymentAllocations key={`${session.user.id}:${selectedYear}`} client={supabase} userId={session.user.id} year={selectedYear} payments={payments} onSaved={loadAll} />}
          </>
        )}

        {activeTab === "import" && (
          <section className="panel">
            <h3>Import da portale fatturazione elettronica</h3>

            <p className="muted">
              Carica il report .xls/.xlsx estratto dal portale. L’app leggerà Numero,
              Data documento, Cliente, Tipo documento, Totale documento e Netto a pagare.
            </p>

            <label className="uploadBox">
              <Upload size={32} />
              <strong>Carica file Excel</strong>
              <span>.xls / .xlsx</span>

              <input
                type="file"
                accept=".xlsx,.xls"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) importExcel(file);
                }}
              />
            </label>
          </section>
        )}
    </AppShell>
  );
}

type InputProps = {
  label: string;
  value?: string | number;
  onChange: (value: string) => void;
  type?: "text" | "number" | "date" | "email" | "password";
};
function Input({ label, value, onChange, type = "text" }: InputProps) {
  return (
    <label className="field">
      {label}
      <input type={type} value={value ?? ""} onChange={(e) => onChange(e.target.value)} />
    </label>
  );
}
