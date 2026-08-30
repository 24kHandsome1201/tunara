use serde::Serialize;
use tauri::State;

use crate::modules::pty::{PtyState, Session};

use super::diagnostics::SessionBindingV1;
use super::{safe_ipc_error, SshIpcErrorKind};

const MAX_SNAPSHOT_BYTES: usize = 512;
const SNAPSHOT_COMMAND: &str = r#"if [ "$(uname -s 2>/dev/null)" != Linux ] || [ ! -r /proc/meminfo ] || [ ! -r /proc/net/dev ]; then
  printf 'TUNARA_UNSUPPORTED\n'
else
  memory_total=''
  memory_available=''
  while read -r key value unit extra; do
    case "$key" in
      MemTotal:)
        [ "$unit" = kB ] && [ -z "$extra" ] || exit 1
        memory_total=$value
        ;;
      MemAvailable:)
        [ "$unit" = kB ] && [ -z "$extra" ] || exit 1
        memory_available=$value
        ;;
    esac
  done < /proc/meminfo
  case "$memory_total:$memory_available" in *[!0-9:]*|:*|*:) exit 1;; esac

  rx_total=0
  tx_total=0
  interfaces=0
  while IFS=: read -r interface counters; do
    [ -n "$counters" ] || continue
    interface=${interface#"${interface%%[![:space:]]*}"}
    interface=${interface%"${interface##*[![:space:]]}"}
    case "$interface" in ''|*[[:space:]]*) exit 1;; esac
    set -- $counters
    [ "$#" -eq 16 ] || exit 1
    rx=$1
    shift 8
    tx=$1
    case "$rx:$tx" in *[!0-9:]*|:*|*:) exit 1;; esac
    interfaces=$((interfaces + 1))
    if [ "$interface" != lo ]; then
      rx_total=$((rx_total + rx))
      tx_total=$((tx_total + tx))
    fi
  done < /proc/net/dev
  [ "$interfaces" -gt 0 ] || exit 1

  uptime_seconds=-
  if read -r observed_uptime _ < /proc/uptime 2>/dev/null; then
    [ -n "$observed_uptime" ] || exit 1
    uptime_seconds=$observed_uptime
  fi
  printf 'TUNARA_V1\nMEM %s %s\nNET %s %s\nUPTIME %s\n' \
    "$memory_total" "$memory_available" "$rx_total" "$tx_total" "$uptime_seconds"
fi"#;

#[derive(Debug, PartialEq, Serialize)]
#[serde(
    tag = "status",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum SshSystemSnapshotV1 {
    Available {
        observed_at: u64,
        memory_total_bytes: u64,
        memory_available_bytes: u64,
        rx_bytes: u64,
        tx_bytes: u64,
        #[serde(skip_serializing_if = "Option::is_none")]
        uptime_seconds: Option<u64>,
    },
    Unsupported {
        observed_at: u64,
    },
}

fn observed_now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX)
}

fn parse_pair(line: &str, prefix: &str) -> Result<(u64, u64), ()> {
    let values = line.strip_prefix(prefix).ok_or(())?;
    let mut fields = values.split(' ');
    let first = fields.next().ok_or(())?.parse::<u64>().map_err(|_| ())?;
    let second = fields.next().ok_or(())?.parse::<u64>().map_err(|_| ())?;
    if fields.next().is_some() {
        return Err(());
    }
    Ok((first, second))
}

fn parse_snapshot(raw: &str, observed_at: u64) -> Result<SshSystemSnapshotV1, ()> {
    if raw == "TUNARA_UNSUPPORTED\n" {
        return Ok(SshSystemSnapshotV1::Unsupported { observed_at });
    }
    let mut lines = raw.lines();
    if lines.next() != Some("TUNARA_V1") {
        return Err(());
    }
    let (total_kib, available_kib) = parse_pair(lines.next().ok_or(())?, "MEM ")?;
    let (rx_bytes, tx_bytes) = parse_pair(lines.next().ok_or(())?, "NET ")?;
    let uptime_value = lines
        .next()
        .and_then(|line| line.strip_prefix("UPTIME "))
        .ok_or(())?;
    let uptime_seconds = if uptime_value == "-" {
        None
    } else {
        Some(
            uptime_value
                .parse::<f64>()
                .ok()
                .filter(|value| value.is_finite() && *value >= 0.0)
                .map(|value| value.floor() as u64)
                .ok_or(())?,
        )
    };
    if lines.next().is_some() {
        return Err(());
    }
    let total = total_kib
        .checked_mul(1024)
        .filter(|value| *value > 0)
        .ok_or(())?;
    let available = available_kib
        .checked_mul(1024)
        .filter(|value| *value <= total)
        .ok_or(())?;

    Ok(SshSystemSnapshotV1::Available {
        observed_at,
        memory_total_bytes: total,
        memory_available_bytes: available,
        rx_bytes,
        tx_bytes,
        uptime_seconds,
    })
}

#[tauri::command]
pub async fn ssh_system_snapshot_v1(
    state: State<'_, PtyState>,
    binding: SessionBindingV1,
) -> Result<SshSystemSnapshotV1, String> {
    let result = async {
        let session = state
            .get_for_ssh_binding(&binding)
            .ok_or_else(|| "stale SSH binding".to_string())?;
        let Session::Ssh(ssh) = session.as_ref() else {
            return Err("stale SSH binding".to_string());
        };
        let raw = ssh.exec(SNAPSHOT_COMMAND, MAX_SNAPSHOT_BYTES).await?;
        parse_snapshot(&raw, observed_now()).map_err(|_| "malformed system snapshot".to_string())
    }
    .await;
    result.map_err(|error| safe_ipc_error(SshIpcErrorKind::SystemMonitor, error))
}

#[cfg(test)]
mod tests {
    use super::{parse_snapshot, SshSystemSnapshotV1};

    const VALID: &str = "TUNARA_V1\nMEM 1000 250\nNET 800 1000\nUPTIME 42.75\n";

    #[test]
    fn parses_available_snapshot() {
        assert_eq!(
            parse_snapshot(VALID, 7),
            Ok(SshSystemSnapshotV1::Available {
                observed_at: 7,
                memory_total_bytes: 1_024_000,
                memory_available_bytes: 256_000,
                rx_bytes: 800,
                tx_bytes: 1_000,
                uptime_seconds: Some(42),
            })
        );
    }

    #[test]
    fn parses_unsupported_snapshot() {
        assert_eq!(
            parse_snapshot("TUNARA_UNSUPPORTED\n", 9),
            Ok(SshSystemSnapshotV1::Unsupported { observed_at: 9 })
        );
    }

    #[test]
    fn accepts_unavailable_uptime() {
        assert_eq!(
            parse_snapshot(&VALID.replace("UPTIME 42.75", "UPTIME -"), 7),
            Ok(SshSystemSnapshotV1::Available {
                observed_at: 7,
                memory_total_bytes: 1_024_000,
                memory_available_bytes: 256_000,
                rx_bytes: 800,
                tx_bytes: 1_000,
                uptime_seconds: None,
            })
        );
    }

    #[test]
    fn rejects_missing_or_malformed_required_values() {
        assert!(parse_snapshot(&VALID.replace("MEM 1000 250", "MEM 1000"), 1).is_err());
        assert!(parse_snapshot(&VALID.replace("NET 800", "NET not-a-number"), 1).is_err());
        assert!(parse_snapshot(&VALID.replace("UPTIME 42.75", "UPTIME forever"), 1).is_err());
        assert!(parse_snapshot(&VALID.replace("MEM 1000 250", "MEM 100 250"), 1).is_err());
        assert!(parse_snapshot(&format!("{VALID}EXTRA\n"), 1).is_err());
    }
}
