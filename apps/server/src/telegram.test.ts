import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { ThoraxService } from "./index.js";
import { TelegramTransport } from "./telegram.js";

describe("TelegramTransport", () => {
  let mockService: any;
  let transport: TelegramTransport;
  let fetchMock: any;
  let originalFetch: typeof fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true, result: [] }),
      } as Response;
    });
    globalThis.fetch = fetchMock;

    mockService = {
      snapshot: vi.fn(async () => ({
        runtime: { state: "healthy" },
        agents: [{ id: "research", name: "Researcher" }],
        projects: [{ id: "thorax", name: "Thorax" }],
      })),
      activeConversation: vi.fn(async (agentId, projectId) => ({
        id: "conv-1",
      })),
      sendMessage: vi.fn(async (conversationId, agentId, projectId, text) => ({
        content: `Reply to: ${text}`,
      })),
      listWorkflowExecutions: vi.fn(() => [
        { id: "exec-1234-uuid", workflowId: "recon-wf", status: "suspended", stepLogs: [], updatedAt: new Date().toISOString() }
      ]),
      loadWorkflowDefinition: vi.fn(async (id) => ({
        id,
        steps: []
      })),
      resumeWorkflow: vi.fn(async (id, def, approved) => ({
        id,
        status: approved ? "completed" : "failed"
      })),
    };

    transport = new TelegramTransport(mockService as unknown as ThoraxService, {
      botToken: "TEST_TOKEN",
      allowedUserIds: [111],
    });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    transport.stop();
  });

  it("filters unauthorized users on incoming messages", async () => {
    // Call private handleMessage directly to test routing logic cleanly
    const msg = {
      from: { id: 999 }, // Unauthorized
      chat: { id: 123 },
      text: "hello"
    };

    await (transport as any).handleMessage(msg);

    expect(fetchMock).toHaveBeenCalled();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("sendMessage");
    expect(JSON.parse(init.body as string)).toMatchObject({
      chat_id: 123,
      text: expect.stringContaining("Unauthorized")
    });
  });

  it("handles /start and /status commands by showing status details", async () => {
    const msg = {
      from: { id: 111 }, // Authorized
      chat: { id: 123 },
      text: "/start"
    };

    await (transport as any).handleMessage(msg);

    expect(fetchMock).toHaveBeenCalled();
    const calls = fetchMock.mock.calls.map(([url, init]: any) => [url, JSON.parse(init.body as string)]);
    const sendCall = calls.find(([url]: any) => url.includes("sendMessage"));
    expect(sendCall).toBeDefined();
    expect(sendCall![1].text).toContain("Thorax V2 Status");
    expect(sendCall![1].text).toContain("research");
  });

  it("binds chat to context using /bind command", async () => {
    const msg = {
      from: { id: 111 },
      chat: { id: 123 },
      text: "/bind research thorax"
    };

    await (transport as any).handleMessage(msg);

    const calls = fetchMock.mock.calls.map(([url, init]: any) => [url, JSON.parse(init.body as string)]);
    const sendCall = calls.find(([url]: any) => url.includes("sendMessage"));
    expect(sendCall).toBeDefined();
    expect(sendCall![1].text).toContain("Bound to Agent");

    // Send conversational message afterwards
    fetchMock.mockClear();
    const userMsg = {
      from: { id: 111 },
      chat: { id: 123 },
      text: "Reconcile leases"
    };

    await (transport as any).handleMessage(userMsg);

    expect(mockService.sendMessage).toHaveBeenCalledWith("conv-1", "research", "thorax", "Reconcile leases");
    const replyCall = fetchMock.mock.calls.find(([url]: any) => url.includes("sendMessage"));
    expect(replyCall).toBeDefined();
    expect(JSON.parse(replyCall![1].body as string).text).toBe("Reply to: Reconcile leases");
  });

  it("lists active workflow runs with /workflows command", async () => {
    const msg = {
      from: { id: 111 },
      chat: { id: 123 },
      text: "/workflows"
    };

    await (transport as any).handleMessage(msg);

    const calls = fetchMock.mock.calls.map(([url, init]: any) => [url, JSON.parse(init.body as string)]);
    const sendCall = calls.find(([url]: any) => url.includes("sendMessage"));
    expect(sendCall).toBeDefined();
    expect(sendCall![1].text).toContain("recon-wf");
    expect(sendCall![1].text).toContain("exec-123");
  });

  it("approves suspended runs using /approve command", async () => {
    const msg = {
      from: { id: 111 },
      chat: { id: 123 },
      text: "/approve exec-1234"
    };

    await (transport as any).handleMessage(msg);

    expect(mockService.loadWorkflowDefinition).toHaveBeenCalledWith("recon-wf");
    expect(mockService.resumeWorkflow).toHaveBeenCalledWith("exec-1234-uuid", expect.any(Object), true);

    const calls = fetchMock.mock.calls.map(([url, init]: any) => [url, JSON.parse(init.body as string)]);
    const sendCall = calls.find(([url]: any) => url.includes("sendMessage"));
    expect(sendCall).toBeDefined();
    expect(sendCall![1].text).toContain("approved");
  });

  it("rejects suspended runs using /reject command", async () => {
    const msg = {
      from: { id: 111 },
      chat: { id: 123 },
      text: "/reject exec-1234"
    };

    await (transport as any).handleMessage(msg);

    expect(mockService.loadWorkflowDefinition).toHaveBeenCalledWith("recon-wf");
    expect(mockService.resumeWorkflow).toHaveBeenCalledWith("exec-1234-uuid", expect.any(Object), false);

    const calls = fetchMock.mock.calls.map(([url, init]: any) => [url, JSON.parse(init.body as string)]);
    const sendCall = calls.find(([url]: any) => url.includes("sendMessage"));
    expect(sendCall).toBeDefined();
    expect(sendCall![1].text).toContain("rejected");
  });
});
