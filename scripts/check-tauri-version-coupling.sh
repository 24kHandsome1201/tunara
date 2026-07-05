#!/usr/bin/env bash
# Verify @tauri-apps/api (npm) and tauri (cargo) share the same major.minor.
# Tauri 2.x requires aligned frontend IPC bindings and backend crate versions.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

npm_major_minor() {
  node --input-type=module -e "
    import { readFileSync } from 'node:fs';
    const pkg = JSON.parse(readFileSync('${ROOT}/package.json', 'utf8'));
    const raw = pkg.dependencies['@tauri-apps/api'] ?? '';
    const m = raw.replace(/^[\^~>=<]*/, '').match(/^(\d+\.\d+)/);
    if (!m) {
      console.error('Could not parse @tauri-apps/api version from package.json');
      process.exit(1);
    }
    console.log(m[1]);
  "
}

cargo_major_minor() {
  awk '
    /^name = "tauri"$/ {
      getline
      if ($1 == "version") {
        gsub(/version = "|"/, "", $3)
        split($3, parts, ".")
        printf "%s.%s\n", parts[1], parts[2]
        exit
      }
    }
  ' "${ROOT}/src-tauri/Cargo.lock"
}

NPM_MM="$(npm_major_minor)"
CARGO_MM="$(cargo_major_minor)"

if [ -z "${CARGO_MM}" ]; then
  echo "Could not find tauri crate version in src-tauri/Cargo.lock" >&2
  exit 1
fi

if [ "${NPM_MM}" != "${CARGO_MM}" ]; then
  echo "Tauri version mismatch: @tauri-apps/api is ${NPM_MM}.x but Cargo.lock tauri is ${CARGO_MM}.x" >&2
  echo "Align npm @tauri-apps/* packages and the src-tauri tauri crate to the same major.minor." >&2
  exit 1
fi

echo "Tauri version coupling OK: ${NPM_MM}.x (npm) matches ${CARGO_MM}.x (cargo)"