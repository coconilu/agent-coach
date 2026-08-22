# Agent Coach for DeepSeek Harness

Prebuilt DSH `0.1.0-rc.7` Bundle. It mounts a native `tools/pre-execute` coaching gate and the Agent Coach MCP stdio shim under `mcp__agent_coach__*`.

```powershell
dsh plugin --profile <profile> add .\agent-coach-dsh-0.1.0.tgz
```

The default mode is `advisory`; set `AGENT_COACH_MODE=enforce` before starting DSH to deny covered write/unknown actions when the local Gateway is healthy and no active execution epoch exists. Gateway failures remain fail-open and visible in DSH logs. The shim completes MCP initialize and tools/list without contacting the Gateway, so an offline daemon does not inherit the DSH MCP client's long startup timeout.

The Bundle forwards only bounded metadata and keyed digests. It does not persist raw prompts, tool arguments, or tool results.
