# 数据与隐私生命周期

## 1. 默认目录

目录由平台 API 解析，示例不得硬编码作者路径。

| 目录 | 默认语义 |
|---|---|
| `AGENT_COACH_HOME` | 用户运行状态根；Windows 默认位于当前用户 LocalAppData |
| `<home>/state.db` | Turn、Candidate、Audit、Settings、Integration ownership 的事实源 |
| `<home>/index.db` | 可删除重建的全文/语义索引 |
| `<home>/gateway.json` | 无密钥发现信息 |
| `<home>/gateway.token` | 当前用户私有 bearer secret |
| `<home>/backups/` | Agent Coach-owned 配置备份，外部不返回绝对路径 |
| `AGENT_COACH_KNOWLEDGE_HOME` | 已批准知识目录；必须位于源码仓之外 |

初始化拒绝运行状态/知识目录与源码 checkout、公共 Git worktree 或彼此发生路径重叠。

## 2. 默认保存策略

- 默认不持久化原始 Prompt、隐藏思维链、完整工具参数和完整工具输出。
- 默认保存：哈希身份、时间、宿主、任务类型、显式计划摘要、匹配引用、采用决定、动作分类、结果摘要和用户反馈。
- 诊断原文捕获默认关闭；显式开启时默认 TTL 为 7 天，并在 UI 持续显示风险提示。
- 普通事件 Journal 默认保留 30 天；审计状态和 tombstone 不含原始正文，可长期保留。
- Candidate 可设置 TTL；approved knowledge 默认无 TTL，但可显式设置。

## 3. 学习开关

| 状态 | 召回 | 新 Journal | Candidate | Provider 写入 |
|---|---:|---:|---:|---:|
| Active | 是 | 是 | 是 | 仅已显式启用时 |
| Paused | 是 | 否 | 否 | 否 |
| Recall off | 否 | 依学习开关 | 依学习开关 | 不做 recall |

暂停/恢复必须通过 CLI/UI 读回状态；Hook 不能静默覆盖。

## 4. 外部 Provider 同意

Provider 默认禁用。启用 Preview 必须展示：

- Provider 名称和 URL/本地进程；
- 会发送哪些字段；
- 是否需要 LLM/Embedding 与凭据；
- 数据落点、删除能力和已知保留限制；
- timeout 和 fallback；
- 当前是否完成真实 roundtrip 验证。

Apply 使用 exact preview token。未经显式确认不进行网络请求或索引上传。

## 5. 来源、纠错和编辑

每条 Memory 详情展示 canonical/candidate 状态、scope、来源、证据、内容哈希、使用次数、反馈、冲突、替代关系和最近验证时间。

编辑 approved knowledge 不是就地无痕覆盖：创建新 Revision，并让旧 Revision 进入 superseded。纠错不会删除历史审计，但默认搜索只返回当前有效版本。

## 6. Forget

Forget Preview 列出受影响层：`state.db` 正文、知识文件、`index.db`、Provider 和附件。Apply 后逐层读回：

1. 当前正文从活动状态和索引移除；
2. 知识文件删除或写入无正文 tombstone；
3. Provider 删除调用完成并复查；
4. Audit 只保留 ID、时间、操作者和结果码，不保留被删正文；
5. 任一层失败时整体结果是 partial/failed，不报告完整成功。

若用户曾显式启用私有 Git，普通删除不会抹除旧 Commit。UI/CLI 必须提示这一点。历史重写具有破坏性，MVP 不自动执行；用户可选择删除整个私人知识仓和备份以完成更强清除。

## 7. Export 与 Reset

- Export 支持单项、作用域或全库，输出可读 Markdown/JSON 和 manifest/hash；默认不含诊断原文和 secret。
- Reset 分为：索引重建、运行状态重置、候选清空、Provider 断开、完整本地数据清除。
- 所有 Reset 默认 Preview；完整清除要求 exact token，并明确说明 Git/外部 Provider 是否仍有副本。
- 删除 material data 后必须报告删除目标和可恢复性。

## 8. 公共仓隐私门禁

CI 和本地 privacy scan 至少拒绝：API key/auth header、真实 Prompt/Hook payload、session/turn ID、用户 home 路径、私人知识正文、Provider 临时 URL 和运行数据库。测试只使用合成固定数据。
