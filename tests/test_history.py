"""Temperature history survives a restart, keeps one sample a minute, and shrugs off a torn line."""
import os, sys, tempfile, unittest

sys.path[:0] = [os.path.join(os.path.dirname(__file__), "..")]
from app.history import History  # noqa: E402


class Clock:
    def __init__(self, t=1_000_000.0):
        self.t = t

    def __call__(self):
        return self.t


class HistoryTest(unittest.TestCase):
    def setUp(self):
        self.path = os.path.join(tempfile.mkdtemp(), "history.jsonl")
        self.clock = Clock()

    def state(self, indoor, on=True):
        return {"indoor_temperature": indoor, "outdoor_temperature": 40, "target_temperature": 24,
                "power": on, "mode": "cool"}

    def test_spacing_and_persistence(self):
        h = History(self.path, now=self.clock)
        self.assertTrue(h.record("ac", self.state(29.0)))
        self.clock.t += 2                       # settle-time confirmation polls are not history
        self.assertFalse(h.record("ac", self.state(28.9)))
        self.clock.t += 60
        self.assertTrue(h.record("ac", self.state(28.5)))
        again = History(self.path, now=self.clock)
        self.assertEqual([r["in"] for r in again.series("ac", 1)], [29.0, 28.5])

    def test_retention_and_torn_line(self):
        h = History(self.path, retain=3600, now=self.clock)
        h.record("ac", self.state(30))
        self.clock.t += 7200
        h.record("ac", self.state(25))
        with open(self.path, "a") as fh:
            fh.write('{"t": 12')              # a crash mid-write
        again = History(self.path, retain=3600, now=self.clock)
        self.assertEqual([r["in"] for r in again.series("ac", 48)], [25])

    def test_on_since(self):
        h = History(self.path, now=self.clock)
        h.record("ac", self.state(30, on=False))
        self.clock.t += 60
        h.record("ac", self.state(29.5, on=True))
        t_on = self.clock.t
        self.clock.t += 60
        h.record("ac", self.state(29.0, on=True))
        self.assertEqual(h.on_since("ac"), round(t_on, 1))
        self.clock.t += 60
        h.record("ac", self.state(29.0, on=False))
        self.assertIsNone(h.on_since("ac"))


if __name__ == "__main__":
    unittest.main()
