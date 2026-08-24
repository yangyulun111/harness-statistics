import time


def run_with_retry(fn, attempts=3, delay_s=0.5):
    """带重试地执行 fn，返回 (result, attempts_used)。"""
    raise NotImplementedError("TODO: 实现本函数")


def run_pipeline(jobs):
    """顺序执行 (name, fn) 序列，返回结果列表。"""
    raise NotImplementedError("TODO: 实现本函数")
