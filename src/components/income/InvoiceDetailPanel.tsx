import { useEffect, useRef, useState } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { InvoiceCorrection, InvoiceDetail } from "../../types/income";
import {
  incomeError,
  loadInvoiceDetail,
  saveInvoiceCorrection,
} from "../../services/income";
import { Button } from "../ui/Button";
import { fiscalMoney } from "../ui/fiscalLabels";

type AmountFields = {
  lordo: string;
  enasarco: string;
  netto: string;
  descrizione: string;
};
const fields = {
  lordo: "Totale documento",
  enasarco: "ENASARCO",
  netto: "Netto a pagare",
} as const;
const actions: Record<string, string> = {
  manual: "Correzione manuale",
  recalculate: "Ricalcolo ENASARCO",
  apply_import: "Import applicato",
  keep_existing: "Valori esistenti mantenuti",
};
export function InvoiceDetailPanel({
  client,
  invoiceId,
  onSaved,
  onClose,
}: {
  client: SupabaseClient;
  invoiceId: string;
  onSaved: () => Promise<void>;
  onClose: () => void;
}) {
  const [detail, setDetail] = useState<InvoiceDetail | null>(null);
  const [form, setForm] = useState<AmountFields>({
    lordo: "",
    enasarco: "",
    netto: "",
    descrizione: "",
  });
  const [derive, setDerive] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const heading = useRef<HTMLHeadingElement>(null);
  const replaceDetail = (value: InvoiceDetail) => {
    setDetail(value);
    const i = value.invoice;
    setForm({
      lordo: String(i.lordo ?? ""),
      enasarco: String(i.enasarco ?? ""),
      netto: String(i.netto ?? ""),
      descrizione: i.descrizione ?? "",
    });
    setDerive(false);
  };
  useEffect(() => {
    let active = true;
    heading.current?.focus();
    loadInvoiceDetail(client, invoiceId)
      .then((d) => {
        if (active) replaceDetail(d);
      })
      .catch((e: unknown) => {
        if (active) setError(incomeError(e));
      })
      .finally(() => {
        if (active) setBusy(false);
      });
    return () => {
      active = false;
    };
  }, [client, invoiceId]);
  const delta =
    form.lordo.trim() && form.netto.trim()
      ? Math.round((Number(form.lordo) - Number(form.netto)) * 100) / 100
      : null;
  const valid = [
    form.lordo,
    form.netto,
    ...(derive ? [] : [form.enasarco]),
  ].every(
    (v) =>
      v.trim() !== "" &&
      Number.isFinite(Number(v)) &&
      Math.abs(Number(v)) < 1e12,
  );
  const save = async (
    action: InvoiceCorrection["edit_action"],
    rowId: string | null = null,
  ) => {
    if (!detail) return;
    setBusy(true);
    setError("");
    setMessage("");
    let persisted = false;
    try {
      await saveInvoiceCorrection(client, {
        target_invoice: invoiceId,
        expected_version: detail.invoice.edit_version,
        edit_action: action,
        conflict_row: rowId,
        edit_reason: reason.trim(),
        amounts: {
          lordo: Number(form.lordo),
          netto: Number(form.netto),
          enasarco: derive ? delta : Number(form.enasarco),
          descrizione: form.descrizione,
        },
      });
      persisted = true;
      replaceDetail(await loadInvoiceDetail(client, invoiceId));
      await onSaved();
      setReason("");
      setMessage(
        "Modifica salvata. Riepiloghi aggiornati e precedente versione conservata nello storico.",
      );
    } catch (e) {
      setError(
        `${persisted ? "Modifica salvata, ma aggiornamento della vista fallito. Riapri il dettaglio. " : ""}${incomeError(e)}`,
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <section
      className="panel"
      aria-labelledby="invoice-detail-title"
      aria-busy={busy}
    >
      <h3 id="invoice-detail-title" tabIndex={-1} ref={heading}>
        Dettaglio fattura {detail?.invoice.numero ?? ""}
      </h3>
      <Button variant="secondary" disabled={busy} onClick={onClose}>
        Chiudi dettaglio
      </Button>
      {busy && <p role="status">Caricamento o salvataggio in corso…</p>}
      {error && (
        <p role="alert" className="notice">
          {error}
        </p>
      )}
      {message && <p role="status">{message}</p>}
      {detail && (
        <>
          <p>
            {detail.invoice.cliente} · {detail.invoice.data} ·{" "}
            {detail.invoice.document_type ??
              detail.invoice.categoria ??
              "Documento"}
          </p>
          <p>
            Correggi gli importi del documento. Numero, data e cliente
            identificano la fattura e restano invariati.
          </p>
          <div className="formGrid">
            {(Object.keys(fields) as Array<keyof typeof fields>).map((key) => (
              <label className="field" key={key}>
                {fields[key]}
                <input
                  type="number"
                  step="0.01"
                  disabled={busy || (key === "enasarco" && derive)}
                  value={
                    key === "enasarco" && derive ? (delta ?? "") : form[key]
                  }
                  onChange={(e) => setForm({ ...form, [key]: e.target.value })}
                />
              </label>
            ))}
            <label className="field">
              Descrizione
              <input
                maxLength={4000}
                value={form.descrizione}
                disabled={busy}
                onChange={(e) =>
                  setForm({ ...form, descrizione: e.target.value })
                }
              />
            </label>
          </div>
          <label className="field">
            <span>
              <input
                type="checkbox"
                checked={derive}
                disabled={busy}
                onChange={(e) => setDerive(e.target.checked)}
              />{" "}
              Ricalcola ENASARCO = totale documento − netto a pagare
            </span>
          </label>
          <p>
            Differenza lordo/netto: {fiscalMoney(delta)}. Attiva il ricalcolo
            quando la differenza rappresenta interamente la tua trattenuta
            ENASARCO. Per le note di credito usa importi negativi.
          </p>
          <label className="field">
            Motivo della modifica o della risoluzione
            <input
              value={reason}
              maxLength={1000}
              disabled={busy}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Es. recupero trattenuta dal report Aruba"
            />
          </label>
          <Button
            disabled={busy || !valid || !reason.trim()}
            onClick={() => void save(derive ? "recalculate" : "manual")}
          >
            Salva correzione
          </Button>
          <h4>Conflitti di importazione ({detail.conflicts.length})</h4>
          <p>
            Confronta i valori. “Applica import” usa gli importi del report
            indicato; “Mantieni esistente” chiude soltanto quel conflitto. Le
            modifiche non salvate del modulo non vengono applicate da questi
            pulsanti.
          </p>
          {detail.conflicts.map((row) => (
            <div className="panel" key={row.id}>
              <p>
                {row.file_name} · riga {row.row_index} ·{" "}
                {row.normalized_data?.numero} · {row.normalized_data?.data} ·{" "}
                {row.normalized_data?.cliente}
              </p>
              <div className="incomeTable">
                <table>
                  <thead>
                    <tr>
                      <th>Campo</th>
                      <th>Esistente</th>
                      <th>Report importato</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(Object.keys(fields) as Array<keyof typeof fields>).map(
                      (key) => (
                        <tr key={key}>
                          <th>{fields[key]}</th>
                          <td>{fiscalMoney(detail.invoice[key])}</td>
                          <td>{fiscalMoney(row.normalized_data?.[key])}</td>
                        </tr>
                      ),
                    )}
                    <tr>
                      <th>Descrizione</th>
                      <td>{detail.invoice.descrizione || "—"}</td>
                      <td>{row.normalized_data?.descrizione || "—"}</td>
                    </tr>
                  </tbody>
                </table>
              </div>
              <Button
                disabled={busy || !reason.trim()}
                onClick={() => void save("apply_import", row.id)}
              >
                Applica import della riga {row.row_index}
              </Button>{" "}
              <Button
                variant="secondary"
                disabled={busy || !reason.trim()}
                onClick={() => void save("keep_existing", row.id)}
              >
                Mantieni esistente per riga {row.row_index}
              </Button>
            </div>
          ))}
          {!detail.conflicts.length && (
            <p>Nessun conflitto collegato a questa fattura.</p>
          )}
          <h4>Storico modifiche</h4>
          {!detail.revisions.length && <p>Nessuna correzione registrata.</p>}
          {detail.revisions.map((r) => (
            <details key={r.id}>
              <summary>
                {new Date(r.created_at).toLocaleString("it-IT")} ·{" "}
                {actions[r.action] ?? r.action} · {r.reason}
              </summary>
              <div className="incomeTable">
                <table>
                  <thead>
                    <tr>
                      <th>Campo</th>
                      <th>Prima</th>
                      <th>Dopo</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(Object.keys(fields) as Array<keyof typeof fields>).map(
                      (key) => (
                        <tr key={key}>
                          <th>{fields[key]}</th>
                          <td>{fiscalMoney(r.before_data[key])}</td>
                          <td>{fiscalMoney(r.after_data[key])}</td>
                        </tr>
                      ),
                    )}
                    <tr>
                      <th>Descrizione</th>
                      <td>{r.before_data.descrizione}</td>
                      <td>{r.after_data.descrizione}</td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </details>
          ))}
        </>
      )}
    </section>
  );
}
