`app/dates.py` 的 `next_month` 应返回"下个月的同一天"，当目标月没有这一天时收敛到目标月最后一天（如 1 月 31 日 → 2 月 28 日）。当前实现有 bug，`python -m unittest discover -s tests` 中有测试失败。

要求：
- 定位并修复 `app/dates.py`，使全部测试通过；
- 不得修改 `tests/` 下任何文件，不得用跳过/屏蔽测试的方式"修复"；
- 完成判据：`python -m unittest discover -s tests` 全部通过。
