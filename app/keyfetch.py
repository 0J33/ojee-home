"""Fetch a device's localKey from the Haier cloud, so a rotation heals itself.

Haier rotates the per-device key server-side. The trigger is not documented — a scheduled
auto-off did it once here — so rather than try to predict *when*, the hub reacts to the fact:
any read or command that fails to decrypt asks this module for a fresh key and retries.

The account password lives in the environment (and therefore in the gitignored `stack/.env`),
never in the repo and never in the hub's data file. Only the resulting device key is persisted.
"""
from __future__ import annotations

import asyncio
import logging
import socket
import time

LOGGER = logging.getLogger("home.keyfetch")

#: Never hammer the cloud. A rotation is rare; a broken password is not, and retrying that in a
#: poll loop would lock the account rather than fix anything.
MIN_INTERVAL_SECONDS = 300.0
#: Give up re-trying after this many consecutive failures — but only failures the cloud
#: actually answered. See `_offline()`.
MAX_CONSECUTIVE_FAILURES = 3
#: Having given up, try once this often anyway. Giving up used to last until someone
#: restarted the hub, which is a long time to leave the AC uncontrollable over a password
#: that may have been corrected hours ago. Once an hour cannot endanger an account.
GIVE_UP_RETRY_SECONDS = 3600.0

#: httpx is imported lazily (see `_fetch`), so its classes cannot be named here. The names
#: cover its timeouts, which carry no OSError underneath.
_OFFLINE_NAMES = {"ConnectError", "ConnectTimeout", "ReadTimeout", "WriteTimeout",
                  "PoolTimeout", "NetworkError", "TimeoutException"}


def _offline(exc: BaseException | None) -> bool:
    """Was this "the internet was not there" rather than "the account was refused"?

    The difference decides whether the failure counts. It cost a day to learn: during a
    router outage on 2026-09-25 three polls failed with "Temporary failure in name
    resolution", which used up the whole give-up budget, and the hub then never refreshed
    the AC's rotated key again — hours after the internet came back — until the container
    was restarted by hand. A machine that cannot reach the internet has learned nothing
    about its password.
    """
    seen: set[int] = set()
    while exc is not None and id(exc) not in seen:
        seen.add(id(exc))
        if isinstance(exc, (socket.gaierror, OSError, ConnectionError, TimeoutError)):
            return True
        if type(exc).__name__ in _OFFLINE_NAMES:
            return True
        exc = exc.__cause__ or exc.__context__
    return False


class KeyFetchError(RuntimeError):
    """A key fetch did not happen. `transient` marks the expected backoff cases (rate limit),
    which a caller should stay quiet about rather than log as a failure every poll."""

    def __init__(self, message: str, *, transient: bool = False) -> None:
        self.transient = transient
        super().__init__(message)


class KeyFetcher:
    """Rate-limited wrapper around the cloud sign-in + gateway key fetch."""

    def __init__(self, username: str, password: str, region: str) -> None:
        self.username = username
        self.password = password
        self.region = str(region).strip().lstrip("+")
        self._last_attempt = 0.0
        self._failures = 0
        self._lock = asyncio.Lock()

    @property
    def configured(self) -> bool:
        return bool(self.username and self.password)

    def _blocked(self) -> tuple[str | None, bool]:
        """(reason, is_transient). Transient means "expected, will resolve on its own"."""
        if not self.configured:
            return "no HAIER_USERNAME/HAIER_PASSWORD configured", True
        if self._failures >= MAX_CONSECUTIVE_FAILURES:
            since = time.time() - self._last_attempt
            if since < GIVE_UP_RETRY_SECONDS:
                mins = int((GIVE_UP_RETRY_SECONDS - since) // 60) + 1
                return (f"gave up after {self._failures} consecutive failures — check the "
                        f"account credentials; trying again in {mins} min"), False
            # Fall through for one attempt. The counter is left alone, so a failure re-arms
            # the hour and a success clears it.
        waited = time.time() - self._last_attempt
        if waited < MIN_INTERVAL_SECONDS:
            return f"rate-limited, {int(MIN_INTERVAL_SECONDS - waited)}s to go", True
        return None, False

    async def fetch(self, device_id: str) -> tuple[str, int | None]:
        """Return (localKey, version) for `device_id`. Raises KeyFetchError."""
        async with self._lock:
            blocked, transient = self._blocked()
            if blocked:
                raise KeyFetchError(blocked, transient=transient)
            self._last_attempt = time.time()
            try:
                key, version = await self._fetch(device_id)
            except Exception as exc:  # noqa: BLE001 - every failure mode is reported the same way
                if _offline(exc):
                    # Not counted, and not logged every poll: an outage resolves itself, and
                    # the next poll after it will fetch the key.
                    raise KeyFetchError(f"{type(exc).__name__}: {exc}", transient=True) from exc
                self._failures += 1
                raise KeyFetchError(f"{type(exc).__name__}: {exc}") from exc
            self._failures = 0
            return key, version

    async def _fetch(self, device_id: str) -> tuple[str, int | None]:
        # Imported here, not at module scope: the extractor pulls in httpx and is only needed
        # when a key actually has to be fetched. A hub with no credentials should not fail to
        # start because of it.
        from haismart_extractor import GatewayClient, GatewayCreds, HaierCloud, SEA_APP_CREDENTIALS

        client, result = await HaierCloud.login(
            SEA_APP_CREDENTIALS, self.username, self.password, zone_info=self.region,
        )
        wanted = "".join(c for c in device_id if c.isalnum()).upper()

        creds = GatewayCreds.derive(
            usdk_client_id=result.client_id, access_token=result.access_token,
        )
        # get_localkeys is blocking (MQTT over a socket), so keep it off the event loop.
        keys = await asyncio.to_thread(
            GatewayClient(creds).get_localkeys, [wanted], timeout=15.0,
        )
        entry = keys.get(wanted)
        if entry is None:
            # Signing in worked, so say so — the natural next move on a bare failure is to go
            # and re-check a password that has just been proven correct.
            raise KeyFetchError(
                f"signed in fine, but no key came back for {wanted}. An appliance that is "
                "offline, or cut off from Haier, cannot be issued one."
            )
        LOGGER.info("fetched localKey v%s for %s", entry.version, wanted)
        return entry.key, entry.version
