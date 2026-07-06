import { access, mkdir, mkdtemp, readFile, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, test } from "vitest";

import { MemoryEngine } from "./index.js";

const directories: string[] = [];
const engines: MemoryEngine[] = [];

async function createEngine() {
  const dataDirectory = await mkdtemp(join(tmpdir(), "thorax-memory-"));
  directories.push(dataDirectory);
  const engine = await MemoryEngine.open({ dataDirectory });
  engines.push(engine);
  return { dataDirectory, engine };
}

afterEach(async () => {
  for (const engine of engines.splice(0)) engine.close();
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("MemoryEngine durable retrieval", () => {
  test("marks a freshly created database with the fully constrained schema version", async () => {
    const { dataDirectory } = await createEngine();
    const inspection = new DatabaseSync(join(dataDirectory, "metadata.sqlite"));
    expect((inspection.prepare("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(1);
    inspection.close();
  });

  test("retrieves project over agent over personal and isolates agent-private memory after reopen", async () => {
    const { dataDirectory, engine } = await createEngine();
    const evidence = [{ conversationId: "conversation-1", turnId: "turn-1", excerpt: "User supplied this fact." }];

    const personal = await engine.addApproved({ content: "Use concise replies", scope: "personal", evidence });
    const privateAlpha = await engine.addApproved({
      content: "Alpha-only operating note",
      scope: "agent",
      agentId: "alpha",
      evidence,
    });
    await engine.addApproved({ content: "Use concise replies", scope: "agent", agentId: "alpha", evidence });
    await engine.addApproved({
      content: "Use concise replies",
      scope: "project",
      projectId: "thorax",
      evidence,
    });
    await engine.addApproved({
      content: "Beta-only operating note",
      scope: "agent",
      agentId: "beta",
      evidence,
    });

    engine.close();
    const reopened = await MemoryEngine.open({ dataDirectory });
    const results = await reopened.retrieve({ agentId: "alpha", projectId: "thorax" });

    expect(results.map(({ content, scope }) => ({ content, scope }))).toEqual([
      { content: "Use concise replies", scope: "project" },
      { content: "Alpha-only operating note", scope: "agent" },
    ]);
    expect(results.some(({ content }) => content.includes("Beta-only"))).toBe(false);
    expect(results[0]?.evidence).toEqual(evidence);
    await expect(readFile(join(dataDirectory, personal.contentPath), "utf8")).resolves.toContain("Use concise replies");
    reopened.close();
  });

  test("does not reveal memory from another project", async () => {
    const { engine } = await createEngine();
    const evidence = [{ conversationId: "conversation-1", excerpt: "Project fact" }];
    await engine.addApproved({ content: "Thorax only", scope: "project", projectId: "thorax", evidence });
    await engine.addApproved({ content: "Apollo only", scope: "project", projectId: "apollo", evidence });

    await expect(engine.retrieve({ agentId: "alpha", projectId: "thorax" })).resolves.toMatchObject([
      { content: "Thorax only", projectId: "thorax" },
    ]);
  });
});

describe("MemoryEngine review workflow", () => {
  test("deduplicates pending candidates by owner and normalized content while preserving evidence", async () => {
    const { engine } = await createEngine();
    const first = await engine.stage({
      content: "Prefer   direct answers",
      scope: "agent",
      agentId: "alpha",
      evidence: [{ conversationId: "conversation-1", excerpt: "First observation" }],
    });
    const duplicate = await engine.stage({
      content: " prefer direct ANSWERS ",
      scope: "agent",
      agentId: "alpha",
      evidence: [{ conversationId: "conversation-2", excerpt: "Second observation" }],
    });
    const otherOwner = await engine.stage({
      content: "Prefer direct answers",
      scope: "agent",
      agentId: "beta",
      evidence: [{ conversationId: "conversation-3", excerpt: "Beta observation" }],
    });

    expect(duplicate.id).toBe(first.id);
    expect(duplicate.evidence).toHaveLength(2);
    expect(otherOwner.id).not.toBe(first.id);
    await expect(engine.pendingReview()).resolves.toHaveLength(2);
    engine.close();
  });

  test("atomically deduplicates concurrent stages across open engine instances", async () => {
    const { dataDirectory, engine } = await createEngine();
    const secondEngine = await MemoryEngine.open({ dataDirectory });
    engines.push(secondEngine);
    const input = {
      content: "One durable candidate",
      scope: "project" as const,
      projectId: "thorax",
      evidence: [{ conversationId: "conversation-1", excerpt: "Same observation" }],
    };

    const [first, second] = await Promise.all([engine.stage(input), secondEngine.stage(input)]);

    expect(second.id).toBe(first.id);
    await expect(engine.pendingReview()).resolves.toHaveLength(1);
  });

  test("deduplicates repeated evidence both initially and while merging", async () => {
    const { engine } = await createEngine();
    const repeated = { conversationId: "conversation-1", turnId: "turn-1", excerpt: "Repeated" };
    const first = await engine.stage({
      content: "Evidence set",
      scope: "personal",
      evidence: [repeated, repeated],
    });
    const merged = await engine.stage({
      content: "Evidence set",
      scope: "personal",
      evidence: [
        repeated,
        { conversationId: "conversation-2", excerpt: "New" },
        { conversationId: "conversation-2", excerpt: "New" },
      ],
    });

    expect(first.evidence).toEqual([repeated]);
    expect(merged.evidence).toEqual([repeated, { conversationId: "conversation-2", excerpt: "New" }]);
  });

  test.each([
    { content: "x", scope: "personal" as const, agentId: "alpha", evidence: [{ conversationId: "c", excerpt: "e" }] },
    { content: "x", scope: "personal" as const, projectId: "thorax", evidence: [{ conversationId: "c", excerpt: "e" }] },
    { content: "x", scope: "agent" as const, agentId: "   ", evidence: [{ conversationId: "c", excerpt: "e" }] },
    { content: "x", scope: "agent" as const, agentId: "alpha", projectId: "thorax", evidence: [{ conversationId: "c", excerpt: "e" }] },
    { content: "x", scope: "project" as const, projectId: " ", evidence: [{ conversationId: "c", excerpt: "e" }] },
    { content: "x", scope: "project" as const, projectId: "thorax", agentId: "alpha", evidence: [{ conversationId: "c", excerpt: "e" }] },
  ])("rejects invalid scope-owner combination %#", async (input) => {
    const { engine } = await createEngine();
    await expect(engine.stage(input)).rejects.toThrow(/scope|requires|nonblank/i);
  });

  test("approve and reject are idempotent and remove candidates from pending review", async () => {
    const { engine } = await createEngine();
    const evidence = [{ conversationId: "conversation-1", excerpt: "Observed" }];
    const approvedCandidate = await engine.stage({ content: "Approved fact", scope: "personal", evidence });
    const rejectedCandidate = await engine.stage({ content: "Rejected fact", scope: "personal", evidence });

    expect((await engine.approve(approvedCandidate.id)).status).toBe("approved");
    expect((await engine.approve(approvedCandidate.id)).status).toBe("approved");
    expect((await engine.reject(rejectedCandidate.id)).status).toBe("rejected");
    expect((await engine.reject(rejectedCandidate.id)).status).toBe("rejected");
    await expect(engine.pendingReview()).resolves.toEqual([]);
    await expect(engine.approve(rejectedCandidate.id)).rejects.toThrow("rejected");
    engine.close();
  });

  test("promotes a candidate exactly once into its reviewed scope", async () => {
    const { dataDirectory, engine } = await createEngine();
    const candidate = await engine.stage({
      content: "Project convention",
      scope: "personal",
      evidence: [{ conversationId: "conversation-1", excerpt: "Convention established" }],
    });

    const promoted = await engine.promote(candidate.id, { scope: "project", projectId: "thorax" });
    const repeated = await engine.promote(candidate.id, { scope: "project", projectId: "thorax" });

    expect(repeated).toEqual(promoted);
    expect(promoted).toMatchObject({ status: "promoted", scope: "project", projectId: "thorax" });
    await expect(engine.retrieve({ agentId: "alpha", projectId: "thorax" })).resolves.toMatchObject([
      { id: candidate.id, content: "Project convention", status: "promoted" },
    ]);
    await expect(readFile(join(dataDirectory, promoted.contentPath), "utf8")).resolves.toBe("Project convention");
    await expect(engine.promote(candidate.id, { scope: "agent", agentId: "alpha" })).rejects.toThrow(
      "already promoted",
    );
    engine.close();
  });

  test("makes concurrent promotion to the same target idempotent", async () => {
    const { dataDirectory, engine } = await createEngine();
    const secondEngine = await MemoryEngine.open({ dataDirectory });
    engines.push(secondEngine);
    const candidate = await engine.stage({
      content: "Concurrent promotion",
      scope: "personal",
      evidence: [{ conversationId: "conversation-1", excerpt: "Promote" }],
    });

    const [first, second] = await Promise.all([
      engine.promote(candidate.id, { scope: "project", projectId: "thorax" }),
      secondEngine.promote(candidate.id, { scope: "project", projectId: "thorax" }),
    ]);

    expect(second).toEqual(first);
    await expect(engine.history(candidate.id)).resolves.toMatchObject([
      { action: "staged" },
      { action: "promoted" },
    ]);
  });

  test("merges an equivalent promotion into the existing target idempotently", async () => {
    const { engine } = await createEngine();
    const existing = await engine.addApproved({
      content: "Shared convention",
      scope: "project",
      projectId: "thorax",
      evidence: [{ conversationId: "target-conversation", excerpt: "Existing target evidence" }],
    });
    const source = await engine.stage({
      content: " shared   CONVENTION ",
      scope: "personal",
      evidence: [{ conversationId: "source-conversation", excerpt: "Promotion evidence" }],
    });

    const promoted = await engine.promote(source.id, { scope: "project", projectId: "thorax" });
    const repeated = await engine.promote(source.id, { scope: "project", projectId: "thorax" });

    expect(promoted.id).toBe(existing.id);
    expect(repeated).toEqual(promoted);
    expect(promoted.evidence).toEqual([
      { conversationId: "target-conversation", excerpt: "Existing target evidence" },
      { conversationId: "source-conversation", excerpt: "Promotion evidence" },
    ]);
    await expect(engine.retrieve({ projectId: "thorax" })).resolves.toHaveLength(1);
    await expect(engine.history(source.id)).resolves.toMatchObject([
      { action: "staged" },
      { action: "promoted", details: { deduplicatedInto: existing.id } },
    ]);
    await expect(engine.history(existing.id)).resolves.toMatchObject([
      { action: "approved" },
      { action: "evidence_added", details: { sourceMemoryId: source.id, addedCount: 1 } },
    ]);
  });

  test("persists promotion convergence across reopen", async () => {
    const { dataDirectory, engine } = await createEngine();
    const target = await engine.addApproved({
      content: "Persistent convergence",
      scope: "project",
      projectId: "thorax",
      evidence: [{ conversationId: "target", excerpt: "Target" }],
    });
    const source = await engine.stage({
      content: "PERSISTENT convergence",
      scope: "personal",
      evidence: [{ conversationId: "source", excerpt: "Source" }],
    });
    await engine.promote(source.id, { scope: "project", projectId: "thorax" });
    engine.close();

    const reopened = await MemoryEngine.open({ dataDirectory });
    engines.push(reopened);
    await expect(reopened.promote(source.id, { scope: "project", projectId: "thorax" })).resolves.toMatchObject({
      id: target.id,
      evidence: [{ conversationId: "target", excerpt: "Target" }, { conversationId: "source", excerpt: "Source" }],
    });
  });

  test("converges a promotion into a pending target and makes the result durable", async () => {
    const { engine } = await createEngine();
    const target = await engine.stage({
      content: "Pending target",
      scope: "project",
      projectId: "thorax",
      evidence: [{ conversationId: "target", excerpt: "Target" }],
    });
    const source = await engine.stage({
      content: "pending TARGET",
      scope: "personal",
      evidence: [{ conversationId: "source", excerpt: "Source" }],
    });

    await expect(engine.promote(source.id, { scope: "project", projectId: "thorax" })).resolves.toMatchObject({
      id: target.id,
      status: "promoted",
    });
    await expect(engine.pendingReview()).resolves.toEqual([]);
    await expect(engine.retrieve({ projectId: "thorax" })).resolves.toHaveLength(1);
  });

  test("rejects an unknown promotion scope at the runtime boundary", async () => {
    const { engine } = await createEngine();
    const candidate = await engine.stage({
      content: "Invalid target",
      scope: "personal",
      evidence: [{ conversationId: "conversation-1", excerpt: "Target" }],
    });

    await expect(engine.promote(candidate.id, { scope: "team" } as never)).rejects.toThrow("scope");
    await expect(engine.pendingReview()).resolves.toMatchObject([{ id: candidate.id, status: "pending" }]);
  });

  test("persists pending review state and an idempotent audit trail across reopen", async () => {
    const { dataDirectory, engine } = await createEngine();
    const candidate = await engine.stage({
      content: "Remember after restart",
      scope: "personal",
      evidence: [{ conversationId: "conversation-1", excerpt: "Durable observation" }],
    });
    engine.close();

    const reopened = await MemoryEngine.open({ dataDirectory });
    await expect(reopened.pendingReview()).resolves.toMatchObject([{ id: candidate.id, status: "pending" }]);
    await reopened.approve(candidate.id);
    await reopened.approve(candidate.id);
    await expect(reopened.history(candidate.id)).resolves.toMatchObject([
      { action: "staged", memoryId: candidate.id },
      { action: "approved", memoryId: candidate.id },
    ]);
    reopened.close();
  });

  test("records candidate provenance in its audit history", async () => {
    const { engine } = await createEngine();
    const candidate = await engine.stage({
      content: "Auditable candidate",
      scope: "agent",
      agentId: "alpha",
      evidence: [{ conversationId: "conversation-1", excerpt: "Source" }],
    });

    await expect(engine.history(candidate.id)).resolves.toMatchObject([
      {
        action: "staged",
        details: { scope: "agent", agentId: "alpha", fingerprint: candidate.fingerprint, evidenceCount: 1 },
      },
    ]);
  });

  test("records reviewer and rationale for approval decisions", async () => {
    const { engine } = await createEngine();
    const candidate = await engine.stage({
      content: "Reviewed candidate",
      scope: "personal",
      evidence: [{ conversationId: "conversation-1", excerpt: "Candidate" }],
    });

    await engine.approve(candidate.id, { reviewer: "operator", rationale: "Confirmed from source evidence" });

    await expect(engine.history(candidate.id)).resolves.toMatchObject([
      { action: "staged" },
      { action: "approved", details: { reviewer: "operator", rationale: "Confirmed from source evidence" } },
    ]);
  });

  test("removes an unreferenced Markdown file when reopening after a partial write", async () => {
    const { dataDirectory, engine } = await createEngine();
    engine.close();
    const orphan = join(dataDirectory, "content", "project", "orphan.md");
    await mkdir(join(dataDirectory, "content", "project"), { recursive: true });
    await writeFile(orphan, "partial write", "utf8");
    const stale = new Date(Date.now() - 120_000);
    await utimes(orphan, stale, stale);

    const reopened = await MemoryEngine.open({ dataDirectory });
    engines.push(reopened);

    await expect(access(orphan)).rejects.toThrow();
  });

  test("does not remove a fresh unreferenced file that may belong to a concurrent writer", async () => {
    const { dataDirectory, engine } = await createEngine();
    engine.close();
    const inFlight = join(dataDirectory, "content", "project", "in-flight.md");
    await mkdir(join(dataDirectory, "content", "project"), { recursive: true });
    await writeFile(inFlight, "concurrent write", "utf8");

    const reopened = await MemoryEngine.open({ dataDirectory });
    engines.push(reopened);

    await expect(readFile(inFlight, "utf8")).resolves.toBe("concurrent write");
  });

  test("rolls back metadata and removes content when audit insertion fails", async () => {
    const { dataDirectory, engine } = await createEngine();
    const sabotage = new DatabaseSync(join(dataDirectory, "metadata.sqlite"));
    sabotage.exec(`
      CREATE TRIGGER reject_memory_event
      BEFORE INSERT ON memory_events
      BEGIN
        SELECT RAISE(ABORT, 'simulated audit failure');
      END;
    `);

    await expect(
      engine.stage({
        content: "Must roll back",
        scope: "personal",
        evidence: [{ conversationId: "conversation-1", excerpt: "Failure" }],
      }),
    ).rejects.toThrow("simulated audit failure");
    await expect(engine.pendingReview()).resolves.toEqual([]);
    await expect(readdir(join(dataDirectory, "content", "personal"))).resolves.toEqual([]);
    sabotage.exec("DROP TRIGGER reject_memory_event");
    sabotage.close();
  });

  test("repairs legacy duplicates without demoting the strongest durable record", async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), "thorax-memory-legacy-"));
    directories.push(dataDirectory);
    await mkdir(join(dataDirectory, "content", "personal"), { recursive: true });
    await writeFile(join(dataDirectory, "content", "personal", "one.md"), "Legacy duplicate", "utf8");
    await writeFile(join(dataDirectory, "content", "personal", "two.md"), "Legacy duplicate", "utf8");
    await writeFile(join(dataDirectory, "content", "personal", "three.md"), "Legacy duplicate", "utf8");
    const fingerprint = "legacy-fingerprint";
    const legacy = new DatabaseSync(join(dataDirectory, "metadata.sqlite"));
    legacy.exec(`
      CREATE TABLE memories (
        id TEXT PRIMARY KEY, scope TEXT NOT NULL, status TEXT NOT NULL, agent_id TEXT, project_id TEXT,
        evidence_json TEXT NOT NULL, fingerprint TEXT NOT NULL, content_path TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL
      );
      CREATE TABLE memory_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT, memory_id TEXT NOT NULL, action TEXT NOT NULL,
        created_at TEXT NOT NULL, details_json TEXT NOT NULL
      );
    `);
    const insert = legacy.prepare("INSERT INTO memories VALUES (?, 'personal', ?, NULL, NULL, ?, ?, ?, ?)");
    insert.run("one", "pending", JSON.stringify([{ conversationId: "one", excerpt: "First" }]), fingerprint, "content/personal/one.md", "2026-01-01T00:00:00.000Z");
    insert.run("two", "approved", JSON.stringify([{ conversationId: "two", excerpt: "Second" }]), fingerprint, "content/personal/two.md", "2026-01-02T00:00:00.000Z");
    insert.run("three", "promoted", JSON.stringify([{ conversationId: "three", excerpt: "Third" }]), fingerprint, "content/personal/three.md", "2026-01-03T00:00:00.000Z");
    legacy.close();

    const engine = await MemoryEngine.open({ dataDirectory });
    engines.push(engine);

    await expect(engine.pendingReview()).resolves.toEqual([]);
    await expect(engine.retrieve({})).resolves.toMatchObject([
      {
        id: "three",
        status: "promoted",
        evidence: [
          { conversationId: "one", excerpt: "First" },
          { conversationId: "two", excerpt: "Second" },
          { conversationId: "three", excerpt: "Third" },
        ],
      },
    ]);
    const inspection = new DatabaseSync(join(dataDirectory, "metadata.sqlite"));
    expect((inspection.prepare("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(0);
    inspection.close();
  });

  test("does not claim schema v1 for a legacy table with only a partial CHECK set", async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), "thorax-memory-partial-schema-"));
    directories.push(dataDirectory);
    await mkdir(join(dataDirectory, "content"), { recursive: true });
    const legacy = new DatabaseSync(join(dataDirectory, "metadata.sqlite"));
    legacy.exec(`
      CREATE TABLE memories (
        id TEXT PRIMARY KEY,
        scope TEXT NOT NULL CHECK (scope IN ('personal', 'agent', 'project')),
        status TEXT NOT NULL, agent_id TEXT, project_id TEXT, evidence_json TEXT NOT NULL,
        fingerprint TEXT NOT NULL, content_path TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL
      );
      CREATE TABLE memory_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT, memory_id TEXT NOT NULL, action TEXT NOT NULL,
        created_at TEXT NOT NULL, details_json TEXT NOT NULL
      );
    `);
    legacy.close();

    const engine = await MemoryEngine.open({ dataDirectory });
    engines.push(engine);
    const inspection = new DatabaseSync(join(dataDirectory, "metadata.sqlite"));
    expect((inspection.prepare("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(0);
    inspection.close();
  });

  test("quarantines valid JSON evidence that is not an array before hydration", async () => {
    const { dataDirectory, engine } = await createEngine();
    const memory = await engine.addApproved({
      content: "Corrupted metadata",
      scope: "personal",
      evidence: [{ conversationId: "conversation-1", excerpt: "Valid initially" }],
    });
    engine.close();
    const corruption = new DatabaseSync(join(dataDirectory, "metadata.sqlite"));
    corruption.prepare("UPDATE memories SET evidence_json = '{}' WHERE id = ?").run(memory.id);
    corruption.close();

    const reopened = await MemoryEngine.open({ dataDirectory });
    engines.push(reopened);

    await expect(reopened.retrieve({})).resolves.toEqual([]);
    await expect(reopened.history(memory.id)).resolves.toMatchObject([
      { action: "approved" },
      { action: "rejected", details: { reason: "invalid_evidence_metadata" } },
    ]);
  });

  test("close is idempotent and blocks operations before writing files", async () => {
    const { dataDirectory, engine } = await createEngine();
    engine.close();
    expect(() => engine.close()).not.toThrow();

    await expect(
      engine.stage({
        content: "Must not be written",
        scope: "personal",
        evidence: [{ conversationId: "conversation-1", excerpt: "Closed" }],
      }),
    ).rejects.toThrow("closed");
    await expect(access(join(dataDirectory, "content", "personal"))).rejects.toThrow();
  });
});
