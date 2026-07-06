import { afterEach, describe, expect, it, vi } from "vitest";
import { operatorApi } from "./api";

const jsonResponse = (body: unknown, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: vi.fn().mockResolvedValue(body),
});

afterEach(() => vi.unstubAllGlobals());

describe("operatorApi", () => {
  it("loads the operator snapshot from the local server", async () => {
    const body = { agents: [], projects: [] };
    const fetch = vi.fn().mockResolvedValue(jsonResponse(body));
    vi.stubGlobal("fetch", fetch);

    await expect(operatorApi.loadSnapshot()).resolves.toBe(body);
    expect(fetch).toHaveBeenCalledWith("/api/operator/snapshot", expect.objectContaining({ headers: { "content-type": "application/json" } }));
  });

  it("loads a conversation using encoded agent and project bindings", async () => {
    const body = { id: "conversation-1", messages: [] };
    const fetch = vi.fn().mockResolvedValue(jsonResponse(body));
    vi.stubGlobal("fetch", fetch);

    await expect(operatorApi.loadConversation("builder one", "project/two")).resolves.toBe(body);
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

    await expect(operatorApi.sendMessage("conversation/1", "builder", "atlas", "Build it")).resolves.toBe(message);
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
