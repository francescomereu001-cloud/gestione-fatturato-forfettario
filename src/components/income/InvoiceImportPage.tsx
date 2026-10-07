import { useState } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import { XLSX } from "../../import/parsers/workbook";
import { parseArubaInvoiceWorkbook } from "../../import/parsers/invoiceExcel";
import {
  stageInvoiceImport,
  commitInvoiceImport,
  loadInvoiceImportRows,
  incomeError,
} from "../../services/income";
import type { InvoiceImportBatch, InvoiceImportRow } from "../../types/income";
import { Button } from "../ui/Button";
import { fiscalMoney } from "../ui/fiscalLabels";
const statuses: Record<string, string> = {
  new: "Nuova",
  existing_unchanged: "Già presente · invariata",
  exact_duplicate: "Duplicato esatto nel report",
  conflict: "Conflitto · preservata",
  rejected: "Scartata",
  inserted: "Inserita",
};
const warningLabels: Record<string, string> = {
  enasarco_missing_in_source:
    "ENASARCO assente nel report: dato da verificare, non ricostruito dal netto",
  gross_enasarco_net_mismatch:
    "Lordo meno ENASARCO diverso dal netto: valori originali preservati",
  signed_document_type_unverified: "Documento negativo: tipo da verificare",
  amount_sign_mismatch: "Segni degli importi da verificare",
};
export function InvoiceImportPage({
  client,
  onSaved,
}: {
  client: SupabaseClient;
  onSaved: () => Promise<void>;
}) {
  const [batch, setBatch] = useState<InvoiceImportBatch | null>(null);
  const [rows, setRows] = useState<InvoiceImportRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const choose = async (file: File) => {
    setBusy(true);
    setError("");
    setMessage("");
    setBatch(null);
    setRows([]);
    try {
      if (file.size > 20 * 1024 * 1024)
        throw new Error("Report troppo grande: il limite è 20 MB.");
      if (!/\.xlsx?$/i.test(file.name))
        throw new Error("Scegli un report Aruba .xls o .xlsx.");
      const parsed = parseArubaInvoiceWorkbook(
        XLSX.read(await file.arrayBuffer(), { cellDates: false }),
      );
      const staged = await stageInvoiceImport(client, file.name, parsed);
      setBatch(staged);
      setRows(await loadInvoiceImportRows(client, staged.id));
    } catch (e) {
      setError(incomeError(e));
    } finally {
      setBusy(false);
    }
  };
  const commit = async () => {
    if (!batch) return;
    setBusy(true);
    setError("");
    try {
      const committed = await commitInvoiceImport(client, batch.id);
      setBatch(committed);
      setMessage(
        `Commit completato: ${committed.inserted_count} inserite, ${committed.duplicate_count} già presenti, ${committed.conflict_count} conflitti, ${committed.rejected_count} scartate.`,
      );
      await onSaved();
      setRows(await loadInvoiceImportRows(client, batch.id));
    } catch (e) {
      setError(
        `Commit o aggiornamento della vista fallito: ${incomeError(e)} Puoi riprovare lo stesso batch senza duplicare fatture.`,
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="panel" aria-busy={busy}>
      <h3>Import Income · Aruba</h3>
      <p>
        1. Scegli il report · 2. Verifica la preview · 3. Conferma il commit.
      </p>
      <p>
        Ogni fattura è considerata incassata alla data documento. Il report
        cumulativo può essere ricaricato; i conflitti conservano la fattura
        esistente.
      </p>
      <label className="field">
        Report fatture inviate (.xls / .xlsx)
        <input
          type="file"
          accept=".xls,.xlsx"
          disabled={busy}
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void choose(file);
            e.target.value = "";
          }}
        />
      </label>
      {busy && <p role="status">Elaborazione in corso…</p>}
      {error && (
        <p className="notice" role="alert">
          {error}
        </p>
      )}
      {message && <p role="status">{message}</p>}
      {batch && (
        <>
          <h4>
            {batch.file_name} ·{" "}
            {batch.status === "staged" ? "Preview server" : "Import registrato"}
          </h4>
          <p>
            Nuove/inserite: {batch.inserted_count} · Già presenti:{" "}
            {batch.duplicate_count} · Conflitti: {batch.conflict_count} ·
            Scartate: {batch.rejected_count}
          </p>
          {batch.duplicate_count === batch.row_count && (
            <p>Tutte le righe sono già presenti: nessuna nuova fattura.</p>
          )}
          {batch.rejected_count === batch.row_count && (
            <p role="alert">
              Tutte le righe sono non valide: verifica date e importi
              obbligatori.
            </p>
          )}
          {batch.conflict_count > 0 && (
            <p className="notice">
              Conflitti esclusi dall’inserimento: confronta numero, data,
              cliente e importi con Income. Nessuna variazione viene applicata
              automaticamente.
            </p>
          )}
          {batch.status === "staged" && (
            <Button disabled={busy} onClick={() => void commit()}>
              Conferma import delle nuove fatture
            </Button>
          )}
          <div className="incomeTable">
            <table>
              <thead>
                <tr>
                  <th>Riga</th>
                  <th>Documento</th>
                  <th>Cliente</th>
                  <th>Lordo</th>
                  <th>ENASARCO</th>
                  <th>Netto</th>
                  <th>Esito / warning</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.id}>
                    <td>{row.row_index}</td>
                    <td>
                      {row.normalized_data?.numero} ·{" "}
                      {row.normalized_data?.data}
                    </td>
                    <td>{row.normalized_data?.cliente}</td>
                    <td>{fiscalMoney(row.normalized_data?.lordo)}</td>
                    <td>{fiscalMoney(row.normalized_data?.enasarco)}</td>
                    <td>{fiscalMoney(row.normalized_data?.netto)}</td>
                    <td>
                      {statuses[row.status]}
                      {row.warning_codes.map((w) => (
                        <p key={w}>{warningLabels[w] ?? w}</p>
                      ))}
                      {row.rejection_code && (
                        <p>
                          Valori obbligatori non validi o tipo documento non
                          supportato.
                        </p>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <details className="technicalDetails">
            <summary>Dettagli audit</summary>
            <p>
              Batch {batch.id}. Parser aruba_invoice_report_v1. I conteggi
              vengono ricalcolati al commit. Senza colonna ENASARCO, la
              trattenuta è la differenza fra totale documento e netto, secondo
              la policy confermata.
            </p>
          </details>
        </>
      )}
    </section>
  );
}
