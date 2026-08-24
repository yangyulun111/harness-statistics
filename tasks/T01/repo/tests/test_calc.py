import unittest

from app.calc import parse_duration


class TestParseDuration(unittest.TestCase):
    def test_single_unit(self):
        self.assertEqual(parse_duration("45s"), 45)
        self.assertEqual(parse_duration("2m"), 120)
        self.assertEqual(parse_duration("1h"), 3600)

    def test_combined(self):
        self.assertEqual(parse_duration("1h30m"), 5400)
        self.assertEqual(parse_duration("2m15s"), 135)
        self.assertEqual(parse_duration("1h30m45s"), 5445)

    def test_trailing_bare_number_is_seconds(self):
        self.assertEqual(parse_duration("90"), 90)

    def test_garbage_ignored(self):
        self.assertEqual(parse_duration(""), 0)
        self.assertEqual(parse_duration("abc"), 0)


if __name__ == "__main__":
    unittest.main()
