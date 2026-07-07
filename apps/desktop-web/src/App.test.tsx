import { StrictMode } from "react";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";
import type { ConversationSummary, OperatorApi, OperatorSnapshot } from "./api";

const snapshot: OperatorSnapshot = {
  activeAgentId: "thorax-core",
  activeProjectId: "thorax",
  agents: [
    { id: "thorax-core", name: "Thorax Core", role: "Orchestrator", state: "ready", skills: [{ id: "coordination", name: "Coordination", description: "Coordinate workflows", rules: [], systemPrompt: "coordination" }] },
    { id: "operator", name: "Operator", role: "Implementation", state: "working", skills: [{ id: "operation", name: "Operation", description: "Execute actions safely", rules: [], systemPrompt: "operation" }] },
  ],
  projects: [
    { id: "thorax", name: "Thorax", rootPath: "C:\\work\\thorax" },
    { id: "atlas", name: "Atlas", rootPath: "C:\\work\\atlas" },
  ],
  conversation: {
    id: "conversation-1",
    messages: [
      { id: "m1", author: "operator", content: "Show me the runtime state.", createdAt: "2026-07-05T12:00:00Z" },
      { id: "m2", author: "thorax-core", content: "All local systems are responding.", createdAt: "2026-07-05T12:00:03Z" },
    ],
  },
  memoryCandidates: [
    { id: "memory-1", content: "Prefer project memory over personal memory.", scope: "project", source: "conversation-1", createdAt: "2026-07-05T12:01:00Z" },
  ],
  learningEvents: [
    { id: "learn-1", title: "Candidate staged", detail: "Project preference is awaiting review.", createdAt: "2026-07-05T12:01:00Z" },
  ],
  runtime: { state: "healthy", codex: "signed-in", activeSessions: 2, version: "0.1.0" },
};

function api(overrides: Partial<OperatorApi> = {}): OperatorApi {
  return {
    loadSnapshot: vi.fn().mockResolvedValue(snapshot),
    loadConversation: vi.fn().mockResolvedValue(snapshot.conversation),
    reviewMemory: vi.fn().mockResolvedValue(undefined),
    sendMessage: vi.fn(),
    executeAdapterAction: vi.fn(),
    triggerWorkflow: vi.fn().mockResolvedValue({}),
    resumeWorkflow: vi.fn().mockResolvedValue({}),
    listWorkflowExecutions: vi.fn().mockResolvedValue([]),
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

afterEach(() => vi.restoreAllMocks());

describe("operator shell", () => {
  it("loads every V1 operator surface with accessible agent status", async () => {
    const client = api();
    render(<App api={client} />);

    expect(screen.getByRole("status")).toHaveTextContent("Waking the local runtime");
    expect(await screen.findByRole("heading", { name: "Conversation" })).toBeInTheDocument();
    expect(screen.getByLabelText("Active agent")).toHaveValue("thorax-core");
    expect(screen.getByLabelText("Active project")).toHaveValue("thorax");
    expect(screen.getByText("Prefer project memory over personal memory.")).toBeInTheDocument();
    expect(screen.getByText("Candidate staged")).toBeInTheDocument();
    expect(screen.getByText("Runtime healthy")).toBeInTheDocument();
    const operatorBtn = screen.getByRole("button", { name: /Operator/ });
    expect(within(operatorBtn).getByText("working")).toHaveClass("sr-only");
    const send = screen.getByRole("button", { name: "Send message" });
    expect(send).toHaveAttribute("aria-describedby", "composer-context-help");
    expect(document.getElementById("composer-context-help")).toHaveClass("composer-hint");
  });

  it("uses the explicit snapshot binding instead of attaching conversation to first options", async () => {
    render(<App api={api({ loadSnapshot: vi.fn().mockResolvedValue({
      ...snapshot,
      activeAgentId: "operator",
      activeProjectId: "atlas",
      conversation: { id: "operator-atlas", messages: [{ id: "bound", author: "operator", content: "Bound to Atlas", createdAt: "2026-07-05T12:00:00Z" }] },
    }) })} />);

    expect(await screen.findByText("Bound to Atlas")).toBeInTheDocument();
    expect(screen.getByLabelText("Active agent")).toHaveValue("operator");
    expect(screen.getByLabelText("Active project")).toHaveValue("atlas");
  });

  it("loads a coherent conversation when snapshot binding is unavailable", async () => {
    const loadConversation = vi.fn().mockResolvedValue({ id: "loaded", messages: [{ id: "loaded-message", author: "builder", content: "Loaded binding", createdAt: "2026-07-05T12:00:00Z" }] });
    render(<App api={api({
      loadConversation,
      loadSnapshot: vi.fn().mockResolvedValue({
        ...snapshot,
        activeAgentId: "unknown-agent",
        activeProjectId: "unknown-project",
        conversation: { id: "unbound", messages: [{ id: "wrong", author: "operator", content: "Wrong binding", createdAt: "2026-07-05T12:00:00Z" }] },
      }),
    })} />);

    expect(await screen.findByText("Loaded binding")).toBeInTheDocument();
    expect(screen.queryByText("Wrong binding")).not.toBeInTheDocument();
    expect(loadConversation).toHaveBeenCalledWith("thorax-core", "thorax");
  });

  it("keeps the newest snapshot when StrictMode overlaps initial loads", async () => {
    const first = deferred<OperatorSnapshot>();
    const second = deferred<OperatorSnapshot>();
    const loadSnapshot = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    render(<StrictMode><App api={api({ loadSnapshot })} /></StrictMode>);

    await waitFor(() => expect(loadSnapshot).toHaveBeenCalledTimes(2));
    second.resolve({ ...snapshot, projects: [{ id: "atlas", name: "Atlas", rootPath: "C:\\work\\atlas" }] });
    expect(await screen.findByLabelText("Active project")).toHaveValue("atlas");
    await act(async () => {
      first.resolve(snapshot);
      await first.promise;
    });
    expect(screen.getByLabelText("Active project")).toHaveValue("atlas");
  });

  it("loads the bound conversation whenever agent or project changes", async () => {
    const loadConversation = vi.fn()
      .mockResolvedValueOnce({ id: "operator-thorax", messages: [{ id: "b1", author: "operator", content: "Operator on Thorax", createdAt: "2026-07-05T12:02:00Z" }] })
      .mockResolvedValueOnce({ id: "operator-atlas", messages: [{ id: "b2", author: "operator", content: "Operator on Atlas", createdAt: "2026-07-05T12:03:00Z" }] });
    const user = userEvent.setup();
    render(<App api={api({ loadConversation })} />);

    await screen.findByRole("heading", { name: "Conversation" });
    await user.selectOptions(screen.getByLabelText("Active agent"), "operator");
    expect(await screen.findByText("Operator on Thorax")).toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText("Active project"), "atlas");
    expect(await screen.findByText("Operator on Atlas")).toBeInTheDocument();
    expect(loadConversation).toHaveBeenNthCalledWith(1, "operator", "thorax");
    expect(loadConversation).toHaveBeenNthCalledWith(2, "operator", "atlas");
  });

  it("does not let a slower stale conversation replace the newest binding", async () => {
    const older = deferred<ConversationSummary>();
    const newer = deferred<ConversationSummary>();
    const loadConversation = vi.fn().mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise);
    const user = userEvent.setup();
    render(<App api={api({ loadConversation })} />);

    await screen.findByRole("heading", { name: "Conversation" });
    await user.selectOptions(screen.getByLabelText("Active agent"), "operator");
    await user.selectOptions(screen.getByLabelText("Active project"), "atlas");
    newer.resolve({ id: "new", messages: [{ id: "new-message", author: "operator", content: "Newest binding", createdAt: "2026-07-05T12:04:00Z" }] });
    expect(await screen.findByText("Newest binding")).toBeInTheDocument();
    older.resolve({ id: "old", messages: [{ id: "old-message", author: "operator", content: "Stale binding", createdAt: "2026-07-05T12:03:00Z" }] });
    await waitFor(() => expect(screen.queryByText("Stale binding")).not.toBeInTheDocument());
  });

  it("explains empty agent and project context and prevents sending", async () => {
    render(<App api={api({ loadSnapshot: vi.fn().mockResolvedValue({ ...snapshot, agents: [], projects: [], conversation: { id: "", messages: [] } }) })} />);

    expect(await screen.findByText("No projects configured. Add a project to start a conversation.")).toBeInTheDocument();
    expect(screen.getByText("No agents configured. Add an agent before sending a message.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Send message" })).toBeDisabled();
    expect(screen.getByLabelText("Active agent")).toBeDisabled();
    expect(screen.getByLabelText("Active project")).toBeDisabled();
    expect(screen.getByText("Start a conversation with the selected agent.")).toBeInTheDocument();
  });

  it("shows an actionable failure and retries loading", async () => {
    const loadSnapshot = vi.fn().mockRejectedValueOnce(new Error("server unavailable")).mockResolvedValueOnce(snapshot);
    const user = userEvent.setup();
    render(<App api={api({ loadSnapshot })} />);

    expect(await screen.findByRole("alert")).toHaveTextContent("Could not reach Thorax");
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("heading", { name: "Conversation" })).toBeInTheDocument();
    expect(loadSnapshot).toHaveBeenCalledTimes(2);
  });

  it("prevents duplicate memory decisions while a review is pending", async () => {
    const pending = deferred<void>();
    const reviewMemory = vi.fn().mockReturnValue(pending.promise);
    const user = userEvent.setup();
    render(<App api={api({ reviewMemory })} />);

    const approve = await screen.findByRole("button", { name: "Approve memory" });
    await user.click(approve);
    expect(screen.getByRole("button", { name: "Saving memory review" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Reject memory" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Saving memory review" }));
    expect(reviewMemory).toHaveBeenCalledTimes(1);
    pending.resolve();
    expect(await screen.findByText("Memory approved")).toBeInTheDocument();
    const memoryPanel = screen.getByRole("heading", { name: "Memory review" }).closest("section");
    expect(memoryPanel).not.toBeNull();
    expect(within(memoryPanel!).getByText("0")).toBeInTheDocument();
  });

  it("keeps a memory candidate available when review fails", async () => {
    const user = userEvent.setup();
    render(<App api={api({ reviewMemory: vi.fn().mockRejectedValue(new Error("write failed")) })} />);

    await user.click(await screen.findByRole("button", { name: "Approve memory" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Review was not saved");
    expect(screen.getByRole("button", { name: "Approve memory" })).toBeEnabled();
  });

  it("sends against the currently bound conversation and clears the composer", async () => {
    const sendMessage = vi.fn().mockResolvedValue({ id: "m3", author: "thorax-core", content: "I am on it.", createdAt: "2026-07-05T12:02:00Z" });
    const user = userEvent.setup();
    render(<App api={api({ sendMessage })} />);

    const composer = await screen.findByLabelText("Message Thorax");
    await user.type(composer, "Inspect the queue");
    await user.click(screen.getByRole("button", { name: "Send message" }));

    await waitFor(() => expect(sendMessage).toHaveBeenCalledWith("conversation-1", "thorax-core", "thorax", "Inspect the queue"));
    expect(composer).toHaveValue("");
    expect(screen.getByText("I am on it.")).toBeInTheDocument();
  });

  it("shows the operator message immediately while the agent reply is pending", async () => {
    const pendingSend = deferred<{ id: string; author: string; content: string; createdAt: string }>();
    const user = userEvent.setup();
    render(<App api={api({ sendMessage: vi.fn().mockReturnValue(pendingSend.promise) })} />);

    const composer = await screen.findByLabelText("Message Thorax");
    await user.type(composer, "Inspect the queue");
    await user.click(screen.getByRole("button", { name: "Send message" }));

    expect(screen.getByText("Inspect the queue")).toBeInTheDocument();
    expect(composer).toHaveValue("");
    pendingSend.resolve({ id: "m3", author: "thorax-core", content: "I am on it.", createdAt: "2026-07-05T12:02:00Z" });
    expect(await screen.findByText("I am on it.")).toBeInTheDocument();
  });

  it("does not append or clear a stale send response after context changes", async () => {
    const pendingSend = deferred<{ id: string; author: string; content: string; createdAt: string }>();
    const loadConversation = vi.fn().mockResolvedValue({
      id: "atlas-conversation",
      messages: [{ id: "atlas-message", author: "builder", content: "Atlas context", createdAt: "2026-07-05T12:03:00Z" }],
    });
    const user = userEvent.setup();
    render(<App api={api({ loadConversation, sendMessage: vi.fn().mockReturnValue(pendingSend.promise) })} />);

    const composer = await screen.findByLabelText("Message Thorax");
    await user.type(composer, "Keep this draft");
    await user.click(screen.getByRole("button", { name: "Send message" }));
    await user.selectOptions(screen.getByLabelText("Active project"), "atlas");
    expect(await screen.findByText("Atlas context")).toBeInTheDocument();
    pendingSend.resolve({ id: "stale", author: "thorax-core", content: "Stale reply", createdAt: "2026-07-05T12:04:00Z" });

    await waitFor(() => expect(screen.getByRole("button", { name: "Send message" })).not.toHaveTextContent("Sending"));
    expect(screen.queryByText("Stale reply")).not.toBeInTheDocument();
    expect(composer).toHaveValue("Keep this draft");
  });

  it.each([
    ["missing", "Codex is not installed. Install Codex and ensure it is available on PATH."],
    ["signed-out", "Codex is signed out. Run `codex login` and choose ChatGPT authentication."],
    ["auth-expired", "Codex authentication expired. Run `codex login` to refresh it."],
    ["unavailable", "Codex is unavailable. Restart Codex and try again."],
  ] as const)("shows actionable recovery when Codex is %s", async (codex, guidance) => {
    render(<App api={api({ loadSnapshot: vi.fn().mockResolvedValue({ ...snapshot, runtime: { ...snapshot.runtime, state: "offline", codex } }) })} />);

    expect(await screen.findByRole("alert")).toHaveTextContent(guidance);
  });

  it("shows dry-run diff preview in modal, cancel closes it, approve commits it", async () => {
    const executeAdapterAction = vi.fn()
      .mockResolvedValueOnce({ mode: "dry_run", diff_preview: "+ Row 42: Bob", would_affect: [], reversible: true })
      .mockResolvedValueOnce({ mode: "commit", result: {}, transaction_id: "txn-123" });

    const client = api({ executeAdapterAction });
    const user = userEvent.setup();
    render(<App api={client} />);

    // Click Append button
    const appendBtn = await screen.findByRole("button", { name: "Append (Alice)" });
    await user.click(appendBtn);

    // Verify executeAdapterAction called with dry_run
    expect(executeAdapterAction).toHaveBeenCalledWith(expect.objectContaining({
      action: "append_lease_row",
      mode: "dry_run"
    }));

    // Verify modal is shown with diff preview
    expect(await screen.findByText("+ Row 42: Bob")).toBeInTheDocument();

    // Click Approve button
    const approveBtn = screen.getByRole("button", { name: "Approve & Commit" });
    await user.click(approveBtn);

    // Verify executeAdapterAction called with commit
    expect(executeAdapterAction).toHaveBeenCalledWith(expect.objectContaining({
      action: "append_lease_row",
      mode: "commit",
      approved_by: "operator"
    }));

    // Verify success toast shows transaction ID
    expect(await screen.findByText(/Action committed successfully! Tx ID: txn-123/)).toBeInTheDocument();
  });
});
