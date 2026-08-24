class Cart:
    def __init__(self):
        self._items = []  # (name, price, qty)

    def add(self, name, price, qty=1):
        self._items.append((name, price, qty))

    def subtotal(self):
        total = 0
        for _name, price, _qty in self._items:
            total += price
        return total
