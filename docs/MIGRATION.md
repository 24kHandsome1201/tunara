# Migration

## Conduit → Tunara

The product rename from **Conduit** to **Tunara** is complete. Tunara is the
supported application identity; Conduit paths exist only as a read-only upgrade
bridge for persisted state.

### What migrated automatically

On first launch after upgrading, Tunara:

1. Opens `tunara-sessions.json` in the plugin store.
2. If that store is still empty, reads legacy `conduit-sessions.json`, copies
   every entry into the new store, saves, and continues with the Tunara file.
3. Reads config from the Tunara config directory; legacy `~/.config/conduit`
   entries are imported through the Rust config migration path when needed.

The migration is **one-way and lazy**: once `tunara-sessions.json` contains
any data, the legacy session file is never read again.

### Legacy paths (read-only)

| Legacy (Conduit) | Current (Tunara) | Status |
| --- | --- | --- |
| `conduit-sessions.json` | `tunara-sessions.json` | Read once for migration, then ignored |
| `~/.config/conduit/` | Tunara config dir | Migrated on read; new writes go to Tunara |
| `conduit-agent` OSC prefix | `tunara-agent` | Still accepted for compatibility |

### Planned removal

Legacy Conduit filenames and OSC prefixes remain for backward compatibility.
**Removal version: TBD.** They will be dropped only after a release window where
existing users have had time to open Tunara once and complete the lazy
migration.

### Verify you have migrated

1. Launch Tunara and open **Settings** — confirm the app title and identifier
   show Tunara (dev builds may display as **Tuna** with `dev.tunara.app.dev`).
2. Check that your sessions, notes, workflows, and layout restored correctly.
3. Confirm the plugin store now contains data under `tunara-sessions.json`.
   The legacy `conduit-sessions.json` may still exist on disk but should no
   longer be updated.
4. Optional: search your workspace snapshot for Conduit-only keys. After a
   normal save cycle, new state should be written through the Tunara snapshot
   path documented in [`STATE_AND_PERSISTENCE.md`](./STATE_AND_PERSISTENCE.md).

If anything still appears to load only from Conduit paths, file an issue with
the on-disk store filenames and your Tunara version.