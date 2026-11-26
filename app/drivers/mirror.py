"""A read-only copy of a device on another hub — for UI work against real readings.

HUB_MIRROR_URL=http://127.0.0.1:28110 makes every configured device mirror the first device
of that hub's /api/state. Commands are refused: this exists so a development copy can never
reach the real unit.
"""
from __future__ import annotations

import asyncio
import json
import urllib.request
from typing import Any

from .base import Capability, Driver
from .haier_ac import DEFAULT_SPEC, build_capabilities


class MirrorAC(Driver):
    kind = "air_conditioner"
    simulated = True

    def __init__(self, device_id: str, url: str) -> None:
        super().__init__()
        self.id = device_id
        self.url = url.rstrip("/")
        self.name = "Mirror"
        self.spec = DEFAULT_SPEC
        self._caps: list[dict[str, Any]] | None = None

    def capabilities(self) -> list[Capability]:
        return build_capabilities(self.spec)

    def _fetch(self) -> dict[str, Any]:
        with urllib.request.urlopen(f"{self.url}/api/state", timeout=8) as res:  # noqa: S310 - dev only
            return json.loads(res.read())

    async def refresh(self) -> None:
        try:
            snap = await asyncio.get_running_loop().run_in_executor(None, self._fetch)
            src = snap["devices"][0]
        except Exception as exc:  # noqa: BLE001
            self._mark_bad("unreachable", f"mirror: {exc}")
            return
        self.name, self.room = src.get("name", self.name), src.get("room", "")
        self.state = dict(src.get("state") or {})
        self.parked = bool(src.get("parked"))
        self.parked_at = src.get("parked_at")
        if src.get("available"):
            self._mark_ok()
        else:
            self._mark_bad(src.get("status") or "unreachable", src.get("status_detail") or "")
        self.last_seen = src.get("last_seen")
        self.status_detail = self.status_detail or "mirrored"

    async def apply(self, command: dict[str, Any]) -> None:
        raise RuntimeError("this is a read-only mirror of another hub")
