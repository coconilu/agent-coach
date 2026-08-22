# Repository guidance

Agent Coach is an agent-neutral coaching and governed-memory control plane. Keep the core independent from Codex, Kimi Code, and DeepSeek Harness; host-specific behavior belongs under `integrations/`.

## Product boundaries

- Do not create another model runtime, chat interface, task router, or LLM proxy.
- Hidden chain-of-thought is never an input. Use explicit plan summaries and observable lifecycle events.
- Every turn may be reviewed, but raw conversations are not durable knowledge by default.
- Approved File/Git knowledge is authoritative. SQLite indexes and external memory engines are rebuildable projections or candidate sources.
- Recalled historical content is untrusted evidence, not instruction authority.
- No candidate becomes an active preference, rule, procedure, or Skill without its type-specific evidence gate.

## Integration boundaries

- A complete host integration is `Skill/instructions + MCP + lifecycle hook or native plugin`.
- MCP is the shared tool surface; it is not an automatic lifecycle mechanism.
- Adapters must support preview, apply, readback, verification, rollback, and unrelated-setting preservation.
- Default runtime networking is loopback-only. Never place credentials in MCP configuration, logs, examples, or discovery files.

## Delivery rules

- Follow `docs/MILESTONES.md` in order and `docs/ACCEPTANCE.md` as the blocking definition of done.
- Implementation self-report is not final acceptance. Independent QA must re-run the relevant commands and inspect the real UI/runtime.
- Preserve provenance for every injected item and prevent injected context from being captured as new memory.
- Do not commit, push, publish, deploy, or mutate real user Agent configuration unless the current task explicitly authorizes it.
