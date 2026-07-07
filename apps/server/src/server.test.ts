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
  const rootPath = await mkdtemp(join(tmpdir(), "thorax-project-")); dirs.push(rootPath);

  // Write adapter manifest inside the temporary project root
  const adaptersDir = join(rootPath, ".thorax", "adapters");
  await import("node:fs/promises").then(({ mkdir }) => mkdir(adaptersDir, { recursive: true }));
  await import("node:fs/promises").then(({ writeFile }) => writeFile(
    join(adaptersDir, "excel.json"),
    JSON.stringify({
      adapter: "excel",
      version: "1.0.0",
      description: "Excel manifest for tests",
      auth: { type: "none" },
      actions: [
        {
          name: "append_lease_row",
          risk_tier: "write_reversible",
          description: "Append row",
          input_schema: {},
          output_schema: {},
          dry_run_supported: true
        },
        {
          name: "update_lease_row",
          risk_tier: "write_irreversible",
          description: "Update row",
          input_schema: {},
          output_schema: {},
          dry_run_supported: true
        }
      ]
    }),
    "utf8"
  ));

  const runtime = new FakeRuntime();
  const service = await ThoraxService.open({ dataDirectory, runtime, project: { id: "thorax", name: "Thorax", rootPath } });
  stops.push(async () => { service.close(); });
  return { service, runtime, dataDirectory, rootPath };
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

  it("exposes the /api/adapter/execute endpoint for dry-run and commit execution", async () => {
    const { service, rootPath } = await fixture();
    const running = await startThoraxServer(service, { host: "127.0.0.1", port: 0 });
    stops.push(running.close);

    const workbookPath = join(rootPath, "leases.xlsx");

    const dryRunRes = await fetch(`${running.url}/api/adapter/execute`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        adapterId: "excel",
        action: "append_lease_row",
        input: { workbook_path: workbookPath, row: { lease_id: "L1", tenant: "Bob" } },
        mode: "dry_run"
      }),
    });
    expect(dryRunRes.status).toBe(200);
    const dryRunBody = await dryRunRes.json() as any;
    expect(dryRunBody.mode).toBe("dry_run");
    expect(dryRunBody.diff_preview).toContain("+ Row 2: lease_id: L1, tenant: Bob");

    const commitFailRes = await fetch(`${running.url}/api/adapter/execute`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        adapterId: "excel",
        action: "update_lease_row",
        input: { workbook_path: workbookPath, lease_id: "L1", updates: { rent: 2000 } },
        mode: "commit"
      }),
    });
    expect(commitFailRes.status).toBe(400);
    const errBody = await commitFailRes.json() as any;
    expect(errBody.error).toContain("requires explicit approval");
  });
});
