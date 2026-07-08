import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ConversationMessage, MemoryReviewCandidate, OperatorApi, OperatorSnapshot, SkillEdit } from "./api";
import { operatorApi } from "./api";
import "./styles.css";

const time = (value: string) => new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" }).format(new Date(value));

function EmptyState({ children }: { children: string }) {
  return <p className="empty-state">{children}</p>;
}

function StatusDot({ state }: { state: string }) {
  return <span className={`status-dot status-dot--${state}`}><span className="sr-only">{state}</span></span>;
}

function runtimeGuidance(codex: OperatorSnapshot["runtime"]["codex"]): string | undefined {
  if (codex === "missing") return "Codex is not installed. Install Codex and ensure it is available on PATH.";
  if (codex === "unavailable") return "Codex is unavailable. Restart Codex and try again.";
  if (codex === "signed-out") return "Codex is signed out. Run `codex login` and choose ChatGPT authentication.";
  if (codex === "auth-expired") return "Codex authentication expired. Run `codex login` to refresh it.";
  return undefined;
}

export function App({ api = operatorApi }: { api?: OperatorApi }) {
  const [snapshot, setSnapshot] = useState<OperatorSnapshot>();
  const [loadError, setLoadError] = useState(false);
  const [loading, setLoading] = useState(true);
  const [agentId, setAgentId] = useState("");
  const [projectId, setProjectId] = useState("");
  const [conversationId, setConversationId] = useState("");
  const [messages, setMessages] = useState<ConversationMessage[]>([]);
  const [conversationLoading, setConversationLoading] = useState(false);
  const [conversationError, setConversationError] = useState(false);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [composerError, setComposerError] = useState("");
  const [pendingOperatorMessage, setPendingOperatorMessage] = useState<ConversationMessage>();
  const [reviewed, setReviewed] = useState<Record<string, "approved" | "rejected">>({});
  const [reviewErrors, setReviewErrors] = useState<Record<string, boolean>>({});
  const [reviewPending, setReviewPending] = useState<Record<string, boolean>>({});
  const [modalOpen, setModalOpen] = useState(false);
  const [diffPreview, setDiffPreview] = useState("");
  const [currentRequest, setCurrentRequest] = useState<{ adapterId: string; action: string; input: Record<string, unknown> } | null>(null);
  const [executing, setExecuting] = useState(false);
  const [toastMessage, setToastMessage] = useState("");
  const [adapterError, setAdapterError] = useState("");
  const [executions, setExecutions] = useState<any[]>([]);
  const [workflowError, setWorkflowError] = useState("");
  const reviewInFlight = useRef(new Set<string>());
  const bindingRequest = useRef(0);
  const snapshotRequest = useRef(0);

  const loadWorkflows = useCallback(async () => {
    try {
      const list = await api.listWorkflowExecutions();
      setExecutions(list);
    } catch {
      // Silently fail workflow list retrieval in UI
    }
  }, [api]);

  const load = useCallback(async () => {
    const requestId = ++snapshotRequest.current;
    setLoading(true);
    setLoadError(false);
    try {
      const next = await api.loadSnapshot();
      if (requestId !== snapshotRequest.current) return;
      const activeAgentId = next.agents.some((agent) => agent.id === next.activeAgentId)
        ? next.activeAgentId
        : next.agents[0]?.id ?? "";
      const activeProjectId = next.projects.some((project) => project.id === next.activeProjectId)
        ? next.activeProjectId
        : next.projects[0]?.id ?? "";
      const bindingIsValid = activeAgentId === next.activeAgentId && activeProjectId === next.activeProjectId;
      const conversation = bindingIsValid
        ? next.conversation
        : activeAgentId && activeProjectId
          ? await api.loadConversation(activeAgentId, activeProjectId)
          : { id: "", messages: [] };
      if (requestId !== snapshotRequest.current) return;
      ++bindingRequest.current;
      setSnapshot(next);
      setAgentId(activeAgentId);
      setProjectId(activeProjectId);
      setConversationId(conversation.id);
      setMessages(conversation.messages);
      setPendingOperatorMessage(undefined);
    } catch {
      if (requestId === snapshotRequest.current) setLoadError(true);
    } finally {
      if (requestId === snapshotRequest.current) setLoading(false);
    }
  }, [api]);

  useEffect(() => {
    void load();
    void loadWorkflows();
    const timer = setInterval(() => {
      void loadWorkflows();
    }, 4000);
    return () => {
      ++snapshotRequest.current;
      clearInterval(timer);
    };
  }, [load, loadWorkflows]);

  async function submitFeedback(messageId: string, score: number, outcome: string) {
    try {
      const notes = prompt("Enter correction notes (optional):");
      await fetch(`/api/skills/runs/${messageId}/feedback`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          score,
          outcome,
          humanOverride: true,
          correctionNotes: notes || null
        })
      });
      setToastMessage("Feedback logged successfully!");
      setTimeout(() => setToastMessage(""), 3000);
      void load();
      void loadWorkflows();
    } catch (err) {
      console.error("Failed to submit feedback:", err);
    }
  }

  async function optimizeSkill(skillId: string) {
    try {
      setExecuting(true);
      const res = await fetch("/api/skills/optimize", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ skillId })
      }).then(r => r.json());
      if (res.error) {
        setToastMessage(`Optimization trigger failed: ${res.error}`);
      } else {
        setToastMessage(`Optimization workflow triggered successfully for skill ${skillId}!`);
      }
      setTimeout(() => setToastMessage(""), 5000);
      void load();
      void loadWorkflows();
    } catch (err) {
      console.error("Failed to trigger skill optimization:", err);
    } finally {
      setExecuting(false);
    }
  }

  const activeAgent = useMemo(() => snapshot?.agents.find((agent) => agent.id === agentId), [agentId, snapshot]);

  async function bindConversation(nextAgentId: string, nextProjectId: string) {
    setAgentId(nextAgentId);
    setProjectId(nextProjectId);
    const requestId = ++bindingRequest.current;
    setConversationId("");
    setMessages([]);
    setDraft((current) => current || pendingOperatorMessage?.content || "");
    setPendingOperatorMessage(undefined);
    setConversationError(false);
    if (!nextAgentId || !nextProjectId) return;
    setConversationLoading(true);
    try {
      const conversation = await api.loadConversation(nextAgentId, nextProjectId);
      if (requestId !== bindingRequest.current) return;
      setConversationId(conversation.id);
      setMessages(conversation.messages);
    } catch {
      if (requestId === bindingRequest.current) setConversationError(true);
    } finally {
      if (requestId === bindingRequest.current) setConversationLoading(false);
    }
  }

  async function review(candidate: MemoryReviewCandidate, decision: "approve" | "reject") {
    if (reviewInFlight.current.has(candidate.id)) return;
    reviewInFlight.current.add(candidate.id);
    setReviewPending((current) => ({ ...current, [candidate.id]: true }));
    setReviewErrors((current) => ({ ...current, [candidate.id]: false }));
    try {
      await api.reviewMemory(candidate.id, decision);
      setReviewed((current) => ({ ...current, [candidate.id]: decision === "approve" ? "approved" : "rejected" }));
    } catch {
      setReviewErrors((current) => ({ ...current, [candidate.id]: true }));
    } finally {
      reviewInFlight.current.delete(candidate.id);
      setReviewPending((current) => ({ ...current, [candidate.id]: false }));
    }
  }

  async function send(event: FormEvent) {
    event.preventDefault();
    const content = draft.trim();
    if (!snapshot || !content || !agentId || !projectId || !conversationId) return;
    setSending(true);
    setComposerError("");
    const contextVersion = bindingRequest.current;
    const pendingMessage = { id: `local-${Date.now()}`, author: "operator", content, createdAt: new Date().toISOString() };
    try {
      setPendingOperatorMessage(pendingMessage);
      setDraft("");
      const reply = await api.sendMessage(conversationId, agentId, projectId, content);
      if (contextVersion !== bindingRequest.current) return;
      setMessages((current) => [
        ...current,
        pendingMessage,
        reply,
      ]);
      setPendingOperatorMessage(undefined);
    } catch {
      if (contextVersion === bindingRequest.current) {
        setPendingOperatorMessage(undefined);
        setDraft(content);
        setComposerError("Message was not sent. Your draft is safe - try again.");
      }
    } finally {
      setSending(false);
    }
  }

  const testWorkbookPath = useMemo(() => {
    const proj = snapshot?.projects.find((p) => p.id === projectId);
    return proj ? `${proj.rootPath}/leases.xlsx` : "leases.xlsx";
  }, [snapshot, projectId]);

  async function triggerDryRun(action: string, input: Record<string, unknown>) {
    setAdapterError("");
    setExecuting(true);
    try {
      const res = await api.executeAdapterAction({
        adapterId: "excel",
        action,
        input,
        mode: "dry_run"
      });
      if (res.mode === "dry_run") {
        setDiffPreview(res.diff_preview);
        setCurrentRequest({ adapterId: "excel", action, input });
        setModalOpen(true);
      }
    } catch (err) {
      setAdapterError(err instanceof Error ? err.message : "Adapter execution failed.");
    } finally {
      setExecuting(false);
    }
  }

  async function approveCommit() {
    if (!currentRequest) return;
    setAdapterError("");
    setExecuting(true);
    try {
      const res = await api.executeAdapterAction({
        ...currentRequest,
        mode: "commit",
        approved_by: "operator"
      });
      if (res.mode === "commit") {
        setToastMessage(`Action committed successfully! Tx ID: ${res.transaction_id}`);
        setModalOpen(false);
        setCurrentRequest(null);
        setTimeout(() => setToastMessage(""), 5000);
      }
    } catch (err) {
      setAdapterError(err instanceof Error ? err.message : "Commit execution failed.");
    } finally {
      setExecuting(false);
    }
  }

  const pilotWorkflow = useMemo(() => ({
    id: "lease-reconciliation-run",
    version: "1.0.0",
    description: "Pilot Lease reconciliation workflow using Excel adapter actions.",
    trigger: { type: "schedule", value: "manual" },
    steps: [
      {
        id: "step_read",
        type: "action",
        adapter: "excel",
        action: "read_lease_row",
        input: { workbook_path: testWorkbookPath, lease_id: "L1" }
      },
      {
        id: "step_update",
        type: "action",
        adapter: "excel",
        action: "update_lease_row",
        input: { workbook_path: testWorkbookPath, lease_id: "L1", updates: { rent: 2200 } }
      }
    ]
  }), [testWorkbookPath]);

  async function triggerPilotWorkflow() {
    setWorkflowError("");
    try {
      await api.triggerWorkflow(pilotWorkflow, {});
      await loadWorkflows();
    } catch (err) {
      setWorkflowError(err instanceof Error ? err.message : "Failed to trigger workflow.");
    }
  }

  async function handleWorkflowApproval(executionId: string, approve: boolean) {
    setWorkflowError("");
    try {
      await api.resumeWorkflow(executionId, pilotWorkflow, approve);
      await loadWorkflows();
    } catch (err) {
      setWorkflowError(err instanceof Error ? err.message : "Failed to resolve workflow step.");
    }
  }

  if (loading) {
    return (
      <main className="state-page">
        <div className="brand-mark" aria-hidden="true">T</div>
        <p role="status">Waking the local runtime...</p>
        <div className="loading-line" aria-hidden="true" />
      </main>
    );
  }

  if (loadError || !snapshot) {
    return (
      <main className="state-page">
        <div className="brand-mark" aria-hidden="true">T</div>
        <h1>Thorax is resting</h1>
        <p role="alert">Could not reach Thorax. Check that the local server is running.</p>
        <button className="button button--primary" onClick={() => void load()}>Try again</button>
      </main>
    );
  }

  const recoveryGuidance = runtimeGuidance(snapshot.runtime.codex);
  const pendingMemoryCount = snapshot.memoryCandidates.filter((candidate) => !reviewed[candidate.id]).length;
  const visibleMessages = pendingOperatorMessage ? [...messages, pendingOperatorMessage] : messages;

  return (
    <div className="app-shell">
      <header className="topbar">
        <a className="brand" href="#conversation" aria-label="Thorax operator home">
          <span className="brand-mark" aria-hidden="true">T</span>
          <span><strong>THORAX</strong><small>LOCAL OPERATOR</small></span>
        </a>
        <div className="context-controls">
          <label>
            <span>Active agent</span>
            <select value={agentId} disabled={snapshot.agents.length === 0} onChange={(event) => void bindConversation(event.target.value, projectId)}>
              {snapshot.agents.length === 0 && <option value="">No agents available</option>}
              {snapshot.agents.map((agent) => <option key={agent.id} value={agent.id}>{agent.name} - {agent.role}</option>)}
            </select>
          </label>
          <label>
            <span>Active project</span>
            <select value={projectId} disabled={snapshot.projects.length === 0} onChange={(event) => void bindConversation(agentId, event.target.value)}>
              {snapshot.projects.length === 0 && <option value="">No projects available</option>}
              {snapshot.projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
            </select>
          </label>
        </div>
        <div className="context-messages" aria-live="polite">
          {snapshot.agents.length === 0 && <p>No agents configured. Add an agent before sending a message.</p>}
          {snapshot.projects.length === 0 && <p>No projects configured. Add a project to start a conversation.</p>}
        </div>
        <div className="runtime-pill"><StatusDot state={snapshot.runtime.state} />Local - {snapshot.runtime.state}</div>
      </header>

      <main className="dashboard">
        <section className="conversation panel" id="conversation" aria-labelledby="conversation-title">
          <div className="panel-heading">
            <div><span className="eyebrow">LIVE SESSION</span><h1 id="conversation-title">Conversation</h1></div>
            <div className="active-agent-info">
              <div className="agent-presence"><StatusDot state={activeAgent?.state ?? "offline"} />{activeAgent?.name ?? "No agent"}</div>
              {activeAgent?.skills && activeAgent.skills.length > 0 && (
                <div className="agent-skills">
                  {activeAgent.skills.map((skill) => (
                    <span key={skill.id} className="skill-badge" title={skill.description}>{skill.name}</span>
                  ))}
                </div>
              )}
            </div>
          </div>
          {toastMessage && (
            <div className="toast-success" role="status">
              {toastMessage}
            </div>
          )}
          <div className="message-list" aria-live="polite">
            {conversationLoading ? <p className="empty-state" role="status">Loading bound conversation...</p> : conversationError ? <p className="inline-error" role="alert">Could not load this conversation. Change context to retry.</p> : visibleMessages.length === 0 ? <EmptyState>Start a conversation with the selected agent.</EmptyState> : visibleMessages.map((message) => (
              <article className={`message message--${message.author === "operator" ? "operator" : "agent"}${pendingOperatorMessage?.id === message.id ? " message--pending" : ""}`} key={message.id}>
                <div className="message-meta"><strong>{message.author === "operator" ? "You" : message.author}</strong><time dateTime={message.createdAt}>{time(message.createdAt)}</time></div>
                <p>{message.content}</p>
                {message.author !== "operator" && (
                  <div style={{ display: "flex", gap: "10px", marginTop: "8px", justifyContent: "flex-end" }}>
                    <button className="button button--quiet" style={{ fontSize: "10px", padding: "2px 6px" }} onClick={() => void submitFeedback(message.id, 1.0, "success")}>👍 Success</button>
                    <button className="button button--quiet" style={{ fontSize: "10px", padding: "2px 6px" }} onClick={() => void submitFeedback(message.id, 0.0, "failure")}>👎 Failure</button>
                  </div>
                )}
              </article>
            ))}
          </div>
          <form className="composer" onSubmit={(event) => void send(event)}>
            <label htmlFor="message">Message Thorax</label>
            <textarea id="message" value={draft} onChange={(event) => setDraft(event.target.value)} placeholder="Give the active agent a clear objective..." rows={3} />
            <div className="composer-footer">
              <span className="composer-hint" id="composer-context-help">{agentId && projectId ? "Agent and project context are attached automatically." : "Select an available agent and project before sending."}</span>
              <button aria-describedby="composer-context-help" className="button button--primary" disabled={sending || conversationLoading || !conversationId || !agentId || !projectId || draft.trim().length === 0} type="submit">{sending ? "Sending..." : "Send message"}</button>
            </div>
            {composerError && <p className="inline-error" role="alert">{composerError}</p>}
          </form>
        </section>

        <aside className="side-stack" aria-label="Runtime overview">
          <section className="panel status-panel" aria-labelledby="status-title">
            <div className="panel-heading"><div><span className="eyebrow">SYSTEM</span><h2 id="status-title">Status</h2></div><span className={`health-badge health-badge--${snapshot.runtime.state}`}>Runtime {snapshot.runtime.state}</span></div>
            <dl className="status-grid">
              <div><dt>Codex</dt><dd>{snapshot.runtime.codex}</dd></div>
              <div><dt>Sessions</dt><dd>{snapshot.runtime.activeSessions}</dd></div>
              <div><dt>Version</dt><dd>v{snapshot.runtime.version}</dd></div>
            </dl>
            {recoveryGuidance && <p className="runtime-guidance" role="alert">{recoveryGuidance}</p>}
          </section>

          <section className="panel" aria-labelledby="agents-title">
            <div className="panel-heading"><div><span className="eyebrow">TEAM</span><h2 id="agents-title">Agents</h2></div><span className="count">{snapshot.agents.length}</span></div>
            <ul className="agent-list">
              {snapshot.agents.length === 0 ? <li><EmptyState>No agents configured.</EmptyState></li> : snapshot.agents.map((agent) => (
                <li key={agent.id} className={agent.id === agentId ? "is-active" : ""}>
                  <button onClick={() => void bindConversation(agent.id, projectId)} aria-pressed={agent.id === agentId}>
                    <span className="agent-avatar">{agent.name.slice(0, 2).toUpperCase()}</span>
                    <span>
                      <strong>{agent.name}</strong>
                      <small>{agent.role}</small>
                      {agent.skills && agent.skills.length > 0 && (
                        <span className="agent-skills-inline" style={{ display: "flex", flexWrap: "wrap", gap: "4px", marginTop: "4px" }}>
                          {agent.skills.map((s) => (
                            <span key={s.id} className="scope-tag" style={{ margin: 0, fontSize: "9px", cursor: "pointer", display: "inline-flex", alignItems: "center" }} onClick={(e) => { e.stopPropagation(); void optimizeSkill(s.id); }} title="Click to optimize this skill">
                              ⚙️ {s.name}
                            </span>
                          ))}
                        </span>
                      )}
                    </span>
                    <StatusDot state={agent.state} />
                  </button>
                </li>
              ))}
            </ul>
          </section>
        </aside>

        <section className="panel adapter-panel" aria-labelledby="adapter-title">
          <div className="panel-heading">
            <div>
              <span className="eyebrow">HUMAN IN THE LOOP</span>
              <h2 id="adapter-title">Adapter actions</h2>
            </div>
            {executing && <span className="count">Executing...</span>}
          </div>
          <div className="review-list">
            <article className="review-card">
              <div className="review-meta">
                <span className="scope-tag">write_reversible</span>
                <span>excel</span>
              </div>
              <p>Append a new lease row to tracking sheet.</p>
              <div className="review-actions">
                <button
                  className="button button--secondary"
                  disabled={executing}
                  onClick={() =>
                    triggerDryRun("append_lease_row", {
                      workbook_path: testWorkbookPath,
                      row: { lease_id: "L1", tenant: "Alice", start_date: "2026-08-01", rent: 1500 },
                    })
                  }
                >
                  Append (Alice)
                </button>
              </div>
            </article>

            <article className="review-card">
              <div className="review-meta">
                <span className="scope-tag">write_irreversible</span>
                <span>excel</span>
              </div>
              <p>Update lease row L1 (increase rent).</p>
              <div className="review-actions">
                <button
                  className="button button--secondary"
                  disabled={executing}
                  onClick={() =>
                    triggerDryRun("update_lease_row", {
                      workbook_path: testWorkbookPath,
                      lease_id: "L1",
                      updates: { rent: 2000 },
                    })
                  }
                >
                  Update (L1 Rent)
                </button>
              </div>
            </article>
          </div>
          {adapterError && <p className="inline-error" style={{ margin: "0 16px 16px" }} role="alert">{adapterError}</p>}
        </section>

        <section className="panel workflow-panel" aria-labelledby="workflow-title">
          <div className="panel-heading">
            <div>
              <span className="eyebrow">AUTOMATION</span>
              <h2 id="workflow-title">Workflows</h2>
            </div>
            <button className="button button--secondary" onClick={triggerPilotWorkflow}>Trigger Lease Recon</button>
          </div>
          <div className="review-list" style={{ gridTemplateColumns: "1fr" }}>
            {executions.length === 0 ? (
              <EmptyState>No workflow runs triggered yet.</EmptyState>
            ) : (
              executions.map((exec) => (
                <article key={exec.id} className="review-card" style={{ marginBottom: "10px" }}>
                  <div className="review-meta" style={{ display: "flex", justifyContent: "space-between" }}>
                    <div>
                      <span className={`health-badge health-badge--${exec.status === "completed" ? "healthy" : exec.status === "failed" ? "offline" : exec.status === "suspended" ? "degraded" : "ready"}`}>
                        {exec.status}
                      </span>
                      <span style={{ marginLeft: "10px", fontFamily: "monospace", fontSize: "10px" }}>{exec.id.slice(0, 8)}</span>
                    </div>
                    <span style={{ fontSize: "9px" }}>{time(exec.updatedAt)}</span>
                  </div>
                  <p style={{ fontSize: "12px", margin: "8px 0" }}>
                    Workflow: <strong>{exec.workflowId}</strong>
                    {exec.currentStepId && <span> (Current step: <code>{exec.currentStepId}</code>)</span>}
                  </p>
                  
                  {exec.status === "suspended" && (() => {
                    const pendingEdit = (snapshot as any).pendingSkillEdits?.find((e: any) => e.skillName === exec.context.skillId);
                    return (
                      <div style={{ marginTop: "12px", background: "#1c221f", padding: "10px", borderRadius: "6px" }}>
                        <p style={{ fontSize: "11px", margin: "0 0 8px 0", color: "#edc878" }}>Awaiting operator approval to commit step updates.</p>
                        {pendingEdit && (
                          <div style={{ margin: "10px 0", borderTop: "1px solid #28332e", paddingTop: "8px", textAlign: "left" }}>
                            <p style={{ fontSize: "11px", color: "#87dfa5", margin: "4px 0" }}><strong>Skill Optimization Proposal:</strong> {pendingEdit.skillName}</p>
                            <p style={{ fontSize: "11px", color: "#c5d0ca", margin: "4px 0" }}><strong>Diagnosis:</strong> {pendingEdit.rationale}</p>
                            <p style={{ fontSize: "11px", color: "#c5d0ca", margin: "4px 0" }}><strong>Validation Score Before:</strong> {(pendingEdit.validationScoreBefore * 100).toFixed(1)}%</p>
                            <p style={{ fontSize: "11px", color: "#c5d0ca", margin: "4px 0" }}><strong>Validation Score After:</strong> {(pendingEdit.validationScoreAfter * 100).toFixed(1)}%</p>
                            <pre className="diff-preview" style={{ background: "#0c0f0d", padding: "8px", borderRadius: "4px", fontSize: "10px", overflowX: "auto", border: "1px solid #1c221f", margin: "8px 0" }}>
                              {pendingEdit.proposedDiff}
                            </pre>
                          </div>
                        )}
                        <div className="review-actions" style={{ display: "flex", gap: "6px" }}>
                          <button className="button button--quiet" onClick={() => handleWorkflowApproval(exec.id, false)}>Reject</button>
                          <button className="button button--primary" onClick={() => handleWorkflowApproval(exec.id, true)}>Approve</button>
                        </div>
                      </div>
                    );
                  })()}

                  {exec.stepLogs.length > 0 && (
                    <div style={{ marginTop: "8px", fontSize: "10px", color: "#8c9991" }}>
                      <strong>Step Logs:</strong>
                      <ul style={{ margin: "4px 0 0 0", paddingLeft: "16px" }}>
                        {exec.stepLogs.map((log: any, idx: number) => (
                          <li key={idx}>
                            <code>{log.stepId}</code> - {log.status} 
                            {log.duration_ms !== undefined && <span> ({log.duration_ms}ms)</span>}
                            {log.error && <span style={{ color: "#f09a91" }}> - Error: {log.error}</span>}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </article>
              ))
            )}
          </div>
          {workflowError && <p className="inline-error" style={{ margin: "0 16px 16px" }} role="alert">{workflowError}</p>}
        </section>

        <section className="panel memory-panel" aria-labelledby="memory-title">
          <div className="panel-heading"><div><span className="eyebrow">HUMAN IN THE LOOP</span><h2 id="memory-title">Memory review</h2></div><span className="count">{pendingMemoryCount}</span></div>
          <div className="review-list">
            {snapshot.memoryCandidates.length === 0 ? <EmptyState>The review queue is clear.</EmptyState> : snapshot.memoryCandidates.map((candidate) => (
              <article className="review-card" key={candidate.id}>
                <div className="review-meta"><span className="scope-tag">{candidate.scope}</span><span>from {candidate.source}</span></div>
                <p>{candidate.content}</p>
                {reviewed[candidate.id] ? (
                  <p className="review-result" role="status">Memory {reviewed[candidate.id]}</p>
                ) : (
                  <div className="review-actions">
                    <button className="button button--quiet" disabled={reviewPending[candidate.id]} onClick={() => void review(candidate, "reject")}>Reject memory</button>
                    <button aria-label={reviewPending[candidate.id] ? "Saving memory review" : "Approve memory"} className="button button--secondary" disabled={reviewPending[candidate.id]} onClick={() => void review(candidate, "approve")}>{reviewPending[candidate.id] ? "Saving..." : "Approve memory"}</button>
                  </div>
                )}
                {reviewErrors[candidate.id] && <p className="inline-error" role="alert">Review was not saved. The candidate remains in your queue.</p>}
              </article>
            ))}
          </div>
        </section>

        <section className="panel learning-panel" aria-labelledby="learning-title">
          <div className="panel-heading"><div><span className="eyebrow">AUDIT TRAIL</span><h2 id="learning-title">Learning log</h2></div></div>
          {snapshot.learningEvents.length === 0 ? <EmptyState>No learning events yet.</EmptyState> : (
            <ol className="timeline">
              {snapshot.learningEvents.map((event) => (
                <li key={event.id}><span className="timeline-node" aria-hidden="true" /><div><strong>{event.title}</strong><p>{event.detail}</p><time dateTime={event.createdAt}>{time(event.createdAt)}</time></div></li>
              ))}
            </ol>
          )}
        </section>
      </main>

      {modalOpen && (
        <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="modal-title">
          <div className="modal-content">
            <h2 id="modal-title">Confirm Adapter Action</h2>
            <p>Please review the dry-run diff preview below before approving:</p>
            <pre className="diff-preview">{diffPreview}</pre>
            <div className="modal-actions">
              <button className="button button--quiet" onClick={() => setModalOpen(false)}>
                Reject / Cancel
              </button>
              <button className="button button--primary" onClick={approveCommit} disabled={executing}>
                {executing ? "Approving..." : "Approve & Commit"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
