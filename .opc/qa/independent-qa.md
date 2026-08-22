# Agent Coach v0.1.0 独立 QA

结论：**PASS**

- 验收对象：`c8cb0296881e573429afc9d6fd704e198d0cae5d`
- 公开仓库：<https://github.com/coconilu/agent-coach>
- Release：<https://github.com/coconilu/agent-coach/releases/tag/v0.1.0>
- 独立复验时间：2026-08-23 02:14 +08:00
- 执行环境：Windows NT 10.0.26200 x64、Node.js 24.15.0、pnpm 10.18.3、Codex 0.147.0、Kimi Code 0.38.0、DSH 0.1.0-rc.7 checkout

本报告不采用实现者总结作为证据。所有 mandatory 门禁均由独立 QA 在最终候选或公开 tag 的 fresh clone 上重跑。H2 live-model 因隔离环境没有模型账号而保持 `UNAVAILABLE/BLOCKED`；它在合同中是明确的条件式非阻断项，未被计入 H1 或 keyless PASS。

## 逐项结论

| 范围 | 状态 | 独立证据 |
|---|---|---|
| A. Turn 与辅导协议 | PASS | Core 状态机、HTTP、MCP 与 live Gateway 测试覆盖纯问答、只读、prepare/commit/ticket/epoch/complete、乱序、过期、跨作用域、幂等冲突、未知工具与 fail-open degraded。 |
| B. 数据权威、学习与治理 | PASS | 学习治理测试覆盖四类 Candidate、explicit/inferred、exact preview/apply、审批/拒绝、注入排除、Provider fallback、Forget 多层读回、跨重启与 index rebuild。 |
| C. 本地安全 | PASS | Gateway 安全测试覆盖 loopback、Bearer/轮换、一次性 bootstrap、SameSite/HttpOnly session、可恢复 CSRF、reload、篡改 cookie、Origin/Host、CORS、CSP 与文本化恶意内容；真实浏览器复验 reload 后 mutation 成功。 |
| D. 隐私与生命周期 | PASS | 隐私测试、公开 checkout scanner、暂停/恢复学习真实 mutation、导出/忘记/重置 CLI/API 测试、Provider consent/失败可见性均通过。 |
| E. Runtime、MCP 与 CLI | PASS | fresh clone 初始化、Demo 5/5、随机端口 Gateway、owner-only token、CLI 全命令测试、stdio MCP 六工具与错误路径通过。 |
| F. 三宿主集成 H1 | PASS | Codex、Kimi、DSH 均完成隔离加载/发现、Hook/MCP 周期、故障降级、移除/回滚与 sentinel 保留；精确版本匹配。 |
| F2. H2 live-model | BLOCKED（非阻断） | 隔离 H1 不复制真实模型凭据；没有把未运行的真实模型行为伪装成 PASS。 |
| G. 用户体验与可视化 | PASS | 应用内浏览器实测 populated、fresh empty、FTS degraded、Candidate exact preview、Trace、Integration、Privacy；1440×900、1280×720、390×844 均无横向溢出，控制台无相关 error/warn。 |
| H. 效果与性能 | PASS | CORE_RUNTIME：Treatment 10/10、相关 Plan Delta 3/3、控制任务负迁移 0、1000 条合成记忆 prepare P95 23.996 ms、Guidance/Token 门禁通过。 |
| I. 公开发布 | PASS | public main/tag/Release/CI/资产均读回；公开 tag fresh clone 完整复现；隐私、依赖审计与校验和通过。 |

## 最终命令证据

| 命令 | 结果 |
|---|---|
| `pnpm install --frozen-lockfile` | PASS；公开 `v0.1.0` fresh clone，锁文件无漂移。 |
| `pnpm typecheck` | PASS。 |
| `pnpm clean && pnpm build` | PASS；Core 与 Dashboard 从空 `dist` 重建。 |
| `pnpm test` | PASS；Core/Server/MCP 28/28，Dashboard 3/3。 |
| `node --test tests/integrations/*.test.mjs tests/outcome/*.test.mjs tests/privacy/*.test.mjs` | PASS；30/30。 |
| `node scripts/run-outcome-eval.mjs --samples 50 --warmup 10` | PASS；3/3 Plan Delta、0 负迁移、P95 23.996 ms。 |
| `node scripts/privacy-scan.mjs --root .` | PASS；fresh public checkout 182 个文本/归档输入、0 finding。 |
| `pnpm audit --json` | PASS；355 dependencies，info/low/moderate/high/critical 均为 0。 |
| `node scripts/release-checksums.mjs --output ...` + `--verify ...` | PASS；fresh clone 92 个发布输入。 |
| 系统 `validate_plugin.py` 与 `quick_validate.py` | PASS；Codex Plugin 和 Agent Coach Skill 均有效。 |
| `node tests/integrations/codex-cli-canary.mjs` | PASS；隔离 Home、fresh process、sentinel preserved。 |
| `DSH_REPO=<rc.7 checkout> node tests/integrations/dsh-cli-canary.mjs` | PASS；packed install、config compose、真实包加载、移除、sentinel preserved。 |
| `node dist/cli.js doctor --json` | PASS；Node 24.15.0 为 verified、FTS5 可用。 |
| doctor 版本边界 | PASS；24.14.99 unsupported、24.15.0 verified、24.99.99 verified、25.0.0 unsupported。 |
| `node dist/cli.js demo --json` | PASS；pure-question、read-only、side-effect handshake、conflict isolation、provider outage fallback 共 5/5。 |

## 三宿主 H1

| 宿主 | 证据 | 状态 |
|---|---|---|
| Codex 0.147.0 | 公开 tag fresh clone 中以隔离 `CODEX_HOME` 执行 Marketplace add、Plugin add/list/remove；发现 Manifest、Hooks、MCP、Skill；sentinel 保留。 | PASS |
| Kimi Code 0.38.0 | 独立真实 TUI：安装后 `state: ok`、Skill 1、MCP 1/1；reload 后可读；remove 后 `info` 明确为 not installed；sentinel 保留。TUI 所用 ZIP 与 Release 资产 SHA-256 相同。 | PASS |
| DSH 0.1.0-rc.7 | 从公开源码本地 pack，在隔离 `DSH_HOME` add、dump-config、导入真实包、执行 native lifecycle fixture、remove；sentinel 保留。 | PASS |

DSH tgz 是 H1 从公开源码本地 pack 的证据，不是 v0.1.0 Release 资产。当前归档隐私扫描合同只承诺 ZIP 解包扫描，因此没有把未发布的 tgz 冒充发布资产。

## 浏览器验收

浏览器路径：Codex 应用内 Browser；未使用 Playwright fallback。

| 流程 | 观察结果 | 状态 |
|---|---|---|
| bootstrap → 无 token `/` →普通 reload | URL 不保留 nonce/CSRF；reload 后 session 仍有效。 | PASS |
| reload → Candidate 审核 | Exact preview 显示“已绑定当前 Revision”，无 403。 | PASS |
| Privacy pause → preview/apply → reload → resume | 暂停读回为 true，恢复后读回为 false。 | PASS |
| fresh empty | 概览显示 Trace 空态；隐私页仍显示默认不保存、暂停/删除/重置；集成页仍显示三宿主，不再被 Trace 空态覆盖。 | PASS |
| degraded | 临时运行时令 FTS5 不可用后，页面明确显示“降级”和确定性检索 fallback 文案；未修改产品源码。 | PASS |
| Trace / Integration | Before/After、采用/忽略、结果与三宿主状态均可达。 | PASS |
| 1440×900 | `scrollWidth=1425 <= 1440`；无主要裁切/重叠。 | PASS |
| 1280×720 | `scrollWidth=1265 <= 1280`；页面纵向滚动可达。 | PASS |
| 390×844 | `scrollWidth=375 <= 390`；移动菜单可打开/关闭，操作可达。 | PASS |
| 键盘与语义 | 导航 Button 可聚焦，实测 2px 紫色 `focus-visible` outline；DOM 有 navigation、main、dialog、switch、table 等语义标签。 | PASS |
| 控制台 | empty、populated、degraded、桌面与窄屏均无相关 error/warn。 | PASS |
| 概念图对照 | 保留左导航、中央 Trace/积累/候选、右侧集成/Provider 的信息层级；中文产品文案和真实状态是有意差异。 | PASS |

## QA 发现并修复的阻断项

| 阻断 | 修复前证据 | 修复与复验 |
|---|---|---|
| Doctor 版本修正导致 TypeScript 回归 | `pnpm typecheck` 报 `src/cli.ts` 的 minor/patch 可能为 undefined。 | 解构提供安全默认值；最终 typecheck、build、test 与四个版本边界均 PASS。 |
| Dashboard reload 后 Candidate preview 403 | bootstrap 后普通 reload，再审核 Candidate，Exact preview 卡在加载并显示 API 403。 | 使用 SameSite=Strict 可恢复 CSRF cookie；仅在有效 session 且 cookie hash 匹配时重新向 HTML 注入 meta。安全回归测试与真实浏览器 reload/mutation 均 PASS。 |
| fresh empty 阻断所有非 Trace 页面 | 无 Trace 时点击隐私或集成，main 仍只显示 Trace 空态。 | Trace 空态仅作用于 Overview/Traces；新增 live-empty jsdom 回归；真实 fresh empty 的隐私与集成页面 PASS。 |

## 公开发布读回

| 项目 | 读回 |
|---|---|
| visibility | `PUBLIC` |
| main SHA | `c8cb0296881e573429afc9d6fd704e198d0cae5d` |
| tag `v0.1.0` | 同一 SHA |
| Release target | 同一 SHA；latest release 为 Agent Coach v0.1.0 |
| CI | Run `32589619364` completed/success；Ubuntu privacy、Windows privacy、macOS privacy、Windows build/test/eval/audit/checksum 四个 Job 全 PASS。 |
| `agent-coach-kimi.zip` | 35,624 bytes；GitHub digest、下载后 SHA-256、发布 checksum 均为 `37950f2e722575a577fd3a1109bc882200dceab8128f41b07fcdf088a34798e6`。 |
| `SHA256SUMS.txt` | 105 bytes；GitHub digest 为 `a681d60073b80701c86b1271fc5034f3f8f362d4bf812bf11ac99e0ed2f4ac9c`。 |
| 本地状态 | 写入本 QA 文件前，原仓 HEAD 与 origin/main 相同且 clean。 |

## 非阻断限制与后续风险

- H2 live-model 未运行，状态为 `UNAVAILABLE/BLOCKED`；v0.1.0 只能声明 H0/H1，不得把 keyless H1 描述为真实模型完成任务。
- TencentDB Agent Memory 目前是 Provider 合同/驱动，尚无真实服务 roundtrip；README 已将其标为实验性。
- Codex Hosted Tool/特殊 opt-out 路径不属于 covered gate；Kimi Hook 故障按宿主 fail-open；DSH 仍是 rc.7 精确支持。
- Windows checkout 若设置 `core.autocrlf=true`，本地重建的 Kimi ZIP 会因 CRLF 字节得到不同归档 hash；解包后的 8/8 文件在换行标准化后与 Release 内容完全一致，功能与来源没有漂移，下载资产仍可由发布 checksum 验证。下一版宜增加 `.gitattributes` 固定发布输入为 LF，以实现跨 checkout 的字节级可复现构建。

最终判断：`docs/ACCEPTANCE.md` 的 mandatory 项均具备当前可观察证据；三个修复前阻断已在最终公开 commit 上回归通过。Agent Coach v0.1.0 可以交给经理体验。
