use std::future::Future;
use std::time::Duration;

use russh_sftp::client::error::Error as SftpError;
use russh_sftp::protocol::{FileAttributes, StatusCode};

use crate::modules::pty::PtyState;
use crate::modules::ssh::sftp_common;

use super::{
    evaluate_precondition, reconcile_after_response_loss, MutationOperationV1, MutationRequestV1,
    MutationResultV1, MutationStatusV1, ObservedPathV1, PathExpectationV1, PathIdentityV1,
    RemotePathKindV1,
};

pub(super) const CONTROL_TIMEOUT: Duration = Duration::from_secs(15);

pub(super) fn validate_operation_id(operation_id: &str) -> Result<(), String> {
    if operation_id.is_empty() || operation_id.len() > 128 {
        return Err("operationId must contain 1-128 characters".into());
    }
    Ok(())
}

pub(super) fn validate_remote_path(path: &str) -> Result<(), String> {
    if path.len() > 16 * 1024 || !path.starts_with('/') || path.contains('\0') {
        return Err("remote path must be a bounded absolute POSIX path".into());
    }
    if path != "/"
        && path
            .split('/')
            .skip(1)
            .any(|component| component.is_empty() || component == "." || component == "..")
    {
        return Err("remote path must not contain empty, dot, or parent components".into());
    }
    Ok(())
}

pub(super) fn parent_path(path: &str) -> Result<&str, String> {
    validate_remote_path(path)?;
    if path == "/" {
        return Err("the remote root cannot be mutated".into());
    }
    let split = path
        .rfind('/')
        .ok_or_else(|| "remote path has no parent".to_string())?;
    Ok(if split == 0 { "/" } else { &path[..split] })
}

fn operation_paths(request: &MutationRequestV1) -> Result<(&str, Option<&str>), String> {
    validate_operation_id(&request.operation_id)?;
    match &request.operation {
        MutationOperationV1::Mkdir { path } | MutationOperationV1::Delete { path } => {
            parent_path(path)?;
            Ok((path, None))
        }
        MutationOperationV1::Rename {
            source_path,
            destination_path,
            ..
        } => {
            parent_path(source_path)?;
            parent_path(destination_path)?;
            if source_path == destination_path {
                return Err("rename source and destination must differ".into());
            }
            Ok((source_path, Some(destination_path)))
        }
    }
}

pub(super) fn identity(attributes: FileAttributes) -> PathIdentityV1 {
    let kind = if attributes.is_symlink() {
        RemotePathKindV1::Symlink
    } else if attributes.is_dir() {
        RemotePathKindV1::Directory
    } else if attributes.is_regular() {
        RemotePathKindV1::File
    } else {
        RemotePathKindV1::Other
    };
    PathIdentityV1 {
        kind,
        size: attributes.size,
        mode: attributes.permissions,
        modified_at: attributes.mtime,
    }
}

pub(super) fn status_code(error: &SftpError) -> Option<StatusCode> {
    match error {
        SftpError::Status(status) => Some(status.status_code),
        _ => None,
    }
}

async fn observe(sftp: &russh_sftp::client::SftpSession, path: &str) -> ObservedPathV1 {
    match tokio::time::timeout(CONTROL_TIMEOUT, sftp.symlink_metadata(path)).await {
        Ok(Ok(attributes)) => ObservedPathV1::Present(identity(attributes)),
        Ok(Err(error)) if status_code(&error) == Some(StatusCode::NoSuchFile) => {
            ObservedPathV1::Absent
        }
        Ok(Err(error)) if status_code(&error) == Some(StatusCode::PermissionDenied) => {
            ObservedPathV1::PermissionDenied
        }
        Ok(Err(_)) | Err(_) => ObservedPathV1::Unknown,
    }
}

struct Observations {
    source: ObservedPathV1,
    source_parent: ObservedPathV1,
    destination: Option<ObservedPathV1>,
    destination_parent: Option<ObservedPathV1>,
}

async fn observations(
    sftp: &russh_sftp::client::SftpSession,
    request: &MutationRequestV1,
) -> Result<Observations, String> {
    let (source_path, destination_path) = operation_paths(request)?;
    let source_parent_path = parent_path(source_path)?;
    let destination_parent_path = destination_path.map(parent_path).transpose()?;
    let source = observe(sftp, source_path).await;
    let source_parent = observe(sftp, source_parent_path).await;
    let destination = match destination_path {
        Some(path) => Some(observe(sftp, path).await),
        None => None,
    };
    let destination_parent = match destination_parent_path {
        Some(path) => Some(observe(sftp, path).await),
        None => None,
    };
    Ok(Observations {
        source,
        source_parent,
        destination,
        destination_parent,
    })
}

fn reconcile(request: &MutationRequestV1, observed: &Observations) -> MutationResultV1 {
    reconcile_after_response_loss(
        request,
        &observed.source,
        &observed.source_parent,
        observed.destination.as_ref(),
        observed.destination_parent.as_ref(),
    )
}

async fn bounded_mutation(
    operation: impl Future<Output = Result<(), SftpError>>,
) -> Result<(), SftpError> {
    match tokio::time::timeout(CONTROL_TIMEOUT, operation).await {
        Ok(result) => result,
        // A timeout says nothing about whether the server applied the request.
        Err(_) => Err(SftpError::Timeout),
    }
}

fn explicit_error(request: &MutationRequestV1, error: &SftpError) -> Option<MutationResultV1> {
    let (status, message) = match status_code(error) {
        Some(StatusCode::NoSuchFile) => (
            MutationStatusV1::NotFound,
            "a required remote path no longer exists",
        ),
        Some(StatusCode::PermissionDenied) => (
            MutationStatusV1::Conflict,
            "the remote server denied this mutation",
        ),
        Some(StatusCode::OpUnsupported) => (
            MutationStatusV1::Unsupported,
            "the remote server does not support this mutation",
        ),
        Some(StatusCode::Failure) => (
            MutationStatusV1::Conflict,
            "the remote server rejected the mutation; the directory may be non-empty or the destination may exist",
        ),
        Some(_) => return None,
        None => return None,
    };
    Some(MutationResultV1::new(
        &request.operation_id,
        status,
        message,
    ))
}

async fn mutate(
    sftp: &russh_sftp::client::SftpSession,
    request: &MutationRequestV1,
) -> Result<(), SftpError> {
    match &request.operation {
        MutationOperationV1::Mkdir { path } => bounded_mutation(sftp.create_dir(path)).await,
        MutationOperationV1::Rename {
            source_path,
            destination_path,
            replace: false,
        } => bounded_mutation(sftp.rename(source_path, destination_path)).await,
        MutationOperationV1::Rename { replace: true, .. } => {
            // russh-sftp 2.3 does not retain the server's advertised
            // posix-rename extension. Unknown is not support: fail closed.
            Err(SftpError::Status(russh_sftp::protocol::Status {
                id: 0,
                status_code: StatusCode::OpUnsupported,
                error_message: "posix-rename capability was not advertised".into(),
                language_tag: String::new(),
            }))
        }
        MutationOperationV1::Delete { path } => {
            let expected_kind = match &request.precondition.source {
                PathExpectationV1::Present { identity } => identity.kind,
                PathExpectationV1::Absent => RemotePathKindV1::Other,
            };
            match expected_kind {
                RemotePathKindV1::File | RemotePathKindV1::Symlink => {
                    bounded_mutation(sftp.remove_file(path)).await
                }
                // RMDIR, rather than REMOVE, means the server itself enforces
                // the empty-directory constraint. There is no recursive path.
                RemotePathKindV1::Directory => bounded_mutation(sftp.remove_dir(path)).await,
                RemotePathKindV1::Other => Err(SftpError::Status(russh_sftp::protocol::Status {
                    id: 0,
                    status_code: StatusCode::OpUnsupported,
                    error_message: "unsupported remote path kind".into(),
                    language_tag: String::new(),
                })),
            }
        }
    }
}

#[tauri::command]
pub async fn ssh_fs_mutate_v1(
    state: tauri::State<'_, PtyState>,
    request: MutationRequestV1,
) -> Result<MutationResultV1, String> {
    (async {
        let sftp = sftp_common::session_for_binding(&state, &request.binding).await?;
        let before = observations(&sftp, &request).await?;
        if let Some(result) = evaluate_precondition(
            &request,
            &before.source,
            &before.source_parent,
            before.destination.as_ref(),
            before.destination_parent.as_ref(),
        ) {
            return Ok(result);
        }

        match mutate(&sftp, &request).await {
            Ok(()) => Ok(MutationResultV1::new(
                &request.operation_id,
                MutationStatusV1::Applied,
                "the remote server accepted the mutation",
            )),
            Err(error) => {
                if let Some(result) = explicit_error(&request, &error) {
                    return Ok(result);
                }
                // No blind retry after timeout/connection loss. Re-observe once on
                // this live binding and report only what pathname state proves.
                let after = observations(&sftp, &request).await?;
                Ok(reconcile(&request, &after))
            }
        }
    })
    .await
    .map_err(|error: String| {
        crate::modules::ssh::safe_ipc_error(crate::modules::ssh::SshIpcErrorKind::RemoteFs, error)
    })
}

/// Read-only recovery endpoint used when the frontend loses the command
/// response itself. It deliberately cannot issue a mutation.
#[tauri::command]
pub async fn ssh_fs_reconcile_mutation_v1(
    state: tauri::State<'_, PtyState>,
    request: MutationRequestV1,
) -> Result<MutationResultV1, String> {
    (async {
        let sftp = sftp_common::session_for_binding(&state, &request.binding).await?;
        let observed = observations(&sftp, &request).await?;
        Ok(reconcile(&request, &observed))
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
    fn remote_paths_are_absolute_canonical_and_never_root() {
        assert_eq!(parent_path("/a/b").unwrap(), "/a");
        assert_eq!(parent_path("/a").unwrap(), "/");
        for invalid in ["a", "/", "/a/", "/a//b", "/a/../b", "/a/./b"] {
            assert!(parent_path(invalid).is_err(), "accepted {invalid}");
        }
    }
}
