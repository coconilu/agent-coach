# 首发支持矩阵

本表记录“已验收版本”，不是宽泛兼容承诺。Doctor 读取实际版本；不匹配时只能显示 `unverified` 或 `unsupported`。

## 1. 基线

| 项目 | 首发范围 |
|---|---|
| OS | Windows 11 x64 |
| Node.js | `>=24.15.0 <25`；启动时探测 `node:sqlite` 与 FTS5 |
| Codex CLI | `>=0.147.0 <0.148.0` |
| Kimi Code | `>=0.38.0 <0.39.0` |
| DeepSeek Harness | `0.1.0-rc.7` 精确锁定 |
| MCP SDK | 实现阶段精确锁定并写入 lockfile |

若 `PRAGMA compile_options` 不包含 FTS5，系统明确降级到确定性非 FTS 检索并显示 degraded，不把非 FTS 结果冒充完整搜索。

## 2. 能力覆盖

| 宿主 | 分发 | Prompt/Stop 审视 | covered gate | 已知不覆盖/故障语义 |
|---|---|---|---|---|
| Codex | Repo marketplace + Codex Plugin | `UserPromptSubmit`、`Stop`、`SessionEnd` | `PreToolUse` 覆盖 Bash、apply_patch、MCP、常见本地函数工具 | Hosted Tool 与特殊 opt-out 路径不覆盖；Hook 需用户信任；错误按宿主行为处理 |
| Kimi Code | 根 Manifest 的 Release ZIP，通过官方 `/plugins install` | `UserPromptSubmit`、`Stop`、`SessionEnd` | `PreToolUse` | Hook timeout/crash fail-open；Plugin 为用户级；无稳定非交互式安装 CLI |
| DSH | 预构建 npm tgz Bundle | 原生 `agent/pre-step`、`agent/turn-stopping` | 原生 `tools/pre-execute` | rc 接口可能变化；`isConcurrencySafe` 不等于只读；需 packed-install canary |

## 3. Codex 安装合同

公开仓提供 `.agents/plugins/marketplace.json` 和 `plugins/agent-coach/`。用户先注册 Marketplace，再使用 Codex 官方 Plugin add/browser；Plugin bundled Hook 必须在 `/hooks` 中审查并信任。

自动 canary 可以使用隔离环境的 Hook trust bypass 验证 wire，但不能替代正常信任流程的人工验收。

## 4. Kimi 安装合同

Kimi Release Artifact 将 Plugin Manifest 放在 ZIP 根。Agent Coach CLI 负责：

- 检测版本；
- 生成并展示官方 `/plugins install <release-zip-url>` 命令；
- 安装后 fresh-process verify；
- 展示官方 remove/disable 恢复步骤。

CLI 不直接修改 Kimi 私有 installed-state 文件，也不声称自动完成交互式 Plugin 安装。

## 5. DSH Bundle 合同

`integrations/dsh/package.json` 必须声明：

```json
{
  "dsh": {
    "bundle": {
      "patch": "./cordis.patch.yml"
    }
  }
}
```

发布预构建 tgz，依赖精确 `@deepseek-ai/dsh-mcp-client@0.1.0-rc.7`。MCP stdio shim 在 Gateway 离线时也必须快速完成 initialize/tools/list；实际工具调用返回明确 degraded，不允许启动阶段等待 DSH 默认长超时。

## 6. 验收分层

| 层级 | 是否 Keyless | 必须证明 |
|---|---:|---|
| H0 Contract | 是 | manifest/schema/fixture/static validation |
| H1 Host load | 是 | 真实 CLI 加载/发现、Hook wire fixture、MCP 全周期；不要求模型登录 |
| H2 Live model | 否/条件式 | 当前已登录环境的一轮真实 Agent 行为；未满足凭据时 BLOCKED |

隔离 Home 不复制真实账号凭据。H1 不能被描述为“真实模型完成任务”，H2 不能被描述为 keyless。

## 7. Canary 证据

每宿主保存：版本、OS、安装来源、manifest/hash、发现结果、covered action、unknown action、Gateway outage、uninstall/rollback 和 sentinel preservation。静态文件存在不能替代 fresh-process 发现。
