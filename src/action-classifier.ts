export type ActionClass = "read" | "write" | "unknown";

export interface ActionClassification {
  class: ActionClass;
  classifier_version: string;
  reason: string;
  coverage: "covered" | "unsupported";
}

export const CLASSIFIER_VERSION = "1.0.0";

const READ_ACTIONS = new Set([
  "read_file",
  "view_image",
  "search",
  "find",
  "list_files",
  "list_directory",
  "git_status",
  "git_diff",
  "web_search",
  "fetch",
  "get",
]);

const WRITE_ACTIONS = new Set([
  "apply_patch",
  "write_file",
  "edit_file",
  "delete_file",
  "move_file",
  "create_issue",
  "send_message",
  "post",
  "put",
  "patch",
  "delete",
  "deploy",
  "publish",
]);

const UNSUPPORTED_PREFIXES = ["hosted:", "optout:"];
const SAFE_COMMANDS = new Set([
  "dir",
  "get-childitem",
  "get-content",
  "git diff",
  "git log",
  "git status",
  "node --version",
  "npm --version",
  "pnpm --version",
  "pwd",
  "rg",
  "rg --files",
  "where.exe",
]);

function classifyShell(command: string): ActionClassification {
  const normalized = command.trim().replace(/\s+/g, " ").toLowerCase();
  if (!normalized) {
    return result("unknown", "empty shell command cannot be proven read-only");
  }
  if (/[|;&<>`]|\$\(|\r|\n/.test(normalized)) {
    return result("unknown", "shell composition or redirection is conservatively classified");
  }
  for (const safe of SAFE_COMMANDS) {
    if (normalized === safe || normalized.startsWith(`${safe} `)) {
      return result("read", `matches conservative read-only shell prefix: ${safe}`);
    }
  }
  return result("unknown", "shell command is not in the conservative read-only allowlist");
}

function result(
  actionClass: ActionClass,
  reason: string,
  coverage: "covered" | "unsupported" = "covered",
): ActionClassification {
  return {
    class: actionClass,
    classifier_version: CLASSIFIER_VERSION,
    reason,
    coverage,
  };
}

export function classifyAction(
  actionName: string,
  actionArguments: Record<string, unknown> = {},
): ActionClassification {
  const normalized = actionName.trim().toLowerCase();
  if (UNSUPPORTED_PREFIXES.some((prefix) => normalized.startsWith(prefix))) {
    return result("unknown", "host reports this action path bypasses the lifecycle hook", "unsupported");
  }
  if (READ_ACTIONS.has(normalized)) return result("read", "known read-only action");
  if (WRITE_ACTIONS.has(normalized)) return result("write", "known side-effecting action");
  if (["shell", "bash", "exec_command", "powershell"].includes(normalized)) {
    const command = actionArguments.command ?? actionArguments.cmd;
    return typeof command === "string"
      ? classifyShell(command)
      : result("unknown", "shell action is missing a classifiable command");
  }
  return result("unknown", "unknown actions are treated as side effects while the gateway is healthy");
}
