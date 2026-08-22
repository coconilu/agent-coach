import { DatabaseSync } from "node:sqlite";
import type {
  CandidateRecord,
  GuidancePacket,
  OutcomeRecord,
  TurnRef,
} from "../contracts.js";
import { CoachError } from "../errors.js";
import { canonicalJson, parseJson, sha256 } from "../utils.js";

export type TurnState = "OBSERVED" | "PREPARED" | "COMMITTED" | "EXECUTING" | "COMPLETED";

export interface TurnRecord extends TurnRef {
  turn_key: string;
  state: TurnState;
  task_type: string;
  goal_summary: string;
  intent: unknown | null;
  execution_epoch: number;
  active_epoch: number | null;
  active_until: string | null;
  packet_id: string | null;
  plan_digest: string | null;
  revised_plan: unknown | null;
  adoption: unknown[];
  created_at: string;
  updated_at: string;
  expires_at: string;
}

interface TurnRow {
  turn_key: string;
  project_id: string;
  host: string;
  session_id: string;
  turn_id: string;
  state: TurnState;
  task_type: string;
  goal_summary: string;
  intent_json: string | null;
  execution_epoch: number;
  active_epoch: number | null;
  active_until: string | null;
  packet_id: string | null;
  plan_digest: string | null;
  revised_plan_json: string | null;
  adoption_json: string;
  created_at: string;
  updated_at: string;
  expires_at: string;
}

interface CandidateRow {
  id: string;
  proposal_id: string;
  type: CandidateRecord["type"];
  title: string;
  summary: string;
  scope: string;
  explicitness: CandidateRecord["explicitness"];
  confidence: number;
  source_refs_json: string;
  evidence_refs_json: string;
  status: CandidateRecord["status"];
  revision: number;
  content_hash: string;
  created_at: string;
  updated_at: string;
  conflict_ids_json: string;
}

export interface TicketRow {
  ticket_hash: string;
  turn_key: string;
  packet_id: string;
  plan_digest: string;
  execution_epoch: number;
  created_at: string;
  expires_at: string;
  redeemed_at: string | null;
}

export interface SettingsRecord {
  revision: number;
  learning_paused: boolean;
  recall_enabled: boolean;
  gate_mode: "advisory" | "enforce";
  journal_ttl_days: number;
  diagnostic_capture_ttl_days: number;
  provider_consent: boolean;
}

export interface StateStoreOptions {
  path: string;
}

export function turnKey(ref: TurnRef): string {
  return sha256({
    project_id: ref.project_id,
    host: ref.host,
    session_id: ref.session_id,
    turn_id: ref.turn_id,
  });
}

function toTurn(row: TurnRow): TurnRecord {
  return {
    turn_key: row.turn_key,
    project_id: row.project_id,
    host: row.host,
    session_id: row.session_id,
    turn_id: row.turn_id,
    state: row.state,
    task_type: row.task_type,
    goal_summary: row.goal_summary,
    intent: row.intent_json ? parseJson(row.intent_json) : null,
    execution_epoch: row.execution_epoch,
    active_epoch: row.active_epoch,
    active_until: row.active_until,
    packet_id: row.packet_id,
    plan_digest: row.plan_digest,
    revised_plan: row.revised_plan_json ? parseJson(row.revised_plan_json) : null,
    adoption: parseJson<unknown[]>(row.adoption_json),
    created_at: row.created_at,
    updated_at: row.updated_at,
    expires_at: row.expires_at,
  };
}

function toCandidate(row: CandidateRow): CandidateRecord {
  return {
    id: row.id,
    proposal_id: row.proposal_id,
    type: row.type,
    title: row.title,
    summary: row.summary,
    scope: row.scope,
    explicitness: row.explicitness,
    confidence: row.confidence,
    source_refs: parseJson(row.source_refs_json),
    evidence_refs: parseJson(row.evidence_refs_json),
    status: row.status,
    revision: row.revision,
    content_hash: row.content_hash,
    created_at: row.created_at,
    updated_at: row.updated_at,
    conflict_ids: parseJson(row.conflict_ids_json),
  };
}

export class StateStore {
  readonly db: DatabaseSync;
  private closed = false;

  constructor(options: StateStoreOptions) {
    this.db = new DatabaseSync(options.path);
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS idempotency (
        scope TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        payload_hash TEXT NOT NULL,
        response_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY(scope, idempotency_key)
      );
      CREATE TABLE IF NOT EXISTS turns (
        turn_key TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        host TEXT NOT NULL,
        session_id TEXT NOT NULL,
        turn_id TEXT NOT NULL,
        state TEXT NOT NULL,
        task_type TEXT NOT NULL,
        goal_summary TEXT NOT NULL,
        intent_json TEXT,
        execution_epoch INTEGER NOT NULL DEFAULT 0,
        active_epoch INTEGER,
        active_until TEXT,
        packet_id TEXT,
        plan_digest TEXT,
        revised_plan_json TEXT,
        adoption_json TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        UNIQUE(project_id, host, session_id, turn_id)
      );
      CREATE TABLE IF NOT EXISTS packets (
        packet_id TEXT PRIMARY KEY,
        turn_key TEXT NOT NULL REFERENCES turns(turn_key),
        payload_json TEXT NOT NULL,
        plan_digest TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS tickets (
        ticket_hash TEXT PRIMARY KEY,
        turn_key TEXT NOT NULL REFERENCES turns(turn_key),
        packet_id TEXT NOT NULL,
        plan_digest TEXT NOT NULL,
        execution_epoch INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        redeemed_at TEXT
      );
      CREATE TABLE IF NOT EXISTS outcomes (
        outcome_id TEXT PRIMARY KEY,
        turn_key TEXT NOT NULL UNIQUE REFERENCES turns(turn_key),
        status TEXT NOT NULL,
        summary TEXT NOT NULL,
        evidence_refs_json TEXT NOT NULL,
        candidate_refs_json TEXT NOT NULL,
        completed_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS candidates (
        id TEXT PRIMARY KEY,
        proposal_id TEXT NOT NULL,
        type TEXT NOT NULL,
        title TEXT NOT NULL,
        summary TEXT NOT NULL,
        scope TEXT NOT NULL,
        explicitness TEXT NOT NULL,
        confidence REAL NOT NULL,
        source_refs_json TEXT NOT NULL,
        evidence_refs_json TEXT NOT NULL,
        status TEXT NOT NULL,
        revision INTEGER NOT NULL,
        content_hash TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        conflict_ids_json TEXT NOT NULL DEFAULT '[]',
        UNIQUE(proposal_id, content_hash)
      );
      CREATE TABLE IF NOT EXISTS feedback (
        id TEXT PRIMARY KEY,
        packet_id TEXT,
        memory_id TEXT,
        sentiment TEXT NOT NULL,
        note TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS audit (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_type TEXT NOT NULL,
        target_id TEXT,
        result_code TEXT NOT NULL,
        metadata_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS settings (
        id INTEGER PRIMARY KEY CHECK(id = 1),
        revision INTEGER NOT NULL,
        payload_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS previews (
        proposal_hash TEXT PRIMARY KEY,
        operation TEXT NOT NULL,
        target_id TEXT,
        base_revision INTEGER NOT NULL,
        payload_json TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        consumed_at TEXT
      );
      CREATE TABLE IF NOT EXISTS browser_nonces (
        nonce_hash TEXT PRIMARY KEY,
        expires_at TEXT NOT NULL,
        consumed_at TEXT
      );
      CREATE TABLE IF NOT EXISTS browser_sessions (
        session_hash TEXT PRIMARY KEY,
        csrf_hash TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS integrations (
        host TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        version TEXT,
        details_json TEXT NOT NULL,
        revision INTEGER NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
    const defaults: SettingsRecord = {
      revision: 1,
      learning_paused: false,
      recall_enabled: true,
      gate_mode: "advisory",
      journal_ttl_days: 30,
      diagnostic_capture_ttl_days: 7,
      provider_consent: false,
    };
    this.db.prepare(
      "INSERT OR IGNORE INTO settings(id, revision, payload_json, updated_at) VALUES(1, 1, ?, ?)",
    ).run(canonicalJson(defaults), new Date(0).toISOString());
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }

  transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const value = fn();
      this.db.exec("COMMIT");
      return value;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  idempotent<T>(
    scope: string,
    key: string,
    payload: unknown,
    now: string,
    mutation: () => T,
  ): T {
    const payloadHash = sha256(payload);
    return this.transaction(() => {
      const existing = this.db.prepare(
        "SELECT payload_hash, response_json FROM idempotency WHERE scope = ? AND idempotency_key = ?",
      ).get(scope, key) as { payload_hash: string; response_json: string } | undefined;
      if (existing) {
        if (existing.payload_hash !== payloadHash) {
          throw new CoachError(
            "IDEMPOTENCY_CONFLICT",
            "The idempotency key was already used with a different payload",
          );
        }
        return parseJson<T>(existing.response_json);
      }
      const response = mutation();
      this.db.prepare(
        "INSERT INTO idempotency(scope, idempotency_key, payload_hash, response_json, created_at) VALUES(?, ?, ?, ?, ?)",
      ).run(scope, key, payloadHash, canonicalJson(response), now);
      return response;
    });
  }

  idempotentMapped<TStored, TResult>(
    scope: string,
    key: string,
    payload: unknown,
    now: string,
    mutation: () => TResult,
    storeResult: (result: TResult) => TStored,
    restoreResult: (stored: TStored) => TResult,
  ): TResult {
    const payloadHash = sha256(payload);
    return this.transaction(() => {
      const existing = this.db.prepare(
        "SELECT payload_hash, response_json FROM idempotency WHERE scope=? AND idempotency_key=?",
      ).get(scope, key) as { payload_hash: string; response_json: string } | undefined;
      if (existing) {
        if (existing.payload_hash !== payloadHash) {
          throw new CoachError("IDEMPOTENCY_CONFLICT", "The idempotency key was already used with a different payload");
        }
        return restoreResult(parseJson<TStored>(existing.response_json));
      }
      const result = mutation();
      this.db.prepare(`
        INSERT INTO idempotency(scope, idempotency_key, payload_hash, response_json, created_at)
        VALUES(?, ?, ?, ?, ?)
      `).run(scope, key, payloadHash, canonicalJson(storeResult(result)), now);
      return result;
    });
  }

  replayIdempotent<T>(scope: string, key: string, payload: unknown): { found: false } | { found: true; value: T } {
    const existing = this.db.prepare(
      "SELECT payload_hash, response_json FROM idempotency WHERE scope=? AND idempotency_key=?",
    ).get(scope, key) as { payload_hash: string; response_json: string } | undefined;
    if (!existing) return { found: false };
    if (existing.payload_hash !== sha256(payload)) {
      throw new CoachError("IDEMPOTENCY_CONFLICT", "The idempotency key was already used with a different payload");
    }
    return { found: true, value: parseJson<T>(existing.response_json) };
  }

  saveIdempotent(scope: string, key: string, payload: unknown, response: unknown, now: string): void {
    this.db.prepare(`
      INSERT INTO idempotency(scope, idempotency_key, payload_hash, response_json, created_at)
      VALUES(?, ?, ?, ?, ?)
    `).run(scope, key, sha256(payload), canonicalJson(response), now);
  }

  getSettings(): SettingsRecord {
    const row = this.db.prepare("SELECT revision, payload_json FROM settings WHERE id = 1").get() as {
      revision: number;
      payload_json: string;
    };
    const payload = parseJson<Omit<SettingsRecord, "revision">>(row.payload_json);
    return { ...payload, revision: row.revision };
  }

  updateSettings(settings: SettingsRecord, now: string): void {
    const { revision, ...payload } = settings;
    this.db.prepare("UPDATE settings SET revision = ?, payload_json = ?, updated_at = ? WHERE id = 1")
      .run(revision, canonicalJson(payload), now);
  }

  insertTurn(record: TurnRecord): void {
    this.db.prepare(`
      INSERT INTO turns(
        turn_key, project_id, host, session_id, turn_id, state, task_type, goal_summary,
        intent_json, execution_epoch, active_epoch, active_until, packet_id, plan_digest,
        revised_plan_json, adoption_json, created_at, updated_at, expires_at
      ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      record.turn_key,
      record.project_id,
      record.host,
      record.session_id,
      record.turn_id,
      record.state,
      record.task_type,
      record.goal_summary,
      record.intent === null ? null : canonicalJson(record.intent),
      record.execution_epoch,
      record.active_epoch,
      record.active_until,
      record.packet_id,
      record.plan_digest,
      record.revised_plan === null ? null : canonicalJson(record.revised_plan),
      canonicalJson(record.adoption),
      record.created_at,
      record.updated_at,
      record.expires_at,
    );
  }

  getTurn(ref: TurnRef): TurnRecord | null {
    return this.getTurnByKey(turnKey(ref));
  }

  getTurnByKey(key: string): TurnRecord | null {
    const row = this.db.prepare("SELECT * FROM turns WHERE turn_key = ?").get(key) as TurnRow | undefined;
    return row ? toTurn(row) : null;
  }

  findUnfinishedTurns(host: string, sessionId: string, now: string): TurnRecord[] {
    const rows = this.db.prepare(`
      SELECT * FROM turns
      WHERE host=? AND session_id=? AND state!='COMPLETED' AND expires_at>?
      ORDER BY updated_at DESC LIMIT 3
    `).all(host, sessionId, now) as unknown as TurnRow[];
    return rows.map(toTurn);
  }

  updatePrepared(key: string, packet: GuidancePacket, intent: unknown, now: string): void {
    this.db.prepare(`
      UPDATE turns SET state='PREPARED', intent_json=?, active_epoch=NULL, active_until=NULL,
        packet_id=?, plan_digest=?, updated_at=? WHERE turn_key=?
    `).run(canonicalJson(intent), packet.packet_id, packet.plan_digest, now, key);
    this.db.prepare(
      "INSERT INTO packets(packet_id, turn_key, payload_json, plan_digest, created_at, expires_at) VALUES(?, ?, ?, ?, ?, ?)",
    ).run(packet.packet_id, key, canonicalJson(packet), packet.plan_digest, packet.created_at, packet.expires_at);
  }

  getPacket(packetId: string): GuidancePacket | null {
    const row = this.db.prepare("SELECT payload_json FROM packets WHERE packet_id = ?").get(packetId) as
      | { payload_json: string }
      | undefined;
    return row ? parseJson<GuidancePacket>(row.payload_json) : null;
  }

  updateCommitted(
    key: string,
    packetId: string,
    planDigest: string,
    revisedPlan: unknown,
    adoption: unknown[],
    epoch: number,
    now: string,
  ): void {
    this.db.prepare(`
      UPDATE turns SET state='COMMITTED', packet_id=?, plan_digest=?, revised_plan_json=?, adoption_json=?,
        execution_epoch=?, active_epoch=NULL, active_until=NULL, updated_at=? WHERE turn_key=?
    `).run(packetId, planDigest, canonicalJson(revisedPlan), canonicalJson(adoption), epoch, now, key);
  }

  insertTicket(ticket: TicketRow): void {
    this.db.prepare(`
      INSERT INTO tickets(ticket_hash, turn_key, packet_id, plan_digest, execution_epoch, created_at, expires_at, redeemed_at)
      VALUES(?, ?, ?, ?, ?, ?, ?, NULL)
    `).run(
      ticket.ticket_hash,
      ticket.turn_key,
      ticket.packet_id,
      ticket.plan_digest,
      ticket.execution_epoch,
      ticket.created_at,
      ticket.expires_at,
    );
  }

  getTicket(ticketHash: string): TicketRow | null {
    return (this.db.prepare("SELECT * FROM tickets WHERE ticket_hash = ?").get(ticketHash) as TicketRow | undefined) ?? null;
  }

  getPendingTicket(turnKeyValue: string, epoch: number): TicketRow | null {
    return (this.db.prepare(`
      SELECT * FROM tickets
      WHERE turn_key=? AND execution_epoch=? AND redeemed_at IS NULL
      ORDER BY created_at DESC LIMIT 1
    `).get(turnKeyValue, epoch) as TicketRow | undefined) ?? null;
  }

  markExecuting(key: string, epoch: number, activeUntil: string, now: string, ticketHash: string): void {
    this.db.prepare("UPDATE tickets SET redeemed_at = ? WHERE ticket_hash = ? AND redeemed_at IS NULL")
      .run(now, ticketHash);
    this.db.prepare(
      "UPDATE turns SET state='EXECUTING', active_epoch=?, active_until=?, updated_at=? WHERE turn_key=?",
    ).run(epoch, activeUntil, now, key);
  }

  insertOutcome(outcome: OutcomeRecord, key: string): void {
    this.db.prepare(`
      INSERT INTO outcomes(outcome_id, turn_key, status, summary, evidence_refs_json, candidate_refs_json, completed_at)
      VALUES(?, ?, ?, ?, ?, ?, ?)
    `).run(
      outcome.outcome_id,
      key,
      outcome.status,
      outcome.summary,
      canonicalJson(outcome.evidence_refs),
      canonicalJson(outcome.candidate_refs),
      outcome.completed_at,
    );
    this.db.prepare(
      "UPDATE turns SET state='COMPLETED', active_epoch=NULL, active_until=NULL, updated_at=? WHERE turn_key=?",
    ).run(outcome.completed_at, key);
  }

  insertCandidate(candidate: CandidateRecord): void {
    this.db.prepare(`
      INSERT INTO candidates(
        id, proposal_id, type, title, summary, scope, explicitness, confidence,
        source_refs_json, evidence_refs_json, status, revision, content_hash,
        created_at, updated_at, conflict_ids_json
      ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      candidate.id,
      candidate.proposal_id,
      candidate.type,
      candidate.title,
      candidate.summary,
      candidate.scope,
      candidate.explicitness,
      candidate.confidence,
      canonicalJson(candidate.source_refs),
      canonicalJson(candidate.evidence_refs),
      candidate.status,
      candidate.revision,
      candidate.content_hash,
      candidate.created_at,
      candidate.updated_at,
      canonicalJson(candidate.conflict_ids),
    );
  }

  findCandidateByProposal(proposalId: string, contentHash: string): CandidateRecord | null {
    const row = this.db.prepare(
      "SELECT * FROM candidates WHERE proposal_id=? AND content_hash=?",
    ).get(proposalId, contentHash) as CandidateRow | undefined;
    return row ? toCandidate(row) : null;
  }

  findActiveCandidateByContent(type: string, scope: string, contentHash: string): CandidateRecord | null {
    const row = this.db.prepare(`
      SELECT * FROM candidates WHERE type=? AND scope=? AND content_hash=? AND status='candidate'
      ORDER BY created_at LIMIT 1
    `).get(type, scope, contentHash) as CandidateRow | undefined;
    return row ? toCandidate(row) : null;
  }

  getCandidate(id: string): CandidateRecord | null {
    const row = this.db.prepare("SELECT * FROM candidates WHERE id=?").get(id) as CandidateRow | undefined;
    return row ? toCandidate(row) : null;
  }

  listCandidates(status?: CandidateRecord["status"]): CandidateRecord[] {
    const rows = (status
      ? this.db.prepare("SELECT * FROM candidates WHERE status=? ORDER BY created_at DESC").all(status)
      : this.db.prepare("SELECT * FROM candidates ORDER BY created_at DESC").all()) as unknown as CandidateRow[];
    return rows.map(toCandidate);
  }

  updateCandidateStatus(id: string, status: CandidateRecord["status"], revision: number, now: string): void {
    this.db.prepare("UPDATE candidates SET status=?, revision=?, updated_at=? WHERE id=?")
      .run(status, revision, now, id);
  }

  markCandidatePromoted(id: string, revision: number, now: string): void {
    this.db.prepare(`
      UPDATE candidates SET status='approved', revision=?, title='[promoted]', summary='',
        source_refs_json='[]', evidence_refs_json='[]', updated_at=? WHERE id=?
    `).run(revision, now, id);
  }

  deleteCandidateBody(id: string, now: string): void {
    this.db.prepare(`
      UPDATE candidates SET title='[forgotten]', summary='', source_refs_json='[]', evidence_refs_json='[]',
        status='obsolete', revision=revision+1, content_hash='', updated_at=? WHERE id=?
    `).run(now, id);
  }

  scrubMemoryReferences(memoryId: string, candidateId: string | null, proposalId: string | null, now: string): void {
    this.transaction(() => {
      const packetRows = this.db.prepare("SELECT packet_id, payload_json FROM packets").all() as unknown as Array<{
        packet_id: string;
        payload_json: string;
      }>;
      const sections = ["constraints", "preferences", "facts", "experiences", "procedures"] as const;
      const updatePacket = this.db.prepare("UPDATE packets SET payload_json=? WHERE packet_id=?");
      for (const row of packetRows) {
        const packet = parseJson<Record<string, unknown>>(row.payload_json);
        let changed = false;
        for (const section of sections) {
          const items = Array.isArray(packet[section]) ? packet[section] as Array<Record<string, unknown>> : [];
          const filtered = items.filter((item) => item.memory_id !== memoryId);
          if (filtered.length !== items.length) {
            packet[section] = filtered;
            changed = true;
          }
        }
        if (changed) updatePacket.run(canonicalJson(packet), row.packet_id);
      }
      if (candidateId) this.deleteCandidateBody(candidateId, now);
      this.db.prepare("UPDATE feedback SET note='' WHERE memory_id=?").run(memoryId);
      this.db.prepare("DELETE FROM previews WHERE target_id IN (?, ?)").run(memoryId, candidateId ?? "");
      this.db.prepare("DELETE FROM idempotency WHERE response_json LIKE ? OR payload_hash = ?")
        .run(`%${memoryId}%`, sha256(memoryId));
      if (proposalId) {
        this.db.prepare("DELETE FROM idempotency WHERE response_json LIKE ?").run(`%${proposalId}%`);
      }
    });
  }

  addFeedback(record: {
    id: string;
    packetId?: string;
    memoryId?: string;
    sentiment: string;
    note: string;
    createdAt: string;
  }): void {
    this.db.prepare(
      "INSERT INTO feedback(id, packet_id, memory_id, sentiment, note, created_at) VALUES(?, ?, ?, ?, ?, ?)",
    ).run(
      record.id,
      record.packetId ?? null,
      record.memoryId ?? null,
      record.sentiment,
      record.note,
      record.createdAt,
    );
  }

  audit(eventType: string, targetId: string | null, resultCode: string, metadata: unknown, now: string): void {
    this.db.prepare(
      "INSERT INTO audit(event_type, target_id, result_code, metadata_json, created_at) VALUES(?, ?, ?, ?, ?)",
    ).run(eventType, targetId, resultCode, canonicalJson(metadata), now);
  }

  savePreview(preview: {
    proposalHash: string;
    operation: string;
    targetId: string | null;
    baseRevision: number;
    payload: unknown;
    expiresAt: string;
  }): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO previews(proposal_hash, operation, target_id, base_revision, payload_json, expires_at, consumed_at)
      VALUES(?, ?, ?, ?, ?, ?, NULL)
    `).run(
      preview.proposalHash,
      preview.operation,
      preview.targetId,
      preview.baseRevision,
      canonicalJson(preview.payload),
      preview.expiresAt,
    );
  }

  getPreview(proposalHash: string): {
    proposal_hash: string;
    operation: string;
    target_id: string | null;
    base_revision: number;
    payload_json: string;
    expires_at: string;
    consumed_at: string | null;
  } | null {
    return (this.db.prepare("SELECT * FROM previews WHERE proposal_hash=?").get(proposalHash) as ReturnType<StateStore["getPreview"]>) ?? null;
  }

  consumePreview(proposalHash: string, now: string): void {
    this.db.prepare("UPDATE previews SET consumed_at=? WHERE proposal_hash=? AND consumed_at IS NULL")
      .run(now, proposalHash);
  }

  saveBrowserNonce(nonceHash: string, expiresAt: string): void {
    this.db.prepare("INSERT INTO browser_nonces(nonce_hash, expires_at, consumed_at) VALUES(?, ?, NULL)")
      .run(nonceHash, expiresAt);
  }

  consumeBrowserNonce(nonceHash: string, now: string): boolean {
    const result = this.db.prepare(`
      UPDATE browser_nonces SET consumed_at=?
      WHERE nonce_hash=? AND consumed_at IS NULL AND expires_at>?
    `).run(now, nonceHash, now);
    return Number(result.changes) === 1;
  }

  saveBrowserSession(sessionHash: string, csrfHash: string, expiresAt: string, now: string): void {
    this.db.prepare(
      "INSERT INTO browser_sessions(session_hash, csrf_hash, expires_at, created_at) VALUES(?, ?, ?, ?)",
    ).run(sessionHash, csrfHash, expiresAt, now);
  }

  getBrowserSession(sessionHash: string, now: string): { csrf_hash: string } | null {
    return (this.db.prepare(
      "SELECT csrf_hash FROM browser_sessions WHERE session_hash=? AND expires_at>?",
    ).get(sessionHash, now) as { csrf_hash: string } | undefined) ?? null;
  }

  listIntegrations(): Array<Record<string, unknown>> {
    const rows = this.db.prepare("SELECT * FROM integrations ORDER BY host").all() as unknown as Array<{
      host: string;
      status: string;
      version: string | null;
      details_json: string;
      revision: number;
      updated_at: string;
    }>;
    return rows.map((row) => ({
      host: row.host,
      status: row.status,
      version: row.version,
      details: parseJson(row.details_json),
      revision: row.revision,
      updated_at: row.updated_at,
    }));
  }

  dashboardOverview(): Record<string, unknown> {
    const candidateCounts = this.db.prepare(
      "SELECT status, count(*) AS count FROM candidates GROUP BY status",
    ).all() as unknown as Array<{ status: string; count: number }>;
    const turnCounts = this.db.prepare(
      "SELECT state, count(*) AS count FROM turns GROUP BY state",
    ).all() as unknown as Array<{ state: string; count: number }>;
    const feedbackCounts = this.db.prepare(
      "SELECT sentiment, count(*) AS count FROM feedback GROUP BY sentiment",
    ).all() as unknown as Array<{ sentiment: string; count: number }>;
    const recentTurns = this.db.prepare(`
      SELECT turn_key, project_id, host, turn_id, state, task_type, goal_summary,
        execution_epoch, packet_id, created_at, updated_at
      FROM turns ORDER BY updated_at DESC LIMIT 10
    `).all();
    return {
      candidates: Object.fromEntries(candidateCounts.map((row) => [row.status, row.count])),
      turns: Object.fromEntries(turnCounts.map((row) => [row.state, row.count])),
      feedback: Object.fromEntries(feedbackCounts.map((row) => [row.sentiment, row.count])),
      recent_turns: recentTurns,
    };
  }

  listTurns(limit = 100): Array<Record<string, unknown>> {
    return this.db.prepare(`
      SELECT turn_key, project_id, host, session_id, turn_id, state, task_type, goal_summary,
        execution_epoch, active_epoch, packet_id, plan_digest, revised_plan_json, adoption_json,
        created_at, updated_at
      FROM turns ORDER BY updated_at DESC LIMIT ?
    `).all(Math.min(Math.max(limit, 1), 500)).map((raw) => {
      const row = raw as Record<string, unknown> & { revised_plan_json: string | null; adoption_json: string };
      return {
        ...row,
        revised_plan: row.revised_plan_json ? parseJson(row.revised_plan_json) : null,
        adoption: parseJson(row.adoption_json),
        revised_plan_json: undefined,
        adoption_json: undefined,
      };
    });
  }

  listAudit(limit = 100): Array<Record<string, unknown>> {
    return this.db.prepare(
      "SELECT id, event_type, target_id, result_code, metadata_json, created_at FROM audit ORDER BY id DESC LIMIT ?",
    ).all(Math.min(Math.max(limit, 1), 500)).map((raw) => {
      const row = raw as Record<string, unknown> & { metadata_json: string };
      return { ...row, metadata: parseJson(row.metadata_json), metadata_json: undefined };
    });
  }

  pruneJournal(before: string): number {
    const result = this.db.prepare("DELETE FROM audit WHERE created_at < ? AND event_type NOT LIKE 'governance.%'")
      .run(before);
    return Number(result.changes);
  }

  exportState(): Record<string, unknown> {
    const candidates = this.listCandidates();
    const turns = this.db.prepare(`
      SELECT project_id, host, session_id, turn_id, state, task_type, goal_summary,
        execution_epoch, created_at, updated_at FROM turns ORDER BY created_at
    `).all();
    const outcomes = this.db.prepare(`
      SELECT outcome_id, status, summary, evidence_refs_json, candidate_refs_json, completed_at
      FROM outcomes ORDER BY completed_at
    `).all();
    return { protocol_version: "agent-coach/v1", settings: this.getSettings(), candidates, turns, outcomes };
  }

  resetOperationalState(now: string): void {
    this.transaction(() => {
      this.db.exec("DELETE FROM tickets; DELETE FROM packets; DELETE FROM outcomes; DELETE FROM turns; DELETE FROM idempotency;");
      this.audit("privacy.reset", null, "SUCCESS", { scope: "operational" }, now);
    });
  }

  clearCandidates(now: string): number {
    return this.transaction(() => {
      const count = (this.db.prepare("SELECT count(*) AS count FROM candidates").get() as { count: number }).count;
      this.db.exec("DELETE FROM candidates;");
      this.audit("privacy.reset", null, "SUCCESS", { scope: "candidates", count }, now);
      return count;
    });
  }
}
