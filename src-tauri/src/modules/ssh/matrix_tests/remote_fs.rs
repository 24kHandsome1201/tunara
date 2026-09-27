//! SFTP and remote search through the production `#[tauri::command]`
//! functions on the ~10k-file fixture directory: bounded directory listing,
//! text read with fingerprint, upload, fingerprint-checked safe write (and its
//! conflict path), download into the sandboxed home, and `ssh_fs_grep` with a
//! wall-clock budget.

use std::time::{Duration, Instant};

use tauri::ipc::Channel;

use super::super::remote_git::{ssh_fs_grep, RemoteGrepRequest};
use super::super::sftp::{
    ssh_fs_read_dir, ssh_fs_read_file, ssh_fs_write_text_file, EntryKind, RemoteReadResult,
    UploadProgress,
};
use super::super::transfer::legacy::{ssh_fs_download, ssh_fs_upload};
use super::harness::{open, unique, CommandApp, Fixture, BIG_DIR, BIG_DIR_FILES, SCRATCH_DIR};
use crate::modules::fs::file::WriteResult;

const NEEDLE: &str = "NEEDLE-tunara";
/// entrypoint.sh plants the needle in every 1000th file: 1000..=9000.
const NEEDLE_FILES: usize = BIG_DIR_FILES / 1000;
const GREP_SAMPLES: usize = 3;

fn text(result: RemoteReadResult) -> (String, String) {
    match result {
        RemoteReadResult::Text {
            content,
            truncated,
            fingerprint,
            ..
        } => {
            assert!(!truncated, "fixture files are tiny");
            (
                content,
                fingerprint.expect("editable text carries a fingerprint"),
            )
        }
        other => panic!(
            "expected text, got {}",
            serde_json::to_string(&other).unwrap()
        ),
    }
}

fn grep_request(session_id: u32, pattern: &str, case_insensitive: bool) -> RemoteGrepRequest {
    serde_json::from_value(serde_json::json!({
        "sessionId": session_id,
        "root": BIG_DIR,
        "pattern": pattern,
        "caseInsensitive": case_insensitive,
        "maxResults": 200,
        "requestId": unique("grep"),
    }))
    .expect("RemoteGrepRequest wire shape")
}

#[tokio::test]
async fn sftp_list_read_write_upload_download_on_big_directory() {
    let fixture = Fixture::load();
    let app = CommandApp::new();
    let logical = unique("sftp");
    let (session, _log) = open(fixture.target(fixture.ed25519_auth(), &logical)).await;
    let binding = app.register(session, &logical, &format!("{logical}-gen-1"));
    let id = binding.physical_pty_id;

    // list: the whole ~10k directory fits the production entry bound.
    let started = Instant::now();
    let entries = ssh_fs_read_dir(app.pty(), id, BIG_DIR.into(), Some(false))
        .await
        .expect("read_dir big");
    let list_elapsed = started.elapsed();
    eprintln!(
        "read_dir {BIG_DIR}: {} entries in {list_elapsed:?}",
        entries.len()
    );
    assert_eq!(entries.len(), BIG_DIR_FILES);
    assert!(entries
        .iter()
        .all(|entry| matches!(entry.kind, EntryKind::File)));
    assert!(entries
        .iter()
        .all(|entry| entry.size > 0 && entry.mtime > 0));
    assert!(entries.iter().any(|entry| entry.name == "f-00001.txt"));
    assert!(entries
        .iter()
        .any(|entry| entry.name == format!("f-{BIG_DIR_FILES:05}.txt")));
    let mut sorted: Vec<&str> = entries.iter().map(|entry| entry.name.as_str()).collect();
    sorted.sort_unstable();
    sorted.dedup();
    assert_eq!(sorted.len(), BIG_DIR_FILES, "names are unique");
    let parent = ssh_fs_read_dir(app.pty(), id, "/srv/matrix".into(), Some(true))
        .await
        .expect("read_dir /srv/matrix");
    assert!(parent
        .iter()
        .any(|entry| entry.name == "big" && matches!(entry.kind, EntryKind::Dir)));
    assert!(
        parent.iter().any(|entry| entry.name == ".big-complete"),
        "include_hidden must surface dotfiles"
    );
    assert!(
        !entries.iter().any(|entry| entry.name.starts_with('.')),
        "hidden entries excluded by default"
    );

    // read: a needle file has the planted line.
    let (content, _) = text(
        ssh_fs_read_file(app.pty(), id, format!("{BIG_DIR}/f-01000.txt"))
            .await
            .expect("read_file"),
    );
    assert_eq!(content, "line 1000 alpha beta gamma\nNEEDLE-tunara 1000\n");
    let missing = ssh_fs_read_file(app.pty(), id, format!("{BIG_DIR}/does-not-exist.txt")).await;
    assert!(missing.is_err());

    // upload: local file from the throwaway home to a unique remote path.
    let local_dir = fixture.home.join("matrix-upload");
    std::fs::create_dir_all(&local_dir).expect("create upload dir");
    let stem = unique("edit");
    let local_source = local_dir.join(format!("{stem}.txt"));
    std::fs::write(&local_source, "upload-v1\n").expect("write upload source");
    let remote_path = format!("{SCRATCH_DIR}/{stem}.txt");
    let progress = std::sync::Arc::new(std::sync::Mutex::new(Vec::<(u64, u64)>::new()));
    let progress_sink = progress.clone();
    let on_progress = Channel::<UploadProgress>::new(move |body| {
        let value: serde_json::Value = match body {
            tauri::ipc::InvokeResponseBody::Json(json) => serde_json::from_str(&json).unwrap(),
            tauri::ipc::InvokeResponseBody::Raw(bytes) => serde_json::from_slice(&bytes).unwrap(),
        };
        progress_sink.lock().unwrap().push((
            value["transferred"].as_u64().unwrap_or_default(),
            value["total"].as_u64().unwrap_or_default(),
        ));
        Ok(())
    });
    let uploaded = ssh_fs_upload(
        app.pty(),
        id,
        unique("transfer"),
        local_source.display().to_string(),
        remote_path.clone(),
        false,
        on_progress,
    )
    .await
    .expect("upload");
    assert_eq!(uploaded, "upload-v1\n".len() as u64);
    assert!(
        progress
            .lock()
            .unwrap()
            .last()
            .is_some_and(|(done, total)| *done == uploaded && *total == uploaded),
        "progress must end at the full size: {:?}",
        progress.lock().unwrap()
    );
    let (content, fingerprint_v1) = text(
        ssh_fs_read_file(app.pty(), id, remote_path.clone())
            .await
            .expect("read uploaded"),
    );
    assert_eq!(content, "upload-v1\n");
    let duplicate = ssh_fs_upload(
        app.pty(),
        id,
        unique("transfer"),
        local_source.display().to_string(),
        remote_path.clone(),
        false,
        Channel::<UploadProgress>::new(|_| Ok(())),
    )
    .await;
    assert_eq!(
        duplicate,
        Err("SSH_TRANSFER_DESTINATION_EXISTS".to_string()),
        "overwrite=false must refuse an existing destination"
    );

    // safe-write: fingerprint-checked, then a stale fingerprint conflicts.
    let saved = ssh_fs_write_text_file(
        app.pty(),
        binding.clone(),
        remote_path.clone(),
        "scratch-v2\n".into(),
        fingerprint_v1.clone(),
    )
    .await
    .expect("safe write");
    let fingerprint_v2 = match saved {
        WriteResult::Saved { fingerprint, size } => {
            assert_eq!(size, "scratch-v2\n".len() as u64);
            fingerprint
        }
        WriteResult::Conflict {
            current_fingerprint,
        } => {
            panic!("fresh fingerprint conflicted: {current_fingerprint}")
        }
    };
    assert_ne!(fingerprint_v2, fingerprint_v1);
    let (content, reread) = text(
        ssh_fs_read_file(app.pty(), id, remote_path.clone())
            .await
            .expect("re-read"),
    );
    assert_eq!(content, "scratch-v2\n");
    assert_eq!(reread, fingerprint_v2);
    let stale = ssh_fs_write_text_file(
        app.pty(),
        binding.clone(),
        remote_path.clone(),
        "lost-update\n".into(),
        fingerprint_v1,
    )
    .await
    .expect("conflict is a result, not an error");
    match stale {
        WriteResult::Conflict {
            current_fingerprint,
        } => {
            assert_eq!(current_fingerprint, fingerprint_v2)
        }
        WriteResult::Saved { .. } => panic!("stale fingerprint must not overwrite"),
    }
    let (content, _) = text(
        ssh_fs_read_file(app.pty(), id, remote_path.clone())
            .await
            .expect("re-read after conflict"),
    );
    assert_eq!(content, "scratch-v2\n");

    // download: into the sandboxed home only.
    let downloads = fixture.home.join("Downloads");
    std::fs::create_dir_all(&downloads).expect("create Downloads");
    let local_target = downloads.join(format!("{stem}.txt"));
    let downloaded = ssh_fs_download(
        app.pty(),
        id,
        remote_path.clone(),
        local_target.display().to_string(),
    )
    .await
    .expect("download");
    assert_eq!(downloaded, "scratch-v2\n".len() as u64);
    assert_eq!(
        std::fs::read_to_string(&local_target).expect("read download"),
        "scratch-v2\n"
    );
    let escape = ssh_fs_download(
        app.pty(),
        id,
        remote_path.clone(),
        format!("/tmp/tunara-matrix-escape-{stem}.txt"),
    )
    .await;
    assert!(
        escape.is_err(),
        "downloads outside the home directory must be refused"
    );

    // Leave the scratch directory as we found it for the next run.
    let removed = ssh_fs_read_file(app.pty(), id, remote_path.clone()).await;
    assert!(removed.is_ok());
    let session = app.session(&binding).expect("binding live");
    let crate::modules::pty::Session::Ssh(ssh) = session.as_ref() else {
        panic!("ssh session")
    };
    ssh.exec(&format!("rm -f {remote_path}"), 4096)
        .await
        .expect("cleanup");
    ssh.close().expect("close");
}

#[tokio::test]
async fn remote_grep_over_big_directory_within_budget() {
    let fixture = Fixture::load();
    let app = CommandApp::new();
    let logical = unique("grep");
    let (session, _log) = open(fixture.target(fixture.ed25519_auth(), &logical)).await;
    let binding = app.register(session, &logical, &format!("{logical}-gen-1"));
    let id = binding.physical_pty_id;

    let mut samples = Vec::with_capacity(GREP_SAMPLES);
    for _ in 0..GREP_SAMPLES {
        let started = Instant::now();
        let response = ssh_fs_grep(app.pty(), app.search(), grep_request(id, NEEDLE, false))
            .await
            .expect("ssh_fs_grep");
        samples.push(started.elapsed());
        assert!(!response.truncated);
        assert_eq!(response.files_scanned, NEEDLE_FILES);
        assert_eq!(response.hits.len(), NEEDLE_FILES);
        let mut rels: Vec<&str> = response.hits.iter().map(|hit| hit.rel.as_str()).collect();
        rels.sort_unstable();
        let expected: Vec<String> = (1..=NEEDLE_FILES)
            .map(|index| format!("f-{:05}.txt", index * 1000))
            .collect();
        assert_eq!(rels, expected);
        for hit in &response.hits {
            assert_eq!(hit.line, 2, "the needle is always the second line");
            assert!(hit.text.contains(NEEDLE));
            assert_eq!(hit.path, format!("{BIG_DIR}/{}", hit.rel));
        }
    }
    let best = samples.iter().copied().min().unwrap_or(Duration::MAX);
    eprintln!(
        "ssh_fs_grep over {BIG_DIR_FILES} files: samples={samples:?} best={best:?} budget={:?}",
        fixture.grep_budget
    );
    assert!(
        best <= fixture.grep_budget,
        "remote grep over ~10k files took {best:?} at best (samples {samples:?}), budget {:?}; \
         raise TUNARA_SSH_MATRIX_GREP_BUDGET_MS only with a documented reason",
        fixture.grep_budget
    );

    let insensitive = ssh_fs_grep(
        app.pty(),
        app.search(),
        grep_request(id, "needle-TUNARA", true),
    )
    .await
    .expect("case-insensitive grep");
    assert_eq!(insensitive.hits.len(), NEEDLE_FILES);
    let sensitive = ssh_fs_grep(
        app.pty(),
        app.search(),
        grep_request(id, "needle-TUNARA", false),
    )
    .await
    .expect("case-sensitive grep");
    assert!(sensitive.hits.is_empty());
    assert_eq!(sensitive.files_scanned, 0);

    let session = app.session(&binding).expect("binding live");
    if let crate::modules::pty::Session::Ssh(ssh) = session.as_ref() {
        ssh.close().expect("close");
    }
}
