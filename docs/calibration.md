# 校准与对账记录（G0 / G1 / G4）

## 契约 v1.2 第三次重建（patch_fail kind 扩展，2026-08-22 深夜）

背景：失败可发现性修复（Day 视图路由 bug + 列表失败列）+ patch 失败采集盲区补齐
（`patch_apply_end success=false` → `tool_failures` kind=patch_fail，零 DDL、SCHEMA_VERSION 不变）。
备份逐文件 `cp`（`*.bak-v1.2-pre-patchfail`，无通配符），serve 停机约 6 分钟。

| 项 | 结果 |
|---|---|
| `npm test` | 6/6（caseM 扩展 patch 三态：成功/失败/success 缺失；v12 断言含 patch_fail 行与 turn patches=1） |
| compare-full | PASS（`tool_failures` 全表 py=ts=**131** 行：118 shell_exit + **13 patch_fail 历史回填**，如 01a0193d turn7 WSL 写文件失败） |
| G0-A | 260/260 完全相等（100.000%），Σ=18,205,772,266 |
| fork-verify | 不变量 0 违例；8/21 取证逐位不变（native=39,076,396） |
| API 冒烟 | /api/status（schema_details 33 线程）、/api/failures（total=131）、/api/day（首任务失败列 shell=15）、/api/task/01a0193d（18 行明细、11 轮 patch_files）、/api/turns?thread_id=（子代理 1 turn） |
| 浏览器 GUI | Day 失败列（✗15/✗2）✓；深链 `#/day/<日期>/<线程ID>` 浮层挂载 ✓；Turns 新列（MCP/失败/补丁/·N文件）✓；子代理 turns 下钻（选择器→"Turns（子代理 · 1）"）✓；失败明细 18 行（15 shell+3 patch）✓ |

**两次 UI 路由缺陷修复（诚实记录）**：① 原生 bug——Day 视图 `openTask` 生成
`#/day/<线程ID>` 被当日期，任务详情永不挂载；② 第一版修复引入的回归——`parseHash` 用
`h.split("/")` 解构只取第二段，`#/day/<日期>/<线程ID>` 的线程 ID 被丢弃，深链浮层不挂载。
②由浏览器验证发现（深链后浮层未开），已改为 `indexOf("/")`+`slice` 保留完整余段并复验通过。
浏览器端"点击任务行"的 Playwright 点击因 5s 轮询重渲染稳定性检查超时未完成，但点击处理器
`openTask` 生成的 hash 与已验证的深链格式逐字一致，属同一代码路径的等价验证。
另：用户反馈失败明细"看不到"实为排序问题（原排在子代理表后需滚动两三屏），已提前至统计卡片
正下方（DOM 顺序 失败明细 6734 < 子代理 22808 < Turns 24601）。

**运维事故（2026-08-23 晚）**：助手侧后台 serve 与用户自启的 `npm run serve` 形成双实例，
两个采集 daemon 每 10s 并发写同一 `collector.sqlite`，后台实例 daemon 连续 3 次
`database is locked` 后进程退出（exit 1）。用户实例存活并独占端口 8766，复验健康：
`/api/status` schema_version=2、`last_update_ms` 每 ~10s 前进（daemon 恢复采集）、
`/api/failures` total=131、`/api/task/01a0193d` 明细 18 行（15 shell + 3 patch，含子代理 2）。
**约定：同一时刻只跑一个 serve 实例**（写库互斥）；启动时端口/单实例守卫与
busy_timeout 属后续改进，未实施。

## 契约 v1.2 重建验证（2026-08-22）

停 serve → 双库全量重建（v1.2 当日两次：列扩展 + `tool_failures` 明细表）后全链路复验：

| 项 | 结果 |
|---|---|
| `npm test` | 6/6（fork 矩阵 golden 含 **caseM**：turn_context sandbox/approval + mcp Ok/Err + 内嵌 exit_code 三态 + **失败明细行断言**（配对命令/exit_code/detail 逐字段），双轨 EXACT + v12 sidecar 断言） |
| compare-full | PASS 逐线程逐字段一致（列集含 v1.2 列 + `tool_failures` 全表 py=ts=118 行完全一致） |
| G0-A | 260/260 完全相等（100.000%） |
| fork-verify | 不变量 0 违例；8/21 取证逐位不变（native=39,076,396 / replay=37,901,458） |
| 真实库抽查 | sandbox/approval 261/261 覆盖；全库 mcp_calls=696、shell_failures=118（明细行含配对命令与输出片段，如 01a0193d turn15 的 node 脚本 exit=1） |

`shell_failures`/`tool_failures` 为低估方向启发式（输出截断/格式变化不计），estimated 标注，不进 authoritative。
**事故记录（诚实）**：当日重建前的备份操作误用通配符 `rm collector.sqlite*`，将
`data/{,ts/}` 下的现库与历史备份（.bak-v1 / .bak-v1.1）一并删除。数据源 `~/.codex` 只读未动，
双库随即全量重建并通过上述全部验证（G0-A 100% 复现），信息损失限于历史备份文件本身；
`py-full-oneshot.sqlite`（8/21 一次性全量副本）幸存。教训：备份删除禁用通配符、先 `ls` 确认再删。

## G1 TS ↔ Python Golden Contract（v1.1 全量复验 ✅ 2026-08-22）

双轨等价性证据（详见 `docs/ts-track.md`）：

| 验证 | 范围 | 结果 |
|---|---|---|
| Fixture Golden（`npm run golden`） | 8 个真实 rollout fixture（根/子代理/fork/自声明 parent/大文件） | threads/diag/turns/daily_usage/rollout_files 逐字段 **EXACT 相等** + 增量幂等 |
| fork 矩阵 Golden（`tests/fork-golden.test.ts`） | 13 类合成场景：43ms 重放、跨秒重放、重放+native 同秒、保留历史时间戳跨日、单一继承快照、无 replay、父缺失 legacy、unresolved、迟到父 refold、嵌套 fork、unchanged 重发、计数器 reset、replay 中途断点续读 | 两阶段双轨 **EXACT** + 期望标注 sidecar 逐字段命中 + 幂等 + 断点 ≡ 一次性 |
| 全量回放对照（`scripts/compare-full.ts`） | 真实 ~/.codex 全历史：259 文件 / 425,884 事件 / 259 线程（契约 v1.1 重建后） | 逐线程逐字段 **PASS**（Σ final_total 18,072,801,039、Σ replay 10,176,933,718、Σ native 7,895,867,321 全等；恒等式 raw = replay + native 成立） |

已知口径细节：长期增量库在 ingest run 边界可能少计一次 wait 语义分类（全库实测差 1/4423，
`segment_tools` 不跨 run 持久化所致）；一次性回放无此差异，Golden 以一次性回放为准。

## G0-A Parser Reconciliation（已完成 ✅ 2026-08-21；v1.1 重建后复跑 ✅ 2026-08-22）

```
对账窗口 90 天：一致(≤1%) 228  超差 0  未采集到rollout 7     （2026-08-21）
v1.1 全量重建后复跑：final_total vs state tokens_used 完全相等 259 / 超容差 0（scripts/fork-verify.mts）
```

- **228/228 = 100% 一致，零超差**；7 个无 rollout 的线程为 archived/迁移残留，非解析错误；
- v1.1 重建后 259/259 完全相等——epoch 感知规则未破坏 raw 口径对账；
- 注意：G0-A 对账的是 **raw 观测累计（final_total）**，它含 fork 继承前缀（state `tokens_used`
  本身就是 lifetime 累计，openai/codex#38154），因此 G0-A **结构上无法发现跨线程 replay**——
  这是 v1.1 之前 fork 重复计入 97% 未被察觉的根本原因。

## G0-B v2 Fork Replay Attribution（契约 v1.1 ✅ 2026-08-22，取代旧启发式）

### 取证（外部质疑成立，证据链）

- 8/21 fork `01a023e9`（父 `01a0193d`）：341 条 token_count 中 **324 条压缩在 43ms 内**，
  累计 27,049 → 37,901,458，与父前 324 条累计值**逐位相同**（= 父在 fork 时刻高水位）；
  其后仅 17 条原生事件 ≈1.08M，与 token-monitor ≈1.08M 吻合；
- 8/02 样本同签名（2,783 条 / 2 秒 replay 354.06M，原生 7.32M）；
- 旧实现 `inherited_baseline` 取子文件**首条**累计值（= 父会话起点计数 27,049，而非
  fork 时刻高水位 37,901,458）→ 97.3% 重复计入；
- 外部佐证：openai/codex#35463（replay 逐字复制祖先记账）、tokscale#681/#651、
  ccusage fork baseline 方案与 #1460/#1501（跨秒重放误计）。

### v2 判定链（时间戳不参与主判定；EOF 与时间 gap 都不是边界）

1. **父前缀位置匹配（主）**：六字段元组逐位比较，子第 i 个增长快照 == 父第 i 个 → 继承前缀；
   首个不等 = 边界；匹配长度 0 且父可达 → 阳性无 replay（method=none）；
2. 父文件缺失 + 起始密集聚簇（≤1s）→ legacy_time（unverified 降级）；
3. 父文件缺失且无签名 → unresolved：**不扣减**，baseline=0；
4. 迟到父：end-of-ingest 延迟复核 pass 对该线程整体重折叠（refold）。

### 验证结果（`scripts/fork-verify.mts`，2026-08-22 全量重建后）

| 项 | 结果 |
|---|---|
| 覆盖表 | parent_prefix/verified 93 个（replay 10,176,933,718）；none/verified 19 个；**legacy/unresolved/parent_missing = 0**（全部 fork 父文件在本地，结构化匹配全覆盖） |
| 8/21 取证对照 | fork 01a023e9：baseline=37,901,458 ✓ replay_total=37,901,458 ✓ native_total=1,076,756 ✓ raw=38,978,214=replay+native ✓ |
| 不变量 | 250 线程 Σ daily native == native_total 违例 0；replay 组件级违例 0 |
| 外部交叉（sanity，非 oracle） | 8/17、8/19、8/20、8/21 四天日消耗与 token-monitor **逐位相等**（791,525 / 31,206,419 / 1,352,112 / 39,076,396） |
| 与官方面板残差 | 8/21 官方 41,854,000 − 本地 native 39,076,396 ≈ 2.78M，取证见下节「官方面板差距取证（2026-08-22）」，**不作为本地 parser correctness 验收标准** |

## 官方面板差距取证（2026-08-22）

8/21 三层对账：本库 native 39,076,396 ≡ token-monitor（逐位，perModel sol 34,660,476 / terra 4,415,920 亦逐位）
＜ 官方面板 41,854,000，差 +2,777,604（+7.11%）。

**已排除**（均有证据）：
- fork replay 双计（replay 已剥离，且重放无 API 调用，不可能进官方计费）；
- 日界/时区（8/20 最后活动 20:04 本地、8/22 最早 08:50 本地 → UTC 日与本地日窗口完全相同；PST 会得到 ~50M+ 量级）；
- 组件口径（rollout `total = input(含cached) + output`，reasoning ⊆ output，`cache_write ≡ 0`；Σ reasoning 8/21 ≈ 233K ≪ 差距）；
- 429/重试/流中断（logs_2.sqlite 当天仅 2 ERROR / 21 WARN，全为良性：PowerShell snapshot、未知模型元数据、hook）。

**已定位的真实差异源（部分）**：**compaction 摘要调用不进 token_count 累计**（取证：COMPACT 标记前后累计平滑衔接、无跳变），
但它是真实模型请求（重发全上下文做总结），计入服务端计费。8/21 真实 compaction 4 次
（父 01a0193d ×3：210,405/208,752/243,316；terra 019ff8f3 ×1：231,135）。用量**只能估算**（摘要正文为 encrypted_content 不可读）：
输入 ≈ 压缩前末笔请求 input（±2%）计 **898,221**；输出经「压缩后首请求 input(33,118/33,703/33,578/27,713) − 保留项」
间接估计 ≈ **49,946**；**合计 ≈ 0.95M（0.93–0.97M），占差距 ~34%**。属诊断估算，不进 native 口径。
注意：fork 子文件里的 3 个 COMPACT 标记是重放的父历史标记（43ms 突发内），非新调用。

**剩余 ~1.88M 本地不可证**，两个候选：(a) 同类服务端计费但 rollout 不可见的内部调用（标题生成/prewarm/ambient 等，单次小）；
(b) **账号级跨 surface 用量**——官方面板按账号计（desktop/IDE/CLI/web/cloud 合计，见
[rate card](https://help.openai.com/en/articles/20001106-codex-rate-card)），web/cloud/其他设备不写本机 `~/.codex/sessions`。

**可证伪预测**（官方面板 30 秒可验）：8/17 官方应 ≈ 791,525、8/20 应 ≈ 1,352,112（当天零 compaction）；
8/19 应 ≈ 31,638,831（31,206,419 + 432,412 两次 compaction）；8/18 本地为 0，官方若 > 0 即证明存在跨 surface 用量。

## 8/20 官方 849.7万 vs 本地 1.35M 取证（2026-08-22 续）

用户读数：官方「Token 活动」热力图 8/20 = **849.7万**（累计 83.5亿）。本地 = 1,352,112 ≡ token-monitor
（当天 perClient 仅 codex=1,352,112，claude/zcode=0）。差 +7,144,888（6.28×）。

排查结论：**这 7.14M 不在本机任何位置**——
- 8/20 零 compaction（compaction 解释贡献 0）；时区/日界不可能（8/19 活动 20:09 止、8/20 活动 15:59–20:05、8/21 活动 10:55 起，任何边界偏移凑不出 849.7万，且与官方 8/21=41.85M 矛盾）；
- WSL 全查：`Ubuntu-22.04` 有独立 Codex（8/04 会话 3,357,721 + 8/18 会话 4,108,101 token），**最后活动 8/18 00:05**；
  `Ubuntu-20.04`/`docker-desktop` 无 `.codex`；state_5.sqlite/session_index 无 8/20 额外线程；
- token-monitor `wslStatus=not-installed`（不监控 WSL），其 8/04=46,669,097 与 Windows 本地相等 → 两个解析器都漏 WSL。

**跨 surface 实锤样本**：WSL 8/18 会话 4,108,101 token（本地 8/18=0、token-monitor 8/18=0，官方按账号计会包含）
→ 悬停官方热力图 8/18 若 ≈410万 即验证「官方=账号全局、本工具=本机 Windows rollout」口径。

**全局一致性**：官方累计 83.5亿 vs 本地 native 全库 78.96亿（**+5.7%**，≈ compaction+服务端杂项的系统性差）
→ 历史用量主体在本机；8/20（+528%）为孤例离群日，当天 ~7.14M 发生在 Codex web / 云任务 / 其他设备
（官方活动时长 10h55m vs 本机 ~4h 窗口佐证）。可选改进：ledger discovery 纳入 `\\wsl.localhost\*\home\*\.codex\sessions`。

## G0-B v1 Exclusive Usage Attribution fixtures（已被 v2 取代，存档）

| 类别 | 结果 |
|---|---|
| rebroadcast 复算 | 4/4 抽样精确一致 |
| fork 继承 | 111/111 满足 0 < base ≤ 源线程累计 —— **纯合理性启发式，无法识别 replay**（"base=父历史首快照"同样满足不等式），故被 v2 结构化匹配取代 |
| subagent 继承 | 134/137 子代理首 turn 起点累计 < 1000 tokens |
| duplicate token_count | 等值重播未计入增长 |

## G0-C 采样校准（待执行）

`usage_bearing_samples` ↔ `logs_2.sqlite` post-sampling telemetry（或 app-server
`rawResponse/completed` 语义）在 3 个短任务上 1:1 对照。`logs_2.sqlite` 仅作校准 oracle
（高频 TRACE、WAL churn），不进入主 Ledger 链路。通过后：
`classification_version` 升级并评估是否将 `usage_bearing_samples` 更名为 `model_calls`。

## G4 外部 sanity check（正式 Baseline 后执行）

```bash
npx ccusage@latest codex session --since 20260821   # 社区解析器，Beta 质量
```

ccusage 只作量级对照（曾存在 duplicate TokenCount 与 fork double-counting 历史 bug，
[#897](https://github.com/ccusage/ccusage/issues/897)、[#1288](https://github.com/ccusage/ccusage/issues/1288)），
**不作 golden truth**。对照结果记录在下表：

| 日期 | ledger 总量 | ccusage 总量 | 偏差 | 备注 |
|---|---|---|---|---|
| （待填） | | | | |
