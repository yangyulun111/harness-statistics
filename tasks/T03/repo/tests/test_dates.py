import unittest
from datetime import date

from app.dates import next_month


class TestNextMonth(unittest.TestCase):
    def test_normal_month(self):
        self.assertEqual(next_month(date(2026, 8, 21)), date(2026, 9, 21))

    def test_december_wraps_year(self):
        self.assertEqual(next_month(date(2026, 12, 15)), date(2027, 1, 15))

    def test_end_of_month_clamps(self):
        self.assertEqual(next_month(date(2026, 1, 31)), date(2026, 2, 28))
        self.assertEqual(next_month(date(2028, 1, 31)), date(2028, 2, 29))  # 闰年
        self.assertEqual(next_month(date(2026, 3, 31)), date(2026, 4, 30))
        self.assertEqual(next_month(date(2026, 12, 31)), date(2027, 1, 31))

    def test_mid_month_unchanged(self):
        self.assertEqual(next_month(date(2026, 1, 15)), date(2026, 2, 15))


if __name__ == "__main__":
    unittest.main()
