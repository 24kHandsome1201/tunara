#!/usr/bin/env bash
# Generates the throwaway client key pairs the matrix containers trust
# (tests/ssh-matrix/.generated/, git-ignored). Idempotent: existing keys are
# kept so a running fixture stays valid across repeated test runs.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
out="$here/.generated/client"
mkdir -p "$out"
chmod 700 "$here/.generated" "$out"

if [ ! -f "$out/id_ed25519" ]; then
    ssh-keygen -q -t ed25519 -N '' -C tunara-matrix-ed25519 -f "$out/id_ed25519"
fi
if [ ! -f "$out/id_rsa" ]; then
    ssh-keygen -q -t rsa -b 3072 -N '' -C tunara-matrix-rsa -f "$out/id_rsa"
fi
# The bind mount is read by root inside the container; keep the private keys
# owner-only for the local ssh-agent and let the public halves be world-readable.
chmod 600 "$out"/id_ed25519 "$out"/id_rsa
chmod 644 "$out"/id_ed25519.pub "$out"/id_rsa.pub
echo "matrix client keys ready in $out"
