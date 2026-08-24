`shipping` 包的订单总额计算有两处 bug，分别位于 `shipping/cart.py` 与 `shipping/pricing.py`：

1. `Cart.subtotal()` 没有按数量累加（买 3 件只按 1 件计）；
2. `discount_rate()` 的折扣档位判断顺序错误（满 500 应打 8 折，却被 100 档拦截）。

要求：
- 修复这两个文件使全部测试通过；
- 不得修改 `tests/` 下任何文件；
- 完成判据：`python -m unittest discover -s tests` 全部通过。
