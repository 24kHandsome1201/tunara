#!/usr/bin/env python3
"""Summarize tmux-rendered Codex TUI stages and delete raw snapshots."""

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
    "history",
    "history-cancel",
    "multiline",
    "multiline-cancel",
)
ANSI = re.compile(r"\x1b\[[0-?]*[ -/]*[@-~]")


def text(path: Path) -> str:
    return ANSI.sub("", path.read_text(errors="ignore"))


def has_menu_candidate(screen: str, command: str) -> bool:
    return re.search(rf"^\s{{2}}/{re.escape(command)}\s{{2,}}", screen, re.MULTILINE) is not None


def composer_contains(screen: str, value: str) -> bool:
    return re.search(rf"^[›>]\s+{re.escape(value)}\s*$", screen, re.MULTILINE) is not None


def load_result(prefix: Path) -> dict[str, int]:
    result: dict[str, int] = {}
    for item in Path(f"{prefix}.result").read_text().split():
        key, value = item.split("=", 1)
        result[key] = int(value)
    return result


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

    result = load_result(args.prefix)
    if result.get("ready") != 1:
        cleanup(args.prefix)
        return 1

    stages = {stage: text(Path(f"{args.prefix}.{stage}.log")) for stage in STAGES}
    checks = {
        "readyPromptVisible": "OpenAI Codex" in stages["baseline"],
        "slashMenuOpened": has_menu_candidate(stages["slash-menu"], "model") and has_menu_candidate(stages["slash-menu"], "permissions"),
        "slashMenuFiltered": composer_contains(stages["slash-filter"], "/perm") and has_menu_candidate(stages["slash-filter"], "permissions") and not has_menu_candidate(stages["slash-filter"], "model"),
        "slashMenuCancelled": not has_menu_candidate(stages["slash-cancel"], "permissions") and not composer_contains(stages["slash-cancel"], "/perm"),
        "historySearchOpened": "reverse-i-search:" in stages["history"],
        "historySearchCancelled": "reverse-i-search:" not in stages["history-cancel"],
        "multilineAVisible": "TUNARA_CODEX_SEMANTIC_A" in stages["multiline"],
        "multilineBVisible": "TUNARA_CODEX_SEMANTIC_B" in stages["multiline"],
        "multilineCancelled": "TUNARA_CODEX_SEMANTIC_A" not in stages["multiline-cancel"] and "TUNARA_CODEX_SEMANTIC_B" not in stages["multiline-cancel"],
        "normalExitObserved": result.get("normal_exit") == 1,
    }
    payload = {
        "capturedAt": datetime.now(timezone.utc).isoformat(),
        "commit": args.commit,
        "target": args.target,
        "agent": "codex",
        "safety": {
            "sandbox": "read-only",
            "approvalPolicy": "never",
            "hookTrustGranted": False,
            "hookTrustDeniedDuringProbe": result.get("trust_denied") == 1,
            "modelPromptSubmitted": False,
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
