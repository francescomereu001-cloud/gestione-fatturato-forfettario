import { useCallback, useEffect, useState } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import { Upload } from "lucide-react";
import * as XLSX from "xlsx";
import { parseBankCsv, parseBankWorkbook } from "../import/parsers/bankStatement";
import { createImportPreview, importReadyRows } from "../services/bankImports";
import type { ImportBatch, ImportRow, ImportRowStatus } from "../types/imports";
import { transactionTypes, type Account, type TransactionCategory, type TransactionType } from "../types/ledger";

export function BankImportPage({ client, userId }: { client: SupabaseClient; userId: string }) {
  const [accounts, setAccounts] = useState<Account[]>([]); const [categories, setCategories] = useState<TransactionCategory[]>([]);
  const [accountId, setAccountId] = useState(""); const [batch, setBatch] = useState<ImportBatch | null>(null); const [rows, setRows] = useState<ImportRow[]>([]);
  const [message, setMessage] = useState(""); const [busy, setBusy] = useState(false);
  const loadBatch = useCallback(async (batchId: string) => {
    const [batchResult, rowsResult] = await Promise.all([
      client.from("import_batches").select("*").eq("id", batchId).eq("user_id", userId).single(),
      client.from("import_rows").select("*").eq("batch_id", batchId).eq("user_id", userId).order("row_index"),
    ]);
    if (batchResult.error || rowsResult.error) throw batchResult.error ?? rowsResult.error;
    setBatch(batchResult.data as ImportBatch); setRows((rowsResult.data ?? []) as ImportRow[]);
  }, [client, userId]);
  useEffect(() => { void Promise.all([
    client.from("accounts").select("*").eq("user_id", userId).eq("is_active", true).order("name"),
    client.from("transaction_categories").select("*").eq("user_id", userId).order("name"),
  ]).then(([accountResult, categoryResult]) => { setAccounts((accountResult.data ?? []) as Account[]); setCategories((categoryResult.data ?? []) as TransactionCategory[]); }); }, [client, userId]);

  const chooseFile = async (file: File) => {
    if (!accountId) { setMessage("Seleziona prima il conto dell’estratto."); return; }
    setBusy(true); setMessage("");
    try {
      const data = await file.arrayBuffer(); const lower = file.name.toLocaleLowerCase();
      if (!lower.endsWith(".csv") && !lower.endsWith(".xlsx")) throw new Error("Formato non supportato: usa CSV o XLSX.");
      const parsed = lower.endsWith(".csv") ? parseBankCsv(new TextDecoder().decode(data)) : parseBankWorkbook(XLSX.read(data, { cellDates: true }));
      if (!parsed.length) throw new Error("Il file non contiene righe leggibili.");
      const batchId = await createImportPreview(client, userId, accountId, file, parsed, data);
      await loadBatch(batchId); setMessage("Previsualizzazione creata. Controlla le righe prima di importare.");
    } catch (error) { setMessage(error instanceof Error ? error.message : "Import non riuscito."); }
    finally { setBusy(false); }
  };
  const updateRow = async (row: ImportRow, changes: Partial<ImportRow>) => {
    if (!row.id) return; const next = { ...row, ...changes }; setRows(rows.map((item) => item.id === row.id ? next : item));
    const { error } = await client.from("import_rows").update(changes).eq("id", row.id).eq("user_id", userId);
    if (error) setMessage(error.message);
  };
  const runImport = async () => {
    if (!batch) return; setBusy(true);
    try { const result = await importReadyRows(client, userId, batch, rows); await loadBatch(batch.id); setMessage(`${result.imported} movimenti importati${result.errors ? `, ${result.errors} errori` : ""}.`); }
    catch (error) { setMessage(error instanceof Error ? error.message : "Import non riuscito."); }
    finally { setBusy(false); }
  };
  const counts = rows.reduce<Record<string, number>>((result, row) => ({ ...result, [row.status]: (result[row.status] ?? 0) + 1 }), {});
  return <section className="panel"><h3>Import movimenti bancari</h3><p className="muted">CSV e XLSX vengono normalizzati in staging. Nessun movimento entra nel ledger prima della conferma.</p>
    <div className="formGrid compact"><label className="field">Conto<select value={accountId} disabled={Boolean(batch)} onChange={event => setAccountId(event.target.value)}><option value="">Seleziona conto</option>{accounts.map(account => <option key={account.id} value={account.id}>{account.name}</option>)}</select></label></div>
    {!batch && <label className="uploadBox"><Upload size={32}/><strong>{busy ? "Analisi…" : "Carica estratto conto"}</strong><span>.csv / .xlsx</span><input type="file" accept=".csv,.xlsx" disabled={busy} onChange={event => { const file = event.target.files?.[0]; if (file) void chooseFile(file); }}/></label>}
    {message && <div className="notice">{message}</div>}
    {batch && <><div className="importSummary"><b>{batch.filename}</b><span>Pronte: {counts.ready ?? 0}</span><span>Possibili duplicati: {counts.possible_duplicate ?? 0}</span><span>Errori: {counts.error ?? 0}</span></div>
      <div className="importTable">{rows.map(row => <div className={`importRow status-${row.status}`} key={row.id ?? row.row_index}>
        <span><input type="date" value={row.transaction_date ?? ""} disabled={row.status === "imported"} onChange={event => void updateRow(row, { transaction_date: event.target.value })}/><small>riga {row.row_index + 1}</small></span>
        <input value={row.description ?? ""} disabled={row.status === "imported"} onChange={event => void updateRow(row, { description: event.target.value })}/>
        <input type="number" step="0.01" value={row.amount ?? ""} disabled={row.status === "imported"} onChange={event => void updateRow(row, { amount: Number(event.target.value) })}/>
        <select value={row.suggested_transaction_type ?? "unclassified"} disabled={row.status === "imported"} onChange={event => void updateRow(row, { suggested_transaction_type: event.target.value as TransactionType })}>{transactionTypes.map(type => <option key={type}>{type}</option>)}</select>
        <select value={row.suggested_category_id ?? ""} disabled={row.status === "imported"} onChange={event => void updateRow(row, { suggested_category_id: event.target.value || null })}><option value="">Nessuna categoria</option>{categories.map(category => <option key={category.id} value={category.id}>{category.name}</option>)}</select>
        <select value={row.status} disabled={row.status === "imported" || row.status === "error"} onChange={event => void updateRow(row, { status: event.target.value as ImportRowStatus })}><option value="ready">Importa</option><option value="duplicate">Duplicato</option><option value="ignored">Ignora</option>{row.status === "possible_duplicate" && <option value="possible_duplicate">Da verificare</option>}<option value="imported" disabled>Importato</option><option value="error" disabled>Errore</option></select>
      </div>)}</div>
      {batch.status === "preview" || batch.status === "failed" ? <button className="primary mt" disabled={busy || !(counts.ready > 0)} onClick={() => void runImport()}>Importa {counts.ready ?? 0} movimenti</button> : null}
      <button className="ghost mt" onClick={() => { setBatch(null); setRows([]); setAccountId(""); setMessage(""); }}>Nuovo import</button>
    </>}
  </section>;
}
