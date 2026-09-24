"""The key-fetch breaker: it must open under failure and close again on its own.

The bug this pins: `_failures >= 3` used to be a permanent stop that told a human to
restart the hub, so three transient failures — an appliance briefly offline, an MQTT
timeout, a slow cloud — turned self-healing off until someone noticed the AC was dead.
"""
import asyncio
import os
import pathlib
import sys
import time

sys.path.insert(0, os.environ.get("HUB_ROOT", str(pathlib.Path(__file__).resolve().parents[1])))

from app.keyfetch import (  # noqa: E402
    BREAKER_COOLDOWN_SECONDS,
    MAX_CONSECUTIVE_FAILURES,
    MIN_INTERVAL_SECONDS,
    KeyFetcher,
    KeyFetchError,
)

fails = []


def check(label, cond, extra=""):
    print(("  ok   " if cond else "  FAIL ") + label + (f"  {extra}" if extra and not cond else ""))
    if not cond:
        fails.append(label)


def fetcher(outcomes):
    """A fetcher whose _fetch follows a script of exceptions / (key, version) pairs."""
    f = KeyFetcher("someone@example.com", "hunter2", "20")
    seq = list(outcomes)

    async def fake(device_id):
        step = seq.pop(0) if seq else ("KEY", 1)
        if isinstance(step, Exception):
            raise step
        return step

    f._fetch = fake  # noqa: SLF001
    return f


async def main():
    print("\n— it opens after repeated failure —")
    # Exactly enough failures to trip it; anything after the script runs out succeeds, which
    # is what makes the half-open probe below a real test of recovery.
    f = fetcher([RuntimeError("boom")] * MAX_CONSECUTIVE_FAILURES)
    for _ in range(MAX_CONSECUTIVE_FAILURES):
        f._last_attempt = 0.0            # skip the ordinary rate limit
        try:
            await f.fetch("AABBCC")
        except KeyFetchError:
            pass
    check("it stops trying after the limit", f._failures >= MAX_CONSECUTIVE_FAILURES)
    try:
        await f.fetch("AABBCC")
        check("blocked while cooling down", False, "it attempted anyway")
    except KeyFetchError as exc:
        check("blocked while cooling down", "trying again in" in str(exc), str(exc))
        # The important half: a caller must be told this resolves itself, or it logs an
        # error every poll and buries the failures that need a person.
        check("and reported as transient", exc.transient is True)
        check("it does not tell anyone to restart the hub", "restart the hub" not in str(exc))

    print("\n— it closes again once the cooldown passes —")
    f._last_attempt = time.time() - (BREAKER_COOLDOWN_SECONDS + 1)
    try:
        key, version = await f.fetch("AABBCC")
        check("one attempt is allowed through", key == "KEY")
        check("a success resets the breaker", f._failures == 0)
    except KeyFetchError as exc:
        check("one attempt is allowed through", False, str(exc))

    print("\n— a failure at the half-open point lengthens the wait —")
    f = fetcher([RuntimeError("boom")] * 9)
    for _ in range(MAX_CONSECUTIVE_FAILURES):
        f._last_attempt = 0.0
        try:
            await f.fetch("AABBCC")
        except KeyFetchError:
            pass
    first = None
    try:
        await f.fetch("AABBCC")
    except KeyFetchError as exc:
        first = int("".join(c for c in str(exc).split("in ")[-1] if c.isdigit()) or 0)
    f._last_attempt = time.time() - (BREAKER_COOLDOWN_SECONDS + 1)
    try:
        await f.fetch("AABBCC")          # allowed through, fails again
    except KeyFetchError:
        pass
    second = None
    try:
        await f.fetch("AABBCC")
    except KeyFetchError as exc:
        second = int("".join(c for c in str(exc).split("in ")[-1] if c.isdigit()) or 0)
    check("the next wait is longer than the last", (second or 0) > (first or 0), f"{first} -> {second}")


    print("\n— an outage is not evidence about the password —")

    class ConnectError(Exception):
        """Stands in for httpx's, which is imported lazily and cannot be named here."""

    # Exactly as many outages as there are attempts below, so the poll after them
    # falls through to the success the script ends on.
    f = fetcher([ConnectError("[Errno -3] Temporary failure in name resolution")]
                * (MAX_CONSECUTIVE_FAILURES + 1))
    for _ in range(MAX_CONSECUTIVE_FAILURES + 1):
        f._last_attempt = 0.0
        try:
            await f.fetch("AABBCC")
            last = None
        except KeyFetchError as exc:
            last = exc
    check("it does not count unanswered failures", f._failures == 0, f"failures={f._failures}")
    check("and stays quiet about them", bool(last) and last.transient is True)
    f._last_attempt = 0.0
    try:
        key, _ = await f.fetch("AABBCC")
        check("the first poll after the outage fetches", key == "KEY")
    except KeyFetchError as exc:
        check("the first poll after the outage fetches", False, str(exc))

    print("\n— ordinary rate limiting still applies —")
    f = fetcher([("KEY", 1), ("KEY", 1)])
    await f.fetch("AABBCC")
    try:
        await f.fetch("AABBCC")
        check("a second call inside the window is refused", False)
    except KeyFetchError as exc:
        check("a second call inside the window is refused", "rate-limited" in str(exc))
        check("and is transient", exc.transient is True)

    print("\n— no credentials is transient, not an error to shout about —")
    f = KeyFetcher("", "", "20")
    try:
        await f.fetch("AABBCC")
        check("unconfigured is refused", False)
    except KeyFetchError as exc:
        check("unconfigured is refused", "no HAIER_USERNAME" in str(exc))
        check("and is transient", exc.transient is True)

    print(f"\n{'ALL PASS' if not fails else str(len(fails)) + ' FAILED: ' + ', '.join(fails)}")
    return 1 if fails else 0


sys.exit(asyncio.run(main()))
