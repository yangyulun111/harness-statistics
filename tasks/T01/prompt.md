修复 `app/calc.py` 中的 `parse_duration` 函数：它应把 "1h30m"、"45s"、"2m15s" 这类时长字符串解析为总秒数并**累加**各段，当前实现有逻辑错误导致组合时长结果不对（例如 "1h30m" 返回 3600 而不是 5400）。

要求：
- 只修改 `app/calc.py`；
- 不得修改 `tests/` 下任何文件；
- 完成判据：在仓库根目录运行 `python -m unittest discover -s tests` 全部通过。
