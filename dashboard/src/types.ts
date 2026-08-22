export type MemoryType = "preference" | "fact" | "experience" | "procedure";
export type CandidateStatus = "candidate" | "approved" | "rejected" | "superseded" | "obsolete";
export type IntegrationStatus = "verified" | "configured" | "detected" | "degraded" | "unverified" | "unsupported";

export interface Candidate {
  id: string;
  type: MemoryType;
  title: string;
  summary: string;
  scope: string;
  status: CandidateStatus;
  explicitness: "explicit" | "inferred";
  confidence: number;
  source_refs: string[];
  evidence_refs: string[];
  updated_at: string;
}

export interface Trace {
  id: string;
  title: string;
  host: string;
  time: string;
  status: "observed" | "prepared" | "committed" | "executing" | "completed" | "degraded";
  matches: number;
  before: string[];
  after: string[];
  adopted: string[];
  omitted: string[];
  outcome: string;
}

export interface Integration {
  id: "codex" | "kimi" | "dsh";
  name: string;
  version: string;
  status: IntegrationStatus;
  detail: string;
  coverage: string;
}

export interface MemoryRecord {
  id: string;
  type: MemoryType;
  title: string;
  content: string;
  scope: string;
  status: CandidateStatus;
  uses: number;
  feedback: number;
  source: string;
  updated_at: string;
}

export interface Settings {
  learning_paused: boolean;
  recall_enabled: boolean;
  gate_mode: "advisory" | "enforce";
  journal_ttl_days: number;
  diagnostic_capture_ttl_days: number;
  provider_consent: boolean;
}

export interface DashboardData {
  health: "healthy" | "degraded" | "unverified";
  health_message: string;
  pending_count: number;
  counts: Record<MemoryType, number>;
  growth: number[];
  candidates: Candidate[];
  traces: Trace[];
  integrations: Integration[];
  memories: MemoryRecord[];
  settings: Settings;
  provider: { name: string; status: "healthy" | "degraded" | "disabled"; detail: string };
  demo: boolean;
}
