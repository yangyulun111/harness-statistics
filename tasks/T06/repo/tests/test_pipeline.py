import time
import unittest

from app.pipeline import run_pipeline, run_with_retry


class TestRunWithRetry(unittest.TestCase):
    def test_success_first_try(self):
        calls = []

        def fn():
            calls.append(1)
            return "ok"

        result, used = run_with_retry(fn, attempts=3, delay_s=0.1)
        self.assertEqual(result, "ok")
        self.assertEqual(used, 1)
        self.assertEqual(len(calls), 1)

    def test_retries_then_succeeds(self):
        state = {"n": 0}

        def flaky():
            state["n"] += 1
            if state["n"] < 3:
                raise ValueError("boom")
            return 42

        result, used = run_with_retry(flaky, attempts=5, delay_s=0.1)
        self.assertEqual(result, 42)
        self.assertEqual(used, 3)

    def test_exhausts_and_raises(self):
        def always_fail():
            raise RuntimeError("nope")

        with self.assertRaises(RuntimeError):
            run_with_retry(always_fail, attempts=2, delay_s=0.1)

    def test_delay_between_retries(self):
        state = {"n": 0}

        def slow_flaky():
            state["n"] += 1
            if state["n"] == 1:
                time.sleep(2.0)   # 模拟慢速第一阶段
                raise TimeoutError("stage timeout")
            return "recovered"

        t0 = time.monotonic()
        result, used = run_with_retry(slow_flaky, attempts=3, delay_s=0.3)
        self.assertEqual((result, used), ("recovered", 2))
        self.assertGreaterEqual(time.monotonic() - t0, 2.0)


class TestRunPipeline(unittest.TestCase):
    def test_order_and_results(self):
        def job_a():
            time.sleep(1.5)
            return "a"

        def job_b():
            time.sleep(1.5)
            return "b"

        t0 = time.monotonic()
        out = run_pipeline([("a", job_a), ("b", job_b)])
        self.assertEqual(out, ["a", "b"])
        self.assertGreaterEqual(time.monotonic() - t0, 3.0)

    def test_slow_stage_with_retry(self):
        state = {"n": 0}

        def stage():
            state["n"] += 1
            time.sleep(2.0)
            if state["n"] < 2:
                raise RuntimeError("transient")
            return "done"

        out = run_pipeline([("only", stage)])
        self.assertEqual(out, ["done"])


if __name__ == "__main__":
    unittest.main()
