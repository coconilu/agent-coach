# Agent Coach 验收合同

## 阻断完成条件

只有同时具备以下证据才算完成：

1. `docs/ACCEPTANCE.md` 的 mandatory 阻断项全部 PASS；条件式 H2 可以 UNAVAILABLE/BLOCKED，但必须限制发布声明。
2. 当前 Windows 主机上的干净安装、构建、测试和 Demo 成功。
3. 运行中的 Daemon、MCP、CLI 和 Dashboard 共享同一权威状态。
4. observe、prepare、guidance、plan commit、Ticket 兑换、execution epoch、complete、candidate、approval 和后续 recall 端到端成立。
5. Codex、Kimi 和 DSH 的 H1 隔离加载/发现/回滚 canary 通过；H2 真实模型按条件单独报告。
6. 浏览器 QA 验证 populated、empty、degraded、candidate review、trace、integration 和 privacy 状态，以及桌面/窄屏。
7. 独立 QA 检查真实实现并重跑命令；实现者自述不能代替 PASS。
8. 推送后读回公开仓状态，确认无私人数据、凭据、主机路径或运行 ID。

## 必需证据

| 范围 | 证据 |
|---|---|
| Core | 单元/集成输出和确定性夹具 |
| Protocol | MCP transcript 和 HTTP smoke |
| Hosts | H1 隔离 canary、版本和 sentinel 保留；可用时另附 H2 |
| UI | 浏览器截图、交互断言和概念图对比 |
| Privacy | secret/privacy scan、权限与删除读回 |
| Outcome | baseline/treatment、Plan Delta、负迁移和 fallback |
| Release | GitHub URL、visibility、Commit SHA、CI、产物 hash 和 clean status |

## 状态语义

- PASS：可观察检查已运行并满足预期。
- FAIL：结果违反合同，需要修复。
- BLOCKED：外部前置阻止验证。
- TIMEOUT、SKIPPED、UNKNOWN 都不是 PASS。
