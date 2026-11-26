"""The device abstraction every driver implements.

The hub, the REST API and the UI only ever talk to this shape. Adding a light, a plug or
a sensor later means writing one more Driver subclass and registering it — no changes to
the API surface or the frontend's device rendering.
"""
from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import Any


@dataclass
class Capability:
    """One controllable or readable attribute, described well enough for the UI to render
    a control for it without knowing what a Haier AC is."""

    key: str
    label: str
    # switch | enum | range | readout | action
    kind: str
    options: list[dict[str, str]] = field(default_factory=list)
    minimum: float | None = None
    maximum: float | None = None
    step: float | None = None
    unit: str = ""
    icon: str = ""
    # One line explaining what the control actually does, shown under it. For anything whose
    # name does not carry its meaning — "Eco 1/2/3" tells you nothing on its own.
    hint: str = ""
    # Attributes the UI should grey out when the device is off.
    needs_power: bool = False


class Driver:
    """Base class. Subclasses implement `refresh` and `apply`."""

    #: stable identifier, used in URLs and scene/automation action targets
    id: str = "device"
    #: human name
    name: str = "Device"
    #: device class — drives the icon and grouping in the UI
    kind: str = "generic"
    room: str = ""
    #: A device is only reported as down after this many failed reads in a row, spanning at
    #: least DOWN_SECONDS. One missed poll — the AC busy with the phone app's session, a Wi-Fi
    #: hiccup — is a blip, not an outage, and flagging it made the page cry wolf. The hub sets
    #: both from HUB_DOWN_CHECKS / HUB_DOWN_SECONDS.
    DOWN_CHECKS: int = 3
    DOWN_SECONDS: float = 180.0
    #: True when this device is a stand-in rather than real hardware. Reported to the UI so
    #: the status strip cannot claim "live" while a simulator is answering — the hub-level
    #: demo flag is not enough, since a missing key substitutes a simulator on its own.
    simulated: bool = False

    def __init__(self) -> None:
        self.state: dict[str, Any] = {}
        self.available: bool = False
        self.status: str = "unknown"       # ok | unconfigured | unreachable | error | parked
        #: Switched off at the wall (a fuse turned off for the season): not answering is
        #: expected, so it is not a fault. Set by the person (hub.park); cleared by itself
        #: the first time the unit answers again.
        self.parked: bool = False
        self.parked_at: float | None = None
        self.status_detail: str = ""
        self.last_seen: float | None = None
        self.last_error: str = ""
        #: Consecutive failed reads, and when the first of them happened.
        self.fail_streak: int = 0
        self.fail_since: float | None = None

    @property
    def down(self) -> bool:
        """Sustained failure: unavailable for DOWN_CHECKS reads AND DOWN_SECONDS."""
        if self.available or self.parked or self.fail_since is None:
            return False
        return (self.fail_streak >= self.DOWN_CHECKS
                and time.time() - self.fail_since >= self.DOWN_SECONDS)

    def note_read(self) -> None:
        """Called by the hub after every read attempt, to keep the failure streak."""
        if self.available:
            self.fail_streak = 0
            self.fail_since = None
        else:
            self.fail_streak += 1
            if self.fail_since is None:
                self.fail_since = time.time()

    # ---- introspection -------------------------------------------------
    def capabilities(self) -> list[Capability]:
        return []

    def describe(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "name": self.name,
            "kind": self.kind,
            "room": self.room,
            "simulated": self.simulated,
            "available": self.available,
            "status": "parked" if self.parked and not self.available else self.status,
            "status_detail": "switched off at the wall" if self.parked and not self.available else self.status_detail,
            "parked": self.parked,
            "parked_at": self.parked_at,
            "last_seen": self.last_seen,
            # The readings below are never live while the device is unavailable: either the
            # last good ones, or — if there has not been a good read since start — the
            # driver's init defaults. Both must be flagged, or the UI shows an invented
            # setpoint as though it came off the unit.
            "stale": not self.available,
            "last_error": self.last_error,
            # available=false on its own is one missed read; `down` is the sustained kind
            # (see DOWN_CHECKS). The UI and the summary only call a device unavailable on this.
            "down": self.down,
            "fail_streak": self.fail_streak,
            "fail_since": self.fail_since,
            "state": self.state,
            "capabilities": [
                {
                    "key": c.key, "label": c.label, "kind": c.kind, "options": c.options,
                    "min": c.minimum, "max": c.maximum, "step": c.step, "unit": c.unit,
                    "icon": c.icon, "hint": c.hint, "needs_power": c.needs_power,
                }
                for c in self.capabilities()
            ],
        }

    # ---- lifecycle -----------------------------------------------------
    async def refresh(self) -> None:
        """Pull current state from the device. Must set `available`/`status` and never raise."""
        raise NotImplementedError

    async def apply(self, command: dict[str, Any]) -> None:
        """Push a command. May raise — the caller turns it into a 4xx/5xx and an activity entry."""
        raise NotImplementedError

    # ---- helpers -------------------------------------------------------
    def _mark_ok(self) -> None:
        self.available = True
        self.status = "ok"
        self.status_detail = ""
        self.last_error = ""
        self.last_seen = time.time()

    def _mark_bad(self, status: str, detail: str) -> None:
        self.available = False
        self.status = status
        self.status_detail = detail
        self.last_error = detail
