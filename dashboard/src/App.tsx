import { useEffect, useMemo, useState } from "react";
import { applyCandidate, loadDashboard, previewCandidate, privacyAction, saveSettings } from "./api";
import { demoData } from "./demo-data";
import type { Candidate, DashboardData, IntegrationStatus, MemoryType, Settings, Trace } from "./types";

type Page = "overview" | "experience" | "candidates" | "traces" | "integrations" | "privacy";

const nav: Array<{ id: Page; label: string }> = [
  { id: "overview", label: "概览" },
  { id: "experience", label: "经验库" },
  { id: "candidates", label: "候选审核" },
  { id: "traces", label: "辅导 Trace" },
  { id: "integrations", label: "集成" },
  { id: "privacy", label: "隐私设置" },
];

const typeLabels: Record<MemoryType, string> = {
  preference: "偏好",
  fact: "知识",
  experience: "经验",
  procedure: "流程",
};

const statusLabels: Record<IntegrationStatus, string> = {
  verified: "已验证",
  configured: "已配置",
  detected: "已检测",
  degraded: "降级",
  unverified: "待验证",
  unsupported: "不支持",
};

function formatPercent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function StatusDot({ status }: { status: string }) {
  return <span className={`status-dot status-${status}`} aria-hidden="true" />;
}

function Icon({ name, size = 18 }: { name: Page | "menu" | "close" | "local" | "trace" | "database" | "search" | "arrow"; size?: number }) {
  const common = { width: size, height: size, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.7, strokeLinecap: "round" as const, strokeLinejoin: "round" as const, "aria-hidden": true };
  if (name === "overview") return <svg {...common}><path d="M3.8 10.5 12 3.9l8.2 6.6"/><path d="M5.6 9.4v10.2h12.8V9.4"/><path d="M9.5 19.6v-6.1h5v6.1"/></svg>;
  if (name === "experience") return <svg {...common}><ellipse cx="12" cy="5.4" rx="7.6" ry="2.8"/><path d="M4.4 5.4v6.3c0 1.5 3.4 2.8 7.6 2.8s7.6-1.3 7.6-2.8V5.4"/><path d="M4.4 11.7V18c0 1.5 3.4 2.8 7.6 2.8s7.6-1.3 7.6-2.8v-6.3"/></svg>;
  if (name === "candidates") return <svg {...common}><path d="M9.2 6h10.2M9.2 12h10.2M9.2 18h10.2"/><circle cx="4.9" cy="6" r="1.2"/><circle cx="4.9" cy="12" r="1.2"/><circle cx="4.9" cy="18" r="1.2"/></svg>;
  if (name === "traces") return <svg {...common}><path d="m3.7 17.5 4.2-5.1 4.1 2.2 4.2-7.3 4.1 2.2"/><circle cx="3.7" cy="17.5" r="1.4"/><circle cx="8" cy="12.4" r="1.4"/><circle cx="12" cy="14.6" r="1.4"/><circle cx="16.2" cy="7.3" r="1.4"/><circle cx="20.3" cy="9.5" r="1.4"/></svg>;
  if (name === "integrations") return <svg {...common}><path d="M8.5 3.5v4.2H4.3M15.5 3.5v4.2h4.2M8.5 20.5v-4.2H4.3M15.5 20.5v-4.2h4.2"/><rect x="8.5" y="7.7" width="7" height="8.6" rx="2"/></svg>;
  if (name === "privacy") return <svg {...common}><path d="M12 3.2 19 6v5.2c0 4.6-2.8 7.6-7 9.6-4.2-2-7-5-7-9.6V6l7-2.8Z"/><path d="m8.7 12 2.1 2.1 4.5-4.5"/></svg>;
  if (name === "menu") return <svg {...common}><path d="M4 7h16M4 12h16M4 17h16"/></svg>;
  if (name === "close") return <svg {...common}><path d="m6 6 12 12M18 6 6 18"/></svg>;
  if (name === "local") return <svg {...common}><rect x="3.2" y="4.5" width="17.6" height="12" rx="2"/><path d="M8.5 20h7M12 16.5V20"/></svg>;
  if (name === "trace") return <svg {...common}><rect x="5" y="3.5" width="14" height="17" rx="2"/><path d="M8.5 8h7M8.5 12h7M8.5 16h4"/></svg>;
  if (name === "database") return <svg {...common}><ellipse cx="12" cy="5.5" rx="7.5" ry="3"/><path d="M4.5 5.5v6.3c0 1.7 3.4 3 7.5 3s7.5-1.3 7.5-3V5.5"/><path d="M4.5 11.8v6.3c0 1.7 3.4 3 7.5 3s7.5-1.3 7.5-3v-6.3"/></svg>;
  if (name === "search") return <svg {...common}><circle cx="10.5" cy="10.5" r="6.2"/><path d="m15.2 15.2 4.5 4.5"/></svg>;
  return <svg {...common}><path d="M5 19 19 5M9 5h10v10"/></svg>;
}

function AppMark() {
  return (
    <span className="app-mark" aria-hidden="true">
      <span />
      <span />
      <span />
    </span>
  );
}

function SectionTitle({ index, children, action }: { index?: number; children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div className="section-title">
      <div className="section-title-copy">
        {index ? <span className="section-index">{index}</span> : null}
        <h2>{children}</h2>
      </div>
      {action}
    </div>
  );
}

function Lifecycle({ trace }: { trace: Trace }) {
  const stages = [
    ["计划已捕获", "captured"],
    [`${trace.matches} 条匹配`, "matched"],
    ["计划已重整", "revised"],
    [trace.status === "completed" ? "已完成" : "准备行动", "ready"],
  ];
  return (
    <ol className="lifecycle" aria-label="辅导生命周期">
      {stages.map(([label, id], index) => (
        <li key={id} className={index < 3 || trace.status === "completed" ? "is-done" : "is-current"}>
          <span className="lifecycle-node">{index + 1}</span>
          <strong>{label}</strong>
          <small>{index === 0 ? trace.time : index === 1 ? "计划相关经验" : index === 2 ? "采用决定已记录" : trace.outcome}</small>
        </li>
      ))}
    </ol>
  );
}

function PlanDelta({ trace }: { trace: Trace }) {
  const rows = Math.max(trace.before.length, trace.after.length);
  return (
    <div className="plan-delta">
      <div className="delta-head"><span>Before</span><span>After</span></div>
      {Array.from({ length: rows }, (_, index) => (
        <div className="delta-row" key={`${trace.id}-${index}`}>
          <span className="delta-before"><i>−</i>{trace.before[index] ?? "—"}</span>
          <span className="delta-after"><i>+</i>{trace.after[index] ?? "—"}</span>
        </div>
      ))}
    </div>
  );
}

function Growth({ values }: { values: number[] }) {
  const max = Math.max(...values, 1);
  const points = values.map((value, index) => `${(index / (values.length - 1)) * 100},${44 - (value / max) * 36}`).join(" ");
  return (
    <div className="growth" aria-label="七天经验增长">
      <div className="growth-label"><span>7 天增长</span><strong>+{values.at(-1)! - values[0]}</strong></div>
      <svg viewBox="0 0 100 48" preserveAspectRatio="none" role="img" aria-label="经验增长折线">
        <line x1="0" y1="44" x2="100" y2="44" />
        <line x1="0" y1="26" x2="100" y2="26" />
        <polyline points={points} />
        {values.map((value, index) => <circle key={index} cx={(index / (values.length - 1)) * 100} cy={44 - (value / max) * 36} r="1.2" />)}
      </svg>
      <div className="growth-days"><span>周一</span><span>周二</span><span>周三</span><span>周四</span><span>周五</span><span>周六</span><span>今天</span></div>
    </div>
  );
}

function IntegrationList({ data, compact = false }: { data: DashboardData; compact?: boolean }) {
  return (
    <div className={compact ? "integration-list compact" : "integration-list"}>
      {data.integrations.map((item) => (
        <article className="integration-row" key={item.id} tabIndex={0}>
          <span className={`host-mark host-${item.id}`}>{item.name[0]}</span>
          <div className="integration-copy"><strong>{item.name}</strong>{compact ? null : <small>{item.version} · {item.detail}</small>}</div>
          <span className={`integration-status status-text-${item.status}`}><StatusDot status={item.status} />{statusLabels[item.status]}</span>
        </article>
      ))}
    </div>
  );
}

function CandidateRows({ candidates, onReview, dense = false }: { candidates: Candidate[]; onReview: (candidate: Candidate) => void; dense?: boolean }) {
  return (
    <div className={`candidate-table ${dense ? "dense" : ""}`} role="table" aria-label="候选经验">
      <div className="candidate-table-head" role="row"><span>类型</span><span>标题</span><span>来源</span><span>置信 / 证据</span><span>操作</span></div>
      {candidates.map((candidate) => (
        <div className="candidate-row" role="row" key={candidate.id}>
          <span className={`type-cell type-${candidate.type}`}><i />{typeLabels[candidate.type]}</span>
          <strong>{candidate.title}</strong>
          <span className="muted ellipsis">{candidate.source_refs[0]}</span>
          <span className="muted">{formatPercent(candidate.confidence)} · {candidate.evidence_refs.length} 项</span>
          <button className="button secondary compact" onClick={() => onReview(candidate)}>审核</button>
        </div>
      ))}
    </div>
  );
}

function Overview({ data, selectedTrace, onTrace, onReview, setPage }: {
  data: DashboardData;
  selectedTrace: Trace;
  onTrace: (trace: Trace) => void;
  onReview: (candidate: Candidate) => void;
  setPage: (page: Page) => void;
}) {
  return (
    <div className="overview-layout">
      <div className="overview-main">
        <section>
          <SectionTitle index={1} action={<button className="text-button" onClick={() => setPage("traces")}>查看全部 Trace</button>}>最近辅导</SectionTitle>
          <div className="trace-panel">
            <button className="trace-heading" onClick={() => onTrace(selectedTrace)}>
              <span className="trace-icon"><Icon name="trace" size={18} /></span>
              <span><strong>{selectedTrace.title}</strong><small>{selectedTrace.host} · {selectedTrace.time}</small></span>
              <span className="trace-open">完整详情 <Icon name="arrow" size={11} /></span>
            </button>
            <Lifecycle trace={selectedTrace} />
            <div className="plan-label">计划变化 <span>关键调整</span></div>
            <PlanDelta trace={selectedTrace} />
          </div>
        </section>

        <section>
          <SectionTitle index={2}>经验积累</SectionTitle>
          <div className="experience-panel">
            <div className="metrics">
              {(Object.keys(typeLabels) as MemoryType[]).map((type) => <div key={type}><span>{typeLabels[type]}</span><strong>{data.counts[type]}</strong></div>)}
            </div>
            <Growth values={data.growth} />
          </div>
        </section>

        <section>
          <SectionTitle index={3} action={<button className="text-button" onClick={() => setPage("candidates")}>打开候选审核</button>}>候选队列</SectionTitle>
          <CandidateRows candidates={data.candidates.slice(0, 3)} onReview={onReview} dense />
        </section>
      </div>

      <aside className="operations-rail" aria-label="运行状态">
        <SectionTitle>集成</SectionTitle>
        <IntegrationList data={data} compact />
        <div className="rail-divider" />
        <h3>记忆 Provider</h3>
        <div className="provider-row"><span className="database-icon"><Icon name="database" size={21} /></span><div><strong>{data.provider.name}</strong><small>{data.provider.detail}</small></div><StatusDot status={data.provider.status} /></div>
        <button className="button primary wide" onClick={() => setPage("candidates")}>审核 {data.pending_count} 个候选</button>
        <div className="privacy-note"><span><Icon name="privacy" size={17} /></span><p><strong>仅在本机</strong><br />默认不保存原始 Prompt</p></div>
      </aside>
    </div>
  );
}

function ExperiencePage({ data }: { data: DashboardData }) {
  const [query, setQuery] = useState("");
  const [type, setType] = useState<"all" | MemoryType>("all");
  const filtered = data.memories.filter((item) => (type === "all" || item.type === type) && `${item.title} ${item.content} ${item.scope}`.toLowerCase().includes(query.toLowerCase()));
  return (
    <div className="page-content">
      <SectionTitle>经验库</SectionTitle>
      <p className="page-lead">已批准内容是辅导权威；候选与历史内容会清楚标注，不会因为相关度高而变成指令。</p>
      <div className="toolbar">
        <label className="search-field"><span><Icon name="search" size={15} /></span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索标题、正文或作用域" /></label>
        <div className="segmented" aria-label="经验类型">
          <button className={type === "all" ? "active" : ""} onClick={() => setType("all")}>全部</button>
          {(Object.keys(typeLabels) as MemoryType[]).map((item) => <button key={item} className={type === item ? "active" : ""} onClick={() => setType(item)}>{typeLabels[item]}</button>)}
        </div>
      </div>
      <div className="memory-list">
        {filtered.map((memory) => (
          <article className="memory-row" key={memory.id} tabIndex={0}>
            <span className={`memory-glyph type-${memory.type}`}>{typeLabels[memory.type][0]}</span>
            <div className="memory-copy"><div><strong>{memory.title}</strong><span className={`status-tag tag-${memory.status}`}>{memory.status}</span></div><p>{memory.content}</p><small>{memory.scope} · 来源：{memory.source}</small></div>
            <div className="memory-usage"><strong>{memory.uses}</strong><span>复用</span><small>{memory.feedback} 次正向反馈</small></div>
          </article>
        ))}
        {filtered.length === 0 ? <div className="empty-state"><strong>没有匹配经验</strong><span>调整筛选条件，或完成一次辅导后再回来。</span></div> : null}
      </div>
    </div>
  );
}

function CandidatesPage({ candidates, onReview }: { candidates: Candidate[]; onReview: (candidate: Candidate) => void }) {
  return (
    <div className="page-content">
      <SectionTitle>候选审核</SectionTitle>
      <p className="page-lead">候选默认不生效。审核会先展示来源、证据和 exact preview，再决定批准或拒绝。</p>
      <div className="queue-summary"><div><strong>{candidates.length}</strong><span>等待审核</span></div><div><strong>{candidates.filter((item) => item.explicitness === "explicit").length}</strong><span>用户明确表达</span></div><div><strong>{candidates.filter((item) => item.confidence >= 0.9).length}</strong><span>高置信</span></div></div>
      <CandidateRows candidates={candidates} onReview={onReview} />
    </div>
  );
}

function TracesPage({ traces, selected, onSelect }: { traces: Trace[]; selected: Trace; onSelect: (trace: Trace) => void }) {
  return (
    <div className="page-content trace-page">
      <SectionTitle>辅导 Trace</SectionTitle>
      <p className="page-lead">查看一次辅导为什么命中、Agent 采用或忽略了什么，以及计划是否真的发生变化。</p>
      <div className="trace-browser">
        <div className="trace-list">
          {traces.map((trace) => <button key={trace.id} className={trace.id === selected.id ? "selected" : ""} onClick={() => onSelect(trace)}><StatusDot status={trace.status} /><span><strong>{trace.title}</strong><small>{trace.host} · {trace.time}</small></span><b>{trace.matches}</b></button>)}
        </div>
        <div className="trace-detail">
          <div className="detail-heading"><div><strong>{selected.title}</strong><span>{selected.outcome}</span></div><span className={`status-tag tag-${selected.status}`}>{selected.status}</span></div>
          <Lifecycle trace={selected} />
          <PlanDelta trace={selected} />
          <div className="decision-columns"><div><h3>采用</h3>{selected.adopted.map((item) => <p key={item}>+ {item}</p>)}</div><div><h3>忽略</h3>{selected.omitted.length ? selected.omitted.map((item) => <p key={item}>− {item}</p>) : <p className="muted">没有忽略项</p>}</div></div>
        </div>
      </div>
    </div>
  );
}

function IntegrationsPage({ data }: { data: DashboardData }) {
  return (
    <div className="page-content">
      <SectionTitle>集成</SectionTitle>
      <p className="page-lead">“检测到”不等于“已验证”。只有精确版本的 fresh-process canary 通过后才显示绿色状态。</p>
      <div className="integration-cards">
        {data.integrations.map((item) => (
          <article key={item.id}>
            <div className="integration-card-head"><span className={`host-mark host-${item.id}`}>{item.name[0]}</span><div><h3>{item.name}</h3><span>{item.version}</span></div><span className={`integration-status status-text-${item.status}`}><StatusDot status={item.status} />{statusLabels[item.status]}</span></div>
            <p>{item.detail}</p><dl><dt>Covered path</dt><dd>{item.coverage}</dd><dt>Gate mode</dt><dd>{data.settings.gate_mode}</dd></dl>
            <button className="button secondary">查看安装与验证</button>
          </article>
        ))}
      </div>
      <div className="provider-card"><div><span className="database-icon"><Icon name="database" size={21} /></span><div><h3>{data.provider.name} Memory</h3><p>{data.provider.detail}</p></div></div><span className={`integration-status status-text-${data.provider.status}`}><StatusDot status={data.provider.status} />{data.provider.status}</span></div>
    </div>
  );
}

function PrivacyPage({ settings, live, onSave }: { settings: Settings; live: boolean; onSave: (settings: Settings) => Promise<void> }) {
  const [draft, setDraft] = useState(settings);
  const [notice, setNotice] = useState("");
  useEffect(() => setDraft(settings), [settings]);
  const save = async () => { await onSave(draft); setNotice(live ? "设置已通过 preview/apply 保存" : "Demo 设置已保存到当前页面"); };
  const runPrivacy = async (action: "export" | "forget" | "reset") => {
    if (!live) { setNotice(`Demo：${action} 已完成预览，没有删除真实数据`); return; }
    const result = await privacyAction(action);
    setNotice(`${action}：${JSON.stringify(result)}`);
  };
  return (
    <div className="page-content privacy-page">
      <SectionTitle>隐私设置</SectionTitle>
      <p className="page-lead">默认不保存原始 Prompt。所有修改都通过统一管理 API 预览、校验 Revision，再原子应用。</p>
      <section className="settings-section"><h3>学习与召回</h3><SettingToggle label="暂停学习" help="暂停后仍可召回，但不写 Journal、候选或 Provider。" value={draft.learning_paused} onChange={(value) => setDraft({ ...draft, learning_paused: value })} /><SettingToggle label="启用召回" help="关闭后 Agent Coach 不向新 Turn 注入经验。" value={draft.recall_enabled} onChange={(value) => setDraft({ ...draft, recall_enabled: value })} /><div className="setting-row"><div><strong>辅导模式</strong><span>首次安装默认 advisory；enforce 只覆盖 capability matrix 中声明的工具路径。</span></div><select value={draft.gate_mode} onChange={(event) => setDraft({ ...draft, gate_mode: event.target.value as Settings["gate_mode"] })}><option value="advisory">Advisory</option><option value="enforce">Enforce</option></select></div></section>
      <section className="settings-section"><h3>保留周期</h3><NumberSetting label="Journal TTL" help="不含原始 Prompt 的运行元数据。" value={draft.journal_ttl_days} suffix="天" onChange={(value) => setDraft({ ...draft, journal_ttl_days: value })} /><NumberSetting label="诊断原文 TTL" help="只有显式开启诊断捕获时生效。" value={draft.diagnostic_capture_ttl_days} suffix="天" onChange={(value) => setDraft({ ...draft, diagnostic_capture_ttl_days: value })} /></section>
      <section className="settings-section"><h3>外部 Memory Provider</h3><SettingToggle label="允许 Provider 数据出站" help="默认关闭；开启前应展示目标 URL、字段、凭据与删除能力。" value={draft.provider_consent} onChange={(value) => setDraft({ ...draft, provider_consent: value })} /></section>
      <div className="settings-actions"><button className="button primary" onClick={() => void save()}>预览并保存设置</button><button className="button secondary" onClick={() => void runPrivacy("export")}>导出</button><button className="button secondary danger" onClick={() => void runPrivacy("forget")}>忘记所选</button><button className="button secondary danger" onClick={() => void runPrivacy("reset")}>重置本地状态</button></div>
      {notice ? <div className="notice" role="status">{notice}</div> : null}
      <div className="security-boundary"><strong>本地安全边界</strong><p>Bearer、SameSite session、CSRF、Origin 与 CSP 可以防止普通恶意网页和未认证 localhost 请求，但不能防御已经拥有相同 OS 用户权限的恶意进程。</p></div>
    </div>
  );
}

function SettingToggle({ label, help, value, onChange }: { label: string; help: string; value: boolean; onChange: (value: boolean) => void }) {
  return <div className="setting-row"><div><strong>{label}</strong><span>{help}</span></div><button className={`switch ${value ? "on" : ""}`} role="switch" aria-checked={value} aria-label={label} onClick={() => onChange(!value)}><span /></button></div>;
}

function NumberSetting({ label, help, value, suffix, onChange }: { label: string; help: string; value: number; suffix: string; onChange: (value: number) => void }) {
  return <div className="setting-row"><div><strong>{label}</strong><span>{help}</span></div><label className="number-field"><input type="number" min={1} max={365} value={value} onChange={(event) => onChange(Number(event.target.value))} /><span>{suffix}</span></label></div>;
}

function CandidateDrawer({ candidate, live, onClose, onResolve }: { candidate: Candidate; live: boolean; onClose: () => void; onResolve: (id: string, action: "approve" | "reject") => void }) {
  const [preview, setPreview] = useState<Record<string, unknown> | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => { setPreview(null); setError(""); if (live) void previewCandidate(candidate.id).then(setPreview).catch((value: Error) => setError(value.message)); }, [candidate.id, live]);
  const act = async (action: "approve" | "reject") => {
    setBusy(true); setError("");
    try {
      if (live) await applyCandidate(candidate.id, action, String(preview?.proposal_hash ?? ""), Number(preview?.base_revision ?? (candidate.status === "candidate" ? 1 : 0)));
      onResolve(candidate.id, action); onClose();
    } catch (value) { setError(value instanceof Error ? value.message : String(value)); }
    finally { setBusy(false); }
  };
  return (
    <div className="drawer-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <aside className="candidate-drawer" role="dialog" aria-modal="true" aria-labelledby="candidate-title">
        <button className="drawer-close" onClick={onClose} aria-label="关闭候选详情"><Icon name="close" size={16} /></button>
        <span className={`type-cell type-${candidate.type}`}><i />{typeLabels[candidate.type]}</span>
        <h2 id="candidate-title">{candidate.title}</h2>
        <p className="drawer-summary">{candidate.summary}</p>
        <dl className="detail-list"><dt>作用域</dt><dd>{candidate.scope}</dd><dt>表达类型</dt><dd>{candidate.explicitness}</dd><dt>置信度</dt><dd>{formatPercent(candidate.confidence)}</dd><dt>状态</dt><dd>{candidate.status}</dd></dl>
        <h3>来源</h3><ul>{candidate.source_refs.map((item) => <li key={item}>{item}</li>)}</ul>
        <h3>证据</h3><ul>{candidate.evidence_refs.map((item) => <li key={item}>{item}</li>)}</ul>
        <div className="preview-box"><div><strong>Exact preview</strong><span>{live ? preview ? "已绑定当前 Revision" : "正在获取…" : "Demo preview"}</span></div><code>{preview ? String(preview.proposal_hash ?? "pending") : `candidate:${candidate.id}`}</code><p>批准会创建 canonical Revision；拒绝只改变候选状态，审计历史保留。</p></div>
        {error ? <div className="error-notice" role="alert">{error}</div> : null}
        <div className="drawer-actions"><button className="button secondary danger" disabled={busy} onClick={() => void act("reject")}>拒绝</button><button className="button primary" disabled={busy} onClick={() => void act("approve")}>批准并版本化</button></div>
      </aside>
    </div>
  );
}

export function App() {
  const [page, setPage] = useState<Page>("overview");
  const [data, setData] = useState<DashboardData>(demoData);
  const [live, setLive] = useState(false);
  const [loading, setLoading] = useState(true);
  const [selectedTraceId, setSelectedTraceId] = useState(demoData.traces[0].id);
  const [candidate, setCandidate] = useState<Candidate | null>(null);
  const [mobileNav, setMobileNav] = useState(false);

  useEffect(() => {
    let active = true;
    loadDashboard().then((value) => { if (active) { setData(value); setLive(true); if (value.traces[0]) setSelectedTraceId(value.traces[0].id); } }).catch(() => { if (active) { setData(demoData); setLive(false); } }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);

  const selectedTrace = useMemo(() => data.traces.find((item) => item.id === selectedTraceId) ?? data.traces[0], [data.traces, selectedTraceId]);
  const resolveCandidate = (id: string, action: "approve" | "reject") => setData((current) => ({ ...current, pending_count: Math.max(0, current.pending_count - 1), candidates: current.candidates.filter((item) => item.id !== id), memories: action === "approve" ? [...current.memories, { id, type: candidate!.type, title: candidate!.title, content: candidate!.summary, scope: candidate!.scope, status: "approved", uses: 0, feedback: 0, source: candidate!.source_refs[0], updated_at: new Date().toISOString() }] : current.memories }));
  const save = async (settings: Settings) => { const next = live ? await saveSettings(settings) : settings; setData((current) => ({ ...current, settings: next })); };

  const traceEmptyState = <div className="empty-state"><strong>还没有辅导 Trace</strong><span>运行 Demo 或连接 Agent 后，这里会展示计划变化。</span></div>;
  const content =
    page === "overview" ? selectedTrace ? <Overview data={data} selectedTrace={selectedTrace} onTrace={(trace) => { setSelectedTraceId(trace.id); setPage("traces"); }} onReview={setCandidate} setPage={setPage} /> : traceEmptyState :
    page === "experience" ? <ExperiencePage data={data} /> :
    page === "candidates" ? <CandidatesPage candidates={data.candidates} onReview={setCandidate} /> :
    page === "traces" ? selectedTrace ? <TracesPage traces={data.traces} selected={selectedTrace} onSelect={(trace) => setSelectedTraceId(trace.id)} /> : traceEmptyState :
    page === "integrations" ? <IntegrationsPage data={data} /> :
    <PrivacyPage settings={data.settings} live={live} onSave={save} />;

  return (
    <div className="app-shell">
      <aside className={`sidebar ${mobileNav ? "mobile-open" : ""}`}>
        <div className="brand"><AppMark /><strong>Agent Coach</strong><button className="mobile-close" onClick={() => setMobileNav(false)} aria-label="关闭导航"><Icon name="close" size={17} /></button></div>
        <nav aria-label="主导航">{nav.map((item) => <button key={item.id} className={page === item.id ? "active" : ""} onClick={() => { setPage(item.id); setMobileNav(false); }}><span><Icon name={item.id} size={17} /></span>{item.label}{item.id === "candidates" && data.pending_count ? <b>{data.pending_count}</b> : null}</button>)}</nav>
        <div className="local-only"><span><Icon name="local" size={19} /></span><div><strong>Local only</strong><small>私人数据不进入公开仓</small></div></div>
      </aside>
      <div className="workspace">
        <header className="topbar"><button className="mobile-menu" onClick={() => setMobileNav(true)} aria-label="打开导航"><Icon name="menu" size={17} /></button><div><h1>{page === "overview" ? "你的助理正在学习" : nav.find((item) => item.id === page)!.label}</h1>{data.demo ? <span className="demo-label">Demo 数据</span> : null}</div><div className={`health health-${data.health}`} title={data.health_message}><StatusDot status={data.health} /><strong>{data.health === "healthy" ? "健康" : data.health === "degraded" ? "降级" : "待验证"}</strong></div></header>
        <main className={loading ? "is-loading" : ""}>{content}</main>
      </div>
      {mobileNav ? <button className="mobile-scrim" aria-label="关闭导航" onClick={() => setMobileNav(false)} /> : null}
      {candidate ? <CandidateDrawer candidate={candidate} live={live} onClose={() => setCandidate(null)} onResolve={resolveCandidate} /> : null}
    </div>
  );
}
