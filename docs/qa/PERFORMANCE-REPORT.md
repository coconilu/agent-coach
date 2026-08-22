# M4 Core 效果与性能报告（本地快照）

状态：**PASS（Core runtime，本地工作树）**。

这份快照证明当前 Core 在合成确定性夹具上满足 M4 阈值；它不是独立 QA、GitHub Actions 或三宿主真实 CLI canary 的替代品。发布时应以同一命令在目标 Commit 和 Windows CI 上重新生成 Artifact。

## 运行证据

| 项目 | 实测 |
|---|---|
| 日期 | 2026-08-23 |
| 平台 | Windows NT 10.0.26200 x64（系统 API 报 `Windows 10 Pro`；不据此声称已完成 Windows 11 clean-run 验收） |
| Node.js | 24.15.0 |
| pnpm | 10.18.3（frozen lockfile） |
| Adapter | `CORE_RUNTIME`，直接调用构建后的 `AgentCoachCore` |
| 合成记忆 | 1000 条 |
| prepare 样本 | 10 次预热 + 50 次计量 |
| 命令 | `pnpm build` 后运行 `node scripts/run-outcome-eval.mjs --samples 50 --warmup 10` |

## 指标

| 指标 | 实测 | 门禁 | 状态 |
|---|---:|---:|---|
| Baseline 完成率 | 60.0%（6/10 runs） | Treatment 不低于 Baseline | PASS |
| Treatment 完成率 | 100.0%（10/10 runs） | ≥ Baseline | PASS |
| 相关任务正确 Plan Delta | 3/3 logical scenarios | ≥ 2/3 | PASS |
| 不相关控制任务负迁移 | 0/3 | 0 | PASS |
| prepare P50 | 22.006 ms | 仅报告 | PASS |
| prepare P95 | 24.618 ms | ≤ 300 ms | PASS |
| prepare P99 | 25.991 ms | 仅报告 | PASS |
| 最大 Guidance 数 | 2 | ≤ 8 | PASS |
| 最大估算 tokens | 103 | ≤ 1200 | PASS |

额外门禁均通过：同一偏好以 Codex、Kimi Code、DeepSeek Harness 三种 Host identity 召回；冲突事实只进入 conflicts；Provider outage 保留 canonical fallback 并记录 degraded；obsolete、rejected、conflicting、superseded 条目没有进入约束区。

## 解释边界

- “10 runs”来自 8 个逻辑场景，其中跨宿主偏好场景以三个 Host identity 各跑一次。
- Baseline 结果由固定夹具声明；Treatment 只有在 required recall/conflict 成立、无 forbidden constraint，且完成 `prepare → commit → healthy gate → complete` 后才算成功。
- Plan Delta 由确定性策略根据命中 ID 生成，因此这里衡量的是检索、隔离、预算和生命周期是否能稳定改变计划，不是对任意 LLM 智能提升幅度的估计。
- 三个 Host identity 经过同一 Core 协议不等于真实 Codex/Kimi/DSH 插件已经通过 H1；真实宿主装载和 Hook canary 属于 M3 独立证据。
- 耗时是本机单次快照。CI、目标 Commit 或依赖变化后的结果可能不同；超时、缺样本或 `HARNESS_ONLY` 结果都不得沿用本 PASS。
