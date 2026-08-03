#!/usr/bin/env python3
"""
File watcher + long-poll server for Chrome extension auto-reload.

Compatible with https://github.com/wader/crxreload (same URL / behavior):
  GET http://localhost:8080/crxreload-request  → holds until a watched file changes

Usage (from extension root):
  python3 dev/watch.py

Then load/reload the extension once in chrome://extensions.
Edit any .js/.css/.html/.json and the extension reloads itself.
"""
from __future__ import annotations

import http.server
import os
import re
import sys
import threading
import time
from pathlib import Path

HOST = "127.0.0.1"
PORT = 8080
POLL_PATH = "/crxreload-request"
WATCH_RE = re.compile(r"\.(json|js|html|htm|css|png|jpe?g|svg|md)$", re.I)
SKIP_DIRS = {".git", "node_modules", "dev", "__pycache__", ".grok"}

root = Path(__file__).resolve().parent.parent
os.chdir(root)

_lock = threading.Lock()
_waiters: list[threading.Event] = []
_mtimes: dict[str, float] = {}


def list_files() -> list[Path]:
    out: list[Path] = []
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS and not d.startswith(".")]
        for name in filenames:
            p = Path(dirpath) / name
            if WATCH_RE.search(name):
                out.append(p)
    return out


def snapshot() -> dict[str, float]:
    snap: dict[str, float] = {}
    for p in list_files():
        try:
            snap[str(p)] = p.stat().st_mtime
        except OSError:
            pass
    return snap


def notify():
    with _lock:
        waiters = list(_waiters)
        _waiters.clear()
    for ev in waiters:
        ev.set()


def watch_loop():
    global _mtimes
    _mtimes = snapshot()
    print(f"[crxreload] watching {len(_mtimes)} files under {root}")
    for p in sorted(_mtimes)[:12]:
        print(f"  · {Path(p).relative_to(root)}")
    if len(_mtimes) > 12:
        print(f"  … +{len(_mtimes) - 12} more")
    print(f"[crxreload] long-poll http://{HOST}:{PORT}{POLL_PATH}")
    print("[crxreload] load the extension, then save a file to reload")

    while True:
        time.sleep(0.35)
        cur = snapshot()
        changed = False
        if set(cur) != set(_mtimes):
            changed = True
        else:
            for k, m in cur.items():
                if _mtimes.get(k) != m:
                    changed = True
                    break
        if changed:
            for k, m in cur.items():
                if _mtimes.get(k) != m:
                    try:
                        rel = Path(k).relative_to(root)
                    except ValueError:
                        rel = k
                    print(f"[crxreload] change: {rel}")
            _mtimes = cur
            print("[crxreload] telling extension to reload")
            notify()


class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        # Quiet default access log; we print our own events.
        pass

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.end_headers()

    def do_GET(self):
        path = self.path.split("?", 1)[0]
        if path != POLL_PATH:
            self.send_error(404, "use /crxreload-request")
            return

        print("[crxreload] extension connected")
        ev = threading.Event()
        with _lock:
            _waiters.append(ev)

        # Hold until file change (or client disconnect ~ long timeout).
        ev.wait(timeout=3600)

        try:
            self.send_response(200)
            self.send_header("Content-Type", "text/plain")
            self.send_header("Cache-Control", "no-store")
            self._cors()
            self.end_headers()
            self.wfile.write(b"reload\n")
        except BrokenPipeError:
            pass

    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS")


def main():
    t = threading.Thread(target=watch_loop, daemon=True)
    t.start()
    server = http.server.ThreadingHTTPServer((HOST, PORT), Handler)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n[crxreload] stopped")
        return 0
    return 0


if __name__ == "__main__":
    sys.exit(main() or 0)
