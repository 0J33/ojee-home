"""The console contract: four metrics, a sparkline, keyed alerts, declared kinds, no 3D model."""
import asyncio, os, sys, tempfile, unittest

os.environ["HUB_DATA_DIR"] = tempfile.mkdtemp()
os.environ["HUB_DEMO"] = "1"
ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
os.environ.setdefault("HUB_UI_DIR", os.path.join(ROOT, "ui"))
os.environ.setdefault("HUB_WEB_DIR", os.path.join(ROOT, "public"))
sys.path[:0] = [ROOT, os.path.join(ROOT, "vendor")]

from app import hub as H  # noqa: E402


class SummaryContract(unittest.TestCase):
    def test_shape_and_fault(self):
        async def run():
            from app.main import summary, module_manifest
            h = H.HUB
            did = next(iter(h.devices))
            d = h.devices[did]
            d.parked = False
            await h.refresh(did)
            s = await summary()
            self.assertNotIn("model", s)
            self.assertEqual([m["label"] for m in s["metrics"]][:3], ["AC", "Indoor", "Outdoor coil"])
            self.assertEqual(len(s["metrics"]), 4)
            self.assertIn("values", s["spark"])
            self.assertEqual(s["alerts"], [])

            d.state["error_code"] = 7
            s = await summary()
            self.assertEqual([(a["key"], a["kind"], a["severity"]) for a in s["alerts"]],
                             [(f"home.ac-fault.{did}", "home.ac-fault", "err")])
            d.state["error_code"] = 12           # a different number is the same item
            s2 = await summary()
            self.assertEqual(s2["alerts"][0]["key"], s["alerts"][0]["key"])
            d.state["error_code"] = 0

            m = await module_manifest()
            kinds = {k["kind"] for k in m["alertKinds"]}
            self.assertEqual(kinds, {"home.ac-fault", "home.ac-unavailable"})
            self.assertNotIn("Outside", str(s) + str(m))

            # Scenes are overview quick actions: declared, stateful, and runnable.
            from app.main import quick_action
            sc = h.store.get("scenes")[0]
            qid = f"scene-{sc['id']}"
            self.assertIn(qid, [q["id"] for q in m["quickActions"]])
            self.assertIn("ac-power", [q["id"] for q in m["quickActions"]])
            out = await quick_action(qid)
            self.assertTrue(out["ok"])
            s = await summary()
            self.assertEqual(s["quick"][qid]["label"], sc["name"])
            self.assertIsNotNone(s["quick"][qid]["lastRun"])
            self.assertIn("on", s["quick"]["ac-power"])
        asyncio.run(run())


if __name__ == "__main__":
    unittest.main()
