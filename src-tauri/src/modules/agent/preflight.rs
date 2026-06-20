use std::time::Duration;

use serde::Serialize;

use crate::modules::process::{run_capture, CommandSpec};
use crate::modules::resolver::ResolverState;

const PREFLIGHT_TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Preflight {
    pub installed: bool,
    pub logged_in: bool,
    pub hint: Option<String>,
}

fn agent_bin(code: &str) -> Option<&'static str> {
    match code {
        "claude" | "CC" => Some("claude"),
        "codex" | "CX" => Some("codex"),
        "gemini" | "GM" => Some("gemini"),
        "aider" => Some("aider"),
        "copilot" | "CP" => Some("gh"),
        "amp" | "AM" => Some("amp"),
        "cline" => Some("cline"),
        "roo" => Some("roo"),
        "kilo-code" => Some("kilo-code"),
        "void" => Some("void"),
        "codename-goose" => Some("goose"),
        "cursor" | "CR" => Some("cursor"),
        "droid" | "DR" => Some("droid"),
        "opencode" | "OC" => Some("opencode"),
        "pi" | "PI" => Some("pi"),
        "auggie" | "AG" => Some("auggie"),
        "devin" | "DV" => Some("devin"),
        _ => None,
    }
}

#[tauri::command]
pub async fn agent_preflight(
    resolver: tauri::State<'_, ResolverState>,
    agent: String,
) -> Result<Preflight, String> {
    let bin = agent_bin(&agent).ok_or("未知 agent")?;

    let resolved = resolver.resolve(bin);
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

    let login_args: &[&str] = match agent.as_str() {
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
