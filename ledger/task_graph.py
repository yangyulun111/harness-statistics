"""父子线程归因（子代理 Token 归集到根任务）。

v3 优先级（证据强度从高到低）：
  ① rollout session_meta.parent_thread_id（线程自声明，Guardian 场景唯一来源）
  ② state DB thread_spawn_edges 表（索引/交叉验证；Guardian 边缺失、status 恒 open）
  ③ threads.source JSON blob（subagent.thread_spawn.parent_thread_id）
注意：forked_from_id 不建立 ownership（见 collector fork 基线处理）。
"""
from __future__ import annotations

from typing import Dict, Optional, Tuple


def resolve_roots(parent_map: Dict[str, Tuple[Optional[str], str]]) -> Dict[str, Tuple[Optional[str], int, str]]:
    """给定 child -> (parent, 来源) 映射（仅含有 parent 的项），计算 child -> (root, depth, thread_type)。

    root 为 None 表示该线程自身是根；depth = 到根的跳数（根为 0，直接子为 1）。
    环上节点 root 置 None、depth 记 -1。
    """
    resolved: Dict[str, Tuple[Optional[str], int, str]] = {}

    def walk(start: str):
        chain = [start]
        seen = {start}
        cur = start
        while True:
            parent = parent_map.get(cur, (None, "none"))[0]
            if parent is None:
                root = cur          # cur 无 parent → cur 即根
                break
            if parent not in parent_map:
                chain.append(parent)  # parent 自身无 parent → parent 是根
                root = parent
                break
            if parent in seen:      # 环
                for node in chain:
                    resolved[node] = (None, -1, "root")
                return
            seen.add(parent)
            chain.append(parent)
            cur = parent
        # chain = [start, 祖先..., root]
        for i, node in enumerate(chain):
            resolved[node] = (root, len(chain) - 1 - i, "subagent")
        resolved[root] = (None, 0, "root")

    for child in parent_map:
        if child not in resolved:
            walk(child)
    return resolved
