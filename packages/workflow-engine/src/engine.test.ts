import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { existsSync } from "node:fs";
import type { WorkflowDefinition, AdapterManifest } from "@thorax/shared-types";
import { AdapterRegistry, DispatchRegistry, FakeAdapter } from "@thorax/core";
import { ExecutionStateStore } from "./store.js";
import { WorkflowEngine, type AgentRunner } from "./engine.js";

const testAdapterManifest: AdapterManifest = {
  adapter: "excel",
  version: "1.0.0",
  description: "Test excel",
  auth: { type: "none" },
  actions: [
    {
      name: "read_lease",
      risk_tier: "read_only",
      description: "Read row",
      input_schema: {},
      output_schema: {},
      dry_run_supported: true,
    },
    {
      name: "append_row",
      risk_tier: "write_reversible",
      description: "Append row",
      input_schema: {},
      output_schema: {},
      dry_run_supported: true,
    },
    {
      name: "post_ledger",
      risk_tier: "write_irreversible",
      description: "Post ledger",
      input_schema: {},
      output_schema: {},
      dry_run_supported: true,
    },
  ],
};

const simpleWorkflow: WorkflowDefinition = {
  id: "simple-test",
  version: "1.0.0",
  description: "Runs sequential steps",
  trigger: { type: "schedule", value: "manual" },
  steps: [
    {
      id: "read_step",
      type: "action",
      adapter: "excel",
      action: "read_lease",
      input: { lease_id: "L1" },
      output_path: "context.lease_data",
    },
    {
      id: "agent_step",
      type: "agent_turn",
      agent: "research",
      prompt: "Summarize: ${context.lease_data.tenant}",
      output_path: "context.summary",
    },
  ],
};

const irreversibleWorkflow: WorkflowDefinition = {
  id: "irreversible-test",
  version: "1.0.0",
  description: "Runs irreversible action",
  trigger: { type: "schedule", value: "manual" },
  steps: [
    {
      id: "post_step",
      type: "action",
      adapter: "excel",
      action: "post_ledger",
      input: { rent: "context.rent" },
      output_path: "context.post_result",
    },
  ],
};

const conditionalWorkflow: WorkflowDefinition = {
  id: "conditional-test",
  version: "1.0.0",
  description: "Runs conditional branch",
  trigger: { type: "schedule", value: "manual" },
  steps: [
    {
      id: "cond_step",
      type: "conditional",
      condition: "context.is_valid",
      then: [
        {
          id: "then_step",
          type: "agent_turn",
          agent: "research",
          prompt: "Valid",
          output_path: "context.branch_result",
        },
      ],
      otherwise: [
        {
          id: "else_step",
          type: "agent_turn",
          agent: "research",
          prompt: "Invalid",
          output_path: "context.branch_result",
        },
      ],
    },
  ],
};

const loopWorkflow: WorkflowDefinition = {
  id: "loop-test",
  version: "1.0.0",
  description: "Loops over items",
  trigger: { type: "schedule", value: "manual" },
  steps: [
    {
      id: "loop_step",
      type: "loop",
      over: "context.items",
      item_name: "num",
      steps: [
        {
          id: "add_item_step",
          type: "action",
          adapter: "excel",
          action: "append_row",
          input: { value: "num" },
        },
      ],
    },
  ],
};

describe("WorkflowEngine", () => {
  let tmpDir: string;
  let store: ExecutionStateStore;
  let adapters: AdapterRegistry;
  let dispatch: DispatchRegistry;
  let fakeAdapter: FakeAdapter;
  let agentRunner: AgentRunner;
  let engine: WorkflowEngine;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "thorax-engine-test-"));
    store = new ExecutionStateStore(tmpDir);
    
    adapters = new AdapterRegistry([testAdapterManifest]);
    dispatch = new DispatchRegistry();
    fakeAdapter = new FakeAdapter({
      commitResponse: (action, input) => {
        if (action === "read_lease") return { mode: "commit", result: { tenant: "Bob" }, transaction_id: "txn-read" };
        return { mode: "commit", result: { ok: true, input }, transaction_id: "txn-commit" };
      }
    });
    dispatch.register(testAdapterManifest, fakeAdapter);

    agentRunner = {
      runTurn: vi.fn(async (agentId, prompt) => `Result of ${agentId} for: ${prompt}`),
    };

    engine = new WorkflowEngine(store, adapters, dispatch, agentRunner);
  });

  afterEach(async () => {
    store.close();
    if (existsSync(tmpDir)) {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("executes simple sequential actions and agent turns successfully", async () => {
    const exec = await engine.start(simpleWorkflow, {});
    
    // Wait slightly to let the async engine complete
    await new Promise((r) => setTimeout(r, 50));
    
    const finalized = store.load(exec.id)!;
    expect(finalized.status).toBe("completed");
    expect(finalized.context.lease_data).toEqual({ tenant: "Bob" });
    expect(finalized.context.summary).toBe("Result of research for: Summarize: Bob");
    expect(agentRunner.runTurn).toHaveBeenCalledTimes(1);
  });

  it("suspends execution on irreversible actions and resumes upon approval", async () => {
    const exec = await engine.start(irreversibleWorkflow, { rent: 2000 });
    await new Promise((r) => setTimeout(r, 50));

    const suspended = store.load(exec.id)!;
    expect(suspended.status).toBe("suspended");
    expect(suspended.currentStepId).toBe("post_step");

    // Resume execution with approval
    const resumed = await engine.resumeWithDefinition(exec.id, irreversibleWorkflow, true);
    await new Promise((r) => setTimeout(r, 50));

    const finalized = store.load(resumed.id)!;
    expect(finalized.status).toBe("completed");
    expect(finalized.context.post_result).toMatchObject({ ok: true, input: { rent: 2000 } });
  });

  it("supports branching conditional steps", async () => {
    // Branch true
    const execTrue = await engine.start(conditionalWorkflow, { is_valid: true });
    await new Promise((r) => setTimeout(r, 50));
    expect(store.load(execTrue.id)!.context.branch_result).toContain("Valid");

    // Branch false
    const execFalse = await engine.start(conditionalWorkflow, { is_valid: false });
    await new Promise((r) => setTimeout(r, 50));
    expect(store.load(execFalse.id)!.context.branch_result).toContain("Invalid");
  });

  it("loops over array items", async () => {
    fakeAdapter.reset();
    const exec = await engine.start(loopWorkflow, { items: [10, 20, 30] });
    await new Promise((r) => setTimeout(r, 50));

    expect(store.load(exec.id)!.status).toBe("completed");
    // Wrote 3 commit actions, plus 3 dry_runs
    expect(fakeAdapter.calls.filter((c) => c.mode === "commit")).toHaveLength(3);
    expect(fakeAdapter.calls.filter((c) => c.mode === "commit")[0]?.input).toEqual({ value: 10 });
  });
});
