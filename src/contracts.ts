import { z } from "zod";

export const PROTOCOL_VERSION = "agent-coach/v1" as const;

const identifier = z.string().trim().min(1).max(160);
const nonEmptyText = z.string().trim().min(1).max(8_000);
const shortText = z.string().trim().min(1).max(1_000);
const stringList = z.array(z.string().trim().min(1).max(2_000)).max(100);

export const TurnRefSchema = z.object({
  project_id: identifier,
  host: identifier,
  session_id: identifier,
  turn_id: identifier,
});
export type TurnRef = z.infer<typeof TurnRefSchema>;

export const IntentEnvelopeSchema = z.object({
  goal: nonEmptyText,
  task_type: identifier,
  planned_steps: stringList,
  intended_tools: stringList,
  target_paths: stringList,
  constraints: stringList,
  assumptions: stringList,
  risk_flags: stringList,
});
export type IntentEnvelope = z.infer<typeof IntentEnvelopeSchema>;

export const LearningProposalSchema = z.object({
  proposal_id: identifier,
  type: z.enum(["preference", "fact", "experience", "procedure"]),
  title: shortText,
  summary: nonEmptyText,
  scope: identifier,
  explicitness: z.enum(["explicit", "inferred"]),
  confidence: z.number().min(0).max(1),
  source_refs: stringList.min(1),
  evidence_refs: stringList,
  origin: z.literal("agent_proposal"),
});
export type LearningProposal = z.infer<typeof LearningProposalSchema>;

export const AdoptionSchema = z.object({
  memory_id: identifier,
  decision: z.enum(["adopted", "ignored"]),
  reason: z.string().trim().max(2_000).default(""),
});
export type Adoption = z.infer<typeof AdoptionSchema>;

export const RevisedPlanSchema = z.object({
  summary: nonEmptyText,
  steps: stringList,
  intended_tools: stringList,
  target_paths: stringList,
});
export type RevisedPlan = z.infer<typeof RevisedPlanSchema>;

export const PrepareInputSchema = TurnRefSchema.extend({
  intent: IntentEnvelopeSchema,
  idempotency_key: identifier,
});
export type PrepareInput = z.infer<typeof PrepareInputSchema>;

export const CommitPlanInputSchema = TurnRefSchema.extend({
  packet_id: identifier,
  revised_plan: RevisedPlanSchema,
  adoption: z.array(AdoptionSchema).max(100),
  idempotency_key: identifier,
});
export type CommitPlanInput = z.infer<typeof CommitPlanInputSchema>;

export const CompleteInputSchema = TurnRefSchema.extend({
  outcome_status: z.enum(["succeeded", "failed", "aborted"]),
  outcome_summary: z.string().trim().max(8_000).default(""),
  evidence_refs: stringList,
  learning_proposals: z.array(LearningProposalSchema).max(50).default([]),
  idempotency_key: identifier,
});
export type CompleteInput = z.infer<typeof CompleteInputSchema>;

export const FeedbackInputSchema = z.object({
  packet_id: identifier.optional(),
  memory_id: identifier.optional(),
  sentiment: z.enum(["helpful", "not_helpful", "stale", "wrong"]),
  note: z.string().trim().max(4_000).default(""),
  idempotency_key: identifier,
}).refine((value) => Boolean(value.packet_id || value.memory_id), {
  message: "packet_id or memory_id is required",
});
export type FeedbackInput = z.infer<typeof FeedbackInputSchema>;

export type KnowledgeType = LearningProposal["type"];
export type KnowledgeStatus = "candidate" | "approved" | "rejected" | "superseded" | "obsolete";
export type Authority = "canonical" | "candidate" | "provider";

export interface Provenance {
  source_refs: string[];
  evidence_refs: string[];
  origin: "agent_proposal" | "user_approved" | "provider" | "synthetic_demo";
}

export interface GuidanceItem {
  memory_id: string;
  type: KnowledgeType;
  title: string;
  content: string;
  scope: string;
  authority: Authority;
  status: KnowledgeStatus;
  provenance: Provenance;
  content_hash: string;
  score: number;
}

export interface GuidancePacket {
  protocol_version: typeof PROTOCOL_VERSION;
  origin: "agent-coach";
  packet_id: string;
  turn_ref: TurnRef;
  constraints: GuidanceItem[];
  preferences: GuidanceItem[];
  facts: GuidanceItem[];
  experiences: GuidanceItem[];
  procedures: GuidanceItem[];
  conflicts: Array<{ memory_ids: string[]; reason: string }>;
  omitted_summary: string;
  estimated_tokens: number;
  plan_digest: string;
  created_at: string;
  expires_at: string;
}

export interface ActionTicket {
  ticket: string;
  turn_ref: TurnRef;
  packet_id: string;
  plan_digest: string;
  execution_epoch: number;
  created_at: string;
  expires_at: string;
}

export interface MutationPreviewV1 {
  operation: string;
  exact_targets: string[];
  before: unknown;
  after: unknown;
  base_revision: number;
  proposal_hash: string;
  expires_at: string;
  warnings: string[];
}

export interface CandidateRecord {
  id: string;
  proposal_id: string;
  type: KnowledgeType;
  title: string;
  summary: string;
  scope: string;
  explicitness: "explicit" | "inferred";
  confidence: number;
  source_refs: string[];
  evidence_refs: string[];
  status: KnowledgeStatus;
  revision: number;
  content_hash: string;
  created_at: string;
  updated_at: string;
  conflict_ids: string[];
}

export interface SearchInput {
  query: string;
  project_id?: string;
  scopes?: string[];
  types?: KnowledgeType[];
  statuses?: KnowledgeStatus[];
  limit?: number;
}

export interface GateInput extends TurnRef {
  action_name: string;
  action_arguments?: Record<string, unknown>;
  ticket?: string;
  execution_epoch?: number;
  mode?: "advisory" | "enforce";
  gateway_healthy?: boolean;
}

export interface GateDecision {
  allowed: boolean;
  degraded: boolean;
  classification: import("./action-classifier.js").ActionClassification;
  execution_epoch?: number;
  reason: string;
}

export const ObserveInputSchema = TurnRefSchema.extend({
  task_type: identifier.default("conversation"),
  goal_summary: z.string().trim().max(8_000).default(""),
  host_event: z.object({
    event_type: identifier,
    action_name: identifier.optional(),
    action_class: z.enum(["read", "write", "unknown"]).optional(),
    outcome_status: z.enum(["succeeded", "failed", "aborted"]).optional(),
  }).optional(),
  idempotency_key: identifier,
});
export type ObserveInput = z.infer<typeof ObserveInputSchema>;

export interface OutcomeRecord {
  outcome_id: string;
  turn_ref: TurnRef;
  status: "succeeded" | "failed" | "aborted";
  summary: string;
  evidence_refs: string[];
  candidate_refs: string[];
  completed_at: string;
}
