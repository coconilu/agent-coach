# 阻断验收清单

这是产品 Definition of Done。文件存在、实现者总结和“看起来能用”都不是验收证据。

## A. Turn 与辅导协议

- [ ] 纯问答 Turn 能建立轻量 Trace 并在 Stop 时完成，不要求 Ticket。
- [ ] 只读勘察可以在 prepare 前进行，并能正常完成审视。
- [ ] `enforce` + Gateway healthy 下，副作用 Turn 不能在 prepare 前 commit，也不能在 commit 前获得 Ticket。
- [ ] 空 GuidancePacket 仍允许 Agent 提交 RevisedPlan 并获得 Ticket。
- [ ] Ticket 绑定 project、host、session、turn、plan digest、packet、execution epoch 和 expiry。
- [ ] 过期、跨项目、跨会话、旧 epoch、错误 digest 的 Ticket 被拒绝。
- [ ] 首次 covered gate 只能原子兑换 Ticket 一次并建立 active epoch；同 epoch 后续动作查询服务端 epoch，不重放 Ticket。
- [ ] 新 PlanCommit 使旧 Ticket 和 active epoch 失效。
- [ ] 重复 idempotency key 返回同一结果；不同 payload 重用同一 key 返回冲突。
- [ ] 未知工具在健康模式默认按副作用处理；明确只读例外有 golden fixture。
- [ ] Gateway/Hook 故障时按宿主默认 fail-open，并记录 degraded，而不是伪装已辅导。

## B. 数据权威、学习与治理

- [ ] `state.db` 跨重启保留 Turn、Candidate、审计、设置与集成所有权。
- [ ] 已批准知识只存在于用户私有知识目录，不进入公开源码仓。
- [ ] `index.db` 删除后可从有效记录重建，且不丢权威数据。
- [ ] SQLite mutation 使用事务/WAL；崩溃恢复不产生半状态。
- [ ] 并发 session/turn 不串数据。
- [ ] preference、fact、experience、procedure 四种 LearningProposal 均有 keyless 确定性夹具。
- [ ] explicit preference 与 inferred preference 明确区分。
- [ ] Candidate 在类型门禁和 exact preview/apply 前保持 inactive。
- [ ] approve、reject、supersede、obsolete、rollback 保留内容无关审计历史。
- [ ] 外部 Provider 故障不能覆盖 canonical knowledge。
- [ ] Agent Coach 注入的 packet 被 Capture 排除，不形成反馈环。

## C. 本地安全

- [ ] Daemon 默认只接受 loopback Host。
- [ ] 发现文件不含 bearer secret；凭据文件 owner-only，Doctor 能报告权限状态。
- [ ] API 无 token/错误 token 返回 401，secret 轮换使旧值失效。
- [ ] Dashboard bootstrap nonce 单次使用并换取 SameSite/HttpOnly session。
- [ ] mutation 缺失/错误 CSRF、错误 Origin 或 Host 时拒绝。
- [ ] CORS 默认不授权跨域；CSP 不允许任意外部脚本。
- [ ] 恶意记忆中的 HTML/script/event handler 只按文本显示，不执行。
- [ ] Adapter 只能瞬时标准化 Hook payload；API 错误、持久化、日志和 UI 均不保存或回显原始 payload、secret 或本机绝对路径。

## D. 隐私与数据生命周期

- [ ] 默认不持久化原始 Prompt 和完整工具输出。
- [ ] Journal 元数据默认 TTL 有界；过期清理有读回证据。
- [ ] 用户可以暂停/恢复学习；暂停时不写 Journal、Candidate 或 Provider。
- [ ] 用户可以查看来源、纠错、编辑、导出单项/全库、忘记单项和重置本地数据。
- [ ] Forget 从 state、知识文件、index 和已启用 Provider 删除，并报告每层结果。
- [ ] 若私有 Git 历史仍保留旧内容，UI/CLI 必须明确提示；安全历史重写不做隐式操作。
- [ ] Provider 默认禁用；启用前展示数据类型、目标地址和凭据需求并要求显式确认。
- [ ] Provider timeout/删除失败保持可见，不能报告完整成功。

## E. Runtime、MCP 与 CLI

- [ ] 一条命令初始化，一条命令启动；冷启动目标 ≤ 2s。
- [ ] Daemon 随机端口、认证发现、有序 shutdown 和 restart persistence 通过。
- [ ] stdio Launcher stdin 关闭后退出，重复连接无孤儿进程。
- [ ] MCP initialize、tools/list、六个 tools/call 和错误路径通过。
- [ ] CLI 覆盖 init/start/status/demo/doctor/search/review/approve/reject/forget/export/reset/provider/integrations。
- [ ] Demo Host 覆盖纯问答、只读勘察、副作用任务、冲突和 Provider outage。

## F. 三宿主集成

- [ ] Codex `0.147.0` fresh process 发现 Skill、MCP、可信 Hooks。
- [ ] Kimi `0.38.0` fresh process 发现 Skill、MCP、Hooks。
- [ ] DSH `0.1.0-rc.7` profile 合成 Bundle 并发现 MCP。
- [ ] Doctor 对不匹配版本显示 unverified/unsupported，不显示 Verified。
- [ ] 每宿主 H1 keyless 完成真实 CLI 装载、发现、Hook wire fixture、MCP prepare/guidance/commit/ticket/complete 周期。
- [ ] 每宿主 `enforce` + Gateway healthy 时，无有效 epoch 的 covered 副作用被拒绝一次并得到可执行恢复提示。
- [ ] 每宿主 Gateway/Hook 故障路径 fail-open 且显示 degraded。

### F2. 条件式非阻断证据

- [ ] H2 live-model 仅在当前已登录环境运行；缺少账号/模型时记录 `UNAVAILABLE/BLOCKED`，不归为 H1 或 keyless PASS，也不阻断 mandatory MVP。
- [ ] install/update/repair/uninstall/rollback 在隔离 home 中保留无关 sentinel。
- [ ] 真实未运行的宿主验收保持 BLOCKED，不以静态文件替代。

## G. 用户体验与可视化

- [ ] 一级导航为概览、经验库、候选审核、辅导 Trace、集成、隐私设置。
- [ ] 首次运行解释保存什么、不保存什么、如何连接以及如何暂停/删除。
- [ ] 概览显示待处理候选、最近辅导效果、Provider/宿主 degraded 和知识增长。
- [ ] 经验库支持 type/scope/status/host/text 筛选以及来源查看。
- [ ] 候选审核展示 evidence、conflict、exact diff 和 preview token。
- [ ] Trace 展示匹配项、采用/忽略、Before/After Plan、动作和结果。
- [ ] 积累视图展示 approved/candidate、复用次数、采用率、正负反馈、作用域和时间增长。
- [ ] 集成页区分 detected/configured/verified/degraded/unverified/unsupported。
- [ ] 隐私设置支持暂停、TTL、Provider 同意、导出、忘记和重置。
- [ ] 1440×900、1280×720、390×844 无主要内容裁切、重叠或不可达操作。
- [ ] 键盘操作、焦点可见、语义标签和关键文本/状态对比度达到 WCAG AA 目标。

## H. 效果与性能

- [ ] 8 个确定性 baseline/treatment 场景按 M4 约定运行。
- [ ] Treatment 完成率不低于 Baseline，且至少 2/3 相关任务产生正确 Plan Delta。
- [ ] 3 个不相关控制任务零错误约束注入、零负迁移失败。
- [ ] 一条偏好跨三宿主复用；一条失败经验在动作前改变计划。
- [ ] stale/rejected/conflicting/superseded 不进入约束区。
- [ ] 1000 条合成记忆下 keyless prepare P95 ≤ 300ms。
- [ ] Hook 超时 1000ms 后降级；Guidance ≤ 8 项、约 1200 tokens。
- [ ] 已有 Node 环境下，从 clone 到 Demo 目标 ≤ 5 分钟。

## I. 公开发布

- [ ] 公开仓只包含合成数据，无 Key、真实 Prompt、全 Hook payload、session ID、用户路径或私人知识。
- [ ] Privacy/secret scan、依赖审计、Windows CI、锁文件和构建产物校验和通过。
- [ ] 独立 QA 逐条复验并无阻断发现。
- [ ] README 限制和验证状态与证据一致。
- [ ] GitHub URL、visibility、CI、Commit/Tag、Release 和本地 clean status 读回。

状态语义：PASS 表示真实检查运行并满足期望；FAIL 表示需要修复；BLOCKED 表示外部前置阻止验证；TIMEOUT/SKIPPED/UNKNOWN 都不是 PASS。最终 M5 要求所有 mandatory 项 PASS；明确标记为“条件式非阻断”的 H2 可以保持 UNAVAILABLE/BLOCKED，但会限制发布声明。
