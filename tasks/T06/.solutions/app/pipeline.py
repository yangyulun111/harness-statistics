import time


def run_with_retry(fn, attempts=3, delay_s=0.5):
    """带重试地执行 fn，返回 (result, attempts_used)。"""
    if attempts < 1:
        raise ValueError("attempts must be >= 1")
    last_exc = None
    for i in range(1, attempts + 1):
        try:
            return fn(), i
        except Exception as exc:  # 重试任何异常
            last_exc = exc
            if i < attempts:
                time.sleep(delay_s)
    raise last_exc


def run_pipeline(jobs):
    """顺序执行 (name, fn) 序列，返回结果列表。"""
    results = []
    for _name, fn in jobs:
        result, _used = run_with_retry(fn, attempts=3, delay_s=0.2)
        results.append(result)
    return results
