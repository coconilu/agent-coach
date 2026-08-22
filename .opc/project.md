# Agent Coach 项目简报

## 目标

构建并公开发布一个本地优先、Agent 无关的辅导与可治理记忆平台，通过薄适配器接入 Codex、Kimi Code 和 DeepSeek Harness。平台应随着经过验证的偏好、知识、经验和流程积累而变得更有用。

## 主要用户

在 Windows 上同时使用多个 Coding Agent 的个人用户，希望获得跨宿主连续性，同时保持私人知识所有权，不替换已经使用的 Agent Runtime。

## 用户承诺

用户可以启动一个本地服务，以简单方式连接受支持 Agent；查看平台学到了什么；审核、纠错或删除候选；并观察相关经验在 Agent 首次副作用动作前改变显式计划。

## 范围

- Agent-neutral Core 与版本化协议。
- 本地 Daemon、MCP、CLI、经验面板和私人数据生命周期。
- 已批准知识目录、权威状态库与可重建索引。
- 可治理学习、来源追踪和 Guidance 采用效果。
- Codex、Kimi Code、DeepSeek Harness 集成。
- 公开 GitHub 仓库、文档、测试和独立 QA 证据。

## 非目标

- 替代 Agent Harness、模型 Provider、权限系统或聊天 UI。
- 读取或保存隐藏思维链。
- MVP 阶段实现团队/云多租户、公共插件市场或自动发布 Skill。
- 静默修改用户真实 Agent 配置。

## 约束

- 用户文档默认中文；公共 Schema 和代码标识使用英文。
- Windows 是首发阻断平台。
- 无外部 API Key 的 H0/H1 与完整 Demo 必须可用；真实模型 H2 是条件验收。
- 外部 Memory Provider 可选，且不能覆盖 canonical knowledge。
- 公开源码仓只包含合成夹具，运行数据和私人知识必须位于源码树之外。

## 交付顺序

严格遵循 `docs/MILESTONES.md`。首个未解决阻断项会停止完成声明。
