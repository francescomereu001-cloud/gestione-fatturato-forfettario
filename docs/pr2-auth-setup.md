# PR2 — configurazione Auth, backfill legacy e verifica RLS

Questa procedura va eseguita **una sola volta** dopo aver applicato la migration PR2. Lo schema
remoto non era interrogabile dall'ambiente di sviluppo: la migration assume esclusivamente
l'esistenza delle tre tabelle confermate dal codice (`invoices`, `tax_payments`, `tax_settings`) e
non modifica le loro constraint preesistenti.

## 1. Creare o invitare l'utente

In Supabase Dashboard aprire **Authentication → Users** e usare **Add user** oppure **Invite user**.
Non abilitare una registrazione pubblica nell'app. Verificare che l'utente riesca ad autenticarsi.

## 2. Recuperare l'UUID

Copiare l'UUID dalla pagina dell'utente, oppure eseguire nel SQL Editor (sostituendo il placeholder):

```sql
select id, email from auth.users where email = '<EMAIL_UTENTE>';
```

Conservare l'UUID soltanto per la sessione amministrativa; non inserirlo nel repository.

## 3. Attribuire esplicitamente i record legacy

Prima verificare conteggi e contenuto dei record senza proprietario. Quindi, dopo aver accertato che
appartengano tutti all'utente scelto, eseguire in una transazione:

```sql
begin;

update public.invoices
set user_id = '<UUID_UTENTE>'::uuid
where user_id is null;

update public.tax_payments
set user_id = '<UUID_UTENTE>'::uuid
where user_id is null;

update public.tax_settings
set user_id = '<UUID_UTENTE>'::uuid
where user_id is null;

commit;
```

Non automatizzare questo backfill e non usare UUID o email hardcoded. Finché `user_id` è `NULL`, le
policy RLS rendono quei record invisibili a tutti gli utenti dell'app.

## 4. Verificare il backfill

```sql
select 'invoices' as tabella, user_id, count(*) from public.invoices group by user_id
union all
select 'tax_payments', user_id, count(*) from public.tax_payments group by user_id
union all
select 'tax_settings', user_id, count(*) from public.tax_settings group by user_id;
```

Verificare anche che il conteggio con `user_id is null` sia zero in ogni tabella prima di procedere.

## 5. Rendere obbligatoria l'ownership (fase successiva al backfill)

Solo dopo la verifica, applicare una nuova migration versionata:

```sql
alter table public.invoices alter column user_id set not null;
alter table public.tax_payments alter column user_id set not null;
alter table public.tax_settings alter column user_id set not null;
```

## Test manuale RLS con due utenti

Creare due utenti di test A e B, senza dati finanziari reali. Usare due client/sessioni con la sola
anon/publishable key:

1. A inserisce un record in ciascuna tabella con il proprio UUID; l'inserimento con UUID di B fallisce.
2. B esegue `SELECT`: i record di A non compaiono.
3. B tenta `UPDATE` e `DELETE` sugli ID di A: nessuna riga viene modificata o eliminata.
4. A riesce invece a leggere, modificare ed eliminare i propri record.
5. Un client anonimo non può leggere né scrivere dati finanziari.
6. Ripetere le verifiche per `profiles`, dove `id` deve coincidere con `auth.uid()`.

Il precedente `upsert(..., { onConflict: "anno" })` presupponeva una constraint globale su `anno`,
non verificabile e potenzialmente incompatibile con più utenti. PR2 non altera quella constraint:
l'app aggiorna per `id` un'impostazione già caricata oppure inserisce un nuovo record. Se sul database
esiste davvero unicità globale su `anno`, l'inserimento dello stesso anno per un secondo utente può
fallire. Prima di una futura correzione va ispezionata la constraint remota e pianificata una migration
dedicata verso un'unicità composta `(user_id, anno)`.
