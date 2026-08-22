import type {
  ActionTicket,
  CandidateRecord,
  CommitPlanInput,
  CompleteInput,
  FeedbackInput,
  GateDecision,
  GateInput,
  GuidanceItem,
  GuidancePacket,
  LearningProposal,
  MutationPreviewV1,
  ObserveInput,
  OutcomeRecord,
  PrepareInput,
  SearchInput,
  TurnRef,
} from "./contracts.js";
import {
  CommitPlanInputSchema,
  CompleteInputSchema,
  FeedbackInputSchema,
  LearningProposalSchema,
  ObserveInputSchema,
  PrepareInputSchema,
  PROTOCOL_VERSION,
} from "./contracts.js";
import { classifyAction } from "./action-classifier.js";
import { CoachError } from "./errors.js";
import { ensureSafePaths, resolvePaths, type CoachPaths } from "./paths.js";
import { DisabledMemoryProvider, type MemoryProvider } from "./providers/memory-provider.js";
import { KnowledgeStore, type CanonicalKnowledgeRecord, type SearchResult } from "./storage/knowledge-store.js";
import { StateStore, turnKey, type SettingsRecord, type TurnRecord } from "./storage/state-store.js";
import {
  addMilliseconds,
  canonicalJson,
  estimateTokens,
  isoNow,
  opaqueId,
  sha256,
  type Clock,
  systemClock,
} from "./utils.js";

const TURN_TTL_MS = 24 * 60 * 60 * 1_000;
const PACKET_TTL_MS = 15 * 60 * 1_000;
const TICKET_TTL_MS = 10 * 60 * 1_000;
const PREVIEW_TTL_MS = 10 * 60 * 1_000;
const MAX_GUIDANCE_ITEMS = 8;
const MAX_GUIDANCE_TOKENS = 1_200;

export interface AgentCoachCoreOptions {
  home?: string;
  knowledgeHome?: string;
  sourceRoot?: string;
  provider?: MemoryProvider;
  clock?: Clock;
}

export interface ApproveInput {
  candidate_id: string;
  proposal_hash: string;
  base_revision: number;
  idempotency_key: string;
}

export interface RejectInput {
  candidate_id: string;
  reason: string;
  idempotency_key: string;
}

export interface ExactApplyInput {
  proposal_hash: string;
  base_revision: number;
  idempotency_key: string;
}

function assertFresh(expiresAt: string, now: string, code: "PACKET_STALE" | "TICKET_INVALID" | "REVISION_CONFLICT"): void {
  if (expiresAt <= now) throw new CoachError(code, "The referenced object has expired");
}

function pickTurnRef(value: TurnRef): TurnRef {
  return {
    project_id: value.project_id,
    host: value.host,
    session_id: value.session_id,
    turn_id: value.turn_id,
  };
}

function allPacketItems(packet: GuidancePacket): GuidanceItem[] {
  return [
    ...packet.constraints,
    ...packet.preferences,
    ...packet.facts,
    ...packet.experiences,
    ...packet.procedures,
  ];
}

function sensitiveProposal(proposal: LearningProposal): boolean {
  const combined = `${proposal.title}\n${proposal.summary}\n${proposal.source_refs.join("\n")}\n${proposal.evidence_refs.join("\n")}`;
  return (
    /\b(?:authorization\s*:\s*bearer|bearer\s+[a-z0-9._-]{12,}|sk-[a-z0-9_-]{12,}|api[_ -]?key\s*[:=])\b/i.test(combined) ||
    /[A-Za-z]:\\(?:[^\\\s]+\\)*[^\\\s]+/.test(combined) ||
    /\/(?:Users|home)\/[^\s]+/.test(combined)
  );
}

function injectionDerived(proposal: LearningProposal): boolean {
  return proposal.source_refs.some((reference) =>
    reference === "agent-coach" ||
    reference.startsWith("agent-coach:") ||
    reference.startsWith("packet:"),
  );
}

function assertProposalScope(proposal: LearningProposal, projectId: string): void {
  if (!["global", projectId, `project:${projectId}`].includes(proposal.scope)) {
    throw new CoachError("PROVENANCE_INVALID", "Learning proposal scope does not match the active project");
  }
}

function candidatePromotionWarnings(candidate: CandidateRecord): string[] {
  const warnings: string[] = [];
  if (candidate.type === "preference" && candidate.explicitness === "inferred") {
    warnings.push("Inferred preferences require this explicit user approval and remain scoped.");
  }
  if (candidate.type === "fact" && candidate.evidence_refs.length === 0) {
    throw new CoachError("PROVENANCE_INVALID", "Facts require at least one freshness or content-hash evidence reference");
  }
  if (candidate.type === "experience" && candidate.evidence_refs.length === 0) {
    throw new CoachError("PROVENANCE_INVALID", "Experiences require at least one outcome evidence reference");
  }
  if (candidate.type === "procedure" && candidate.evidence_refs.length < 2) {
    if (!(candidate.explicitness === "explicit" && candidate.evidence_refs.length === 1)) {
      throw new CoachError(
        "PROVENANCE_INVALID",
        "Procedures require two independent successes or one explicit bounded-trial evidence reference",
      );
    }
    warnings.push("Approval is treated as a user-approved bounded trial; revalidate before broadening scope.");
  }
  return warnings;
}

function groupGuidance(
  turnRef: TurnRef,
  intent: PrepareInput["intent"],
  canonical: SearchResult[],
  providerItems: GuidanceItem[],
  now: string,
): GuidancePacket {
  const canonicalIds = new Set(canonical.map(({ item }) => item.memory_id));
  const conflicted = new Set<string>();
  const conflicts: GuidancePacket["conflicts"] = [];
  for (const result of canonical) {
    const peers = result.conflicts.filter((id) => canonicalIds.has(id));
    if (peers.length) {
      const ids = [...new Set([result.item.memory_id, ...peers])].sort();
      ids.forEach((id) => conflicted.add(id));
      if (!conflicts.some((conflict) => canonicalJson(conflict.memory_ids) === canonicalJson(ids))) {
        conflicts.push({ memory_ids: ids, reason: "Conflicting canonical bodies were isolated from instruction sections" });
      }
    }
  }

  const candidates: Array<{ item: GuidanceItem; isConstraint: boolean }> = [
    ...canonical
      .filter(({ item }) => !conflicted.has(item.memory_id))
      .map(({ item, is_constraint }) => ({ item, isConstraint: is_constraint })),
    ...providerItems.map((item) => ({ item, isConstraint: false })),
  ].sort((left, right) => {
    const authority = (item: GuidanceItem) => item.authority === "canonical" ? 2 : 1;
    return authority(right.item) - authority(left.item) || right.item.score - left.item.score;
  });

  const selected: Array<{ item: GuidanceItem; isConstraint: boolean }> = [];
  let tokens = 0;
  for (const candidate of candidates) {
    const candidateTokens = estimateTokens(`${candidate.item.title}\n${candidate.item.content}`);
    if (selected.length >= MAX_GUIDANCE_ITEMS || tokens + candidateTokens > MAX_GUIDANCE_TOKENS) continue;
    selected.push(candidate);
    tokens += candidateTokens;
  }

  const categorized = (type: GuidanceItem["type"]) =>
    selected.filter(({ item, isConstraint }) => item.type === type && !isConstraint).map(({ item }) => item);
  const planDigest = sha256(intent);
  return {
    protocol_version: PROTOCOL_VERSION,
    origin: "agent-coach",
    packet_id: opaqueId("packet"),
    turn_ref: turnRef,
    constraints: selected.filter(({ isConstraint, item }) => isConstraint && item.authority === "canonical").map(({ item }) => item),
    preferences: categorized("preference"),
    facts: categorized("fact"),
    experiences: categorized("experience"),
    procedures: categorized("procedure"),
    conflicts,
    omitted_summary: `${Math.max(0, candidates.length - selected.length)} item(s) omitted by conflict or context budget`,
    estimated_tokens: tokens,
    plan_digest: planDigest,
    created_at: now,
    expires_at: addMilliseconds(now, PACKET_TTL_MS),
  };
}

export class AgentCoachCore {
  readonly paths: CoachPaths;
  readonly state: StateStore;
  readonly knowledge: KnowledgeStore;
  readonly provider: MemoryProvider;
  private readonly clock: Clock;

  private constructor(options: AgentCoachCoreOptions, paths: CoachPaths) {
    this.paths = paths;
    this.clock = options.clock ?? systemClock;
    this.provider = options.provider ?? new DisabledMemoryProvider();
    this.state = new StateStore({ path: paths.stateDb });
    this.knowledge = new KnowledgeStore(paths.knowledgeHome, paths.indexDb);
  }

  static async create(options: AgentCoachCoreOptions = {}): Promise<AgentCoachCore> {
    const paths = resolvePaths(options.home, options.knowledgeHome);
    await ensureSafePaths(paths, options.sourceRoot);
    const core = new AgentCoachCore(options, paths);
    await core.knowledge.initialize();
    return core;
  }

  close(): void {
    this.knowledge.close();
    this.state.close();
  }

  private now(): string {
    return isoNow(this.clock);
  }

  observe(raw: ObserveInput): TurnRecord {
    const input = ObserveInputSchema.parse(raw);
    const ref = pickTurnRef(input);
    const key = turnKey(ref);
    const now = this.now();
    const terminalEvent = ["stop", "sessionend", "session_end"].includes(input.host_event?.event_type.toLowerCase() ?? "");
    return this.state.idempotent(`turn.observe:${key}`, input.idempotency_key, input, now, () => {
      const existing = this.state.getTurnByKey(key);
      if (existing) {
        if (!this.state.getSettings().learning_paused) {
          this.state.audit("turn.host_event", key, "SUCCESS", {
            event_type: input.host_event?.event_type ?? "observe",
            ...(input.host_event?.action_class ? { action_class: input.host_event.action_class } : {}),
          }, now);
        }
        if (terminalEvent && existing.state !== "COMPLETED") {
          this.state.insertOutcome({
            outcome_id: opaqueId("outcome"),
            turn_ref: ref,
            status: input.host_event?.outcome_status ?? "succeeded",
            summary: "Turn closed by a sanitized host lifecycle event",
            evidence_refs: [],
            candidate_refs: [],
            completed_at: now,
          }, key);
          return this.state.getTurnByKey(key)!;
        }
        return existing;
      }
      const record: TurnRecord = {
        ...ref,
        turn_key: key,
        state: "OBSERVED",
        task_type: input.task_type,
        goal_summary: input.goal_summary,
        intent: null,
        execution_epoch: 0,
        active_epoch: null,
        active_until: null,
        packet_id: null,
        plan_digest: null,
        revised_plan: null,
        adoption: [],
        created_at: now,
        updated_at: now,
        expires_at: addMilliseconds(now, TURN_TTL_MS),
      };
      this.state.insertTurn(record);
      if (!this.state.getSettings().learning_paused) {
        this.state.audit("turn.observed", key, "SUCCESS", {
          task_type: record.task_type,
          event_type: input.host_event?.event_type ?? "observe",
        }, now);
      }
      if (terminalEvent) {
        this.state.insertOutcome({
          outcome_id: opaqueId("outcome"),
          turn_ref: ref,
          status: input.host_event?.outcome_status ?? "succeeded",
          summary: "Turn closed by a sanitized host lifecycle event",
          evidence_refs: [],
          candidate_refs: [],
          completed_at: now,
        }, key);
        return this.state.getTurnByKey(key)!;
      }
      return record;
    });
  }

  async prepare(raw: PrepareInput): Promise<GuidancePacket> {
    const input = PrepareInputSchema.parse(raw);
    const ref = pickTurnRef(input);
    const key = turnKey(ref);
    const now = this.now();
    let turn = this.state.getTurnByKey(key);
    if (!turn) {
      turn = this.observe({
        ...ref,
        task_type: input.intent.task_type,
        goal_summary: input.intent.goal,
        idempotency_key: `auto-observe-${input.idempotency_key}`,
      });
    }
    if (turn.state === "COMPLETED") throw new CoachError("INVALID_STATE", "Completed turns cannot be prepared again");
    if (turn.expires_at <= now) throw new CoachError("INVALID_STATE", "Turn has expired");

    const settings = this.state.getSettings();
    const query = [
      input.intent.goal,
      input.intent.task_type,
      ...input.intent.planned_steps,
      ...input.intent.intended_tools,
      ...input.intent.constraints,
      ...input.intent.risk_flags,
    ].join(" ");
    const canonical = settings.recall_enabled
      ? this.knowledge.search({ query, project_id: input.project_id, limit: 24 }, now)
      : [];
    let providerItems: GuidanceItem[] = [];
    let providerDegraded = false;
    if (settings.recall_enabled && settings.provider_consent && this.provider.enabled) {
      try {
        providerItems = await this.provider.recall({ turn_ref: ref, intent: input.intent, query, limit: 8 });
      } catch {
        providerDegraded = true;
      }
    }

    const packet = groupGuidance(ref, input.intent, canonical, providerItems, now);
    return this.state.idempotent(`turn.prepare:${key}`, input.idempotency_key, input, now, () => {
      const current = this.state.getTurnByKey(key);
      if (!current || current.state === "COMPLETED") throw new CoachError("INVALID_STATE", "Turn is not preparable");
      this.state.updatePrepared(key, packet, input.intent, now);
      this.knowledge.incrementUse(allPacketItems(packet).map((item) => item.memory_id));
      this.state.audit("turn.prepared", key, providerDegraded ? "DEGRADED" : "SUCCESS", {
        packet_id: packet.packet_id,
        item_count: allPacketItems(packet).length,
        estimated_tokens: packet.estimated_tokens,
      }, now);
      return packet;
    });
  }

  commitPlan(raw: CommitPlanInput): ActionTicket {
    const input = CommitPlanInputSchema.parse(raw);
    const ref = pickTurnRef(input);
    const key = turnKey(ref);
    const now = this.now();
    return this.state.idempotentMapped<Omit<ActionTicket, "ticket">, ActionTicket>(
      `turn.commit:${key}`,
      input.idempotency_key,
      input,
      now,
      () => {
      const turn = this.state.getTurnByKey(key);
      if (!turn) throw new CoachError("TURN_NOT_FOUND", "Turn does not exist");
      if (!["PREPARED", "COMMITTED", "EXECUTING"].includes(turn.state)) {
        throw new CoachError("INVALID_STATE", "Turn must be prepared before a plan can be committed");
      }
      if (turn.packet_id !== input.packet_id) throw new CoachError("PACKET_STALE", "Packet is not current for this turn");
      const packet = this.state.getPacket(input.packet_id);
      if (!packet) throw new CoachError("PACKET_STALE", "Packet does not exist");
      assertFresh(packet.expires_at, now, "PACKET_STALE");
      // packet_id is the immutable link to the prepared intent. turn.plan_digest
      // intentionally changes to the revised-plan digest on every PlanCommit, so
      // comparing those two digests would incorrectly forbid a new epoch.

      const packetIds = new Set(allPacketItems(packet).map((item) => item.memory_id));
      const adoptedIds = new Set<string>();
      for (const adoption of input.adoption) {
        if (!packetIds.has(adoption.memory_id)) {
          throw new CoachError("VALIDATION_ERROR", "Adoption references a memory outside the GuidancePacket");
        }
        if (adoptedIds.has(adoption.memory_id)) {
          throw new CoachError("VALIDATION_ERROR", "Adoption decisions must be unique per memory");
        }
        adoptedIds.add(adoption.memory_id);
      }

      const epoch = turn.execution_epoch + 1;
      const planDigest = sha256(input.revised_plan);
      const ticketMetadata: Omit<ActionTicket, "ticket"> = {
        turn_ref: ref,
        packet_id: input.packet_id,
        plan_digest: planDigest,
        execution_epoch: epoch,
        created_at: now,
        expires_at: addMilliseconds(now, TICKET_TTL_MS),
      };
      // The ticket is a deterministic sequencing token, not an authentication
      // credential. HTTP bearer/session auth remains mandatory. Persist only
      // its hash; retries reconstruct the same token from immutable metadata.
      const rawTicket = `ticket_${sha256(ticketMetadata)}`;
      const ticket: ActionTicket = { ticket: rawTicket, ...ticketMetadata };
      this.state.updateCommitted(key, input.packet_id, planDigest, input.revised_plan, input.adoption, epoch, now);
      this.state.insertTicket({
        ticket_hash: sha256(rawTicket),
        turn_key: key,
        packet_id: input.packet_id,
        plan_digest: planDigest,
        execution_epoch: epoch,
        created_at: now,
        expires_at: ticket.expires_at,
        redeemed_at: null,
      });
      this.state.audit("turn.committed", key, "SUCCESS", { packet_id: input.packet_id, execution_epoch: epoch }, now);
      return ticket;
      },
      ({ ticket: _ticket, ...metadata }) => metadata,
      (metadata) => ({ ticket: `ticket_${sha256(metadata)}`, ...metadata }),
    );
  }

  checkGate(input: GateInput): GateDecision {
    const classification = classifyAction(input.action_name, input.action_arguments ?? {});
    const gatewayHealthy = input.gateway_healthy ?? true;
    const mode = input.mode ?? this.state.getSettings().gate_mode;
    if (!gatewayHealthy) {
      return { allowed: true, degraded: true, classification, reason: "Gateway is unhealthy; fail-open preserves host availability" };
    }
    if (classification.coverage === "unsupported") {
      return { allowed: true, degraded: true, classification, reason: "Action path is not covered by the host lifecycle hook" };
    }
    if (classification.class === "read") {
      return { allowed: true, degraded: false, classification, reason: "Explicit read-only action does not require a ticket" };
    }
    if (mode === "advisory") {
      return { allowed: true, degraded: false, classification, reason: "Advisory mode records missing coaching without blocking" };
    }

    const ref = pickTurnRef(input);
    const key = turnKey(ref);
    const now = this.now();
    return this.state.transaction(() => {
      const turn = this.state.getTurnByKey(key);
      if (!turn) {
        throw new CoachError("ACTION_REQUIRES_COACHING", "Run coach_prepare and coach_commit_plan before this action");
      }
      if (turn.state === "COMPLETED" || turn.expires_at <= now) {
        throw new CoachError("EPOCH_STALE", "The turn or execution epoch is no longer active");
      }
      if (
        turn.active_epoch !== null &&
        turn.active_until !== null &&
        turn.active_until > now &&
        (input.execution_epoch === undefined || input.execution_epoch === turn.active_epoch)
      ) {
        return {
          allowed: true,
          degraded: false,
          classification,
          execution_epoch: turn.active_epoch,
          reason: "Server-side execution epoch is active",
        };
      }
      if (input.execution_epoch !== undefined && input.execution_epoch !== turn.execution_epoch) {
        throw new CoachError("EPOCH_STALE", "Execution epoch was invalidated by a newer plan");
      }
      const ticketHash = input.ticket ? sha256(input.ticket) : undefined;
      const ticket = ticketHash
        ? this.state.getTicket(ticketHash)
        : this.state.getPendingTicket(key, turn.execution_epoch);
      if (!ticket && !input.ticket) {
        throw new CoachError("ACTION_REQUIRES_COACHING", "Run coach_prepare and coach_commit_plan before this action");
      }
      if (!ticket || ticket.turn_key !== key) throw new CoachError("TICKET_INVALID", "Ticket identity does not match this turn");
      if (
        ticket.packet_id !== turn.packet_id ||
        ticket.plan_digest !== turn.plan_digest ||
        ticket.execution_epoch !== turn.execution_epoch
      ) {
        throw new CoachError("EPOCH_STALE", "Ticket was invalidated by a newer plan or packet");
      }
      assertFresh(ticket.expires_at, now, "TICKET_INVALID");
      if (ticket.redeemed_at) {
        const refreshed = this.state.getTurnByKey(key);
        if (refreshed?.active_epoch === ticket.execution_epoch && refreshed.active_until && refreshed.active_until > now) {
          return {
            allowed: true,
            degraded: false,
            classification,
            execution_epoch: ticket.execution_epoch,
            reason: "Concurrent gate observed the already-active execution epoch",
          };
        }
        throw new CoachError("TICKET_REDEEMED", "Ticket has already been redeemed");
      }
      this.state.markExecuting(key, ticket.execution_epoch, ticket.expires_at, now, ticket.ticket_hash);
      this.state.audit("gate.redeemed", key, "SUCCESS", { execution_epoch: ticket.execution_epoch }, now);
      return {
        allowed: true,
        degraded: false,
        classification,
        execution_epoch: ticket.execution_epoch,
        reason: "Ticket was atomically redeemed and execution epoch activated",
      };
    });
  }

  complete(raw: CompleteInput): OutcomeRecord {
    const input = CompleteInputSchema.parse(raw);
    const ref = pickTurnRef(input);
    const key = turnKey(ref);
    const now = this.now();
    return this.state.idempotent(`turn.complete:${key}`, input.idempotency_key, input, now, () => {
      const turn = this.state.getTurnByKey(key);
      if (!turn) throw new CoachError("TURN_NOT_FOUND", "Turn does not exist");
      if (turn.state === "COMPLETED") throw new CoachError("INVALID_STATE", "Turn is already completed");
      const settings = this.state.getSettings();
      const candidateRefs: string[] = [];
      if (!settings.learning_paused) {
        for (const rawProposal of input.learning_proposals) {
          const proposal = LearningProposalSchema.parse(rawProposal);
          if (injectionDerived(proposal)) {
            this.state.audit("candidate.excluded", proposal.proposal_id, "INJECTION_DERIVED", {}, now);
            continue;
          }
          assertProposalScope(proposal, input.project_id);
          if (sensitiveProposal(proposal)) {
            throw new CoachError("PROVENANCE_INVALID", "Learning proposal contains a secret or absolute user path");
          }
          const contentHash = sha256({
            type: proposal.type,
            title: proposal.title.trim().toLowerCase(),
            summary: proposal.summary.trim(),
            scope: proposal.scope,
          });
          const duplicate =
            this.state.findCandidateByProposal(proposal.proposal_id, contentHash) ??
            this.state.findActiveCandidateByContent(proposal.type, proposal.scope, contentHash);
          if (duplicate) {
            candidateRefs.push(duplicate.id);
            continue;
          }
          const candidate: CandidateRecord = {
            id: opaqueId("cand"),
            proposal_id: proposal.proposal_id,
            type: proposal.type,
            title: proposal.title,
            summary: proposal.summary,
            scope: proposal.scope,
            explicitness: proposal.explicitness,
            confidence: proposal.confidence,
            source_refs: proposal.source_refs,
            evidence_refs: proposal.evidence_refs,
            status: "candidate",
            revision: 1,
            content_hash: contentHash,
            created_at: now,
            updated_at: now,
            conflict_ids: [],
          };
          this.state.insertCandidate(candidate);
          candidateRefs.push(candidate.id);
        }
      }
      const outcome: OutcomeRecord = {
        outcome_id: opaqueId("outcome"),
        turn_ref: ref,
        status: input.outcome_status,
        summary: input.outcome_summary,
        evidence_refs: input.evidence_refs,
        candidate_refs: candidateRefs,
        completed_at: now,
      };
      this.state.insertOutcome(outcome, key);
      this.state.audit("turn.completed", key, "SUCCESS", {
        status: outcome.status,
        candidate_count: candidateRefs.length,
      }, now);
      return outcome;
    });
  }

  feedback(raw: FeedbackInput): { feedback_id: string; sentiment: FeedbackInput["sentiment"] } {
    const input = FeedbackInputSchema.parse(raw);
    const now = this.now();
    const scope = `feedback:${input.packet_id ?? input.memory_id ?? "unknown"}`;
    return this.state.idempotent(scope, input.idempotency_key, input, now, () => {
      if (input.packet_id && !this.state.getPacket(input.packet_id)) {
        throw new CoachError("NOT_FOUND", "Packet does not exist");
      }
      const id = opaqueId("feedback");
      this.state.addFeedback({
        id,
        ...(input.packet_id ? { packetId: input.packet_id } : {}),
        ...(input.memory_id ? { memoryId: input.memory_id } : {}),
        sentiment: input.sentiment,
        note: input.note,
        createdAt: now,
      });
      this.state.audit("feedback.recorded", input.packet_id ?? input.memory_id ?? null, "SUCCESS", {
        sentiment: input.sentiment,
      }, now);
      return { feedback_id: id, sentiment: input.sentiment };
    });
  }

  search(input: SearchInput): GuidanceItem[] {
    return this.knowledge.search(input, this.now()).map(({ item }) => item);
  }

  async explain(input: { packet_id?: string; memory_id?: string }): Promise<Record<string, unknown>> {
    if (input.packet_id) {
      const packet = this.state.getPacket(input.packet_id);
      if (!packet) throw new CoachError("NOT_FOUND", "Packet does not exist");
      return {
        kind: "packet",
        packet_id: packet.packet_id,
        authority_rule: "canonical authority is ordered before provider relevance",
        conflict_rule: "conflicting bodies are isolated from instruction sections",
        budget: { max_items: MAX_GUIDANCE_ITEMS, max_estimated_tokens: MAX_GUIDANCE_TOKENS },
        included: allPacketItems(packet).map((item) => ({
          memory_id: item.memory_id,
          authority: item.authority,
          score: item.score,
          provenance: item.provenance,
        })),
        conflicts: packet.conflicts,
        omitted_summary: packet.omitted_summary,
      };
    }
    if (input.memory_id) {
      const memory = await this.knowledge.get(input.memory_id);
      if (!memory) throw new CoachError("NOT_FOUND", "Memory does not exist");
      return { kind: "memory", memory };
    }
    throw new CoachError("VALIDATION_ERROR", "packet_id or memory_id is required");
  }

  listCandidates(status: CandidateRecord["status"] = "candidate"): CandidateRecord[] {
    return this.state.listCandidates(status);
  }

  previewCandidate(candidateId: string): MutationPreviewV1 {
    const candidate = this.state.getCandidate(candidateId);
    if (!candidate) throw new CoachError("NOT_FOUND", "Candidate does not exist");
    if (candidate.status !== "candidate") throw new CoachError("INVALID_STATE", "Only active candidates can be approved");
    const warnings = candidatePromotionWarnings(candidate);
    const now = this.now();
    const after = {
      memory_id: `mem_${candidate.id.replace(/^cand_/, "")}`,
      type: candidate.type,
      title: candidate.title,
      content: candidate.summary,
      scope: candidate.scope,
      status: "approved",
      provenance: { source_refs: candidate.source_refs, evidence_refs: candidate.evidence_refs },
    };
    const proposalHash = sha256({ operation: "candidate.approve", target: candidate.id, base_revision: candidate.revision, after });
    const preview: MutationPreviewV1 = {
      operation: "candidate.approve",
      exact_targets: [candidate.id, after.memory_id],
      before: candidate,
      after,
      base_revision: candidate.revision,
      proposal_hash: proposalHash,
      expires_at: addMilliseconds(now, PREVIEW_TTL_MS),
      warnings,
    };
    this.state.savePreview({
      proposalHash,
      operation: preview.operation,
      targetId: candidate.id,
      baseRevision: candidate.revision,
      payload: preview,
      expiresAt: preview.expires_at,
    });
    return preview;
  }

  async approveCandidate(input: ApproveInput): Promise<{ candidate: CandidateRecord; memory: CanonicalKnowledgeRecord }> {
    const now = this.now();
    const replay = this.state.replayIdempotent<{ candidate_id: string; memory_id: string }>(
      `candidate.approve:${input.candidate_id}`,
      input.idempotency_key,
      input,
    );
    if (replay.found) {
      const candidate = this.state.getCandidate(replay.value.candidate_id);
      const memory = await this.knowledge.get(replay.value.memory_id);
      if (!candidate || !memory) throw new CoachError("REVISION_CONFLICT", "Approval replay references missing state");
      return { candidate, memory };
    }
    const preview = this.state.getPreview(input.proposal_hash);
    if (!preview || preview.operation !== "candidate.approve" || preview.target_id !== input.candidate_id) {
      throw new CoachError("REVISION_CONFLICT", "Approval preview does not match this candidate");
    }
    assertFresh(preview.expires_at, now, "REVISION_CONFLICT");
    if (preview.consumed_at) throw new CoachError("REVISION_CONFLICT", "Approval preview was already consumed");
    const candidate = this.state.getCandidate(input.candidate_id);
    if (!candidate || candidate.revision !== input.base_revision || preview.base_revision !== input.base_revision) {
      throw new CoachError("REVISION_CONFLICT", "Candidate changed after preview");
    }
    candidatePromotionWarnings(candidate);
    const memory = await this.knowledge.approveCandidate(candidate, now);
    this.state.transaction(() => {
      const current = this.state.getCandidate(input.candidate_id);
      if (!current || current.revision !== input.base_revision || current.status !== "candidate") {
        throw new CoachError("REVISION_CONFLICT", "Candidate changed while approval was being applied");
      }
      this.state.markCandidatePromoted(candidate.id, candidate.revision + 1, now);
      this.state.consumePreview(input.proposal_hash, now);
      this.state.audit("governance.approved", candidate.id, "SUCCESS", { memory_id: memory.id }, now);
      this.state.saveIdempotent(
        `candidate.approve:${input.candidate_id}`,
        input.idempotency_key,
        input,
        { candidate_id: candidate.id, memory_id: memory.id },
        now,
      );
    });
    return { candidate: this.state.getCandidate(candidate.id)!, memory };
  }

  rejectCandidate(input: RejectInput): CandidateRecord {
    const candidate = this.state.getCandidate(input.candidate_id);
    if (!candidate) throw new CoachError("NOT_FOUND", "Candidate does not exist");
    const now = this.now();
    return this.state.idempotent(`candidate.reject:${candidate.id}`, input.idempotency_key, input, now, () => {
      const current = this.state.getCandidate(candidate.id);
      if (!current || current.status !== "candidate") throw new CoachError("INVALID_STATE", "Candidate is not reviewable");
      this.state.updateCandidateStatus(current.id, "rejected", current.revision + 1, now);
      this.state.audit("governance.rejected", current.id, "SUCCESS", { reason: input.reason }, now);
      return this.state.getCandidate(current.id)!;
    });
  }

  previewForget(memoryId: string): MutationPreviewV1 {
    const now = this.now();
    const candidate = this.state.getCandidate(memoryId) ??
      (memoryId.startsWith("mem_") ? this.state.getCandidate(`cand_${memoryId.slice(4)}`) : null);
    const revision = candidate?.revision ?? 1;
    const after = { state_body: "removed", knowledge_file: "removed", index: "removed", provider: this.provider.enabled ? "requested" : "disabled" };
    const proposalHash = sha256({ operation: "privacy.forget", target: memoryId, base_revision: revision, after });
    const preview: MutationPreviewV1 = {
      operation: "privacy.forget",
      exact_targets: [memoryId],
      before: candidate ? { id: candidate.id, status: candidate.status } : { id: memoryId },
      after,
      base_revision: revision,
      proposal_hash: proposalHash,
      expires_at: addMilliseconds(now, PREVIEW_TTL_MS),
      warnings: ["Private Git history, if explicitly enabled, is not rewritten automatically."],
    };
    this.state.savePreview({ proposalHash, operation: preview.operation, targetId: memoryId, baseRevision: revision, payload: preview, expiresAt: preview.expires_at });
    return preview;
  }

  async forget(memoryId: string, apply: ExactApplyInput): Promise<Record<string, unknown>> {
    const now = this.now();
    const replay = this.state.replayIdempotent<Record<string, unknown>>(
      `privacy.forget:${memoryId}`,
      apply.idempotency_key,
      { memory_id: memoryId, ...apply },
    );
    if (replay.found) return replay.value;
    const preview = this.state.getPreview(apply.proposal_hash);
    if (!preview || preview.operation !== "privacy.forget" || preview.target_id !== memoryId) {
      throw new CoachError("REVISION_CONFLICT", "Forget preview does not match the target");
    }
    assertFresh(preview.expires_at, now, "REVISION_CONFLICT");
    if (preview.consumed_at) throw new CoachError("REVISION_CONFLICT", "Forget preview was already consumed");
    const candidate = this.state.getCandidate(memoryId) ??
      (memoryId.startsWith("mem_") ? this.state.getCandidate(`cand_${memoryId.slice(4)}`) : null);
    if (candidate && candidate.revision !== apply.base_revision) throw new CoachError("REVISION_CONFLICT", "Target changed after preview");
    const knowledge = await this.knowledge.forget(memoryId);
    this.state.scrubMemoryReferences(memoryId, candidate?.id ?? null, candidate?.proposal_id ?? null, now);
    let provider: unknown = { deleted: false, verified: true, detail: "provider disabled" };
    if (this.provider.enabled && this.state.getSettings().provider_consent) {
      try {
        provider = await this.provider.forget(memoryId);
      } catch (error) {
        provider = { deleted: false, verified: false, detail: error instanceof Error ? error.message : "provider deletion failed" };
      }
    }
    this.state.consumePreview(apply.proposal_hash, now);
    const layers = { state: Boolean(candidate), ...knowledge, provider };
    const complete = !this.provider.enabled || (provider as { verified?: boolean }).verified === true;
    const result = { memory_id: memoryId, status: complete ? "complete" : "partial", layers };
    this.state.audit("governance.forgotten", memoryId, complete ? "SUCCESS" : "PARTIAL", { layers }, now);
    this.state.saveIdempotent(
      `privacy.forget:${memoryId}`,
      apply.idempotency_key,
      { memory_id: memoryId, ...apply },
      result,
      now,
    );
    return result;
  }

  getSettings(): SettingsRecord {
    return this.state.getSettings();
  }

  previewSettings(changes: Partial<Omit<SettingsRecord, "revision">>): MutationPreviewV1 {
    const before = this.state.getSettings();
    const after = { ...before, ...changes, revision: before.revision + 1 };
    if (!['advisory', 'enforce'].includes(after.gate_mode)) throw new CoachError("VALIDATION_ERROR", "Invalid gate mode");
    if (after.journal_ttl_days < 1 || after.journal_ttl_days > 365) throw new CoachError("VALIDATION_ERROR", "Journal TTL must be 1-365 days");
    const now = this.now();
    const proposalHash = sha256({ operation: "settings.apply", base_revision: before.revision, after });
    const preview: MutationPreviewV1 = {
      operation: "settings.apply",
      exact_targets: ["settings"],
      before,
      after,
      base_revision: before.revision,
      proposal_hash: proposalHash,
      expires_at: addMilliseconds(now, PREVIEW_TTL_MS),
      warnings: after.provider_consent && !before.provider_consent ? ["Provider consent permits configured outbound recall fields."] : [],
    };
    this.state.savePreview({ proposalHash, operation: preview.operation, targetId: "settings", baseRevision: before.revision, payload: preview, expiresAt: preview.expires_at });
    return preview;
  }

  applySettings(apply: ExactApplyInput): SettingsRecord {
    const now = this.now();
    return this.state.idempotent("settings.apply", apply.idempotency_key, apply, now, () => {
      const previewRow = this.state.getPreview(apply.proposal_hash);
      if (!previewRow || previewRow.operation !== "settings.apply") throw new CoachError("REVISION_CONFLICT", "Settings preview is invalid");
      assertFresh(previewRow.expires_at, now, "REVISION_CONFLICT");
      const preview = JSON.parse(previewRow.payload_json) as MutationPreviewV1;
      const current = this.state.getSettings();
      if (current.revision !== apply.base_revision || preview.base_revision !== apply.base_revision) {
        throw new CoachError("REVISION_CONFLICT", "Settings changed after preview");
      }
      const after = preview.after as SettingsRecord;
      this.state.updateSettings(after, now);
      this.state.consumePreview(apply.proposal_hash, now);
      this.state.audit("governance.settings", "settings", "SUCCESS", { revision: after.revision }, now);
      return after;
    });
  }

  async seedApprovedKnowledge(
    record: Parameters<KnowledgeStore["seed"]>[0],
  ): Promise<CanonicalKnowledgeRecord> {
    return this.knowledge.seed(record);
  }

  export(): Record<string, unknown> {
    return {
      exported_at: this.now(),
      state: this.state.exportState(),
      index: this.knowledge.status(),
    };
  }

  async resetOperationalState(): Promise<void> {
    this.state.resetOperationalState(this.now());
    await this.knowledge.rebuild();
  }

  previewReset(mode: "index" | "operational" | "candidates" | "all"): MutationPreviewV1 {
    if (!["index", "operational", "candidates", "all"].includes(mode)) {
      throw new CoachError("VALIDATION_ERROR", "Reset mode must be index, operational, candidates, or all");
    }
    const now = this.now();
    const baseRevision = this.state.getSettings().revision;
    const after = { mode, action: mode === "index" ? "rebuild from canonical knowledge" : "delete selected local state" };
    const proposalHash = sha256({ operation: "privacy.reset", mode, base_revision: baseRevision, after });
    const preview: MutationPreviewV1 = {
      operation: "privacy.reset",
      exact_targets: mode === "index"
        ? ["index.db projection"]
        : mode === "operational"
          ? ["turns", "packets", "tickets", "outcomes"]
          : mode === "candidates"
            ? ["candidates"]
            : ["turns", "packets", "tickets", "outcomes", "candidates", "canonical knowledge", "index projection"],
      before: { mode, exported_state_available: true },
      after,
      base_revision: baseRevision,
      proposal_hash: proposalHash,
      expires_at: addMilliseconds(now, PREVIEW_TTL_MS),
      warnings: mode === "index" ? [] : ["This removes material local data and is not automatically recoverable without an export."],
    };
    this.state.savePreview({ proposalHash, operation: preview.operation, targetId: mode, baseRevision, payload: preview, expiresAt: preview.expires_at });
    return preview;
  }

  async applyReset(mode: "index" | "operational" | "candidates" | "all", apply: ExactApplyInput): Promise<Record<string, unknown>> {
    const now = this.now();
    const preview = this.state.getPreview(apply.proposal_hash);
    if (!preview || preview.operation !== "privacy.reset" || preview.target_id !== mode) {
      throw new CoachError("REVISION_CONFLICT", "Reset preview does not match the selected mode");
    }
    assertFresh(preview.expires_at, now, "REVISION_CONFLICT");
    if (preview.base_revision !== apply.base_revision || this.state.getSettings().revision !== apply.base_revision) {
      throw new CoachError("REVISION_CONFLICT", "Settings revision changed after reset preview");
    }
    let result: Record<string, unknown>;
    if (mode === "index") result = await this.knowledge.rebuild();
    else if (mode === "operational") {
      this.state.resetOperationalState(now);
      result = { reset: "operational" };
    } else if (mode === "candidates") result = { cleared_candidates: this.state.clearCandidates(now) };
    else {
      const memories = await this.knowledge.list();
      const providerResults: Array<Record<string, unknown>> = [];
      for (const memory of memories) {
        await this.knowledge.forget(memory.id);
        if (this.provider.enabled && this.state.getSettings().provider_consent) {
          try {
            providerResults.push({ memory_id: memory.id, ...(await this.provider.forget(memory.id)) });
          } catch (error) {
            providerResults.push({ memory_id: memory.id, deleted: false, verified: false, detail: error instanceof Error ? error.message : "provider deletion failed" });
          }
        }
      }
      const clearedCandidates = this.state.clearCandidates(now);
      this.state.resetOperationalState(now);
      result = {
        removed_knowledge: memories.length,
        cleared_candidates: clearedCandidates,
        provider_results: providerResults,
        recoverability: "Local bodies removed; explicitly enabled private Git history is not rewritten.",
      };
    }
    this.state.consumePreview(apply.proposal_hash, now);
    return { status: "complete", mode, result };
  }

  status(): Record<string, unknown> {
    return {
      protocol_version: PROTOCOL_VERSION,
      state: "ready",
      provider: { id: this.provider.id, enabled: this.provider.enabled },
      index: this.knowledge.status(),
      settings: this.state.getSettings(),
    };
  }
}
