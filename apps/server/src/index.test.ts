import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
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
  mockedResponse = "Hello";

  async *runTurn(options: RunTurnOptions): AsyncGenerator<CodexEvent> {
    this.lastRunOptions = options;
    yield { type: "thread.started", threadId: "thread-1" };
    yield { type: "turn.started", threadId: "thread-1", turnId: "turn-1" };
    
    let response = this.mockedResponse;
    if (options.prompt.includes("Task input")) {
      if (options.prompt.includes("Use clear steps.")) {
        response = "Coordinate";
      } else {
        response = "Incorrect response";
      }
    }

    yield { type: "message.delta", threadId: "thread-1", turnId: "turn-1", itemId: "item-1", delta: response };
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

  it("logs skill runs and executes dryRun and commit of optimization adapter", async () => {
    const rootPath = await mkdtemp(join(tmpdir(), "thorax-project-"));
    const dataDirectory = await mkdtemp(join(tmpdir(), "thorax-data-"));
    cleanupPaths.push(rootPath, dataDirectory);
    await mkdir(join(rootPath, "workspace"), { recursive: true });

    // Create a real skill file to patch
    await mkdir(join(rootPath, ".thorax", "skills", "coordination"), { recursive: true });
    const originalSkillMd = `---
id: coordination
name: Coordination
description: Coordinate work.
systemPrompt: You coordinate work.
---

# Guidelines
- Coordinate with other agents.
- Be precise.
`;
    await writeFile(join(rootPath, ".thorax", "skills", "coordination", "SKILL.md"), originalSkillMd, "utf8");

    const runtime = new FakeRuntime();
    const service = await ThoraxService.open({
      dataDirectory,
      runtime,
      project: { id: "thorax", name: "Thorax", rootPath },
    });

    const snapshot = await service.snapshot();
    const conversation = snapshot.conversation;
    
    // Set a response mock first
    runtime.mockedResponse = "Some output";
    await service.sendMessage(conversation.id, "thorax-core", "thorax", "test run");

    const store = service.getSkillsStore();
    const runs = store.listRunsForSkill("coordination");
    expect(runs.length).toBeGreaterThan(0);
    expect(runs[0]?.outcome).toBe("success");
    expect(runs[0]?.score).toBe(1.0);

    // Save a failed run in the store to trigger optimization reflection
    const failedRun = {
      id: "run-failed",
      skillName: "coordination",
      skillVersion: "v1",
      timestamp: new Date().toISOString(),
      inputSummary: "Failed task",
      output: "Wrong answer",
      outcome: "failure" as const,
      score: 0.0,
      humanOverride: false,
      correctionNotes: "Please use clear steps."
    };
    store.saveRun(failedRun);

    // Setup validation cases
    await mkdir(join(rootPath, ".thorax", "validation"), { recursive: true });
    const validationCases = {
      cases: [
        {
          input: "Task input",
          expected: "Coordinate"
        }
      ]
    };
    await writeFile(join(rootPath, ".thorax", "validation", "coordination.json"), JSON.stringify(validationCases), "utf8");

    // Mock validation run replies
    runtime.mockedResponse = "DIAGNOSIS: Proposing steps rule.\n2. DIFF:\n--- a/SKILL.md\n+++ b/SKILL.md\n@@ -8,2 +8,3 @@\n - Be precise.\n+- Use clear steps.\n3. RISK: none\n4. CONFIDENCE: high";

    const dryRunResult = await service.executeAdapterAction({
      adapterId: "skills",
      action: "optimize_skill",
      input: { skillId: "coordination" },
      mode: "dry_run"
    }) as any;

    expect(dryRunResult.mode).toBe("dry_run");
    expect(dryRunResult.diff_preview).toContain("VALIDATION SCORE");

    const edits = store.listEditsForSkill("coordination");
    expect(edits).toHaveLength(1);
    expect(edits[0]?.status).toBe("proposed");

    const commitResult = await service.executeAdapterAction({
      adapterId: "skills",
      action: "optimize_skill",
      input: { skillId: "coordination" },
      mode: "commit",
      approved_by: "operator"
    }) as any;

    expect(commitResult.mode).toBe("commit");
    expect(commitResult.result.status).toBe("promoted");

    const updatedEdits = store.listEditsForSkill("coordination");
    expect(updatedEdits[0]?.status).toBe("accepted");

    // Read the skill file and verify it got patched!
    const patchedSkillMd = await readFile(join(rootPath, ".thorax", "skills", "coordination", "SKILL.md"), "utf8");
    expect(patchedSkillMd).toContain("- Use clear steps.");

    service.close();
  });
});
