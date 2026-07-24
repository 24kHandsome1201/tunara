import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const read = (path) => fs.readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("Phase 2 local writes require a fingerprint and expose structured conflicts", () => {
  const backend = read("src-tauri/src/modules/fs/file.rs");
  const bridge = read("src/modules/fs/fs-bridge.ts");
  const runtime = read("src-tauri/src/lib.rs");

  assert.match(backend, /expected_fingerprint: String/);
  assert.match(backend, /WriteResult::Conflict/);
  assert.match(backend, /create_new\(true\)/);
  assert.match(backend, /set_permissions\(original_metadata\.permissions\(\)\)/);
  assert.match(backend, /sync_all\(\)/);
  assert.match(backend, /std::fs::rename\(&temporary_path, &target\)/);
  assert.match(backend, /file_type\(\)\.is_symlink\(\)/);
  assert.match(bridge, /status: "conflict"; currentFingerprint: string/);
  assert.match(bridge, /invoke<WriteTextResult>\("fs_write_text_file"/);
  assert.match(runtime, /fs::file::fs_write_text_file/);
});

test("Phase 2 local safe-write Linux gate uses real fixtures, unprivileged failure, and atomic stress", () => {
  const backend = read("src-tauri/src/modules/fs/file.rs");
  const runner = read("scripts/benchmark-m2-local-safe-write-linux.sh");

  assert.match(backend, /local_save_reopen_same_size_conflict_and_residue_closure/);
  assert.match(backend, /unwritable_parent_failure_preserves_original_and_leaves_no_residue/);
  assert.match(backend, /atomic_replace_stress_never_exposes_partial_content/);
  assert.match(backend, /assert_eq!\(fs::read\(&path\)\.unwrap\(\), b"other!\\n"\)/);
  assert.match(backend, /assert_eq!\(fs::read\(&path\)\.unwrap\(\), b"original\\n"\)/);
  assert.match(backend, /partialObservations/);
  assert.match(backend, /temporaryResidue/);
  assert.match(runner, /runuser -u nobody/);
  assert.match(runner, /TUNARA_LOCAL_SAFE_WRITE_ROUNDS/);
  assert.match(runner, /m2-local-safe-write-linux/);
});

test("Phase 2 SSH writes preserve the local conflict-safe contract", () => {
  const backend = read("src-tauri/src/modules/ssh/sftp.rs");
  const transaction = read("src-tauri/src/modules/ssh/safe_write.rs");
  const bridge = read("src/modules/ssh/remote-fs-bridge.ts");
  const reconcile = read("src/modules/ssh/ssh-write-reconcile.ts");
  const runtime = read("src-tauri/src/lib.rs");

  assert.match(backend, /ssh_fs_write_text_file/);
  assert.match(backend, /expected_fingerprint: String/);
  assert.match(backend, /symlink_metadata\(&?path\)/);
  assert.match(backend, /OpenFlags::WRITE \| OpenFlags::CREATE \| OpenFlags::EXCLUDE/);
  assert.match(backend, /temporary\.write_all/);
  assert.match(backend, /temporary\.flush/);
  assert.match(backend, /temporary\.set_metadata/);
  assert.match(backend, /temporary\.sync_all/);
  assert.match(backend, /temporary\.shutdown/);
  assert.match(backend, /for attempt in 0\.\.16/);
  assert.match(transaction, /latest_fingerprint != request\.expected_fingerprint/);
  assert.match(transaction, /enum TransactionOutcome/);
  assert.match(transaction, /OutcomeUnknown/);
  assert.match(transaction, /acquire_replace_lock/);
  assert.match(transaction, /release_replace_lock/);
  assert.match(transaction, /async fn cleanup/);
  assert.match(backend, /mv -f --/);
  assert.match(backend, /remote_write_lock\(id, &path\)/);
  assert.match(backend, /outcomeUnknown:/);
  assert.match(backend, /lockOwner=\{replace_lock_owner\}/);
  assert.match(backend, /cleanup_owned_write_residue/);
  assert.match(backend, /remote_replace_lock_path/);
  assert.match(backend, /create_dir\(lock\.clone\(\)\)/);
  assert.match(backend, /REPLACE_LOCK_STALE_AFTER/);
  assert.match(backend, /stale_replace_lock_error/);
  assert.match(backend, /refusing automatic removal/);
  assert.doesNotMatch(backend, /if stale \{[\s\S]{0,600}remove_(?:file|dir)/);
  assert.match(backend, /ssh_fs_reconcile_text_write/);
  assert.match(backend, /reconcile_text_write_with_sftp/);
  assert.match(backend, /real_ssh_replace_status_loss_reconciles_saved_on_a_fresh_connection/);
  assert.match(backend, /observed_mode == expected_mode/);
  assert.doesNotMatch(backend, /remove_file\(&path\)/);
  assert.doesNotMatch(transaction, /remove.*target/);
  assert.match(bridge, /invoke<WriteTextResult>\("ssh_fs_write_text_file"/);
  assert.match(runtime, /ssh::sftp::ssh_fs_write_text_file/);
  assert.match(runtime, /ssh::sftp::ssh_fs_reconcile_text_write/);
  assert.match(bridge, /invoke<WriteTextResult>\("ssh_fs_reconcile_text_write"/);
  assert.match(bridge, /parseSshWriteOutcomeUnknown\(error\)/);
  assert.match(reconcile, /cleanupPending: boolean/);
  assert.match(reconcile, /replaceLockOwner: string/);
  assert.match(reconcile, /cleanupPending=\(true\|false\)/);
  const editor = read("src/ui/FilePreview.tsx");
  assert.match(editor, /parseSshWriteOutcomeUnknown\(error\)/);
  assert.match(editor, /sshReconcileOutcomeUnknownTextWrite\(/);
  assert.match(editor, /saveState === "unknown"/);
  assert.match(editor, /unknownOutcome\?\.cleanupPending/);
  assert.match(editor, /disabled=\{remoteDisconnected \|\| !dirty \|\| saveState === "saving" \|\| saveState === "reconciling" \|\| saveState === "unknown"\}/);
});
