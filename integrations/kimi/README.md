# Agent Coach for Kimi Code 0.38

The release artifact `agent-coach-kimi.zip` is a Kimi Plugin archive with a root `kimi.plugin.json`, one Skill, one MCP server, and lifecycle Hooks.

## Remote release install

Kimi's official manager accepts a ZIP URL:

```text
/plugins install https://github.com/coconilu/agent-coach/releases/latest/download/agent-coach-kimi.zip
/reload
/plugins info agent-coach
```

## Local H1 install

Kimi `0.38.0` does not accept a local ZIP file path. Extract the archive first, then install the extracted directory:

```powershell
Expand-Archive .\integrations\dist\agent-coach-kimi.zip -DestinationPath <TEMP_PLUGIN_DIR>
```

```text
/plugins install <TEMP_PLUGIN_DIR>
/reload
/plugins info agent-coach
```

The verified info state is Agent Coach `0.1.0`, one Skill, and MCP `1/1` enabled. Removal uses the official manager:

```text
/plugins remove agent-coach
/plugins info agent-coach
```

Installation is interactive and user-scoped. Agent Coach does not edit Kimi's private `installed.json`. Preserve an unrelated sentinel in the isolated `KIMI_CODE_HOME` when repeating the H1 canary.
