use std::path::Path;

pub fn cleanup_hooks_settings(session_id: &str, config_dir: Option<&Path>) {
    let Some(config_dir) = config_dir else {
        return;
    };
    let Ok(entries) = std::fs::read_dir(config_dir) else {
        return;
    };
    let prefix = format!("tunara-agent-{session_id}.");
    for entry in entries.flatten() {
        let name = entry.file_name();
        let Some(name) = name.to_str() else {
            continue;
        };
        if !name.starts_with(&prefix) {
            continue;
        }
        let path = entry.path();
        // Never follow a symlink planted inside the runtime directory. The
        // parent is private (0700), but this keeps cleanup safe even if its
        // permissions drift or a future caller passes a less-trusted path.
        let Ok(metadata) = std::fs::symlink_metadata(&path) else {
            continue;
        };
        if metadata.file_type().is_symlink() || (metadata.is_file() && name.ends_with(".json")) {
            let _ = std::fs::remove_file(path);
        } else if metadata.is_dir() {
            let _ = std::fs::remove_dir_all(path);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::cleanup_hooks_settings;
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn cleanup_hooks_settings_only_removes_matching_session_runtimes() {
        let dir = std::env::temp_dir().join(format!(
            "tunara-wrapper-test-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("system time")
                .as_nanos()
        ));
        fs::create_dir_all(&dir).expect("create test dir");
        let target = dir.join("tunara-agent-s1.abcdef");
        let legacy_target = dir.join("tunara-agent-s1.legacy.json");
        let other_session = dir.join("tunara-agent-s2.abcdef");
        let other_file = dir.join("tunara-agent-s1.abcdef.txt");
        fs::create_dir_all(target.join("hooks")).expect("create target runtime");
        fs::write(target.join("hooks/hooks.json"), "{}").expect("write target hook");
        fs::write(&legacy_target, "{}").expect("write legacy target");
        fs::create_dir_all(&other_session).expect("create other session");
        fs::write(&other_file, "{}").expect("write other file");

        cleanup_hooks_settings("s1", Some(&dir));

        assert!(!target.exists());
        assert!(!legacy_target.exists());
        assert!(other_session.exists());
        assert!(other_file.exists());
        let _ = fs::remove_dir_all(&dir);
    }
}
