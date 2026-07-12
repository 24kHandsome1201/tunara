fn main() {
    let mut attributes = tauri_build::Attributes::new();
    if std::env::var_os("CARGO_FEATURE_M2_SAFE_WRITE_BENCHMARK").is_some() {
        attributes = attributes.plugin(
            "m2-safe-write-benchmark",
            tauri_build::InlinedPlugin::new().commands(&["arm_release_failure"]),
        );
    }
    if let Err(error) = tauri_build::try_build(attributes) {
        panic!("tauri build setup failed: {error:#}");
    }
}
