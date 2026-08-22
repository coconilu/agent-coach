# 发布与公开仓门禁

## 本地复验

```powershell
node --test tests/privacy/*.test.mjs
node scripts/privacy-scan.mjs --root .
pnpm install --frozen-lockfile
pnpm build
pnpm --filter @agent-coach/dsh build
node integrations/scripts/build-kimi-plugin.mjs
pnpm test
node --test tests/integrations/*.test.mjs tests/outcome/*.test.mjs tests/privacy/*.test.mjs
node scripts/run-outcome-eval.mjs
pnpm audit --audit-level high
node scripts/release-checksums.mjs --output .artifacts/release/SHA256SUMS.txt package.json README.md LICENSE dist integrations/dist plugins/agent-coach integrations/dsh/package.json integrations/dsh/README.md integrations/dsh/cordis.patch.yml integrations/dsh/index.mjs integrations/dsh/runtime .agents/plugins/marketplace.json .kimi-plugin/plugin.json .kimi-plugin/marketplace.json
node scripts/release-checksums.mjs --verify .artifacts/release/SHA256SUMS.txt
```

任一命令未真实运行、超时或返回非零，都不是 PASS。

## CI 证据

`.github/workflows/ci.yml` 固定 Node.js `24.15.0` 和 pnpm `10.18.3`：

| Job | 平台 | 阻断内容 |
|---|---|---|
| `privacy-cross-platform` | Windows + Ubuntu + macOS | Scanner 单测和公共 checkout 扫描 |
| `windows-build-test` | Windows | frozen install、build、test、真实 Core 评测、build 后隐私扫描、依赖审计、SHA-256 |

CI 会上传脱敏后的 JSON/Markdown QA 报告、完整依赖审计 JSON 与 `SHA256SUMS.txt`。Artifact 存在不等于 PASS，必须读回对应 Job 结论。

依赖审计以 `high` 为自动阻断阈值；`moderate/low` 不会被隐藏，仍保留在 JSON 中并要求发布说明给出风险判断。“CI audit PASS”不等于“零已知漏洞”。

## Privacy scan 范围

跨平台扫描器至少阻断：

- 常见 API Key、Bearer/Basic Authorization、私钥和 credential URL；
- JSON/代码中的真实 Session ID、Turn ID、raw prompt/hook/full tool output；
- Windows、Linux、macOS 用户主目录绝对路径；
- 临时 Provider tunnel URL 和私人知识标记；
- `state.db`、`index.db`、SQLite sidecar、`gateway.token`、真实 `.env` 和私钥文件。

ZIP 发布包不是黑盒：stored/deflate 条目会逐项解包扫描；ZIP 内的加密、streamed、未知压缩方法、路径逃逸、超限或解压失败均阻断。MVP 涉及的压缩归档只生成 ZIP；引入其他归档格式前必须先扩展扫描器。

`synthetic-*`、`fixture-*`、`example-*`、`test-*`、`<PLACEHOLDER>`、环境变量占位符与 `REDACTED` 允许用于公开夹具。扫描结果只输出规则、相对路径、位置和截断样本，不回显完整疑似 secret。

扫描器跳过依赖缓存、Git 元数据和 `.ui-style-director` 本地选型缓存；后者已由根 `.gitignore` 排除，不属于源码或发布产物。`dist`、`.agent-coach` 和其他构建/运行目录不会被隐式豁免，因此误放在 checkout 中的数据库和编译后 secret 仍会阻断。

## SHA-256 语义

`release-checksums.mjs` 对选择的文件按仓库相对路径排序，写 LF 结尾的标准 SHA-256 manifest；拒绝目录外路径和符号链接。`--verify` 会阻断格式错误、缺失、篡改、路径逃逸和符号链接。
