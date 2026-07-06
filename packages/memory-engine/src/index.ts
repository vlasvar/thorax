import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

export type DurableMemoryScope = "personal" | "agent" | "project";
export type MemoryStatus = "pending" | "approved" | "rejected" | "promoted";
const ORPHAN_GRACE_PERIOD_MS = 60_000;

export interface MemoryEvidence {
  conversationId: string;
  excerpt: string;
  turnId?: string;
}

export interface MemoryInput {
  content: string;
  scope: DurableMemoryScope;
  agentId?: string;
  projectId?: string;
  evidence: MemoryEvidence[];
}

export interface MemoryRecord extends MemoryInput {
  id: string;
  status: MemoryStatus;
  fingerprint: string;
  contentPath: string;
  createdAt: string;
}

export interface RetrievalContext {
  agentId?: string;
  projectId?: string;
}

export type PromotionTarget =
  | { scope: "personal" }
  | { scope: "agent"; agentId: string }
  | { scope: "project"; projectId: string };

export interface ReviewAudit {
  reviewer?: string;
  rationale?: string;
}

export interface MemoryHistoryEntry {
  id: number;
  memoryId: string;
  action: "staged" | "approved" | "rejected" | "promoted" | "evidence_added";
  createdAt: string;
  details: Record<string, unknown>;
}

interface HistoryRow {
  id: number;
  memory_id: string;
  action: MemoryHistoryEntry["action"];
  created_at: string;
  details_json: string;
}

interface MemoryRow {
  id: string;
  scope: DurableMemoryScope;
  status: MemoryStatus;
  agent_id: string | null;
  project_id: string | null;
  evidence_json: string;
  fingerprint: string;
  content_path: string;
  created_at: string;
}

interface PromotionMappingRow {
  source_memory_id: string;
  target_memory_id: string;
  scope: DurableMemoryScope;
  agent_id: string | null;
  project_id: string | null;
}

export class MemoryEngine {
  readonly #dataDirectory: string;
  readonly #database: DatabaseSync;
  readonly #promotionLocks = new Map<string, Promise<MemoryRecord>>();
  #closed = false;

  private constructor(dataDirectory: string, database: DatabaseSync) {
    this.#dataDirectory = dataDirectory;
    this.#database = database;
  }

  static async open({ dataDirectory }: { dataDirectory: string }): Promise<MemoryEngine> {
    const contentDirectory = join(dataDirectory, "content");
    await mkdir(contentDirectory, { recursive: true });
    const database = new DatabaseSync(join(dataDirectory, "metadata.sqlite"));
    try {
      database.exec(`
        PRAGMA journal_mode = WAL;
        PRAGMA foreign_keys = ON;
        PRAGMA busy_timeout = 5000;
        CREATE TABLE IF NOT EXISTS memories (
          id TEXT PRIMARY KEY,
          scope TEXT NOT NULL CHECK (scope IN ('personal', 'agent', 'project')),
          status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected', 'promoted')),
          agent_id TEXT,
          project_id TEXT,
          evidence_json TEXT NOT NULL CHECK (json_valid(evidence_json)),
          fingerprint TEXT NOT NULL CHECK (length(fingerprint) > 0),
          content_path TEXT NOT NULL UNIQUE CHECK (length(content_path) > 0),
          created_at TEXT NOT NULL,
          CHECK (
            (scope = 'personal' AND agent_id IS NULL AND project_id IS NULL)
            OR (scope = 'agent' AND agent_id IS NOT NULL AND length(trim(agent_id)) > 0 AND project_id IS NULL)
            OR (scope = 'project' AND project_id IS NOT NULL AND length(trim(project_id)) > 0 AND agent_id IS NULL)
          )
        );
        CREATE INDEX IF NOT EXISTS memories_lookup
          ON memories (status, project_id, agent_id, scope, fingerprint);
        CREATE TABLE IF NOT EXISTS memory_events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          memory_id TEXT NOT NULL REFERENCES memories(id),
          action TEXT NOT NULL CHECK (action IN ('staged', 'approved', 'rejected', 'promoted', 'evidence_added')),
          created_at TEXT NOT NULL,
          details_json TEXT NOT NULL CHECK (json_valid(details_json))
        );
        CREATE INDEX IF NOT EXISTS memory_events_history ON memory_events (memory_id, id);
        CREATE TABLE IF NOT EXISTS memory_promotion_dedup (
          source_memory_id TEXT PRIMARY KEY REFERENCES memories(id),
          target_memory_id TEXT NOT NULL REFERENCES memories(id),
          scope TEXT NOT NULL,
          agent_id TEXT,
          project_id TEXT,
          created_at TEXT NOT NULL
        );
      `);
      repairLegacyRows(database);
      const constrainedSchema = memoryTableHasConstraints(database);
      database.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS memories_active_identity
          ON memories (scope, COALESCE(agent_id, ''), COALESCE(project_id, ''), fingerprint)
          WHERE status IN ('pending', 'approved', 'promoted');
        PRAGMA user_version = ${constrainedSchema ? 1 : 0};
      `);
      const engine = new MemoryEngine(dataDirectory, database);
      await engine.#removeOrphanedContent();
      return engine;
    } catch (error) {
      database.close();
      throw error;
    }
  }

  async addApproved(input: MemoryInput): Promise<MemoryRecord> {
    this.#assertOpen();
    return this.#insertOrMerge(normalizeInput(input), "approved");
  }

  async stage(input: MemoryInput): Promise<MemoryRecord> {
    this.#assertOpen();
    return this.#insertOrMerge(normalizeInput(input), "pending");
  }

  async pendingReview(): Promise<MemoryRecord[]> {
    this.#assertOpen();
    const rows = this.#database
      .prepare("SELECT * FROM memories WHERE status = 'pending' ORDER BY created_at ASC, id ASC")
      .all() as unknown as MemoryRow[];
    return Promise.all(rows.map((row) => this.#hydrate(row)));
  }

  async approve(id: string, audit?: ReviewAudit): Promise<MemoryRecord> {
    this.#assertOpen();
    const auditDetails = normalizeReviewAudit(audit);
    const row = this.#transaction(() => {
      const current = this.#row(id);
      if (current.status === "rejected") throw new Error(`Memory ${id} was rejected and cannot be approved`);
      if (current.status === "pending") {
        this.#database.prepare("UPDATE memories SET status = 'approved' WHERE id = ?").run(id);
        this.#recordEvent(id, "approved", auditDetails);
        current.status = "approved";
      }
      return current;
    });
    return this.#hydrate(row);
  }

  async reject(id: string, audit?: ReviewAudit): Promise<MemoryRecord> {
    this.#assertOpen();
    const auditDetails = normalizeReviewAudit(audit);
    const row = this.#transaction(() => {
      const current = this.#row(id);
      if (current.status === "approved" || current.status === "promoted") {
        throw new Error(`Memory ${id} is ${current.status} and cannot be rejected`);
      }
      if (current.status === "pending") {
        this.#database.prepare("UPDATE memories SET status = 'rejected' WHERE id = ?").run(id);
        this.#recordEvent(id, "rejected", auditDetails);
        current.status = "rejected";
      }
      return current;
    });
    return this.#hydrate(row);
  }

  async promote(id: string, target: PromotionTarget, audit?: ReviewAudit): Promise<MemoryRecord> {
    this.#assertOpen();
    const normalizedTarget = normalizeTarget(target);
    const auditDetails = normalizeReviewAudit(audit);
    const prior = this.#promotionLocks.get(id);
    const operation = (prior ? prior.catch(() => undefined) : Promise.resolve()).then(() =>
      this.#promoteOnce(id, normalizedTarget, auditDetails),
    );
    this.#promotionLocks.set(id, operation);
    return operation.finally(() => {
      if (this.#promotionLocks.get(id) === operation) this.#promotionLocks.delete(id);
    });
  }

  async history(memoryId: string): Promise<MemoryHistoryEntry[]> {
    this.#assertOpen();
    this.#row(memoryId);
    const rows = this.#database
      .prepare("SELECT * FROM memory_events WHERE memory_id = ? ORDER BY id ASC")
      .all(memoryId) as unknown as HistoryRow[];
    return rows.map((row) => ({
      id: row.id,
      memoryId: row.memory_id,
      action: row.action,
      createdAt: row.created_at,
      details: JSON.parse(row.details_json) as Record<string, unknown>,
    }));
  }

  async retrieve(context: RetrievalContext): Promise<MemoryRecord[]> {
    this.#assertOpen();
    const agentId = optionalNonblank(context.agentId, "agentId");
    const projectId = optionalNonblank(context.projectId, "projectId");
    const rows = this.#database
      .prepare(`
        SELECT * FROM memories
        WHERE status IN ('approved', 'promoted')
          AND (
            scope = 'personal'
            OR (scope = 'agent' AND agent_id = ?)
            OR (scope = 'project' AND project_id = ?)
          )
        ORDER BY CASE scope WHEN 'project' THEN 3 WHEN 'agent' THEN 2 ELSE 1 END DESC,
                 created_at ASC, id ASC
      `)
      .all(agentId ?? null, projectId ?? null) as unknown as MemoryRow[];

    const fingerprints = new Set<string>();
    const results: MemoryRecord[] = [];
    for (const row of rows) {
      if (fingerprints.has(row.fingerprint)) continue;
      fingerprints.add(row.fingerprint);
      results.push(await this.#hydrate(row));
    }
    return results;
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#database.close();
  }

  async #insertOrMerge(input: MemoryInput, status: "pending" | "approved"): Promise<MemoryRecord> {
    const id = randomUUID();
    const fingerprint = fingerprintFor(input.content);
    const contentPath = contentPathFor(input.scope, id);
    const absolutePath = join(this.#dataDirectory, contentPath);
    const createdAt = new Date().toISOString();
    await mkdir(dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, input.content, { encoding: "utf8", flag: "wx" });

    try {
      const inserted = this.#transaction(() => {
        this.#database
          .prepare(`
            INSERT INTO memories (
              id, scope, status, agent_id, project_id, evidence_json,
              fingerprint, content_path, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          `)
          .run(
            id,
            input.scope,
            status,
            input.agentId ?? null,
            input.projectId ?? null,
            JSON.stringify(input.evidence),
            fingerprint,
            contentPath,
            createdAt,
          );
        this.#recordEvent(id, status === "pending" ? "staged" : "approved", provenance(input, fingerprint));
        return this.#row(id);
      });
      return this.#hydrate(inserted);
    } catch (error) {
      await rm(absolutePath, { force: true }).catch(() => undefined);
      const existing = this.#findActive(input, fingerprint);
      if (!existing) throw error;
      return this.#mergeEvidence(existing, input.evidence, status);
    }
  }

  async #mergeEvidence(
    existing: MemoryRow,
    incoming: MemoryEvidence[],
    requestedStatus: "pending" | "approved",
  ): Promise<MemoryRecord> {
    const updated = this.#transaction(() => {
      const current = this.#row(existing.id);
      const currentEvidence = parseEvidence(current.evidence_json);
      const evidence = dedupeEvidence([...currentEvidence, ...incoming]);
      const status = requestedStatus === "approved" && current.status === "pending" ? "approved" : current.status;
      if (evidence.length !== currentEvidence.length || status !== current.status) {
        this.#database
          .prepare("UPDATE memories SET evidence_json = ?, status = ? WHERE id = ?")
          .run(JSON.stringify(evidence), status, current.id);
        if (evidence.length !== currentEvidence.length) {
          this.#recordEvent(current.id, "evidence_added", { addedCount: evidence.length - currentEvidence.length });
        }
        if (status !== current.status) this.#recordEvent(current.id, "approved");
        current.evidence_json = JSON.stringify(evidence);
        current.status = status;
      }
      return current;
    });
    return this.#hydrate(updated);
  }

  async #promoteOnce(id: string, target: PromotionTarget, audit: Record<string, string>): Promise<MemoryRecord> {
    this.#assertOpen();
    const mapping = this.#promotionMapping(id);
    if (mapping) return this.#mappedPromotionOrThrow(mapping, target);
    const initial = this.#row(id);
    if (initial.status === "promoted") return this.#hydrate(this.#samePromotionOrThrow(initial, target));
    if (initial.status === "rejected") throw new Error(`Memory ${id} was rejected and cannot be promoted`);

    const collision = this.#findPromotionTarget(target, initial.fingerprint, id);
    if (collision) return this.#mergePromotionCollision(initial, collision, target, audit);

    const targetPath = contentPathFor(target.scope, id);
    const oldAbsolutePath = join(this.#dataDirectory, initial.content_path);
    const targetAbsolutePath = join(this.#dataDirectory, targetPath);
    if (targetPath !== initial.content_path) {
      const content = await readFile(oldAbsolutePath, "utf8");
      await mkdir(dirname(targetAbsolutePath), { recursive: true });
      await writeFile(targetAbsolutePath, content, "utf8");
    }

    let promoted: MemoryRow;
    try {
      promoted = this.#transaction(() => {
        const current = this.#row(id);
        if (current.status === "promoted") return this.#samePromotionOrThrow(current, target);
        if (current.status === "rejected") throw new Error(`Memory ${id} was rejected and cannot be promoted`);
        const agentId = target.scope === "agent" ? target.agentId : null;
        const projectId = target.scope === "project" ? target.projectId : null;
        this.#database
          .prepare(`
            UPDATE memories
            SET scope = ?, status = 'promoted', agent_id = ?, project_id = ?, content_path = ?
            WHERE id = ?
          `)
          .run(target.scope, agentId, projectId, targetPath, id);
        this.#recordEvent(id, "promoted", {
          fromScope: current.scope,
          toScope: target.scope,
          ...(agentId ? { agentId } : {}),
          ...(projectId ? { projectId } : {}),
          ...audit,
        });
        return { ...current, scope: target.scope, status: "promoted", agent_id: agentId, project_id: projectId, content_path: targetPath };
      });
    } catch (error) {
      if (targetPath !== initial.content_path) await rm(targetAbsolutePath, { force: true }).catch(() => undefined);
      const racedTarget = this.#findPromotionTarget(target, initial.fingerprint, id);
      if (racedTarget) return this.#mergePromotionCollision(this.#row(id), racedTarget, target, audit);
      throw error;
    }

    if (targetPath !== initial.content_path) await rm(oldAbsolutePath, { force: true }).catch(() => undefined);
    return this.#hydrate(promoted);
  }

  #samePromotionOrThrow(row: MemoryRow, target: PromotionTarget): MemoryRow {
    const agentId = target.scope === "agent" ? target.agentId : null;
    const projectId = target.scope === "project" ? target.projectId : null;
    if (row.scope === target.scope && row.agent_id === agentId && row.project_id === projectId) return row;
    throw new Error(`Memory ${row.id} was already promoted to another scope`);
  }

  async #mappedPromotionOrThrow(mapping: PromotionMappingRow, target: PromotionTarget): Promise<MemoryRecord> {
    const agentId = target.scope === "agent" ? target.agentId : null;
    const projectId = target.scope === "project" ? target.projectId : null;
    if (mapping.scope !== target.scope || mapping.agent_id !== agentId || mapping.project_id !== projectId) {
      throw new Error(`Memory ${mapping.source_memory_id} was already promoted to another scope`);
    }
    return this.#hydrate(this.#row(mapping.target_memory_id));
  }

  async #mergePromotionCollision(
    source: MemoryRow,
    targetRow: MemoryRow,
    target: PromotionTarget,
    audit: Record<string, string>,
  ): Promise<MemoryRecord> {
    const merged = this.#transaction(() => {
      const existingMapping = this.#promotionMapping(source.id);
      if (existingMapping) {
        const agentId = target.scope === "agent" ? target.agentId : null;
        const projectId = target.scope === "project" ? target.projectId : null;
        if (existingMapping.scope !== target.scope || existingMapping.agent_id !== agentId || existingMapping.project_id !== projectId) {
          throw new Error(`Memory ${source.id} was already promoted to another scope`);
        }
        return this.#row(existingMapping.target_memory_id);
      }
      const currentSource = this.#row(source.id);
      const currentTarget = this.#row(targetRow.id);
      const targetEvidence = parseEvidence(currentTarget.evidence_json);
      const sourceEvidence = parseEvidence(currentSource.evidence_json);
      const evidence = dedupeEvidence([...targetEvidence, ...sourceEvidence]);
      const addedCount = evidence.length - targetEvidence.length;
      const resultingStatus = currentTarget.status === "pending" ? "promoted" : currentTarget.status;
      this.#database
        .prepare("UPDATE memories SET evidence_json = ?, status = ? WHERE id = ?")
        .run(JSON.stringify(evidence), resultingStatus, currentTarget.id);
      this.#database.prepare("UPDATE memories SET status = 'rejected' WHERE id = ?").run(currentSource.id);
      const agentId = target.scope === "agent" ? target.agentId : null;
      const projectId = target.scope === "project" ? target.projectId : null;
      this.#database
        .prepare(`
          INSERT INTO memory_promotion_dedup
            (source_memory_id, target_memory_id, scope, agent_id, project_id, created_at)
          VALUES (?, ?, ?, ?, ?, ?)
        `)
        .run(currentSource.id, currentTarget.id, target.scope, agentId, projectId, new Date().toISOString());
      if (addedCount > 0) {
        this.#recordEvent(currentTarget.id, "evidence_added", {
          sourceMemoryId: currentSource.id,
          addedCount,
          evidence: evidence.slice(targetEvidence.length),
        });
      }
      if (currentTarget.status === "pending") {
        this.#recordEvent(currentTarget.id, "promoted", { deduplicatedFrom: currentSource.id, ...audit });
      }
      this.#recordEvent(currentSource.id, "promoted", {
        deduplicatedInto: currentTarget.id,
        toScope: target.scope,
        ...(agentId ? { agentId } : {}),
        ...(projectId ? { projectId } : {}),
        ...audit,
      });
      return { ...currentTarget, status: resultingStatus, evidence_json: JSON.stringify(evidence) };
    });
    return this.#hydrate(merged);
  }

  #promotionMapping(sourceId: string): PromotionMappingRow | undefined {
    return this.#database
      .prepare("SELECT * FROM memory_promotion_dedup WHERE source_memory_id = ?")
      .get(sourceId) as unknown as PromotionMappingRow | undefined;
  }

  #findPromotionTarget(target: PromotionTarget, fingerprint: string, sourceId: string): MemoryRow | undefined {
    const agentId = target.scope === "agent" ? target.agentId : "";
    const projectId = target.scope === "project" ? target.projectId : "";
    return this.#database
      .prepare(`
        SELECT * FROM memories
        WHERE id <> ? AND scope = ? AND COALESCE(agent_id, '') = ? AND COALESCE(project_id, '') = ?
          AND fingerprint = ? AND status IN ('pending', 'approved', 'promoted')
        LIMIT 1
      `)
      .get(sourceId, target.scope, agentId, projectId, fingerprint) as unknown as MemoryRow | undefined;
  }

  #findActive(input: MemoryInput, fingerprint: string): MemoryRow | undefined {
    return this.#database
      .prepare(`
        SELECT * FROM memories
        WHERE scope = ?
          AND COALESCE(agent_id, '') = ?
          AND COALESCE(project_id, '') = ?
          AND fingerprint = ?
          AND status IN ('pending', 'approved', 'promoted')
        LIMIT 1
      `)
      .get(input.scope, input.agentId ?? "", input.projectId ?? "", fingerprint) as unknown as MemoryRow | undefined;
  }

  #row(id: string): MemoryRow {
    const row = this.#database.prepare("SELECT * FROM memories WHERE id = ?").get(id) as unknown as MemoryRow | undefined;
    if (!row) throw new Error(`Memory ${id} was not found`);
    return row;
  }

  #recordEvent(memoryId: string, action: MemoryHistoryEntry["action"], details: Record<string, unknown> = {}): void {
    this.#database
      .prepare("INSERT INTO memory_events (memory_id, action, created_at, details_json) VALUES (?, ?, ?, ?)")
      .run(memoryId, action, new Date().toISOString(), JSON.stringify(details));
  }

  #transaction<T>(operation: () => T): T {
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.#database.exec("COMMIT");
      return result;
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  async #hydrate(row: MemoryRow): Promise<MemoryRecord> {
    const content = await readFile(join(this.#dataDirectory, row.content_path), "utf8");
    return {
      id: row.id,
      content,
      scope: row.scope,
      status: row.status,
      fingerprint: row.fingerprint,
      contentPath: row.content_path,
      createdAt: row.created_at,
      evidence: parseEvidence(row.evidence_json),
      ...(row.agent_id === null ? {} : { agentId: row.agent_id }),
      ...(row.project_id === null ? {} : { projectId: row.project_id }),
    };
  }

  async #removeOrphanedContent(): Promise<void> {
    const referenced = new Set(
      (this.#database.prepare("SELECT content_path FROM memories").all() as unknown as Array<{ content_path: string }>).map(
        ({ content_path }) => resolve(this.#dataDirectory, content_path),
      ),
    );
    const contentDirectory = join(this.#dataDirectory, "content");
    const staleBefore = Date.now() - ORPHAN_GRACE_PERIOD_MS;
    for (const file of await markdownFiles(contentDirectory)) {
      if (referenced.has(resolve(file))) continue;
      const metadata = await stat(file).catch(() => undefined);
      if (metadata && metadata.mtimeMs <= staleBefore) await rm(file, { force: true });
    }
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error("Memory engine is closed");
  }
}

function normalizeInput(input: MemoryInput): MemoryInput {
  const content = input.content.trim();
  if (!content) throw new Error("Memory content cannot be empty");
  const evidence = dedupeEvidence(input.evidence);
  if (evidence.length === 0) throw new Error("Memory evidence is required");
  const agentId = optionalNonblank(input.agentId, "agentId");
  const projectId = optionalNonblank(input.projectId, "projectId");

  if (input.scope === "personal" && (agentId || projectId)) throw new Error("Personal scope cannot have an owner");
  if (input.scope === "agent" && (!agentId || projectId)) throw new Error("Agent scope requires only agentId");
  if (input.scope === "project" && (!projectId || agentId)) throw new Error("Project scope requires only projectId");

  return {
    content,
    scope: input.scope,
    evidence,
    ...(agentId ? { agentId } : {}),
    ...(projectId ? { projectId } : {}),
  };
}

function normalizeTarget(target: PromotionTarget): PromotionTarget {
  const input = target as PromotionTarget & { agentId?: string; projectId?: string };
  if (input.scope !== "personal" && input.scope !== "agent" && input.scope !== "project") {
    throw new Error("Promotion scope must be personal, agent, or project");
  }
  const agentId = optionalNonblank(input.agentId, "agentId");
  const projectId = optionalNonblank(input.projectId, "projectId");
  if (input.scope === "personal" && (agentId || projectId)) throw new Error("Personal scope cannot have an owner");
  if (input.scope === "agent" && (!agentId || projectId)) throw new Error("Agent scope requires only agentId");
  if (input.scope === "project" && (!projectId || agentId)) throw new Error("Project scope requires only projectId");
  if (input.scope === "agent") return { scope: "agent", agentId: agentId! };
  if (input.scope === "project") return { scope: "project", projectId: projectId! };
  return { scope: "personal" };
}

function normalizeReviewAudit(audit?: ReviewAudit): Record<string, string> {
  if (!audit) return {};
  const reviewer = optionalNonblank(audit.reviewer, "reviewer");
  const rationale = optionalNonblank(audit.rationale, "rationale");
  return { ...(reviewer ? { reviewer } : {}), ...(rationale ? { rationale } : {}) };
}

function optionalNonblank(value: string | undefined, label: string): string | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label} must be nonblank`);
  return normalized;
}

function fingerprintFor(content: string): string {
  const normalized = content.trim().replace(/\s+/g, " ").toLowerCase();
  return createHash("sha256").update(normalized).digest("hex");
}

function evidenceKey(evidence: MemoryEvidence): string {
  return `${evidence.conversationId}\u0000${evidence.turnId ?? ""}\u0000${evidence.excerpt}`;
}

function dedupeEvidence(evidence: MemoryEvidence[]): MemoryEvidence[] {
  const seen = new Set<string>();
  const result: MemoryEvidence[] = [];
  for (const item of evidence) {
    if (!item.conversationId?.trim() || !item.excerpt?.trim() || (item.turnId !== undefined && !item.turnId.trim())) {
      throw new Error("Memory evidence fields must be nonblank");
    }
    const key = evidenceKey(item);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(item);
  }
  return result;
}

function parseEvidence(value: string): MemoryEvidence[] {
  const parsed: unknown = JSON.parse(value);
  if (!Array.isArray(parsed)) throw new Error("Memory evidence metadata must be an array");
  if (parsed.length === 0) throw new Error("Memory evidence metadata must be a non-empty array");
  const evidence: MemoryEvidence[] = parsed.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error("Memory evidence metadata contains an invalid entry");
    }
    const record = item as Record<string, unknown>;
    if (typeof record.conversationId !== "string" || typeof record.excerpt !== "string") {
      throw new Error("Memory evidence metadata contains an invalid entry");
    }
    if (record.turnId !== undefined && typeof record.turnId !== "string") {
      throw new Error("Memory evidence metadata contains an invalid entry");
    }
    return {
      conversationId: record.conversationId,
      excerpt: record.excerpt,
      ...(typeof record.turnId === "string" ? { turnId: record.turnId } : {}),
    };
  });
  return dedupeEvidence(evidence);
}

function provenance(input: MemoryInput, fingerprint: string): Record<string, unknown> {
  return {
    scope: input.scope,
    ...(input.agentId ? { agentId: input.agentId } : {}),
    ...(input.projectId ? { projectId: input.projectId } : {}),
    fingerprint,
    evidenceCount: input.evidence.length,
  };
}

function contentPathFor(scope: DurableMemoryScope, id: string): string {
  return `content/${scope}/${id}.md`;
}

async function markdownFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) files.push(...(await markdownFiles(path)));
    else if (entry.isFile() && entry.name.endsWith(".md")) files.push(path);
  }
  return files;
}

interface DuplicateGroup {
  scope: DurableMemoryScope;
  agent_id: string;
  project_id: string;
  fingerprint: string;
}

function repairLegacyRows(database: DatabaseSync): void {
  database.exec("BEGIN IMMEDIATE");
  try {
    database.exec(`
      UPDATE memories SET agent_id = NULL, project_id = NULL WHERE scope = 'personal';
      UPDATE memories SET project_id = NULL, agent_id = trim(agent_id) WHERE scope = 'agent';
      UPDATE memories SET agent_id = NULL, project_id = trim(project_id) WHERE scope = 'project';
      UPDATE memories SET status = 'rejected'
        WHERE (scope = 'agent' AND (agent_id IS NULL OR agent_id = ''))
           OR (scope = 'project' AND (project_id IS NULL OR project_id = ''));
    `);
    const evidenceRows = database
      .prepare("SELECT id, evidence_json FROM memories WHERE status IN ('pending', 'approved', 'promoted')")
      .all() as unknown as Array<{ id: string; evidence_json: string }>;
    for (const row of evidenceRows) {
      try {
        parseEvidence(row.evidence_json);
      } catch {
        database.prepare("UPDATE memories SET status = 'rejected' WHERE id = ?").run(row.id);
        database
          .prepare("INSERT INTO memory_events (memory_id, action, created_at, details_json) VALUES (?, 'rejected', ?, ?)")
          .run(row.id, new Date().toISOString(), JSON.stringify({ reason: "invalid_evidence_metadata" }));
      }
    }
    const groups = database
      .prepare(`
        SELECT scope, COALESCE(agent_id, '') AS agent_id, COALESCE(project_id, '') AS project_id, fingerprint
        FROM memories
        WHERE status IN ('pending', 'approved', 'promoted')
        GROUP BY scope, COALESCE(agent_id, ''), COALESCE(project_id, ''), fingerprint
        HAVING COUNT(*) > 1
      `)
      .all() as unknown as DuplicateGroup[];
    for (const group of groups) {
      const rows = database
        .prepare(`
          SELECT * FROM memories
          WHERE scope = ? AND COALESCE(agent_id, '') = ? AND COALESCE(project_id, '') = ?
            AND fingerprint = ? AND status IN ('pending', 'approved', 'promoted')
          ORDER BY created_at ASC, id ASC
        `)
        .all(group.scope, group.agent_id, group.project_id, group.fingerprint) as unknown as MemoryRow[];
      const keeper = rows.reduce<MemoryRow | undefined>((strongest, row) => {
        if (!strongest) return row;
        const rowRank = durableStatusRank(row.status);
        const strongestRank = durableStatusRank(strongest.status);
        if (rowRank !== strongestRank) return rowRank > strongestRank ? row : strongest;
        return row.created_at < strongest.created_at || (row.created_at === strongest.created_at && row.id < strongest.id)
          ? row
          : strongest;
      }, undefined);
      if (!keeper) continue;
      const evidence = dedupeEvidence(rows.flatMap((row) => parseEvidence(row.evidence_json)));
      database.prepare("UPDATE memories SET evidence_json = ? WHERE id = ?").run(JSON.stringify(evidence), keeper.id);
      for (const duplicate of rows.filter((row) => row.id !== keeper.id)) {
        database.prepare("UPDATE memories SET status = 'rejected' WHERE id = ?").run(duplicate.id);
        database
          .prepare("INSERT INTO memory_events (memory_id, action, created_at, details_json) VALUES (?, 'rejected', ?, ?)")
          .run(duplicate.id, new Date().toISOString(), JSON.stringify({ deduplicatedInto: keeper.id }));
      }
    }
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

function durableStatusRank(status: MemoryStatus): number {
  if (status === "promoted") return 3;
  if (status === "approved") return 2;
  if (status === "pending") return 1;
  return 0;
}

function memoryTableHasConstraints(database: DatabaseSync): boolean {
  const row = database
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'memories'")
    .get() as { sql?: string } | undefined;
  if (typeof row?.sql !== "string") return false;
  const sql = row.sql.toLowerCase().replace(/\s+/g, " ");
  const requiredConstraints = [
    "scope in ('personal', 'agent', 'project')",
    "status in ('pending', 'approved', 'rejected', 'promoted')",
    "json_valid(evidence_json)",
    "length(fingerprint) > 0",
    "length(content_path) > 0",
    "scope = 'personal' and agent_id is null and project_id is null",
    "scope = 'agent' and agent_id is not null and length(trim(agent_id)) > 0 and project_id is null",
    "scope = 'project' and project_id is not null and length(trim(project_id)) > 0 and agent_id is null",
  ];
  return requiredConstraints.every((constraint) => sql.includes(constraint));
}
