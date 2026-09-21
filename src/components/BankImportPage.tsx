import { useCallback, useEffect, useState } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import { Upload } from "lucide-react";
import * as XLSX from "xlsx";
import { fingerprint, mappingFields, normalizeBankRows, readCsv, readWorkbook, suggestColumnMapping, type ColumnMapping, type ReadBankFile } from "../import/parsers/bankStatement";
import { commitImportBatch, createImportPreview } from "../services/bankImports";
import type { ImportBatch, ImportRow, ImportRowStatus } from "../types/imports";
import { transactionTypes, type Account, type TransactionCategory, type TransactionType } from "../types/ledger";

const mappingLabels: Record<(typeof mappingFields)[number], string> = {
  transaction_date: "Data operazione", booking_date: "Data contabile", amount: "Importo singolo",
  debit: "Addebito", credit: "Accredito", description: "Descrizione", merchant: "Controparte", external_id: "ID esterno",
};

type PendingFile = { file: File; data: ArrayBuffer; read: ReadBankFile };

export function BankImportPage({ client, userId }: { client: SupabaseClient; userId: string }) {
  const [accounts, setAccounts] = useState<Account[]>([]); const [categories, setCategories] = useState<TransactionCategory[]>([]);
  const [history, setHistory] = useState<ImportBatch[]>([]); const [accountId, setAccountId] = useState("");
  const [batch, setBatch] = useState<ImportBatch | null>(null); const [rows, setRows] = useState<ImportRow[]>([]);
  const [pending, setPending] = useState<PendingFile | null>(null); const [mapping, setMapping] = useState<ColumnMapping>({});
  const [message, setMessage] = useState(""); const [busy, setBusy] = useState(false);

  const loadHistory = useCallback(async () => {
    const result = await client.from("import_batches").select("*").eq("user_id", userId).order("created_at", { ascending: false });
    if (!result.error) setHistory((result.data ?? []) as ImportBatch[]);
  }, [client, userId]);
  const loadBatch = useCallback(async (batchId: string) => {
    const [batchResult, rowsResult] = await Promise.all([
      client.from("import_batches").select("*").eq("id", batchId).eq("user_id", userId).single(),
      client.from("import_rows").select("*").eq("batch_id", batchId).eq("user_id", userId).order("row_index"),
    ]);
    if (batchResult.error || rowsResult.error) throw batchResult.error ?? rowsResult.error;
    const loaded = batchResult.data as ImportBatch; setBatch(loaded); setAccountId(loaded.account_id); setRows((rowsResult.data ?? []) as ImportRow[]);
  }, [client, userId]);
  useEffect(() => { void Promise.all([
    client.from("accounts").select("*").eq("user_id", userId).eq("is_active", true).order("name"),
    client.from("transaction_categories").select("*").eq("user_id", userId).order("name"),
    client.from("import_batches").select("*").eq("user_id", userId).order("created_at", { ascending: false }),
  ]).then(([accountResult, categoryResult, historyResult]) => { setAccounts((accountResult.data ?? []) as Account[]); setCategories((categoryResult.data ?? []) as TransactionCategory[]); setHistory((historyResult.data ?? []) as ImportBatch[]); }); }, [client, userId]);

  const readFile = async (file: File) => {
    if (!accountId) { setMessage("Seleziona prima il conto dell’estratto."); return; }
    setBusy(true); setMessage("");
    try {
      const data = await file.arrayBuffer(); const lower = file.name.toLocaleLowerCase();
      if (!lower.endsWith(".csv") && !lower.endsWith(".xlsx")) throw new Error("Formato non supportato: usa CSV o XLSX.");
      const read = lower.endsWith(".csv") ? readCsv(new TextDecoder().decode(data)) : readWorkbook(XLSX.read(data, { cellDates: true }));
      if (!read.rows.length) throw new Error("Il file non contiene righe leggibili.");
      setPending({ file, data, read }); setMapping(suggestColumnMapping(read.headers));
    } catch (error) { setMessage(error instanceof Error ? error.message : "Lettura non riuscita."); }
    finally { setBusy(false); }
  };
  const createPreview = async () => {
    if (!pending) return; setBusy(true);
    try {
      const parsed = normalizeBankRows(pending.read.rows, mapping);
      const batchId = await createImportPreview(client, userId, accountId, pending.file, parsed, pending.data);
      setPending(null); await loadBatch(batchId); await loadHistory(); setMessage("Previsualizzazione creata. Controlla le righe prima di importare.");
    } catch (error) { setMessage(error instanceof Error ? error.message : "Import non riuscito."); }
    finally { setBusy(false); }
  };
  const updateRow = async (row: ImportRow, changes: Partial<ImportRow>) => {
    if (!row.id) return;
    const next = { ...row, ...changes };
    const canonicalChanged = "transaction_date" in changes || "amount" in changes || "description" in changes;
    if (canonicalChanged) next.dedupe_fingerprint = fingerprint(next);
    const persisted = canonicalChanged ? { ...changes, dedupe_fingerprint: next.dedupe_fingerprint } : changes;
    setRows((current) => current.map((item) => item.id === row.id ? next : item));
    const { error } = await client.from("import_rows").update(persisted).eq("id", row.id).eq("user_id", userId);
    if (error) setMessage(error.message);
  };
  const runImport = async () => {
    if (!batch) return; setBusy(true);
    try {
      // Recompute and persist from the displayed canonical values before the atomic DB commit.
      const canonical = rows.filter((row) => row.id && row.status === "ready").map((row) => ({ id: row.id!, dedupe_fingerprint: fingerprint(row) }));
      for (const item of canonical) {
        const result = await client.from("import_rows").update({ dedupe_fingerprint: item.dedupe_fingerprint }).eq("id", item.id).eq("user_id", userId);
        if (result.error) throw result.error;
      }
      const imported = await commitImportBatch(client, batch.id); await loadBatch(batch.id); await loadHistory(); setMessage(`${imported} movimenti importati atomicamente.`);
    } catch (error) { setMessage(error instanceof Error ? error.message : "Import non riuscito: nessun movimento è stato registrato."); }
    finally { setBusy(false); }
  };
  const reset = () => { setBatch(null); setRows([]); setPending(null); setMapping({}); setAccountId(""); setMessage(""); };
  const counts = rows.reduce<Record<string, number>>((result, row) => ({ ...result, [row.status]: (result[row.status] ?? 0) + 1 }), {});

  return <section className="panel"><h3>Import movimenti bancari</h3><p className="muted">CSV e XLSX vengono mappati e normalizzati in staging. Il commit del batch è atomico.</p>
    {!batch && <div className="formGrid compact"><label className="field">Conto<select value={accountId} disabled={Boolean(pending)} onChange={event => setAccountId(event.target.value)}><option value="">Seleziona conto</option>{accounts.map(account => <option key={account.id} value={account.id}>{account.name}</option>)}</select></label></div>}
    {!batch && !pending && <label className="uploadBox"><Upload size={32}/><strong>{busy ? "Lettura…" : "Carica estratto conto"}</strong><span>.csv / .xlsx</span><input type="file" accept=".csv,.xlsx" disabled={busy} onChange={event => { const file = event.target.files?.[0]; if (file) void readFile(file); }}/></label>}
    {pending && <div className="mappingPanel"><h4>Mappa le colonne di {pending.file.name}</h4><div className="formGrid">{mappingFields.map(field => <label className="field" key={field}>{mappingLabels[field]}<select value={mapping[field] ?? ""} onChange={event => setMapping({ ...mapping, [field]: event.target.value || undefined })}><option value="">Non mappata</option>{pending.read.headers.map(header => <option key={header}>{header}</option>)}</select></label>)}</div><button className="primary" disabled={busy || !mapping.transaction_date || !mapping.description || (!mapping.amount && !mapping.debit && !mapping.credit)} onClick={() => void createPreview()}>Crea preview</button> <button className="ghost" onClick={reset}>Annulla</button></div>}
    {message && <div className="notice">{message}</div>}
    {batch && <><div className="importSummary"><b>{batch.filename}</b><span>Pronte: {counts.ready ?? 0}</span><span>Possibili duplicati: {counts.possible_duplicate ?? 0}</span><span>Duplicati: {counts.duplicate ?? 0}</span><span>Errori: {counts.error ?? 0}</span></div>
      <div className="importTable">{rows.map(row => <div className={`importRow status-${row.status}`} key={row.id ?? row.row_index}>
        <span><input type="date" value={row.transaction_date ?? ""} disabled={batch.status !== "preview" || row.status === "imported" || row.status === "duplicate"} onChange={event => void updateRow(row, { transaction_date: event.target.value })}/><small>riga {row.row_index + 1}</small></span>
        <input value={row.description ?? ""} disabled={batch.status !== "preview" || row.status === "imported" || row.status === "duplicate"} onChange={event => void updateRow(row, { description: event.target.value })}/>
        <input type="number" step="0.01" value={row.amount ?? ""} disabled={batch.status !== "preview" || row.status === "imported" || row.status === "duplicate"} onChange={event => void updateRow(row, { amount: Number(event.target.value) })}/>
        <select value={row.suggested_transaction_type ?? "unclassified"} disabled={batch.status !== "preview" || row.status === "imported" || row.status === "duplicate"} onChange={event => void updateRow(row, { suggested_transaction_type: event.target.value as TransactionType })}>{transactionTypes.map(type => <option key={type}>{type}</option>)}</select>
        <select value={row.suggested_category_id ?? ""} disabled={batch.status !== "preview" || row.status === "imported" || row.status === "duplicate"} onChange={event => void updateRow(row, { suggested_category_id: event.target.value || null })}><option value="">Nessuna categoria</option>{categories.map(category => <option key={category.id} value={category.id}>{category.name}</option>)}</select>
        <select value={row.status} disabled={batch.status !== "preview" || row.status === "imported" || row.status === "error" || row.status === "duplicate"} onChange={event => void updateRow(row, { status: event.target.value as ImportRowStatus })}><option value="ready">Importa</option><option value="duplicate">Duplicato</option><option value="ignored">Ignora</option>{row.status === "possible_duplicate" && <option value="possible_duplicate">Da verificare</option>}<option value="imported" disabled>Importato</option><option value="error" disabled>Errore</option></select>
      </div>)}</div>
      {batch.status === "preview" ? <button className="primary mt" disabled={busy || !(counts.ready > 0)} onClick={() => void runImport()}>Importa atomicamente {counts.ready ?? 0} movimenti</button> : null} <button className="ghost mt" onClick={reset}>Chiudi dettaglio</button>
    </>}
    {!pending && !batch && <div className="mt"><h3>Storico import</h3><div className="historyTable">{history.map(item => <div className="historyRow" key={item.id}><span><b>{item.filename || "—"}</b><small>{accounts.find(account => account.id === item.account_id)?.name || item.account_id}</small></span><span>{item.created_at ? new Date(item.created_at).toLocaleString("it-IT") : "—"}</span><span>{item.status}</span><span>{item.row_count} righe</span><span>{item.imported_count} importate</span><span>{item.duplicate_count} duplicate</span><span>{item.ignored_count} ignorate</span><span>{item.error_count} errori</span><button className="ghost" onClick={() => void loadBatch(item.id)}>Apri dettaglio</button></div>)}</div></div>}
  </section>;
}
