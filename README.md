# Codex Desktop Task Ledger

只读、零侵入的 ChatGPT Desktop — Codex View 任务与 Token 观测器 + Level-0 Benchmark Harness。

> 📄 **项目报告**：[`docs/report.md`](docs/report.md) —— 定位与架构、三层口径、
> **与 Codex 官方统计量差异的取证结论**（compaction 不可见调用 / 账号级跨 surface / 已排除项）、
> 需求满足度矩阵与优化路线图（2026-08-22，契约 v1.2）。

双轨架构（v3）：
- **TS 轨（产品主栈，P1 已落地 ✅）**：`packages/`（7 包）+ `apps/`（cli/server/web），系统 Node 原生跑 TS，
  `node:sqlite` 零原生依赖；React 仪表盘 `npm run serve` → http://127.0.0.1:8766；
  **G1 Golden：TS ↔ Python oracle 逐字段 EXACT 相等**（fixture + 全量 237 线程，见 `docs/ts-track.md`）；
- **Python 轨**（conda env `harness-stats`）：ledger oracle（已冻结，只跟 schema / 参考计算 / 验证 TS / 跑 Benchmark）+ benchmark；
- 两轨以 **Ledger Contract v1**（`collector.sqlite` schema + `metrics.json` 协议，见 `docs/protocol.md`）解耦。

## TS 轨快速开始（推荐日常使用）

```bash
npm run start        # 构建前端 + 启动仪表盘 http://127.0.0.1:8766（内嵌 10s 采集守护）
npm run update       # 仅采集（→ data/ts/collector.sqlite）
npm run golden       # G1 回归：TS ↔ Python EXACT 对比 + 幂等
npm test             # golden + 单元测试
```

## 环境要求

- 所有 Python 命令统一使用 conda 环境：

```bash
conda activate harness-stats          # Python 3.12（C:\Users\Administrator\miniconda3\envs\harness-stats）
# 或直接用绝对路径： C:/Users/Administrator/miniconda3/envs/harness-stats/python.exe
```

- 本机安装 ChatGPT Desktop（Codex View）且 `~/.codex` 有数据；git 可用。

## 克隆后的准备（本地数据不入库）

以下内容因含个人/敏感数据被 `.gitignore` 排除，克隆后需自行准备：

- `npm install`：安装 TS 轨依赖（`node_modules/` 不入库）；
- `tests/fixtures/codex-home/`：真实 Codex 会话 fixtures（G1 Golden 测试依赖，可将本机 `~/.codex` 的 sessions 拷贝至此重建）；
- `data/`：本地账本 sqlite，由 `npm run update` / `python -m ledger update` 采集自动生成；
- `environment.json`：可用 `python -m ledger env --write environment.json` 重新生成。

## 日常监控（Monitor 模式）

```bash
python -m ledger serve                  # ★ 网页实时视图：http://127.0.0.1:8765
                                        #   内嵌采集线程（20s 增量）+ 页面 5s 自动刷新
                                        #   视图：今日 / 项目聚合 / 近7天 / 任务详情（Token 树+turns）/ 状态
python -m ledger daemon --interval 30   # 常驻自动采集（无网页，仅周期增量；适合挂后台/计划任务）
python -m ledger update                 # 手动增量采集（首次全量回放，本机 234 文件约 30s，之后秒级）
python -m ledger today                  # 今天做了哪些任务、每个任务多少 Token
python -m ledger projects --days 30     # 项目级聚合（按 cwd 归组：任务数/Token/采样/wait/子代理）
python -m ledger tasks --days 7         # 近 7 天根任务
python -m ledger task <thread-id前缀>   # 任务详情：Token 树（root/子代理）、turns、诊断
python -m ledger threads --days 7       # 全部线程（含子代理归因）
python -m ledger reconcile --days 90    # 与 state DB tokens_used 对账（G0-A）
python -m ledger env --write environment.json   # 固定实验环境
```

实时性说明：Codex 每次模型响应都会向 rollout 追加 `token_count` 事件，`serve`/`daemon` 的增量 tail
会在一个采集周期内读到——**正在进行中的任务约 25s 内在网页上更新 Token**。

## Level-0 Benchmark

```bash
# 自测链路（不连 ChatGPT，验证 runner/watcher/grader/metrics 管线）
python -m benchmark.runner start --task T01 --repeat 0 --simulate

# 正式 run（交互式，唯一线程绑定协议见 docs/protocol.md §7）
python -m benchmark.runner start --task T01 --repeat 1

# 聚合报告（baseline.csv + report.md + 静态 HTML report.html）
python -m benchmark.aggregate
```

正式 Baseline：6 任务 × 3 重复 = 18 runs（先 smoke 2×1 核对全链路）。
人工评分：编辑 `results/manual_scores.csv`（run_id, correctness, quality, minimalism, notes）后重新 aggregate。

## 目录结构

```
packages/       TS 轨 7 包（shared/codex-discovery/rollout-parser/task-graph/codex-state/usage-accounting/ledger-core）
apps/           TS 轨应用（cli / server / web React 仪表盘）
ledger/        Python oracle（discovery/state_reader/rollout_tail/task_graph/collector/views）
benchmark/     runner / watcher / grading / metrics / aggregate / sim_agent
tasks/T01-T06/ 任务集（task.yaml + prompt.md + repo 基仓 + grader.py + solution.patch）
results/       metrics/ raw/(gitignored) baseline.csv report.md report.html manual_scores.csv
data/          collector.sqlite（本地账本，gitignored）
docs/          protocol.md（契约）/ calibration.md（G0 校准记录）
diagnostics/   可选网络诊断插件（不在标准链路）
```

## 关键事实（本机实测，2026-08-21）

- G0-A 对账 **228/228 一致（100%）**，G0-B 复算 4/4 精确一致（scripts/validate_usage.py）；
- Guardian 52 个全部经 session_meta 归位（thread_spawn_edges 无此边）；
- 子代理 rollout 第 2 行嵌父线程 session_meta echo——文件身份只认首行（曾致误绑，已修复并回归）；
- 真实 rebroadcast 率 ≈3%（#14489 重播去重后）；wait/status 语义分类占采样 ≈3.6%；
- `state_5.sqlite` 两套并存，以 `codex doctor --json` 报告为准。
