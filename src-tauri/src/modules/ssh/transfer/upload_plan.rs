//! Backend-owned batch upload planning and directory materialization.
//!
//! A plan is an opaque, short-lived capability bound to one complete SSH
//! binding and one operation id. The frontend may choose actions for item ids,
//! but cannot submit source or destination paths. Directory mutations are
//! never retried after an uncertain outcome; the reconcile command only
//! observes requests already issued by materialization.

use super::manifest::{
    local_upload_manifest, ManifestEntryKind, ManifestLimits, MAX_ENTRIES, MAX_PATH_BYTES,
};
use crate::modules::pty::{PtyState, Session};
use crate::modules::ssh::connection::SshSession;
use crate::modules::ssh::diagnostics::SessionBindingV1;
use crate::modules::ssh::remote_fs::commands::{
    execute_mutation, identity, lstat_identity_bounded, reconcile_mutation, validate_operation_id,
    validate_remote_path, CONTROL_TIMEOUT,
};
use crate::modules::ssh::remote_fs::{
    MutationOperationV1, MutationPreconditionV1, MutationRequestV1, MutationStatusV1,
    PathExpectationV1, PathIdentityV1, RemotePathKindV1,
};
use crate::modules::ssh::sftp_common;
use russh_sftp::client::error::Error as SftpError;
use russh_sftp::protocol::{FileAttributes, StatusCode};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const PLAN_TTL: Duration = Duration::from_secs(5 * 60);
const MAX_GLOBAL_PLANS: usize = 32;
const MAX_BINDING_PLANS: usize = 8;
const MAX_REGISTRY_ENTRIES: usize = 40_000;
const MAX_REGISTRY_SOURCE_BYTES: u64 = 40 * 1024 * 1024 * 1024;
const MAX_REGISTRY_PAYLOAD_BYTES: usize = 64 * 1024 * 1024;
const MAX_REMOTE_DIRECTORY_NAME_BYTES: usize = 4 * 1024 * 1024;
const DIRECTORY_TIMEOUT: Duration = Duration::from_secs(30);
const MKDIR_CONCURRENCY: usize = 8;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UploadPreflightRequestV1 {
    pub operation_id: String,
    pub binding: SessionBindingV1,
    pub local_sources: Vec<String>,
    pub destination_root: String,
    pub limits: Option<ManifestLimits>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UploadPlanV1 {
    pub plan_id: String,
    /// Unix epoch milliseconds, suitable for direct comparison with Date.now().
    pub expires_at: u64,
    pub binding: SessionBindingV1,
    pub items: Vec<UploadPlanItemV1>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UploadPlanItemV1 {
    pub item_id: String,
    pub source_path: String,
    pub relative_path: String,
    pub kind: UploadItemKindV1,
    pub bytes: u64,
    pub proposed_destination: String,
    pub destination: UploadDestinationStateV1,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub suggested_rename: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum UploadItemKindV1 {
    File,
    Dir,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum UploadDestinationStateV1 {
    Absent,
    FileConflict,
    MergeDirectory,
    BlockingNonDirectory,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UploadMaterializeRequestV1 {
    pub plan_id: String,
    pub operation_id: String,
    pub decisions: Vec<UploadDecisionV1>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UploadDecisionV1 {
    pub item_id: String,
    pub action: UploadActionV1,
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum UploadActionV1 {
    Replace,
    Rename,
    Skip,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UploadReconcileRequestV1 {
    pub plan_id: String,
    pub operation_id: String,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum UploadMaterializationStatusV1 {
    Ready,
    Conflict,
    OutcomeUnknown,
    Expired,
    Stale,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum UploadMaterializationItemStatusV1 {
    Ready,
    Skipped,
    Applied,
    DesiredStateObserved,
    Conflict,
    OutcomeUnknown,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct UploadTransferDescriptorV1 {
    pub item_id: String,
    pub source_path: String,
    pub destination_path: String,
    pub overwrite: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct UploadMaterializationItemV1 {
    pub item_id: String,
    pub status: UploadMaterializationItemStatusV1,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub destination_path: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct UploadMaterializationResultV1 {
    pub plan_id: String,
    pub operation_id: String,
    pub status: UploadMaterializationStatusV1,
    pub items: Vec<UploadMaterializationItemV1>,
    pub partial_directories: Vec<String>,
    /// Populated if and only if status is `ready`.
    pub descriptors: Vec<UploadTransferDescriptorV1>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum WorkAction {
    CreateOnly,
    MergeOnly,
    Replace,
    Rename,
    Skip,
}

#[derive(Clone)]
struct MaterializationWorkItem {
    item_id: String,
    relative_path: String,
    source_path: String,
    kind: UploadItemKindV1,
    action: WorkAction,
    destination_path: Option<String>,
    status: UploadMaterializationItemStatusV1,
    overwrite: bool,
    mutation: Option<MutationRequestV1>,
}

#[derive(Clone)]
struct MaterializationWork {
    plan_id: String,
    operation_id: String,
    binding: SessionBindingV1,
    items: Vec<MaterializationWorkItem>,
}

#[derive(Clone)]
enum OperationState {
    Idle,
    Running,
    NeedsReconcile(MaterializationWork),
    Completed(UploadMaterializationResultV1),
}

#[derive(Clone)]
struct StoredPlan {
    owner_operation_id: String,
    destination_root: String,
    plan: UploadPlanV1,
    source_bytes: u64,
    payload_bytes: usize,
    operation: OperationState,
}

#[derive(Default)]
struct PlanRegistry {
    plans: HashMap<String, StoredPlan>,
}

impl PlanRegistry {
    fn prune(&mut self, now: u64) {
        self.plans.retain(|_, plan| plan.plan.expires_at > now);
    }

    fn insert(&mut self, plan: StoredPlan, now: u64) -> Result<(), String> {
        self.prune(now);
        let binding_count = self
            .plans
            .values()
            .filter(|stored| stored.plan.binding == plan.plan.binding)
            .count();
        let entries = self
            .plans
            .values()
            .map(|stored| stored.plan.items.len())
            .sum::<usize>();
        let source_bytes = self
            .plans
            .values()
            .map(|stored| stored.source_bytes)
            .sum::<u64>();
        let payload_bytes = self
            .plans
            .values()
            .map(|stored| stored.payload_bytes)
            .sum::<usize>();
        if self.plans.len() >= MAX_GLOBAL_PLANS
            || binding_count >= MAX_BINDING_PLANS
            || entries.saturating_add(plan.plan.items.len()) > MAX_REGISTRY_ENTRIES
            || source_bytes.saturating_add(plan.source_bytes) > MAX_REGISTRY_SOURCE_BYTES
            || payload_bytes.saturating_add(plan.payload_bytes) > MAX_REGISTRY_PAYLOAD_BYTES
        {
            return Err("upload plan capacity exceeded".into());
        }
        self.plans.insert(plan.plan.plan_id.clone(), plan);
        Ok(())
    }
}

fn registry() -> &'static Mutex<PlanRegistry> {
    static REGISTRY: OnceLock<Mutex<PlanRegistry>> = OnceLock::new();
    REGISTRY.get_or_init(|| Mutex::new(PlanRegistry::default()))
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX)
}

fn opaque_token() -> Result<String, String> {
    let mut bytes = [0_u8; 24];
    getrandom::fill(&mut bytes).map_err(|_| "upload plan token generation failed")?;
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

fn safe(error: String) -> String {
    crate::modules::ssh::safe_ipc_error(crate::modules::ssh::SshIpcErrorKind::Manifest, error)
}

fn join_remote(root: &str, relative: &str) -> String {
    if root == "/" {
        format!("/{relative}")
    } else {
        format!("{root}/{relative}")
    }
}

fn relative_parent(path: &str) -> &str {
    path.rsplit_once('/').map_or("", |(parent, _)| parent)
}

fn relative_leaf(path: &str) -> &str {
    path.rsplit_once('/').map_or(path, |(_, leaf)| leaf)
}

fn remote_parent(path: &str) -> Result<&str, String> {
    validate_remote_path(path)?;
    if path == "/" {
        return Err("remote root has no parent".into());
    }
    let index = path.rfind('/').ok_or("remote path has no parent")?;
    Ok(if index == 0 { "/" } else { &path[..index] })
}

fn hinted_kind(attributes: &FileAttributes) -> Option<RemotePathKindV1> {
    super::remote_kind_from_unix_mode(attributes.permissions?)
}

fn classify_present(kind: UploadItemKindV1, present: RemotePathKindV1) -> UploadDestinationStateV1 {
    match (kind, present) {
        (UploadItemKindV1::Dir, RemotePathKindV1::Directory) => {
            UploadDestinationStateV1::MergeDirectory
        }
        (UploadItemKindV1::File, RemotePathKindV1::File) => UploadDestinationStateV1::FileConflict,
        _ => UploadDestinationStateV1::BlockingNonDirectory,
    }
}

#[derive(Clone, Copy)]
enum ParentAvailability {
    Existing,
    Missing,
    Blocked,
}

async fn classify_destinations(
    ssh: &SshSession,
    sftp: &russh_sftp::client::SftpSession,
    destination_root: &str,
    entries: &[(UploadItemKindV1, String)],
) -> Result<Vec<UploadDestinationStateV1>, String> {
    let root_before = lstat_identity_bounded(sftp, destination_root, CONTROL_TIMEOUT).await?;
    if root_before.kind != RemotePathKindV1::Directory {
        return Err("upload destination root must be a non-symlink directory".into());
    }
    let mut states = vec![UploadDestinationStateV1::Absent; entries.len()];
    let mut parent_availability = HashMap::from([(String::new(), ParentAvailability::Existing)]);
    let max_depth = entries
        .iter()
        .map(|(_, relative)| relative.split('/').count())
        .max()
        .unwrap_or(0);

    for depth in 1..=max_depth {
        let mut groups = BTreeMap::<String, Vec<usize>>::new();
        for (index, (_, relative)) in entries.iter().enumerate() {
            if relative.split('/').count() == depth {
                groups
                    .entry(relative_parent(relative).to_string())
                    .or_default()
                    .push(index);
            }
        }
        for (parent_relative, indexes) in groups {
            let availability = parent_availability
                .get(&parent_relative)
                .copied()
                .unwrap_or(ParentAvailability::Blocked);
            if !matches!(availability, ParentAvailability::Existing) {
                for index in indexes {
                    states[index] = if matches!(availability, ParentAvailability::Missing) {
                        UploadDestinationStateV1::Absent
                    } else {
                        UploadDestinationStateV1::BlockingNonDirectory
                    };
                    if entries[index].0 == UploadItemKindV1::Dir {
                        parent_availability.insert(
                            entries[index].1.clone(),
                            if states[index] == UploadDestinationStateV1::Absent {
                                ParentAvailability::Missing
                            } else {
                                ParentAvailability::Blocked
                            },
                        );
                    }
                }
                continue;
            }

            let parent_path = if parent_relative.is_empty() {
                destination_root.to_string()
            } else {
                join_remote(destination_root, &parent_relative)
            };
            let listing = ssh
                .read_dir_bounded(
                    &parent_path,
                    MAX_ENTRIES as usize,
                    MAX_REMOTE_DIRECTORY_NAME_BYTES,
                    DIRECTORY_TIMEOUT,
                )
                .await?;
            let mut names = HashMap::new();
            for entry in listing {
                if entry.filename == "." || entry.filename == ".." {
                    continue;
                }
                if entry.filename.is_empty()
                    || entry.filename.contains('/')
                    || entry.filename.contains('\\')
                    || entry.filename.chars().any(char::is_control)
                    || names.insert(entry.filename.clone(), entry.attrs).is_some()
                {
                    return Err("invalid or duplicate remote directory entry".into());
                }
            }
            for index in indexes {
                let (item_kind, relative) = &entries[index];
                let leaf = relative_leaf(relative);
                let Some(attributes) = names.get(leaf) else {
                    states[index] = UploadDestinationStateV1::Absent;
                    if *item_kind == UploadItemKindV1::Dir {
                        parent_availability.insert(relative.clone(), ParentAvailability::Missing);
                    }
                    continue;
                };
                let hint = hinted_kind(attributes);
                let path = join_remote(destination_root, relative);
                let observed_kind = if hint == Some(RemotePathKindV1::Symlink) {
                    RemotePathKindV1::Symlink
                } else if *item_kind == UploadItemKindV1::Dir || hint.is_none() {
                    lstat_identity_bounded(sftp, &path, CONTROL_TIMEOUT)
                        .await?
                        .kind
                } else {
                    hint.unwrap_or(RemotePathKindV1::Other)
                };
                states[index] = classify_present(*item_kind, observed_kind);
                if *item_kind == UploadItemKindV1::Dir {
                    parent_availability.insert(
                        relative.clone(),
                        if states[index] == UploadDestinationStateV1::MergeDirectory {
                            ParentAvailability::Existing
                        } else {
                            ParentAvailability::Blocked
                        },
                    );
                }
            }
        }
    }
    let root_after = lstat_identity_bounded(sftp, destination_root, CONTROL_TIMEOUT).await?;
    if root_before != root_after {
        return Err("upload destination root changed during preflight".into());
    }
    Ok(states)
}

fn suggested_sibling(path: &str, index: usize) -> Result<String, String> {
    let parent = remote_parent(path)?;
    let leaf = path.rsplit('/').next().ok_or("remote path has no leaf")?;
    let dot = leaf.rfind('.').filter(|position| *position > 0);
    let (stem, extension) = dot.map_or((leaf, ""), |position| leaf.split_at(position));
    let suffix = format!(" ({index}){extension}");
    let prefix = if parent == "/" {
        "/".to_string()
    } else {
        format!("{parent}/")
    };
    let mut bounded_stem = stem.to_string();
    while !bounded_stem.is_empty()
        && prefix.len() + bounded_stem.len() + suffix.len() > MAX_PATH_BYTES as usize
    {
        bounded_stem.pop();
        while !bounded_stem.is_char_boundary(bounded_stem.len()) {
            bounded_stem.pop();
        }
    }
    let candidate = format!("{prefix}{bounded_stem}{suffix}");
    validate_remote_path(&candidate)?;
    if candidate.len() > MAX_PATH_BYTES as usize {
        return Err("could not generate a bounded upload sibling".into());
    }
    Ok(candidate)
}

enum PathObservation {
    Absent,
    Present(PathIdentityV1),
}

async fn observe_path(
    sftp: &russh_sftp::client::SftpSession,
    path: &str,
) -> Result<PathObservation, String> {
    validate_remote_path(path)?;
    let _in_flight = crate::modules::perf_counters::sftp_lstat_begin();
    match tokio::time::timeout(CONTROL_TIMEOUT, sftp.symlink_metadata(path)).await {
        Ok(Ok(attributes)) => Ok(PathObservation::Present(identity(attributes))),
        Ok(Err(SftpError::Status(status))) if status.status_code == StatusCode::NoSuchFile => {
            Ok(PathObservation::Absent)
        }
        Ok(Err(error)) => Err(format!("remote path observation failed: {error}")),
        Err(_) => Err("remote path observation timed out".into()),
    }
}

async fn fresh_sibling(
    ssh: &SshSession,
    sftp: &russh_sftp::client::SftpSession,
    path: &str,
    occupied_by_parent: &mut HashMap<String, HashSet<String>>,
) -> Result<String, String> {
    let parent = remote_parent(path)?.to_string();
    if !occupied_by_parent.contains_key(&parent) {
        let listing = ssh
            .read_dir_bounded(
                &parent,
                MAX_ENTRIES as usize,
                MAX_REMOTE_DIRECTORY_NAME_BYTES,
                DIRECTORY_TIMEOUT,
            )
            .await?;
        let mut names = HashSet::new();
        for entry in listing {
            if entry.filename != "." && entry.filename != ".." {
                names.insert(entry.filename);
            }
        }
        occupied_by_parent.insert(parent.clone(), names);
    }
    let names = occupied_by_parent
        .get_mut(&parent)
        .ok_or("rename allocation state missing")?;
    for index in 1..=10_000 {
        let candidate = suggested_sibling(path, index)?;
        let leaf = candidate.rsplit('/').next().unwrap_or_default();
        if names.contains(leaf) {
            continue;
        }
        if matches!(
            observe_path(sftp, &candidate).await?,
            PathObservation::Absent
        ) {
            names.insert(leaf.to_string());
            return Ok(candidate);
        }
        names.insert(leaf.to_string());
    }
    Err("could not allocate a fresh upload sibling".into())
}

fn decisions_by_id(
    plan: &UploadPlanV1,
    decisions: &[UploadDecisionV1],
) -> Result<HashMap<String, UploadActionV1>, ()> {
    let ids = plan
        .items
        .iter()
        .map(|item| item.item_id.as_str())
        .collect::<HashSet<_>>();
    let mut result = HashMap::new();
    for decision in decisions {
        if !ids.contains(decision.item_id.as_str())
            || result
                .insert(decision.item_id.clone(), decision.action)
                .is_some()
        {
            return Err(());
        }
    }
    Ok(result)
}

fn work_action(item: &UploadPlanItemV1, decision: Option<UploadActionV1>) -> Option<WorkAction> {
    decision.map_or_else(
        || match item.destination {
            UploadDestinationStateV1::Absent => Some(WorkAction::CreateOnly),
            UploadDestinationStateV1::MergeDirectory => Some(WorkAction::MergeOnly),
            UploadDestinationStateV1::FileConflict
            | UploadDestinationStateV1::BlockingNonDirectory => None,
        },
        |action| {
            Some(match action {
                UploadActionV1::Replace => WorkAction::Replace,
                UploadActionV1::Rename => WorkAction::Rename,
                UploadActionV1::Skip => WorkAction::Skip,
            })
        },
    )
}

#[derive(Clone, Copy)]
enum WorkParent {
    Existing,
    WillCreate,
    Skipped,
    Blocked,
}

async fn build_work(
    plan: &StoredPlan,
    decisions: &HashMap<String, UploadActionV1>,
    ssh: &SshSession,
    sftp: &russh_sftp::client::SftpSession,
) -> MaterializationWork {
    let mut items = Vec::with_capacity(plan.plan.items.len());
    let mut directory_modes = HashMap::from([(String::new(), WorkParent::Existing)]);
    let mut directory_destinations = HashMap::new();
    let mut occupied_by_parent = HashMap::new();
    let mut planned_paths = HashSet::new();

    for item in &plan.plan.items {
        let parent_relative = relative_parent(&item.relative_path);
        let parent_mode = directory_modes
            .get(parent_relative)
            .copied()
            .unwrap_or(WorkParent::Blocked);
        let parent_destination = if parent_relative.is_empty() {
            Some(plan.destination_root.clone())
        } else {
            directory_destinations.get(parent_relative).cloned()
        };
        let decision = decisions.get(&item.item_id).copied();
        let mut action = if matches!(parent_mode, WorkParent::WillCreate) && decision.is_none() {
            Some(WorkAction::CreateOnly)
        } else {
            work_action(item, decision)
        };
        let mut status = UploadMaterializationItemStatusV1::Ready;
        let mut destination_path = parent_destination
            .as_ref()
            .map(|parent| join_remote(parent, relative_leaf(&item.relative_path)));

        if matches!(parent_mode, WorkParent::Skipped) || action == Some(WorkAction::Skip) {
            action = Some(WorkAction::Skip);
            status = UploadMaterializationItemStatusV1::Skipped;
            destination_path = None;
        } else if matches!(parent_mode, WorkParent::Blocked) || action.is_none() {
            status = UploadMaterializationItemStatusV1::Conflict;
        } else if let (Some(WorkAction::Rename), Some(current)) = (action, &destination_path) {
            destination_path = if matches!(parent_mode, WorkParent::Existing) {
                fresh_sibling(ssh, sftp, current, &mut occupied_by_parent)
                    .await
                    .ok()
            } else {
                (1..=10_000)
                    .filter_map(|index| suggested_sibling(current, index).ok())
                    .find(|candidate| !planned_paths.contains(candidate))
            };
            if destination_path.is_none() {
                status = UploadMaterializationItemStatusV1::Conflict;
            }
        }
        if let Some(destination) = &destination_path {
            if destination.len() > MAX_PATH_BYTES as usize
                || validate_remote_path(destination).is_err()
                || !planned_paths.insert(destination.clone())
            {
                status = UploadMaterializationItemStatusV1::Conflict;
            }
        }

        if item.kind == UploadItemKindV1::Dir {
            let next_parent = match status {
                UploadMaterializationItemStatusV1::Skipped => WorkParent::Skipped,
                UploadMaterializationItemStatusV1::Conflict => WorkParent::Blocked,
                _ if matches!(parent_mode, WorkParent::WillCreate) => WorkParent::WillCreate,
                _ => match (&destination_path, action) {
                    (Some(path), Some(action)) => match observe_path(sftp, path).await {
                        Ok(PathObservation::Absent)
                            if matches!(
                                action,
                                WorkAction::CreateOnly | WorkAction::Replace | WorkAction::Rename
                            ) =>
                        {
                            status = UploadMaterializationItemStatusV1::Ready;
                            WorkParent::WillCreate
                        }
                        Ok(PathObservation::Present(identity))
                            if identity.kind == RemotePathKindV1::Directory
                                && matches!(
                                    action,
                                    WorkAction::MergeOnly | WorkAction::Replace
                                ) =>
                        {
                            status = UploadMaterializationItemStatusV1::DesiredStateObserved;
                            WorkParent::Existing
                        }
                        _ => {
                            status = UploadMaterializationItemStatusV1::Conflict;
                            WorkParent::Blocked
                        }
                    },
                    _ => WorkParent::Blocked,
                },
            };
            directory_modes.insert(item.relative_path.clone(), next_parent);
            if let Some(destination) = &destination_path {
                directory_destinations.insert(item.relative_path.clone(), destination.clone());
            }
        } else if status == UploadMaterializationItemStatusV1::Ready
            && matches!(parent_mode, WorkParent::Existing)
        {
            status = match (&destination_path, action) {
                (Some(path), Some(action)) => match observe_path(sftp, path).await {
                    Ok(PathObservation::Absent)
                        if matches!(
                            action,
                            WorkAction::CreateOnly | WorkAction::Replace | WorkAction::Rename
                        ) =>
                    {
                        UploadMaterializationItemStatusV1::Ready
                    }
                    Ok(PathObservation::Present(identity))
                        if identity.kind == RemotePathKindV1::File
                            && action == WorkAction::Replace =>
                    {
                        UploadMaterializationItemStatusV1::Ready
                    }
                    _ => UploadMaterializationItemStatusV1::Conflict,
                },
                _ => UploadMaterializationItemStatusV1::Conflict,
            };
        }

        items.push(MaterializationWorkItem {
            item_id: item.item_id.clone(),
            relative_path: item.relative_path.clone(),
            source_path: item.source_path.clone(),
            kind: item.kind,
            action: action.unwrap_or(WorkAction::Skip),
            destination_path,
            status,
            overwrite: false,
            mutation: None,
        });
    }
    MaterializationWork {
        plan_id: plan.plan.plan_id.clone(),
        operation_id: plan.owner_operation_id.clone(),
        binding: plan.plan.binding.clone(),
        items,
    }
}

fn has_conflict(work: &MaterializationWork) -> bool {
    work.items
        .iter()
        .any(|item| item.status == UploadMaterializationItemStatusV1::Conflict)
}

fn result_from_work(
    work: &MaterializationWork,
    status: UploadMaterializationStatusV1,
) -> UploadMaterializationResultV1 {
    let descriptors = if status == UploadMaterializationStatusV1::Ready {
        work.items
            .iter()
            .filter(|item| {
                item.kind == UploadItemKindV1::File
                    && item.status == UploadMaterializationItemStatusV1::Ready
            })
            .filter_map(|item| {
                Some(UploadTransferDescriptorV1 {
                    item_id: item.item_id.clone(),
                    source_path: item.source_path.clone(),
                    destination_path: item.destination_path.clone()?,
                    overwrite: item.overwrite,
                })
            })
            .collect()
    } else {
        Vec::new()
    };
    UploadMaterializationResultV1 {
        plan_id: work.plan_id.clone(),
        operation_id: work.operation_id.clone(),
        status,
        items: work
            .items
            .iter()
            .map(|item| UploadMaterializationItemV1 {
                item_id: item.item_id.clone(),
                status: item.status,
                destination_path: item.destination_path.clone(),
            })
            .collect(),
        partial_directories: work
            .items
            .iter()
            .filter(|item| {
                item.kind == UploadItemKindV1::Dir
                    && item.status == UploadMaterializationItemStatusV1::Applied
            })
            .filter_map(|item| item.destination_path.clone())
            .collect(),
        descriptors,
    }
}

fn empty_result(
    plan_id: &str,
    operation_id: &str,
    status: UploadMaterializationStatusV1,
) -> UploadMaterializationResultV1 {
    UploadMaterializationResultV1 {
        plan_id: plan_id.to_string(),
        operation_id: operation_id.to_string(),
        status,
        items: Vec::new(),
        partial_directories: Vec::new(),
        descriptors: Vec::new(),
    }
}

enum PreparedDirectory {
    NoMutation(UploadMaterializationItemStatusV1),
    Mutation(Box<MutationRequestV1>),
    Conflict,
}

async fn prepare_directory(
    work: &MaterializationWork,
    index: usize,
    sftp: &russh_sftp::client::SftpSession,
) -> Result<PreparedDirectory, String> {
    let item = &work.items[index];
    let path = item
        .destination_path
        .as_ref()
        .ok_or("directory path missing")?;
    match observe_path(sftp, path).await? {
        PathObservation::Present(identity)
            if identity.kind == RemotePathKindV1::Directory
                && matches!(item.action, WorkAction::MergeOnly | WorkAction::Replace) =>
        {
            Ok(PreparedDirectory::NoMutation(
                UploadMaterializationItemStatusV1::DesiredStateObserved,
            ))
        }
        PathObservation::Present(_) => Ok(PreparedDirectory::Conflict),
        PathObservation::Absent if item.action == WorkAction::MergeOnly => {
            Ok(PreparedDirectory::Conflict)
        }
        PathObservation::Absent => {
            let parent = remote_parent(path)?;
            let parent_identity = match observe_path(sftp, parent).await? {
                PathObservation::Present(identity)
                    if identity.kind == RemotePathKindV1::Directory =>
                {
                    identity
                }
                _ => return Ok(PreparedDirectory::Conflict),
            };
            Ok(PreparedDirectory::Mutation(Box::new(MutationRequestV1 {
                operation_id: format!("upload-mkdir:{}", item.item_id),
                binding: work.binding.clone(),
                operation: MutationOperationV1::Mkdir { path: path.clone() },
                precondition: MutationPreconditionV1 {
                    source: PathExpectationV1::Absent,
                    source_parent: parent_identity,
                    destination: None,
                    destination_parent: None,
                },
            })))
        }
    }
}

async fn materialize_directories(
    mut work: MaterializationWork,
    sftp: Arc<russh_sftp::client::SftpSession>,
) -> (MaterializationWork, UploadMaterializationStatusV1) {
    let max_depth = work
        .items
        .iter()
        .filter(|item| item.kind == UploadItemKindV1::Dir)
        .map(|item| item.relative_path.split('/').count())
        .max()
        .unwrap_or(0);
    for depth in 1..=max_depth {
        let indexes = work
            .items
            .iter()
            .enumerate()
            .filter(|(_, item)| {
                item.kind == UploadItemKindV1::Dir
                    && item.status == UploadMaterializationItemStatusV1::Ready
                    && item.relative_path.split('/').count() == depth
            })
            .map(|(index, _)| index)
            .collect::<Vec<_>>();
        let mut prepared = Vec::new();
        for index in indexes {
            match prepare_directory(&work, index, &sftp).await {
                Ok(PreparedDirectory::NoMutation(status)) => work.items[index].status = status,
                Ok(PreparedDirectory::Mutation(request)) => prepared.push((index, *request)),
                Ok(PreparedDirectory::Conflict) | Err(_) => {
                    work.items[index].status = UploadMaterializationItemStatusV1::Conflict
                }
            }
        }
        if has_conflict(&work) {
            return (work, UploadMaterializationStatusV1::Conflict);
        }

        for chunk in prepared.chunks(MKDIR_CONCURRENCY) {
            let mut tasks = tokio::task::JoinSet::new();
            for (index, request) in chunk.iter().cloned() {
                let session = sftp.clone();
                tasks.spawn(async move {
                    let result = execute_mutation(&session, &request).await;
                    (index, request, result)
                });
            }
            while let Some(joined) = tasks.join_next().await {
                let Ok((index, request, result)) = joined else {
                    continue;
                };
                match result.map(|result| result.status) {
                    Ok(MutationStatusV1::Applied) => {
                        work.items[index].status = UploadMaterializationItemStatusV1::Applied
                    }
                    Ok(MutationStatusV1::DesiredStateObserved) => {
                        work.items[index].status =
                            UploadMaterializationItemStatusV1::DesiredStateObserved
                    }
                    Ok(MutationStatusV1::OutcomeUnknown) | Err(_) => {
                        work.items[index].status =
                            UploadMaterializationItemStatusV1::OutcomeUnknown;
                        work.items[index].mutation = Some(request);
                    }
                    Ok(_) => work.items[index].status = UploadMaterializationItemStatusV1::Conflict,
                }
            }
        }
        if work
            .items
            .iter()
            .any(|item| item.status == UploadMaterializationItemStatusV1::OutcomeUnknown)
        {
            return (work, UploadMaterializationStatusV1::OutcomeUnknown);
        }
        if has_conflict(&work) {
            return (work, UploadMaterializationStatusV1::Conflict);
        }
    }
    (work, UploadMaterializationStatusV1::Ready)
}

async fn finalize_files(
    work: &mut MaterializationWork,
    sftp: &russh_sftp::client::SftpSession,
) -> UploadMaterializationStatusV1 {
    for item in &mut work.items {
        if item.kind != UploadItemKindV1::File
            || item.status == UploadMaterializationItemStatusV1::Skipped
            || item.status == UploadMaterializationItemStatusV1::Conflict
        {
            continue;
        }
        let Some(path) = item.destination_path.as_ref() else {
            item.status = UploadMaterializationItemStatusV1::Conflict;
            continue;
        };
        let parent_ok = matches!(
            observe_path(sftp, remote_parent(path).unwrap_or("/")).await,
            Ok(PathObservation::Present(identity)) if identity.kind == RemotePathKindV1::Directory
        );
        if !parent_ok {
            item.status = UploadMaterializationItemStatusV1::Conflict;
            continue;
        }
        match observe_path(sftp, path).await {
            Ok(PathObservation::Absent)
                if matches!(
                    item.action,
                    WorkAction::CreateOnly | WorkAction::Replace | WorkAction::Rename
                ) =>
            {
                item.status = UploadMaterializationItemStatusV1::Ready;
                item.overwrite = false;
            }
            Ok(PathObservation::Present(identity))
                if identity.kind == RemotePathKindV1::File
                    && item.action == WorkAction::Replace =>
            {
                item.status = UploadMaterializationItemStatusV1::Ready;
                item.overwrite = true;
            }
            _ => item.status = UploadMaterializationItemStatusV1::Conflict,
        }
    }
    if has_conflict(work) {
        UploadMaterializationStatusV1::Conflict
    } else {
        UploadMaterializationStatusV1::Ready
    }
}

fn save_operation(plan_id: &str, state: OperationState) -> Result<(), String> {
    let mut registry = registry()
        .lock()
        .map_err(|_| "upload plan registry unavailable".to_string())?;
    if let Some(plan) = registry.plans.get_mut(plan_id) {
        plan.operation = state;
    }
    Ok(())
}

#[tauri::command]
pub async fn ssh_upload_preflight_v1(
    state: tauri::State<'_, PtyState>,
    request: UploadPreflightRequestV1,
) -> Result<UploadPlanV1, String> {
    (async {
        validate_operation_id(&request.operation_id)?;
        validate_remote_path(&request.destination_root)?;
        if request.destination_root.len() > MAX_PATH_BYTES as usize
            || request.local_sources.is_empty()
            || request.local_sources.len() > MAX_ENTRIES as usize
        {
            return Err("invalid upload preflight bounds".into());
        }
        let sources = request.local_sources.clone();
        let limits = request.limits.clone();
        let local_entries =
            tokio::task::spawn_blocking(move || local_upload_manifest(&sources, limits))
                .await
                .map_err(|_| "local upload manifest task failed".to_string())??;
        let sftp = sftp_common::session_for_binding(&state, &request.binding).await?;
        let session = state
            .get_for_ssh_binding(&request.binding)
            .ok_or_else(|| "stale or invalid SSH session binding".to_string())?;
        let ssh = match session.as_ref() {
            Session::Ssh(ssh) => ssh,
            Session::Local(_) => return Err("not a remote session".into()),
        };
        let classifications = classify_destinations(
            ssh,
            &sftp,
            &request.destination_root,
            &local_entries
                .iter()
                .map(|entry| {
                    (
                        if entry.kind == ManifestEntryKind::File {
                            UploadItemKindV1::File
                        } else {
                            UploadItemKindV1::Dir
                        },
                        entry.relative_path.clone(),
                    )
                })
                .collect::<Vec<_>>(),
        )
        .await?;
        let mut items = Vec::with_capacity(local_entries.len());
        for (entry, destination) in local_entries.into_iter().zip(classifications) {
            let proposed_destination = join_remote(&request.destination_root, &entry.relative_path);
            if proposed_destination.len() > MAX_PATH_BYTES as usize {
                return Err("upload destination path exceeds maxPathBytes".into());
            }
            items.push(UploadPlanItemV1 {
                item_id: opaque_token()?,
                source_path: entry.source_path,
                relative_path: entry.relative_path,
                kind: if entry.kind == ManifestEntryKind::File {
                    UploadItemKindV1::File
                } else {
                    UploadItemKindV1::Dir
                },
                bytes: entry.bytes,
                proposed_destination: proposed_destination.clone(),
                destination,
                suggested_rename: (destination != UploadDestinationStateV1::Absent)
                    .then(|| suggested_sibling(&proposed_destination, 1).ok())
                    .flatten(),
            });
        }
        let plan_id = opaque_token()?;
        let plan = UploadPlanV1 {
            plan_id: plan_id.clone(),
            expires_at: now_millis().saturating_add(PLAN_TTL.as_millis() as u64),
            binding: request.binding,
            items,
        };
        let source_bytes = plan.items.iter().map(|item| item.bytes).sum();
        let payload_bytes = plan
            .items
            .iter()
            .map(|item| {
                item.item_id.len()
                    + item.source_path.len()
                    + item.relative_path.len()
                    + item.proposed_destination.len()
                    + item.suggested_rename.as_ref().map_or(0, String::len)
            })
            .sum();
        registry()
            .lock()
            .map_err(|_| "upload plan registry unavailable".to_string())?
            .insert(
                StoredPlan {
                    owner_operation_id: request.operation_id,
                    destination_root: request.destination_root,
                    plan: plan.clone(),
                    source_bytes,
                    payload_bytes,
                    operation: OperationState::Idle,
                },
                now_millis(),
            )?;
        Ok(plan)
    })
    .await
    .map_err(safe)
}

#[tauri::command]
pub async fn ssh_upload_materialize_v1(
    state: tauri::State<'_, PtyState>,
    request: UploadMaterializeRequestV1,
) -> Result<UploadMaterializationResultV1, String> {
    let stored = {
        let mut registry = registry()
            .lock()
            .map_err(|_| safe("upload plan registry unavailable".into()))?;
        let Some(stored) = registry.plans.get_mut(&request.plan_id) else {
            return Ok(empty_result(
                &request.plan_id,
                &request.operation_id,
                UploadMaterializationStatusV1::Stale,
            ));
        };
        if stored.plan.expires_at <= now_millis() {
            return Ok(empty_result(
                &request.plan_id,
                &request.operation_id,
                UploadMaterializationStatusV1::Expired,
            ));
        }
        if stored.owner_operation_id != request.operation_id {
            return Ok(empty_result(
                &request.plan_id,
                &request.operation_id,
                UploadMaterializationStatusV1::Stale,
            ));
        }
        match &stored.operation {
            OperationState::Completed(result) => return Ok(result.clone()),
            OperationState::NeedsReconcile(work) => {
                return Ok(result_from_work(
                    work,
                    UploadMaterializationStatusV1::OutcomeUnknown,
                ))
            }
            OperationState::Running => {
                return Ok(empty_result(
                    &request.plan_id,
                    &request.operation_id,
                    UploadMaterializationStatusV1::OutcomeUnknown,
                ))
            }
            OperationState::Idle => {}
        }
        let Ok(decisions) = decisions_by_id(&stored.plan, &request.decisions) else {
            return Ok(empty_result(
                &request.plan_id,
                &request.operation_id,
                UploadMaterializationStatusV1::Stale,
            ));
        };
        stored.operation = OperationState::Running;
        (stored.clone(), decisions)
    };

    let sftp = match sftp_common::session_for_binding(&state, &stored.0.plan.binding).await {
        Ok(session) => session,
        Err(_) => {
            let result = empty_result(
                &request.plan_id,
                &request.operation_id,
                UploadMaterializationStatusV1::Stale,
            );
            save_operation(&request.plan_id, OperationState::Completed(result.clone()))
                .map_err(safe)?;
            return Ok(result);
        }
    };
    let session = state
        .get_for_ssh_binding(&stored.0.plan.binding)
        .ok_or_else(|| safe("stale or invalid SSH session binding".into()))?;
    let ssh = match session.as_ref() {
        Session::Ssh(ssh) => ssh,
        Session::Local(_) => return Err(safe("not a remote session".into())),
    };
    let work = build_work(&stored.0, &stored.1, ssh, &sftp).await;
    if has_conflict(&work) {
        let result = result_from_work(&work, UploadMaterializationStatusV1::Conflict);
        save_operation(&request.plan_id, OperationState::Completed(result.clone()))
            .map_err(safe)?;
        return Ok(result);
    }

    let (mut work, directory_status) = materialize_directories(work, sftp.clone()).await;
    if directory_status == UploadMaterializationStatusV1::OutcomeUnknown {
        let result = result_from_work(&work, directory_status);
        save_operation(&request.plan_id, OperationState::NeedsReconcile(work)).map_err(safe)?;
        return Ok(result);
    }
    if directory_status == UploadMaterializationStatusV1::Conflict {
        let result = result_from_work(&work, directory_status);
        save_operation(&request.plan_id, OperationState::Completed(result.clone()))
            .map_err(safe)?;
        return Ok(result);
    }
    let status = finalize_files(&mut work, &sftp).await;
    let result = result_from_work(&work, status);
    save_operation(&request.plan_id, OperationState::Completed(result.clone())).map_err(safe)?;
    Ok(result)
}

#[tauri::command]
pub async fn ssh_upload_materialization_reconcile_v1(
    state: tauri::State<'_, PtyState>,
    request: UploadReconcileRequestV1,
) -> Result<UploadMaterializationResultV1, String> {
    let state_to_reconcile = {
        let registry = registry()
            .lock()
            .map_err(|_| safe("upload plan registry unavailable".into()))?;
        let Some(stored) = registry.plans.get(&request.plan_id) else {
            return Ok(empty_result(
                &request.plan_id,
                &request.operation_id,
                UploadMaterializationStatusV1::Stale,
            ));
        };
        if stored.plan.expires_at <= now_millis() {
            return Ok(empty_result(
                &request.plan_id,
                &request.operation_id,
                UploadMaterializationStatusV1::Expired,
            ));
        }
        if stored.owner_operation_id != request.operation_id {
            return Ok(empty_result(
                &request.plan_id,
                &request.operation_id,
                UploadMaterializationStatusV1::Stale,
            ));
        }
        match &stored.operation {
            OperationState::Completed(result) => return Ok(result.clone()),
            OperationState::NeedsReconcile(work) => work.clone(),
            OperationState::Running => {
                return Ok(empty_result(
                    &request.plan_id,
                    &request.operation_id,
                    UploadMaterializationStatusV1::OutcomeUnknown,
                ))
            }
            OperationState::Idle => {
                return Ok(empty_result(
                    &request.plan_id,
                    &request.operation_id,
                    UploadMaterializationStatusV1::Stale,
                ))
            }
        }
    };
    let sftp = match sftp_common::session_for_binding(&state, &state_to_reconcile.binding).await {
        Ok(session) => session,
        Err(_) => {
            return Ok(result_from_work(
                &state_to_reconcile,
                UploadMaterializationStatusV1::OutcomeUnknown,
            ))
        }
    };
    let mut work = state_to_reconcile;
    for item in &mut work.items {
        if item.status != UploadMaterializationItemStatusV1::OutcomeUnknown {
            continue;
        }
        let Some(request) = item.mutation.as_ref() else {
            continue;
        };
        match reconcile_mutation(&sftp, request).await {
            Ok(result) if result.status == MutationStatusV1::DesiredStateObserved => {
                item.status = UploadMaterializationItemStatusV1::DesiredStateObserved;
                item.mutation = None;
            }
            Ok(result) if result.status != MutationStatusV1::OutcomeUnknown => {
                item.status = UploadMaterializationItemStatusV1::Conflict;
                item.mutation = None;
            }
            _ => {}
        }
    }
    if work
        .items
        .iter()
        .any(|item| item.status == UploadMaterializationItemStatusV1::OutcomeUnknown)
    {
        let result = result_from_work(&work, UploadMaterializationStatusV1::OutcomeUnknown);
        save_operation(&request.plan_id, OperationState::NeedsReconcile(work)).map_err(safe)?;
        return Ok(result);
    }
    // Reconcile is deliberately read-only. If a deeper mkdir was never issued,
    // the operation has converged to a known incomplete conflict, not a retry.
    for item in &mut work.items {
        if item.kind == UploadItemKindV1::Dir
            && item.status == UploadMaterializationItemStatusV1::Ready
        {
            item.status = UploadMaterializationItemStatusV1::Conflict;
        }
    }
    let status = if has_conflict(&work) {
        UploadMaterializationStatusV1::Conflict
    } else {
        finalize_files(&mut work, &sftp).await
    };
    let result = result_from_work(&work, status);
    save_operation(&request.plan_id, OperationState::Completed(result.clone())).map_err(safe)?;
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn binding(generation: &str) -> SessionBindingV1 {
        SessionBindingV1 {
            logical_session_id: "logical".into(),
            physical_pty_id: 7,
            transport_generation: generation.into(),
        }
    }

    fn item(id: &str, destination: UploadDestinationStateV1) -> UploadPlanItemV1 {
        UploadPlanItemV1 {
            item_id: id.into(),
            source_path: format!("/local/{id}"),
            relative_path: id.into(),
            kind: UploadItemKindV1::File,
            bytes: 1,
            proposed_destination: format!("/remote/{id}"),
            destination,
            suggested_rename: None,
        }
    }

    fn stored(id: &str, generation: &str, expires_at: u64) -> StoredPlan {
        let plan = UploadPlanV1 {
            plan_id: id.into(),
            expires_at,
            binding: binding(generation),
            items: vec![item("one", UploadDestinationStateV1::Absent)],
        };
        StoredPlan {
            owner_operation_id: "operation".into(),
            destination_root: "/remote".into(),
            source_bytes: 1,
            payload_bytes: 100,
            operation: OperationState::Idle,
            plan,
        }
    }

    #[test]
    fn canonical_sibling_preserves_extension_and_path_bound() {
        assert_eq!(
            suggested_sibling("/remote/report.txt", 2).unwrap(),
            "/remote/report (2).txt"
        );
        let long = format!("/remote/{}.txt", "é".repeat(4_000));
        let sibling = suggested_sibling(&long, 1).unwrap();
        assert!(sibling.len() <= MAX_PATH_BYTES as usize);
        assert!(sibling.ends_with(" (1).txt"));
    }

    #[test]
    fn decisions_reject_unknown_and_duplicate_item_ids() {
        let plan = stored("plan", "g", u64::MAX).plan;
        assert!(decisions_by_id(
            &plan,
            &[UploadDecisionV1 {
                item_id: "tampered".into(),
                action: UploadActionV1::Skip,
            }]
        )
        .is_err());
        assert!(decisions_by_id(
            &plan,
            &[
                UploadDecisionV1 {
                    item_id: "one".into(),
                    action: UploadActionV1::Replace,
                },
                UploadDecisionV1 {
                    item_id: "one".into(),
                    action: UploadActionV1::Skip,
                },
            ]
        )
        .is_err());
    }

    #[test]
    fn undecided_conflicts_never_become_replace() {
        assert_eq!(
            work_action(&item("file", UploadDestinationStateV1::FileConflict), None),
            None
        );
        assert_eq!(
            work_action(&item("file", UploadDestinationStateV1::Absent), None),
            Some(WorkAction::CreateOnly)
        );
    }

    #[test]
    fn non_ready_results_publish_zero_descriptors_and_keep_partial_directories() {
        let work = MaterializationWork {
            plan_id: "plan".into(),
            operation_id: "operation".into(),
            binding: binding("g"),
            items: vec![
                MaterializationWorkItem {
                    item_id: "dir".into(),
                    relative_path: "dir".into(),
                    source_path: "/local/dir".into(),
                    kind: UploadItemKindV1::Dir,
                    action: WorkAction::CreateOnly,
                    destination_path: Some("/remote/dir".into()),
                    status: UploadMaterializationItemStatusV1::Applied,
                    overwrite: false,
                    mutation: None,
                },
                MaterializationWorkItem {
                    item_id: "file".into(),
                    relative_path: "dir/file".into(),
                    source_path: "/local/dir/file".into(),
                    kind: UploadItemKindV1::File,
                    action: WorkAction::CreateOnly,
                    destination_path: Some("/remote/dir/file".into()),
                    status: UploadMaterializationItemStatusV1::OutcomeUnknown,
                    overwrite: false,
                    mutation: None,
                },
            ],
        };
        let result = result_from_work(&work, UploadMaterializationStatusV1::OutcomeUnknown);
        assert!(result.descriptors.is_empty());
        assert_eq!(result.partial_directories, ["/remote/dir"]);
    }

    #[test]
    #[ignore = "projection scale benchmark; run explicitly from the runtime benchmark script"]
    fn materialization_projection_scale_benchmark() {
        use std::time::Instant;

        let mut scenarios = Vec::new();
        for (kind, count) in [
            (UploadItemKindV1::File, 1_000),
            (UploadItemKindV1::File, 10_000),
            (UploadItemKindV1::Dir, 100),
            (UploadItemKindV1::Dir, 1_000),
        ] {
            let label = if kind == UploadItemKindV1::File {
                "files"
            } else {
                "directories"
            };
            let work = MaterializationWork {
                plan_id: format!("plan-{label}-{count}"),
                operation_id: "operation".into(),
                binding: binding("g"),
                items: (0..count)
                    .map(|index| MaterializationWorkItem {
                        item_id: format!("item-{index}"),
                        relative_path: format!("item-{index}"),
                        source_path: format!("/local/item-{index}"),
                        kind,
                        action: WorkAction::CreateOnly,
                        destination_path: Some(format!("/remote/item-{index}")),
                        status: if kind == UploadItemKindV1::File {
                            UploadMaterializationItemStatusV1::Ready
                        } else {
                            UploadMaterializationItemStatusV1::Applied
                        },
                        overwrite: false,
                        mutation: None,
                    })
                    .collect(),
            };
            let started = Instant::now();
            let result = result_from_work(&work, UploadMaterializationStatusV1::Ready);
            let payload_bytes = serde_json::to_vec(&result).unwrap().len();
            let elapsed_ms = started.elapsed().as_secs_f64() * 1_000.0;
            assert_eq!(result.items.len(), count);
            if kind == UploadItemKindV1::File {
                assert_eq!(result.descriptors.len(), count);
            } else {
                assert_eq!(result.partial_directories.len(), count);
                assert!(result.descriptors.is_empty());
            }
            scenarios.push(serde_json::json!({
                "kind": label,
                "count": count,
                "ipcResponses": 1,
                "publishedDescriptors": result.descriptors.len(),
                "partialDirectories": result.partial_directories.len(),
                "payloadBytes": payload_bytes,
                "elapsedMs": (elapsed_ms * 1_000.0).round() / 1_000.0,
            }));
        }
        eprintln!(
            "RUNTIME_UPLOAD_MATERIALIZATION_SCALE_RESULT {}",
            serde_json::to_string(&serde_json::json!({
                "buildRevision": std::env::var("TUNARA_BENCHMARK_REVISION").unwrap_or_else(|_| "working-tree".into()),
                "platform": format!("{}-{}", std::env::consts::OS, std::env::consts::ARCH),
                "samples": 1,
                "units": "ms",
                "scenarios": scenarios,
            }))
            .unwrap()
        );
    }

    #[test]
    fn registry_prunes_expired_and_keys_binding_capacity_by_full_binding() {
        let mut registry = PlanRegistry::default();
        registry.insert(stored("expired", "old", 10), 1).unwrap();
        registry.insert(stored("fresh", "new", 100), 50).unwrap();
        assert!(!registry.plans.contains_key("expired"));
        assert!(registry.plans.contains_key("fresh"));

        for index in 0..MAX_BINDING_PLANS - 1 {
            registry
                .insert(stored(&format!("same-{index}"), "new", 100), 50)
                .unwrap();
        }
        assert!(registry.insert(stored("overflow", "new", 100), 50).is_err());
        assert!(registry
            .insert(stored("replacement", "next", 100), 50)
            .is_ok());
    }

    fn attrs(permissions: Option<u32>) -> FileAttributes {
        FileAttributes {
            permissions,
            ..FileAttributes::empty()
        }
    }

    #[test]
    fn explicit_symlink_hint_is_never_a_file_or_directory_conflict() {
        assert_eq!(
            hinted_kind(&attrs(Some(super::super::S_IFLNK | 0o777))),
            Some(RemotePathKindV1::Symlink)
        );
        assert_eq!(
            classify_present(UploadItemKindV1::File, RemotePathKindV1::Symlink),
            UploadDestinationStateV1::BlockingNonDirectory
        );
        assert_eq!(
            classify_present(UploadItemKindV1::Dir, RemotePathKindV1::Symlink),
            UploadDestinationStateV1::BlockingNonDirectory
        );
        assert_eq!(
            hinted_kind(&attrs(Some(super::super::S_IFREG | 0o644))),
            Some(RemotePathKindV1::File)
        );
        assert_eq!(
            hinted_kind(&attrs(Some(super::super::S_IFDIR | 0o755))),
            Some(RemotePathKindV1::Directory)
        );
        assert_eq!(hinted_kind(&attrs(None)), None);
        assert_eq!(hinted_kind(&attrs(Some(0))), None);
    }
}
