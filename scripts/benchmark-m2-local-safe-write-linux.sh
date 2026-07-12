#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RESULTS_ROOT="${TUNARA_M2_LOCAL_RESULTS:-/tmp/tunara-m2-local-safe-write-linux-results}"
ROUNDS="${TUNARA_LOCAL_SAFE_WRITE_ROUNDS:-500}"
TARGETED_LOG="$RESULTS_ROOT/targeted.log"
PERMISSION_LOG="$RESULTS_ROOT/permission.log"
STRESS_LOG="$RESULTS_ROOT/stress.log"
RESULT_JSON="$RESULTS_ROOT/result.json"

mkdir -p "$RESULTS_ROOT"
cd "$ROOT"

export PATH="$HOME/.cargo/bin:$PATH"
export TUNARA_LOCAL_SAFE_WRITE_ROUNDS="$ROUNDS"

started_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
started_ms="$(date +%s%3N)"

cargo test --manifest-path src-tauri/Cargo.toml \
  modules::fs::file::write_tests::local_save_reopen_same_size_conflict_and_residue_closure \
  -- --exact --nocapture 2>&1 | tee "$TARGETED_LOG"

test_binary="$(find src-tauri/target/debug/deps -maxdepth 1 -type f -name 'tunara_lib-*' -perm -111 -printf '%T@ %p\n' \
  | sort -nr | head -1 | cut -d' ' -f2-)"
permission_binary="/tmp/tunara-local-safe-write-test-$$"
cp "$test_binary" "$permission_binary"
chmod 755 "$permission_binary"
trap 'rm -f "$permission_binary"' EXIT
runuser -u nobody -- "$permission_binary" \
  modules::fs::file::write_tests::unwritable_parent_failure_preserves_original_and_leaves_no_residue \
  --exact --nocapture 2>&1 | tee "$PERMISSION_LOG"

cargo test --manifest-path src-tauri/Cargo.toml \
  modules::fs::file::write_tests::atomic_replace_stress_never_exposes_partial_content \
  -- --ignored --exact --nocapture 2>&1 | tee "$STRESS_LOG"

finished_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
finished_ms="$(date +%s%3N)"
duration_ms="$((finished_ms - started_ms))"
export TUNARA_M2_LOCAL_STARTED_AT="$started_at"
export TUNARA_M2_LOCAL_FINISHED_AT="$finished_at"
export TUNARA_M2_LOCAL_DURATION_MS="$duration_ms"
export TUNARA_M2_LOCAL_COMMIT="$(git rev-parse HEAD)"
export TUNARA_M2_LOCAL_HOST="$(hostname)"
export TUNARA_M2_LOCAL_KERNEL="$(uname -srmo)"
export TUNARA_M2_LOCAL_OS="$(. /etc/os-release && printf '%s' "$PRETTY_NAME")"
export TUNARA_M2_LOCAL_FILESYSTEM="$(findmnt -n -o FSTYPE --target /tmp)"
export TUNARA_M2_LOCAL_RUSTC="$(rustc --version)"
export TUNARA_M2_LOCAL_PNPM="$(pnpm --version)"

node --input-type=module - "$TARGETED_LOG" "$PERMISSION_LOG" "$STRESS_LOG" "$RESULT_JSON" <<'NODE'
import fs from "node:fs";

const [targetedLog, permissionLog, stressLog, resultPath] = process.argv.slice(2);
const marker = /^\[benchmark:m2-local-safe-write\] (\{.*\})$/m;
const readEvidence = (path) => {
  const text = fs.readFileSync(path, "utf8");
  const match = text.match(marker);
  if (!match) throw new Error(`missing benchmark marker in ${path}`);
  return JSON.parse(match[1]);
};

const evidence = [targetedLog, permissionLog, stressLog].map(readEvidence);
const byKind = Object.fromEntries(evidence.map((entry) => [entry.kind, entry]));
const result = {
  benchmark: "m2-local-safe-write-linux",
  baselineCommit: process.env.TUNARA_M2_LOCAL_COMMIT,
  host: process.env.TUNARA_M2_LOCAL_HOST,
  os: process.env.TUNARA_M2_LOCAL_OS,
  kernel: process.env.TUNARA_M2_LOCAL_KERNEL,
  filesystem: process.env.TUNARA_M2_LOCAL_FILESYSTEM,
  rustc: process.env.TUNARA_M2_LOCAL_RUSTC,
  pnpm: process.env.TUNARA_M2_LOCAL_PNPM,
  startedAt: process.env.TUNARA_M2_LOCAL_STARTED_AT,
  finishedAt: process.env.TUNARA_M2_LOCAL_FINISHED_AT,
  durationMs: Number(process.env.TUNARA_M2_LOCAL_DURATION_MS),
  result: "pass",
  evidence: byKind,
};
fs.writeFileSync(resultPath, `${JSON.stringify(result, null, 2)}\n`);
NODE

printf 'result=%s\n' "$RESULT_JSON"
