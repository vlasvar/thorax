import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
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

export function parseSkillMarkdown(content: string): Skill {
  const parts = content.split("---");
  if (parts.length < 3) {
    throw new Error("Invalid SKILL.md format: missing frontmatter");
  }
  const yamlSection = parts[1]!;
  const bodySection = parts.slice(2).join("---").trim();

  const metadata: Record<string, string> = {};
  for (const line of yamlSection.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const colonIdx = trimmed.indexOf(":");
    if (colonIdx === -1) continue;
    const key = trimmed.slice(0, colonIdx).trim();
    const val = trimmed.slice(colonIdx + 1).trim();
    metadata[key] = val.replace(/^["']|["']$/g, "");
  }

  const rules: string[] = [];
  for (const line of bodySection.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("-") || trimmed.startsWith("*")) {
      rules.push(trimmed.slice(1).trim());
    }
  }

  return {
    id: metadata.id || "",
    name: metadata.name || "",
    description: metadata.description || "",
    rules,
    systemPrompt: metadata.systemPrompt || "",
  };
}

export function stringifySkillMarkdown(skill: Skill): string {
  const yaml = [
    "---",
    `id: ${skill.id}`,
    `name: ${skill.name}`,
    `description: ${skill.description}`,
    `systemPrompt: ${skill.systemPrompt}`,
    "---",
    "",
    "# Guidelines",
    ...skill.rules.map(rule => `- ${rule}`),
    ""
  ].join("\n");
  return yaml;
}

export function getSkillHash(skill: Skill): string {
  const content = stringifySkillMarkdown(skill);
  return createHash("sha256").update(content).digest("hex").slice(0, 16);
}

export function applyPatch(original: string, diff: string): string {
  const normalizedOriginal = original.replace(/\r\n/g, "\n");
  const normalizedDiff = diff.replace(/\r\n/g, "\n");

  const lines = normalizedOriginal.split("\n");
  const diffLines = normalizedDiff.split("\n");

  const resultLines = [...lines];

  let i = 0;
  while (i < diffLines.length) {
    const line = diffLines[i]!;
    if (line.startsWith("@@ ")) {
      const match = /^@@ -(\d+),?(\d+)? \+(\d+),?(\d+)? @@/.exec(line);
      if (match) {
        const origStart = parseInt(match[1]!, 10) - 1; // 0-indexed
        
        const hunkLines: { type: "space" | "minus" | "plus"; text: string }[] = [];
        i++;
        while (i < diffLines.length && !diffLines[i]!.startsWith("@@ ") && !diffLines[i]!.startsWith("diff ") && !diffLines[i]!.startsWith("--- ") && !diffLines[i]!.startsWith("+++ ")) {
          const hunkLine = diffLines[i]!;
          if (hunkLine.startsWith(" ")) {
            hunkLines.push({ type: "space", text: hunkLine.slice(1) });
          } else if (hunkLine.startsWith("-")) {
            hunkLines.push({ type: "minus", text: hunkLine.slice(1) });
          } else if (hunkLine.startsWith("+")) {
            hunkLines.push({ type: "plus", text: hunkLine.slice(1) });
          } else if (hunkLine === "") {
            hunkLines.push({ type: "space", text: "" });
          }
          i++;
        }
        i--;

        let foundIndex = -1;
        for (const offset of [0, 1, -1, 2, -2, 3, -3, 4, -4, 5, -5, 6, -6, 7, -7, 8, -8, 9, -9, 10, -10]) {
          const checkIdx = origStart + offset;
          if (checkIdx < 0 || checkIdx >= resultLines.length) continue;
          
          let matches = true;
          let rIdx = checkIdx;
          for (const hunkLine of hunkLines) {
            if (hunkLine.type === "space" || hunkLine.type === "minus") {
              if (rIdx >= resultLines.length || resultLines[rIdx] !== hunkLine.text) {
                matches = false;
                break;
              }
              rIdx++;
            }
          }
          if (matches) {
            foundIndex = checkIdx;
            break;
          }
        }

        if (foundIndex === -1) {
          throw new Error("Could not find matching context for diff hunk.");
        }

        const replacement: string[] = [];
        let deleteCount = 0;
        for (const hunkLine of hunkLines) {
          if (hunkLine.type === "space") {
            replacement.push(hunkLine.text);
            deleteCount++;
          } else if (hunkLine.type === "minus") {
            deleteCount++;
          } else if (hunkLine.type === "plus") {
            replacement.push(hunkLine.text);
          }
        }

        resultLines.splice(foundIndex, deleteCount, ...replacement);
      }
    }
    i++;
  }

  return resultLines.join("\n");
}

export class SkillRegistry {
  readonly #skills = new Map<string, Skill>();

  constructor(skills: readonly Skill[]) {
    for (const skill of skills) {
      const cloned = structuredClone(skill);
      cloned.version = getSkillHash(cloned);
      this.#skills.set(cloned.id, cloned);
    }
  }

  static async load(projectRootPath: string, skills: readonly Skill[] = defaultSkills): Promise<SkillRegistry> {
    const registry = new SkillRegistry(skills);
    const skillsDir = join(projectRootPath, ".thorax", "skills");
    try {
      const entries = await readdir(skillsDir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isFile() && entry.name.endsWith(".json")) {
          try {
            const content = await readFile(join(skillsDir, entry.name), "utf8");
            const parsed = skillSchema.parse(JSON.parse(content));
            parsed.version = getSkillHash(parsed);
            registry.#skills.set(parsed.id, parsed);
          } catch (error) {
            console.error(`Failed to load project skill from ${entry.name}:`, error);
          }
        } else if (entry.isFile() && entry.name.endsWith(".md")) {
          try {
            const content = await readFile(join(skillsDir, entry.name), "utf8");
            const parsed = skillSchema.parse(parseSkillMarkdown(content));
            parsed.version = getSkillHash(parsed);
            registry.#skills.set(parsed.id, parsed);
          } catch (error) {
            console.error(`Failed to load project skill from ${entry.name}:`, error);
          }
        } else if (entry.isDirectory()) {
          const skillMdPath = join(skillsDir, entry.name, "SKILL.md");
          try {
            const content = await readFile(skillMdPath, "utf8");
            const parsed = skillSchema.parse(parseSkillMarkdown(content));
            parsed.version = getSkillHash(parsed);
            registry.#skills.set(parsed.id, parsed);
          } catch (error) {
            if (typeof error === "object" && error !== null && "code" in error && error.code !== "ENOENT") {
              console.error(`Failed to load project skill from ${skillMdPath}:`, error);
            }
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
