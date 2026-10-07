import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { SupabaseClient } from '@supabase/supabase-js';
import { loadFinancialTaxSummary, saveFiscalAllocation } from './fiscal.ts';
import { blankFiscalSettings } from '../types/fiscal.ts';
import { fiscalMoney } from '../components/ui/fiscalLabels.ts';
test('fiscal RPC receives year, never a caller-supplied owner or frontend totals', async () => {
 const client = { rpc: async (name: string, args: unknown) => { assert.equal(name, 'financial_tax_summary'); assert.deepEqual(args, {target_year:2026}); return {data:{required_tax_reserve:null},error:null}; } } as unknown as SupabaseClient;
 assert.equal((await loadFinancialTaxSummary(client,2026)).required_tax_reserve,null);
});
test('new annual profile contains no assumed rates and null reserve is visibly unavailable', () => {
 const settings=blankFiscalSettings(2026);
 assert.equal(settings.substitute_tax_rate_pct,null); assert.equal(settings.maximum_social_income,null);
 assert.equal(settings.configuration_verified,false); assert.equal(settings.liability_schedule_verified,false);
 assert.equal(fiscalMoney(null),'Non disponibile'); assert.notEqual(fiscalMoney(0),'Non disponibile');
});
test('allocation updates only metadata and scopes payment to its owner', async () => {
 const filters: unknown[]=[]; let payload: Record<string,unknown>={};
 const query={eq:(key:string,value:string)=>{filters.push([key,value]);return query;},then:(resolve:(value:unknown)=>void)=>resolve({error:null})};
 const client={from:(table:string)=>{assert.equal(table,'tax_payments');return {update:(data:Record<string,unknown>)=>{payload=data;return query;}};}} as unknown as SupabaseClient;
 await saveFiscalAllocation(client,'owner','payment',{fiscal_allocation_status:'unallocated',fiscal_tax_year:null,fiscal_payment_kind:null,fiscal_payment_date:null,deductible_social_security:null,fiscal_obligation_id:null,fiscal_allocation_note:null});
 assert.deepEqual(filters,[['id','payment'],['user_id','owner']]); assert.equal(Object.keys(payload).length,7);
 for(const key of ['importo','anno','data','descrizione','user_id']) assert.equal(key in payload,false);
});
