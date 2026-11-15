"""Switched off at the wall (hub.park): an AC whose fuse is off for the winter is not an error,
and it comes back by itself the first time it answers."""
import asyncio, os, sys, tempfile, unittest

os.environ["HUB_DATA_DIR"] = tempfile.mkdtemp()
os.environ["HUB_DEMO"] = "1"
ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
os.environ.setdefault("HUB_UI_DIR", os.path.join(ROOT, "ui"))
os.environ.setdefault("HUB_WEB_DIR", os.path.join(ROOT, "public"))
sys.path[:0] = [os.path.join(os.path.dirname(__file__), ".."), os.path.join(os.path.dirname(__file__), "..", "vendor")]

from app import hub as H  # noqa: E402


class Park(unittest.TestCase):
    def test_parked_is_not_broken_and_unparks_itself(self):
        async def run():
            from app.main import summary
            h = H.HUB
            did = next(iter(h.devices))
            d = h.devices[did]
            d.simulated = False
            answers = {"on": False}

            async def refresh():
                if answers["on"]:
                    d._mark_ok()
                else:
                    d._mark_bad("unreachable", "no answer")
            d.refresh = refresh
            await h.refresh(did)
            s = await summary()
            self.assertEqual((s["status"], len(s["alerts"])), ("err", 1))
            h.park(did, True)
            s = await summary()
            self.assertEqual((s["status"], s["alerts"]), ("ok", []))
            self.assertEqual(d.describe()["status"], "parked")
            self.assertIn("off at the wall", " ".join(f["v"] for f in s["facts"]))
            # Not looked for on every poll while parked.
            h._parked_tried[did] = __import__("time").time()
            answers["on"] = True
            await h.refresh_all()
            self.assertTrue(d.parked, "too soon to look again")
            h._parked_tried[did] = 0
            await h.refresh_all()
            self.assertFalse(d.parked, "it answered: back on by itself")
            self.assertEqual(d.describe()["status"], "ok")
        asyncio.run(run())


if __name__ == "__main__":
    unittest.main()
