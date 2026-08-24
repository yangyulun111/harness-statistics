`app/report.py` 的 `render_report` 是一个 80+ 行的长函数（解析配置、逐行格式化、组装边框全部混在一起），可读性差。请在**不改变任何外部行为**的前提下重构它：

- 拆出职责单一的私有辅助函数（如配置解析、行格式化、边框生成）；
- 为公开函数与关键私有函数补充类型注解；
- `render_report(lines, width)` 的签名与返回值保持不变。

要求：
- 只修改 `app/report.py`；
- 不得修改 `tests/`（评分会额外注入等价行为的新测试）；
- 完成判据：`python -m unittest discover -s tests` 全部通过。
