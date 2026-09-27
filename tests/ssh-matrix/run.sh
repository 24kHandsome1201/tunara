#!/usr/bin/env bash
# Runs the gated Rust real-SSH matrix against an already-running fixture
# (docker compose -f tests/ssh-matrix/docker-compose.yml up -d --build --wait).
#
# The test binary is built with the caller's HOME, then executed with HOME
# pointed at a throwaway directory so known_hosts.rs, the download sandbox
# and the agent lookup never touch the developer's or the CI runner's real
# ~/.ssh. A private ssh-agent holding only the fixture ed25519 key backs the
# agent scenario. Extra arguments are forwarded to the test harness, e.g.
# `run.sh --nocapture` or `run.sh matrix_tests::auth`.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
manifest="$repo/src-tauri/Cargo.toml"

"$here/keygen.sh" >/dev/null

export TUNARA_SSH_MATRIX_HOST="${TUNARA_SSH_MATRIX_HOST:-127.0.0.1}"
export TUNARA_SSH_MATRIX_TARGET_PORT="${TUNARA_SSH_MATRIX_TARGET_PORT:-2201}"
export TUNARA_SSH_MATRIX_JUMP_PORT="${TUNARA_SSH_MATRIX_JUMP_PORT:-2202}"
export TUNARA_SSH_MATRIX_KEYS="$here/.generated/client"
export TUNARA_SSH_MATRIX_PW_PASSWORD="${TUNARA_SSH_MATRIX_PW_PASSWORD:-tunara-matrix-pw}"
export TUNARA_SSH_MATRIX_KBD_PASSWORD="${TUNARA_SSH_MATRIX_KBD_PASSWORD:-tunara-matrix-kbd}"
export TUNARA_SSH_MATRIX_GREP_BUDGET_MS="${TUNARA_SSH_MATRIX_GREP_BUDGET_MS:-3000}"

wait_port() {
    local port="$1" label="$2" i
    for i in $(seq 1 60); do
        if bash -c "exec 3<>/dev/tcp/$TUNARA_SSH_MATRIX_HOST/$port" 2>/dev/null; then
            return 0
        fi
        sleep 1
    done
    echo "ssh-matrix: $label hop is not accepting connections on $TUNARA_SSH_MATRIX_HOST:$port" >&2
    echo "ssh-matrix: start it with: docker compose -f tests/ssh-matrix/docker-compose.yml up -d --build --wait" >&2
    exit 1
}
wait_port "$TUNARA_SSH_MATRIX_TARGET_PORT" target
wait_port "$TUNARA_SSH_MATRIX_JUMP_PORT" jump

# Compile with the real HOME so rustup/cargo resolve their toolchain dirs.
cargo test --manifest-path "$manifest" --lib --features ssh-matrix --no-run

matrix_home="$(mktemp -d "${TMPDIR:-/tmp}/tunara-ssh-matrix-home.XXXXXX")"
# Physical path: known_hosts.rs walks every parent with O_NOFOLLOW, and macOS
# $TMPDIR lives under /var -> /private/var (see docs/TESTING.md).
matrix_home="$(cd "$matrix_home" && pwd -P)"
mkdir -p "$matrix_home/.ssh"
chmod 700 "$matrix_home/.ssh"
export TUNARA_SSH_MATRIX_HOME="$matrix_home"

agent_pid=""
cleanup() {
    if [ -n "$agent_pid" ]; then
        kill "$agent_pid" 2>/dev/null || true
    fi
    rm -rf "$matrix_home"
}
trap cleanup EXIT

eval "$(ssh-agent -s -a "$matrix_home/agent.sock")" >/dev/null
agent_pid="$SSH_AGENT_PID"
ssh-add -q "$TUNARA_SSH_MATRIX_KEYS/id_ed25519"
export SSH_AUTH_SOCK

# HOME is swapped only for the test process; CARGO_HOME/RUSTUP_HOME stay
# pinned to the real toolchain so the `cargo` proxy still finds it.
env HOME="$matrix_home" \
    CARGO_HOME="${CARGO_HOME:-$HOME/.cargo}" \
    RUSTUP_HOME="${RUSTUP_HOME:-$HOME/.rustup}" \
    cargo test --manifest-path "$manifest" --lib --features ssh-matrix \
    -- ssh::matrix_tests "$@"
