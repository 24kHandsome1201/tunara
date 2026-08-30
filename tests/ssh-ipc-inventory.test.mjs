import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);
const lib = await readFile(new URL("src-tauri/src/lib.rs", root), "utf8");

const mapped = {
  "mod.rs": {
    ssh_open: "OpenLegacy",
    ssh_host_key_decision: "HostDecision",
    ssh_keyboard_interactive_response: "KeyboardInteractive",
  },
  "hosts.rs": Object.fromEntries(["ssh_hosts_load", "ssh_hosts_save", "ssh_hosts_remove", "ssh_hosts_import_config"].map((name) => [name, "Hosts"])),
  "known_hosts.rs": Object.fromEntries(["ssh_known_hosts_list_v1", "ssh_known_hosts_remove_v1", "ssh_known_hosts_refresh_v1"].map((name) => [name, "KnownHosts"])),
  "sftp.rs": {
    ssh_fs_read_dir: "SftpRead", ssh_fs_read_file: "SftpRead", ssh_fs_home: "SftpRead",
    ssh_fs_write_text_file: "SftpWrite", ssh_fs_reconcile_text_write: "SftpWrite",
  },
  "transfer/legacy.rs": { ssh_fs_download: "Transfer", ssh_fs_upload: "Transfer" },
  "transfer/engine.rs": { ssh_transfer_download: "Transfer", ssh_transfer_upload: "Transfer" },
  "transfer/manifest.rs": { validate_manifest: "Manifest" },
  "transfer/upload_plan.rs": Object.fromEntries([
    "ssh_upload_preflight_v1", "ssh_upload_materialize_v1",
    "ssh_upload_materialization_reconcile_v1",
  ].map((name) => [name, "Manifest"])),
  "transfer_journal.rs": Object.fromEntries([
    "ssh_transfer_journal_load", "ssh_transfer_journal_save", "ssh_transfer_journal_list_owned_partials",
    "ssh_transfer_journal_cleanup", "ssh_transfer_recovery_prepare",
    "ssh_transfer_recovery_reconcile", "ssh_transfer_recovery_dismiss",
  ].map((name) => [name, "Journal"])),
  "remote_fs/commands.rs": { ssh_fs_mutate_v1: "RemoteFs", ssh_fs_reconcile_mutation_v1: "RemoteFs" },
  "remote_fs/metadata.rs": { ssh_fs_stat_v1: "RemoteFs", ssh_fs_chmod_v1: "RemoteFs" },
  "forwarding.rs": Object.fromEntries([
    "ssh_local_forward_start", "ssh_local_forward_list", "ssh_local_forward_stop",
    "ssh_dynamic_forward_start", "ssh_dynamic_forward_list", "ssh_dynamic_forward_stop",
    "ssh_remote_forward_start", "ssh_remote_forward_list", "ssh_remote_forward_stop",
    "ssh_forwarding_reconnect_snapshot", "ssh_forwarding_reconnect_rebuild",
  ].map((name) => [name, "Forwarding"])),
  "remote_git.rs": Object.fromEntries([
    "ssh_git_diff", "ssh_git_workspace_context",
    "ssh_fs_search", "ssh_fs_grep",
  ].map((name) => [name, "RemoteGit"])),
  "system_monitor.rs": { ssh_system_snapshot_v1: "SystemMonitor" },
};

// Strict exemptions: these commands cannot leak a Result<String> error. The two
// run/open and bounded-view v1 commands return typed errors; cancel commands
// return bool, while transfer cancellation returns the typed CancelResult enum.
const exemptions = new Set([
  "ssh_open_v2", "ssh_diagnostic_run_v1", "ssh_cancel_open",
  "ssh_diagnostic_cancel_v1", "ssh_fs_cancel_upload", "ssh_transfer_cancel",
  "ssh_file_view_head_v1", "ssh_file_view_tail_v1",
  "ssh_fs_read_if_changed_v1",
  "ssh_remote_git_snapshot_v1",
]);

const addedSshCommands = [
  "ssh_open_v2", "ssh_diagnostic_run_v1", "ssh_diagnostic_cancel_v1",
  "ssh_local_forward_start", "ssh_local_forward_list", "ssh_local_forward_stop",
  "ssh_dynamic_forward_start", "ssh_dynamic_forward_list", "ssh_dynamic_forward_stop",
  "ssh_remote_forward_start", "ssh_remote_forward_list", "ssh_remote_forward_stop",
  "ssh_forwarding_reconnect_snapshot", "ssh_forwarding_reconnect_rebuild",
  "ssh_known_hosts_list_v1", "ssh_known_hosts_remove_v1", "ssh_known_hosts_refresh_v1",
  "ssh_fs_mutate_v1", "ssh_fs_reconcile_mutation_v1", "ssh_fs_stat_v1", "ssh_fs_chmod_v1",
  "ssh_transfer_download", "ssh_transfer_upload", "ssh_transfer_cancel",
  "ssh_transfer_journal_load", "ssh_transfer_journal_save",
  "ssh_transfer_journal_list_owned_partials", "ssh_transfer_journal_cleanup",
  "ssh_transfer_recovery_prepare", "ssh_transfer_recovery_reconcile",
  "ssh_transfer_recovery_dismiss", "validate_manifest",
  "ssh_fs_read_if_changed_v1",
  "ssh_upload_preflight_v1", "ssh_upload_materialize_v1",
  "ssh_upload_materialization_reconcile_v1",
];

function functionSource(source, name) {
  const start = source.search(new RegExp(`pub\\s+(?:async\\s+)?fn\\s+${name}\\b`));
  assert.notEqual(start, -1, `missing command function ${name}`);
  const open = source.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === "{") depth += 1;
    if (source[i] === "}" && --depth === 0) return source.slice(start, i + 1);
  }
  assert.fail(`unterminated command function ${name}`);
}

const block = lib.match(/tauri::generate_handler!\[([\s\S]*?)\]\)/)?.[1] ?? "";
const registrations = [...block.matchAll(/modules::ssh(?:::[a-z_]+)*::([a-z_][a-z0-9_]+)/g)]
  .map((match) => match[1]);
const expected = new Set(Object.values(mapped).flatMap((commands) => Object.keys(commands)));

test("registered SSH command inventory is explicit and complete", () => {
  assert.deepEqual(new Set(registrations), new Set([...expected, ...exemptions]));
});

test("all 36 added SSH commands are registered, permitted, and present in generated ACL", async () => {
  assert.equal(addedSshCommands.length, 36);
  const permission = await readFile(new URL("src-tauri/permissions/main.toml", root), "utf8");
  const acl = JSON.parse(await readFile(new URL("src-tauri/gen/schemas/acl-manifests.json", root), "utf8"));
  const generated = acl["__app-acl__"].permissions["allow-main-commands"].commands.allow;
  for (const command of addedSshCommands) {
    assert.ok(registrations.includes(command), `${command} is not registered`);
    assert.match(permission, new RegExp(`"${command}"`), `${command} is not permitted`);
    assert.ok(generated.includes(command), `${command} is absent from generated ACL`);
  }
});

test("every non-exempt registered SSH Result<String> command maps its final error", async () => {
  for (const [file, commands] of Object.entries(mapped)) {
    const source = await readFile(new URL(`src-tauri/src/modules/ssh/${file}`, root), "utf8");
    for (const [name, kind] of Object.entries(commands)) {
      assert.ok(registrations.includes(name), `${file}:${name} is not registered`);
      const fn = functionSource(source, name);
      const gitStatusCommands = new Set([
        "ssh_git_diff",
        "ssh_git_workspace_context",
      ]);
      const mapper = kind === "RemoteGit" && gitStatusCommands.has(name)
        ? /map_remote_git_error\(/
        : file === "transfer/upload_plan.rs"
          ? /(?:safe_ipc_error|map_err\(safe\)|safe\()/
        : new RegExp(`safe_ipc_error\\(\\s*(?:crate::modules::ssh::)?SshIpcErrorKind::${kind}\\b`);
      assert.match(fn, mapper, `${file}:${name} must map its final Err as ${kind}`);
    }
  }
});

test("safe mapper has fixed output for every error class", async () => {
  const ssh = await readFile(new URL("src-tauri/src/modules/ssh/mod.rs", root), "utf8");
  for (const kind of new Set(Object.values(mapped).flatMap((commands) => Object.values(commands)))) {
    assert.match(ssh, new RegExp(`SshIpcErrorKind::${kind}\\s*=>\\s*"[A-Z_]+"`));
  }
});

test("forward cancellation and late channel close never shut down the shared transport", async () => {
  const connection = await readFile(new URL("src-tauri/src/modules/ssh/connection.rs", root), "utf8");
  const start = connection.indexOf("async fn close_forward_channel_owned");
  const end = connection.indexOf("#[derive(Debug)]\npub enum RoutedOpenError", start);
  const forwardingOwnership = connection.slice(start, end);
  assert.ok(start >= 0 && end > start);
  assert.match(forwardingOwnership, /timeout\(Duration::from_secs\(2\), channel\.close\(\)\)/);
  assert.doesNotMatch(forwardingOwnership, /transport_abort|Shutdown::Both|\.disconnect\(/);

  const openStart = connection.indexOf("async fn await_pending_forward_open");
  const openEnd = connection.indexOf("#[derive(Debug)]\npub enum RoutedOpenError", openStart);
  const pendingOpen = connection.slice(openStart, openEnd);
  assert.ok(openStart >= 0 && openEnd > openStart);
  assert.match(pendingOpen, /local forward cancelled/);
  assert.match(pendingOpen, /port forward channel timed out/);
  assert.doesNotMatch(pendingOpen, /transport_abort|Shutdown::Both|\.disconnect\(/);
  assert.match(connection, /async fn open_forward_channel[\s\S]*await_pending_forward_open\(/);
});

test("multiplexed shell setup consumes cancellation and closes only its late channel", async () => {
  const connection = await readFile(new URL("src-tauri/src/modules/ssh/connection.rs", root), "utf8");
  const ssh = await readFile(new URL("src-tauri/src/modules/ssh/mod.rs", root), "utf8");

  assert.match(connection, /open_from_shared\([\s\S]*cancel: watch::Receiver<bool>/);
  assert.match(connection, /await_pending_shell_open\([\s\S]*cancelled\.changed\(\)/);
  assert.match(connection, /map\(ForwardChannel::new\)/);
  assert.match(connection, /await_shell_setup_stage\(\s*"request PTY"/);
  assert.match(connection, /await_shell_setup_stage\(\s*"request shell"/);
  assert.match(connection, /bootstrap_cancelled\.store\(true, Ordering::Release\)/);
  assert.doesNotMatch(connection.slice(
    connection.indexOf("async fn await_pending_shell_open"),
    connection.indexOf("async fn await_pending_exec_open"),
  ), /transport_abort|Shutdown::Both|\.disconnect\(/);
  assert.match(ssh, /if let Some\(shared\) = shared[\s\S]*open_from_shared\([\s\S]*cancel_receiver/);
  assert.doesNotMatch(ssh, /let \(_cancel, guard\) = register_open_attempt/);
});

test("forward stop carries and atomically validates the complete SSH binding", async () => {
  const bridge = await readFile(new URL("src/modules/ssh/forwarding-bridge.ts", root), "utf8");
  const backend = await readFile(new URL("src-tauri/src/modules/ssh/forwarding.rs", root), "utf8");
  for (const [kind, command] of [
    ["Local", "ssh_local_forward_stop"],
    ["Dynamic", "ssh_dynamic_forward_stop"],
    ["Remote", "ssh_remote_forward_stop"],
  ]) {
    assert.match(bridge, new RegExp(`stop${kind}Forward\\(binding: SessionBindingV1, ruleId: string\\)`));
    assert.match(bridge, new RegExp(`"${command}", \\{ binding, ruleId \\}`));
    const commandSource = functionSource(backend, command);
    assert.match(commandSource, /binding: SessionBindingV1/);
    assert.match(commandSource, /cancel_bound_rule\(&pty, &state, &binding, &rule_id/);
  }
  const helperStart = backend.indexOf("fn cancel_bound_rule");
  const helperEnd = backend.indexOf("async fn wait_for_rule_stop", helperStart);
  const helper = backend.slice(helperStart, helperEnd);
  assert.match(helper, /get_for_ssh_binding\(binding\)/);
  assert.match(helper, /acquire_commit_lease\(binding\)/);
  assert.match(helper, /rule\.view\.binding\(\) != binding/);
  assert.match(helper, /Arc::ptr_eq\(&rule\.generation, &current\)/);
  assert.match(helper, /rule\.cancel\.send\(true\)/);
});

test("transfer resume IPC accepts only a durable recovery ownership token", async () => {
  const bridge = await readFile(new URL("src/modules/ssh/transfer-bridge.ts", root), "utf8");
  const backend = await readFile(new URL("src-tauri/src/modules/ssh/transfer/engine.rs", root), "utf8");
  const journal = await readFile(new URL("src-tauri/src/modules/ssh/transfer_journal.rs", root), "utf8");
  const sftp = await readFile(new URL("src-tauri/src/modules/ssh/sftp.rs", root), "utf8");

  assert.match(bridge, /recoveryId\?: string/);
  assert.doesNotMatch(bridge, /\bresume(?:From|Partial)\b/);
  for (const command of ["ssh_transfer_download", "ssh_transfer_upload"]) {
    const commandSource = functionSource(backend, command);
    assert.match(commandSource, /recovery_id: Option<String>/);
    assert.doesNotMatch(commandSource, /\bresume_(?:from|partial)\b/);
    assert.match(commandSource, /validated_resume_record\(/);
    assert.match(commandSource, /transfer_journal::reactivate\(/);
  }
  const downloadSource = functionSource(backend, "ssh_transfer_download");
  assert.match(downloadSource, /Re-read the same open handle before publishing every download/);
  assert.match(downloadSource, /remote download verification SHA-256 mismatch/);
  assert.match(downloadSource, /download commit intent could not be persisted/);
  assert.match(downloadSource, /Verify the final path before reporting Completed/);
  assert.match(sftp, /Mandatory full SFTP readback proves the server-side partial bytes/);
  assert.match(sftp, /remote upload readback SHA-256 mismatch/);
  assert.match(sftp, /indeterminate published outcome, never a completed upload/);
  assert.match(sftp, /sftp\.hardlink\(&partial_path, &remote_path\)/);
  assert.match(sftp, /upload source contents changed during transfer/);
  assert.match(journal, /records\[index\] != \*expected \|\| !records\[index\]\.paused/);
  assert.match(journal, /transfer partial has multiple journal owners/);
});
