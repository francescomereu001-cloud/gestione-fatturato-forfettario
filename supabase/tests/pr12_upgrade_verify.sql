do $$ declare t record;data jsonb;expression text;begin
 for t in select * from pr12_upgrade.rows loop
 expression:=case when t.table_name='invoices' then 'to_jsonb(x)-ARRAY[''document_type'',''source_document_id'',''source'',''parser_key'',''import_batch_id'',''source_fingerprint'',''imported_at'',''import_metadata'']' else 'to_jsonb(x)' end;
 execute format('select coalesce(jsonb_agg(%s order by (%s)::text),''[]''::jsonb) from public.%I x',expression,expression,t.table_name) into data;
 if data is distinct from t.rows then raise exception 'PR12 altered original table %',t.table_name;end if;
 end loop;
 if exists(select 1 from public.invoice_import_batches) or exists(select 1 from public.invoice_import_rows) then raise exception 'PR12 must not generate real/synthetic invoices in migration';end if;
 raise notice 'PASS: PR12 preserves every original public-table row, invoices, F24, settings, bank ledger and PR11 entries';
end $$;
-- Keep preservation owner in isolated DB; other suites use generated owners and RLS.
drop schema pr12_upgrade cascade;
