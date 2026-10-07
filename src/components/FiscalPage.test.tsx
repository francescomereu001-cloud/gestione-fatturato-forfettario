import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { FiscalSummaryPanel } from './FiscalPage.tsx';
import type { FinancialTaxSummary } from '../types/fiscal.ts';
test('incomplete fiscal UI displays server status, required fields, null reserve and no spendable balance', () => {
 const summary={tax_year:2026,as_of:'2026-10-07',projection_status:'incomplete',missing_fields:['maximum_social_income'],warnings:[],schedule:[],taxable_revenue:1234,required_tax_reserve:null} as unknown as FinancialTaxSummary;
 const html=renderToStaticMarkup(<FiscalSummaryPanel summary={summary}/>);
 assert.match(html,/Dati incompleti/); assert.match(html,/Massimale previdenziale/); assert.match(html,/Non disponibile/);
 assert.match(html,/1234,00/); assert.doesNotMatch(html,/Disponibilità stimata|Safe to Spend/);
});
test('RPC failure remains visible instead of switching to legacy estimates', () => {
 const html=renderToStaticMarkup(<FiscalSummaryPanel summary={null} error="Proiezione fiscale non disponibile"/>);
 assert.match(html,/role="alert"/); assert.match(html,/Proiezione fiscale non disponibile/); assert.doesNotMatch(html,/0,00/);
});
