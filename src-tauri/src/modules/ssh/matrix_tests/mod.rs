//! Real-SSH regression matrix.
//!
//! These tests drive the production russh client (`SshSession`, `auth`,
//! `known_hosts`, SFTP and remote grep commands) against the Docker OpenSSH
//! fixture in `tests/ssh-matrix/`. They compile only with
//! `--features ssh-matrix` and are launched by `tests/ssh-matrix/run.sh`, which
//! points `HOME` at a throwaway directory so `known_hosts.rs`, the download
//! sandbox and the agent lookup never touch a real `~/.ssh`. Plain
//! `cargo test --lib` never builds this module. See docs/TESTING.md.

mod auth_matrix;
mod harness;
mod host_key;
mod proxy_jump;
mod reconnect;
mod remote_fs;
mod shells;
