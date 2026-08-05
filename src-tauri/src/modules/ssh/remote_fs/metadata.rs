use russh_sftp::client::error::Error as SftpError;
use russh_sftp::protocol::FileAttributes;

use crate::modules::pty::PtyState;
use crate::modules::ssh::diagnostics::SessionBindingV1;
use crate::modules::ssh::sftp_common;

use super::commands::{
    identity, parent_path, status_code, validate_operation_id, validate_remote_path,
    CONTROL_TIMEOUT,
};
use super::{
    CapabilityStateV1, ChmodMechanismV1, ChmodRequestV1, ChmodResultV1, MutationStatusV1,
    RemoteFsCapabilitiesV1, RemoteMetadataV1, RemotePathKindV1,
};

const PATH_TOCTOU: &str = "SFTP v3 cannot bind lstat and pathname SETSTAT into one operation. A swapped final or intermediate symlink may be followed before a post-check detects the change.";
const HANDLE_TOCTOU: &str = "SFTP v3 OPEN has no no-follow flag. A swapped final or intermediate symlink may be followed before FSTAT; FSETSTAT then targets the opened object, and SFTP metadata is not stable inode identity.";

fn metadata(
    path: String,
    attributes: FileAttributes,
    parent_precondition: Option<super::PathIdentityV1>,
    link_target: Option<String>,
) -> RemoteMetadataV1 {
    let path_identity = identity(attributes.clone());
    RemoteMetadataV1 {
        path,
        kind: path_identity.kind,
        precondition: path_identity.clone(),
        parent_precondition,
        size: attributes.size,
        mode: attributes.permissions,
        uid: attributes.uid,
        gid: attributes.gid,
        user: attributes.user,
        group: attributes.group,
        accessed_at: attributes.atime,
        modified_at: attributes.mtime,
        link_target,
        capability: RemoteFsCapabilitiesV1 {
            chmod: CapabilityStateV1::Unsupported,
            handle_setstat: if path_identity.kind == RemotePathKindV1::File {
                CapabilityStateV1::Unknown
            } else {
                CapabilityStateV1::Unsupported
            },
            posix_rename: CapabilityStateV1::Unknown,
        },
    }
}

fn chmod_result(
    request: &ChmodRequestV1,
    status: MutationStatusV1,
    message: impl Into<String>,
    observed_mode: Option<u32>,
    mechanism: Option<ChmodMechanismV1>,
) -> ChmodResultV1 {
    ChmodResultV1 {
        operation_id: request.operation_id.clone(),
        status,
        message: message.into(),
        observed_mode,
        toctou_boundary: match mechanism {
            Some(ChmodMechanismV1::HandleFsetstat) => HANDLE_TOCTOU,
            _ => PATH_TOCTOU,
        }
        .into(),
        mechanism,
    }
}

async fn lstat(
    sftp: &russh_sftp::client::SftpSession,
    path: &str,
) -> Result<FileAttributes, SftpError> {
    tokio::time::timeout(CONTROL_TIMEOUT, sftp.symlink_metadata(path))
        .await
        .map_err(|_| SftpError::Timeout)?
}

#[tauri::command]
pub async fn ssh_fs_stat_v1(
    state: tauri::State<'_, PtyState>,
    binding: SessionBindingV1,
    path: String,
) -> Result<RemoteMetadataV1, String> {
    (async {
        validate_remote_path(&path)?;
        let sftp = sftp_common::session_for_binding(&state, &binding).await?;
        let attributes = lstat(&sftp, &path).await.map_err(|error| {
            if status_code(&error) == Some(russh_sftp::protocol::StatusCode::NoSuchFile) {
                "remote path not found".to_string()
            } else {
                format!("remote lstat failed: {error}")
            }
        })?;
        let parent_precondition = match parent_path(&path) {
            Ok(parent) => {
                Some(identity(lstat(&sftp, parent).await.map_err(|error| {
                    format!("remote parent lstat failed: {error}")
                })?))
            }
            Err(_) if path == "/" => None,
            Err(error) => return Err(error),
        };
        let link_target = if attributes.is_symlink() {
            tokio::time::timeout(CONTROL_TIMEOUT, sftp.read_link(&path))
                .await
                .ok()
                .and_then(Result::ok)
        } else {
            None
        };
        Ok(metadata(path, attributes, parent_precondition, link_target))
    })
    .await
    .map_err(|error: String| {
        crate::modules::ssh::safe_ipc_error(crate::modules::ssh::SshIpcErrorKind::RemoteFs, error)
    })
}

#[tauri::command]
pub async fn ssh_fs_chmod_v1(
    _state: tauri::State<'_, PtyState>,
    request: ChmodRequestV1,
) -> Result<ChmodResultV1, String> {
    (async {
        validate_operation_id(&request.operation_id)?;
        validate_remote_path(&request.path)?;
        let _parent = parent_path(&request.path)?;
        if request.mode > 0o777 {
            return Err("mode must be between 0000 and 0777; special bits are read-only".into());
        }
        if request.expected.kind == RemotePathKindV1::Symlink {
            return Ok(chmod_result(
                &request,
                MutationStatusV1::Unsupported,
                "chmod refuses a path observed as a symlink",
                request.expected.mode,
                None,
            ));
        }
        if request.expected.kind == RemotePathKindV1::Other {
            return Ok(chmod_result(
                &request,
                MutationStatusV1::Unsupported,
                "chmod supports regular files and directories only",
                request.expected.mode,
                None,
            ));
        }
        // SFTP v3 has neither O_NOFOLLOW nor a stable inode identity, so this
        // capability is reported Unsupported and no mutation is attempted.
        Ok(chmod_result(
            &request,
            MutationStatusV1::Unsupported,
            "the negotiated SFTP protocol cannot perform a no-follow identity-bound chmod",
            request.expected.mode,
            None,
        ))
    })
    .await
    .map_err(|error: String| {
        crate::modules::ssh::safe_ipc_error(crate::modules::ssh::SshIpcErrorKind::RemoteFs, error)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn metadata_keeps_unknown_values_absent_and_special_bits_visible() {
        let mut attributes = FileAttributes::empty();
        attributes.permissions = Some(0o104755);
        attributes.user = Some("deploy".into());
        let result = metadata("/srv/tool".into(), attributes, None, None);
        assert_eq!(result.mode, Some(0o104755));
        assert_eq!(result.user.as_deref(), Some("deploy"));
        assert_eq!(result.uid, None);
        assert_eq!(result.size, None);
    }

    #[test]
    fn metadata_reports_chmod_as_unsupported() {
        let result = metadata("/srv/tool".into(), FileAttributes::empty(), None, None);
        assert_eq!(result.capability.chmod, CapabilityStateV1::Unsupported);
    }
}
