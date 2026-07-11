#!/usr/bin/env python3
"""Summarize staged Claude TUI output without retaining raw terminal logs."""

from __future__ import annotations

import argparse
import json
import re
from datetime import datetime, timezone
from pathlib import Path


STAGES = (
    "baseline",
    "shift-tab-1",
    "shift-tab-2",
    "shift-tab-3",
    "shift-tab-4",
    "slash-menu",
    "slash-filter",
    "slash-filter-clear",
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


CSI = re.compile(rb"\x1b\[[0-?]*[ -/]*[@-~]")
OSC = re.compile(rb"\x1b\].*?(?:\x07|\x1b\\)", re.DOTALL)


def visible_text(data: bytes) -> str:
    without_osc = OSC.sub(b" ", data)
    without_csi = CSI.sub(b" ", without_osc)
    return " ".join(without_csi.decode("utf-8", errors="ignore").lower().split())


def menu_commands(data: bytes) -> set[str]:
    cursor_positioned = {
        match.group(1).decode()
        for match in re.finditer(rb"/([a-z][a-z-]+)\x1b\[[0-9;]*G", data)
    }
    space_aligned = {
        match.group(1).decode()
        for match in re.finditer(rb"/([a-z][a-z-]+) {2,}", data)
    }
    return cursor_positioned | space_aligned


def load_stages(prefix: Path) -> dict[str, bytes]:
    result: dict[str, bytes] = {}
    for stage in STAGES:
        path = Path(f"{prefix}.{stage}.log")
        result[stage] = path.read_bytes()
    return result


def remove_stage_logs(prefix: Path) -> None:
    for stage in STAGES:
        Path(f"{prefix}.{stage}.log").unlink(missing_ok=True)
    Path(f"{prefix}.result").unlink(missing_ok=True)


def load_result(prefix: Path) -> dict[str, int]:
    pairs: dict[str, int] = {}
    for item in Path(f"{prefix}.result").read_text().split():
        key, value = item.split("=", 1)
        pairs[key] = int(value)
    return pairs


def summarize(stages: dict[str, bytes], result: dict[str, int], menu_filter: str) -> dict[str, bool]:
    texts = {stage: visible_text(data) for stage, data in stages.items()}
    shifted = " ".join(texts[f"shift-tab-{index}"] for index in range(1, 5))
    slash_menu_commands = menu_commands(stages["slash-menu"])
    slash_filter_commands = menu_commands(stages["slash-filter"])
    slash_clear_commands = menu_commands(stages["slash-filter-clear"])
    selection_output = b"".join(stages[stage] for stage in ("slash-down", "slash-up"))
    filter_applied = bool(slash_filter_commands) and all(command.startswith(menu_filter) for command in slash_filter_commands)
    filter_cleared = slash_menu_commands.issubset(slash_clear_commands)
    selection_observed = len(selection_output) > 0
    return {
        "modeCycleChanged": any(label in shifted for label in ("auto mode", "accept edits", "? for shortcuts")),
        "acceptEditsVisible": "accept edits" in shifted,
        "planModeVisible": "plan mode" in texts["baseline"] or "plan mode" in shifted,
        "slashMenuOpened": len(slash_menu_commands) >= 2,
        "slashMenuFiltered": filter_applied,
        "slashFilterCleared": filter_cleared,
        "slashSelectionOutputObserved": selection_observed,
        "slashChoiceChanged": (filter_applied and filter_cleared) or selection_observed,
        "slashMenuCancelled": not (menu_commands(stages["slash-cancel"]) & (slash_menu_commands | slash_filter_commands)),
        "historySearchOpened": "search" in texts["history"] and "prompts" in texts["history"],
        "historySearchCancelled": "search prompts" not in texts["history-cancel"],
        "multilineAVisible": contains(stages["multiline"], "TUNARA_CLAUDE_SEMANTIC_A"),
        "multilineBVisible": contains(stages["multiline"], "TUNARA_CLAUDE_SEMANTIC_B"),
        "multilineCancelled": not contains(stages["multiline-cancel"], "TUNARA_CLAUDE_SEMANTIC_A") and "press ctrl-c" in texts["multiline-cancel"],
        "normalExitObserved": result.get("child_exited") == 1 and result.get("exit_status") == 0,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--prefix", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--commit", required=True)
    parser.add_argument("--target", required=True)
    parser.add_argument("--menu-filter", default="a")
    args = parser.parse_args()

    if len(args.menu_filter) != 1 or not args.menu_filter.isascii() or not args.menu_filter.isalpha():
        parser.error("--menu-filter must be one ASCII letter")
    checks = summarize(load_stages(args.prefix), load_result(args.prefix), args.menu_filter.lower())
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
        "passed": all(
            value
            for key, value in checks.items()
            if key not in {"slashMenuFiltered", "slashFilterCleared", "slashSelectionOutputObserved"}
        ),
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(payload, indent=2) + "\n")
    return 0 if payload["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
