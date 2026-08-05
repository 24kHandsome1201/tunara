//! Compatibility owner for the original transfer IPC surface.
//!
//! Implementations remain colocated with their mature SFTP helpers; these
//! adapters own the legacy command names and preserve every wire shape.

use tauri::ipc::Channel;

use crate::modules::pty::PtyState;
use crate::modules::ssh::sftp::{self, UploadProgress};

#[tauri::command]
pub async fn ssh_fs_download(
    state: tauri::State<'_, PtyState>,
    id: u32,
    remote_path: String,
    local_path: String,
) -> Result<u64, String> {
    (async { sftp::legacy_download_file(state, id, remote_path, local_path).await })
        .await
        .map_err(|error| {
            crate::modules::ssh::safe_ipc_error(
                crate::modules::ssh::SshIpcErrorKind::Transfer,
                error,
            )
        })
}

#[tauri::command]
pub async fn ssh_fs_upload(
    state: tauri::State<'_, PtyState>,
    id: u32,
    transfer_id: String,
    local_path: String,
    remote_path: String,
    overwrite: bool,
    on_progress: Channel<UploadProgress>,
) -> Result<u64, String> {
    (async {
        sftp::legacy_upload_file(
            state,
            id,
            transfer_id,
            local_path,
            remote_path,
            overwrite,
            on_progress,
        )
        .await
    })
    .await
    .map_err(|error: String| {
        crate::modules::ssh::safe_ipc_error(crate::modules::ssh::SshIpcErrorKind::Transfer, error)
    })
}

#[tauri::command]
pub fn ssh_fs_cancel_upload(transfer_id: String) -> bool {
    sftp::cancel_upload(transfer_id)
}
