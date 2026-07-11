#!/usr/bin/env python3
"""Summarize Aider semantic stages and remove raw terminal snapshots."""

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
    "settings-output",
    "history-up",
    "history-down",
    "multiline",
    "multiline-cancel",
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


def prompt_has(screen: str, value: str) -> bool:
    return re.search(rf"^>\s*{re.escape(value)}\s*$", screen, re.MULTILINE) is not None


def prompt_values(screen: str) -> list[str]:
    return [match.strip() for match in re.findall(r"^>\s?(.*)$", screen, re.MULTILINE)]


def last_prompt_is(screen: str, value: str) -> bool:
    values = prompt_values(screen)
    return bool(values) and values[-1] == value


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
        "readyPromptVisible": "Aider v0.86.2" in stages["baseline"] and re.search(r"^>\s*$", stages["baseline"], re.MULTILINE) is not None,
        "slashMenuOpened": "/settings" in stages["slash-menu"] and "/exit" in stages["slash-menu"],
        "slashMenuFiltered": prompt_has(stages["slash-filter"], "/sett") and "/settings" in stages["slash-filter"] and "/exit" not in stages["slash-filter"],
        "slashMenuCancelled": last_prompt_is(stages["slash-cancel"], ""),
        "localSettingsExecuted": "Main model (openai/gpt-4o-mini)" in stages["settings-output"],
        "historyRestored": prompt_has(stages["history-up"], "/settings"),
        "historyReturnedToBlank": last_prompt_is(stages["history-down"], ""),
        "multilineAVisible": prompt_values(stages["multiline"])[-2:] == ["TUNARA_AIDER_SEMANTIC_A", "TUNARA_AIDER_SEMANTIC_B"],
        "multilineBVisible": "TUNARA_AIDER_SEMANTIC_B" in prompt_values(stages["multiline"]),
        "multilineCancelled": last_prompt_is(stages["multiline-cancel"], ""),
        "normalExitObserved": outcome.get("normal_exit") == 1,
    }
    payload = {
        "capturedAt": datetime.now(timezone.utc).isoformat(),
        "commit": args.commit,
        "target": args.target,
        "agent": "aider",
        "safety": {
            "modelPromptSubmitted": False,
            "historySeed": "local /settings command",
            "gitEnabled": False,
            "analyticsEnabled": False,
            "browserEnabled": False,
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
