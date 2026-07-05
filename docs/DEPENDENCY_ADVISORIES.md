# Dependency security advisories

This document records **accepted residual risk** from transitive Rust dependencies
and the **bump policy** for security-sensitive pins. CI enforces the same ignores
via `src-tauri/.cargo/audit.toml` and `.github/workflows/security.yml`.

## RUSTSEC-2023-0071 — `rsa` Marvin timing sidechannel

| Field | Detail |
|-------|--------|
| Advisory | [RUSTSEC-2023-0071](https://rustsec.org/advisories/RUSTSEC-2023-0071.html) |
| Crate | `rsa` (transitive) |
| Path | `russh` → `ssh-key` → `rsa` (`cargo tree -i rsa`) |
| Upstream status | No fixed `rsa` release; unresolved timing sidechannel in RSA decryption |

### Why we accept the risk

- Tunara is an **interactive desktop SSH client**, not a server doing high-volume RSA operations.
- Exploitation requires an **active network MITM** harvesting many RSA decryption timing samples.
- Tunara **prefers ed25519** keys (agent / configured key first); RSA host-key and pubkey auth are fallbacks.
- Dropping `rsa` would mean dropping RSA-server compatibility entirely.

### When to revisit

- `rsa` ships a release that addresses the advisory, **or**
- `russh` exposes a feature flag to build without RSA support and we accept the compatibility trade-off.

Then: `cargo update`, re-run `cargo audit`, and remove `RUSTSEC-2023-0071` from `audit.toml` and the security workflow ignores.

---

## RUSTSEC-2026-0194 / RUSTSEC-2026-0195 — `quick-xml` unbounded allocation DoS

| Field | Detail |
|-------|--------|
| Advisories | [RUSTSEC-2026-0194](https://rustsec.org/advisories/RUSTSEC-2026-0194.html), [RUSTSEC-2026-0195](https://rustsec.org/advisories/RUSTSEC-2026-0195.html) |
| Crate | `quick-xml` (transitive) |
| Path | `tauri` → `plist` → `quick-xml` (`cargo tree -i quick-xml`) |
| Fixed in | `quick-xml` ≥ 0.41.0 |
| Blocked by | Latest `plist` (1.9.0, locked) still pins `quick-xml` 0.39.x |

### Why we accept the risk

- `quick-xml` here parses **local macOS property lists** (app bundle `Info.plist`, system plists) read by Tauri — trusted, local input, not network-facing XML.
- Worst case is a **memory-exhaustion DoS of the local desktop app**; a local attacker who can plant a malicious plist has simpler attack paths.

### When to revisit

- `plist` releases a version on `quick-xml` ≥ 0.41.

Then:

```bash
cargo update -p plist -p quick-xml
cargo audit   # should pass without quick-xml ignores
```

Remove `RUSTSEC-2026-0194` and `RUSTSEC-2026-0195` from `audit.toml` and `.github/workflows/security.yml`.

---

## `russh` exact patch pin policy

`src-tauri/Cargo.toml` pins:

```toml
russh = "=0.61.2"
```

`russh` is **pre-1.0** and has shipped breaking changes across patch releases. The exact pin locks the reviewed SSH transport stack (connect/auth, channel multiplexing, SFTP subsystem, key handling via `russh::keys`).

### When to bump `russh`

Only **deliberately**, never via a blind `cargo update`:

1. Read `russh` / `russh-sftp` changelogs for breaking API or behavior changes.
2. Run the full test matrix locally: `cargo test`, SSH integration smoke (connect, shell, SFTP, known_hosts TOFU).
3. Re-run `cargo audit` and update `audit.toml` / security workflow ignores if the transitive graph changes.
4. Update the pin comment in `Cargo.toml` with the reviewed version and rationale.
5. If the bump changes SSH error strings, check `src/modules/ssh/failure-reason.ts` substring matchers.

---

## Dependency bump checklist (security-sensitive)

Use this checklist whenever bumping **Tauri**, **russh**, or running a broad `cargo update`:

| Step | Action |
|------|--------|
| 1 | `bash scripts/check-tauri-version-coupling.sh` — npm `@tauri-apps/*` major.minor must match `Cargo.lock` `tauri` |
| 2 | `cargo audit` — no new unignored advisories |
| 3 | `pnpm audit --prod --audit-level high` — no new high/critical npm issues |
| 4 | `cargo test` + `pnpm test:node` |
| 5 | macOS: `cargo build --release --bin tunara` (CI macOS job) or full `pnpm tauri build` for bundle/signing changes |
| 6 | macOS titlebar / vibrancy: visual check per [CLAUDE.md](../CLAUDE.md#macos-titlebar-alignment) |
| 7 | Update this doc, `CHANGELOG.md` Known security advisories, and `audit.toml` if ignore rationale changes |