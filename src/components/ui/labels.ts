import type {
  AccountType,
  ClassificationMethod,
  ReconciliationStatus,
  TransactionType,
} from "../../types/ledger";
export const transactionTypeLabels: Record<TransactionType, string> = {
  income: "Entrata",
  expense: "Spesa",
  refund: "Rimborso",
  internal_transfer: "Trasferimento interno",
  investment_transfer: "Trasferimento investimento",
  debt_principal: "Rimborso capitale debito",
  debt_interest: "Interessi debito",
  adjustment: "Rettifica",
  unclassified: "Non classificato",
};
export const accountTypeLabels: Record<AccountType, string> = {
  checking: "Conto corrente",
  savings: "Risparmio",
  credit_card: "Carta di credito",
  broker: "Broker",
  cash: "Contanti",
  technical: "Conto tecnico",
  other: "Altro",
};
export const reconciliationLabels: Record<ReconciliationStatus, string> = {
  pending: "Da riconciliare",
  confirmed: "Confermato",
  ignored: "Ignorato",
};
export const classificationLabels: Record<ClassificationMethod, string> = {
  manual: "Manuale",
  user_rule: "Regola personale",
  merchant_memory: "Memoria merchant",
  ai_suggestion: "Suggerimento AI",
  provider_rule: "Automatico",
  transfer_match: "Trasferimento riconciliato",
};
export function providerLabel(parser: string | null): string {
  return (
    (
      {
        isybank_operations_v1: "IsyBank",
        american_express_v1: "American Express",
        isybank_card_v1: "IsyBank Carta",
      } as Record<string, string>
    )[parser ?? ""] ?? "Import bancario"
  );
}
export function money(value: number, currency = "EUR", signed = false): string {
  return new Intl.NumberFormat("it-IT", {
    style: "currency",
    currency,
    ...(signed ? { signDisplay: "exceptZero" as const } : {}),
  }).format(value);
}
export function dateRange(min: string, max: string): string {
  const format = (value: string) =>
    new Intl.DateTimeFormat("it-IT", {
      month: "short",
      year: "numeric",
      timeZone: "UTC",
    }).format(new Date(`${value}T00:00:00Z`));
  return `${format(min)} – ${format(max)}`;
}
