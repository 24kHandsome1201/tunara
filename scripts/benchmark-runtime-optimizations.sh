#!/usr/bin/env bash
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
cd "$ROOT"

export TUNARA_BENCHMARK_REVISION=${TUNARA_BENCHMARK_REVISION:-$(git rev-parse HEAD)}
printf 'RUNTIME_BENCHMARK_METADATA {"buildRevision":"%s","platform":"%s-%s","samples":1,"latencyUnits":"ms"}\n' \
  "$TUNARA_BENCHMARK_REVISION" "$(uname -s | tr '[:upper:]' '[:lower:]')" "$(uname -m)"

pnpm exec vitest run tests/ui/transfer-store.test.tsx \
  --reporter=verbose \
  -t 'indexes and aggregates a .*item batch with bounded pump work'
pnpm exec vitest run tests/ui/sessions-persistence-revision.test.ts \
  --reporter=verbose
pnpm exec vitest run tests/ui/file-explorer.test.tsx \
  --reporter=verbose \
  -t 'virtualizes 10k rows|same bounded virtualizer after expanding'

cargo test --manifest-path src-tauri/Cargo.toml \
  local_upload_manifest_scale_benchmark -- --ignored --nocapture
cargo test --manifest-path src-tauri/Cargo.toml \
  materialization_projection_scale_benchmark -- --ignored --nocapture
cargo test --manifest-path src-tauri/Cargo.toml \
  stable_index_restoration_and_virtual_rtt_benchmark -- --nocapture
cargo test --manifest-path src-tauri/Cargo.toml \
  generation_model_allows_only_the_highest_of_ten_thousand_to_commit -- --nocapture
cargo test --manifest-path src-tauri/Cargo.toml \
  binding_retirement_subscription -- --nocapture

if [[ -n ${TUNARA_SSH_SMOKE_HOST:-} && -n ${TUNARA_SSH_SMOKE_CWD:-} ]]; then
  cargo test --manifest-path src-tauri/Cargo.toml \
    real_ssh_rtt_operations_benchmark -- --ignored --nocapture
else
  echo 'RUNTIME_REAL_SSH_BENCHMARK_BLOCKED: TUNARA_SSH_SMOKE_HOST and TUNARA_SSH_SMOKE_CWD are not configured; delayed-proxy data was not presented as a real-network result.'
  echo 'RUNTIME_REMOTE_UPLOAD_BENCHMARK_BLOCKED: no isolated real SFTP fixture is configured; local preflight and pure backend materialization projections were measured instead.'
fi
