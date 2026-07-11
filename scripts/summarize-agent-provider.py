#!/usr/bin/env python3
"""Summarize Agent provider probes without retaining raw provider output."""

from __future__ import annotations

import argparse
import json
from datetime import datetime, timezone
from pathlib import Path


MARKERS = {
    ("local", "claude"): "TUNARA_LOCAL_CLAUDE_TOOL_OK",
    ("local", "codex"): "TUNARA_LOCAL_CODEX_TOOL_OK",
    ("local", "pi"): "TUNARA_LOCAL_PI_OK",
    ("local", "opencode"): "TUNARA_LOCAL_OPENCODE_OK",
    ("local", "aider"): "TUNARA_LOCAL_AIDER_OK",
    ("ssh", "claude"): "TUNARA_SSH_CLAUDE_TOOL_OK",
    ("ssh", "codex"): "TUNARA_SSH_CODEX_TOOL_OK",
    ("ssh", "pi"): "TUNARA_SSH_PI_OK",
    ("ssh", "opencode"): "TUNARA_SSH_OPENCODE_OK",
    ("ssh", "aider"): "TUNARA_SSH_AIDER_OK",
}
TOOL_CASES = {("local", "claude"), ("local", "codex"), ("ssh", "claude"), ("ssh", "codex")}


def classify_error(raw: str, return_code: int) -> str | None:
    lowered = raw.lower()
    if return_code in {124, 137}:
        return "timeout"
    if "no api key" in lowered or (
        "api key" in lowered and any(word in lowered for word in ("missing", "not set", "provide"))
    ):
        return "missing_api_key"
    if any(token in lowered for token in ("usage limit", "insufficient", "quota", "2056")):
        return "usage_limit"
    if "401" in lowered or "unauthorized" in lowered:
        return "provider_401"
    if "402" in lowered or "benefits" in lowered:
        return "provider_402"
    if return_code != 0:
        return "nonzero"
    return None


def parse_json_events(raw: str) -> list[object]:
    events: list[object] = []
    for line in raw.splitlines():
        try:
            events.append(json.loads(line))
        except json.JSONDecodeError:
            continue
    return events


def summarize_case(root: Path, scope: str, agent: str) -> dict[str, object]:
    base = root / scope / agent
    raw = base.with_suffix(".log").read_text(encoding="utf-8", errors="replace")
    return_code = int(base.with_suffix(".rc").read_text().strip())
    events = parse_json_events(raw)
    serialized = json.dumps(events, ensure_ascii=False)
    tool_event = any(token in serialized for token in ("tool_use", "command_execution", "function_call"))
    marker = MARKERS[(scope, agent)] in raw
    error = classify_error(raw, return_code)
    completion = return_code == 0 and marker and error is None
    return {
        "returnCode": return_code,
        "capturedBytes": len(raw.encode()),
        "jsonEvents": len(events),
        "markerObserved": marker,
        "toolEventObserved": tool_event,
        "completionPassed": completion,
        "toolCallPassed": completion and tool_event if (scope, agent) in TOOL_CASES else None,
        "errorClass": error,
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--commit", required=True)
    parser.add_argument("--target", required=True)
    args = parser.parse_args()

    matrix = {
        scope: {
            agent: summarize_case(args.input, scope, agent)
            for agent in ("claude", "codex", "pi", "opencode", "aider")
        }
        for scope in ("local", "ssh")
    }
    entries = [entry for scope in matrix.values() for entry in scope.values()]
    result = {
        "commit": args.commit,
        "capturedAt": datetime.now(timezone.utc).isoformat(),
        "sshTarget": args.target,
        "safety": "read-only probes; raw output deleted after redacted summary",
        "matrix": matrix,
        "summary": {
            "entries": len(entries),
            "completionPassed": sum(bool(entry["completionPassed"]) for entry in entries),
            "toolCallPassed": sum(entry["toolCallPassed"] is True for entry in entries),
            "blockedOrFailed": sum(entry["errorClass"] is not None for entry in entries),
        },
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
