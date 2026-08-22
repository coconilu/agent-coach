# M4 效果与性能验收

Agent Coach 的“越来越聪明”必须表现为可复现的计划改善，不能用“保存了记忆”代替效果证据。

## 一条命令

先完成锁定依赖安装和构建，再运行真实 Core 评测：

```powershell
pnpm install --frozen-lockfile
pnpm build
node scripts/run-outcome-eval.mjs
```

默认报告写入 `.artifacts/qa/outcome-report.json` 和 `.artifacts/qa/outcome-report.md`。输出不得包含本机目录、凭据、真实 Session/Turn ID 或用户知识。

评测器自身可用下列命令验证，但结果会明确标记 `HARNESS_ONLY`，不能作为产品 PASS：

```powershell
node scripts/run-outcome-eval.mjs --adapter tests/outcome/fixture-adapter.mjs --allow-failures
```

## 固定场景

| 类别 | 数量 | 要证明什么 |
|---|---:|---|
| 相关任务 | 3 | 偏好、失败经验、发布流程在动作前形成正确 Plan Delta |
| 不相关控制 | 3 | 文档、视频、数据库的无关记忆不会被提升成当前约束 |
| 冲突 | 1 | 两条冲突事实只进入 conflicts，不进入 constraints |
| Provider 故障 | 1 | 外部 Provider 不可用时仍使用本地 canonical，并明确 degraded |

首个相关场景分别以 Codex、Kimi Code 和 DeepSeek Harness 身份执行，因此逻辑场景是 8 个，实际运行是 10 次。全部数据来自 `tests/outcome/scenarios.v1.json`，只包含合成内容。

## 阻断阈值

| 指标 | 阈值 |
|---|---:|
| Treatment 完成率 | 不低于 Baseline |
| 三个相关任务的正确 Plan Delta | 至少 2/3 |
| 三个控制任务负迁移 | 0 |
| 1000 条合成记忆下 keyless prepare P95 | ≤ 300 ms |
| 单次 Guidance | ≤ 8 项，估算 ≤ 1200 tokens |

P95 使用 10 次预热后的 50 次独立 prepare 样本。`TIMEOUT`、缺样本、Adapter 未调用真实 Core 或运行异常均不得转换成 PASS。

## 报告字段

JSON 报告保留以下审计链：

- baseline/treatment 完成状态；
- 检索到的合成 Memory ID、约束注入、冲突隔离；
- Before/After Plan 和正确 Plan Delta；
- 负迁移；
- prepare P50/P95/P99、Guidance 数和 token 估算；
- 每个门禁的实测值、阈值和 PASS/FAIL。

只有 `evidence_kind=CORE_RUNTIME` 且总状态为 `PASS` 才能用于 M4 验收。
