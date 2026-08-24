def discount_rate(subtotal):
    """满 500 打 8 折（0.20），满 100 打 9 折（0.10），否则无折扣。"""
    if subtotal >= 100:
        return 0.10
    elif subtotal >= 500:
        return 0.20
    return 0.0


def total(cart):
    sub = cart.subtotal()
    return round(sub * (1 - discount_rate(sub)), 2)
