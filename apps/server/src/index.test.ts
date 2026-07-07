import { mkdtemp, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CodexEvent, CodexHealth, RunTurnOptions } from "@thorax/codex-bridge";
import { ThoraxService } from "./index.js";

class FakeRuntime {
  health = vi.fn<() => Promise<CodexHealth>>().mockResolvedValue({
    status: "ready",
    version: "0.1.0",
    auth: "chatgpt",
    message: "ok",
  });

  lastRunOptions?: RunTurnOptions;

  async *runTurn(options: RunTurnOptions): AsyncGenerator<CodexEvent> {
    this.lastRunOptions = options;
    yield { type: "thread.started", threadId: "thread-1" };
    yield { type: "turn.started", threadId: "thread-1", turnId: "turn-1" };
    yield { type: "message.delta", threadId: "thread-1", turnId: "turn-1", itemId: "item-1", delta: "Hello" };
    yield { type: "turn.completed", threadId: "thread-1", turnId: "turn-1", status: "completed" };
  }
}

let cleanupPaths: string[] = [];

afterEach(async () => {
  for (const path of cleanupPaths) {
    await import("node:fs/promises").then(({ rm }) => rm(path, { recursive: true, force: true }));
  }
  cleanupPaths = [];
});

describe("ThoraxService snapshot", () => {
  it("reuses a recent Codex health check across snapshot calls", async () => {
    const rootPath = await mkdtemp(join(tmpdir(), "thorax-project-"));
    const dataDirectory = await mkdtemp(join(tmpdir(), "thorax-data-"));
    cleanupPaths.push(rootPath, dataDirectory);
    await mkdir(join(rootPath, "workspace"), { recursive: true });

    const runtime = new FakeRuntime();
    const service = await ThoraxService.open({
      dataDirectory,
      runtime,
      project: { id: "thorax", name: "Thorax", rootPath },
    });

    await service.snapshot();
    await service.snapshot();

    expect(runtime.health).toHaveBeenCalledTimes(1);
    service.close();
  });

  it("enriches agent prompts with skills guidelines and routes correctly", async () => {
    const rootPath = await mkdtemp(join(tmpdir(), "thorax-project-"));
    const dataDirectory = await mkdtemp(join(tmpdir(), "thorax-data-"));
    cleanupPaths.push(rootPath, dataDirectory);
    await mkdir(join(rootPath, "workspace"), { recursive: true });

    const runtime = new FakeRuntime();
    const service = await ThoraxService.open({
      dataDirectory,
      runtime,
      project: { id: "thorax", name: "Thorax", rootPath },
    });

    const snapshot = await service.snapshot();
    const operatorAgent = snapshot.agents.find((a) => a.id === "operator");
    expect(operatorAgent).toBeDefined();
    expect(operatorAgent?.skills).toBeDefined();
    expect(operatorAgent?.skills.map((s) => s.id)).toContain("operation");

    const conversation = snapshot.conversation;
    await service.sendMessage(conversation.id, "thorax-core", "thorax", "delegate work");

    expect(runtime.lastRunOptions).toBeDefined();
    expect(runtime.lastRunOptions?.prompt).toContain("Active Capabilities:");
    expect(runtime.lastRunOptions?.prompt).toContain("Skill: Coordination");
    expect(runtime.lastRunOptions?.prompt).toContain("Available specialist agents in this workspace:");
    expect(runtime.lastRunOptions?.prompt).toContain("Agent: Operator (operator) - Role: Execute actions safely in any domain");

    service.close();
  });
});
