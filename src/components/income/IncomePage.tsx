import { useState } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  ResponsiveContainer,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
} from "recharts";
import type {
  IncomeSummary,
  IncomeInvoice,
  InvoiceDocument,
} from "../../types/income";
import {
  stageInvoiceImport,
  commitInvoiceImport,
  incomeError,
} from "../../services/income";
import { StatCard } from "../ui/StatCard";
import { fiscalMoney } from "../ui/fiscalLabels";
import { Button } from "../ui/Button";
export function IncomePage({
  client,
  summary,
  invoices,
  error,
  onSaved,
}: {
  client: SupabaseClient;
  summary: IncomeSummary | null;
  invoices: IncomeInvoice[];
  error: string;
  onSaved: () => Promise<void>;
}) {
  const [form, setForm] = useState<InvoiceDocument>({
    numero: "",
    data: new Date().toISOString().slice(0, 10),
    cliente: "",
    descrizione: "",
    lordo: 0,
    enasarco: 0,
    netto: 0,
    document_type: "invoice",
  });
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const save = async () => {
    setBusy(true);
    setMessage("");
    try {
      const batch = await stageInvoiceImport(client, "Inserimento manuale", {
        parser_key: "manual_invoice_v1",
        rows: [
          {
            row_index: 1,
            raw_data: { ...form },
            normalized_data: form,
            warning_codes: [],
          },
        ],
      });
      const result = await commitInvoiceImport(client, batch.id);
      await onSaved();
      setMessage(
        result.inserted_count
          ? "Documento registrato e riepiloghi aggiornati."
          : result.conflict_count
            ? "Conflitto: il documento esistente è stato preservato."
            : result.rejected_count
              ? "Documento non valido: verifica i campi."
              : "Documento già presente.",
      );
    } catch (e) {
      setMessage(incomeError(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <p>
        Fattura = incassata alla data documento. I movimenti bancari alimentano
        liquidità e cashflow; non aggiungono reddito a questi valori.
      </p>
      {error && (
        <p role="alert" className="notice">
          {error}
        </p>
      )}
      <div className="cards">
        <StatCard
          title="Lordo anno"
          value={fiscalMoney(summary?.gross_invoiced)}
        />
        <StatCard
          title="ENASARCO trattenuto"
          value={fiscalMoney(summary?.enasarco_withheld)}
        />
        <StatCard
          title="Netto percepito"
          value={fiscalMoney(summary?.net_income)}
        />
      </div>
      {summary && (
        <section className="panel">
          <p>
            {summary.invoice_count} documenti · Note di credito:{" "}
            {fiscalMoney(summary.credit_notes_total)} · Fonte: fatture · Stato:{" "}
            {summary.source_status === "available"
              ? "Disponibile, completezza da verificare sul report"
              : summary.source_status === "incomplete"
                ? "Dati incompleti"
                : "Da verificare"}
          </p>
          <p>
            Dal {summary.first_invoice_date ?? "—"} al{" "}
            {summary.last_invoice_date ?? "—"} · Situazione al {summary.as_of}
          </p>
          <p>
            Ultimo import:{" "}
            {summary.latest_import?.file_name ?? "Nessun batch registrato"} ·{" "}
            {summary.latest_import?.status ?? "—"} · Warning:{" "}
            {summary.warning_count} · Conflitti: {summary.conflict_count}
          </p>
          <h3>Andamento mensile</h3>
          <ResponsiveContainer width="100%" height={240}>
            <BarChart data={summary.monthly}>
              <XAxis dataKey="month" />
              <YAxis />
              <Tooltip formatter={(v) => fiscalMoney(Number(v))} />
              <Bar dataKey="gross" name="Lordo" fill="var(--fm-primary)" />
            </BarChart>
          </ResponsiveContainer>
        </section>
      )}
      <section className="panel">
        <h3>Elenco documenti</h3>
        <div className="incomeTable">
          <table>
            <thead>
              <tr>
                <th>Data</th>
                <th>N.</th>
                <th>Cliente</th>
                <th>Lordo</th>
                <th>ENASARCO</th>
                <th>Netto</th>
                <th>Fonte / tipo</th>
              </tr>
            </thead>
            <tbody>
              {invoices.map((i) => (
                <tr key={i.id}>
                  <td>{i.data}</td>
                  <td>{i.numero}</td>
                  <td>{i.cliente}</td>
                  <td>{fiscalMoney(i.lordo)}</td>
                  <td>{fiscalMoney(i.enasarco)}</td>
                  <td>{fiscalMoney(i.netto)}</td>
                  <td>
                    {i.source ?? "Legacy"} · {i.document_type ?? i.categoria}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!invoices.length && (
          <p>Nessun documento per questo anno. Importa un report Aruba.</p>
        )}
      </section>
      <section className="panel">
        <details>
          <summary>Registra un documento manualmente</summary>
          <p>
            Inserisci gli importi documentali: il netto non viene ricostruito
            automaticamente.
          </p>
          <div className="formGrid">
            {(
              [
                "numero",
                "data",
                "cliente",
                "descrizione",
                "lordo",
                "enasarco",
                "netto",
              ] as const
            ).map((key) => (
              <label className="field" key={key}>
                {
                  (
                    {
                      numero: "Numero",
                      data: "Data documento",
                      cliente: "Cliente",
                      descrizione: "Descrizione",
                      lordo: "Lordo",
                      enasarco: "ENASARCO",
                      netto: "Netto",
                    } as const
                  )[key]
                }
                <input
                  disabled={busy}
                  type={
                    key === "data"
                      ? "date"
                      : ["lordo", "enasarco", "netto"].includes(key)
                        ? "number"
                        : "text"
                  }
                  step="0.01"
                  value={form[key] ?? ""}
                  onChange={(e) =>
                    setForm({
                      ...form,
                      [key]: ["lordo", "enasarco", "netto"].includes(key)
                        ? Number(e.target.value)
                        : e.target.value,
                    })
                  }
                />
              </label>
            ))}
            <label className="field">
              Tipo documento
              <select
                value={form.document_type}
                onChange={(e) =>
                  setForm({
                    ...form,
                    document_type: e.target
                      .value as InvoiceDocument["document_type"],
                  })
                }
              >
                <option value="invoice">Fattura</option>
                <option value="credit_note">Nota di credito TD04</option>
              </select>
            </label>
          </div>
          <Button
            disabled={
              busy || !form.numero.trim() || !form.cliente.trim() || !form.data
            }
            onClick={() => void save()}
          >
            Registra documento
          </Button>
          {message && <p role="status">{message}</p>}
        </details>
      </section>
    </>
  );
}
