import { DatabaseSync } from "node:sqlite";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  CandidateRecord,
  GuidanceItem,
  KnowledgeStatus,
  KnowledgeType,
  SearchInput,
} from "../contracts.js";
import { CoachError } from "../errors.js";
import { canonicalJson, estimateTokens, opaqueId, parseJson, sha256 } from "../utils.js";

export interface CanonicalKnowledgeRecord {
  id: string;
  revision: number;
  type: KnowledgeType;
  title: string;
  content: string;
  scope: string;
  status: Exclude<KnowledgeStatus, "candidate" | "rejected">;
  is_constraint: boolean;
  provenance: {
    source_refs: string[];
    evidence_refs: string[];
    origin: "user_approved" | "synthetic_demo";
  };
  content_hash: string;
  created_at: string;
  updated_at: string;
  expires_at: string | null;
  supersedes: string[];
  conflicts: string[];
  use_count: number;
}

interface IndexRow {
  id: string;
  revision: number;
  type: KnowledgeType;
  title: string;
  content: string;
  scope: string;
  status: CanonicalKnowledgeRecord["status"];
  is_constraint: number;
  provenance_json: string;
  content_hash: string;
  updated_at: string;
  expires_at: string | null;
  conflicts_json: string;
  use_count: number;
}

export interface SearchResult {
  item: GuidanceItem;
  is_constraint: boolean;
  conflicts: string[];
  use_count: number;
}

function terms(query: string): string[] {
  return [...new Set(query.toLowerCase().split(/[^\p{L}\p{N}_-]+/u).filter((term) => term.length > 1))];
}

function scoreText(queryTerms: string[], title: string, content: string): number {
  const titleLower = title.toLowerCase();
  const contentLower = content.toLowerCase();
  return queryTerms.reduce(
    (score, term) => score + (titleLower.includes(term) ? 3 : 0) + (contentLower.includes(term) ? 1 : 0),
    0,
  );
}

function scopeAllowed(scope: string, projectId?: string, requestedScopes?: string[]): boolean {
  if (requestedScopes?.length) return requestedScopes.includes(scope);
  if (scope === "global") return true;
  if (!projectId) return false;
  return scope === projectId || scope === `project:${projectId}`;
}

function toGuidance(row: IndexRow, score: number): SearchResult {
  return {
    item: {
      memory_id: row.id,
      type: row.type,
      title: row.title,
      content: row.content,
      scope: row.scope,
      authority: "canonical",
      status: row.status,
      provenance: parseJson(row.provenance_json),
      content_hash: row.content_hash,
      score,
    },
    is_constraint: row.is_constraint === 1,
    conflicts: parseJson(row.conflicts_json),
    use_count: row.use_count,
  };
}

export class KnowledgeStore {
  readonly index: DatabaseSync;
  readonly fts5Available: boolean;
  private readonly itemsDir: string;
  private closed = false;

  constructor(
    readonly knowledgeHome: string,
    indexPath: string,
  ) {
    this.itemsDir = join(knowledgeHome, "items");
    this.index = new DatabaseSync(indexPath);
    this.index.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;");
    this.index.exec(`
      CREATE TABLE IF NOT EXISTS index_records (
        id TEXT PRIMARY KEY,
        revision INTEGER NOT NULL,
        type TEXT NOT NULL,
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        scope TEXT NOT NULL,
        status TEXT NOT NULL,
        is_constraint INTEGER NOT NULL,
        provenance_json TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        expires_at TEXT,
        conflicts_json TEXT NOT NULL,
        use_count INTEGER NOT NULL DEFAULT 0
      );
    `);
    this.fts5Available = this.probeFts5();
  }

  private probeFts5(): boolean {
    try {
      this.index.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_fts USING fts5(
          id UNINDEXED, title, content, tokenize='unicode61'
        );
      `);
      return true;
    } catch {
      return false;
    }
  }

  async initialize(): Promise<void> {
    await mkdir(this.itemsDir, { recursive: true, mode: 0o700 });
    await this.rebuild();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.index.close();
  }

  private jsonPath(id: string): string {
    return join(this.itemsDir, `${id}.json`);
  }

  private markdownPath(id: string): string {
    return join(this.itemsDir, `${id}.md`);
  }

  async get(id: string): Promise<CanonicalKnowledgeRecord | null> {
    try {
      return parseJson<CanonicalKnowledgeRecord>(await readFile(this.jsonPath(id), "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  async list(): Promise<CanonicalKnowledgeRecord[]> {
    await mkdir(this.itemsDir, { recursive: true, mode: 0o700 });
    const files = (await readdir(this.itemsDir)).filter((file) => file.endsWith(".json")).sort();
    const records: CanonicalKnowledgeRecord[] = [];
    for (const file of files) {
      records.push(parseJson(await readFile(join(this.itemsDir, file), "utf8")));
    }
    return records;
  }

  async approveCandidate(candidate: CandidateRecord, now: string): Promise<CanonicalKnowledgeRecord> {
    const record: CanonicalKnowledgeRecord = {
      id: `mem_${candidate.id.replace(/^cand_/, "")}`,
      revision: 1,
      type: candidate.type,
      title: candidate.title,
      content: candidate.summary,
      scope: candidate.scope,
      status: "approved",
      is_constraint: false,
      provenance: {
        source_refs: candidate.source_refs,
        evidence_refs: candidate.evidence_refs,
        origin: "user_approved",
      },
      content_hash: candidate.content_hash,
      created_at: now,
      updated_at: now,
      expires_at: null,
      supersedes: [],
      conflicts: candidate.conflict_ids,
      use_count: 0,
    };
    await this.write(record);
    return record;
  }

  async seed(record: Omit<CanonicalKnowledgeRecord, "id" | "revision" | "content_hash" | "created_at" | "updated_at" | "use_count"> & {
    id?: string;
    created_at?: string;
  }): Promise<CanonicalKnowledgeRecord> {
    const now = record.created_at ?? new Date().toISOString();
    const complete: CanonicalKnowledgeRecord = {
      ...record,
      id: record.id ?? opaqueId("mem"),
      revision: 1,
      content_hash: sha256({ title: record.title, content: record.content, scope: record.scope, type: record.type }),
      created_at: now,
      updated_at: now,
      use_count: 0,
    };
    await this.write(complete);
    return complete;
  }

  async write(record: CanonicalKnowledgeRecord): Promise<void> {
    await mkdir(this.itemsDir, { recursive: true, mode: 0o700 });
    const json = `${JSON.stringify(record, null, 2)}\n`;
    const markdown = `# ${record.title}\n\n${record.content}\n\n---\n\n- Type: ${record.type}\n- Scope: ${record.scope}\n- Status: ${record.status}\n- Revision: ${record.revision}\n- Content hash: ${record.content_hash}\n`;
    const tempId = `${record.id}.${process.pid}.${Date.now()}.tmp`;
    const jsonTemp = join(this.itemsDir, `${tempId}.json`);
    const markdownTemp = join(this.itemsDir, `${tempId}.md`);
    await writeFile(jsonTemp, json, { encoding: "utf8", mode: 0o600 });
    await writeFile(markdownTemp, markdown, { encoding: "utf8", mode: 0o600 });
    await rename(jsonTemp, this.jsonPath(record.id));
    await rename(markdownTemp, this.markdownPath(record.id));
    this.upsertIndex(record);
  }

  private upsertIndex(record: CanonicalKnowledgeRecord): void {
    this.index.exec("BEGIN IMMEDIATE");
    try {
      this.index.prepare(`
        INSERT INTO index_records(
          id, revision, type, title, content, scope, status, is_constraint, provenance_json,
          content_hash, updated_at, expires_at, conflicts_json, use_count
        ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          revision=excluded.revision, type=excluded.type, title=excluded.title, content=excluded.content,
          scope=excluded.scope, status=excluded.status, is_constraint=excluded.is_constraint,
          provenance_json=excluded.provenance_json, content_hash=excluded.content_hash,
          updated_at=excluded.updated_at, expires_at=excluded.expires_at,
          conflicts_json=excluded.conflicts_json, use_count=excluded.use_count
      `).run(
        record.id,
        record.revision,
        record.type,
        record.title,
        record.content,
        record.scope,
        record.status,
        record.is_constraint ? 1 : 0,
        canonicalJson(record.provenance),
        record.content_hash,
        record.updated_at,
        record.expires_at,
        canonicalJson(record.conflicts),
        record.use_count,
      );
      if (this.fts5Available) {
        this.index.prepare("DELETE FROM knowledge_fts WHERE id=?").run(record.id);
        this.index.prepare("INSERT INTO knowledge_fts(id, title, content) VALUES(?, ?, ?)")
          .run(record.id, record.title, record.content);
      }
      this.index.exec("COMMIT");
    } catch (error) {
      this.index.exec("ROLLBACK");
      throw error;
    }
  }

  async rebuild(): Promise<{ count: number; fts5: boolean }> {
    this.index.exec("DELETE FROM index_records;");
    if (this.fts5Available) this.index.exec("DELETE FROM knowledge_fts;");
    const records = await this.list();
    for (const record of records) this.upsertIndex(record);
    return { count: records.length, fts5: this.fts5Available };
  }

  search(input: SearchInput, now = new Date().toISOString()): SearchResult[] {
    const queryTerms = terms(input.query);
    const limit = Math.min(Math.max(input.limit ?? 8, 1), 50);
    const rows = this.index.prepare(`
      SELECT * FROM index_records
      WHERE status='approved' AND (expires_at IS NULL OR expires_at>?)
      ORDER BY updated_at DESC
    `).all(now) as unknown as IndexRow[];
    const filtered = rows.filter((row) =>
      scopeAllowed(row.scope, input.project_id, input.scopes) &&
      (!input.types?.length || input.types.includes(row.type)) &&
      (!input.statuses?.length || input.statuses.includes(row.status)),
    );
    if (!queryTerms.length) {
      return filtered.slice(0, limit).map((row, index) => toGuidance(row, 1 / (index + 1)));
    }

    let ftsRanks = new Map<string, number>();
    if (this.fts5Available) {
      try {
        const match = queryTerms.map((term) => `"${term.replaceAll('"', '""')}"`).join(" OR ");
        const ftsRows = this.index.prepare(
          "SELECT id, bm25(knowledge_fts) AS rank FROM knowledge_fts WHERE knowledge_fts MATCH ? LIMIT 200",
        ).all(match) as unknown as Array<{ id: string; rank: number }>;
        ftsRanks = new Map(ftsRows.map((row) => [row.id, Math.max(0.1, 10 - row.rank)]));
      } catch {
        ftsRanks = new Map();
      }
    }

    return filtered
      .map((row) => ({ row, score: (ftsRanks.get(row.id) ?? 0) + scoreText(queryTerms, row.title, row.content) }))
      .filter(({ score }) => score > 0)
      .sort((left, right) => right.score - left.score || right.row.updated_at.localeCompare(left.row.updated_at))
      .slice(0, limit)
      .map(({ row, score }) => toGuidance(row, score));
  }

  incrementUse(ids: string[]): void {
    const update = this.index.prepare("UPDATE index_records SET use_count=use_count+1 WHERE id=?");
    for (const id of ids) update.run(id);
  }

  async forget(id: string): Promise<{ knowledge: boolean; index: boolean }> {
    const existed = await this.get(id);
    await rm(this.jsonPath(id), { force: true });
    await rm(this.markdownPath(id), { force: true });
    const result = this.index.prepare("DELETE FROM index_records WHERE id=?").run(id);
    if (this.fts5Available) this.index.prepare("DELETE FROM knowledge_fts WHERE id=?").run(id);
    return { knowledge: Boolean(existed), index: Number(result.changes) > 0 };
  }

  status(): { fts5: boolean; mode: "fts5" | "deterministic-fallback"; records: number } {
    const row = this.index.prepare("SELECT count(*) AS count FROM index_records").get() as { count: number };
    return {
      fts5: this.fts5Available,
      mode: this.fts5Available ? "fts5" : "deterministic-fallback",
      records: row.count,
    };
  }

  estimatedContentTokens(record: CanonicalKnowledgeRecord): number {
    return estimateTokens(`${record.title}\n${record.content}`);
  }
}
