use std::collections::HashMap;
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant};

use serde::Deserialize;
use serde::Serialize;

use crate::modules::process::{run_capture, CommandSpec};
use crate::modules::resolver::ResolverState;

const PREFLIGHT_TIMEOUT: Duration = Duration::from_secs(10);
const PREFLIGHT_CACHE_TTL: Duration = Duration::from_secs(30 * 60);

const AGENT_REGISTRY_JSON: &str = include_str!("../../../../src/modules/agent/registry-data.json");

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
struct AgentRegistryEntry {
    code: String,
    commands: Vec<String>,
    cli_bin: String,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Preflight {
    pub installed: bool,
    pub logged_in: bool,
    pub hint: Option<String>,
}

static PREFLIGHT_CACHE: LazyLock<Mutex<HashMap<String, (Preflight, Instant)>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// Parse the embedded agent registry once (it's `include_str!`-baked at build
/// time), instead of re-parsing on every `agent_bin` lookup.
static AGENT_REGISTRY: LazyLock<Vec<AgentRegistryEntry>> = LazyLock::new(|| {
    serde_json::from_str(AGENT_REGISTRY_JSON).expect("agent registry JSON must stay valid")
});

fn agent_registry_entries() -> Vec<AgentRegistryEntry> {
    AGENT_REGISTRY.clone()
}

fn agent_bin(agent: &str) -> Option<String> {
    let normalized = agent.trim().to_lowercase();
    agent_registry_entries()
        .into_iter()
        .find(|entry| {
            entry.code.eq_ignore_ascii_case(agent)
                || entry.cli_bin.eq_ignore_ascii_case(&normalized)
                || entry
                    .commands
                    .iter()
                    .any(|command| command.eq_ignore_ascii_case(&normalized))
        })
        .map(|entry| entry.cli_bin)
}

fn cache_get(bin: &str) -> Option<Preflight> {
    let cache = PREFLIGHT_CACHE.lock().ok()?;
    let (value, ts) = cache.get(bin)?;
    if ts.elapsed() < PREFLIGHT_CACHE_TTL {
        Some(value.clone())
    } else {
        None
    }
}

fn cache_put(bin: &str, value: &Preflight) {
    if let Ok(mut cache) = PREFLIGHT_CACHE.lock() {
        cache.insert(bin.to_string(), (value.clone(), Instant::now()));
    }
}

#[tauri::command]
pub async fn agent_preflight(
    resolver: tauri::State<'_, ResolverState>,
    agent: String,
) -> Result<Preflight, String> {
    let bin = agent_bin(&agent).ok_or("未知 agent")?;

    if let Some(cached) = cache_get(&bin) {
        return Ok(cached);
    }

    let resolved = resolver.resolve(&bin);
    let Some(path) = resolved.path.clone() else {
        let value = Preflight {
            installed: false,
            logged_in: false,
            hint: Some(format!(
                "未找到 {bin}，请先安装该 agent CLI（或在设置里指定路径）"
            )),
        };
        cache_put(&bin, &value);
        return Ok(value);
    };
    let program = path.to_string_lossy().into_owned();

    let login_args: &[&str] = match bin.as_str() {
        "claude" => &["auth", "status"],
        "codex" => &["login", "status"],
        "gh" => &["auth", "status"],
        _ => {
            let value = Preflight {
                installed: true,
                logged_in: true,
                hint: None,
            };
            cache_put(&bin, &value);
            return Ok(value);
        }
    };

    let logged_in = run_capture(
        CommandSpec::new(program).args(login_args.iter().map(|s| s.to_string())),
        PREFLIGHT_TIMEOUT,
    )
    .await
    .is_ok();

    let value = Preflight {
        installed: true,
        logged_in,
        hint: if logged_in {
            None
        } else {
            Some(format!("{bin} 似乎未登录，请先登录"))
        },
    };
    cache_put(&bin, &value);
    Ok(value)
}

#[tauri::command]
pub fn agent_preflight_invalidate(agent: Option<String>) -> Result<(), String> {
    let mut cache = PREFLIGHT_CACHE
        .lock()
        .map_err(|_| "preflight cache poisoned".to_string())?;
    match agent {
        Some(a) => {
            if let Some(bin) = agent_bin(&a) {
                cache.remove(&bin);
            }
        }
        None => cache.clear(),
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{agent_bin, agent_registry_entries};

    #[test]
    fn preflight_uses_shared_agent_registry_data() {
        let entries = agent_registry_entries();
        assert_eq!(entries.len(), 12);
        assert_eq!(agent_bin("CC").as_deref(), Some("claude"));
        assert_eq!(agent_bin("codex").as_deref(), Some("codex"));
        assert_eq!(agent_bin("cursor-agent").as_deref(), Some("cursor-agent"));
        assert_eq!(agent_bin("agent"), None);
        assert_eq!(agent_bin("cline"), None);
    }
}
