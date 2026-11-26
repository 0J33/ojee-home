"""HTTP surface for the home hub — REST for actions, SSE for live state."""
from __future__ import annotations

import asyncio
import json
import time
from contextlib import asynccontextmanager
from typing import Any

from fastapi import Body, FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles

from .config import SETTINGS
from .hub import HUB


@asynccontextmanager
async def lifespan(_: FastAPI):
    # Serving starts at once: the first poll runs in the background loop (HUB.start polls first
    # thing). Waiting on it here kept the whole hub unreachable whenever a device was not
    # answering, an AC switched off at the wall for the winter above all: its read times out and
    # then the subnet is scanned for it before giving up.
    await HUB.start()
    yield
    await HUB.stop()


app = FastAPI(title="ojee home", version="1.0.0", lifespan=lifespan)


@app.middleware("http")
async def revalidate_assets(request, call_next):
    """Force the app shell to revalidate.

    Without this the browser serves a cached app.css/app.js after a redeploy and the new
    build is silently invisible — which cost a real debugging detour during development.
    ETags still make the revalidation a cheap 304.
    """
    response = await call_next(request)
    path = request.url.path
    if path == "/" or path.endswith((".html", ".css", ".js", ".svg")):
        response.headers["Cache-Control"] = "no-cache, must-revalidate"
    return response


# ---- state ---------------------------------------------------------------
@app.get("/api/state")
async def get_state() -> dict[str, Any]:
    return HUB.snapshot()


@app.get("/api/health")
async def health() -> dict[str, Any]:
    devices = HUB.snapshot()["devices"]
    return {
        "ok": True,
        "devices": len(devices),
        "online": sum(1 for d in devices if d["available"]),
        "uptime": time.time() - HUB.started_at,
    }


ALERT_KINDS: list[dict[str, Any]] = [
    {"kind": "home.ac-fault", "label": "AC reports a fault code",
     "description": "The unit itself reports an error code (E-code). Raised once it has held for two reads.",
     "severity": "err", "channel": "inbox", "holdChecks": 2, "clearMin": 5},
    {"kind": "home.ac-unavailable", "label": "AC not answering",
     "description": "No good read for 3 polls spanning 3 minutes. Off at the wall is not a fault and never raises it.",
     "severity": "warn", "channel": "inbox", "holdChecks": 3, "clearMin": 5,
     "threshold": {"key": "minutes", "label": "Not answering for", "unit": "min", "default": 3}},
]

# The same kinds in the console's documented shape (README "Notifications"): every kind shows
# in Settings → Notifications; the shell holds/clears summary alerts by `hold` / `clearMin`
# and POSTs the person's params back to /api/notify/prefs.
NOTIFICATIONS: list[dict[str, Any]] = [
    {"id": "home.ac-fault", "label": "AC reports a fault code",
     "description": "The unit itself reports an error code (E-code).",
     "severity": "critical", "blocking": False, "channel": "inbox", "discord": False,
     "hold": 2, "clearMin": 5, "params": [], "view": "overview", "source": "alerts"},
    {"id": "home.ac-unavailable", "label": "AC not answering",
     "description": "No good read for several polls in a row. Off at the wall never raises it.",
     "severity": "warn", "blocking": False, "channel": "inbox", "discord": False,
     "hold": 2, "clearMin": 5,
     "params": [{"key": "minutes", "label": "Not answering for", "type": "number", "unit": "min",
                 "default": 3, "min": 1, "max": 120}],
     "view": "overview", "source": "alerts"},
]


@app.post("/api/notify/prefs")
async def notify_prefs(body: dict[str, Any] = Body(...)) -> dict[str, Any]:
    """The console's effective settings per kind; this module applies the thresholds."""
    types = body.get("types") if isinstance(body, dict) else None
    if not isinstance(types, dict):
        raise HTTPException(400, "types is required")
    params = ((types.get("home.ac-unavailable") or {}).get("params") or {})
    minutes = params.get("minutes")
    try:
        if minutes is not None:
            from .drivers.base import Driver
            Driver.DOWN_SECONDS = max(60.0, min(7200.0, float(minutes) * 60))
    except (TypeError, ValueError):
        raise HTTPException(400, "minutes must be a number") from None
    return {"ok": True}


_MODE_LABEL = {"cool": "Cool", "heat": "Heat", "dry": "Dry", "fan": "Fan", "fan_only": "Fan", "auto": "Auto"}


def _fmt(v: Any, dp: int = 1) -> str | None:
    if v is None:
        return None
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return f"{f:.{dp}f}" if dp else f"{round(f)}"


def _alerts(devices: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Alerts with stable keys: the console matches them across polls by key, so a changing
    number in the text updates the same item instead of raising a new one."""
    out: list[dict[str, Any]] = []
    for d in devices:
        code = (d.get("state") or {}).get("error_code") or 0
        if d["available"] and code:
            out.append({"key": d["id"], "kind": "home.ac-fault",
                        "severity": "err", "view": "overview",
                        "text": f"{d['name']} reports fault E{code}",
                        "detail": "Error code from the unit itself; see the manual or the Haier app.",
                        # back-compat for consoles that only read `notify`
                        "notify": "home.ac-fault"})
        if d.get("down") and not d.get("parked"):
            mins = max(1, round((time.time() - (d.get("fail_since") or time.time())) / 60))
            out.append({"key": d["id"], "kind": "home.ac-unavailable",
                        "severity": "warn", "view": "overview",
                        "text": f"{d['name']} not answering for {mins} min",
                        "detail": d.get("status_detail") or d.get("last_error") or "",
                        "notify": "home.ac-unavailable"})
    return out


@app.get("/api/summary")
async def summary() -> dict[str, Any]:
    """This hub from outside, for the console's overview row and inbox.

    Four numbers (AC, indoor, outdoor coil, humidity or the phone), a 6 h indoor sparkline,
    and alerts with stable keys. A device that missed one read is not reported as anything:
    only a sustained failure (`down`) or a fault code from the unit is news. Off at the wall
    (parked) is how a unit spends the winter and says so without alarming.
    """
    snap = HUB.snapshot()
    devices = snap["devices"]
    presence = snap.get("presence") or {}
    lead = next((d for d in devices if d["state"].get("indoor_temperature") is not None
                 and not d.get("down")), devices[0] if devices else None)
    alerts = _alerts(devices)
    st = (lead or {}).get("state") or {}
    live = bool(lead and lead["available"])
    parked = bool(lead and lead.get("parked") and not lead["available"])
    down = bool(lead and lead.get("down"))
    on = bool(st.get("power")) and live
    mode = _MODE_LABEL.get(str(st.get("mode") or ""), str(st.get("mode") or "").title())

    ac_value = ("Off at wall" if parked else "Not answering" if down
                else f"{mode} {_fmt(st.get('target_temperature'), 0)}°" if on else "Off")
    hum = st.get("humidity", st.get("indoor_humidity"))
    metrics = [
        {"label": "AC", "value": ac_value, "unit": "",
         "state": "warn" if down else ("ok" if on else None),
         "status": "warn" if down else ("ok" if on else None)},
        {"label": "Indoor", "value": _fmt(st.get("indoor_temperature")) or "—", "unit": "°C",
         **({"stale": True} if not live else {})},
        {"label": "Outdoor coil", "value": _fmt(st.get("outdoor_temperature"), 0) or "—", "unit": "°C",
         **({"stale": True} if not live else {})},
        ({"label": "Humidity", "value": _fmt(hum, 0), "unit": "%"} if hum is not None else
         {"label": "Phone", "value": (presence.get("zone_name") if presence.get("zone_name") not in (None, "unknown")
                    else "Away" if presence.get("last_fix") else "—"),
          "unit": ""}),
    ]

    spark = None
    if lead:
        rows = HUB.history.series(lead["id"], 6)
        # 72 five-minute buckets: a sparkline has ~120 px to draw in, and a missing
        # bucket stays a gap (None) rather than being bridged.
        t_end = time.time()
        buckets: list[list[float]] = [[] for _ in range(72)]
        for r in rows:
            i = int((r["t"] - (t_end - 6 * 3600)) // 300)
            if 0 <= i < 72 and r.get("in") is not None:
                buckets[i].append(r["in"])
        vals = [round(sum(b) / len(b), 2) if b else None for b in buckets]
        nums = [v for v in vals if v is not None]
        since = HUB.history.on_since(lead["id"])
        stat = ""
        if since and nums:
            start = next((r.get("in") for r in rows if r["t"] >= since and r.get("in") is not None), None)
            if start is not None:
                stat = f"{nums[-1] - start:+.1f}° since on"
        elif nums:
            stat = f"{min(nums):.1f}–{max(nums):.1f}°"
        # `points`/`cap`/`status` are the console's names; `values`/`stat` kept as aliases.
        spark = {"label": "Indoor °C · 6h", "points": vals, "values": vals, "cap": stat, "stat": stat,
                 "threshold": st.get("target_temperature") if on else None, "unit": "°C",
                 "status": "warn" if down else None}

    if alerts:
        headline = alerts[0]["text"]
    elif parked:
        headline = f"{lead['name']} off at the wall"
    elif on:
        headline = f"{mode} to {_fmt(st.get('target_temperature'), 0)}° · {_fmt(st.get('indoor_temperature'))}° inside"
    elif lead and live:
        headline = f"AC off · {_fmt(st.get('indoor_temperature'))}° inside"
    elif lead and lead.get("status") != "unknown":
        headline = f"{lead['name']} retrying"
    elif devices:
        headline = "AC checking…"
    else:
        headline = "no devices configured"

    facts = [{"k": m["label"], "v": f"{m['value']}{m.get('unit') or ''}"} for m in metrics]
    return {
        "status": "err" if any(a["severity"] == "err" for a in alerts) else "warn" if alerts else "ok",
        "headline": headline,
        "facts": facts,
        "metrics": metrics,
        "spark": spark,
        "alerts": alerts,
        # Quick-action state for the console's overview: the AC's power, and each scene
        # (label + when it last ran). Ids match the manifest's quickActions.
        "quick": {"ac-power": {"on": on}, **_scene_quick()},
    }


@app.get("/api/history")
async def history(hours: float = 24, device: str | None = None) -> dict[str, Any]:
    """Temperature samples for the chart: one row per good read, at most one a minute."""
    hours = max(0.5, min(float(hours), 72.0))
    dev = device or next(iter(HUB.devices), None)
    if dev is None or dev not in HUB.devices:
        raise HTTPException(404, "no such device")
    rows = HUB.history.series(dev, hours)
    return {"device": dev, "hours": hours, "poll_seconds": SETTINGS.poll_seconds,
            "on_since": HUB.history.on_since(dev),
            "points": [[r["t"], r.get("in"), r.get("out"), r.get("set"), 1 if r.get("on") else 0,
                        r.get("hum")] for r in rows]}


# ---- devices -------------------------------------------------------------
@app.get("/api/devices")
async def list_devices() -> list[dict[str, Any]]:
    return [d.describe() for d in HUB.devices.values()]


@app.get("/api/devices/{device_id}")
async def get_device(device_id: str) -> dict[str, Any]:
    device = HUB.devices.get(device_id)
    if device is None:
        raise HTTPException(404, f"no device {device_id!r}")
    return device.describe()


@app.post("/api/devices/{device_id}/command")
async def send_command(device_id: str, command: dict[str, Any] = Body(...)) -> dict[str, Any]:
    if device_id not in HUB.devices:
        raise HTTPException(404, f"no device {device_id!r}")
    if not isinstance(command, dict) or not command:
        raise HTTPException(400, "body must be a non-empty object of attribute -> value")
    try:
        return await HUB.command(device_id, command)
    except (KeyError, ValueError) as exc:
        raise HTTPException(400, str(exc)) from exc
    except Exception as exc:  # noqa: BLE001 - the device layer's failure is the user's answer
        raise HTTPException(502, f"{type(exc).__name__}: {exc}") from exc


@app.patch("/api/devices/{device_id}")
async def rename_device(device_id: str, body: dict[str, Any] = Body(...)) -> dict[str, Any]:
    if device_id not in HUB.devices:
        raise HTTPException(404, f"no device {device_id!r}")
    name, room, parked = body.get("name"), body.get("room"), body.get("parked")
    if name is None and room is None and parked is None:
        raise HTTPException(400, "provide 'name', 'room' and/or 'parked'")
    try:
        out = HUB.rename(device_id, name, room) if (name is not None or room is not None) else None
        if parked is not None:
            out = HUB.park(device_id, bool(parked))
        return out
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc


def _scene_last_runs() -> dict[str, float]:
    """When each scene last ran, from the activity log ("Scene 'X' activated")."""
    out: dict[str, float] = {}
    for e in HUB.store.get("activity") or []:
        msg = e.get("message") or ""
        if e.get("kind") == "scene" and msg.startswith("Scene '"):
            name = msg[len("Scene '"):].rsplit("'", 1)[0]
            out.setdefault(name, e.get("ts"))
    return out


def _scene_quick() -> dict[str, Any]:
    runs = _scene_last_runs()
    return {f"scene-{sc['id']}": {"label": sc.get("name"), "lastRun": runs.get(sc.get("name"))}
            for sc in (HUB.store.get("scenes") or [])}


@app.post("/api/quick/{quick_id}")
async def quick_action(quick_id: str) -> dict[str, Any]:
    """Overview quick actions: `ac-power` toggles the lead AC, `scene-<id>` runs a scene."""
    if quick_id == "ac-power":
        return await quick_ac_power()
    if quick_id.startswith("scene-"):
        try:
            out = await HUB.activate_scene(quick_id[len("scene-"):])
        except KeyError as exc:
            raise HTTPException(404, f"no scene {quick_id!r}") from exc
        return {"ok": not out["errors"], **out}
    raise HTTPException(404, f"no quick action {quick_id!r}")


async def quick_ac_power() -> dict[str, Any]:
    """Toggle the lead AC's power — the one button the home tile carries."""
    snap = HUB.snapshot()
    lead = next((d for d in snap["devices"]
                 if d["available"] and d["state"].get("indoor_temperature") is not None), None)
    if lead is None:
        raise HTTPException(404, "no AC answering")
    target = not bool(lead["state"].get("power"))
    await HUB.command(lead["id"], {"power": target})
    return {"ok": True, "on": target}


@app.post("/api/devices/{device_id}/refresh")
async def refresh_device(device_id: str) -> dict[str, Any]:
    if device_id not in HUB.devices:
        raise HTTPException(404, f"no device {device_id!r}")
    await HUB.refresh(device_id)
    return HUB.devices[device_id].describe()


# ---- scenes --------------------------------------------------------------
@app.get("/api/scenes")
async def list_scenes() -> Any:
    return HUB.store.get("scenes")


@app.put("/api/scenes")
async def put_scenes(scenes: list[dict[str, Any]] = Body(...)) -> Any:
    HUB.store.set("scenes", scenes)
    HUB.bus.publish("scenes", scenes)
    return scenes


@app.post("/api/scenes/{scene_id}/activate")
async def activate_scene(scene_id: str) -> dict[str, Any]:
    try:
        return await HUB.activate_scene(scene_id)
    except KeyError as exc:
        raise HTTPException(404, f"no scene {scene_id!r}") from exc


# ---- automations ---------------------------------------------------------
@app.get("/api/automations")
async def list_automations() -> Any:
    return HUB.store.get("automations")


@app.put("/api/automations")
async def put_automations(automations: list[dict[str, Any]] = Body(...)) -> Any:
    HUB.store.set("automations", automations)
    HUB.bus.publish("automations", automations)
    return automations


@app.post("/api/automations/{automation_id}/toggle")
async def toggle_automation(automation_id: str) -> Any:
    automations = HUB.store.get("automations") or []
    found = False
    for rule in automations:
        if rule["id"] == automation_id:
            rule["enabled"] = not rule.get("enabled", False)
            found = True
            break
    if not found:
        raise HTTPException(404, f"no automation {automation_id!r}")
    HUB.store.set("automations", automations)
    HUB.bus.publish("automations", automations)
    return automations


# ---- presence ------------------------------------------------------------
def _location_authorised(request) -> bool:
    """OwnTracks can send HTTP Basic or a bearer token; accept either, plus ?token= for a
    quick curl. Blank HOME_LOCATION_TOKEN disables the check — the hub is tailnet-only."""
    token = SETTINGS.location_token
    if not token:
        return True
    if request.query_params.get("token") == token:
        return True
    header = request.headers.get("authorization", "")
    if header.startswith("Bearer ") and header[7:] == token:
        return True
    if header.startswith("Basic "):
        import base64
        try:
            decoded = base64.b64decode(header[6:]).decode("utf-8", "replace")
        except Exception:  # noqa: BLE001
            return False
        return decoded.split(":", 1)[-1] == token
    return False


@app.post("/api/location")
async def ingest_location(request: Request, payload: dict[str, Any] = Body(...)) -> Any:
    """OwnTracks HTTP endpoint. Returns a JSON array, which is what the app expects."""
    if not _location_authorised(request):
        raise HTTPException(401, "bad or missing location token")
    await HUB.ingest_location(payload)
    return []


@app.get("/api/presence")
async def get_presence() -> Any:
    return HUB.presence.describe()


@app.get("/api/location/recent")
async def recent_location_reports() -> Any:
    """What the phone has actually been sending — type, trigger and region. Use this to check
    whether the geofence is configured: a crossing shows type=transition (or trigger "c")."""
    return HUB.presence.recent()


@app.get("/api/zones")
async def get_zones() -> Any:
    return HUB.presence.zones()


@app.put("/api/zones")
async def put_zones(zones: list[dict[str, Any]] = Body(...)) -> Any:
    saved = HUB.presence.set_zones(zones)
    HUB.bus.publish("presence", HUB.presence.describe())
    return saved


@app.post("/api/zones/from-fix")
async def zone_from_fix(body: dict[str, Any] = Body(...)) -> Any:
    """Pin a zone to wherever the phone last reported. Saves anyone having to look up
    coordinates by hand — walk into the room, tap the button."""
    fix = HUB.presence.last_fix
    if not fix:
        raise HTTPException(409, "no position reported yet — send one location from the phone first")
    name = str(body.get("name") or "Home").strip() or "Home"
    zones = [z for z in HUB.presence.zones() if z["name"].lower() != name.lower()]
    zones.append({"id": name.lower().replace(" ", "-"), "name": name,
                  "lat": fix["lat"], "lon": fix["lon"],
                  "radius": float(body.get("radius") or 150)})
    saved = HUB.presence.set_zones(zones)
    HUB.bus.publish("presence", HUB.presence.describe())
    return saved


# ---- activity ------------------------------------------------------------
@app.get("/api/activity")
async def activity(limit: int = 60) -> Any:
    return (HUB.store.get("activity") or [])[: max(1, min(limit, SETTINGS.activity_limit))]


@app.delete("/api/activity")
async def clear_activity() -> dict[str, Any]:
    HUB.store.set("activity", [])
    HUB.bus.publish("activity_cleared", [])
    return {"cleared": True}


# ---- live stream ---------------------------------------------------------
@app.get("/api/events")
async def events() -> StreamingResponse:
    queue = HUB.bus.subscribe()

    async def stream():
        try:
            # Prime the connection so a client that missed the last publish is not blank.
            yield f"data: {json.dumps({'event': 'snapshot', 'data': HUB.snapshot()})}\n\n"
            while True:
                try:
                    message = await asyncio.wait_for(queue.get(), timeout=20)
                except asyncio.TimeoutError:
                    yield ": keepalive\n\n"   # keeps proxies from closing an idle stream
                    continue
                yield f"data: {json.dumps(message, default=str)}\n\n"
        finally:
            HUB.bus.unsubscribe(queue)

    return StreamingResponse(
        stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no", "Connection": "keep-alive"},
    )


# ---- module contract -----------------------------------------------------
# What lets an ojee-console mount this hub. The console reads the manifest,
# builds nav from `views`, and dynamically imports `ui`. Served unauthenticated
# on purpose: the console has already authenticated the caller before it
# proxies here, and standalone the tailnet is the boundary.
@app.get("/module.json")
async def module_manifest() -> dict[str, Any]:
    return {
        "id": "home",
        "name": "Home",
        "version": app.version,
        # The house: the module is the home, and the AC is one thing in it.
        # Its glyph names the module wherever the console lists modules.
        "icon": "i-house",
        # One page: the AC and its temperatures, and everything else (all controls, scenes,
        # automations, activity) under Details on the same page. The old view ids (devices,
        # scenes, automations, activity) still deep-link: the UI opens that Details tab.
        "views": [
            {"id": "overview", "label": "Home", "icon": "i-house"},
        ],
        "ui": "/ui/index.js",
        "health": "/api/health",
        "capabilities": ["sse", "commands", "summary"],
        # Every alert this module can raise, for the console's per-kind settings. Alerts on
        # /api/summary carry `kind` and a stable `key` (home.<kind>.<device>).
        "alertKinds": ALERT_KINDS,
        "notifications": NOTIFICATIONS,
        # One press on the console's home tile: the lead AC's power. The
        # state it reports rides on /api/summary's `quick`, so the button
        # shows what the house is actually doing.
        # The AC's power, then one per scene, so a scene is one tap from the overview.
        "quickActions": [
            {"id": "ac-power", "label": "AC power", "icon": "i-power"},
            *[{"id": f"scene-{sc['id']}", "label": sc.get("name") or sc["id"], "icon": "i-scene"}
              for sc in (HUB.store.get("scenes") or [])],
        ],
    }


# ---- static --------------------------------------------------------------
# /ui is the module: the entry point the console imports, plus its stylesheet
# and icon sprite. /public is the STANDALONE shell, which a mounted console
# never requests — it supplies its own chrome.
app.mount("/ui", StaticFiles(directory=SETTINGS.ui_dir), name="ui")


@app.get("/")
async def index() -> FileResponse:
    return FileResponse(f"{SETTINGS.web_dir}/index.html")


app.mount("/", StaticFiles(directory=SETTINGS.web_dir, html=True), name="web")
