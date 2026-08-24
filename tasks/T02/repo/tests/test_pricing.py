import unittest

from shipping.cart import Cart
from shipping.pricing import discount_rate, total


class TestCart(unittest.TestCase):
    def test_subtotal_multiplies_quantity(self):
        c = Cart()
        c.add("book", 30.0, qty=3)
        c.add("pen", 5.0)
        self.assertAlmostEqual(c.subtotal(), 95.0)


class TestPricing(unittest.TestCase):
    def test_discount_tiers(self):
        self.assertEqual(discount_rate(99), 0.0)
        self.assertEqual(discount_rate(100), 0.10)
        self.assertEqual(discount_rate(499.99), 0.10)
        self.assertEqual(discount_rate(500), 0.20)
        self.assertEqual(discount_rate(1200), 0.20)

    def test_total_applies_quantity_and_discount(self):
        c = Cart()
        c.add("keyboard", 200.0, qty=3)   # 小计 600 → 8 折
        self.assertAlmostEqual(total(c), 480.0)


if __name__ == "__main__":
    unittest.main()
