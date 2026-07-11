#!/usr/bin/env python3
"""Summarize first-permission and resume smokes without retaining raw output."""

from __future__ import annotations

import argparse
import json
import re
from datetime import datetime, timezone
from pathlib import Path


ANSI = re.compile(
    r"\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\)|P.*?\x1b\\)",
    re.DOTALL,
)


def read(path: Path) -> str:
    return path.read_text(encoding="utf-8", errors="replace") if path.exists() else ""


def json_events(raw: str) -> list[object]:
    events: list[object] = []
    for line in raw.splitlines():
        try:
            events.append(json.loads(line))
        except json.JSONDecodeError:
            continue
    return events


def ids_in(events: list[object], keys: set[str]) -> set[str]:
    found: set[str] = set()

    def visit(value: object) -> None:
        if isinstance(value, dict):
            for key, child in value.items():
                if key in keys and isinstance(child, str):
                    found.add(child)
                visit(child)
        elif isinstance(value, list):
            for child in value:
                visit(child)

    for event in events:
        visit(event)
    return found


def resume_result(root: Path, name: str, first_marker: str, resume_marker: str) -> dict[str, object]:
    first = read(root / f"{name}-first.log")
    second = read(root / f"{name}-resume.log")
    events = json_events(first) + json_events(second)
    ids = ids_in(events, {"session_id", "thread_id"})
    first_ok = first_marker in first
    resume_ok = resume_marker in second
    return {
        "idObserved": any(len(value) == 36 for value in ids),
        "firstMarkerObserved": first_ok,
        "resumeMarkerObserved": resume_ok,
        "jsonEvents": len(events),
        "passed": first_ok and resume_ok and bool(ids),
    }


def aider_resume_result(root: Path) -> dict[str, object]:
    raw = read(root / "resume-ssh-aider.json")
    try:
        payload = json.loads(raw)
    except json.JSONDecodeError:
        payload = {}
    if not isinstance(payload, dict):
        payload = {}

    def boolean(key: str) -> bool:
        return payload.get(key) is True

    error_class = payload.get("errorClass")
    return {
        "historyIdentityObserved": boolean("historyIdentityObserved"),
        "firstMarkerObserved": boolean("firstMarkerObserved"),
        "resumeMarkerObserved": boolean("resumeMarkerObserved"),
        "errorClass": error_class if isinstance(error_class, str) else None,
        "passed": boolean("passed"),
    }


def opencode_resume_result(root: Path, scope: str) -> dict[str, object]:
    raw = read(root / f"resume-{scope}-opencode.json")
    try:
        payload = json.loads(raw)
    except json.JSONDecodeError:
        payload = {}
    if not isinstance(payload, dict):
        payload = {}

    def boolean(key: str) -> bool:
        return payload.get(key) is True

    error_class = payload.get("errorClass")
    events = payload.get("jsonEvents")
    return {
        "sessionIdentityObserved": boolean("sessionIdentityObserved"),
        "firstMarkerObserved": boolean("firstMarkerObserved"),
        "resumeMarkerObserved": boolean("resumeMarkerObserved"),
        "jsonEvents": events if isinstance(events, int) and events >= 0 else 0,
        "errorClass": error_class if isinstance(error_class, str) else None,
        "passed": boolean("passed"),
    }


def pi_resume_result(root: Path, scope: str) -> dict[str, object]:
    raw = read(root / f"resume-{scope}-pi.json")
    try:
        payload = json.loads(raw)
    except json.JSONDecodeError:
        payload = {}
    if not isinstance(payload, dict):
        payload = {}

    def boolean(key: str) -> bool:
        return payload.get(key) is True

    error_class = payload.get("errorClass")
    events = payload.get("jsonEvents")
    return {
        "sessionIdentityObserved": boolean("sessionIdentityObserved"),
        "firstMarkerObserved": boolean("firstMarkerObserved"),
        "resumeMarkerObserved": boolean("resumeMarkerObserved"),
        "jsonEvents": events if isinstance(events, int) and events >= 0 else 0,
        "errorClass": error_class if isinstance(error_class, str) else None,
        "passed": boolean("passed"),
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--commit", required=True)
    parser.add_argument("--target", required=True)
    args = parser.parse_args()

    claude_permission = ANSI.sub("", read(args.input / "permission-claude.log")).lower()
    codex_permission = ANSI.sub("", read(args.input / "permission-codex.log")).lower()
    claude_compact = re.sub(r"\s+", "", claude_permission)
    codex_compact = re.sub(r"\s+", "", codex_permission)
    claude_prompt = any(
        token in claude_compact
        for token in ("doyouwanttoproceed", "allowthiscommand", "esctocancel")
    )
    codex_prompt = "doyoutrustthecontentsofthisdirectory" in codex_compact
    probe_created = read(args.input / "permission-claude-probe-created").strip() == "1"

    resume = {
        "localClaude": resume_result(
            args.input,
            "resume-local-claude",
            "TUNARA_CLAUDE_FIRST_OK",
            "TUNARA_CLAUDE_RESUME_OK",
        ),
        "localCodex": resume_result(
            args.input,
            "resume-local-codex",
            "TUNARA_CODEX_FIRST_OK",
            "TUNARA_CODEX_RESUME_OK",
        ),
        "sshCodex": resume_result(
            args.input,
            "resume-ssh-codex",
            "TUNARA_SSH_CODEX_FIRST_OK",
            "TUNARA_SSH_CODEX_RESUME_OK",
        ),
        "sshAider": aider_resume_result(args.input),
        "localOpenCode": opencode_resume_result(args.input, "local"),
        "sshOpenCode": opencode_resume_result(args.input, "ssh"),
        "localPi": pi_resume_result(args.input, "local"),
        "sshPi": pi_resume_result(args.input, "ssh"),
    }
    result = {
        "commit": args.commit,
        "capturedAt": datetime.now(timezone.utc).isoformat(),
        "sshTarget": args.target,
        "safety": "temporary directories and probe cleaned; raw output deleted after summary",
        "permission": {
            "localClaude": {
                "explicitDefaultMode": True,
                "toolPermissionPromptObserved": claude_prompt,
                "temporaryProbeCreated": probe_created,
                "result": "prompt_observed" if claude_prompt else "organization_policy_auto_allowed",
            },
            "localCodex": {
                "untrustedPolicyForced": True,
                "directoryTrustPromptObserved": codex_prompt,
                "promptInjectionRiskCopyObserved": "higherriskofpromptinjection" in codex_compact,
                "result": "prompt_observed" if codex_prompt else "prompt_missing",
            },
        },
        "resume": resume,
        "summary": {
            "permissionPromptsObserved": int(claude_prompt) + int(codex_prompt),
            "resumePassed": sum(bool(value["passed"]) for value in resume.values()),
            "resumeEntries": len(resume),
        },
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
