// Saved SSH host profiles (Phase 2).
//
// Profiles live in their own file, ~/.config/tunara/hosts.toml, separate from
// the comment-preserving appearance config — host management is a flat
// load/save/remove list and doesn't need toml_edit's merge machinery.
//
// IMPORTANT: profiles store NO secrets. Only host/port/user and an optional
// identity-file PATH. Passwords and passphrases are never written to disk.

mod effective;
mod import;
mod patterns;
mod profile;
mod resolver;
#[cfg(test)]
mod tests;

pub use import::ssh_hosts_import_config;
pub use profile::{ssh_hosts_load, ssh_hosts_remove, ssh_hosts_save};

// `tauri::generate_handler!` resolves its command shims by the same module path
// the commands were originally exported at, so re-export them here.
pub(crate) use import::{
    __cmd__ssh_hosts_import_config, __tauri_command_name_ssh_hosts_import_config,
};
pub(crate) use profile::{
    __cmd__ssh_hosts_load, __cmd__ssh_hosts_remove, __cmd__ssh_hosts_save,
    __tauri_command_name_ssh_hosts_load, __tauri_command_name_ssh_hosts_remove,
    __tauri_command_name_ssh_hosts_save,
};

#[cfg(test)]
fn temp_path(name: &str) -> std::path::PathBuf {
    let unique = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("system clock before Unix epoch")
        .as_nanos();
    std::fs::canonicalize(std::env::temp_dir())
        .unwrap_or_else(|_| std::env::temp_dir())
        .join(format!("tunara-hosts-test-{name}-{unique}"))
        .join("hosts.toml")
}
