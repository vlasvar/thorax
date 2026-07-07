import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentRegistry, ConversationStore, LearningPipeline, ReflectionScheduler, defaultAgents, extractLearning } from "./index.js";

const dirs: string[] = [];
afterEach(async () => Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))));

describe("agent registry", () => {
  it("ships the five durable specialists", () => {
    expect(defaultAgents.map((agent) => agent.id)).toEqual(["thorax-core", "research", "operator", "reviewer", "memory-curator"]);
  });

  it("enforces explicit project access", () => {
    const registry = new AgentRegistry(defaultAgents.map((agent) => ({ ...agent, projectAccess: ["thorax"] })));
    expect(registry.requireAccess("operator", "thorax").id).toBe("operator");
    expect(() => registry.requireAccess("operator", "private")).toThrow(/access/i);
  });
});

describe("conversation bindings", () => {
  it("persists one durable binding per agent and project and resumes its Codex thread", async () => {
    const dir = await mkdtemp(join(tmpdir(), "thorax-core-")); dirs.push(dir);
    const store = await ConversationStore.open(join(dir, "conversations.json"));
    const first = await store.getOrCreate("builder", "thorax");
    await store.bindThread(first.id, "thread-123");
    await store.append(first.id, { author: "operator", content: "Build it" });

    const reopened = await ConversationStore.open(join(dir, "conversations.json"));
    const binding = await reopened.getOrCreate("builder", "thorax");
    expect(binding.id).toBe(first.id);
    expect(binding.codexThreadId).toBe("thread-123");
    expect(binding.messages[0]?.content).toBe("Build it");
    expect((await reopened.getOrCreate("research", "thorax")).id).not.toBe(first.id);
  });
});

describe("reviewable learning", () => {
  it("auto-stages ephemeral lessons but sends durable lessons to review", async () => {
    const staged: unknown[] = [];
    const pipeline = new LearningPipeline({
      async stage(input) { staged.push(input); return { id: `memory-${staged.length}`, status: "pending" as const }; },
    });
    const results = await pipeline.ingest([
      { content: "Temporary observation", scope: "ephemeral", evidence: { conversationId: "c1", excerpt: "temp" } },
      { content: "Use the project formatter", scope: "project", projectId: "thorax", evidence: { conversationId: "c1", excerpt: "format" } },
      { content: "Operator prefers TDD", scope: "agent", agentId: "operator", evidence: { conversationId: "c1", excerpt: "tests first" } },
      { content: "Change operator instructions", scope: "instruction-suggestion", agentId: "operator", evidence: { conversationId: "c1", excerpt: "suggestion" } },
    ]);

    expect(results.map((result) => result.status)).toEqual(["staged", "pending", "pending", "pending"]);
    expect(staged).toHaveLength(3);
    expect(staged[2]).toMatchObject({ scope: "agent", agentId: "memory-curator", content: expect.stringContaining("Instruction suggestion") });
  });

  it("extracts explicit model learning markers without showing them to the operator", () => {
    const result = extractLearning(
      "Done.\n<thorax-memory scope=\"project\">Always run npm check.</thorax-memory>",
      { conversationId: "c1", agentId: "operator", projectId: "thorax", turnId: "t1" },
    );
    expect(result.visibleText).toBe("Done.");
    expect(result.candidates[0]).toMatchObject({ scope: "project", projectId: "thorax", content: "Always run npm check." });
  });
});

describe("background reflection", () => {
  it("is restart-safe and does not process a completed session twice", async () => {
    const dir = await mkdtemp(join(tmpdir(), "thorax-reflect-")); dirs.push(dir);
    let reflections = 0;
    const reflector = { async reflect() { reflections += 1; return [{ content: "Keep tests small", scope: "project" as const, projectId: "thorax", evidence: { conversationId: "c1", excerpt: "small tests" } }]; } };
    const staged: unknown[] = [];
    const pipeline = new LearningPipeline({ async stage(input) { staged.push(input); return { id: "m1", status: "pending" as const }; } });
    const statePath = join(dir, "reflection.json");
    const first = await ReflectionScheduler.open(statePath, reflector, pipeline);
    expect(await first.reflect({ id: "session-1", agentId: "operator", projectId: "thorax", transcript: "Use small tests" })).toMatchObject({ processed: true, candidates: 1 });
    const reopened = await ReflectionScheduler.open(statePath, reflector, pipeline);
    expect(await reopened.reflect({ id: "session-1", agentId: "operator", projectId: "thorax", transcript: "Use small tests" })).toMatchObject({ processed: false, candidates: 0 });
    expect(reflections).toBe(1);
    expect(staged).toHaveLength(1);
  });
});
