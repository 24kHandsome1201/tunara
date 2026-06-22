use std::time::Duration;

use serde::Deserialize;
use serde::Serialize;

use crate::modules::process::{run_capture, CommandSpec};
use crate::modules::resolver::ResolverState;

const PREFLIGHT_TIMEOUT: Duration = Duration::from_secs(10);

const AGENT_REGISTRY_JSON: &str = include_str!("../../../../src/modules/agent/registry-data.json");

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
struct AgentRegistryEntry {
    code: String,
    commands: Vec<String>,
    cli_bin: String,
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Preflight {
    pub installed: bool,
    pub logged_in: bool,
    pub hint: Option<String>,
}

fn agent_registry_entries() -> Vec<AgentRegistryEntry> {
    serde_json::from_str(AGENT_REGISTRY_JSON).expect("agent registry JSON must stay valid")
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

#[tauri::command]
pub async fn agent_preflight(
    resolver: tauri::State<'_, ResolverState>,
    agent: String,
) -> Result<Preflight, String> {
    let bin = agent_bin(&agent).ok_or("未知 agent")?;

    let resolved = resolver.resolve(&bin);
    let Some(path) = resolved.path.clone() else {
        return Ok(Preflight {
            installed: false,
            logged_in: false,
            hint: Some(format!(
                "未找到 {bin}，请先安装该 agent CLI（或在设置里指定路径）"
            )),
        });
    };
    let program = path.to_string_lossy().into_owned();

    let login_args: &[&str] = match bin.as_str() {
        "claude" => &["auth", "status"],
        "codex" => &["login", "status"],
        _ => {
            return Ok(Preflight {
                installed: true,
                logged_in: true,
                hint: None,
            });
        }
    };

    let logged_in = run_capture(
        CommandSpec::new(program).args(login_args.iter().map(|s| s.to_string())),
        PREFLIGHT_TIMEOUT,
    )
    .await
    .is_ok();

    Ok(Preflight {
        installed: true,
        logged_in,
        hint: if logged_in {
            None
        } else {
            Some(format!("{bin} 似乎未登录，请先登录"))
        },
    })
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
