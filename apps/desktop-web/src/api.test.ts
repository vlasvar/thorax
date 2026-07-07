import { afterEach, describe, expect, it, vi } from "vitest";
import { createOperatorApi, operatorApi } from "./api";

const jsonResponse = (body: unknown, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: vi.fn().mockResolvedValue(body),
});

afterEach(() => vi.unstubAllGlobals());

describe("operatorApi", () => {
  it("loads the operator snapshot from the local server", async () => {
    const body = {
      activeAgentId: "builder", activeProjectId: "thorax",
      agents: [{ id: "builder", name: "Builder", role: "Build", state: "ready", skills: [] }],
      projects: [{ id: "thorax", name: "Thorax", rootPath: "C:/thorax" }],
      conversation: { id: "c1", messages: [] }, memoryCandidates: [], learningEvents: [],
      runtime: { state: "healthy", codex: "signed-in", activeSessions: 1, version: "test" },
    };
    const fetch = vi.fn().mockResolvedValue(jsonResponse(body));
    vi.stubGlobal("fetch", fetch);

    await expect(operatorApi.loadSnapshot()).resolves.toEqual(body);
    expect(fetch).toHaveBeenCalledWith("/api/operator/snapshot", expect.objectContaining({ headers: { "content-type": "application/json" } }));
  });

  it("uses a supplied loopback base URL and rejects malformed server payloads", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ agents: [] })));
    await expect(createOperatorApi("http://127.0.0.1:4317").loadSnapshot()).rejects.toThrow();
    expect(fetch).toHaveBeenCalledWith("http://127.0.0.1:4317/api/operator/snapshot", expect.any(Object));
  });

  it("loads a conversation using encoded agent and project bindings", async () => {
    const body = { id: "conversation-1", messages: [] };
    const fetch = vi.fn().mockResolvedValue(jsonResponse(body));
    vi.stubGlobal("fetch", fetch);

    await expect(operatorApi.loadConversation("builder one", "project/two")).resolves.toEqual(body);
    expect(fetch).toHaveBeenCalledWith("/api/conversations/active?agentId=builder%20one&projectId=project%2Ftwo", expect.any(Object));
  });

  it("accepts a 204 response when a memory review succeeds", async () => {
    const response = { ok: true, status: 204, json: vi.fn() };
    const fetch = vi.fn().mockResolvedValue(response);
    vi.stubGlobal("fetch", fetch);

    await expect(operatorApi.reviewMemory("memory/1", "approve")).resolves.toBeUndefined();
    expect(response.json).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledWith("/api/memory/candidates/memory%2F1/review", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ decision: "approve" }),
    }));
  });

  it("posts the complete bound-message payload and returns the server message", async () => {
    const message = { id: "m1", author: "builder", content: "Done", createdAt: "2026-07-05T12:00:00Z" };
    const fetch = vi.fn().mockResolvedValue(jsonResponse(message, 201));
    vi.stubGlobal("fetch", fetch);

    await expect(operatorApi.sendMessage("conversation/1", "builder", "atlas", "Build it")).resolves.toEqual(message);
    expect(fetch).toHaveBeenCalledWith("/api/conversations/conversation%2F1/messages", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ agentId: "builder", projectId: "atlas", content: "Build it" }),
    }));
  });

  it("rejects non-success statuses without attempting to parse a body", async () => {
    const response = jsonResponse({ message: "no" }, 503);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));

    await expect(operatorApi.loadSnapshot()).rejects.toThrow("Thorax request failed (503)");
    expect(response.json).not.toHaveBeenCalled();
  });
});
