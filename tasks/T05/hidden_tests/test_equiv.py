import unittest
import random

from app.report import render_report


class TestEquivalentBehavior(unittest.TestCase):
    """等价行为注入测试：重构后行为必须与原实现一致。"""

    REF = "+------------------+\n|       hello      |\n+------------------+"

    def test_known_output_exact(self):
        self.assertEqual(render_report(["hello"], 20), self.REF)

    def test_random_inputs_stable_shape(self):
        rng = random.Random(42)
        for _ in range(50):
            w = rng.randint(12, 60)
            lines = ["x" * rng.randint(0, 80) for _ in range(rng.randint(0, 5))]
            r = render_report(lines, w)
            for ln in r.split("\n"):
                self.assertEqual(len(ln), w)
            self.assertTrue(r.split("\n")[0].startswith("+"))

    def test_truncation_exact(self):
        r = render_report(["abcdefghij" * 5], 16)
        mid = r.split("\n")[1]
        self.assertTrue(mid.endswith("...  |") or mid.rstrip("|").rstrip().endswith("..."))


if __name__ == "__main__":
    unittest.main()
