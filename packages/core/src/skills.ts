import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { skillSchema, type Skill } from "@thorax/shared-types";

export const defaultSkills: readonly Skill[] = [
  {
    id: "coordination",
    name: "Coordination",
    description: "Coordinate workflows, direct operator requests, and route tasks to specialists.",
    rules: [
      "Analyze operator requests to determine which specialist is needed.",
      "Delegate tasks clearly with full context.",
      "Synthesize final results from specialists back to the operator."
    ],
    systemPrompt: "You are skilled in Coordination. Your primary job is to orchestrate the workflow, identify the correct agent for the job, and delegate tasks cleanly."
  },
  {
    id: "research",
    name: "Research",
    description: "Analyze code structures, search for patterns, and gather factual information.",
    rules: [
      "Search before assuming.",
      "Distinguish facts from inferences.",
      "Reference exact lines and files when reporting findings."
    ],
    systemPrompt: "You are skilled in Research. Ensure all claims are backed by source files/symbols. Use your search tools before drawing conclusions."
  },
  {
    id: "operation",
    name: "Operation",
    description: "Execute actions safely in any domain — code, spreadsheets, or external systems.",
    rules: [
      "Keep changes focused and minimal.",
      "Prefer dry-run or preview before committing any state change.",
      "Run verification (tests, diffs, confirmations) before completing a task.",
      "Preserve existing data and structure; prefer additive changes."
    ],
    systemPrompt: "You are skilled in Domain Operations. Whether acting on code, spreadsheets, or external systems, always prefer to preview actions before committing them. Verify results after every change."
  },
  {
    id: "reviewer",
    name: "Reviewer",
    description: "Independently review code changes for correctness, security, and styling.",
    rules: [
      "Inspect diffs carefully for logic errors or security issues.",
      "Verify that the implementation meets all requirements.",
      "Provide clear, constructive feedback on style and patterns."
    ],
    systemPrompt: "You are skilled in Code Review. Verify correctness, edge cases, security, and compliance with project styling."
  },
  {
    id: "memory-curation",
    name: "Memory Curation",
    description: "Extract lessons learned and store them as project, agent, or personal memories.",
    rules: [
      "Identify reusable lessons that prevent future repeating of work.",
      "Add memories using thorax-memory tags with appropriate scopes.",
      "Keep memory content concise and actionable."
    ],
    systemPrompt: "You are skilled in Memory Curation. Monitor the session outcomes for durable lessons and output <thorax-memory> tags to suggest them."
  }
] as const;

export class SkillRegistry {
  readonly #skills = new Map<string, Skill>();

  constructor(skills: readonly Skill[]) {
    for (const skill of skills) {
      this.#skills.set(skill.id, structuredClone(skill));
    }
  }

  static async load(projectRootPath: string, skills: readonly Skill[] = defaultSkills): Promise<SkillRegistry> {
    const registry = new SkillRegistry(skills);
    const skillsDir = join(projectRootPath, ".thorax", "skills");
    try {
      const files = await readdir(skillsDir);
      for (const file of files) {
        if (file.endsWith(".json")) {
          try {
            const content = await readFile(join(skillsDir, file), "utf8");
            const parsed = skillSchema.parse(JSON.parse(content));
            registry.#skills.set(parsed.id, parsed);
          } catch (error) {
            console.error(`Failed to load project skill from ${file}:`, error);
          }
        }
      }
    } catch (error) {
      if (typeof error === "object" && error !== null && "code" in error && error.code !== "ENOENT") {
        throw error;
      }
    }
    return registry;
  }

  get(id: string): Skill | undefined {
    return this.#skills.get(id);
  }

  list(): Skill[] {
    return [...this.#skills.values()];
  }
}
