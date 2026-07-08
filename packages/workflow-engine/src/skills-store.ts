import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import type { SkillRun, SkillEdit } from "@thorax/shared-types";

export class SkillOptimizationStore {
  readonly #db: DatabaseSync;
  #closed = false;

  constructor(dataDirectory: string) {
    mkdirSync(dataDirectory, { recursive: true });
    this.#db = new DatabaseSync(join(dataDirectory, "state.sqlite"));
    
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS skill_runs (
        id TEXT PRIMARY KEY,
        skill_name TEXT NOT NULL,
        skill_version TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        input_summary TEXT NOT NULL,
        output TEXT NOT NULL,
        outcome TEXT NOT NULL CHECK (outcome IN ('success', 'failure', 'partial')),
        score REAL NOT NULL CHECK (score >= 0.0 AND score <= 1.0),
        human_override INTEGER NOT NULL CHECK (human_override IN (0, 1)),
        correction_notes TEXT
      );

      CREATE TABLE IF NOT EXISTS skill_edits (
        id TEXT PRIMARY KEY,
        skill_name TEXT NOT NULL,
        base_version TEXT NOT NULL,
        proposed_diff TEXT NOT NULL,
        rationale TEXT NOT NULL,
        validation_score_before REAL NOT NULL,
        validation_score_after REAL NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('proposed', 'accepted', 'rejected')),
        rejection_reason TEXT
      );
    `);
  }

  saveRun(run: SkillRun): void {
    if (this.#closed) throw new Error("Store is closed.");
    const stmt = this.#db.prepare(`
      INSERT INTO skill_runs (id, skill_name, skill_version, timestamp, input_summary, output, outcome, score, human_override, correction_notes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        outcome = excluded.outcome,
        score = excluded.score,
        human_override = excluded.human_override,
        correction_notes = excluded.correction_notes;
    `);
    stmt.run(
      run.id,
      run.skillName,
      run.skillVersion,
      run.timestamp,
      run.inputSummary,
      run.output,
      run.outcome,
      run.score,
      run.humanOverride ? 1 : 0,
      run.correctionNotes ?? null
    );
  }

  loadRun(id: string): SkillRun | undefined {
    if (this.#closed) throw new Error("Store is closed.");
    const stmt = this.#db.prepare(`
      SELECT id, skill_name, skill_version, timestamp, input_summary, output, outcome, score, human_override, correction_notes
      FROM skill_runs WHERE id = ?
    `);
    const row = stmt.get(id) as Record<string, any> | undefined;
    if (!row) return undefined;
    return {
      id: row.id,
      skillName: row.skill_name,
      skillVersion: row.skill_version,
      timestamp: row.timestamp,
      inputSummary: row.input_summary,
      output: row.output,
      outcome: row.outcome as SkillRun["outcome"],
      score: row.score,
      humanOverride: row.human_override === 1,
      correctionNotes: row.correction_notes ?? null
    };
  }

  listRunsForSkill(skillName: string, limit = 20): SkillRun[] {
    if (this.#closed) throw new Error("Store is closed.");
    const stmt = this.#db.prepare(`
      SELECT id, skill_name, skill_version, timestamp, input_summary, output, outcome, score, human_override, correction_notes
      FROM skill_runs
      WHERE skill_name = ?
      ORDER BY timestamp DESC
      LIMIT ?
    `);
    const rows = stmt.all(skillName, limit) as Record<string, any>[];
    return rows.map((row) => ({
      id: row.id,
      skillName: row.skill_name,
      skillVersion: row.skill_version,
      timestamp: row.timestamp,
      inputSummary: row.input_summary,
      output: row.output,
      outcome: row.outcome as SkillRun["outcome"],
      score: row.score,
      humanOverride: row.human_override === 1,
      correctionNotes: row.correction_notes ?? null
    }));
  }

  saveEdit(edit: SkillEdit): void {
    if (this.#closed) throw new Error("Store is closed.");
    const stmt = this.#db.prepare(`
      INSERT INTO skill_edits (id, skill_name, base_version, proposed_diff, rationale, validation_score_before, validation_score_after, status, rejection_reason)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        status = excluded.status,
        rejection_reason = excluded.rejection_reason;
    `);
    stmt.run(
      edit.id,
      edit.skillName,
      edit.baseVersion,
      edit.proposedDiff,
      edit.rationale,
      edit.validationScoreBefore,
      edit.validationScoreAfter,
      edit.status,
      edit.rejectionReason ?? null
    );
  }

  loadEdit(id: string): SkillEdit | undefined {
    if (this.#closed) throw new Error("Store is closed.");
    const stmt = this.#db.prepare(`
      SELECT id, skill_name, base_version, proposed_diff, rationale, validation_score_before, validation_score_after, status, rejection_reason
      FROM skill_edits WHERE id = ?
    `);
    const row = stmt.get(id) as Record<string, any> | undefined;
    if (!row) return undefined;
    return {
      id: row.id,
      skillName: row.skill_name,
      baseVersion: row.base_version,
      proposedDiff: row.proposed_diff,
      rationale: row.rationale,
      validationScoreBefore: row.validation_score_before,
      validationScoreAfter: row.validation_score_after,
      status: row.status as SkillEdit["status"],
      rejectionReason: row.rejection_reason ?? null
    };
  }

  listEditsForSkill(skillName: string): SkillEdit[] {
    if (this.#closed) throw new Error("Store is closed.");
    const stmt = this.#db.prepare(`
      SELECT id, skill_name, base_version, proposed_diff, rationale, validation_score_before, validation_score_after, status, rejection_reason
      FROM skill_edits
      WHERE skill_name = ?
      ORDER BY id DESC
    `);
    const rows = stmt.all(skillName) as Record<string, any>[];
    return rows.map((row) => ({
      id: row.id,
      skillName: row.skill_name,
      baseVersion: row.base_version,
      proposedDiff: row.proposed_diff,
      rationale: row.rationale,
      validationScoreBefore: row.validation_score_before,
      validationScoreAfter: row.validation_score_after,
      status: row.status as SkillEdit["status"],
      rejectionReason: row.rejection_reason ?? null
    }));
  }

  listAllEdits(): SkillEdit[] {
    if (this.#closed) throw new Error("Store is closed.");
    const stmt = this.#db.prepare(`
      SELECT id, skill_name, base_version, proposed_diff, rationale, validation_score_before, validation_score_after, status, rejection_reason
      FROM skill_edits
      ORDER BY id DESC
    `);
    const rows = stmt.all() as Record<string, any>[];
    return rows.map((row) => ({
      id: row.id,
      skillName: row.skill_name,
      baseVersion: row.base_version,
      proposedDiff: row.proposed_diff,
      rationale: row.rationale,
      validationScoreBefore: row.validation_score_before,
      validationScoreAfter: row.validation_score_after,
      status: row.status as SkillEdit["status"],
      rejectionReason: row.rejection_reason ?? null
    }));
  }

  updateEditStatus(id: string, status: SkillEdit["status"], rejectionReason?: string): void {
    if (this.#closed) throw new Error("Store is closed.");
    const stmt = this.#db.prepare(`
      UPDATE skill_edits
      SET status = ?, rejection_reason = ?
      WHERE id = ?
    `);
    stmt.run(status, rejectionReason ?? null, id);
  }

  close(): void {
    if (!this.#closed) {
      this.#db.close();
      this.#closed = true;
    }
  }
}
