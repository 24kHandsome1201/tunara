pub fn cleanup_hooks_settings(session_id: &str) {
    let path = format!("/tmp/tunara-agent-{session_id}.json");
    let _ = std::fs::remove_file(path);
}
