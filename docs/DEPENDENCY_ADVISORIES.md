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

## RUSTSEC-2026-0235 — `rkyv` shared-pointer archive validation OOB read

| Field | Detail |
|-------|--------|
| Advisory | [RUSTSEC-2026-0235](https://rustsec.org/advisories/RUSTSEC-2026-0235.html) |
| Crate | `rkyv` 0.7.46 (transitive) |
| Path | `tauri-plugin-log` → `byte-unit` → `rust_decimal` (rkyv feature) → `rkyv` |
| Upstream status | Patched in `rkyv` ≥ 0.8.17; the 0.7 series is unmaintained. `rust_decimal` 1.x still pulls 0.7 |

### Why we accept the risk

- Tunara **does not deserialize rkyv archives**, trusted or otherwise. The crate is unused application code; it is only linked because `byte-unit` enables `rust_decimal`'s default `rkyv` feature for decimal formatting.
- The advisory requires a crafted archive consumed through `rkyv::access` / `rkyv::from_bytes`. That API is not on Tunara's product surface.
- Bumping to `rkyv` 0.8 would mean replacing `tauri-plugin-log` / `byte-unit` / `rust_decimal`, not a lockfile-only bump.

### When to revisit

- `tauri-plugin-log` or `byte-unit` drop the `rust_decimal` rkyv feature, **or**
- `rust_decimal` moves to `rkyv` ≥ 0.8.17.

Then: `cargo update`, re-run `cargo audit`, and remove `RUSTSEC-2026-0235` from `audit.toml` and the security workflow ignores.

---

## Resolved: RUSTSEC-2026-0194 / RUSTSEC-2026-0195 — `quick-xml` unbounded allocation DoS

| Field | Detail |
|-------|--------|
| Advisories | [RUSTSEC-2026-0194](https://rustsec.org/advisories/RUSTSEC-2026-0194.html), [RUSTSEC-2026-0195](https://rustsec.org/advisories/RUSTSEC-2026-0195.html) |
| Crate | `quick-xml` (transitive) |
| Path | `tauri` → `plist` → `quick-xml` (`cargo tree -i quick-xml`) |
| Fixed in | `quick-xml` ≥ 0.41.0 |
| Resolved | 2026-07-10: `plist` 1.10.0 permits `quick-xml` 0.41.0 |

### Resolution

- Updated the lockfile to `plist` 1.10.0 and `quick-xml` 0.41.0.
- Removed both advisory exceptions from `audit.toml` and the security workflow.
- The dependency path remains covered by the normal `cargo audit` gate.

```bash
cargo audit --ignore RUSTSEC-2023-0071 --ignore RUSTSEC-2026-0235
```

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
| 6 | macOS titlebar / vibrancy: visual check per [VISUAL_QA.md](./VISUAL_QA.md) |
| 7 | Update this doc, `CHANGELOG.md` Known security advisories, and `audit.toml` if ignore rationale changes |
