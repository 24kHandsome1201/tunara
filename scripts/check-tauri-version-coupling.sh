#!/usr/bin/env bash
# Verify npm @tauri-apps/api and @tauri-apps/plugin-* share major.minor with
# the matching crates in src-tauri/Cargo.lock. `tauri build` refuses mismatched
# plugin pairs (v2.0.0's first Release run failed on plugin-log 2.8 vs 2.9).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export TUNARA_ROOT="$ROOT"

node --input-type=module <<'EOF'
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.env.TUNARA_ROOT;
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const lock = readFileSync(join(root, "src-tauri/Cargo.lock"), "utf8");

const cargoVersions = new Map();
for (const block of lock.split("\n[[package]]\n")) {
  const name = block.match(/^name = "([^"]+)"/m)?.[1];
  const version = block.match(/^version = "([^"]+)"/m)?.[1];
  if (name && version && !cargoVersions.has(name)) cargoVersions.set(name, version);
}

function majorMinor(raw, label) {
  const m = String(raw).replace(/^[\^~>=<]*/, "").match(/^(\d+\.\d+)/);
  if (!m) {
    console.error(`Could not parse version for ${label}: ${raw}`);
    process.exit(1);
  }
  return m[1];
}

const pairs = [["@tauri-apps/api", "tauri"]];
for (const name of Object.keys({ ...pkg.dependencies, ...pkg.devDependencies })) {
  const plugin = name.match(/^@tauri-apps\/plugin-(.+)$/)?.[1];
  if (plugin) pairs.push([name, `tauri-plugin-${plugin}`]);
}

let failed = 0;
for (const [npmName, crate] of pairs) {
  const npmRaw = pkg.dependencies?.[npmName] ?? pkg.devDependencies?.[npmName];
  if (!npmRaw) continue;
  const cargoRaw = cargoVersions.get(crate);
  if (!cargoRaw) {
    console.error(`Missing ${crate} in src-tauri/Cargo.lock (paired with ${npmName})`);
    failed += 1;
    continue;
  }
  const npmMM = majorMinor(npmRaw, npmName);
  const cargoMM = majorMinor(cargoRaw, crate);
  if (npmMM !== cargoMM) {
    console.error(
      `Tauri version mismatch: ${npmName} is ${npmMM}.x but Cargo.lock ${crate} is ${cargoMM}.x (${cargoRaw})`,
    );
    failed += 1;
    continue;
  }
  console.log(`OK ${npmName} ${npmMM}.x ↔ ${crate} ${cargoRaw}`);
}

if (failed) {
  console.error(
    "Align npm @tauri-apps/* packages and the matching src-tauri crates to the same major.minor.",
  );
  process.exit(1);
}

console.log(`Tauri version coupling OK: ${pairs.length} npm/cargo pairs`);
EOF
