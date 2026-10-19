-- Invoice amounts can be corrected without deleting/recreating documentary identities.
-- No historical amounts are changed by applying this migration.
begin;
alter table public.invoices add column edit_version bigint not null default 0;
create function public.bump_invoice_edit_version() returns trigger
language plpgsql security invoker set search_path='' as $$
begin new.edit_version:=old.edit_version+1; return new; end $$;
revoke all on function public.bump_invoice_edit_version() from public,anon,authenticated;
create trigger invoices_edit_version before update on public.invoices
for each row execute function public.bump_invoice_edit_version();

create table public.invoice_revisions(
 id uuid primary key default gen_random_uuid(),
 user_id uuid not null references auth.users(id),
 invoice_id uuid not null,
 import_row_id uuid,
 action text not null check(action in ('manual','recalculate','apply_import','keep_existing')),
 reason text not null check(length(btrim(reason)) between 1 and 1000),
 before_data jsonb not null, after_data jsonb not null,
 created_at timestamptz not null default now(),
 foreign key(invoice_id,user_id) references public.invoices(id,user_id),
 foreign key(import_row_id) references public.invoice_import_rows(id)
);
create index invoice_revisions_owner_invoice_idx on public.invoice_revisions(user_id,invoice_id,created_at desc);
alter table public.invoice_revisions enable row level security;
revoke all on public.invoice_revisions from public,anon,authenticated;
grant select on public.invoice_revisions to authenticated;
create policy invoice_revisions_read on public.invoice_revisions for select to authenticated using((select auth.uid())=user_id);
alter table public.invoice_import_rows drop constraint invoice_import_rows_status_check;
alter table public.invoice_import_rows add constraint invoice_import_rows_status_check
 check(status in ('new','existing_unchanged','exact_duplicate','conflict','rejected','inserted','resolved_import','resolved_kept'));

create function public.invoice_detail(target_invoice uuid) returns jsonb
language plpgsql stable security invoker set search_path='' as $$
declare inv jsonb;
begin
 select to_jsonb(i) into inv from public.invoices i where i.id=target_invoice and i.user_id=auth.uid();
 if inv is null then raise exception 'Documento non disponibile' using errcode='42501'; end if;
 return jsonb_build_object('invoice',inv,
 'conflicts',coalesce((select jsonb_agg(to_jsonb(r)||jsonb_build_object('file_name',b.file_name) order by b.created_at desc,r.row_index)
 from public.invoice_import_rows r join public.invoice_import_batches b on b.id=r.batch_id and b.user_id=r.user_id
 where r.invoice_id=target_invoice and r.user_id=auth.uid() and r.status='conflict' and b.status='committed'),'[]'::jsonb),
 'revisions',coalesce((select jsonb_agg(to_jsonb(h) order by h.created_at desc,h.id)
 from public.invoice_revisions h where h.invoice_id=target_invoice and h.user_id=auth.uid()),'[]'::jsonb));
end $$;
revoke all on function public.invoice_detail(uuid) from public,anon;
grant execute on function public.invoice_detail(uuid) to authenticated;

-- Private privileged writer: owner checks, owner-wide import lock, optimistic version,
-- validation and immutable audit are a single transaction. Public wrapper is invoker.
create function financial_private.edit_invoice(target_invoice uuid, expected_version bigint,
 edit_action text, amounts jsonb, edit_reason text, conflict_row uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
 owner_id uuid:=auth.uid(); inv public.invoices; updated public.invoices;
 r public.invoice_import_rows; b public.invoice_import_batches; d jsonb;
 g numeric; e numeric; n numeric; description text; dtype text; source_kind text;
begin
 if owner_id is null then raise exception 'authentication required' using errcode='42501'; end if;
 if edit_action is null or edit_action not in ('manual','recalculate','apply_import','keep_existing')
 or edit_reason is null or length(btrim(edit_reason)) not between 1 and 1000 then raise exception 'Azione o motivazione non valida'; end if;
 perform pg_advisory_xact_lock(hashtextextended('invoice_import:'||owner_id::text,0));
 select * into inv from public.invoices where id=target_invoice and user_id=owner_id for update;
 if not found then raise exception 'Documento non disponibile' using errcode='42501'; end if;
 if expected_version is distinct from inv.edit_version then
  raise exception 'La fattura è stata modificata: riapri il dettaglio prima di salvare' using errcode='40001'; end if;
 dtype:=coalesce(inv.document_type,case when inv.categoria='Nota di credito' then 'credit_note' when inv.lordo<0 then 'signed_adjustment' else 'invoice' end);
 if edit_action in ('apply_import','keep_existing') then
  select * into r from public.invoice_import_rows where id=conflict_row and user_id=owner_id and invoice_id=inv.id and status='conflict' for update;
  if not found then raise exception 'Conflitto non disponibile o già risolto'; end if;
  select * into b from public.invoice_import_batches where id=r.batch_id and user_id=owner_id;
  if b.status is distinct from 'committed' then raise exception 'Conferma prima il batch di importazione'; end if;
  d:=r.normalized_data;
  if edit_action='apply_import' then
   -- Do not overwrite identity or automatically choose between ambiguous source rows.
   if lower(btrim(d->>'numero')) is distinct from lower(btrim(inv.numero))
     or public.fiscal_date(d->>'data') is distinct from inv.data
     or btrim(d->>'cliente') is distinct from btrim(inv.cliente)
     or d->>'document_type' is distinct from dtype
     or (inv.source_document_id is not null and d->>'source_document_id' is not null and inv.source_document_id<>d->>'source_document_id')
     or exists(select 1 from public.invoice_import_rows x where x.batch_id=r.batch_id and x.user_id=owner_id
      and x.identity_key=r.identity_key and x.fingerprint is distinct from r.fingerprint) then
    raise exception 'Identità o righe sorgente ambigue: verifica il documento prima di correggere manualmente'; end if;
   g:=public.fiscal_numeric(d->>'lordo');n:=public.fiscal_numeric(d->>'netto');e:=public.fiscal_numeric(d->>'enasarco');
   source_kind:=d->>'enasarco_source';
   if source_kind='document_gross_net_delta' then e:=round(g-n,2); end if;
   description:=coalesce(d->>'descrizione','');
  else g:=inv.lordo;n:=inv.netto;e:=inv.enasarco;description:=inv.descrizione;
  end if;
 else
  if conflict_row is not null then raise exception 'Azione non compatibile con il conflitto'; end if;
  g:=public.fiscal_numeric(amounts->>'lordo');n:=public.fiscal_numeric(amounts->>'netto');
  e:=public.fiscal_numeric(amounts->>'enasarco');description:=coalesce(amounts->>'descrizione','');
  source_kind:='manual_correction';
  if edit_action='recalculate' then e:=round(g-n,2);source_kind:='document_gross_net_delta'; end if;
 end if;
 if edit_action<>'keep_existing' then
  if g is null or e is null or n is null or abs(g)>=1e12 or abs(e)>=1e12 or abs(n)>=1e12
    or g<>round(g,2) or e<>round(e,2) or n<>round(n,2) or length(description)>4000
    or (dtype='invoice' and (g<0 or e<0 or n<0))
    or (dtype='credit_note' and (g>0 or e>0 or n>0))
    or (g>0 and (e<0 or n<0)) or (g<0 and (e>0 or n>0)) or abs(e)>abs(g) then
   raise exception 'Importi non validi: verifica centesimi e segni del documento'; end if;
 end if;
 update public.invoices set lordo=g,enasarco=e,netto=n,descrizione=description,
  import_metadata=case when edit_action='keep_existing' then import_metadata else
   coalesce(import_metadata,'{}'::jsonb)||jsonb_build_object('enasarco_source',source_kind,'last_edit_action',edit_action) end
 where id=inv.id and user_id=owner_id returning * into updated;
 insert into public.invoice_revisions(user_id,invoice_id,import_row_id,action,reason,before_data,after_data)
 values(owner_id,inv.id,conflict_row,edit_action,btrim(edit_reason),to_jsonb(inv),to_jsonb(updated));
 if conflict_row is not null then
  update public.invoice_import_rows set status=case when edit_action='apply_import' then 'resolved_import' else 'resolved_kept' end
  where id=r.id and user_id=owner_id;
  update public.invoice_import_batches set
   conflict_count=(select count(*) from public.invoice_import_rows where batch_id=b.id and user_id=owner_id and status='conflict'),
   updated_count=(select count(*) from public.invoice_import_rows where batch_id=b.id and user_id=owner_id and status='resolved_import')
  where id=b.id and user_id=owner_id;
 end if;
 return to_jsonb(updated);
end $$;
revoke all on function financial_private.edit_invoice(uuid,bigint,text,jsonb,text,uuid) from public,anon,authenticated;
grant execute on function financial_private.edit_invoice(uuid,bigint,text,jsonb,text,uuid) to authenticated;
create function public.save_invoice_correction(target_invoice uuid, expected_version bigint,
 edit_action text, amounts jsonb, edit_reason text, conflict_row uuid default null)
returns jsonb language sql security invoker set search_path='' as $$
 select financial_private.edit_invoice(target_invoice,expected_version,edit_action,amounts,edit_reason,conflict_row);
$$;
revoke all on function public.save_invoice_correction(uuid,bigint,text,jsonb,text,uuid) from public,anon;
grant execute on function public.save_invoice_correction(uuid,bigint,text,jsonb,text,uuid) to authenticated;
commit;
