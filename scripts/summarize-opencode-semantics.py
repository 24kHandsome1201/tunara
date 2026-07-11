#!/usr/bin/env python3
"""Summarize OpenCode semantic stages and remove raw terminal snapshots."""

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
    "multiline",
    "multiline-cancel",
    "history-failure",
    "history-up",
    "history-cancel",
)
ANSI = re.compile(r"\x1b\[[0-?]*[ -/]*[@-~]")


def text(path: Path) -> str:
    return ANSI.sub("", path.read_text(errors="ignore"))


def load_result(prefix: Path) -> dict[str, int]:
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

    outcome = load_result(args.prefix)
    if outcome.get("ready") != 1:
        cleanup(args.prefix)
        return 1
    stages = {stage: text(Path(f"{args.prefix}.{stage}.log")) for stage in STAGES}
    checks = {
        "readyPromptVisible": "1.17.18" in stages["baseline"] and "Ask anything" in stages["baseline"],
        "slashMenuOpened": "/agents" in stages["slash-menu"] and "/models" in stages["slash-menu"],
        "slashMenuFiltered": "/models" in stages["slash-filter"] and "/agents" not in stages["slash-filter"],
        "slashMenuCancelled": "/models" not in stages["slash-cancel"] and re.search(r"/mo\s*$", stages["slash-cancel"], re.MULTILINE) is None,
        "multilineAVisible": "TUNARA_OPENCODE_SEMANTIC_A" in stages["multiline"],
        "multilineBVisible": "TUNARA_OPENCODE_SEMANTIC_B" in stages["multiline"],
        "multilineCancelled": "TUNARA_OPENCODE_SEMANTIC_A" not in stages["multiline-cancel"] and "TUNARA_OPENCODE_SEMANTIC_B" not in stages["multiline-cancel"],
        "loopbackFailureObserved": "Unauthorized" in stages["history-failure"],
        "historyRestored": stages["history-up"].count("TUNARA_OPENCODE_HISTORY_SEED") >= 2,
        "historyCancelled": stages["history-cancel"].count("TUNARA_OPENCODE_HISTORY_SEED") == 1,
        "normalExitObserved": outcome.get("normal_exit") == 1,
    }
    payload = {
        "capturedAt": datetime.now(timezone.utc).isoformat(),
        "commit": args.commit,
        "target": args.target,
        "agent": "opencode",
        "safety": {
            "providerEndpoint": "loopback-only HTTP 401 stub",
            "externalModelReached": False,
            "toolsEnabled": False,
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
