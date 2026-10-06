import type * as XLSX from "xlsx";
import type { ImportRow } from "../../types/imports.ts";
import type { AccountType } from "../../types/ledger.ts";
import { normalizeBankRows, readWorkbook, suggestColumnMapping, type ReadBankFile } from "./bankStatement.ts";
import { AMERICAN_EXPRESS_PARSER_KEY, parseAmericanExpress } from "./americanExpress.ts";
import { ISYBANK_PARSER_KEY, parseIsyBank } from "./isyBank.ts";
import { ISYBANK_OPERATIONS_PARSER_KEY, parseIsyBankOperations } from "./isyBankOperations.ts";

export type BankImportDetection = { parserKey: string; providerLabel: string; compatibleAccountType: AccountType | null; rows: ImportRow[]; read: ReadBankFile; generic: boolean };

export function detectBankImport(workbook: XLSX.WorkBook): BankImportDetection {
  const providers = [
    { parserKey: ISYBANK_OPERATIONS_PARSER_KEY, providerLabel: "IsyBank", compatibleAccountType: "checking" as const, parse: parseIsyBankOperations },
    { parserKey: ISYBANK_PARSER_KEY, providerLabel: "IsyBank", compatibleAccountType: "checking" as const, parse: parseIsyBank },
    { parserKey: AMERICAN_EXPRESS_PARSER_KEY, providerLabel: "American Express", compatibleAccountType: "credit_card" as const, parse: parseAmericanExpress },
  ];
  for (const provider of providers) {
    const rows = provider.parse(workbook);
    if (rows) return { ...provider, rows, read: { headers: [], rows: [] }, generic: false };
  }
  const read = readWorkbook(workbook);
  return { parserKey: "generic_bank_v1", providerLabel: "Formato generico", compatibleAccountType: null,
    rows: normalizeBankRows(read.rows, suggestColumnMapping(read.headers)), read, generic: true };
}
