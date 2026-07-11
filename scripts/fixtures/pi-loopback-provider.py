#!/usr/bin/env python3
"""Deterministic loopback-only Chat Completions server for Pi resume probes."""

from __future__ import annotations

import json
import sys
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path


FIRST_CONTEXT = "TUNARA_PI_CONTEXT_7412"
FIRST_MARKER = "TUNARA_PI_FIRST_OK"
RESUME_PROMPT = "TUNARA_PI_RESUME_REQUEST_8524"
RESUME_MARKER = "TUNARA_PI_RESUME_OK"


def write_json(path: Path, value: object) -> None:
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def sse_chunk(marker: str, finish_reason: str | None) -> bytes:
    payload = {
        "id": "chatcmpl-tunara-pi-probe",
        "object": "chat.completion.chunk",
        "created": 1,
        "model": "probe",
        "choices": [{
            "index": 0,
            "delta": {"role": "assistant", "content": marker} if marker else {},
            "finish_reason": finish_reason,
        }],
    }
    return f"data: {json.dumps(payload, separators=(',', ':'))}\n\n".encode()


def role_contains(messages: object, role: str, marker: str) -> bool:
    if not isinstance(messages, list):
        return False
    return any(
        isinstance(message, dict)
        and message.get("role") == role
        and marker in json.dumps(message.get("content", ""), ensure_ascii=False)
        for message in messages
    )


class Handler(BaseHTTPRequestHandler):
    server_version = "TunaraPiLoopback/1"

    def log_message(self, _format: str, *_args: object) -> None:
        return

    def send_json(self, status: int, payload: object) -> None:
        body = json.dumps(payload, separators=(",", ":")).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:  # noqa: N802
        if self.path.rstrip("/") != "/v1/models":
            self.send_json(404, {"error": "not_found"})
            return
        self.send_json(200, {"object": "list", "data": [{"id": "probe", "object": "model"}]})

    def do_POST(self) -> None:  # noqa: N802
        state_path: Path = self.server.state_path  # type: ignore[attr-defined]
        state: dict[str, object] = json.loads(state_path.read_text(encoding="utf-8"))
        state["allClientsLoopback"] = bool(state.get("allClientsLoopback", True)) and self.client_address[0] == "127.0.0.1"
        expected_token: str = self.server.auth_token  # type: ignore[attr-defined]
        if self.headers.get("Authorization") != f"Bearer {expected_token}":
            state["allRequestsAuthenticated"] = False
            state["authorizationFailures"] = int(state.get("authorizationFailures", 0)) + 1
            write_json(state_path, state)
            self.send_json(401, {"error": "unauthorized"})
            return
        if self.path.rstrip("/") != "/v1/chat/completions":
            state["unexpectedPath"] = self.path
            write_json(state_path, state)
            self.send_json(404, {"error": "not_found"})
            return

        length = int(self.headers.get("Content-Length", "0"))
        if length <= 0 or length > 2 * 1024 * 1024:
            state["invalidRequestSize"] = length
            write_json(state_path, state)
            self.send_json(400, {"error": "invalid_request_size"})
            return
        try:
            payload = json.loads(self.rfile.read(length))
        except (UnicodeDecodeError, json.JSONDecodeError):
            state["invalidJson"] = True
            write_json(state_path, state)
            self.send_json(400, {"error": "invalid_json"})
            return

        request_count = int(state.get("requestCount", 0)) + 1
        state["requestCount"] = request_count
        messages = payload.get("messages", [])
        first_context_seen = role_contains(messages, "user", FIRST_CONTEXT)
        first_assistant_replayed = role_contains(messages, "assistant", FIRST_MARKER)
        resume_prompt_seen = role_contains(messages, "user", RESUME_PROMPT)
        observations = state.get("observations", [])
        if not isinstance(observations, list):
            observations = []
        observations.append({
            "request": request_count,
            "messageCount": len(messages) if isinstance(messages, list) else 0,
            "firstContext": first_context_seen,
            "firstAssistantMarker": first_assistant_replayed,
            "resumePrompt": resume_prompt_seen,
        })
        state["observations"] = observations[-8:]
        marker = ""
        valid = False
        if first_context_seen and not resume_prompt_seen and not first_assistant_replayed:
            state["mainRequestCount"] = int(state.get("mainRequestCount", 0)) + 1
            valid = state["mainRequestCount"] == 1
            state["firstContextSeen"] = valid
            marker = FIRST_MARKER
        elif resume_prompt_seen:
            state["mainRequestCount"] = int(state.get("mainRequestCount", 0)) + 1
            state["resumeContextSeen"] = first_context_seen and state["mainRequestCount"] == 2
            state["firstAssistantMarkerReplayed"] = first_assistant_replayed
            valid = bool(state["resumeContextSeen"]) and first_assistant_replayed
            marker = RESUME_MARKER
        else:
            state["auxiliaryRequestCount"] = int(state.get("auxiliaryRequestCount", 0)) + 1
            valid = True
            marker = "Tunara Pi probe"

        write_json(state_path, state)
        if not valid:
            self.send_json(409, {"error": "resume_context_contract_failed"})
            return

        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        self.wfile.write(sse_chunk(marker, None))
        self.wfile.write(sse_chunk("", "stop"))
        self.wfile.write(b"data: [DONE]\n\n")
        self.wfile.flush()


def main() -> None:
    if len(sys.argv) != 4:
        raise SystemExit("usage: pi-loopback-provider.py STATE_PATH PORT_PATH AUTH_TOKEN")
    state_path = Path(sys.argv[1])
    port_path = Path(sys.argv[2])
    auth_token = sys.argv[3]
    write_json(state_path, {
        "requestCount": 0,
        "mainRequestCount": 0,
        "auxiliaryRequestCount": 0,
        "allClientsLoopback": True,
        "allRequestsAuthenticated": True,
        "authorizationFailures": 0,
        "firstContextSeen": False,
        "resumeContextSeen": False,
        "firstAssistantMarkerReplayed": False,
    })
    # Pi's probe requests are tiny and sequential processing keeps the on-disk
    # evidence updates deterministic without a shared-state race.
    server = HTTPServer(("127.0.0.1", 0), Handler)
    server.state_path = state_path  # type: ignore[attr-defined]
    server.auth_token = auth_token  # type: ignore[attr-defined]
    port_path.write_text(f"{server.server_address[1]}\n", encoding="utf-8")
    server.serve_forever()


if __name__ == "__main__":
    main()
