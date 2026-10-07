#!/usr/bin/env bash
# PostgreSQL only, isolated synthetic database. Never connects to a Supabase project.
set -euo pipefail
cd "$(dirname "$0")/.."
pr6_container="financialmind-pr6-test-${RANDOM}-${RANDOM}"
cleanup() { docker rm -f "$pr6_container" >/dev/null; }
trap cleanup EXIT
docker run --rm -d --name "$pr6_container" -e POSTGRES_HOST_AUTH_METHOD=trust postgres:17 >/dev/null
for attempt in {1..30}; do
  if docker exec "$pr6_container" pg_isready -U postgres >/dev/null 2>&1; then break; fi
  if [ "$attempt" -eq 30 ]; then echo 'PostgreSQL did not become ready' >&2; exit 1; fi
  sleep 1
done
run_sql() { docker exec -i "$pr6_container" psql -U postgres -v ON_ERROR_STOP=1 < "$1"; }
run_sql supabase/tests/bootstrap.sql
for migration in supabase/migrations/*.sql; do
  if [[ "$migration" == *pr6_residual_review.sql ]]; then
    run_sql supabase/tests/pr6_upgrade_preservation.sql
    run_sql "$migration"
    run_sql supabase/tests/pr6_upgrade_verify.sql
  else
    run_sql "$migration"
  fi
done
run_sql supabase/tests/pr4_4_multi_instrument.sql
run_sql supabase/tests/pr5_provider_classification.sql
run_sql supabase/tests/pr6_residual_review.sql
