# TS 轨（P1）—— Codex Task Ledger 的 TypeScript 实现

状态：**G1 已通过**（TS ↔ Python oracle 逐字段 EXACT 相等，fixture + 全量 237 线程双重验证）。

## 为什么有两条轨

- **Python 轨（`ledger/`，冻结 oracle）**：只读参照实现 + 验证 + Benchmark 编排。不再新增功能。
- **TS 轨（`packages/` + `apps/`，产品主栈）**：长期演化的采集与可视化实现，最终进 Electron（P4）。

两条轨由 **Ledger Contract v1**（`docs/protocol.md`）约束：同一 `collector.sqlite` schema +
同一 metrics.json 协议。TS 轨产出的库与 Python 轨**可互换**，由 Golden 测试（G1）守护。

## 包结构

```
packages/
  shared/            @hs/shared          DDL 契约（与 Python SCHEMA 逐字一致）、Zod fail-closed 事件契约、时间归一
  codex-discovery/   @hs/codex-discovery doctor --json 探测 / CODEX_HOME 回退 / sessions 发现
  rollout-parser/    @hs/rollout-parser  JSONL 增量 tail（4MB 分块 / 2 万行批 / 半行保留 / 截断检测）
  task-graph/        @hs/task-graph      父子归因（session_meta > edges > source_json）、环检测
  codex-state/       @hs/codex-state     state_5.sqlite 只读（threads / thread_spawn_edges）
  usage-accounting/  @hs/usage-accounting process_line 状态机：token 差分、三分类、wait 语义段、fork 基线
  ledger-core/       @hs/ledger-core     ingest 编排 + 查询层（口径与 queries.py 一致）+ G0-A 对账
apps/
  cli/               @hs/cli             update / serve / reconcile / env
  server/            @hs/server          HTTP API + 静态托管 + Worker 线程内嵌采集（node:sqlite 不阻塞主线程）
  web/               @hs/web             React 仪表盘（今日/任务/项目/趋势/状态/任务详情）
```

运行时：系统 Node（≥23.6，本机 v25.4.0）原生跑 `.ts`（type stripping，无构建步骤），
`node:sqlite` 内置 SQLite，**零原生依赖、零全局安装**。Web 构建用 Vite（devDep）。

## 常用命令

```bash
npm run update          # 全量/增量采集 → data/ts/collector.sqlite
npm run serve           # 仪表盘 http://127.0.0.1:8766/（API + 静态 + 10s 采集守护）
npm run start           # build:web + serve
npm run golden          # G1 回归：fixture 上 TS ↔ Python EXACT 对比 + 幂等
npm test                # golden + task-graph / toMs / rollout-tail 单元测试
npm run reconcile       # G0-A：ledger ↔ state DB tokens_used 对账
npm run typecheck       # 双 tsconfig 全量类型检查
```

Python oracle 侧对应用户此前约定的 conda 环境（harness-stats）：
`conda run -n harness-stats python -m ledger update`。

## G1 证据（契约 v1.1 复验 2026-08-22）

1. **Fixture Golden**（`tests/fixtures/codex-home/`，8 个真实 rollout：普通根×3、子代理×2+父、
   fork、session_meta 自声明 parent、20MB 大文件）：
   `npm test` → threads/diag/turns/daily_usage/rollout_files **逐字段 EXACT 相等**，且第二轮增量 ingest 幂等。
2. **fork 矩阵 Golden**（`tests/fixtures/fork-home/` + `tests/fork-golden.test.ts`，`scripts/gen-fork-fixtures.mts`
   生成，13 类场景含期望标注 sidecar `expected.json`）：43ms 重放、跨秒重放（反 ccusage#1460）、
   重放+native 同秒、保留历史时间戳跨日、单一继承快照、无 replay、父缺失 legacy 聚簇、unresolved、
   迟到父 refold（两阶段：先 legacy 后结构化重折叠）、嵌套 fork、unchanged 重发、计数器 reset、
   replay 中途断点续读 ≡ 一次性 ingest。双轨两阶段 EXACT + sidecar 命中 + 幂等。
3. **全量回放对照**（`scripts/compare-full.ts`）：真实 `~/.codex` 全历史 259 文件 / 425,884 事件 /
   259 线程（v1.1 重建）TS 与 Python **逐线程逐字段完全一致**
   （Σ raw 18,072,801,039 = Σ replay 10,176,933,718 + Σ native 7,895,867,321 全等）。

## 契约 v1.2（2026-08-22）：MCP/shell/sandbox 采集 + 分析层派生

- 采集：`threads +sandbox_policy/approval_mode`（state DB 权威 + turn_context 兜底）；
  `threads_diag/turns +mcp_calls/mcp_failures`（`mcp_tool_call_end` 自包含 Ok|Err）+
  `shell_failures`（**estimated** 启发式：工具输出内嵌 JSON 的 exit_code≠0，低估方向）；
  `meta.schema_version=2`。双轨逐字镜像，golden 扩展（fixture caseM + v12 sidecar 断言）。
- **失败明细 drill-down**：`tool_failures` 事件表（kind=shell_exit|mcp_err|patch_fail，exit_code、
  配对 `call_id` 的命令文本、输出/错误片段）；TaskDetail 展示「失败明细」表；refold 随线程清理。
- 查询层派生（不落盘）：wall_ms、TTFM、子代理并发峰值（estimated）、wait 时长估算（estimated）、
  no-progress 预警（heuristic）；TaskDetail/StatusView 展示（MCP/shell/web/子代理状态/环境）。
  同时修复 snapshot 漏选 diag 列（tool_calls/patches 显示 0）的老 bug。
- 全量重建后：compare-full PASS（含新列与 tool_failures 全表 118 行）、G0-A 260/260、npm test 6/6。

### v1.2 增补（2026-08-22 晚）：patch_fail kind + 明细可见性修复

- **Day 视图路由 bug 修复**：`openTask` 在 day 视图下生成 `#/day/<线程ID>` 被当日期 → 详情页
  永不挂载（"该日无用量"）。现支持 `#/day/<日期>/<线程ID>` 双段参数，Day/Tasks 列表加「失败」列
  （shell+MCP 合计红色 badge），失败可发现性问题闭环。
- **patch_fail（kind 扩展，零 DDL/SCHEMA_VERSION 不变）**：`patch_apply_end success=false` →
  tool_failures 记一行（command=changes 文件列表截断 500、detail=stderr 截断 1000；success 缺失
  fail-closed 不计）；`patches` 口径不变（仅成功）。历史回填 13 条（此前完全盲区）。
- **零成本明细补齐（查询层+前端）**：TaskDetail turns 表 +patch_files/MCP/失败列/cached·reasoning
  tooltip；子代理 turns 下钻（`/api/turns?thread_id=` + 线程选择器，子代理表行可点击）；
  StatusView 全库失败总览（`/api/failures`，行点击进任务）；schema 异常逐字段明细（含未达阈值
  零星异常，`schema_issues` JSON 列此前无任何查询读取）；G0-A 差异清单带任务名可点击（上限 20→200）；
  线程级 warnings 附首事件时间。
- golden：caseM 扩展 patch 三态（成功/失败/success 缺失），v12 断言含 patch_fail 行与 turn patches。

## fork replay 分类器（v1.1 / fork-v2，2026-08-22）

结构化父前缀匹配为主判据（六字段元组逐位、位置对齐、时间无关；EOF/时间 gap 都不是边界）；
父缺失 → legacy 时间聚簇兜底（unverified）或 unresolved（不扣减）；迟到父由 ingest 末尾
refold pass 重折叠。父序列游标持久化（`fork_replay_json`），全部轮次合计只读父文件一遍；
分类器状态与账目、offset 同轮事务提交（每轮 flushThread）。判定结果落在
`threads.baseline_method/verification_status` + `threads_diag.replay_*/baseline_*`；
消耗口径 = `daily_usage` 毛差分 − `replay_*`（组件级）。校准证据见 `docs/calibration.md` G0-B v2
（8/21 与 token-monitor 逐位相等 39,076,396；fork 01a023e9 baseline/replay/native 与取证一致）。

### 已知口径细节

- **标题源优先级链**（2026-08-22）：`~/.codex/session_index.jsonl` 的 `thread_name`（云端摘要标题
  的本地镜像，桌面端 app-server 维护，含活跃线程）→ state `threads.title`（仅当 ≠ 首条消息，
  已同步摘要；活跃线程会被覆盖回首条消息原文，物理文件空闲页曾观察到回写后被覆盖）→
  `cleanTitle()` 清洗首条消息（提取 `## My request:`、去路径/URL、取首句、40 字截断）。
  查询层注入（`snapshot().cloud_title`），每次请求重读 session_index（46 行小文件），不改采集、
  不改契约；Python oracle 不动（标题属展示层）。
- **今日视图口径**（2026-08-22，v1.1 收紧）：主数字 = 当日实际消耗的 **native**（毛差分 − replay，
  与 Codex 官方每日用量同语义；任务域累计为任务卡次要数字）。
- **三层指标**：L0 raw（`final_*`，含继承前缀，G0-A 基准）/ L1 native（真实调用）/
  L2 credits 估算（规划中，pricing_rules 表驱动、未知模型 pricing_status=unknown）。
- **增量边界的 wait 语义段**：`segment_tools` 不跨 ingest 运行持久化。长期增量库在 run 边界
  可能少计一次 wait 分类（实测全库差 1/4423）；一次性回放无此差异，Golden 以一次性回放为准。
  （v1.1 起分类器状态/账目/offset 同事务提交，epoch 软封存跨 run 正确。）
- **已知无害分歧**（仅理论值，实测数据未触发）：非整数字符串数值、lone surrogate 的字节长度、
  JSON 序列化空格（Golden dump 已规范化）。
- **已知限制**：重放若非逐字前缀（子集/乱序）会提前判边界（偏少计 + 显式标注）；多文件父按
  路径时间序拼接；replay 事件 wait 分类不可考；≥0.147 exec-resume（#35621 不再 replay）由
  `method=none` 路径覆盖；与官方面板残差记 unresolved reconciliation gap（非验收标准）。

## 测试钩子（Python 侧最小改动）

`ledger/discovery.discover(env_codex_home, use_doctor)`：显式 home 时跳过 doctor（fixture 复现）。
`ledger/collector.ingest(env_codex_home=…)` 透传。契约 v1.1 的 fork 分类器（`ledger/fork.py`）
与 TS `packages/usage-accounting/src/fork.ts` 逐条对应，由 Golden 守护 EXACT 等价。
