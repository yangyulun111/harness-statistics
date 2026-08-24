# Ledger Contract v1 — 计算规则与数据协议（已冻结）

本文件是 Python oracle 与 TypeScript 产品实现共同遵守的契约。TS 侧实现必须与本文规则逐字段一致（G1 golden tests）。

## 1. 数据源与只读保证

| 层 | 来源 | 打开方式 |
|---|---|---|
| 任务目录 | `state_5.sqlite`（threads / thread_spawn_edges，路径由 `codex doctor --json` 报告的 sqlite home 决定，本机两套并存**只用 doctor 指定的**） | `file:...?mode=ro` + busy_timeout |
| 行为账本 | `$CODEX_HOME/sessions/YYYY/MM/DD/*.jsonl` | 增量 tail：`rollout_files.last_offset` 断点续读，单批 ≤20k 行 / ≤64MB，只消费完整 `\n` 行；文件变小 → 从头重读 |

collector 绝不写 `~/.codex`；观察与执行分离（不装 MCP/插件/hook 进被测环境）。

## 2. Token 事件三分类（v3 核心）

对 rollout 中每个 `event_msg/token_count`：

1. `total_token_usage.total_tokens` **较上一有效快照增长** → `usage_bearing_samples += 1`（本次采样对应一次真实模型完成）；
2. **未增长** → `rebroadcast_events += 1`（#14489 限流重播/重复快照），**不计任何 call**。本机实测（修复 embedded-echo 误绑后）：samples 124,008 / rebroadcast 3,898 ≈ **3%**；未去重仅虚高约 3%；
3. `wait_status_model_calls`：**语义分类**而非增长分类——该 usage-bearing sample 所属完成段（自上一采样起）的 action/tool set ⊆ `WAIT_ACTIONS` 且无成功 patch。`WAIT_ACTIONS = {wait_agent, functions.wait, wait, status, list_agents, thread_status}`（本机实测工具名：wait_agent×417、wait×373、list_agents×136 命中；`exec` 型 sleep 轮询为已知漏检项，经 G0-C 校准）。全库实测 wait 占采样 4,421/124,008 ≈ 3.6%。

**rollout 文件身份规则（重要，实测踩坑）**：
- 子代理文件会在**第 2 行嵌入父线程的 session_meta echo**（id=父线程）。文件身份只由**首行** session_meta 决定（`payload.id`，缺失回退文件名 uuid），**绝不**用 `session_id`（子代理文件的 session_id 存父线程 id）、**绝不**因中途出现的 session_meta 改绑；
- 同线程 id 跨多文件且各文件计数独立重启时（resume/retry），线程口径取高水位（与 state `tokens_used` 一致，G0-A 验证），`file_usage_epochs` 记录各文件区间并提示潜在少计。

字段语义：
- 线程累计 = 最后一个**增长**快照（`threads_diag.last_total_json` / `final_*`），绝不 `sum(last_token_usage)`；
- Turn 用量 = 累计计数器差分（`Total_after − Total_before`），`usage_start_json` 在 Turn 首次增长前捕获；
- `reasoning_output_tokens ⊆ output_tokens`，不重复计入总量；
- `peak_context = max(last_token_usage.total_tokens)`，与累计 `tokens_used` 是**两个概念**，任何 UI/报告不得混同；
- 指标命名用 `usage_bearing_samples`（经 G0-C 与 logs_2.sqlite post-sampling telemetry 校准 1:1 后才允许改称 `model_calls`）。

## 3. 任务图归因（优先级）

```
① rollout session_meta.parent_thread_id   （线程自声明；Guardian 唯一可靠来源）
② state DB thread_spawn_edges             （索引/交叉验证；Guardian 缺边、status 恒 open）
③ threads.source JSON（subagent.thread_spawn.parent_thread_id）
```

本机实测：186 个子代理全部由 ① 归位（含 52 个 `{"subagent":{"other":"guardian"}}` 无 spawn 信息的 Guardian）。

**fork 双重身份**（`session_meta.forked_from_id`，v1.1 / fork-v2）：
- MUST NOT 建立 task ownership（fork 不是 parent 的 subagent）；
- MUST 做继承前缀去重，但依据是**结构化父前缀匹配**而非首快照启发式：
  - 主判据 = 子/父增长快照六字段元组（input/cached/cache_write/output/reasoning/total）逐位
    位置匹配；首个不等处 = 边界，其后全部 native；匹配长度 0 且父可达 → `baseline_method='none'`（阳性无重放）；
  - 时间戳**不参与主判定**（EOF 与时间 gap 都不是 replay 边界——ccusage#1460 教训）；
  - 父文件缺失：起始密集聚簇（连续 gap ≤1s、≥2 条）→ `legacy_time`（unverified 降级）；
    无签名 → `unresolved`，**不扣减**（baseline=0），绝不自动扣首快照；
  - 迟到父：ingest 末尾延迟复核 pass 对该线程整体重折叠（refold），结构化结论取代降级结论；
  - `verification_status != 'verified'` 的 fork 在任务域内 → `authoritative=false`。

## 4. schema 兼容 fail-closed（关键字段，带阈值）

| 字段 | 处理 |
|---|---|
| `session_meta.id` | 缺失（且文件名无 uuid 可回退）→ 身份破坏 → `schema_compat='incompatible'` |
| `token_count.info.total_token_usage` | 单条缺失 → 跳过该事件并计数；**畸形数 > max(3, 20% × token_count_events)** 才判 `incompatible`（零星畸形不影响对账正确的数值，实测 33 条零星畸形线程仍与 state 精确一致） |
| `task_started/task_complete/turn_aborted.turn_id` | 缺失计数为告警（turn 归属降级，Token 总量不受影响） |

`threads_diag.schema_compat != 'ok'` → Token 指标 `authoritative=false` → **禁入正式 Benchmark**（防"程序正常运行但数字错误"）。一般未知字段忽略、未知事件类型 raw 保存+告警。

## 5. metrics.json v2 协议

```jsonc
{
  "usage_source": "rollout_cumulative",   // 枚举: rollout_cumulative | state_snapshot |
                                          //        app_server_exact | estimated_tiktoken | missing
  "authoritative": true,                  // = 唯一线程绑定 ∧ 全域 schema_compat=ok ∧ 无未验证 fork 基线
  "quality":  { "test_pass_rate", "task_completed", "manual_score", "terminal_failure" },
  "tokens":   { "input_tokens", "cached_input_tokens", "uncached_input_tokens",
                "cache_write_tokens", "output_tokens", "reasoning_tokens", "total_tokens" },  // 任务域 exclusive
  "turns":    [ { "turn_index", "duration_ms", "ttft_ms", token 五项,
                  "usage_bearing_samples", "wait_status_model_calls", "patches", "compactions", "status" } ],
  "orchestration": { "user_turns", "usage_bearing_samples", "wait_status_model_calls",
                     "rebroadcast_events", "subagents", "retries",
                     "wait_tokens_est",   // estimated：Σ(轮 token × wait采样占比)
                     "classification_version" },
  "context":  { "peak_context_tokens", "model_context_window", "compactions", "tool_output_bytes" },
  "performance": { "total_ms", "ttft_ms_first", "time_to_first_patch_ms", "failure_recovery_ms" },
  "cost":     { "available", "total", "currency", "components", "missing_models", "sources",
                "catalog_digest", "path" }   // estimated · 按时点价（时变价格目录）
}
```

正式 Level-0：主 Token 指标非 `authoritative` → **run 无效，重跑**，不得混入估算值。

### cost 口径（时变价格目录）

- 价格目录 = 仓库根 `model_prices.json`（benchmark 侧可用 `HS_PRICES` 覆盖；serve 可用 `--prices`），
  条目含 `effective_from/effective_to`，**促销/调价以新条目表达，取价 = 事件时点所在区间的最新条目**；
- 主口径永远是 Token；成本仅为 `estimated` 参考口径，价格未配置 → null（fail-closed，绝不猜价）；
- `catalog_digest`（目录内容哈希）钉入 metrics.json，保证跨 run / Treatment A/B 可复现——
  对比期间发生促销调价不污染结论；web 端趋势视图不展示成本（避免跨期价格不可比造成误导）。

## 6. Failure Recovery v2

- 可恢复失败（agent 执行期）：turn `had_error` / `turn_aborted` / patch_apply 失败 / 命令非零退出；
- `recovery_ms = 下一次 workspace 内成功 patch 时刻 − 首个失败时刻`；
- grader 终局失败 → `terminal_failure=true`、`recovery_ms=null`（不给伪造值）。

## 7. Benchmark Run 协议

1. run 开始：快照 ledger 全部 thread id；
2. `git worktree add --detach <ws> <base_commit>`（本地基仓，非 clone，消除网络/cache 噪声）；
3. setup 运行（不计入耗时）；
4. 操作者在 ChatGPT Desktop — Codex 视图**新建任务**，cwd 指向 workspace，粘贴 prompt，回车记 t0；
5. 结束回车记 t_end；grader 独立评分（不信任模型自称完成）；
6. 唯一线程绑定：候选 = 新 thread id ∧ `normcase(cwd)==workspace` ∧ `created≥t0−120s` ∧ `thread_source==user`；
   **候选数 ≠ 1 → `attribution_ambiguous`，不进正式 Baseline，绝不猜**。

## 8. 统计口径

- Primary = median + IQR；Secondary = mean / max / total（Token 极端消耗是真实成本，不因 heavy-tail 隐藏 mean）；
- `Tokens / Successful Task = 所有 runs Token 总量 / 成功 runs 数`（失败消耗被惩罚）；
- 未来 Treatment A/B：同任务、同 initial commit，配对比较（非独立总体）。

## 9. collector.sqlite schema 要点（契约 v1.2，2026-08-22）

三层指标：**L0 raw** = `final_*`（观测累计，含继承前缀，G0-A 对账基准）；**L1 分类** =
`daily_usage` 毛增长差分 + 组件级 `replay_*` 列，`native := raw − replay`（查询层派生，恒等式
`raw = replay + native` 按组件成立）；L2 经济层（成本 estimated）= 查询层按时变价格目录派生
（`model_prices.json` 用户层 + `model_prices.synced.json` 官网同步层，用户优先；见 metrics.json 协议 cost 口径节），
不落盘、不影响 schema。

**TS-only 扩展表 `tool_events`（v1.3，不在本契约六表内、G1 不可见）**：工具分桶明细
（shell/file/mcp/web/collab，per-call 时长=call↔output 时戳差、双口径成败、文件 ± 行、启发式读检测）。
Python 冻结轨无此表；历史回填 `npm run update -- --refold-tools`（内存库全量重放后整体替换）。
注意其 shell 成败为 JSON+纯文本双口径，可比契约列 `shell_failures`（仅 JSON 风格）更全。
**v1.4**：file 桶时长 = `patch_apply_end.call_id` ↔ pending exec 调用时戳差（apply_patch 走 exec 通道；
peek 不 consume，shell 行仍由 output 配对负责）——fork/重放文件剥离 call 事件 → NULL 不猜；
桶聚合 duration 全 NULL 时返回 null（UI 显示 "–"，不误报 0.0s）。

`threads`（含 `forked_from_id/inherited_baseline/baseline_verified` + v1.1 `baseline_method`
/`verification_status` + **v1.2 `sandbox_policy`/`approval_mode`**——state DB 权威写入、
turn_context `sandbox_policy`/`approval_policy` setdefault 兜底）、
`turns`（三分类计数与差分五项 + **v1.2 `mcp_calls`/`mcp_failures`/`shell_failures`**）、
`threads_diag`（`final_*` raw 累计 + v1.1 `native_total`/`replay_{input,cached,output,total}_tokens`
/`replay_events`/`baseline_prefix_events`/`baseline_parent_digest`（继承前缀链式 SHA-256）
/`fork_replay_json`（分类器状态机 + 父序列游标 + 文件边界辅助态，与账目同轮事务落盘）
+ **v1.2 `mcp_calls`/`mcp_failures`/`shell_failures`**）、
`daily_usage`（按日实际消耗——增长事件差分按事件时间戳归日 + `replay_*` 组件列；
消耗口径 = raw − replay，无状态、幂等；2026-08-17/19/20/21 四日与 token-monitor 逐 token 相等）、
`task_usage`（VIEW：root/sub/total 以 `native_total` 为 canonical）、`rollout_files`（增量断点）、
`benchmark_runs`、`meta`（`schema_version=2` 守卫 + codex 版本）。

**v1.2 口径**：`mcp_tool_call_end` 自包含 `invocation.server/tool` 与 `result.{Ok|Err}` →
一等成败计数；`shell_failures` 为 **estimated** 启发式（工具输出文本内嵌 JSON 的
`exit_code≠0`，不可解析不计 → 低估方向，不进 authoritative 判定）。
失败明细落事件级 `tool_failures` 表（`thread_id+seq` 主键；`kind = shell_exit|mcp_err|patch_fail`；
`command` 来自配对 `call_id` 的工具调用输入（截断 500 code point，跨 run 边界的孤行输出
记 NULL）；`detail` 为输出/错误片段截断 1000；refold 时随线程清理，seq 从 MAX+1 续接）。
`patch_fail`（2026-08-22 kind 扩展，零 DDL 变更）：`patch_apply_end` 且 `success=false` →
记一行（`command`=目标文件列表（`changes` 键，截断 500；空则回退 `call_id` 配对输入），
`detail`=`stderr` 截断 1000）；`success` 字段缺失时 fail-closed 不计（低估方向）。
注意 `patches` 计数口径不变——**仅计成功**（历史失败 patch 此前完全盲区，现可在明细表查得）。
查询层派生（不落盘防漂移）：wall_ms、TTFM（首有效文件修改 − 首事件）、子代理并发峰值
（estimated）、wait 时长双口径（**v1.4**：实测 `wait_call_ms`=tool_events 中 name∈WAIT_ACTIONS
的 call↔output 差之和，UI 优先展示；折算 `wait_ms_est`=Σ轮耗时×wait 采样占比，estimated，
保留进脚注）、no-progress 预警（heuristic）。
**v1.4 任务详情当日切片**（`/api/task/:id?day=YYYY-MM-DD`）：消耗/采样用 `daily_usage`
（与今日视图同源 native 口径）；工具行为/失败/wait 实测用 ts_ms 当日过滤；轮按 started 归日；
rebroadcast/输出量当日不入账 → null；TTFM/三层口径仅总计。快照 SQL 补
`model_context_window` 读取（v1.4 修复：此前查询层漏 SELECT 该列致 UI 恒 0%）。
查询层明细（同不落盘）：turn 级 `patch_files`/MCP/shell 失败列、任意线程 turn 下钻
（`/api/turns`）、全库失败总览（`/api/failures`）、`schema_issues` 逐字段明细（含未达
fail-closed 阈值的零星异常）、G0-A 差异清单（带任务名，上限 200）。

`classification_version = "fork-v2"`；跨 run 崩溃安全：分类器状态/daily/offset 同一事务提交
（每轮 `flushThread`），文件 epoch 采用软封存（同文件续读重开，跨文件转正）。

## 10. 已知限制（诚实清单）

- `exec` 型 sleep 轮询不计入 wait/status（漏检方向，G0-C 校准后修订 `WAIT_ACTIONS`）；
- fork replay 判定假设重放为**逐字前缀**（子集/乱序会在重启点提前判边界 → 偏少计方向 + 显式标注；
  实测未触发）；跨多文件的父序列按路径时间序拼接，与 Codex 序列化顺序一致的假设未形式化证明；
- legacy/unresolved 降级路径下 fork 不扣减（偏多计方向，`verification_status` 显式标注，authoritative=false）；
- replay 事件的 wait 语义分类不可考（悬置事件迟判为 native 时只补 samples，不计 wait）；
- 离线无法 100% 判定线程存活（`possibly_active` 为启发式；实时状态需 app-server `thread/list`，二期）；
- transport 级重试（429/重连）离线不可见，仅在 `--network-diagnostics` 诊断模式可得；
- 与官方面板的残差（如 8/21 的 ~2.78M）记为 unresolved reconciliation gap（chat-level 与
  billing-level 口径不同），不作为本地 parser correctness 验收标准。
