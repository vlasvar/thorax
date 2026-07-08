import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SkillOptimizationStore } from "./skills-store.js";
import { SkillRun, SkillEdit } from "@thorax/shared-types";

const dirs: string[] = [];
afterEach(async () => Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))));

describe("SkillOptimizationStore", () => {
  it("initializes and performs CRUD on skill runs and edits", async () => {
    const dir = await mkdtemp(join(tmpdir(), "thorax-skills-store-"));
    dirs.push(dir);

    const store = new SkillOptimizationStore(dir);

    const runId1 = "run-1";
    const run1: SkillRun = {
      id: runId1,
      skillName: "sap_lease_entry",
      skillVersion: "v1.0.0",
      timestamp: new Date().toISOString(),
      inputSummary: "Alice lease",
      output: "Done",
      outcome: "success",
      score: 1.0,
      humanOverride: false,
      correctionNotes: null
    };

    store.saveRun(run1);

    const loadedRun = store.loadRun(runId1);
    expect(loadedRun).toBeDefined();
    expect(loadedRun?.skillName).toBe("sap_lease_entry");
    expect(loadedRun?.outcome).toBe("success");

    const runs = store.listRunsForSkill("sap_lease_entry");
    expect(runs).toHaveLength(1);
    expect(runs[0]?.id).toBe(runId1);

    const editId1 = "edit-1";
    const edit1: SkillEdit = {
      id: editId1,
      skillName: "sap_lease_entry",
      baseVersion: "v1.0.0",
      proposedDiff: "diff content",
      rationale: "fix details",
      validationScoreBefore: 0.5,
      validationScoreAfter: 0.8,
      status: "proposed",
      rejectionReason: null
    };

    store.saveEdit(edit1);

    const edits = store.listEditsForSkill("sap_lease_entry");
    expect(edits).toHaveLength(1);
    expect(edits[0]?.id).toBe(editId1);
    expect(edits[0]?.status).toBe("proposed");

    const allEdits = store.listAllEdits();
    expect(allEdits).toHaveLength(1);

    store.updateEditStatus(editId1, "accepted");
    const updatedEdits = store.listEditsForSkill("sap_lease_entry");
    expect(updatedEdits[0]?.status).toBe("accepted");

    store.close();
  });
});
