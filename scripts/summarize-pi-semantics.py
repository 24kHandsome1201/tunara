#!/usr/bin/env python3
"""Summarize tmux-rendered Pi TUI stages and remove raw snapshots."""

from __future__ import annotations

import argparse
import json
import re
from datetime import datetime, timezone
from pathlib import Path


STAGES = (
    "baseline",
    "slash-menu",
    "slash-filter",
    "slash-cancel",
    "shell-busy",
    "shell-ready",
    "history-up",
    "history-down",
    "multiline",
    "multiline-cancel",
)
ANSI = re.compile(r"\x1b\[[0-?]*[ -/]*[@-~]")


def text(path: Path) -> str:
    return ANSI.sub("", path.read_text(errors="ignore"))


def result(prefix: Path) -> dict[str, int]:
    return {
        key: int(value)
        for key, value in (
            item.split("=", 1)
            for item in Path(f"{prefix}.result").read_text().split()
        )
    }


def cleanup(prefix: Path) -> None:
    for stage in (*STAGES, "startup-failure"):
        Path(f"{prefix}.{stage}.log").unlink(missing_ok=True)
    Path(f"{prefix}.result").unlink(missing_ok=True)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--prefix", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--commit", required=True)
    parser.add_argument("--target", required=True)
    args = parser.parse_args()

    outcome = result(args.prefix)
    if outcome.get("ready") != 1:
        cleanup(args.prefix)
        return 1
    stages = {stage: text(Path(f"{args.prefix}.{stage}.log")) for stage in STAGES}
    checks = {
        "readyPromptVisible": "pi v0.79.4" in stages["baseline"],
        "slashMenuOpened": "Open settings menu" in stages["slash-menu"] and "Select model" in stages["slash-menu"],
        "slashMenuFiltered": re.search(r"^/mod\s*$", stages["slash-filter"], re.MULTILINE) is not None and "Select model" in stages["slash-filter"] and "Open settings menu" not in stages["slash-filter"],
        "slashMenuCancelled": "Select model" not in stages["slash-cancel"] and re.search(r"^/mod$", stages["slash-cancel"], re.MULTILINE) is None,
        "shellBusyVisible": "Running... (escape/ctrl+c to cancel)" in stages["shell-busy"],
        "shellReturnedToReady": "Running... (escape/ctrl+c to cancel)" not in stages["shell-ready"] and re.search(r"\(auto\).*unknown", stages["shell-ready"]) is not None,
        "historyRestored": "!!printf TUNARA_PI_HISTORY_SEED" in stages["history-up"],
        "historyReturnedToBlank": "!!printf TUNARA_PI_HISTORY_SEED" not in stages["history-down"],
        "multilineAVisible": "TUNARA_PI_SEMANTIC_A" in stages["multiline"],
        "multilineBVisible": "TUNARA_PI_SEMANTIC_B" in stages["multiline"],
        "multilineCancelled": "TUNARA_PI_SEMANTIC_A" not in stages["multiline-cancel"] and "TUNARA_PI_SEMANTIC_B" not in stages["multiline-cancel"],
        "normalExitObserved": outcome.get("normal_exit") == 1,
    }
    payload = {
        "capturedAt": datetime.now(timezone.utc).isoformat(),
        "commit": args.commit,
        "target": args.target,
        "agent": "pi",
        "safety": {
            "modelPromptSubmitted": False,
            "historySeed": "double-bang shell command excluded from model context",
            "busyProbe": "double-bang sleep excluded from model context",
            "rawLogsRetained": False,
        },
        "checks": checks,
        "passed": all(checks.values()),
    }
    cleanup(args.prefix)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(payload, indent=2) + "\n")
    return 0 if payload["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
