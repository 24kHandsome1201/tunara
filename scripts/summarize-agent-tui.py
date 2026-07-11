#!/usr/bin/env python3
"""Build a redacted machine-readable summary from Agent TUI smoke logs."""

from __future__ import annotations

import argparse
import json
import re
from datetime import datetime, timezone
from pathlib import Path


AGENTS = ("claude", "codex", "pi", "opencode", "aider", "unknown")
SCOPES = ("local", "ssh")
SUMMARY_PATTERN = re.compile(r"([a-z_]+)=(-?\d+)")


def read_text(path: Path) -> str:
    return path.read_text(encoding="utf-8", errors="replace").strip()


def parse_harness(path: Path) -> dict[str, int]:
    if not path.exists():
        return {}
    return {key: int(value) for key, value in SUMMARY_PATTERN.findall(read_text(path))}


def protocol_flags(data: bytes) -> dict[str, bool]:
    return {
        "alternateScreen": b"\x1b[?1049h" in data,
        "alternateScreenRestored": b"\x1b[?1049l" in data,
        "bracketedPaste": b"\x1b[?2004h" in data,
        "focusReporting": b"\x1b[?1004h" in data,
        "mouseTracking": any(
            mode in data for mode in (b"\x1b[?1000h", b"\x1b[?1002h", b"\x1b[?1003h")
        ),
        "trueColor": b"38;2;" in data or b"48;2;" in data,
        "cjk": "中文".encode() in data,
        "emoji": "🐾".encode() in data,
    }


def fixture_flags(data: bytes) -> dict[str, bool]:
    tokens = {
        "terminalQueriesAnswered": b"TUNARA_UNKNOWN_QUERY_RESPONSES:complete",
        "highOutputComplete": b"TUNARA_UNKNOWN_HIGH_OUTPUT:complete",
        "waitingVisible": b"TUNARA_UNKNOWN_WAITING_CONFIRMATION:visible",
        "failureVisible": b"TUNARA_UNKNOWN_FAILURE:recoverable",
        "resumeVisible": b"TUNARA_UNKNOWN_RESUME:ready",
        "resizeObserved": b"TUNARA_UNKNOWN_RESIZE:40x120",
        "interruptObserved": b"TUNARA_UNKNOWN_EXIT:interrupt",
    }
    return {key: token in data for key, token in tokens.items()}


def summarize_entry(root: Path, scope: str, agent: str) -> dict[str, object]:
    base = root / scope / agent
    unavailable = base.with_suffix(".unavailable")
    version_path = base.with_suffix(".version")
    log_path = base.with_suffix(".log")
    summary_path = base.with_suffix(".summary")
    if unavailable.exists():
        return {
            "available": False,
            "reason": read_text(unavailable),
        }

    data = log_path.read_bytes() if log_path.exists() else b""
    harness = parse_harness(summary_path)
    entry: dict[str, object] = {
        "available": log_path.exists(),
        "version": read_text(version_path) if version_path.exists() else None,
        "capturedBytes": len(data),
        "harness": harness,
        "protocol": protocol_flags(data),
        "startupPassed": bool(harness.get("saw_output") and harness.get("resize_sent")),
        "interruptExitObserved": bool(harness.get("exited_after_interrupt")),
        "inputProbe": {
            "sent": bool(harness.get("interaction_sent")),
            "multilineMarkersVisible": all(
                marker in data for marker in (b"TUNARA_MULTILINE_A", b"TUNARA_MULTILINE_B")
            ),
        },
        "exit": {
            "requestedMethod": {0: "interrupt", 1: "slash", 2: "eof"}.get(
                harness.get("exit_method_code"), "unknown"
            ),
            "completedAfter": {0: "none", 1: "slash", 2: "eof", 3: "interrupt"}.get(
                harness.get("exit_stage_code"), "unknown"
            ),
            "normalExitObserved": bool(harness.get("normal_exit_observed")),
        },
    }
    if agent == "unknown":
        fixture = fixture_flags(data)
        entry["fixture"] = fixture
        entry["contractPassed"] = bool(
            entry["startupPassed"]
            and all(entry["protocol"].values())
            and all(fixture.values())
        )
    return entry


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--commit", required=True)
    parser.add_argument("--target", default=None)
    parser.add_argument("--macos", required=True)
    args = parser.parse_args()

    matrix = {
        scope: {agent: summarize_entry(args.input, scope, agent) for agent in AGENTS}
        for scope in SCOPES
    }
    actual_agents = ("claude", "codex", "pi", "opencode", "aider")
    started = sum(
        bool(matrix[scope][agent].get("startupPassed"))
        for scope in SCOPES
        for agent in actual_agents
    )
    available = sum(
        bool(matrix[scope][agent].get("available"))
        for scope in SCOPES
        for agent in actual_agents
    )
    result = {
        "commit": args.commit,
        "capturedAt": datetime.now(timezone.utc).isoformat(),
        "macOS": args.macos,
        "sshTarget": args.target,
        "terminalIdentity": {"TERM": "xterm-256color", "COLORTERM": "truecolor"},
        "matrix": matrix,
        "summary": {
            "actualAgentEntriesAvailable": available,
            "actualAgentEntriesStartedAndResized": started,
            "unknownLocalContractPassed": bool(matrix["local"]["unknown"].get("contractPassed")),
            "unknownSshContractPassed": bool(matrix["ssh"]["unknown"].get("contractPassed")),
        },
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
