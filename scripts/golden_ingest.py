"""Golden harness（Python 侧）：对 fixture home 执行一次性 ingest。用法：
python scripts/golden_ingest.py <codex_home> <db_path>
"""
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from ledger import collector  # noqa: E402


def main():
    home, db = sys.argv[1], sys.argv[2]
    stats = collector.ingest(db_path=Path(db), verbose=False, env_codex_home=home)
    print(stats)


if __name__ == "__main__":
    main()
