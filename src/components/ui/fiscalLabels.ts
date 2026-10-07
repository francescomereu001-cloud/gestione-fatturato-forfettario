export const fiscalMoney = (value: number | null | undefined) => value == null ? "Non disponibile" : new Intl.NumberFormat("it-IT", { style: "currency", currency: "EUR" }).format(value);
