import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { defaultSkills, SkillRegistry } from "./skills.js";

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
