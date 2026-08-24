import unittest

from app.report import render_report


class TestRenderReport(unittest.TestCase):
    def test_box_structure(self):
        r = render_report(["hello"], 20)
        lns = r.split("\n")
        self.assertEqual(len(lns), 3)
        self.assertTrue(lns[0].startswith("+") and lns[0].endswith("+"))
        self.assertTrue(lns[-1].startswith("+") and lns[-1].endswith("+"))
        self.assertIn("hello", lns[1])

    def test_width_exact(self):
        for w in (10, 21, 40):
            r = render_report(["x"], w)
            self.assertTrue(all(len(l) == w for l in r.split("\n")))

    def test_long_line_truncated_with_ellipsis(self):
        r = render_report(["a" * 100], 20)
        self.assertIn("...", r.split("\n")[1])
        self.assertEqual(len(r.split("\n")[1]), 20)

    def test_tab_expanded(self):
        r = render_report(["a\tb"], 24)
        self.assertIn("a    b", r)

    def test_heading_marker(self):
        r = render_report(["# Title"], 20)
        self.assertIn("#", r.split("\n")[1])

    def test_plain_line_no_marker(self):
        r = render_report(["plain"], 20)
        self.assertNotIn("#", r.split("\n")[1])

    def test_empty(self):
        r = render_report([], 12)
        self.assertEqual(len(r.split("\n")), 2)

    def test_non_string_coerced(self):
        r = render_report([42], 16)
        self.assertIn("42", r)


if __name__ == "__main__":
    unittest.main()
