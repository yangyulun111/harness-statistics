/**
 * 父子线程归因 —— Python oracle ledger/task_graph.py resolve_roots 的 TS 移植。
 *
 * v3 优先级（证据强度从高到低）：
 *   ① rollout session_meta.parent_thread_id（线程自声明，Guardian 场景唯一来源）
 *   ② state DB thread_spawn_edges 表（索引/交叉验证；Guardian 边缺失、status 恒 open）
 *   ③ threads.source JSON blob（subagent.thread_spawn.parent_thread_id）
 * 注意：forked_from_id 不建立 ownership（见 usage-accounting 的 fork 基线处理）。
 */

export type ParentSource = string; // session_meta | edges | source_json | none | unknown

export interface ResolvedNode {
  root: string | null; // null = 自身是根（或环上节点）
  depth: number; // 到根的跳数（根 0；环记 -1）
  type: "root" | "subagent";
}

export function resolveRoots(
  parentMap: Map<string, [string, ParentSource]>,
): Map<string, ResolvedNode> {
  const resolved = new Map<string, ResolvedNode>();

  const walk = (start: string) => {
    const chain: string[] = [start];
    const seen = new Set<string>([start]);
    let cur = start;
    let root: string;
    while (true) {
      const entry = parentMap.get(cur);
      const parent = entry ? entry[0] : null;
      if (parent === null || parent === undefined) {
        root = cur; // cur 无 parent → cur 即根
        break;
      }
      if (!parentMap.has(parent)) {
        chain.push(parent); // parent 自身无 parent → parent 是根
        root = parent;
        break;
      }
      if (seen.has(parent)) {
        // 环
        for (const node of chain) resolved.set(node, { root: null, depth: -1, type: "root" });
        return;
      }
      seen.add(parent);
      chain.push(parent);
      cur = parent;
    }
    // chain = [start, 祖先..., root]
    for (let i = 0; i < chain.length; i++) {
      resolved.set(chain[i]!, { root, depth: chain.length - 1 - i, type: "subagent" });
    }
    resolved.set(root, { root: null, depth: 0, type: "root" });
  };

  for (const child of parentMap.keys()) {
    if (!resolved.has(child)) walk(child);
  }
  return resolved;
}
