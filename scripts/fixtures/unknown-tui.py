#!/usr/bin/env python3
"""Deterministic unrecognised-TUI fixture for terminal compatibility smokes."""

from __future__ import annotations

import os
import signal
import sys
import time


ALT_SCREEN_ENTER = "\x1b[?1049h"
ALT_SCREEN_LEAVE = "\x1b[?1049l"
BRACKETED_PASTE_ENTER = "\x1b[?2004h"
BRACKETED_PASTE_LEAVE = "\x1b[?2004l"
FOCUS_REPORTING_ENTER = "\x1b[?1004h"
FOCUS_REPORTING_LEAVE = "\x1b[?1004l"
MOUSE_TRACKING_ENTER = "\x1b[?1000h\x1b[?1006h"
MOUSE_TRACKING_LEAVE = "\x1b[?1006l\x1b[?1000l"


def write(value: str) -> None:
    os.write(sys.stdout.fileno(), value.encode("utf-8"))


def geometry() -> str:
    size = os.get_terminal_size(sys.stdout.fileno())
    return f"{size.lines}x{size.columns}"


def restore_terminal() -> None:
    write(
        MOUSE_TRACKING_LEAVE
        + FOCUS_REPORTING_LEAVE
        + BRACKETED_PASTE_LEAVE
        + ALT_SCREEN_LEAVE
    )


def on_resize(_signum: int, _frame: object) -> None:
    write(f"\r\nTUNARA_UNKNOWN_RESIZE:{geometry()}\r\n")


def on_interrupt(_signum: int, _frame: object) -> None:
    write("\r\nTUNARA_UNKNOWN_EXIT:interrupt\r\n")
    restore_terminal()
    raise SystemExit(0)


signal.signal(signal.SIGWINCH, on_resize)
signal.signal(signal.SIGTERM, on_interrupt)

write(
    ALT_SCREEN_ENTER
    + BRACKETED_PASTE_ENTER
    + FOCUS_REPORTING_ENTER
    + MOUSE_TRACKING_ENTER
    + "\x1b[2J\x1b[H"
)
write(f"TUNARA_UNKNOWN_START:{geometry()}\r\n")
write("TUNARA_UNKNOWN_TOOL_CALL:running\r\n")
for index in range(256):
    write(f"TUNARA_UNKNOWN_OUTPUT:{index:03d}:中文:🐾:\x1b[38;2;198;93;59mcolor\x1b[0m\r\n")
write("TUNARA_UNKNOWN_HIGH_OUTPUT:complete\r\n")
write("TUNARA_UNKNOWN_WAITING_CONFIRMATION:visible\r\n")
write("TUNARA_UNKNOWN_FAILURE:recoverable\r\n")
write("TUNARA_UNKNOWN_RESUME:ready\r\n")

try:
    while True:
        time.sleep(1)
except KeyboardInterrupt:
    write("\r\nTUNARA_UNKNOWN_EXIT:interrupt\r\n")
    restore_terminal()
