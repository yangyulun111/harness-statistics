"""Codex Desktop Task Ledger — 只读、零侵入的本地 Codex 任务与 Token 观测器。

数据源（全部只读）：
  1. state_5.sqlite   任务目录（threads / thread_spawn_edges）
  2. sessions/**/*.jsonl  Token/行为账本（增量 tail）
所有 Token 指标来自 rollout 中的服务端权威 token_count，按累计计数器差分计算。
"""
