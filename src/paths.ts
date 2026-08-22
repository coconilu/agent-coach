import { constants } from "node:fs";
import { access, chmod, mkdir, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { CoachError } from "./errors.js";

export interface CoachPaths {
  home: string;
  knowledgeHome: string;
  stateDb: string;
  indexDb: string;
  discovery: string;
  token: string;
  backups: string;
}

export function defaultDataHome(): string {
  const configured = process.env.AGENT_COACH_HOME;
  if (configured) return resolve(configured);
  if (process.platform === "win32") {
    return join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "AgentCoach");
  }
  return join(process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"), "agent-coach");
}

export function defaultKnowledgeHome(home = defaultDataHome()): string {
  return resolve(process.env.AGENT_COACH_KNOWLEDGE_HOME ?? join(dirname(home), "AgentCoachKnowledge"));
}

export function resolvePaths(home = defaultDataHome(), knowledgeHome = defaultKnowledgeHome(home)): CoachPaths {
  const resolvedHome = resolve(home);
  const resolvedKnowledge = resolve(knowledgeHome);
  return {
    home: resolvedHome,
    knowledgeHome: resolvedKnowledge,
    stateDb: join(resolvedHome, "state.db"),
    indexDb: join(resolvedHome, "index.db"),
    discovery: join(resolvedHome, "gateway.json"),
    token: join(resolvedHome, "gateway.token"),
    backups: join(resolvedHome, "backups"),
  };
}

function contains(parent: string, child: string): boolean {
  const relation = relative(parent, child);
  return relation === "" || (!relation.startsWith("..") && !isAbsolute(relation));
}

export async function ensureSafePaths(paths: CoachPaths, sourceRoot?: string): Promise<void> {
  if (contains(paths.home, paths.knowledgeHome) || contains(paths.knowledgeHome, paths.home)) {
    throw new CoachError("VALIDATION_ERROR", "Runtime and knowledge directories must not overlap");
  }
  if (sourceRoot) {
    const source = resolve(sourceRoot);
    if (
      contains(source, paths.home) ||
      contains(paths.home, source) ||
      contains(source, paths.knowledgeHome) ||
      contains(paths.knowledgeHome, source)
    ) {
      throw new CoachError("VALIDATION_ERROR", "Runtime and knowledge directories must be outside the source checkout");
    }
  }
  await mkdir(paths.home, { recursive: true, mode: 0o700 });
  await mkdir(paths.knowledgeHome, { recursive: true, mode: 0o700 });
  await mkdir(paths.backups, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") {
    await chmod(paths.home, 0o700);
    await chmod(paths.knowledgeHome, 0o700);
  }
}

export async function permissionStatus(path: string): Promise<"owner-only" | "degraded"> {
  try {
    await access(path, constants.R_OK | constants.W_OK);
    if (process.platform === "win32") return "degraded";
    const fs = await import("node:fs/promises");
    const stats = await fs.stat(path);
    return (stats.mode & 0o077) === 0 ? "owner-only" : "degraded";
  } catch {
    return "degraded";
  }
}

export async function canonicalPath(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    return resolve(path);
  }
}
