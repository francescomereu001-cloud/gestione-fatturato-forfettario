import { useState } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { TaxPayment } from "../../types/finance";
import { FiscalPaymentAllocations } from "../FiscalPaymentAllocations";
import { Button } from "../ui/Button";
import { incomeError } from "../../services/income";
export function TaxPaymentsPage({
  client,
  userId,
  year,
  payments,
  onSaved,
}: {
  client: SupabaseClient;
  userId: string;
  year: number;
  payments: TaxPayment[];
  onSaved: () => Promise<void>;
}) {
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [description, setDescription] = useState("");
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const save = async () => {
    setBusy(true);
    setMessage("");
    try {
      const { error } = await client
        .from("tax_payments")
        .insert({
          user_id: userId,
          anno: Number(date.slice(0, 4)),
          data: date,
          descrizione: description,
          importo: Number(amount),
          tipo: "F24",
          fiscal_allocation_status: "unallocated",
        });
      if (error) throw error;
      await onSaved();
      setAmount("");
      setDescription("");
      setMessage(
        "F24 registrato. Se conosci la competenza, attribuiscilo qui sotto.",
      );
    } catch (e) {
      setMessage(incomeError(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <section className="panel">
        <h3>Registra F24</h3>
        <p>
          1. Registra importo e data · 2. Attribuisci competenza e tipo, se
          noti. Un F24 non attribuito non riduce la Tax Reserve.
        </p>
        <div className="formGrid">
          <label className="field">
            Data pagamento
            <input
              type="date"
              value={date}
              disabled={busy}
              onChange={(e) => setDate(e.target.value)}
            />
          </label>
          <label className="field">
            Descrizione
            <input
              value={description}
              disabled={busy}
              onChange={(e) => setDescription(e.target.value)}
            />
          </label>
          <label className="field">
            Importo
            <input
              type="number"
              min="0.01"
              step="0.01"
              value={amount}
              disabled={busy}
              onChange={(e) => setAmount(e.target.value)}
            />
          </label>
        </div>
        <Button
          disabled={
            busy || !date || !description.trim() || !(Number(amount) > 0)
          }
          onClick={() => void save()}
        >
          Registra F24 non attribuito
        </Button>
        {message && <p role="status">{message}</p>}
      </section>
      <FiscalPaymentAllocations
        client={client}
        userId={userId}
        year={year}
        payments={payments}
        onSaved={onSaved}
      />
    </>
  );
}
