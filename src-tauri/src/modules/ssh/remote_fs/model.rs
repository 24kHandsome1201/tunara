use serde::{Deserialize, Serialize};

use crate::modules::ssh::diagnostics::SessionBindingV1;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RemotePathKindV1 {
    File,
    Directory,
    Symlink,
    Other,
}

/// The strongest pathname identity SFTP v3 can provide without following a
/// symlink. Missing server attributes stay absent rather than becoming zero.
/// This is a change detector, not a stable inode identity.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PathIdentityV1 {
    pub kind: RemotePathKindV1,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub size: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mode: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub modified_at: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "state", rename_all = "camelCase")]
pub enum PathExpectationV1 {
    Absent,
    Present { identity: PathIdentityV1 },
}

/// Captured when the dialog is opened. The backend lstats all listed paths
/// again immediately before mutation. Parent checks detect many pathname-swap
/// races but SFTP v3 has no directory-relative mutation primitive, so an
/// indistinguishable swap can still occur after the final check.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MutationPreconditionV1 {
    pub source: PathExpectationV1,
    pub source_parent: PathIdentityV1,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub destination: Option<PathExpectationV1>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub destination_parent: Option<PathIdentityV1>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum MutationOperationV1 {
    Mkdir {
        path: String,
    },
    Rename {
        source_path: String,
        destination_path: String,
        /// Overwrite is forbidden unless the user explicitly selected it and
        /// the server explicitly advertised posix-rename support.
        replace: bool,
    },
    Delete {
        path: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MutationRequestV1 {
    pub operation_id: String,
    pub binding: SessionBindingV1,
    pub operation: MutationOperationV1,
    pub precondition: MutationPreconditionV1,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum MutationStatusV1 {
    Applied,
    DesiredStateObserved,
    Conflict,
    NotFound,
    Unsupported,
    OutcomeUnknown,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MutationResultV1 {
    pub operation_id: String,
    pub status: MutationStatusV1,
    pub message: String,
    /// Pathname operations over SFTP are not represented as atomic. This is
    /// true only for an explicitly advertised posix-rename replace operation.
    pub atomic: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CapabilityStateV1 {
    Supported,
    Unsupported,
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteFsCapabilitiesV1 {
    /// SFTP v3 defines SETSTAT, but support cannot be established without a
    /// mutation. Stat therefore reports unknown until a chmod is attempted.
    pub chmod: CapabilityStateV1,
    pub handle_setstat: CapabilityStateV1,
    /// russh-sftp 2.3 does not retain this server extension advertisement.
    pub posix_rename: CapabilityStateV1,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteMetadataV1 {
    pub path: String,
    pub kind: RemotePathKindV1,
    pub precondition: PathIdentityV1,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent_precondition: Option<PathIdentityV1>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub size: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mode: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub uid: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub gid: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub user: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub group: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub accessed_at: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub modified_at: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub link_target: Option<String>,
    pub capability: RemoteFsCapabilitiesV1,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChmodRequestV1 {
    pub operation_id: String,
    pub binding: SessionBindingV1,
    pub path: String,
    /// Requested ordinary permission bits only. Special bits are observed and
    /// preserved where the server permits, never accepted from the caller.
    pub mode: u32,
    pub expected: PathIdentityV1,
    pub expected_parent: PathIdentityV1,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ChmodMechanismV1 {
    HandleFsetstat,
    PathSetstat,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChmodResultV1 {
    pub operation_id: String,
    pub status: MutationStatusV1,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub observed_mode: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mechanism: Option<ChmodMechanismV1>,
    /// Explicit reminder that pathname checks and pathname SETSTAT cannot be
    /// made one operation by SFTP v3.
    pub toctou_boundary: String,
}

impl MutationResultV1 {
    pub fn new(operation_id: &str, status: MutationStatusV1, message: impl Into<String>) -> Self {
        Self {
            operation_id: operation_id.to_string(),
            status,
            message: message.into(),
            atomic: false,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ObservedPathV1 {
    Absent,
    Present(PathIdentityV1),
    PermissionDenied,
    Unknown,
}

fn expectation_matches(expected: &PathExpectationV1, observed: &ObservedPathV1) -> bool {
    match (expected, observed) {
        (PathExpectationV1::Absent, ObservedPathV1::Absent) => true,
        (PathExpectationV1::Present { identity: expected }, ObservedPathV1::Present(observed)) => {
            expected == observed
        }
        _ => false,
    }
}

fn invalid_request(request: &MutationRequestV1) -> Option<MutationResultV1> {
    if matches!(
        (&request.operation, &request.precondition.source),
        (
            MutationOperationV1::Delete { .. },
            PathExpectationV1::Present {
                identity: PathIdentityV1 {
                    kind: RemotePathKindV1::Other,
                    ..
                }
            }
        )
    ) {
        return Some(MutationResultV1::new(
            &request.operation_id,
            MutationStatusV1::Unsupported,
            "only files, symlinks, and empty directories can be deleted",
        ));
    }
    let parent_is_directory =
        request.precondition.source_parent.kind == RemotePathKindV1::Directory;
    let invalid_message = match (&request.operation, &request.precondition.source) {
        (MutationOperationV1::Mkdir { .. }, PathExpectationV1::Absent)
            if parent_is_directory =>
        {
            None
        }
        (MutationOperationV1::Mkdir { .. }, _) => {
            Some("mkdir requires an absent path and a directory parent")
        }
        (
            MutationOperationV1::Rename { replace, .. },
            PathExpectationV1::Present { .. },
        ) if parent_is_directory
            && request.precondition.destination_parent.as_ref().is_some_and(|parent| {
                parent.kind == RemotePathKindV1::Directory
            })
            && ((!*replace
                && matches!(
                    request.precondition.destination,
                    Some(PathExpectationV1::Absent)
                ))
                || (*replace
                    && matches!(
                        request.precondition.destination,
                        Some(PathExpectationV1::Present { .. })
                    ))) =>
        {
            None
        }
        (MutationOperationV1::Rename { replace: false, .. }, _) => {
            Some("non-replacing rename requires a present source, absent destination, and both directory parents")
        }
        (MutationOperationV1::Rename { replace: true, .. }, _) => {
            Some("replacing rename requires present source and destination snapshots and both directory parents")
        }
        (
            MutationOperationV1::Delete { .. },
            PathExpectationV1::Present { identity },
        ) if parent_is_directory && identity.kind != RemotePathKindV1::Other => None,
        (MutationOperationV1::Delete { .. }, _) => {
            Some("delete requires a present file, symlink, or directory and its directory parent")
        }
    };
    invalid_message.map(|message| {
        MutationResultV1::new(&request.operation_id, MutationStatusV1::Conflict, message)
    })
}

/// Validate the click-time snapshot against fresh, non-following lstat results.
/// Callers must perform this after binding validation and immediately before
/// issuing the mutation request.
pub fn evaluate_precondition(
    request: &MutationRequestV1,
    source: &ObservedPathV1,
    source_parent: &ObservedPathV1,
    destination: Option<&ObservedPathV1>,
    destination_parent: Option<&ObservedPathV1>,
) -> Option<MutationResultV1> {
    if let Some(result) = invalid_request(request) {
        return Some(result);
    }
    let denied = matches!(source, ObservedPathV1::PermissionDenied)
        || matches!(source_parent, ObservedPathV1::PermissionDenied)
        || destination.is_some_and(|value| matches!(value, ObservedPathV1::PermissionDenied))
        || destination_parent
            .is_some_and(|value| matches!(value, ObservedPathV1::PermissionDenied));
    if denied {
        return Some(MutationResultV1::new(
            &request.operation_id,
            MutationStatusV1::Conflict,
            "permission denied while rechecking the mutation precondition",
        ));
    }

    if !expectation_matches(&request.precondition.source, source) {
        let status = if matches!(source, ObservedPathV1::Absent)
            && matches!(
                request.precondition.source,
                PathExpectationV1::Present { .. }
            ) {
            MutationStatusV1::NotFound
        } else {
            MutationStatusV1::Conflict
        };
        return Some(MutationResultV1::new(
            &request.operation_id,
            status,
            "source changed after the operation was prepared",
        ));
    }
    if !matches!(source_parent, ObservedPathV1::Present(identity) if identity == &request.precondition.source_parent)
    {
        return Some(MutationResultV1::new(
            &request.operation_id,
            MutationStatusV1::Conflict,
            "source parent changed after the operation was prepared",
        ));
    }
    if let Some(expected) = request.precondition.destination.as_ref() {
        let Some(observed) = destination else {
            return Some(MutationResultV1::new(
                &request.operation_id,
                MutationStatusV1::OutcomeUnknown,
                "destination could not be rechecked",
            ));
        };
        if !expectation_matches(expected, observed) {
            return Some(MutationResultV1::new(
                &request.operation_id,
                MutationStatusV1::Conflict,
                "destination changed after the operation was prepared",
            ));
        }
    }
    if let Some(expected) = request.precondition.destination_parent.as_ref() {
        if !matches!(destination_parent, Some(ObservedPathV1::Present(identity)) if identity == expected)
        {
            return Some(MutationResultV1::new(
                &request.operation_id,
                MutationStatusV1::Conflict,
                "destination parent changed after the operation was prepared",
            ));
        }
    }
    None
}

/// Reconcile only by observing state after a response was lost. It never asks
/// the caller to issue the mutation again.
pub fn reconcile_after_response_loss(
    request: &MutationRequestV1,
    source: &ObservedPathV1,
    source_parent: &ObservedPathV1,
    destination: Option<&ObservedPathV1>,
    destination_parent: Option<&ObservedPathV1>,
) -> MutationResultV1 {
    if let Some(result) = invalid_request(request) {
        return result;
    }
    let source_parent_unchanged = matches!(
        source_parent,
        ObservedPathV1::Present(identity) if identity == &request.precondition.source_parent
    );
    let destination_parent_unchanged = request
        .precondition
        .destination_parent
        .as_ref()
        .is_none_or(|expected| {
            matches!(destination_parent, Some(ObservedPathV1::Present(identity)) if identity == expected)
        });
    let desired = match &request.operation {
        MutationOperationV1::Mkdir { .. } => {
            source_parent_unchanged
                && matches!(source, ObservedPathV1::Present(identity) if identity.kind == RemotePathKindV1::Directory)
        }
        MutationOperationV1::Delete { .. } => {
            source_parent_unchanged && matches!(source, ObservedPathV1::Absent)
        }
        // SFTP v3 metadata is not stable object identity. Even if the source
        // disappeared and destination metadata matches, a concurrent writer
        // could have produced that state. Never claim a lost rename succeeded.
        MutationOperationV1::Rename { .. } => {
            let _ = (destination, destination_parent_unchanged);
            false
        }
    };
    if desired {
        MutationResultV1::new(
            &request.operation_id,
            MutationStatusV1::DesiredStateObserved,
            "the desired state was observed after the response was lost",
        )
    } else {
        MutationResultV1::new(
            &request.operation_id,
            MutationStatusV1::OutcomeUnknown,
            "the mutation outcome remains unknown; refresh before deciding whether to retry",
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn identity(kind: RemotePathKindV1, size: Option<u64>, modified_at: u32) -> PathIdentityV1 {
        PathIdentityV1 {
            kind,
            size,
            mode: Some(match kind {
                RemotePathKindV1::Directory => 0o040755,
                RemotePathKindV1::Symlink => 0o120777,
                _ => 0o100644,
            }),
            modified_at: Some(modified_at),
        }
    }

    fn request(operation: MutationOperationV1, source: PathExpectationV1) -> MutationRequestV1 {
        MutationRequestV1 {
            operation_id: "op-1".into(),
            binding: SessionBindingV1 {
                logical_session_id: "logical".into(),
                physical_pty_id: 7,
                transport_generation: "backend-generation".into(),
            },
            operation,
            precondition: MutationPreconditionV1 {
                source,
                source_parent: identity(RemotePathKindV1::Directory, None, 10),
                destination: None,
                destination_parent: None,
            },
        }
    }

    #[test]
    fn broken_symlink_is_a_present_link_and_never_followed() {
        let link = identity(RemotePathKindV1::Symlink, Some(17), 20);
        let request = request(
            MutationOperationV1::Delete {
                path: "/srv/broken-link".into(),
            },
            PathExpectationV1::Present {
                identity: link.clone(),
            },
        );
        assert_eq!(
            evaluate_precondition(
                &request,
                &ObservedPathV1::Present(link),
                &ObservedPathV1::Present(request.precondition.source_parent.clone()),
                None,
                None,
            ),
            None
        );
    }

    #[test]
    fn parent_swap_is_a_conflict_before_mutation() {
        let file = identity(RemotePathKindV1::File, Some(5), 20);
        let request = request(
            MutationOperationV1::Delete {
                path: "/srv/file".into(),
            },
            PathExpectationV1::Present {
                identity: file.clone(),
            },
        );
        let swapped_parent = identity(RemotePathKindV1::Directory, None, 11);
        let result = evaluate_precondition(
            &request,
            &ObservedPathV1::Present(file),
            &ObservedPathV1::Present(swapped_parent),
            None,
            None,
        )
        .unwrap();
        assert_eq!(result.status, MutationStatusV1::Conflict);
        assert!(result.message.contains("parent changed"));
    }

    #[test]
    fn response_loss_observes_completed_delete_without_retrying() {
        let file = identity(RemotePathKindV1::File, Some(5), 20);
        let request = request(
            MutationOperationV1::Delete {
                path: "/srv/file".into(),
            },
            PathExpectationV1::Present { identity: file },
        );
        let result = reconcile_after_response_loss(
            &request,
            &ObservedPathV1::Absent,
            &ObservedPathV1::Present(request.precondition.source_parent.clone()),
            None,
            None,
        );
        assert_eq!(result.status, MutationStatusV1::DesiredStateObserved);
    }

    #[test]
    fn concurrent_writer_at_rename_destination_is_not_claimed_as_success() {
        let original = identity(RemotePathKindV1::File, Some(5), 20);
        let mut request = request(
            MutationOperationV1::Rename {
                source_path: "/srv/a".into(),
                destination_path: "/srv/b".into(),
                replace: false,
            },
            PathExpectationV1::Present {
                identity: original.clone(),
            },
        );
        request.precondition.destination = Some(PathExpectationV1::Absent);
        request.precondition.destination_parent =
            Some(identity(RemotePathKindV1::Directory, None, 30));
        let concurrent = identity(RemotePathKindV1::File, Some(6), 21);
        let result = reconcile_after_response_loss(
            &request,
            &ObservedPathV1::Absent,
            &ObservedPathV1::Present(request.precondition.source_parent.clone()),
            Some(&ObservedPathV1::Present(concurrent)),
            Some(&ObservedPathV1::Present(
                request.precondition.destination_parent.clone().unwrap(),
            )),
        );
        assert_eq!(result.status, MutationStatusV1::OutcomeUnknown);
    }

    #[test]
    fn identical_metadata_cannot_prove_a_lost_rename_succeeded() {
        let original = identity(RemotePathKindV1::File, Some(5), 20);
        let mut request = request(
            MutationOperationV1::Rename {
                source_path: "/srv/a".into(),
                destination_path: "/srv/b".into(),
                replace: false,
            },
            PathExpectationV1::Present {
                identity: original.clone(),
            },
        );
        request.precondition.destination = Some(PathExpectationV1::Absent);
        request.precondition.destination_parent =
            Some(identity(RemotePathKindV1::Directory, None, 30));
        let result = reconcile_after_response_loss(
            &request,
            &ObservedPathV1::Absent,
            &ObservedPathV1::Present(request.precondition.source_parent.clone()),
            Some(&ObservedPathV1::Present(original)),
            Some(&ObservedPathV1::Present(
                request.precondition.destination_parent.clone().unwrap(),
            )),
        );
        assert_eq!(result.status, MutationStatusV1::OutcomeUnknown);
    }

    #[test]
    fn post_loss_parent_swap_prevents_desired_state_claim() {
        let request = request(
            MutationOperationV1::Delete {
                path: "/srv/file".into(),
            },
            PathExpectationV1::Present {
                identity: identity(RemotePathKindV1::File, Some(5), 20),
            },
        );
        let result = reconcile_after_response_loss(
            &request,
            &ObservedPathV1::Absent,
            &ObservedPathV1::Present(identity(RemotePathKindV1::Directory, None, 11)),
            None,
            None,
        );
        assert_eq!(result.status, MutationStatusV1::OutcomeUnknown);
    }

    #[test]
    fn wire_contract_uses_camel_case_for_rename_fields() {
        let request = request(
            MutationOperationV1::Rename {
                source_path: "/srv/a".into(),
                destination_path: "/srv/b".into(),
                replace: false,
            },
            PathExpectationV1::Present {
                identity: identity(RemotePathKindV1::File, Some(5), 20),
            },
        );
        let json = serde_json::to_value(request).unwrap();
        assert_eq!(json["operation"]["sourcePath"], "/srv/a");
        assert_eq!(json["operation"]["destinationPath"], "/srv/b");
        assert!(json["operation"].get("source_path").is_none());
    }

    #[test]
    fn permission_denied_during_final_lstat_fails_closed() {
        let request = request(
            MutationOperationV1::Delete {
                path: "/root/secret".into(),
            },
            PathExpectationV1::Present {
                identity: identity(RemotePathKindV1::File, Some(5), 20),
            },
        );
        let result = evaluate_precondition(
            &request,
            &ObservedPathV1::PermissionDenied,
            &ObservedPathV1::Present(request.precondition.source_parent.clone()),
            None,
            None,
        )
        .unwrap();
        assert_eq!(result.status, MutationStatusV1::Conflict);
        assert!(result.message.contains("permission denied"));
    }
}
