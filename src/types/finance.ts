export type Invoice = {
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

export type TaxPayment = {
  id?: string;
  anno: number;
  data?: string;
  descrizione: string;
  importo: number;
  tipo: string;
};

export type TaxSettings = {
  id?: string;
  anno: number;
  aliquota_imposta: number;
  coefficiente_redditivita: number;
  aliquota_inps: number;
  minimale_inps: number;
};
