# PR1 — audit e refactor strutturale minimo

## Obiettivo

Creare i primi confini architetturali di FinancialMind senza cambiare interfaccia, persistenza o
flussi esistenti. Questa PR è intenzionalmente limitata all'estrazione di codice già in produzione e
alla sua copertura di regressione.

## Audit della baseline

### Stack riutilizzabile

- React 19, TypeScript e Vite costituiscono una base adeguata per un'evoluzione incrementale.
- Supabase è già isolato nella configurazione client e usa solo URL e anon key esposti da Vite.
- Recharts è già usato dalla dashboard e XLSX dal flusso di import.
- Le funzioni fatture, F24, parametri fiscali e import sono operative e vanno mantenute durante le
  fasi successive.

### Debito tecnico rilevato

- `App.tsx` concentra navigazione, stato, query Supabase, calcoli, parsing e rendering.
- I tipi delle tre entità esistenti erano locali al componente e quindi non riutilizzabili.
- Il calcolo fiscale era deterministico, ma incorporato nel rendering e privo di test.
- Il parser Excel era incorporato nel componente e mescolato al commit su Supabase.
- Non è presente nel repository alcuna migration o definizione SQL dello schema remoto; la baseline
  osservabile usa `invoices`, `tax_payments` e `tax_settings`.
- Non sono ancora presenti autenticazione, ownership o policy RLS versionate: appartengono alla PR2,
  insieme a una migration verificabile e compatibile con le tabelle attuali.

## Contenuto esatto della PR1

1. Spostare i tipi finanziari esistenti in `src/types`.
2. Estrarre impostazioni predefinite e calcolo fiscale puro in `src/domain/calculations`.
3. Separare parsing/normalizzazione Excel dal caricamento e dal commit Supabase in
   `src/import/parsers`.
4. Aggiungere test di regressione deterministici per fiscalità e parsing delle fatture.
5. Documentare baseline, rischi, criteri di accettazione e confini della fase successiva.

Non vengono aggiunti moduli finanziari, tabelle, migration, nuove dipendenze o modifiche visuali.

## Migration database

Nessuna. La PR1 mantiene inalterati nomi e payload delle tabelle esistenti.

## Rischi e mitigazioni

- **Regressioni nei calcoli:** esempi numerici fissano imponibile, imposta, INPS, incassi e residuo.
- **Regressioni nell'import:** un workbook in memoria verifica formati italiani, stato incasso e note
  di credito prima di qualsiasi accesso al database.
- **Divergenza dallo schema remoto:** nessuno schema SQL era disponibile nel repository; prima della
  PR2 lo schema effettivo dovrà essere esportato e confrontato con i payload correnti.
- **Bundle già voluminoso:** l'estrazione non aggiunge dipendenze; code splitting resta lavoro futuro.

## Criteri di accettazione

- Fatture, F24, parametri fiscali e import conservano gli stessi payload e flussi UI.
- Il componente non contiene più formule fiscali né regole di parsing Excel.
- Calcoli e parser sono invocabili senza Supabase e coperti da test.
- Test, lint e build passano.

## Lavoro successivo

La PR2 dovrà partire dall'export verificato dello schema remoto e introdurre in una migration
reversibile: Supabase Auth, `profiles`, ownership sulle entità esistenti, indici e policy RLS. Le
policy andranno validate con almeno due utenti distinti prima di procedere ad Accounts e
Transactions.
