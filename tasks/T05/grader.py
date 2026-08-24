import json
import os
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[2] / "benchmark"))
from grading import run_unittest  # noqa: E402

r = run_unittest(pathlib.Path(os.environ["BENCH_WORKSPACE"]), timeout=900,
                 extra_test_dirs=[pathlib.Path(__file__).resolve().parent / "hidden_tests"])
print(json.dumps({k: r[k] for k in ("total", "passed", "failures", "errors", "success")}))
