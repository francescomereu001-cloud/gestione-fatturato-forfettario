import { type FormEvent, type ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import {
  Euro,
  TrendingUp,
  Receipt,
  PiggyBank,
  CalendarDays,
  Upload,
  Plus,
  Trash2,
  Save,
  Wallet,
  AlertTriangle,
  BarChart3,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
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
import { calculateTaxSummary, defaultTaxSettings } from "./domain/calculations/tax";
import { ownedBy, sessionGateState } from "./auth/ownership";
import { parseInvoiceWorkbook } from "./import/parsers/invoiceExcel";
import { supabase, supabaseConfigError } from "./supabase";
import type { Invoice, TaxPayment, TaxSettings } from "./types/finance";
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

  return (
    <main className="authPage">
      <form className="authCard" onSubmit={login}>
        <div className="logo">€</div>
        <h1>Fatturato PRO</h1>
        <p className="muted">Accedi con l’utente creato o invitato in Supabase.</p>
        <Input label="Email" type="email" value={email} onChange={setEmail} />
        <Input label="Password" type="password" value={password} onChange={setPassword} />
        {errorMessage ? <div className="notice">{errorMessage}</div> : null}
        <button className="primary" type="submit" disabled={submitting}>
          {submitting ? "Accesso…" : "Accedi"}
        </button>
      </form>
    </main>
  );
}

function AuthStatus({ message }: { message: string }) {
  return <main className="authPage"><div className="authCard"><p>{message}</p></div></main>;
}

function PrivateApp({ session }: { session: Session }) {
  const navItems: Array<[string, string, LucideIcon]> = [
    ["dashboard", "Dashboard", BarChart3],
    ["fatture", "Fatture", Receipt],
    ["fiscale", "Fiscale", PiggyBank],
    ["pagamenti", "F24 / Pagamenti", Wallet],
    ["import", "Import Excel", Upload],
  ];
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [payments, setPayments] = useState<TaxPayment[]>([]);
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

    const [inv, pay, set] = await Promise.all([
      supabase.from("invoices").select("*").eq("user_id", session.user.id).order("data", { ascending: false }),
      supabase.from("tax_payments").select("*").eq("user_id", session.user.id).order("data", { ascending: false }),
      supabase.from("tax_settings").select("*").eq("user_id", session.user.id).order("anno", { ascending: false }),
    ]);

    if (inv.error || pay.error || set.error) {
      setErrorMessage(
        inv.error?.message || pay.error?.message || set.error?.message || "Errore caricamento dati."
      );
      setLoading(false);
      return;
    }

    setInvoices(inv.data ?? []);
    setPayments(pay.data ?? []);
    setSettings(set.data ?? []);
    setLoading(false);
  }, [session.user.id]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadAll();
  }, [loadAll]);

  const yearSettings =
    settings.find((s) => s.anno === selectedYear) || defaultTaxSettings(selectedYear);

  const invoicesYear = invoices.filter((i) => Number(i.anno) === selectedYear);
  const paymentsYear = payments.filter((p) => Number(p.anno) === selectedYear);

  const stats = useMemo(
    () => calculateTaxSummary(invoicesYear, paymentsYear, yearSettings),
    [invoicesYear, paymentsYear, yearSettings],
  );

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
      ...invoices.map((i) => Number(i.anno)).filter(Boolean),
      ...settings.map((s) => Number(s.anno)).filter(Boolean),
    ]);

    return Array.from(all).sort((a, b) => b - a);
  }, [invoices, settings]);

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
    if (!supabase) return;
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
      setSettings([...settings, { ...defaultTaxSettings(selectedYear), [field]: value }]);
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
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <div className="logo">€</div>
          <div>
            <h1>Fatturato PRO</h1>
            <p>Regime forfettario</p>
          </div>
        </div>

        <nav>
          {navItems.map(([id, label, Icon]) => (
            <button
              key={id}
              className={activeTab === id ? "active" : ""}
              onClick={() => setActiveTab(id)}
            >
              <Icon size={18} />
              {label}
            </button>
          ))}
        </nav>

        <div className="yearBox">
          <label>Anno fiscale</label>
          <select value={selectedYear} onChange={(e) => setSelectedYear(Number(e.target.value))}>
            {years.map((y) => (
              <option key={y}>{y}</option>
            ))}
          </select>
        </div>
      </aside>

      <main className="main">
        <header className="topbar">
          <div>
            <h2>Gestione economica aziendale</h2>
            <p>Fatture, incassi, accantonamenti, F24 e previsione tasse per anno fiscale.</p>
          </div>
          <div className="topbarActions">
            <span className="sessionUser">{session.user.email}</span>
            <button onClick={loadAll} className="ghost">{loading ? "Aggiorno..." : "Aggiorna"}</button>
            <button onClick={() => void supabase?.auth.signOut()} className="ghost">Esci</button>
          </div>
        </header>
        {errorMessage ? <div className="notice">{errorMessage}</div> : null}

        {activeTab === "dashboard" && (
          <>
            <section className="cards">
              <Card icon={<Euro />} title="Fatturato anno" value={euro(stats.fatturato)} />
              <Card icon={<Receipt />} title="Incassato" value={euro(stats.incassato)} />
              <Card icon={<PiggyBank />} title="Tasse stimate" value={euro(stats.tasseTotali)} />
              <Card
                icon={<AlertTriangle />}
                title="Residuo da pagare"
                value={euro(stats.residuo)}
                danger={stats.residuo > 0}
              />
            </section>

            <section className="grid2">
              <div className="panel">
                <h3>Andamento mensile fatturato</h3>
                <ResponsiveContainer width="100%" height={280}>
                  <BarChart data={monthlyData}>
                    <CartesianGrid strokeDasharray="3 3" />
                    <XAxis dataKey="mese" />
                    <YAxis />
                    <Tooltip formatter={(v) => euro(Number(v ?? 0))} />
                    <Bar dataKey="fatturato" radius={[8, 8, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>

              <div className="panel">
                <h3>Previsione fiscale {selectedYear}</h3>
                <div className="rows">
                  <Row label="Fatturato lordo" value={euro(stats.fatturato)} />
                  <Row label="Imponibile forfettario" value={euro(stats.imponibile)} />
                  <Row label="Imposta sostitutiva" value={euro(stats.imposta)} />
                  <Row label="INPS stimata" value={euro(stats.inps)} />
                  <Row label="F24 già inseriti" value={euro(stats.pagato)} />
                  <Row label="Residuo stimato" value={euro(stats.residuo)} strong />
                  <Row
                    label="Accantonamento consigliato"
                    value={`${stats.accantonamentoConsigliato.toFixed(1)}%`}
                    strong
                  />
                </div>
              </div>
            </section>

            <section className="panel">
              <h3>Liquidità reale stimata</h3>
              <div className="cards mini">
                <Card icon={<Wallet />} title="Netto fatture" value={euro(stats.netto)} />
                <Card icon={<CalendarDays />} title="Da incassare" value={euro(stats.daIncassare)} />
                <Card
                  icon={<TrendingUp />}
                  title="Disponibile post tasse"
                  value={euro(stats.disponibilitaStimata)}
                />
              </div>
            </section>
          </>
        )}

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
                  <button className="iconBtn" onClick={() => deleteInvoice(i.id)}>
                    <Trash2 size={16} />
                  </button>
                </div>
              ))}
            </div>
          </section>
        )}

        {activeTab === "fiscale" && (
          <section className="panel">
            <h3>Impostazioni fiscali {selectedYear}</h3>

            <div className="formGrid">
              <Input label="Aliquota imposta sostitutiva %" type="number" value={yearSettings.aliquota_imposta} onChange={(v) => updateSetting("aliquota_imposta", Number(v))} />
              <Input label="Coefficiente redditività %" type="number" value={yearSettings.coefficiente_redditivita} onChange={(v) => updateSetting("coefficiente_redditivita", Number(v))} />
              <Input label="Aliquota INPS %" type="number" value={yearSettings.aliquota_inps} onChange={(v) => updateSetting("aliquota_inps", Number(v))} />
              <Input label="Minimale INPS" type="number" value={yearSettings.minimale_inps} onChange={(v) => updateSetting("minimale_inps", Number(v))} />
            </div>

            <button className="primary" onClick={saveSettings}>
              <Save size={18} /> Salva impostazioni fiscali
            </button>

            <div className="notice">
              Per il 2025 puoi lasciare imposta al 5%. Per il 2026 puoi impostare il 15%.
              I parametri restano modificabili perché INPS e regole fiscali possono cambiare.
            </div>
          </section>
        )}

        {activeTab === "pagamenti" && (
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
      </main>
    </div>
  );
}

type CardProps = { icon: ReactNode; title: string; value: string; danger?: boolean };
function Card({ icon, title, value, danger }: CardProps) {
  return (
    <div className={`card ${danger ? "danger" : ""}`}>
      <div className="cardIcon">{icon}</div>
      <p>{title}</p>
      <h2>{value}</h2>
    </div>
  );
}

type RowProps = { label: string; value: string; strong?: boolean };
function Row({ label, value, strong }: RowProps) {
  return (
    <div className={`row ${strong ? "strong" : ""}`}>
      <span>{label}</span>
      <b>{value}</b>
    </div>
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
