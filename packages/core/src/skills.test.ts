import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { defaultSkills, SkillRegistry, parseSkillMarkdown, stringifySkillMarkdown, applyPatch, getSkillHash } from "./skills.js";

const dirs: string[] = [];
afterEach(async () => Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))));

describe("Skills System", () => {
  it("ships all 5 default capabilities", () => {
    expect(defaultSkills.map((s) => s.id).sort()).toEqual([
      "coordination",
      "memory-curation",
      "operation",
      "research",
      "reviewer",
    ]);
  });

  it("SkillRegistry retrieves default skills", () => {
    const registry = new SkillRegistry(defaultSkills);
    expect(registry.get("operation")?.name).toBe("Operation");
    expect(registry.get("unknown")).toBeUndefined();
    expect(registry.list()).toHaveLength(5);
  });

  it("SkillRegistry.load retrieves project-specific skills from .thorax/skills", async () => {
    const rootPath = await mkdtemp(join(tmpdir(), "thorax-project-skills-"));
    dirs.push(rootPath);
    await mkdir(join(rootPath, ".thorax", "skills"), { recursive: true });

    const customSkill = {
      id: "custom-deploy",
      name: "Custom Deploy",
      description: "Handles custom deployment flows.",
      rules: ["Verify environment variables first."],
      systemPrompt: "You are acting as a Deployment Specialist.",
    };

    await writeFile(
      join(rootPath, ".thorax", "skills", "custom-deploy.json"),
      JSON.stringify(customSkill),
      "utf8",
    );

    const registry = await SkillRegistry.load(rootPath, defaultSkills);
    
    // Check that we loaded both default skills and custom project skills
    expect(registry.get("custom-deploy")?.name).toBe("Custom Deploy");
    expect(registry.get("operation")?.name).toBe("Operation");
    expect(registry.list().length).toBe(6);
  });
});

describe("Skill Markdown and Patching Helpers", () => {
  it("parses and stringifies a skill file correctly", () => {
    const rawMarkdown = `---
id: lease_entry
name: Lease Entry
description: Handles SAP lease entry flows.
systemPrompt: You are acting as a Lease Entry Specialist.
---

# Guidelines
- Verify tenant details.
- Do not use placeholders.
`;
    const parsed = parseSkillMarkdown(rawMarkdown);
    expect(parsed.id).toBe("lease_entry");
    expect(parsed.name).toBe("Lease Entry");
    expect(parsed.description).toBe("Handles SAP lease entry flows.");
    expect(parsed.rules).toEqual(["Verify tenant details.", "Do not use placeholders."]);
    expect(parsed.systemPrompt.trim()).toBe("You are acting as a Lease Entry Specialist.");

    const stringified = stringifySkillMarkdown(parsed);
    expect(stringified.trim()).toBe(rawMarkdown.trim());
  });

  it("calculates a consistent hash for a skill", () => {
    const skill1 = {
      id: "coordination",
      name: "Coordination",
      description: "Coordination skill",
      rules: ["Rule 1"],
      systemPrompt: "Prompt 1"
    };
    const hash1 = getSkillHash(skill1);
    expect(typeof hash1).toBe("string");
    expect(hash1.length).toBe(16); // 16 hex length
    
    const skill2 = { ...skill1, rules: ["Rule 1", "Rule 2"] };
    const hash2 = getSkillHash(skill2);
    expect(hash2).not.toBe(hash1);
  });

  it("applies unified diff patches correctly", () => {
    const original = "Line 1\nLine 2\nLine 3\n";
    const diff = `--- a/SKILL.md
+++ b/SKILL.md
@@ -1,3 +1,3 @@
 Line 1
-Line 2
+Line 2 modified
 Line 3
`;
    const patched = applyPatch(original, diff);
    expect(patched).toBe("Line 1\nLine 2 modified\nLine 3\n");
  });
});
