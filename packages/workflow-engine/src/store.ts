import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import type { WorkflowExecution } from "@thorax/shared-types";

export class ExecutionStateStore {
  readonly #db: DatabaseSync;
  #closed = false;

  constructor(dataDirectory: string) {
    mkdirSync(dataDirectory, { recursive: true });
    this.#db = new DatabaseSync(join(dataDirectory, "state.sqlite"));
    
    // Initialize Schema
    this.#db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;

      CREATE TABLE IF NOT EXISTS workflow_executions (
        id TEXT PRIMARY KEY,
        workflow_id TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('running', 'suspended', 'completed', 'failed')),
        current_step_id TEXT,
        context_json TEXT NOT NULL CHECK (json_valid(context_json)),
        step_logs_json TEXT NOT NULL CHECK (json_valid(step_logs_json)),
        updated_at TEXT NOT NULL
      );
    `);
  }

  save(exec: WorkflowExecution): void {
    if (this.#closed) throw new Error("Store is closed.");
    const stmt = this.#db.prepare(`
      INSERT INTO workflow_executions (id, workflow_id, status, current_step_id, context_json, step_logs_json, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        status = excluded.status,
        current_step_id = excluded.current_step_id,
        context_json = excluded.context_json,
        step_logs_json = excluded.step_logs_json,
        updated_at = excluded.updated_at;
    `);
    stmt.run(
      exec.id,
      exec.workflowId,
      exec.status,
      exec.currentStepId ?? null,
      JSON.stringify(exec.context),
      JSON.stringify(exec.stepLogs),
      exec.updatedAt
    );
  }

  load(id: string): WorkflowExecution | undefined {
    if (this.#closed) throw new Error("Store is closed.");
    const stmt = this.#db.prepare(`
      SELECT id, workflow_id, status, current_step_id, context_json, step_logs_json, updated_at
      FROM workflow_executions
      WHERE id = ?
    `);
    const row = stmt.get(id) as Record<string, any> | undefined;
    if (!row) return undefined;
    return {
      id: row.id,
      workflowId: row.workflow_id,
      status: row.status as WorkflowExecution["status"],
      currentStepId: row.current_step_id ?? undefined,
      context: JSON.parse(row.context_json),
      stepLogs: JSON.parse(row.step_logs_json),
      updatedAt: row.updated_at,
    };
  }

  listActive(): WorkflowExecution[] {
    if (this.#closed) throw new Error("Store is closed.");
    const stmt = this.#db.prepare(`
      SELECT id, workflow_id, status, current_step_id, context_json, step_logs_json, updated_at
      FROM workflow_executions
      WHERE status IN ('running', 'suspended')
      ORDER BY updated_at DESC
    `);
    const rows = stmt.all() as Record<string, any>[];
    return rows.map((row) => ({
      id: row.id,
      workflowId: row.workflow_id,
      status: row.status as WorkflowExecution["status"],
      currentStepId: row.current_step_id ?? undefined,
      context: JSON.parse(row.context_json),
      stepLogs: JSON.parse(row.step_logs_json),
      updatedAt: row.updated_at,
    }));
  }

  listAll(): WorkflowExecution[] {
    if (this.#closed) throw new Error("Store is closed.");
    const stmt = this.#db.prepare(`
      SELECT id, workflow_id, status, current_step_id, context_json, step_logs_json, updated_at
      FROM workflow_executions
      ORDER BY updated_at DESC
    `);
    const rows = stmt.all() as Record<string, any>[];
    return rows.map((row) => ({
      id: row.id,
      workflowId: row.workflow_id,
      status: row.status as WorkflowExecution["status"],
      currentStepId: row.current_step_id ?? undefined,
      context: JSON.parse(row.context_json),
      stepLogs: JSON.parse(row.step_logs_json),
      updatedAt: row.updated_at,
    }));
  }

  close(): void {
    if (!this.#closed) {
      this.#db.close();
      this.#closed = true;
    }
  }
}
