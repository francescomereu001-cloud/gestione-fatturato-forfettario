# FinancialMind

Evoluzione incrementale di **Gestione Fatturato** verso un Financial OS personale. Il principio
guida è separare i calcoli finanziari deterministici dall'interpretazione: database e funzioni di
dominio producono i valori ufficiali; un futuro layer AI potrà soltanto spiegarli e proporre scenari.

## Stato attuale

L'app React + TypeScript + Vite conserva le funzioni esistenti per:

- fatture e incassi;
- stima fiscale configurabile;
- pagamenti F24;
- import di fatture `.xls` e `.xlsx`;
- dashboard annuale.

L'accesso ai dati richiede ora una sessione Supabase autenticata; ownership e Row Level Security
proteggono `invoices`, `tax_payments`, `tax_settings` e `profiles`. La procedura amministrativa per
applicare la migration e attribuire i dati legacy è in
[`docs/pr2-auth-setup.md`](docs/pr2-auth-setup.md). L'audit tecnico precedente resta disponibile in
[`docs/pr1-audit.md`](docs/pr1-audit.md).

## Sviluppo locale

Creare un file `.env.local` senza versionarlo:

```dotenv
VITE_SUPABASE_URL=https://example.supabase.co
VITE_SUPABASE_ANON_KEY=...
```

La chiave anon è l'unica chiave Supabase prevista nel client. Non inserire mai service-role key o
altri segreti nelle variabili `VITE_*`.

```bash
npm install
npm run dev
```

## Verifiche

```bash
npm test
npm run lint
npm run build
```

I test usano il test runner nativo di Node e non introducono dipendenze. Le funzioni in
`src/domain/calculations` e i parser in `src/import/parsers` devono restare deterministici e privi di
accessi diretti a Supabase.
