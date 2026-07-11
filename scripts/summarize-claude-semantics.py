#!/usr/bin/env python3
"""Summarize staged Claude TUI output without retaining raw terminal logs."""

from __future__ import annotations

import argparse
import json
from datetime import datetime, timezone
from pathlib import Path


STAGES = (
    "baseline",
    "shift-tab-1",
    "shift-tab-2",
    "shift-tab-3",
    "slash-menu",
    "slash-down",
    "slash-up",
    "slash-cancel",
    "history",
    "history-cancel",
    "multiline",
    "multiline-cancel",
    "exit",
)


def contains(data: bytes, text: str) -> bool:
    return text.encode() in data


def load_stages(prefix: Path) -> dict[str, bytes]:
    result: dict[str, bytes] = {}
    for stage in STAGES:
        path = Path(f"{prefix}.{stage}.log")
        result[stage] = path.read_bytes()
    return result


def remove_stage_logs(prefix: Path) -> None:
    for stage in STAGES:
        Path(f"{prefix}.{stage}.log").unlink(missing_ok=True)


def summarize(stages: dict[str, bytes]) -> dict[str, bool]:
    slash_down = stages["slash-down"]
    slash_up = stages["slash-up"]
    return {
        "defaultModeVisibleAfterFirstShiftTab": contains(stages["shift-tab-1"], "? for shortcuts"),
        "acceptEditsVisibleAfterSecondShiftTab": contains(stages["shift-tab-2"], "accept edits on"),
        "planModeRestoredAfterThirdShiftTab": contains(stages["shift-tab-3"], "plan mode on"),
        "slashMenuOpened": contains(stages["slash-down"], "/add-dir") and contains(stages["slash-down"], "/agents"),
        "slashSelectionMovedDown": b"\x1b[38;5;153m/agents" in slash_down,
        "slashSelectionMovedUp": b"\x1b[38;5;153m/add-dir" in slash_up,
        "slashMenuCancelled": not contains(stages["slash-cancel"], "/add-dir") and contains(stages["slash-cancel"], "plan mode on"),
        "historySearchOpened": contains(stages["history"], "search ") and contains(stages["history"], "prompts:"),
        "historySearchCancelled": not contains(stages["history-cancel"], "prompts:") and contains(stages["history-cancel"], "plan mode on"),
        "multilineAVisible": contains(stages["multiline"], "TUNARA_CLAUDE_SEMANTIC_A"),
        "multilineBVisible": contains(stages["multiline"], "TUNARA_CLAUDE_SEMANTIC_B"),
        "multilineCancelled": not contains(stages["multiline-cancel"], "TUNARA_CLAUDE_SEMANTIC_A") and contains(stages["multiline-cancel"], "Press Ctrl-C again"),
        "normalExitObserved": contains(stages["exit"], "Connection to ") and contains(stages["exit"], " closed."),
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--prefix", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--commit", required=True)
    parser.add_argument("--target", required=True)
    args = parser.parse_args()

    checks = summarize(load_stages(args.prefix))
    remove_stage_logs(args.prefix)
    payload = {
        "capturedAt": datetime.now(timezone.utc).isoformat(),
        "commit": args.commit,
        "target": args.target,
        "agent": "claude",
        "safety": {
            "permissionMode": "plan",
            "modelPromptSubmitted": False,
            "rawLogsRetained": False,
        },
        "checks": checks,
        "passed": all(checks.values()),
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(payload, indent=2) + "\n")
    return 0 if payload["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
