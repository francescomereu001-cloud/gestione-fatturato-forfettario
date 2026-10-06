import type { SupabaseClient } from "@supabase/supabase-js";
import type { ImportAccountMapping, ImportRow } from "../types/imports.ts";
import type { Account, AccountType } from "../types/ledger.ts";

export function normalizeInstrument(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

export function instrumentAccountType(value: string): AccountType | null {
  const normalized = normalizeInstrument(value);
  if (/^carta di credito(?: |$)/.test(normalized)) return "credit_card";
  if (/^conto(?: |$)/.test(normalized)) return "checking";
  return null;
}

export function detectedInstruments(rows: ImportRow[]): { key: string; label: string; count: number }[] {
  const instruments = new Map<string, { key: string; label: string; count: number }>();
  for (const row of rows) {
    if (!row.source_instrument) continue;
    const key = normalizeInstrument(row.source_instrument);
    const group = instruments.get(key);
    if (group) group.count++;
    else instruments.set(key, { key, label: row.source_instrument, count: 1 });
  }
  return [...instruments.values()];
}

export function resolveInstrumentMappings(rows: ImportRow[], mappings: ImportAccountMapping[], accounts: Account[], userId: string): Record<string, string> {
  const resolved: Record<string, string> = {};
  for (const instrument of detectedInstruments(rows)) {
    const mapping = mappings.find((item) => item.user_id === userId && normalizeInstrument(item.source_instrument) === instrument.key);
    const account = accounts.find((item) => item.id === mapping?.account_id && item.user_id === userId && item.is_active);
    const expected = instrumentAccountType(instrument.label);
    if (account?.id && (!expected || account.account_type === expected)) resolved[instrument.key] = account.id;
  }
  return resolved;
}

export function routeImportRows(rows: ImportRow[], selections: Record<string, string>, accounts: Account[], userId: string): ImportRow[] {
  return rows.map((row) => {
    if (!row.source_instrument) {
      if (row.status === "error") return row;
      throw new Error("Strumento mancante: correggi il file prima di importare.");
    }
    const accountId = selections[normalizeInstrument(row.source_instrument)];
    const account = accounts.find((item) => item.id === accountId && item.user_id === userId && item.is_active);
    if (!account) throw new Error(`Seleziona un account valido per ${row.source_instrument}.`);
    const expected = instrumentAccountType(row.source_instrument);
    if (expected && account.account_type !== expected) throw new Error(`Lo strumento ${row.source_instrument} richiede un account ${expected}.`);
    return { ...row, target_account_id: accountId };
  });
}

export async function loadImportMappings(client: SupabaseClient, userId: string, parserKey: string): Promise<ImportAccountMapping[]> {
  const { data, error } = await client.from("import_account_mappings").select("*").eq("user_id", userId).eq("parser_key", parserKey);
  if (error) throw error;
  return (data ?? []) as ImportAccountMapping[];
}

export async function saveImportMappings(client: SupabaseClient, userId: string, parserKey: string, rows: ImportRow[]): Promise<void> {
  const values = detectedInstruments(rows).map((instrument) => ({
    user_id: userId, parser_key: parserKey, source_instrument: instrument.key,
    account_id: rows.find((row) => row.source_instrument && normalizeInstrument(row.source_instrument) === instrument.key)!.target_account_id,
  }));
  if (!values.length) return;
  const { error } = await client.from("import_account_mappings").upsert(values, { onConflict: "user_id,parser_key,source_instrument" });
  if (error) throw error;
}
