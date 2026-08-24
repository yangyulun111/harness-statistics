在 `app/pipeline.py` 中实现带重试的任务执行器（当前为占位实现）：

1. `run_with_retry(fn, attempts=3, delay_s=0.5) -> (result, attempts_used)`
   - 依次尝试调用 `fn()`，成功立即返回 `(fn() 的返回值, 实际尝试次数)`；
   - 失败则等待 `delay_s` 秒后重试，直到第 `attempts` 次仍失败时把最后一次异常抛出；
   - `attempts >= 1`。

2. `run_pipeline(jobs) -> list`
   - jobs 为 (name, fn) 序列，逐个用 `run_with_retry(fn, attempts=3, delay_s=0.2)` 执行；
   - 返回每个 job 的结果列表（保持顺序）。

要求：
- 只修改 `app/pipeline.py`；
- 不得修改 `tests/`（测试含多个长耗时用例，请耐心等待其自然结束）；
- 完成判据：`python -m unittest discover -s tests` 全部通过。
