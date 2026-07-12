import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const read = (path) => fs.readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("M2 safe-write fault control is a non-default, feature-only plugin", () => {
  const cargo = read("src-tauri/Cargo.toml");
  const ssh = read("src-tauri/src/modules/ssh/mod.rs");
  const app = read("src-tauri/src/lib.rs");
  const build = read("src-tauri/build.rs");
  const fault = read("src-tauri/src/modules/ssh/m2_safe_write_benchmark.rs");
  const runner = read("scripts/benchmark-m2-safe-write.sh");

  const features = cargo.match(/\[features\]([\s\S]*?)\n\[/)?.[1] ?? "";
  assert.match(features, /^default = \[\]$/m);
  assert.match(features, /^m2-safe-write-benchmark = \[\]$/m);
  assert.match(ssh, /#\[cfg\(feature = "m2-safe-write-benchmark"\)\]\s+pub\(crate\) mod m2_safe_write_benchmark/);
  assert.match(app, /#\[cfg\(feature = "m2-safe-write-benchmark"\)\]\s+let builder = builder\.plugin\(modules::ssh::m2_safe_write_benchmark::init\(\)\)/);
  assert.doesNotMatch(app.match(/generate_handler!\[([\s\S]*?)\]/)?.[1] ?? "", /arm_release_failure/);
  assert.match(fault, /const FIXTURE_PREFIX: &str = "\/tmp\/tunara-m2-safe-write-benchmark-"/);
  assert.match(fault, /Session::Ssh/);
  assert.match(fault, /already armed/);
  assert.doesNotMatch(fault, /password|identity_file|shell_command|fault_stage/);
  assert.match(build, /CARGO_FEATURE_M2_SAFE_WRITE_BENCHMARK/);
  assert.match(build, /InlinedPlugin::new\(\)\.commands\(&\["arm_release_failure"\]\)/);
  assert.match(runner, /m2-safe-write-benchmark:allow-arm-release-failure/);
});

test("the injected release failure is compiled out of ordinary SFTP writes", () => {
  const sftp = read("src-tauri/src/modules/ssh/sftp.rs");
  assert.match(sftp, /#\[cfg\(feature = "m2-safe-write-benchmark"\)\]\s+session_id: u32/);
  assert.match(sftp, /#\[cfg\(feature = "m2-safe-write-benchmark"\)\]\s+if super::m2_safe_write_benchmark::take_release_failure/);
});

test("the M2 runner drives real file, save, reconnect, and reconcile surfaces", () => {
  const hook = read("src/app/useM2SafeWriteBenchmark.ts");
  const script = read("scripts/benchmark-m2-safe-write.sh");

  assert.match(hook, /fileButton\(path\)\)\)\.click\(\)/);
  assert.match(hook, /save\.click\(\)/);
  assert.match(hook, /disconnectAndReconnectSshBenchmarkSession\(session\.id\)/);
  assert.match(hook, /reconcile\.click\(\)/);
  assert.match(hook, /session\.dir\.replace/);
  assert.doesNotMatch(script, /VITE_TUNARA_M2_FIXTURE_PATH/);
  assert.match(script, /jq -e '\.passed == true'/);
});
