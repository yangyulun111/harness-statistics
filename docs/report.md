# Codex Task Ledger 项目报告

> 面向阅读的项目总结：定位与架构、口径定义、**与 Codex 官方统计量差异的取证结论**、
> 需求满足度评估、优化路线图。数据截至 2026-08-22（契约 v1.2）。

## 1. 概述

本工具是一个**零侵入的 Codex 任务级观测账本**（Codex Task-level Observability Ledger），
目标是把散落在 `~/.codex` rollout 事件流里的原始数据，整理成完整的因果链：

```
Task → Agent/Turn → Model Calls → Tools/Wait → Context → Tokens → Time → Result
```

看到"这个任务用了 8M token"时，能进一步回答：其中多少来自子代理、多少是 wait/status
空转、发生了几次 compaction、峰值上下文多少、工具输出多大、最终是否成功。

- **双轨架构**：TS 产品主栈（`packages/` + `apps/`，日常使用）+ Python 冻结 oracle
  （`ledger/`，基准守护）。两轨以 `collector.sqlite` 契约（v1.2）解耦，Golden 测试要求
  两轨对同一输入产出**逐字段 EXACT 相等**的账本。
- **零侵入**：对 `~/.codex` 只读（rollout 增量 tail + state DB 只读快照），不写任何 Codex 文件，
  不依赖 Codex 代码改动，升级不破坏。
- **崩溃安全**：分类器/账目状态与 rollout 断点 offset 在同一事务提交，任意时刻中断可续。

## 2. 核心口径（三层指标）

| 层 | 定义 | 用途 |
|---|---|---|
| L0 raw | token_count 累计毛差分（含 fork 继承前缀） | 观测上限、与 state DB 对账（G0-A） |
| L1 native | raw − replay（fork-v2 结构化分类器剥离继承重放，组件级 input/cached/output） | **消耗口径**（日用量、任务域） |
| L2 经济层 | credits 估算（pricing_rules，可选未做） | 成本分析 |

- `native_total` = 跨计数 epoch 正增量求和（canonical，落盘）；日消耗 = daily 毛差分 − replay，
  与 Codex 官方每日用量同语义、按事件时间戳归日。
- fork-v2 分类器：父前缀**位置匹配**（六字段元组逐位比对），时间戳不参与主判定；
  详见 `docs/protocol.md` §3。
- **可信度体系**：schema 兼容 fail-closed（关键字段缺失/变型 → `authoritative=false`）、
  `classification_version`、estimated/heuristic 指标显式标注（见 §4 矩阵"口径标注"列）。

## 3. 与 Codex 官方统计量不同的原因（专节）

### 3.1 对账矩阵（本机 vs 官方面板）

| 日期 | 本工具 native | token-monitor（独立解析器） | Codex 官方面板 | 差异 |
|---|---|---|---|---|
| 2026-08-17 | 791,525 | 791,525 | – | – |
| 2026-08-19 | 31,206,419 | 31,206,419 | – | – |
| 2026-08-20 | 1,352,112 | 1,352,112 | **8,497,000** | 官方为本地 6.28× |
| 2026-08-21 | 39,076,396 | 39,076,396 | **41,854,000** | +7.11% |
| 累计 | 78.96 亿（native 全库） | – | 83.5 亿 | +5.7%（系统性） |

本工具与 token-monitor（另一套独立实现的本地解析器）在上述各日**逐位相等**，
按模型分摊（sol 34,660,476 / terra 4,415,920）也逐位一致——即差异不在解析层。

### 3.2 三类根因

**① compaction 摘要调用：真实计费、本地不可见（约占 8/21 残差的 1/3）**
上下文压缩时 Codex 发起一次独立的模型请求（把 ~200–250K 全上下文重发做总结），
该请求计入服务端计费，但**不进 token_count 累计**（取证：`compacted` 标记前后累计平滑衔接、无跳变）。
8/21 真实发生 4 次（父线程 ×3 + terra 线程 ×1），用量只能估算：输入 ≈ 压缩前末笔请求 input
（898,221，±2%）；输出经「压缩后首请求 input − 保留项」间接估 ≈ 49,946（±20%，摘要正文为
encrypted_content 不可读）。**合计 ≈ 0.95M**。

**② 账号级跨 surface 用量（8/20 残差的主体）**
官方面板按**账号全局**统计（desktop/IDE/CLI/web/云任务/所有设备合计，见官方
[rate card](https://help.openai.com/en/articles/20001106-codex-rate-card)），
不写本机 `~/.codex/sessions` 的活动本地完全看不到。8/20 官方多出的 ~7.14M 经穷尽排查
（Windows `~/.codex`、全部 3 个 WSL 发行版、桌面端 state 库、token-monitor 当天实时计数）
确认**不在本机任何位置**。实锤样本：WSL `Ubuntu-22.04` 里有独立 Codex 安装，
8/18 有一段 4,108,101 token 的会话（本地 Windows 与 token-monitor 均为 0，官方会计入）。
旁证：官方 8/20 活动时长 10h55m，本机事件窗口仅约 4 小时。

**③ 已排除的解释**（均有取证，详见 `docs/calibration.md`）：
fork replay 双计（重放无 API 调用，不可能进官方计费；且 L1 已剥离）、时区/日界
（8/20 最后活动 20:04、8/22 最早 08:50，UTC 日与本地日窗口完全相同）、组件口径
（`total = input(含 cached) + output`、reasoning ⊆ output、`cache_write ≡ 0`）、
429/重试（`logs_2.sqlite` 当日零记录）。

### 3.3 结论

差异是「**账号级计费口径 vs 本机 chat-level 口径**」的结构性差异，不是统计 bug。
官方每日面板**不能**作为本地解析器的验收 oracle；本工具度量的是"这台机器上 Codex
的真实消耗"，这正是任务级评测（per-task attribution）需要的口径。全库 +5.7% 的系统性
残差与本节 ① 的量级一致，说明账号用量的主体一直在这台机器上，覆盖是接近完整的。

## 4. 需求满足度评估

对照外部需求文本（"Codex Task-level Observability Ledger" 十类指标 + P0/P1/P2 清单），
当前实现状态（契约 v1.2，2026-08-22）：

| 需求类别 | 状态 | 说明与证据 |
|---|---|---|
| 1 任务身份（ID/名称/项目/git/model/effort/CLI/状态） | ✅ 完整 | 名称四级优先级链（云端摘要→name→title→首条消息清洗）；git/sandbox/approval（v1.2） |
| 2 Token 组件（六组件+三层+turn 级） | ✅ 完整 | input/cached/cache_write/output/reasoning/total；L0/L1；turn 差分 |
| 3 Root vs Subagent / 任务域 | ✅ 完整 | task_usage 视图 + fork native 口径 + 子代理按模型拆分 |
| 4 Turn 级 Token | ✅ 完整 | turns 表 token 五项 + active turn 运行时差分 |
| 5 采样/编排（samples、wait/status、duplicate） | ✅ 完整 | wait 语义分类（完成段 action ⊆ WAIT_ACTIONS 且无 patch）；rebroadcast；命名边界见 §6 已知限制 |
| 6 上下文/缓存 | ✅ 完整 | peak_context（=max(last_token_usage)，不与累计混同）、占用率、compactions、缓存命中率 |
| 7 子代理编排 | ✅ 基本完整 | 数量/树/深度/token/model/个体状态（v1.2）；**并发峰值**（v1.2，estimated） |
| 8 工具行为 | ✅ 基本完整 | 四类工具调用、输出字节、patches、web 搜索（v1.2 展示）；**MCP 一等计数含成败（v1.2）**；**shell 失败（v1.2，estimated）** |
| 9 性能时间 | ✅ 基本完整 | turn duration/TTFT；**TTFM、wall time、wait 时长估算（v1.2，派生/estimated）** |
| 10 数据可信度 | ✅ 完整 | schema fail-closed、classification_version、estimated/heuristic 显式标注、G0-A/G1 对账 |
| 质量/Benchmark（tests/grader/TokensPerSuccessfulTask） | ⚠️ 部分 | 协议已定义（protocol §7–8）、benchmark_runs 表就绪；正式 Baseline 未跑 |
| 错误与稳定性（retry/no-progress/runaway） | ⚠️ 部分 | turn status/had_error/abort_reason；no-progress 预警（v1.2，heuristic）；retry 仅 rebroadcast 近似 |

**P0 清单（14 项）：11 项完整 + 3 项部分**（任务级失败判定依赖末 turn 状态、工具失败区分
在 v1.2 后完整、Benchmark 质量环未闭环）。日常监控与 Level-0 数据采集需求**已满足**。

## 5. 本轮优化（v1.2，已落地并验证）

1. **契约 v1.2**（双轨逐字镜像 + golden + 全量重建）：
   `threads +sandbox_policy/approval_mode`（state DB 权威 + turn_context 兜底）；
   `threads_diag/turns +mcp_calls/mcp_failures/shell_failures`；
   `meta.schema_version=2`。
2. **解析**：`mcp_tool_call_end` 一等计数（自包含 server/tool/Ok|Err）；shell 失败启发式
   （输出内嵌 JSON 的 `exit_code≠0`，不可解析不计 → **低估方向，标注 estimated**）；
   **失败明细 drill-down**：`tool_failures` 事件表（kind=shell_exit|mcp_err，exit_code、
   经 `call_id` 配对的失败命令文本、输出/错误片段），TaskDetail 可直接查看具体失败。
   实测全库 118 条 shell 失败明细（如 8/22 PPT 任务 turn15 的 node 脚本 exit=1 及完整命令）。
3. **查询层/UI（TaskDetail/StatusView）**：TTFM、wall time、wait 时长估算（estimated）、
   MCP 调用/失败、shell 失败、web 搜索、并发峰值（estimated）、子代理个体状态、
   originator/sandbox/approval 展示；**no-progress/runaway 预警**（heuristic）。
   同时修复 snapshot 漏选 diag 列导致 tool_calls/patches 一直显示 0 的老 bug。
4. **验证**：`npm test` 6/6（含新 fixture caseM 断言）；`compare-full` PASS（含新列）；
   G0-A 260/260（100.000%）；fork-verify 不变量 0 违例、8/21 取证逐位；
   真实库 sandbox/approval 261/261 覆盖、全库 mcp_calls=696、shell_failures=118。
5. **v1.2 增补（同日）——"有计数无案例"问题全面闭环**：
   - **修复 Day 视图路由 bug**（失败明细此前不可达的直接原因）：day 视图点任务生成
     `#/day/<线程ID>` 被当日期 → 详情页永不挂载；现支持 `#/day/<日期>/<线程ID>`；
     Day/Tasks 列表新增「失败」列（红色 badge），失败可发现。
   - **patch_fail（kind 扩展，零 DDL）**：`patch_apply_end success=false` 落明细表
     （文件列表 + stderr）；`patches` 口径不变（仅成功）——历史失败 patch 此前**完全盲区**，
     重建回填 13 条（如 PPT 任务 turn7 经 WSL 路径写文件失败）。
   - **零成本明细**：turns 表 +patch_files/MCP/失败列/cached·reasoning；子代理 turns 下钻
     （`/api/turns` + 选择器）；状态页全库失败总览（`/api/failures`，可点击进任务）；
     schema 异常逐字段明细（`schema_issues` 列此前无查询读取，零星异常完全不可见）；
     G0-A 差异清单带任务名可点击（20→200）；warnings 附时间戳。
   - 需求映射：Tool 层"per-tool success/failure + 具体案例"、结果层"失败可查"从部分→完整。

## 6. 路线图（后续批次）

| 批次 | 内容 | 备注 |
|---|---|---|
| 3 覆盖面 | WSL discovery（`\\wsl.localhost\*\home\*\.codex\sessions` 纳入，source 标注） | §3.2 ② 的直接对策；token-monitor 亦未覆盖 |
| 4 Benchmark 闭环 | benchmark_runs TS 接入 + tests/grader + TokensPerSuccessfulTask | Level-0 正式 Baseline |
| 5 采样校准 | G0-C：usage_bearing_samples ↔ logs_2.sqlite 1:1 对照；通过后评估更名 model_calls | 采样数目前是 estimated 语义 |
| 6 实时观测（P2） | 只读 app-server / rawResponse exact per-sample usage | 摆脱采样近似 |

**已知限制（诚实清单）**：`usage_bearing_samples` 为采样推导（estimated，G0-C 待校准）；
wait 分类依赖 `WAIT_ACTIONS` 白名单（exec 型 sleep 轮询漏检方向）；shell_failures 低估方向；
跨 epoch 线程的 final_total 为末 epoch 值（native_total 才是 canonical）；
fork 非逐字前缀（子集/乱序）会提前 divergence → 偏少计方向。

## 7. 附录：验证证据摘要

| 验证 | 结果 |
|---|---|
| G1 双轨 Golden | fixture 一次性 + 增量幂等，四表逐字段 EXACT；fork 矩阵 19 线程两阶段 + 断点续读 |
| G0-A 对账 | ledger final_total ↔ state DB tokens_used：260/260 完全相等（100.000%） |
| G0-B v2 fork 覆盖 | parent_prefix/verified 93 + none/verified 19；legacy/unresolved/parent_missing = 0 |
| 不变量 | Σ daily native == native_total 违例 0；replay 组件级恒等式违例 0 |
| 外部交叉 | 8/17、8/19、8/20、8/21 四天与 token-monitor 逐位相等（含 perModel） |
| 8/21 取证 | fork 01a023e9 baseline=37,901,458 / replay=37,901,458 / native=1,076,756，与逐事件取证一致 |

详细取证过程见 `docs/calibration.md`；计算规则与契约见 `docs/protocol.md`。
