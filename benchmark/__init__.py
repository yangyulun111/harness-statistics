"""Benchmark 模式：Task Ledger 之上的 Level-0 评测运行编排。

原则：
  - worktree 隔离（本地基仓 + git worktree add --detach，固定 base_commit）；
  - Run ↔ Thread 唯一绑定（run 前快照线程 id，候选≠1 → attribution_ambiguous，绝不猜）；
  - 独立 grader（不信任模型自称完成）；
  - metrics.json v2：usage_source / authoritative；主 Token 指标非 authoritative 则 run 无效。
"""
