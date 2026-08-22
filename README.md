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

`v0.1.0` MVP 已完成本地实现与 H0/H1 验收：Core、Daemon、MCP、CLI、Dashboard，以及 Codex `0.147.0`、Kimi Code `0.38.0`、DSH `0.1.0-rc.7` 的真实宿主加载均已通过。H2 真实模型行为仍是条件式未验收项，不能被 H1 替代。

当前确定性评测结果：Treatment `10/10`、相关 Plan Delta `3/3`、不相关任务负迁移 `0`；1000 条合成记忆下 keyless prepare P95 约 `24 ms`。这些结果证明协议与检索闭环，不代表任意模型或任意任务都必然提升。

## 首发支持基线

| 组件 | 首发验收版本 | 当前证据语义 |
|---|---:|---|
| Windows | Windows 11 x64 | 目标阻断平台；当前主机已通过，干净远端 CI 待读回 |
| Node.js | `24.15.0` | 本机已确认，使用原生 `node:sqlite` |
| Codex CLI | `0.147.0` | H1：Marketplace/Plugin/Skill/MCP/Hook/卸载 PASS |
| Kimi Code | `0.38.0` | H1：交互安装、Skill 1、MCP 1/1、卸载 PASS |
| DeepSeek Harness | `0.1.0-rc.7` | H1：tgz Bundle/配置合成/MCP/卸载 PASS |
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

## 五分钟本地体验

前置：Node.js `24.15.x`、pnpm `10.18.3`。

```powershell
git clone https://github.com/coconilu/agent-coach.git
cd agent-coach
pnpm install --frozen-lockfile
pnpm build
node dist/cli.js init
node dist/cli.js demo
node dist/cli.js start
```

`start` 会输出一个两分钟内有效的一次性 `dashboard_url`。在浏览器打开后，URL 会自动移除 nonce/CSRF 参数；Dashboard 使用 SameSite session、CSRF、Origin/Host 检查和 CSP。默认数据位于用户本地目录，不在源码 checkout 内。

常用命令：

```powershell
node dist/cli.js doctor
node dist/cli.js review
node dist/cli.js search "配置读回"
node dist/cli.js export --output agent-coach-export.json
```

## 接入现有 Agent

先保持 `agent-coach start` 运行。首次安装默认为 `advisory`；只有用户显式设置 `AGENT_COACH_MODE=enforce` 时，健康 Gateway 下的 covered write/unknown 才会拒绝未辅导动作。Hook 不是安全沙箱，Gateway/Hook 故障始终 fail-open 并显示 degraded。

### Codex 0.147

```powershell
codex plugin marketplace add coconilu/agent-coach
codex plugin add agent-coach@agent-coach
```

新建 Codex 任务，并在 `/hooks` 中审查和信任 bundled Hooks。Hosted Tool 和特殊 opt-out 路径不属于 covered gate。

### Kimi Code 0.38

GitHub Release 发布后，在 Kimi 中运行：

```text
/plugins install https://github.com/coconilu/agent-coach/releases/latest/download/agent-coach-kimi.zip
/reload
/plugins info agent-coach
```

Kimi 不接受本地 ZIP 文件路径；本地开发需先解压，再 `/plugins install <目录>`。完整说明见 [Kimi 集成](integrations/kimi/README.md)。

### DeepSeek Harness rc.7

```powershell
pnpm --filter @agent-coach/dsh pack --pack-destination integrations/dist
dsh plugin --profile <profile> add .\integrations\dist\agent-coach-dsh-0.1.0.tgz
```

详细限制见 [DSH Bundle](integrations/dsh/README.md)。

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
