import { useEffect, useMemo, useState } from "react";
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
import { supabase } from "./supabase";
import "./App.css";

type Invoice = {
  id?: string;
  numero?: string;
  data?: string;
  cliente?: string;
  descrizione?: string;
  lordo?: number;
  enasarco?: number;
  netto?: number;
  incassata?: boolean;
  data_incasso?: string;
  anno?: number;
  categoria?: string;
  note?: string;
};

type TaxPayment = {
  id?: string;
  anno: number;
  data?: string;
  descrizione: string;
  importo: number;
  tipo: string;
};

type TaxSettings = {
  id?: string;
  anno: number;
  aliquota_imposta: number;
  coefficiente_redditivita: number;
  aliquota_inps: number;
  minimale_inps: number;
};

const euro = (n: number) =>
  new Intl.NumberFormat("it-IT", {
    style: "currency",
    currency: "EUR",
  }).format(Number.isFinite(n) ? n : 0);

const currentYear = new Date().getFullYear();

const defaultSettings = (anno: number): TaxSettings => ({
  anno,
  aliquota_imposta: anno <= 2025 ? 5 : 15,
  coefficiente_redditivita: 78,
  aliquota_inps: 24.48,
  minimale_inps: 18808,
});

const norm = (v: any) =>
  String(v ?? "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ");

const parseAmount = (v: any): number => {
  if (typeof v === "number") return v;
  const s = String(v ?? "")
    .replace(/[€\s]/g, "")
    .replace(/\./g, "")
    .replace(",", ".")
    .replace(/[^\d.-]/g, "");
  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
};

const parseExcelDate = (v: any): string | undefined => {
  if (!v) return undefined;

  if (typeof v === "number") {
    const d = XLSX.SSF.parse_date_code(v);
    if (!d) return undefined;
    return `${d.y}-${String(d.m).padStart(2, "0")}-${String(d.d).padStart(2, "0")}`;
  }

  if (v instanceof Date && !isNaN(v.getTime())) {
    return v.toISOString().slice(0, 10);
  }

  const s = String(v).trim();

  const matchIt = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (matchIt) {
    return `${matchIt[3]}-${matchIt[2].padStart(2, "0")}-${matchIt[1].padStart(2, "0")}`;
  }

  const d = new Date(s);
  if (!isNaN(d.getTime())) return d.toISOString().slice(0, 10);

  return undefined;
};

export default function App() {
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [payments, setPayments] = useState<TaxPayment[]>([]);
  const [settings, setSettings] = useState<TaxSettings[]>([]);
  const [selectedYear, setSelectedYear] = useState(currentYear);
  const [activeTab, setActiveTab] = useState("dashboard");
  const [loading, setLoading] = useState(false);

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

  const loadAll = async () => {
    setLoading(true);

    const inv = await supabase
      .from("invoices")
      .select("*")
      .order("data", { ascending: false });

    const pay = await supabase
      .from("tax_payments")
      .select("*")
      .order("data", { ascending: false });

    const set = await supabase
      .from("tax_settings")
      .select("*")
      .order("anno", { ascending: false });

    if (inv.data) setInvoices(inv.data);
    if (pay.data) setPayments(pay.data);
    if (set.data) setSettings(set.data);

    setLoading(false);
  };

  useEffect(() => {
    loadAll();
  }, []);

  const yearSettings =
    settings.find((s) => s.anno === selectedYear) || defaultSettings(selectedYear);

  const invoicesYear = invoices.filter((i) => Number(i.anno) === selectedYear);
  const paymentsYear = payments.filter((p) => Number(p.anno) === selectedYear);

  const stats = useMemo(() => {
    const fatturato = invoicesYear.reduce((a, i) => a + Number(i.lordo || 0), 0);
    const enasarco = invoicesYear.reduce((a, i) => a + Number(i.enasarco || 0), 0);
    const netto = invoicesYear.reduce((a, i) => a + Number(i.netto || 0), 0);

    const incassato = invoicesYear
      .filter((i) => i.incassata)
      .reduce((a, i) => a + Number(i.netto || i.lordo || 0), 0);

    const daIncassare = invoicesYear
      .filter((i) => !i.incassata)
      .reduce((a, i) => a + Number(i.netto || i.lordo || 0), 0);

    const imponibile = fatturato * (yearSettings.coefficiente_redditivita / 100);
    const imposta = imponibile * (yearSettings.aliquota_imposta / 100);

    const baseInps = Math.max(imponibile, Number(yearSettings.minimale_inps || 0));
    const inps = baseInps * (yearSettings.aliquota_inps / 100);

    const tasseTotali = imposta + inps;
    const pagato = paymentsYear.reduce((a, p) => a + Number(p.importo || 0), 0);
    const residuo = tasseTotali - pagato;
    const accantonamentoConsigliato = fatturato > 0 ? (tasseTotali / fatturato) * 100 : 0;
    const disponibilitaStimata = incassato - tasseTotali;

    return {
      fatturato,
      enasarco,
      netto,
      incassato,
      daIncassare,
      imponibile,
      imposta,
      inps,
      tasseTotali,
      pagato,
      residuo,
      accantonamentoConsigliato,
      disponibilitaStimata,
    };
  }, [invoicesYear, paymentsYear, yearSettings]);

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
    const payload = {
      ...invoiceForm,
      anno: invoiceForm.data ? new Date(invoiceForm.data).getFullYear() : selectedYear,
      lordo: Number(invoiceForm.lordo || 0),
      enasarco: Number(invoiceForm.enasarco || 0),
      netto:
        Number(invoiceForm.netto || 0) ||
        Number(invoiceForm.lordo || 0) - Number(invoiceForm.enasarco || 0),
    };

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
    if (!id) return;
    await supabase.from("invoices").delete().eq("id", id);
    loadAll();
  };

  const savePayment = async () => {
    await supabase.from("tax_payments").insert({
      ...paymentForm,
      anno: selectedYear,
      importo: Number(paymentForm.importo || 0),
    });

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
    await supabase
      .from("tax_settings")
      .upsert({ ...yearSettings, anno: selectedYear }, { onConflict: "anno" });

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
      setSettings([...settings, { ...defaultSettings(selectedYear), [field]: value }]);
    }
  };

  const importExcel = async (file: File) => {
    const data = await file.arrayBuffer();
    const workbook = XLSX.read(data, { cellDates: true });
    const rowsToInsert: Invoice[] = [];

    workbook.SheetNames.forEach((sheetName) => {
      const sheet = workbook.Sheets[sheetName];

      const rows: any[][] = XLSX.utils.sheet_to_json(sheet, {
        header: 1,
        defval: "",
        raw: true,
      });

      const headerRowIndex = rows.findIndex((row) => {
        const joined = row.map(norm).join(" | ");
        return (
          joined.includes("numero") &&
          joined.includes("cliente") &&
          (joined.includes("totale documento") ||
            joined.includes("netto a pagare") ||
            joined.includes("totale fattura"))
        );
      });

      if (headerRowIndex === -1) return;

      const headers = rows[headerRowIndex].map(norm);

      const findCol = (...names: string[]) =>
        headers.findIndex((h) => names.some((n) => h === norm(n) || h.includes(norm(n))));

      const colNumero = findCol("Numero", "N. fattura", "Numero fattura");
      const colData = findCol("Data documento", "Data fattura", "Data");
      const colCliente = findCol("Cliente", "Società", "Societa");
      const colTipo = findCol("Tipo documento");
      const colTotaleDocumento = findCol("Totale documento", "Totale fattura");
      const colNetto = findCol("Netto a pagare", "Netto a pagare (ENASARCO)", "Netto");
      const colIncassi = findCol("Incassi", "Stato incasso");
      const colDataIncasso = findCol("Data incasso");
      const colStato = findCol("Stato");
      const colDescrizione = findCol("Descrizione del progetto", "Descrizione");

      rows.slice(headerRowIndex + 1).forEach((row) => {
        const numero = row[colNumero];
        const cliente = row[colCliente];
        const tipoDocumento = colTipo >= 0 ? row[colTipo] : "";
        const descrizione =
          colDescrizione >= 0 && row[colDescrizione]
            ? row[colDescrizione]
            : tipoDocumento || "Fattura elettronica";

        const dataFattura = parseExcelDate(row[colData]);
        const dataIncasso = colDataIncasso >= 0 ? parseExcelDate(row[colDataIncasso]) : undefined;

        const totaleDocumento =
          colTotaleDocumento >= 0 ? parseAmount(row[colTotaleDocumento]) : 0;

        const netto =
          colNetto >= 0 ? parseAmount(row[colNetto]) || totaleDocumento : totaleDocumento;

        const incassi = colIncassi >= 0 ? norm(row[colIncassi]) : "";
        const stato = colStato >= 0 ? norm(row[colStato]) : "";

        if (!numero || !cliente || !dataFattura) return;
        if (!totaleDocumento && !netto) return;
        if (norm(numero).includes("totale")) return;

        const isNotaCredito =
          norm(tipoDocumento).includes("nota") ||
          norm(tipoDocumento).includes("td04");

        const sign = isNotaCredito ? -1 : 1;

        const lordoFinale = Math.abs(totaleDocumento || netto) * sign;
        const nettoFinale = Math.abs(netto || totaleDocumento) * sign;

        rowsToInsert.push({
          numero: String(numero).trim(),
          data: dataFattura,
          cliente: String(cliente).trim(),
          descrizione: String(descrizione).trim(),
          lordo: lordoFinale,
          enasarco: 0,
          netto: nettoFinale,
          incassata: incassi.includes("incassat") || stato.includes("incassat"),
          data_incasso: dataIncasso,
          anno: new Date(dataFattura).getFullYear(),
          categoria: isNotaCredito ? "Nota di credito" : "Import portale FE",
          note: `Import da file: ${file.name}`,
        });
      });
    });

    if (!rowsToInsert.length) {
      alert("Nessuna fattura valida trovata. Il formato del file non è stato riconosciuto.");
      return;
    }

    for (let i = 0; i < rowsToInsert.length; i += 500) {
      const chunk = rowsToInsert.slice(i, i + 500);
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
          {[
            ["dashboard", "Dashboard", BarChart3],
            ["fatture", "Fatture", Receipt],
            ["fiscale", "Fiscale", PiggyBank],
            ["pagamenti", "F24 / Pagamenti", Wallet],
            ["import", "Import Excel", Upload],
          ].map(([id, label, Icon]: any) => (
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
          <button onClick={loadAll} className="ghost">
            {loading ? "Aggiorno..." : "Aggiorna"}
          </button>
        </header>

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
                    <Tooltip formatter={(v: any) => euro(Number(v))} />
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
              <Input label="Numero fattura" value={invoiceForm.numero} onChange={(v: any) => setInvoiceForm({ ...invoiceForm, numero: v })} />
              <Input label="Data fattura" type="date" value={invoiceForm.data} onChange={(v: any) => setInvoiceForm({ ...invoiceForm, data: v })} />
              <Input label="Cliente / società" value={invoiceForm.cliente} onChange={(v: any) => setInvoiceForm({ ...invoiceForm, cliente: v })} />
              <Input label="Descrizione" value={invoiceForm.descrizione} onChange={(v: any) => setInvoiceForm({ ...invoiceForm, descrizione: v })} />
              <Input label="Lordo fattura" type="number" value={invoiceForm.lordo} onChange={(v: any) => setInvoiceForm({ ...invoiceForm, lordo: Number(v) })} />
              <Input label="ENASARCO" type="number" value={invoiceForm.enasarco} onChange={(v: any) => setInvoiceForm({ ...invoiceForm, enasarco: Number(v) })} />
              <Input label="Netto a pagare" type="number" value={invoiceForm.netto} onChange={(v: any) => setInvoiceForm({ ...invoiceForm, netto: Number(v) })} />

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
              <Input label="Aliquota imposta sostitutiva %" type="number" value={yearSettings.aliquota_imposta} onChange={(v: any) => updateSetting("aliquota_imposta", Number(v))} />
              <Input label="Coefficiente redditività %" type="number" value={yearSettings.coefficiente_redditivita} onChange={(v: any) => updateSetting("coefficiente_redditivita", Number(v))} />
              <Input label="Aliquota INPS %" type="number" value={yearSettings.aliquota_inps} onChange={(v: any) => updateSetting("aliquota_inps", Number(v))} />
              <Input label="Minimale INPS" type="number" value={yearSettings.minimale_inps} onChange={(v: any) => updateSetting("minimale_inps", Number(v))} />
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
              <Input label="Data pagamento" type="date" value={paymentForm.data} onChange={(v: any) => setPaymentForm({ ...paymentForm, data: v })} />
              <Input label="Descrizione" value={paymentForm.descrizione} onChange={(v: any) => setPaymentForm({ ...paymentForm, descrizione: v })} />
              <Input label="Importo" type="number" value={paymentForm.importo} onChange={(v: any) => setPaymentForm({ ...paymentForm, importo: Number(v) })} />

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

function Card({ icon, title, value, danger }: any) {
  return (
    <div className={`card ${danger ? "danger" : ""}`}>
      <div className="cardIcon">{icon}</div>
      <p>{title}</p>
      <h2>{value}</h2>
    </div>
  );
}

function Row({ label, value, strong }: any) {
  return (
    <div className={`row ${strong ? "strong" : ""}`}>
      <span>{label}</span>
      <b>{value}</b>
    </div>
  );
}

function Input({ label, value, onChange, type = "text" }: any) {
  return (
    <label className="field">
      {label}
      <input type={type} value={value ?? ""} onChange={(e) => onChange(e.target.value)} />
    </label>
  );
}