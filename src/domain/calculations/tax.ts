import type { Invoice, TaxPayment, TaxSettings } from "../../types/finance";

export type TaxSummary = {
  fatturato: number;
  enasarco: number;
  netto: number;
  incassato: number;
  daIncassare: number;
  imponibile: number;
  imposta: number;
  inps: number;
  tasseTotali: number;
  pagato: number;
  residuo: number;
  accantonamentoConsigliato: number;
  disponibilitaStimata: number;
};

export const defaultTaxSettings = (anno: number): TaxSettings => ({
  anno,
  aliquota_imposta: anno <= 2025 ? 5 : 15,
  coefficiente_redditivita: 78,
  aliquota_inps: 24.48,
  minimale_inps: 18808,
});

export function calculateTaxSummary(
  invoices: Invoice[],
  payments: TaxPayment[],
  settings: TaxSettings,
): TaxSummary {
  const fatturato = invoices.reduce((total, invoice) => total + Number(invoice.lordo || 0), 0);
  const enasarco = invoices.reduce((total, invoice) => total + Number(invoice.enasarco || 0), 0);
  const netto = invoices.reduce((total, invoice) => total + Number(invoice.netto || 0), 0);
  const incassato = invoices
    .filter((invoice) => invoice.incassata)
    .reduce((total, invoice) => total + Number(invoice.netto || invoice.lordo || 0), 0);
  const daIncassare = invoices
    .filter((invoice) => !invoice.incassata)
    .reduce((total, invoice) => total + Number(invoice.netto || invoice.lordo || 0), 0);

  const imponibile = fatturato * (settings.coefficiente_redditivita / 100);
  const imposta = imponibile * (settings.aliquota_imposta / 100);
  const baseInps = Math.max(imponibile, Number(settings.minimale_inps || 0));
  const inps = baseInps * (settings.aliquota_inps / 100);
  const tasseTotali = imposta + inps;
  const pagato = payments.reduce((total, payment) => total + Number(payment.importo || 0), 0);

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
    residuo: tasseTotali - pagato,
    accantonamentoConsigliato: fatturato > 0 ? (tasseTotali / fatturato) * 100 : 0,
    disponibilitaStimata: incassato - tasseTotali,
  };
}
