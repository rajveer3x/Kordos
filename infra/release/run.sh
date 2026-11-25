#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/../.."
mode="${1:-}"
case "$mode" in
  search)
    pg_port=55493 redis_port=56493 storage_port=58493 api_port=4344 web_port=4345
    export TEST_OIDC_PORT=4418 TEST_SEARCH_MODEL_PORT=4518
    ;;
  journeys)
    pg_port=55492 redis_port=56492 storage_port=58492 api_port=4342 web_port=4343
    ;;
  *)
    echo "Usage: bash infra/release/run.sh {search|journeys} [Playwright options]" >&2
    exit 2
    ;;
esac
shift

run_dir="$(mktemp -d "${TMPDIR:-/tmp}/kordos-release.XXXXXX")"
suffix="$(basename "$run_dir" | cut -d. -f2 | tr '[:upper:]' '[:lower:]')"
export COMPOSE_PROJECT_NAME="kordos-release-$mode-$suffix"
local_env="$run_dir/stack.env"
db_name="kordos_release_$mode"
sed -e "s/55432/$pg_port/g" -e "s/56379/$redis_port/g" -e "s/58333/$storage_port/g" \
  -e "s/4301/$api_port/g" -e "s/4317/$web_port/g" \
  -e "s/POSTGRES_DB=kordos$/POSTGRES_DB=$db_name/" -e "s@:$pg_port/kordos\$@:$pg_port/$db_name@" \
  .env.example > "$local_env"

set -a
source "$local_env"
set +a
compose() {
  docker compose --env-file "$local_env" "$@"
}
cleanup() {
  compose down --volumes
  rm -f "$local_env"
  rmdir "$run_dir"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

result_dir="$PWD/test-results/feature-22-$mode-$suffix"
mkdir -p "$result_dir"
echo "Release evidence directory $result_dir"
export KORDOS_RELEASE_SERVER_LOG="$result_dir/server.log"
export PLAYWRIGHT_JSON_OUTPUT_FILE="$result_dir/playwright.json"

compose up -d --wait
pnpm db:migrate
if [[ "$mode" = search ]]; then
  RELEASE_RESUME_INDEX=0 RELEASE_DIAGNOSTICS=full pnpm test:release --output="$result_dir/tests" --reporter=list,json "$@"
else
  status=0
  pnpm test:e2e --output="$result_dir/tests" --reporter=list,json --workers=1 "$@" || status=$?
  compose exec -T postgres psql -qAt -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
    < tests/release/audit.sql > "$result_dir/audit.json"
  audit_status=0
  node - "$result_dir/audit.json" <<'JS' || audit_status=$?
const { readFileSync } = require("node:fs");
const { total_attempts, total_linked } = JSON.parse(readFileSync(process.argv[2], "utf8"));
console.log(`Audit reconciliation linked ${total_linked}/${total_attempts} operation records.`);
if (total_linked !== total_attempts) process.exitCode = 1;
JS
  if [[ "$status" != 0 ]]; then
    exit "$status"
  fi
  exit "$audit_status"
fi
