# Agent Coach v1 协议

本协议只传递显式计划、可观察事件和结构化学习提案，不接收隐藏思维链。

## 1. 公共 MCP 工具

| 工具 | 主要输入 | 主要输出 | 是否写状态 |
|---|---|---|---:|
| `coach_prepare` | `project_id`、`host`、`session_id`、`turn_id`、`IntentEnvelope`、`idempotency_key` | `GuidancePacket`、`plan_digest`、预算与 provenance | 是 |
| `coach_commit_plan` | `turn_ref`、`packet_id`、`RevisedPlan`、逐项 adoption、`idempotency_key` | 单次可兑换 `ActionTicket`、`execution_epoch` | 是 |
| `coach_search` | query、scope、type/status filters、limit | 带 authority/provenance 的搜索结果 | 否 |
| `coach_explain` | `packet_id` 或 `memory_id` | 过滤、排序、冲突、采用和来源解释 | 否 |
| `coach_complete` | `turn_ref`、结果状态、evidence refs、可选 `LearningProposal[]`、`idempotency_key` | Outcome、Candidate refs、审计摘要 | 是 |
| `coach_feedback` | packet/item ref、`helpful/not_helpful/stale/wrong`、可选说明、`idempotency_key` | 更新后的反馈状态 | 是 |

六个工具名和 v1 语义在首个稳定版本前不得无迁移改名。

## 2. 核心数据合同

### IntentEnvelope

```text
goal
task_type
planned_steps[]
intended_tools[]
target_paths[]
constraints[]
assumptions[]
risk_flags[]
```

### GuidancePacket

```text
packet_id
turn_ref
constraints[]      approved canonical only
preferences[]      approved or clearly labeled candidate
facts[]
experiences[]
procedures[]
conflicts[]        citations only when bodies conflict
omitted_summary
estimated_tokens
created_at / expires_at
```

每个注入项都包含 `memory_id`、authority、status、scope、provenance 和 content hash。空数组是合法结果。

### LearningProposal

Keyless 模式由 Host/Agent 提交：

```text
proposal_id
type: preference | fact | experience | procedure
title
summary
scope
explicitness: explicit | inferred
confidence
source_refs[]
evidence_refs[]
origin: agent_proposal
```

Core 进行确定性 Schema、作用域、敏感内容、去重和 provenance 校验；不自行声称 LLM 推断正确。

## 3. Turn 与 Ticket 状态机

```text
OBSERVED
  -> PREPARED(GuidancePacket)
  -> COMMITTED(single-use ActionTicket, epoch N)
  -> EXECUTING(epoch N)
  -> COMPLETED
```

`coach_commit_plan` 返回的 Ticket 只能原子兑换一次。首次健康且 covered 的副作用 gate 使用 Ticket 从 `COMMITTED` 进入 `EXECUTING`；后续 Hook 只查询服务端 active execution epoch，不再兑换 Ticket。

以下情况使 Ticket 和 active epoch 失效：

- 同一 Turn 提交新的 RevisedPlan，epoch 递增；
- Turn complete/abort；
- Ticket/Turn 过期；
- project/host/session/turn identity 改变；
- GuidancePacket 或 plan digest 不匹配。

并发首次 gate 使用数据库事务保证只有一个兑换成功；另一个请求读到同一 active epoch 后可继续，不重复执行状态迁移。

## 4. ActionClassifier

版本化输出：

```ts
type ActionClass = "read" | "write" | "unknown";

interface ActionClassification {
  class: ActionClass;
  classifier_version: string;
  reason: string;
  coverage: "covered" | "unsupported";
}
```

- 文件读、搜索、状态读取等显式工具可列为 `read`。
- 文件编辑、patch、外部 mutation 和已知副作用工具为 `write`。
- Shell 只识别保守只读白名单；复杂语法、重定向、管道或无法证明只读的命令为 `unknown`。
- `enforce` + Gateway healthy 下，`unknown` 按 `write`。
- 宿主未进入 Hook 的 Hosted Tool 或特殊 opt-out 路径为 `unsupported`，不得声称已阻断。

分类器 fixtures 是协议的一部分，变更分类必须升级 `classifier_version` 并更新 canary。

## 5. 运行模式

| 模式 | 健康 covered write/unknown | Gateway/Hook 故障 |
|---|---|---|
| `advisory`（首次安装默认） | 记录缺失握手并给出辅导提示，不拒绝 | fail-open + degraded |
| `enforce`（用户显式开启） | 无 Ticket/epoch 时拒绝一次；握手后允许 | fail-open + degraded |

Agent Coach 不以 fail-closed 代替宿主权限系统。

## 6. Candidate 类型门禁

| 类型 | 最低晋升条件 |
|---|---|
| explicit preference | 用户明确陈述、scope 清晰、无敏感泄漏；仍需 exact preview/apply |
| inferred preference | 必须用户确认，不能因重复观察自动变成规则 |
| fact | 绑定可解析来源及 freshness/hash；过期后不得进入约束区 |
| experience | 有目标、环境、动作、结果和至少一项结果证据 |
| procedure | 至少两个独立成功证据，或一次用户明确批准的 bounded 试用 |
| capability proposal | 独立 QA、Shadow/baseline、用户批准、版本和回滚；MVP 不自动激活 |

审批 Preview 返回 `proposal_hash`、`base_revision` 和 exact diff。Apply 必须携带同一值；任何基础变化返回冲突且零写入。

## 7. HTTP 内部接口

Hook 不调用 MCP，避免递归触发：

```text
POST /v1/turns/observe
POST /v1/turns/prepare
POST /v1/turns/{id}/commit
POST /v1/gates/check
POST /v1/turns/{id}/complete
POST /v1/feedback
GET  /v1/knowledge/search
GET  /v1/candidates
POST /v1/candidates/{id}/preview
POST /v1/candidates/{id}/approve
POST /v1/candidates/{id}/reject
GET  /v1/health
```

### 管理与隐私 Surface

Dashboard 和 CLI 只调用同一组版本化 HTTP API，不直接写数据库或知识文件：

```text
GET  /v1/settings
POST /v1/settings/preview
POST /v1/settings/apply

GET  /v1/memories/{id}
POST /v1/memories/{id}/edit/preview
POST /v1/memories/{id}/edit/apply
POST /v1/memories/{id}/supersede/preview
POST /v1/memories/{id}/supersede/apply
POST /v1/memories/{id}/obsolete/preview
POST /v1/memories/{id}/obsolete/apply
POST /v1/memories/{id}/rollback/preview
POST /v1/memories/{id}/rollback/apply

POST /v1/privacy/forget/preview
POST /v1/privacy/forget/apply
POST /v1/privacy/export
POST /v1/privacy/reset/preview
POST /v1/privacy/reset/apply

GET  /v1/providers
POST /v1/providers/{id}/enable/preview
POST /v1/providers/{id}/enable/apply
POST /v1/providers/{id}/disable/preview
POST /v1/providers/{id}/disable/apply

GET  /v1/integrations
POST /v1/integrations/{host}/preview
POST /v1/integrations/{host}/apply
POST /v1/integrations/{host}/verify
POST /v1/integrations/{host}/rollback/preview
POST /v1/integrations/{host}/rollback/apply
```

所有 management mutation 使用统一 `MutationPreviewV1`：`operation`、exact targets、redacted before/after、`base_revision`、`proposal_hash`、`expires_at`、`warnings`。Apply 必须提供 `proposal_hash + base_revision + idempotency_key`；目标或 Revision 变化时零写入并返回 `REVISION_CONFLICT`。

Settings 覆盖 learning paused、recall enabled、gate mode、Journal TTL、diagnostic capture TTL 和 Provider consent。Edit/supersede/obsolete/rollback 产生新 Revision 或状态迁移，不能就地隐藏历史。

## 8. 统一错误码

| 错误码 | 含义 |
|---|---|
| `UNAUTHORIZED` | Bearer/session 无效 |
| `CSRF_REJECTED` | Browser mutation 来源校验失败 |
| `TURN_NOT_FOUND` | Turn identity 不存在 |
| `INVALID_STATE` | 操作顺序错误 |
| `IDEMPOTENCY_CONFLICT` | 同 key 不同 payload |
| `PACKET_STALE` | Guidance 已过期或基础改变 |
| `TICKET_INVALID` | Ticket identity/digest 错误 |
| `TICKET_REDEEMED` | Ticket 已被另一个 epoch 兑换 |
| `EPOCH_STALE` | 新计划/完成已使 epoch 失效 |
| `ACTION_REQUIRES_COACHING` | enforce 健康模式下缺少有效执行状态 |
| `PROVIDER_UNAVAILABLE` | Provider 未启用、超时或错误 |
| `PROVENANCE_INVALID` | 不能验证来源 |
| `REVISION_CONFLICT` | exact preview 基础已变化 |
| `UNSUPPORTED_HOST_VERSION` | 未在验收矩阵内 |

错误响应不包含 secret、原始 Hook payload、原始 Prompt 或本机绝对路径。
