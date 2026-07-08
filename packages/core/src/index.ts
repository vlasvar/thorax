import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { AgentDefinition } from "@thorax/shared-types";
import type { MemoryEvidence, MemoryInput } from "@thorax/memory-engine";

export const defaultAgents: readonly AgentDefinition[] = [
  { id: "thorax-core", name: "Thorax Core", instructions: "Coordinate work, preserve context, and delegate to the most suitable specialist.", projectAccess: [], skills: ["coordination"] },
  { id: "research", name: "Research", instructions: "Investigate carefully, cite evidence, distinguish facts from inference, and return concise findings.", projectAccess: [], skills: ["research"] },
  { id: "operator", name: "Operator", instructions: "Execute actions safely in any domain — code, spreadsheets, or external systems — test first, verify results, and preserve unrelated state.", projectAccess: [], skills: ["operation"] },
  { id: "reviewer", name: "Reviewer", instructions: "Review independently for correctness, security, maintainability, and requirement coverage.", projectAccess: [], skills: ["reviewer"] },
  { id: "memory-curator", name: "Memory Curator", instructions: "Extract reusable lessons with evidence and send durable changes through review.", projectAccess: [], skills: ["memory-curation"] },
] as const;

export { defaultSkills, SkillRegistry, parseSkillMarkdown, stringifySkillMarkdown, applyPatch, getSkillHash } from "./skills.js";
export { AdapterRegistry } from "./adapters.js";
export { DispatchRegistry, FakeAdapter, ApprovalRequiredError, UnknownActionError, UnknownAdapterError, type AdapterPort, type DispatchRequest, type FakeAdapterCall, type FakeAdapterOptions } from "./dispatch.js";

export class AgentRegistry {
  readonly #agents: Map<string, AgentDefinition>;

  constructor(agents: readonly AgentDefinition[]) {
    this.#agents = new Map(agents.map((agent) => [agent.id, structuredClone(agent)]));
    if (this.#agents.size !== agents.length) throw new Error("Agent ids must be unique.");
  }

  list(): AgentDefinition[] { return [...this.#agents.values()].map((agent) => structuredClone(agent)); }

  requireAccess(agentId: string, projectId: string): AgentDefinition {
    const agent = this.#agents.get(agentId);
    if (!agent) throw new Error(`Unknown agent: ${agentId}`);
    if (!agent.projectAccess.includes(projectId)) throw new Error(`Agent ${agentId} does not have access to project ${projectId}.`);
    return structuredClone(agent);
  }
}

export type LearningScope = "ephemeral" | "project" | "agent" | "personal" | "instruction-suggestion";
export interface LearningCandidate {
  content: string;
  scope: LearningScope;
  agentId?: string;
  projectId?: string;
  evidence: MemoryEvidence;
}
export interface LearningResult {
  status: "staged" | "pending";
  memoryId?: string;
  scope: LearningScope;
}
export interface MemoryStager {
  stage(input: MemoryInput): Promise<{ id: string; status: string }>;
}

export class LearningPipeline {
  constructor(private readonly memory: MemoryStager) {}

  async ingest(candidates: readonly LearningCandidate[]): Promise<LearningResult[]> {
    const results: LearningResult[] = [];
    for (const candidate of candidates) {
      const content = requireText(candidate.content, "Learning content");
      if (candidate.scope === "ephemeral") {
        results.push({ scope: candidate.scope, status: "staged" });
        continue;
      }
      const input = toMemoryInput({ ...candidate, content });
      const record = await this.memory.stage(input);
      if (record.status !== "pending") throw new Error("Durable learning must enter pending review.");
      results.push({ scope: candidate.scope, status: "pending", memoryId: record.id });
    }
    return results;
  }
}

export function extractLearning(
  text: string,
  context: { conversationId: string; agentId: string; projectId: string; turnId?: string },
): { visibleText: string; candidates: LearningCandidate[] } {
  const candidates: LearningCandidate[] = [];
  const visibleText = text.replace(
    /<thorax-memory\s+scope=["'](project|agent|personal|instruction)["']\s*>([\s\S]*?)<\/thorax-memory>/gi,
    (_match, rawScope: string, rawContent: string) => {
      const content = rawContent.trim();
      if (!content) return "";
      const scope = rawScope.toLowerCase();
      const evidence: MemoryEvidence = {
        conversationId: context.conversationId,
        excerpt: content,
        ...(context.turnId ? { turnId: context.turnId } : {}),
      };
      if (scope === "project") candidates.push({ content, scope: "project", projectId: context.projectId, evidence });
      else if (scope === "agent") candidates.push({ content, scope: "agent", agentId: context.agentId, evidence });
      else if (scope === "personal") candidates.push({ content, scope: "personal", evidence });
      else candidates.push({ content, scope: "instruction-suggestion", agentId: context.agentId, evidence });
      return "";
    },
  ).replace(/\n{3,}/g, "\n\n").trim();
  return { visibleText, candidates };
}

export interface CompletedSession {
  id: string;
  agentId: string;
  projectId: string;
  transcript: string;
}
export interface Reflector {
  reflect(session: CompletedSession): Promise<LearningCandidate[]>;
}

export class ReflectionScheduler {
  readonly #processed = new Set<string>();

  private constructor(
    readonly statePath: string,
    private readonly reflector: Reflector,
    private readonly pipeline: LearningPipeline,
  ) {}

  static async open(statePath: string, reflector: Reflector, pipeline: LearningPipeline): Promise<ReflectionScheduler> {
    const scheduler = new ReflectionScheduler(statePath, reflector, pipeline);
    try {
      const parsed = JSON.parse(await readFile(statePath, "utf8")) as unknown;
      if (!Array.isArray(parsed) || parsed.some((id) => typeof id !== "string")) throw new Error("Reflection state must be a string array.");
      for (const id of parsed) scheduler.#processed.add(id);
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
    return scheduler;
  }

  async reflect(session: CompletedSession): Promise<{ processed: boolean; candidates: number }> {
    const id = requireText(session.id, "Session id");
    if (this.#processed.has(id)) return { processed: false, candidates: 0 };
    const candidates = await this.reflector.reflect(session);
    await this.pipeline.ingest(candidates);
    this.#processed.add(id);
    await atomicJsonWrite(this.statePath, [...this.#processed]);
    return { processed: true, candidates: candidates.length };
  }
}

function toMemoryInput(candidate: LearningCandidate): MemoryInput {
  if (candidate.scope === "personal") return { content: candidate.content, scope: "personal", evidence: [candidate.evidence] };
  if (candidate.scope === "project") return { content: candidate.content, scope: "project", projectId: requireText(candidate.projectId, "Project id"), evidence: [candidate.evidence] };
  if (candidate.scope === "agent") return { content: candidate.content, scope: "agent", agentId: requireText(candidate.agentId, "Agent id"), evidence: [candidate.evidence] };
  if (candidate.scope === "instruction-suggestion") {
    const target = requireText(candidate.agentId, "Instruction target agent id");
    return {
      content: `[Instruction suggestion for ${target}] ${candidate.content}`,
      scope: "agent",
      agentId: "memory-curator",
      evidence: [candidate.evidence],
    };
  }
  throw new Error(`Unsupported durable learning scope: ${candidate.scope}`);
}

export interface StoredMessage {
  id: string;
  author: "operator" | string;
  content: string;
  createdAt: string;
}

export interface StoredConversation {
  id: string;
  agentId: string;
  projectId: string;
  codexThreadId?: string;
  messages: StoredMessage[];
  updatedAt: string;
}

export class ConversationStore {
  readonly #conversations = new Map<string, StoredConversation>();

  private constructor(readonly path: string) {}

  static async open(path: string): Promise<ConversationStore> {
    const store = new ConversationStore(path);
    try {
      const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
      if (!Array.isArray(parsed)) throw new Error("Conversation store must contain an array.");
      for (const value of parsed) {
        const conversation = validateConversation(value);
        store.#conversations.set(conversation.id, conversation);
      }
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
    return store;
  }

  list(): StoredConversation[] { return [...this.#conversations.values()].map((value) => structuredClone(value)); }

  async getOrCreate(agentId: string, projectId: string): Promise<StoredConversation> {
    const existing = this.list().find((item) => item.agentId === agentId && item.projectId === projectId);
    if (existing) return existing;
    const now = new Date().toISOString();
    const created: StoredConversation = { id: randomUUID(), agentId, projectId, messages: [], updatedAt: now };
    this.#conversations.set(created.id, created);
    await this.#save();
    return structuredClone(created);
  }

  require(id: string): StoredConversation {
    const value = this.#conversations.get(id);
    if (!value) throw new Error(`Unknown conversation: ${id}`);
    return structuredClone(value);
  }

  async bindThread(id: string, codexThreadId: string): Promise<StoredConversation> {
    const value = this.#requireMutable(id);
    value.codexThreadId = requireText(codexThreadId, "Codex thread id");
    value.updatedAt = new Date().toISOString();
    await this.#save();
    return structuredClone(value);
  }

  async append(id: string, input: { author: string; content: string; id?: string }): Promise<StoredMessage> {
    const value = this.#requireMutable(id);
    const message: StoredMessage = {
      id: input.id ?? randomUUID(),
      author: requireText(input.author, "Message author"),
      content: requireText(input.content, "Message content"),
      createdAt: new Date().toISOString(),
    };
    value.messages.push(message);
    value.updatedAt = message.createdAt;
    await this.#save();
    return structuredClone(message);
  }

  #requireMutable(id: string): StoredConversation {
    const value = this.#conversations.get(id);
    if (!value) throw new Error(`Unknown conversation: ${id}`);
    return value;
  }

  async #save(): Promise<void> {
    await atomicJsonWrite(this.path, this.list());
  }
}

function validateConversation(value: unknown): StoredConversation {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid conversation record.");
  const item = value as Partial<StoredConversation>;
  if (!Array.isArray(item.messages)) throw new Error("Invalid conversation messages.");
  return {
    id: requireText(item.id, "Conversation id"),
    agentId: requireText(item.agentId, "Agent id"),
    projectId: requireText(item.projectId, "Project id"),
    ...(item.codexThreadId ? { codexThreadId: requireText(item.codexThreadId, "Codex thread id") } : {}),
    messages: item.messages.map((message) => {
      if (!message || typeof message !== "object") throw new Error("Invalid message record.");
      const record = message as Partial<StoredMessage>;
      return { id: requireText(record.id, "Message id"), author: requireText(record.author, "Message author"), content: requireText(record.content, "Message content"), createdAt: requireText(record.createdAt, "Message timestamp") };
    }),
    updatedAt: requireText(item.updatedAt, "Conversation timestamp"),
  };
}

function requireText(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} is required.`);
  return value.trim();
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

async function atomicJsonWrite(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temp, path);
}
