# 交付里程碑

里程碑是串行验收门禁。后续工作可以做只读探索，但任一前置阻断项为红时，不得宣称后续里程碑完成。

## M0：契约冻结与公开仓库

目标：在业务代码开始前，让产品边界、协议、安全、数据生命周期、支持版本和定义完成可独立审查。

- [ ] README 为中文优先，并明确当前没有“已支持”声明。
- [ ] 架构统一 healthy gate 与 degraded fail-open 语义。
- [ ] 公开源码、用户运行数据、用户私有知识三者完全分离。
- [ ] 每类持久数据只有一个事实源，索引与权威状态不混淆。
- [ ] 本地认证、Origin/CORS/CSRF/CSP、恶意记忆内容和凭据轮换有明确合同。
- [ ] 六个 MCP 工具、Ticket、错误码、幂等和副作用分类固定。
- [ ] 暂停、来源查看、纠错、编辑、忘记、导出、重置、TTL 和 Provider 同意有用户路径。
- [ ] M2 使用 demo/mock host，真实三宿主依赖只在 M3。
- [ ] 固定 Windows、Node、Codex、Kimi、DSH 精确首发版本与未知版本行为。
- [ ] 固定延迟、上下文、接入时间、baseline/treatment 和负迁移阈值。
- [ ] 独立 M0 复审无阻断项。
- [ ] 首个纯文档/设计提交推送到公开 GitHub，匿名访问可读。

Gate：公开 URL、Commit SHA、仓库 visibility 和文件清单读回；首提交没有业务实现代码或私人数据。

## M1：Agent-neutral 辅导与治理核心

目标：纯库层完成 review、prepare、guidance、commit、ticket、gate、complete、candidate 和治理闭环。

- [ ] `docs/PROTOCOL.md` 中的版本化 JSON 合同落地。
- [ ] 状态机拒绝乱序、跨项目、过期、旧 execution epoch 和幂等冲突。
- [ ] 三类 Turn（纯问答、只读勘察、副作用任务）都有确定性夹具。
- [ ] 副作用分类具有 golden fixtures；未知动作健康模式默认视为副作用。
- [ ] `state.db` 使用事务/WAL，重复事件幂等，并发 Turn 隔离。
- [ ] 私有知识目录保存已批准内容；`index.db` 可删除重建。
- [ ] 检索先硬过滤再排序，空命中仍可完成计划提交。
- [ ] Agent Coach 注入内容不会被再次捕获。
- [ ] 四类 LearningProposal 的 keyless 夹具可生成 Candidate。
- [ ] 外部 Provider 禁用/超时不会改变权威数据。

Gate：干净 checkout、无 API Key 的单元/集成测试全部通过。

## M2：Daemon、MCP、CLI、Demo Host 与经验面板

目标：一个本地 Daemon 和内置 Demo Host 完整展示产品闭环；本阶段不声称真实 Agent 已连接。

- [ ] Daemon loopback-only、随机端口、认证发现、权限检查和有序关闭通过。
- [ ] stdio Launcher 完成 MCP initialize、tools/list 和六个 tools/call。
- [ ] CLI 提供 init、start、status、demo、doctor、search、review、approve、reject、forget、export、reset、provider 和 integrations。
- [ ] Demo Host 覆盖纯问答、只读和副作用 Turn。
- [ ] Dashboard 固定六个一级路径：概览、经验库、候选审核、辅导 Trace、集成、隐私设置。
- [ ] 概览优先显示待处理事项、本次辅导效果和 degraded 状态，而非只显示累计数字。
- [ ] 经验可视化包含时间增长、approved/candidate、复用次数、采用率、正负反馈和作用域。
- [ ] 候选审核展示来源、证据、冲突和 exact preview，并支持审批/拒绝。
- [ ] Privacy/Settings 支持暂停、TTL、Provider 同意、导出、忘记和重置。
- [ ] 401、跨站 mutation、存储型 XSS、CSP 和 CSRF 夹具通过。

Gate：同一运行 Core 的 HTTP、MCP、CLI、Demo 和浏览器验收通过；桌面 1440×900、1280×720 与窄屏 390×844 均可用。

## M3：Codex、Kimi Code 与 DeepSeek Harness

目标：三个宿主使用同一 Core，通过各自正式扩展机制完成接入。

- [ ] Codex Plugin 含 Skill、MCP 和 bundled hooks。
- [ ] Kimi Plugin 含 Skill/system instructions、MCP 和 hooks。
- [ ] DSH `package.json#dsh.bundle.patch` 指向 `./cordis.patch.yml`，并锁定 rc.7。
- [ ] Doctor 检测宿主版本，未验版本不展示 Verified。
- [ ] `enforce` + Gateway healthy 下，已覆盖副作用工具无有效 epoch 时拒绝一次；Ticket 首次兑换后允许。
- [ ] Gateway/Hook 故障时 fail-open，同时产生可见 degraded 证据。
- [ ] Prompt/Stop 轻量路径能审视纯问答和只读 Turn。
- [ ] 安装遵循 probe → preview → apply → readback → fresh-process canary → rollback。
- [ ] 安装/卸载只处理 Agent Coach 所有权范围，并保留 sentinel 与私人知识。
- [ ] 每宿主记录“已覆盖工具、已知绕过、故障模式”canary。

Gate：H1 在隔离 home 下完成真实 CLI 装载/发现、Hook wire、MCP 周期、故障降级、卸载、回滚和 sentinel 保留。H2 是条件式非阻断证据：只在当前已登录环境允许时运行真实模型；不可用时记录 `UNAVAILABLE/BLOCKED` 并限制发布声明，但不阻断 H0/H1 MVP。

## M4：效果、性能和学习质量

目标：证明“变聪明”来自可重复的计划改善，而不是仅保存了数据。

- [ ] 固定至少 8 个确定性任务：3 个应命中、3 个不相关负迁移控制、1 个冲突、1 个 Provider 故障。
- [ ] Treatment 完成率不低于 Baseline；3 个应命中任务中至少 2 个产生正确 Plan Delta。
- [ ] 三个不相关任务保持零强制错误指导、零错误约束注入。
- [ ] 一条偏好能跨三宿主复用；一条历史失败能在动作前改变计划。
- [ ] stale/rejected/conflicting/superseded 不进入约束区。
- [ ] Keyless `coach_prepare` 在 1000 条合成记忆下 P95 ≤ 300ms。
- [ ] Hook/Gateway 超时默认 1000ms 后降级；最大 Guidance 为 8 项、约 1200 tokens。
- [ ] 本地冷启动目标 ≤ 2s；已有 Node 的开发接入流程目标 ≤ 5 分钟。
- [ ] 报告包含检索、注入、采用/忽略、Plan Delta、结果、延迟、上下文和负迁移。

Gate：未达到阈值只能报告实验结果，不得宣称改善已经成立。

## M5：独立 QA 与公开交接

目标：独立审查者可以从公开仓库复现核心体验。

- [ ] Windows 干净 clone 安装、构建、测试和 demo 成功。
- [ ] 独立 QA 按 `docs/ACCEPTANCE.md` 给出 PASS/FAIL/BLOCKED，并修复所有阻断发现。
- [ ] UI 对照概念图完成视觉复核、键盘/焦点/对比度/窄屏验收。
- [ ] 隐私、secret、依赖审计、Windows CI、锁文件和发布产物校验和通过。
- [ ] README 提供五分钟 Demo、真实限制和数据删除说明。
- [ ] GitHub visibility、CI、Commit/Tag、Release 产物和本地 clean status 读回。

Gate：所有 mandatory 阻断项 PASS。条件式 H2 可以是 `UNAVAILABLE/BLOCKED`，但 README/Release 必须如实限制声明；TIMEOUT、SKIPPED 和未验版本不是 PASS。
