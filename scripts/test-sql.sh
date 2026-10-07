#!/usr/bin/env bash
# PostgreSQL only, isolated synthetic database. Never connects to a Supabase project.
set -euo pipefail
cd "$(dirname "$0")/.."
pr6_container="financialmind-pr6-test-${RANDOM}-${RANDOM}"
cleanup() { docker rm -f "$pr6_container" >/dev/null; }
trap cleanup EXIT
docker run --rm -d --name "$pr6_container" -p 127.0.0.1::5432 -e POSTGRES_HOST_AUTH_METHOD=trust postgres:17 >/dev/null
for attempt in {1..30}; do
  if docker exec "$pr6_container" pg_isready -U postgres >/dev/null 2>&1; then break; fi
  if [ "$attempt" -eq 30 ]; then echo 'PostgreSQL did not become ready' >&2; exit 1; fi
  sleep 1
done
run_sql() { docker exec -i "$pr6_container" psql -U postgres -v ON_ERROR_STOP=1 < "$1"; }
run_advisors() {
  local port
  port=$(docker port "$pr6_container" 5432/tcp)
  port=${port##*:}
  npm exec --yes --package=supabase -- supabase db advisors --db-url "postgresql://postgres@127.0.0.1:${port}/postgres?sslmode=disable" --type security --level error --fail-on none --output-format json > "work/pr10-advisors-$1.json"
}
run_sql supabase/tests/bootstrap.sql
for migration in supabase/migrations/*.sql; do
  if [[ "$migration" == *pr6_residual_review.sql ]]; then
    run_sql supabase/tests/pr6_upgrade_preservation.sql
    run_sql "$migration"
    run_sql supabase/tests/pr6_upgrade_verify.sql
  elif [[ "$migration" == *pr9_smart_classification_engine.sql ]]; then
    run_sql supabase/tests/pr9_upgrade_preservation.sql
    run_sql "$migration"
    run_sql supabase/tests/pr9_upgrade_verify.sql
  elif [[ "$migration" == *pr10_fiscal_engine_tax_reserve.sql ]]; then
    if [[ "${PR10_RUN_ADVISORS:-0}" == 1 ]]; then run_advisors before; fi
    run_sql supabase/tests/pr10_upgrade_preservation.sql
    run_sql "$migration"
    run_sql supabase/tests/pr10_upgrade_verify.sql
  else
    run_sql "$migration"
  fi
done
run_sql supabase/tests/pr4_4_multi_instrument.sql
run_sql supabase/tests/pr5_provider_classification.sql
run_sql supabase/tests/pr6_residual_review.sql

run_sql supabase/tests/pr9_smart_classification.sql

run_sql supabase/tests/pr10_fiscal_engine.sql

if [[ "${PR10_RUN_ADVISORS:-0}" == 1 ]]; then
  run_advisors after
  node --input-type=module - <<'JS'
import {readFileSync} from 'node:fs';
const before=JSON.parse(readFileSync('work/pr10-advisors-before.json','utf8'));
const after=JSON.parse(readFileSync('work/pr10-advisors-after.json','utf8'));
if(!Array.isArray(before.results)||!Array.isArray(after.results)) throw new Error('Invalid advisor output');
const known=new Set(before.results.map(issue=>JSON.stringify(issue)));
const added=after.results.filter(issue=>!known.has(JSON.stringify(issue)));
if(added.length) throw new Error(`New security errors: ${JSON.stringify(added)}`);
console.log(`Security advisor errors: before=${before.results.length}, after=${after.results.length}, new=0`);
JS
fi
