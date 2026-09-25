use std::path::{Component, Path};
use std::sync::atomic::Ordering;

use tokio::io::{AsyncReadExt, AsyncSeekExt};

use super::{
    content_fingerprint, observation, observation_completely_matches, sftp_for,
    validate_remote_edit_path, FileObservationKindV1, FileObservationV1, ReadIfChangedResultV1,
    ReadIfChangedValueV1, ReadIfChangedViewV1, RemoteReadResult, MAX_TEXT_PREVIEW_BYTES,
    SFTP_CHUNK_TIMEOUT, SFTP_CONTROL_TIMEOUT, SFTP_PREVIEW_TIMEOUT,
};
use crate::modules::fs::head::{
    finish_tail, remote_revision, validate_line_limit, FileHeadResultV1, FileViewErrorV1,
    HeadAccumulator, RequestRegistration, HEAD_CHUNK_BYTES, MAX_HEAD_BYTES,
};
use crate::modules::pty::PtyState;
use crate::modules::ssh::connection::await_stage;
use crate::modules::ssh::diagnostics::SessionBindingV1;
// 10 MiB hard read cap, matching local fs.
const MAX_READ_BYTES: u64 = 10 * 1024 * 1024;

/// Read a remote file for preview. Same caps/behavior as fs_read_file:
/// too-large → metadata only; non-UTF8 → binary; otherwise text (truncated to
/// the preview budget).
#[tauri::command]
pub async fn ssh_fs_read_file(
    state: tauri::State<'_, PtyState>,
    id: u32,
    path: String,
) -> Result<RemoteReadResult, String> {
    (async {
        let sftp = sftp_for(&state, id).await?;

        crate::modules::perf_counters::sftp_lstat();
        let link_meta = await_stage(
            "lstat remote file",
            SFTP_CONTROL_TIMEOUT,
            sftp.symlink_metadata(&path),
        )
        .await?;
        let editable_regular = link_meta.is_regular() && !link_meta.is_symlink();
        let meta = await_stage(
            "stat remote file",
            SFTP_CONTROL_TIMEOUT,
            sftp.metadata(&path),
        )
        .await?;
        let size = meta.size.unwrap_or(0);
        if size > MAX_READ_BYTES {
            return Ok(RemoteReadResult::TooLarge {
                size,
                limit: MAX_READ_BYTES,
            });
        }

        // Stream only the UI preview budget. The old implementation buffered up
        // to 10 MiB before returning a 256 KiB slice, which made opening a large
        // remote log needlessly expensive before the user chose a bounded view.
        let mut file =
            await_stage("open remote file", SFTP_CONTROL_TIMEOUT, sftp.open(&path)).await?;
        let mut bytes: Vec<u8> = Vec::with_capacity(size.min(MAX_TEXT_PREVIEW_BYTES + 1) as usize);
        await_stage(
            "read remote file",
            SFTP_PREVIEW_TIMEOUT,
            (&mut file)
                .take(MAX_TEXT_PREVIEW_BYTES + 1)
                .read_to_end(&mut bytes),
        )
        .await?;
        crate::modules::perf_counters::sftp_read_bytes(bytes.len());

        let truncated =
            size > MAX_TEXT_PREVIEW_BYTES || bytes.len() as u64 > MAX_TEXT_PREVIEW_BYTES;
        if bytes.len() as u64 > MAX_TEXT_PREVIEW_BYTES {
            bytes.truncate(MAX_TEXT_PREVIEW_BYTES as usize);
        }

        if let Some(image) = crate::modules::fs::file::image_preview(&bytes) {
            if u64::from(image.width).saturating_mul(u64::from(image.height))
                > crate::modules::fs::file::MAX_IMAGE_PIXELS
            {
                return Ok(RemoteReadResult::ImageTooLarge {
                    size,
                    width: image.width,
                    height: image.height,
                    max_pixels: crate::modules::fs::file::MAX_IMAGE_PIXELS,
                });
            }
            // Raster previews intentionally need the complete payload, unlike
            // large text. Reopen after sniffing so the byte dropped by the
            // text-preview +1 probe cannot corrupt the image, and retain the
            // existing 10 MiB hard bound if remote metadata under-reported.
            let mut image_file =
                await_stage("open remote image", SFTP_CONTROL_TIMEOUT, sftp.open(&path)).await?;
            let mut image_bytes = Vec::with_capacity(size.min(MAX_READ_BYTES + 1) as usize);
            await_stage(
                "read remote image",
                SFTP_PREVIEW_TIMEOUT,
                (&mut image_file)
                    .take(MAX_READ_BYTES + 1)
                    .read_to_end(&mut image_bytes),
            )
            .await?;
            if image_bytes.len() as u64 > MAX_READ_BYTES {
                return Ok(RemoteReadResult::TooLarge {
                    size: image_bytes.len() as u64,
                    limit: MAX_READ_BYTES,
                });
            }
            return Ok(RemoteReadResult::Image {
                bytes: image_bytes,
                size,
                mime: image.mime,
                width: image.width,
                height: image.height,
            });
        }

        // Null-byte heuristic for binary detection, like the local reader.
        if bytes.contains(&0) {
            return Ok(RemoteReadResult::Binary { size });
        }
        match String::from_utf8(bytes) {
            Ok(content) => Ok(RemoteReadResult::Text {
                fingerprint: (editable_regular && !truncated && content.len() as u64 == size)
                    .then(|| content_fingerprint(content.as_bytes())),
                content,
                size,
                truncated,
            }),
            Err(error) if truncated && error.utf8_error().error_len().is_none() => {
                let valid = error.utf8_error().valid_up_to();
                let mut bytes = error.into_bytes();
                bytes.truncate(valid);
                Ok(RemoteReadResult::Text {
                    content: String::from_utf8(bytes).expect("valid UTF-8 prefix"),
                    size,
                    truncated: true,
                    fingerprint: None,
                })
            }
            Err(_) => Ok(RemoteReadResult::Binary { size }),
        }
    })
    .await
    .map_err(|error: String| {
        crate::modules::ssh::safe_ipc_error(crate::modules::ssh::SshIpcErrorKind::SftpRead, error)
    })
}

/// Poll a preview through a complete SSH binding. LSTAT observations are only
/// change hints: they are not fingerprints and are never accepted by writes.
#[tauri::command]
pub async fn ssh_fs_read_if_changed_v1(
    state: tauri::State<'_, PtyState>,
    request_id: String,
    binding: SessionBindingV1,
    path: String,
    known: Option<FileObservationV1>,
    view: ReadIfChangedViewV1,
) -> Result<ReadIfChangedResultV1, FileViewErrorV1> {
    crate::modules::perf_counters::binding_timer_poll();
    // Keep registration alive until nested reads and final identity checks finish.
    let _registration = RequestRegistration::register(request_id.clone())?;
    validate_remote_edit_path(&path).map_err(|_| FileViewErrorV1::invalid_request())?;
    if Path::new(&path)
        .components()
        .any(|part| matches!(part, Component::CurDir))
    {
        return Err(FileViewErrorV1::invalid_request());
    }
    let sftp = super::super::sftp_common::session_for_binding(state.inner(), &binding)
        .await
        .map_err(|_| FileViewErrorV1::stale_binding())?;
    crate::modules::perf_counters::sftp_lstat();
    let before_attrs = await_stage(
        "lstat refresh file",
        SFTP_CONTROL_TIMEOUT,
        sftp.symlink_metadata(&path),
    )
    .await
    .map_err(|error| remote_file_view_error(&error))?;
    let before = observation(&before_attrs);
    if before.kind != FileObservationKindV1::File {
        return Err(FileViewErrorV1::read_failed());
    }
    if known
        .as_ref()
        .is_some_and(|value| observation_completely_matches(value, &before))
    {
        return Ok(ReadIfChangedResultV1::Unchanged {
            observation: before,
        });
    }
    let value = match view {
        ReadIfChangedViewV1::Preview => ReadIfChangedValueV1::Preview(
            ssh_fs_read_file(state.clone(), binding.physical_pty_id, path.clone())
                .await
                .map_err(|_| FileViewErrorV1::read_failed())?,
        ),
        ReadIfChangedViewV1::Head { line_limit } => ReadIfChangedValueV1::Bounded(
            ssh_file_view_head_v1(
                state.clone(),
                binding.clone(),
                path.clone(),
                line_limit,
                format!("{}-head", &request_id[..request_id.len().min(100)]),
            )
            .await?,
        ),
        ReadIfChangedViewV1::Tail { line_limit } => ReadIfChangedValueV1::Bounded(
            ssh_file_view_tail_v1(
                state.clone(),
                binding.clone(),
                path.clone(),
                line_limit,
                format!("{}-tail", &request_id[..request_id.len().min(100)]),
            )
            .await?,
        ),
    };
    // Revalidate both binding and authoritative LSTAT after all content bytes.
    super::super::sftp_common::session_for_binding(state.inner(), &binding)
        .await
        .map_err(|_| FileViewErrorV1::stale_binding())?;
    crate::modules::perf_counters::sftp_lstat();
    let after_attrs = await_stage(
        "restat refresh file",
        SFTP_CONTROL_TIMEOUT,
        sftp.symlink_metadata(&path),
    )
    .await
    .map_err(|_| FileViewErrorV1::changed())?;
    let after = observation(&after_attrs);
    if !observation_completely_matches(&before, &after) {
        return Err(FileViewErrorV1::changed());
    }
    Ok(ReadIfChangedResultV1::Changed {
        observation: after,
        value,
    })
}

/// Read only the first requested lines through the current, fully validated
/// SSH binding. Both the line count and buffered bytes have backend hard caps.
#[tauri::command]
pub async fn ssh_file_view_head_v1(
    state: tauri::State<'_, PtyState>,
    binding: SessionBindingV1,
    path: String,
    line_limit: u32,
    request_id: String,
) -> Result<FileHeadResultV1, FileViewErrorV1> {
    validate_line_limit(line_limit)?;
    let registration = RequestRegistration::register(request_id)?;
    let sftp = super::super::sftp_common::session_for_binding(state.inner(), &binding)
        .await
        .map_err(|_| FileViewErrorV1::stale_binding())?;
    let before = await_stage(
        "stat bounded remote file",
        SFTP_CONTROL_TIMEOUT,
        sftp.metadata(&path),
    )
    .await
    .map_err(|error| remote_file_view_error(&error))?;
    if !before.is_regular() {
        return Err(FileViewErrorV1::read_failed());
    }
    let size = before.size.unwrap_or(0);
    let before_revision = remote_revision(size, before.mtime);
    let mut file = await_stage(
        "open bounded remote file",
        SFTP_CONTROL_TIMEOUT,
        sftp.open(&path),
    )
    .await
    .map_err(|error| remote_file_view_error(&error))?;
    let mut accumulator = HeadAccumulator::new();
    let mut chunk = [0_u8; HEAD_CHUNK_BYTES];
    let reached_eof = tokio::time::timeout(SFTP_PREVIEW_TIMEOUT, async {
        loop {
            if registration.cancelled.load(Ordering::Acquire) {
                return Err(FileViewErrorV1::cancelled());
            }
            let count = tokio::time::timeout(SFTP_CHUNK_TIMEOUT, file.read(&mut chunk))
                .await
                .map_err(|_| FileViewErrorV1::read_failed())?
                .map_err(|error| remote_file_view_error(&error.to_string()))?;
            if count == 0 {
                break Ok(true);
            }
            accumulator.push(&chunk[..count], line_limit);
            if accumulator.is_complete() {
                break Ok(false);
            }
        }
    })
    .await
    .map_err(|_| FileViewErrorV1::read_failed())??;
    if registration.cancelled.load(Ordering::Acquire) {
        return Err(FileViewErrorV1::cancelled());
    }
    let after = await_stage(
        "restat bounded remote file",
        SFTP_CONTROL_TIMEOUT,
        sftp.metadata(&path),
    )
    .await
    .map_err(|_| FileViewErrorV1::changed())?;
    let after_size = after.size.unwrap_or(0);
    let after_revision = remote_revision(after_size, after.mtime);
    if before_revision != after_revision {
        return Err(FileViewErrorV1::changed());
    }
    Ok(accumulator.finish(size, before_revision, line_limit, reached_eof))
}

/// Read only the last requested lines through the current SSH binding.
#[tauri::command]
pub async fn ssh_file_view_tail_v1(
    state: tauri::State<'_, PtyState>,
    binding: SessionBindingV1,
    path: String,
    line_limit: u32,
    request_id: String,
) -> Result<FileHeadResultV1, FileViewErrorV1> {
    validate_line_limit(line_limit)?;
    let registration = RequestRegistration::register(request_id)?;
    let sftp = super::super::sftp_common::session_for_binding(state.inner(), &binding)
        .await
        .map_err(|_| FileViewErrorV1::stale_binding())?;
    let before = await_stage(
        "stat bounded remote tail",
        SFTP_CONTROL_TIMEOUT,
        sftp.metadata(&path),
    )
    .await
    .map_err(|error| remote_file_view_error(&error))?;
    if !before.is_regular() {
        return Err(FileViewErrorV1::read_failed());
    }
    let size = before.size.unwrap_or(0);
    let before_revision = remote_revision(size, before.mtime);
    let offset = size.saturating_sub(MAX_HEAD_BYTES as u64);
    let mut file = await_stage(
        "open bounded remote tail",
        SFTP_CONTROL_TIMEOUT,
        sftp.open(&path),
    )
    .await
    .map_err(|error| remote_file_view_error(&error))?;
    if offset > 0 {
        tokio::time::timeout(
            SFTP_CONTROL_TIMEOUT,
            file.seek(std::io::SeekFrom::Start(offset)),
        )
        .await
        .map_err(|_| FileViewErrorV1::read_failed())?
        .map_err(|_| FileViewErrorV1::read_failed())?;
    }
    let mut bytes = Vec::with_capacity((size - offset).min(MAX_HEAD_BYTES as u64) as usize);
    let mut chunk = [0_u8; HEAD_CHUNK_BYTES];
    tokio::time::timeout(SFTP_PREVIEW_TIMEOUT, async {
        loop {
            if registration.cancelled.load(Ordering::Acquire) {
                return Err(FileViewErrorV1::cancelled());
            }
            let count = tokio::time::timeout(SFTP_CHUNK_TIMEOUT, file.read(&mut chunk))
                .await
                .map_err(|_| FileViewErrorV1::read_failed())?
                .map_err(|error| remote_file_view_error(&error.to_string()))?;
            if count == 0 {
                break Ok(());
            }
            let remaining = MAX_HEAD_BYTES.saturating_sub(bytes.len());
            bytes.extend_from_slice(&chunk[..count.min(remaining)]);
            if bytes.len() == MAX_HEAD_BYTES {
                break Ok(());
            }
        }
    })
    .await
    .map_err(|_| FileViewErrorV1::read_failed())??;
    if registration.cancelled.load(Ordering::Acquire) {
        return Err(FileViewErrorV1::cancelled());
    }
    let after = await_stage(
        "restat bounded remote tail",
        SFTP_CONTROL_TIMEOUT,
        sftp.metadata(&path),
    )
    .await
    .map_err(|_| FileViewErrorV1::changed())?;
    let after_revision = remote_revision(after.size.unwrap_or(0), after.mtime);
    if before_revision != after_revision {
        return Err(FileViewErrorV1::changed());
    }
    Ok(finish_tail(
        bytes,
        size,
        before_revision,
        line_limit,
        offset > 0,
    ))
}

fn remote_file_view_error(raw: &str) -> FileViewErrorV1 {
    if raw.to_ascii_lowercase().contains("permission") {
        FileViewErrorV1::permission_denied()
    } else {
        FileViewErrorV1::read_failed()
    }
}
