# Agent Coach

Agent Coach 是一个本地优先、Agent 无关的“计划辅导 + 可治理记忆”控制平面，首发兼容 Codex、Kimi Code 和 DeepSeek Harness。

它不替代现有 Agent，而是在工作真正开始前补上一层可解释的经验辅导：

```text
安全只读勘察
  → Agent 提交显式计划摘要
  → 匹配相关偏好、知识、经验与流程
  → Agent 重整计划并说明采用/忽略了什么
  → 获得本轮 Action Ticket
  → 执行并记录结果证据
  → 生成候选经验，经过审核后再长期生效
```

产品目标不是保存更多聊天，而是让经过验证的经验在正确时机改变下一次计划，同时让用户看得见、改得动、删得掉、可回滚。

## 当前状态

项目处于 **M0 契约冻结阶段**。里程碑、协议、安全边界和验收清单必须先经独立复审放行，之后才允许进入业务实现。

当前没有发布“已支持”或“已经变聪明”的产品声明。

## 首发支持基线

| 组件 | 首发验收版本 | 当前证据语义 |
|---|---:|---|
| Windows | Windows 11 x64 | 阻断平台 |
| Node.js | `24.15.0` | 本机已确认，使用原生 `node:sqlite` |
| Codex CLI | `0.147.0` | 待真实 canary |
| Kimi Code | `0.38.0` | 待真实 canary |
| DeepSeek Harness | `0.1.0-rc.7` | 待真实 Bundle canary |
| TencentDB Agent Memory | Provider 合同 | 实验性；真实 roundtrip 未通过前不称“已验证集成” |

版本不匹配时只能显示 `unverified` 或 `unsupported`，不得展示绿色“已验证”。

## 三类数据严格分离

| 位置 | 允许存放 | 禁止存放 |
|---|---|---|
| 本公开源码仓 | 代码、文档、Schema、合成夹具 | 用户记忆、真实 Prompt、凭据、运行 ID、本机路径 |
| 用户运行数据目录 | Turn、候选、审计、设置、集成所有权记录 | 自动提交到本公开仓的任何内容 |
| 用户私有知识目录 | 已批准偏好、事实、经验、流程；Git 为显式可选 | 未经批准的原始聊天；任何公共远端自动同步 |

默认运行数据永远不位于源码树。私有知识只有在用户明确初始化后才能使用本地/私有 Git；“私有知识进入私有 Git”和“私有知识进入本公开 GitHub 仓库”是完全不同的行为。

## MVP 能力

- 本地 Daemon、每宿主 stdio Launcher、MCP、CLI 和经验可视化面板；
- 所有对话的轻量审视，以及副作用任务的 `prepare → commit → ticket → complete` 强辅导；
- 权威知识、候选、审计、可重建索引和外部 Provider 的清晰数据边界；
- 暂停学习、来源查看、纠错、编辑、忘记、导出、重置和 TTL；
- Codex Plugin、Kimi Plugin 和 DeepSeek Harness Bundle；
- 安装预览、读回、真实验证、失败回滚和无关配置保护；
- 无 API Key 的完整确定性验收路径；
- 有 API Key 时可显式启用外部 Memory Provider，但不改变权威边界。

MVP 明确不做：LLM Proxy、替代 Agent Harness、团队/云多租户、公共插件市场、无限期原始聊天保存、自动发布生成的 Skill。

## 契约导航

| 文档 | 作用 |
|---|---|
| [里程碑](docs/MILESTONES.md) | 串行交付阶段和每阶段门禁 |
| [系统架构](docs/ARCHITECTURE.md) | 拓扑、权威、故障与安全边界 |
| [协议](docs/PROTOCOL.md) | 六个 MCP 工具、Ticket 和错误语义 |
| [数据与隐私](docs/DATA-LIFECYCLE.md) | 存储、TTL、导出、删除与 Provider 出站 |
| [支持矩阵](docs/SUPPORT.md) | 三宿主精确版本、Hook 覆盖和 canary |
| [阻断验收](docs/ACCEPTANCE.md) | 产品定义的 Done |
| [视觉规范](DESIGN.md) | 已委托选择的 UI 方向和概念图 |

## 许可证

MIT，见 [LICENSE](LICENSE)。
