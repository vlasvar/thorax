import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { CodexEvent, CodexHealth, RunTurnOptions } from "@thorax/codex-bridge";
import { ThoraxService, startThoraxServer } from "./index.js";

const dirs: string[] = [];
const stops: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(stops.splice(0).map((stop) => stop()));
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

class FakeRuntime {
  prompts: RunTurnOptions[] = [];
  async health(): Promise<CodexHealth> { return { status: "ready", version: "test", auth: "chatgpt", message: "ready" }; }
  async *runTurn(options: RunTurnOptions): AsyncGenerator<CodexEvent> {
    this.prompts.push(options);
    yield { type: options.threadId ? "thread.resumed" : "thread.started", threadId: options.threadId ?? "thread-1" };
    yield { type: "turn.started", threadId: options.threadId ?? "thread-1", turnId: "turn-1" };
    yield { type: "message.delta", threadId: options.threadId ?? "thread-1", turnId: "turn-1", itemId: "item-1", delta: "Built safely.\n<thorax-memory scope=\"project\">Run the full check before completion.</thorax-memory>" };
    yield { type: "turn.completed", threadId: options.threadId ?? "thread-1", turnId: "turn-1", status: "completed" };
  }
}

async function fixture() {
  const dataDirectory = await mkdtemp(join(tmpdir(), "thorax-server-")); dirs.push(dataDirectory);
  const runtime = new FakeRuntime();
  const service = await ThoraxService.open({ dataDirectory, runtime, project: { id: "thorax", name: "Thorax", rootPath: process.cwd() } });
  stops.push(async () => { service.close(); });
  return { service, runtime, dataDirectory };
}

describe("Thorax service", () => {
  it("rejects a missing project root with an actionable error", async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), "thorax-server-")); dirs.push(dataDirectory);
    await expect(ThoraxService.open({
      dataDirectory, runtime: new FakeRuntime(),
      project: { id: "missing", name: "Missing", rootPath: join(dataDirectory, "does-not-exist") },
    })).rejects.toThrow(/project root/i);
  });

  it("keeps snapshot binding coherent and resumes the stored Codex thread", async () => {
    const { service, runtime } = await fixture();
    const snapshot = await service.snapshot();
    expect(snapshot.activeAgentId).toBe(snapshot.agents[0]?.id);
    expect(snapshot.conversation.id).toBeTruthy();
    const reply = await service.sendMessage(snapshot.conversation.id, snapshot.activeAgentId, snapshot.activeProjectId, "Please build this");
    expect(reply.content).toBe("Built safely.");
    await service.sendMessage(snapshot.conversation.id, snapshot.activeAgentId, snapshot.activeProjectId, "Continue");
    expect(runtime.prompts[1]?.threadId).toBe("thread-1");
    expect(runtime.prompts[0]?.prompt).toContain("Please build this");
    expect((await service.snapshot()).memoryCandidates).toHaveLength(1);
  });

  it("exposes validated loopback HTTP endpoints for snapshot, messages, and memory review", async () => {
    const { service } = await fixture();
    const logs: unknown[] = [];
    const running = await startThoraxServer(service, { host: "127.0.0.1", port: 0, logger: { write: (entry) => logs.push(entry) } });
    stops.push(running.close);
    const snapshot = await fetch(`${running.url}/api/operator/snapshot`).then((response) => response.json()) as any;
    const response = await fetch(`${running.url}/api/conversations/${snapshot.conversation.id}/messages`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ agentId: snapshot.activeAgentId, projectId: snapshot.activeProjectId, content: "Hello" }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ author: snapshot.activeAgentId, content: "Built safely." });
    const withCandidate = await fetch(`${running.url}/api/operator/snapshot`).then((item) => item.json()) as any;
    const review = await fetch(`${running.url}/api/memory/candidates/${withCandidate.memoryCandidates[0].id}/review`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ decision: "approve" }),
    });
    expect(review.status).toBe(204);
    expect((await fetch(`${running.url}/api/operator/snapshot`).then((item) => item.json()) as any).memoryCandidates).toHaveLength(0);
    const invalid = await fetch(`${running.url}/api/conversations/${snapshot.conversation.id}/messages`, { method: "POST", body: "{}" });
    expect(invalid.status).toBe(400);
    expect(logs).toContainEqual(expect.objectContaining({ level: "warn", status: 400 }));
  });
});
