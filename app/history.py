"""Temperature history: every good read, kept on disk so a redeploy does not wipe the chart.

One JSON line per sample in `<data dir>/history.jsonl`. Appending a line per poll is cheaper
and safer than rewriting a file, and a torn last line (power cut mid-write) is skipped on
load rather than costing the whole history. The file is compacted on load and whenever it
has grown to twice what the retention window needs.

A sample is taken at most once a minute per device: after a command the hub polls every two
seconds for a few seconds to confirm the write, and those confirmations are not history.
"""
from __future__ import annotations

import json
import os
import threading
import time
from typing import Any

#: How far back the file reaches. The UI offers 6 h / 24 h / 48 h; a little more is kept so a
#: 48 h window opened just after a restart is still full.
RETAIN_SECONDS = 72 * 3600
#: Minimum spacing between two samples of one device.
MIN_SPACING = 55.0


class History:
    def __init__(self, path: str, *, retain: float = RETAIN_SECONDS, spacing: float = MIN_SPACING,
                 now=time.time) -> None:
        self.path = path
        self.retain = retain
        self.spacing = spacing
        self.now = now
        self._lock = threading.Lock()
        self._rows: list[dict[str, Any]] = []
        self._last: dict[str, float] = {}
        self._load()

    # ---- persistence ----------------------------------------------------
    def _load(self) -> None:
        os.makedirs(os.path.dirname(self.path) or ".", exist_ok=True)
        rows: list[dict[str, Any]] = []
        try:
            with open(self.path, encoding="utf-8") as fh:
                for line in fh:
                    try:
                        row = json.loads(line)
                    except json.JSONDecodeError:
                        continue            # a torn line from a crash: skip it, keep the rest
                    if isinstance(row, dict) and isinstance(row.get("t"), (int, float)):
                        rows.append(row)
        except OSError:
            rows = []
        cutoff = self.now() - self.retain
        self._rows = sorted((r for r in rows if r["t"] >= cutoff), key=lambda r: r["t"])
        for r in self._rows:
            self._last[r.get("d", "")] = r["t"]
        self._rewrite()

    def _rewrite(self) -> None:
        tmp = f"{self.path}.tmp"
        with open(tmp, "w", encoding="utf-8") as fh:
            for r in self._rows:
                fh.write(json.dumps(r, separators=(",", ":")) + "\n")
        os.replace(tmp, self.path)

    # ---- writes ---------------------------------------------------------
    def record(self, device_id: str, state: dict[str, Any], *, force: bool = False) -> bool:
        """Keep one reading. Returns False when it was too soon after the previous one."""
        t = self.now()
        with self._lock:
            if not force and t - self._last.get(device_id, 0.0) < self.spacing:
                return False
            row = {
                "t": round(t, 1), "d": device_id,
                "in": _num(state.get("indoor_temperature")),
                "out": _num(state.get("outdoor_temperature")),
                "set": _num(state.get("target_temperature")),
                "on": bool(state.get("power")),
                "mode": state.get("mode"),
            }
            hum = _num(state.get("humidity", state.get("indoor_humidity")))
            if hum is not None:
                row["hum"] = hum
            self._rows.append(row)
            self._last[device_id] = t
            with open(self.path, "a", encoding="utf-8") as fh:
                fh.write(json.dumps(row, separators=(",", ":")) + "\n")
            cutoff = t - self.retain
            if self._rows and self._rows[0]["t"] < cutoff:
                self._rows = [r for r in self._rows if r["t"] >= cutoff]
                # Compact lazily: rewriting on every expiry would rewrite the file every poll.
                if len(self._rows) and os.path.getsize(self.path) > 2 * 120 * len(self._rows):
                    self._rewrite()
            return True

    # ---- reads ----------------------------------------------------------
    def series(self, device_id: str, hours: float) -> list[dict[str, Any]]:
        cutoff = self.now() - hours * 3600
        with self._lock:
            return [r for r in self._rows if r.get("d") == device_id and r["t"] >= cutoff]

    def on_since(self, device_id: str) -> float | None:
        """When the AC was last switched on, if it is on in the latest sample and the switch-on
        is inside the window this file keeps."""
        with self._lock:
            rows = [r for r in self._rows if r.get("d") == device_id]
        if not rows or not rows[-1].get("on"):
            return None
        since = None
        for r in reversed(rows):
            if not r.get("on"):
                break
            since = r
        return since["t"] if since and since is not rows[0] else None


def _num(v: Any) -> float | None:
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return round(f, 1) if f == f else None
