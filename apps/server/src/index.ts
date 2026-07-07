import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { once } from "node:events";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { CodexEvent, CodexHealth, RunTurnOptions } from "@thorax/codex-bridge";
import { AgentRegistry, ConversationStore, LearningPipeline, SkillRegistry, defaultAgents, extractLearning, type StoredConversation, type StoredMessage } from "@thorax/core";
import { MemoryEngine } from "@thorax/memory-engine";
import { conversationMessageSchema, conversationSummarySchema, operatorSnapshotSchema, type ProjectDefinition, type Skill } from "@thorax/shared-types";

export interface RuntimePort {
  health(): Promise<CodexHealth>;
  runTurn(options: RunTurnOptions): AsyncIterable<CodexEvent>;
}

export interface ThoraxServiceOptions {
  dataDirectory: string;
  runtime: RuntimePort;
  project: ProjectDefinition;
}
export interface LogEntry { level: "info" | "warn" | "error"; event: string; status?: number; method?: string; path?: string; message?: string; timestamp: string }
export interface Logger { write(entry: LogEntry): void }

export class ThoraxService {
  readonly #registry: AgentRegistry;
  readonly #skills: SkillRegistry;
  readonly #learning: LearningPipeline;
  readonly #locks = new Map<string, Promise<unknown>>();
  readonly #healthCacheTtlMs = 10_000;
  #cachedHealth: { value: CodexHealth; expiresAt: number } | undefined;

  private constructor(
    readonly dataDirectory: string,
    readonly project: ProjectDefinition,
    private readonly runtime: RuntimePort,
    private readonly conversations: ConversationStore,
    private readonly memory: MemoryEngine,
    skills: SkillRegistry,
  ) {
    this.#registry = new AgentRegistry(defaultAgents.map((agent) => ({ ...agent, projectAccess: [project.id] })));
    this.#skills = skills;
    this.#learning = new LearningPipeline(memory);
  }

  static async open(options: ThoraxServiceOptions): Promise<ThoraxService> {
    try {
      const projectStat = await stat(options.project.rootPath);
      if (!projectStat.isDirectory()) throw new Error();
    } catch {
      throw new InputError(`Project root is missing or is not a directory: ${options.project.rootPath}`);
    }
    const conversations = await ConversationStore.open(join(options.dataDirectory, "conversations.json"));
    const memory = await MemoryEngine.open({ dataDirectory: join(options.dataDirectory, "memory") });
    const skills = await SkillRegistry.load(options.project.rootPath);
    return new ThoraxService(options.dataDirectory, options.project, options.runtime, conversations, memory, skills);
  }

  close(): void { this.memory.close(); }

  async snapshot() {
    const health = await this.#health();
    const agents = this.#registry.list();
    const activeAgentId = agents[0]?.id;
    if (!activeAgentId) throw new Error("Thorax has no configured agents.");
    const conversation = await this.conversations.getOrCreate(activeAgentId, this.project.id);
    const pending = await this.memory.pendingReview();
    return operatorSnapshotSchema.parse({
      activeAgentId,
      activeProjectId: this.project.id,
      agents: agents.map((agent) => {
        const resolvedSkills = (agent.skills ?? [])
          .map((id) => this.#skills.get(id))
          .filter((s): s is Skill => !!s);
        return {
          id: agent.id,
          name: agent.name,
          role: agent.instructions.split(".")[0] ?? agent.name,
          state: health.status === "ready" ? "ready" : "offline",
          skills: resolvedSkills,
        };
      }),
      projects: [this.project],
      conversation: publicConversation(conversation),
      memoryCandidates: pending.map((record) => ({ id: record.id, content: record.content, scope: record.scope, source: record.evidence[0]?.conversationId ?? "unknown", createdAt: record.createdAt })),
      learningEvents: [],
      runtime: runtimeSummary(health, this.conversations.list().filter((item) => item.codexThreadId).length),
    });
  }

  async activeConversation(agentId: string, projectId: string) {
    this.#registry.requireAccess(agentId, projectId);
    if (projectId !== this.project.id) throw new InputError("Unknown project.");
    return conversationSummarySchema.parse(publicConversation(await this.conversations.getOrCreate(agentId, projectId)));
  }

  async reviewMemory(id: string, decision: "approve" | "reject"): Promise<void> {
    if (decision === "approve") await this.memory.approve(id, { reviewer: "operator", rationale: "Approved in Thorax review queue" });
    else await this.memory.reject(id, { reviewer: "operator", rationale: "Rejected in Thorax review queue" });
  }

  async sendMessage(conversationId: string, agentId: string, projectId: string, content: string): Promise<StoredMessage> {
    const previous = this.#locks.get(conversationId) ?? Promise.resolve();
    const next = previous.then(() => this.#sendMessage(conversationId, agentId, projectId, content));
    this.#locks.set(conversationId, next);
    try { return await next; } finally { if (this.#locks.get(conversationId) === next) this.#locks.delete(conversationId); }
  }

  async #sendMessage(conversationId: string, agentId: string, projectId: string, content: string): Promise<StoredMessage> {
    const agent = this.#registry.requireAccess(agentId, projectId);
    const conversation = this.conversations.require(conversationId);
    if (conversation.agentId !== agentId || conversation.projectId !== projectId) throw new InputError("Conversation binding does not match the selected agent and project.");
    const cleanContent = requireText(content, "Message content");
    await this.conversations.append(conversationId, { author: "operator", content: cleanContent });
    const memories = await this.memory.retrieve({ agentId, projectId });
    const memoryText = memories.map((record) => `- ${record.content}`).join("\n") || "- No durable memory yet.";

    const activeSkills = (agent.skills ?? [])
      .map((id) => this.#skills.get(id))
      .filter((s): s is Skill => !!s);

    let skillsSection = "";
    if (activeSkills.length > 0) {
      skillsSection = "\n\nActive Capabilities:\n" + activeSkills.map((skill) => {
        const rulesStr = skill.rules.map((r) => `- ${r}`).join("\n");
        return `### Skill: ${skill.name} (${skill.id})\n${skill.systemPrompt}\nGuidelines:\n${rulesStr}`;
      }).join("\n\n");
    }

    let teamSection = "";
    if (agent.id === "thorax-core") {
      const otherAgents = this.#registry.list().filter((a) => a.id !== "thorax-core");
      teamSection = "\n\nAvailable specialist agents in this workspace:\n" + otherAgents.map((a) => {
        const skillsList = (a.skills ?? [])
          .map((sid) => this.#skills.get(sid)?.name ?? sid)
          .join(", ");
        return `- Agent: ${a.name} (${a.id}) - Role: ${a.instructions.split(".")[0]} - Skills: [${skillsList}]`;
      }).join("\n");
    }

    const prompt = `${agent.instructions}${skillsSection}${teamSection}\n\nProject: ${this.project.name}\nProject root: ${this.project.rootPath}\n\nRelevant memory (project overrides agent overrides personal):\n${memoryText}\n\nWhen you discover a reusable lesson, append exactly one private marker per lesson: <thorax-memory scope="project|agent|personal|instruction">lesson</thorax-memory>. Do not mention these markers in normal prose. Durable markers are review candidates and never apply automatically.\n\nOperator request:\n${cleanContent}`;
    let threadId = conversation.codexThreadId;
    let turnId: string | undefined;
    let response = "";
    let completed = false;
    for await (const event of this.runtime.runTurn({ prompt, cwd: this.project.rootPath, ...(threadId ? { threadId } : {}) })) {
      if (event.type === "thread.started" || event.type === "thread.resumed") {
        threadId = event.threadId;
        if (conversation.codexThreadId !== threadId) await this.conversations.bindThread(conversationId, threadId);
      } else if (event.type === "message.delta") response += event.delta;
      else if (event.type === "turn.started") turnId = event.turnId;
      else if (event.type === "turn.completed") {
        if (event.status === "failed") throw new Error("Codex turn failed.");
        completed = true;
      }
    }
    if (!completed) throw new Error("Codex turn ended without a completion event.");
    const extracted = extractLearning(response, { conversationId, agentId, projectId, ...(turnId ? { turnId } : {}) });
    await this.#learning.ingest(extracted.candidates);
    return conversationMessageSchema.parse(await this.conversations.append(conversationId, { author: agentId, content: extracted.visibleText || "Codex completed without a text response." }));
  }

  async #health(): Promise<CodexHealth> {
    const now = Date.now();
    if (this.#cachedHealth && this.#cachedHealth.expiresAt > now) return this.#cachedHealth.value;
    const value = await this.runtime.health();
    this.#cachedHealth = { value, expiresAt: now + this.#healthCacheTtlMs };
    return value;
  }
}

export async function startThoraxServer(service: ThoraxService, options: { host: "127.0.0.1"; port: number; logger?: Logger }) {
  if (options.host !== "127.0.0.1") throw new Error("Thorax V1 may only bind to 127.0.0.1.");
  const logger = options.logger ?? consoleLogger;
  const server = createServer((request, response) => { void route(service, request, response, logger); });
  server.listen(options.port, options.host);
  await once(server, "listening");
  const address = server.address() as AddressInfo;
  return {
    url: `http://${address.address}:${address.port}`,
    close: async () => { server.close(); await once(server, "close"); },
  };
}

async function route(service: ThoraxService, request: IncomingMessage, response: ServerResponse, logger: Logger): Promise<void> {
  try {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (request.method === "GET" && url.pathname === "/api/operator/snapshot") return json(response, 200, await service.snapshot());
    if (request.method === "GET" && url.pathname === "/api/conversations/active") {
      return json(response, 200, await service.activeConversation(requireText(url.searchParams.get("agentId"), "Agent id"), requireText(url.searchParams.get("projectId"), "Project id")));
    }
    const messageMatch = /^\/api\/conversations\/([^/]+)\/messages$/.exec(url.pathname);
    if (request.method === "POST" && messageMatch) {
      const body = await readJson(request);
      return json(response, 200, await service.sendMessage(decodeURIComponent(messageMatch[1]!), readText(body, "agentId"), readText(body, "projectId"), readText(body, "content")));
    }
    const reviewMatch = /^\/api\/memory\/candidates\/([^/]+)\/review$/.exec(url.pathname);
    if (request.method === "POST" && reviewMatch) {
      const body = await readJson(request);
      const decision = readText(body, "decision");
      if (decision !== "approve" && decision !== "reject") throw new InputError("Decision must be approve or reject.");
      await service.reviewMemory(decodeURIComponent(reviewMatch[1]!), decision);
      response.writeHead(204).end(); return;
    }
    json(response, 404, { error: "Not found" });
  } catch (error) {
    const status = error instanceof InputError ? 400 : 500;
    const message = error instanceof Error ? error.message : "Unknown error";
    logger.write({
      level: status < 500 ? "warn" : "error", event: "http.request.failed", status, message,
      ...(request.method ? { method: request.method } : {}),
      ...(request.url ? { path: request.url } : {}),
      timestamp: new Date().toISOString(),
    });
    json(response, status, { error: message });
  }
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk);
    size += buffer.length;
    if (size > 64 * 1024) throw new InputError("Request body is too large.");
    chunks.push(buffer);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    return value as Record<string, unknown>;
  } catch { throw new InputError("Request body must be a JSON object."); }
}

function json(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(JSON.stringify(value));
}
function readText(record: Record<string, unknown>, key: string): string { return requireText(record[key], key); }
function requireText(value: unknown, name: string): string { if (typeof value !== "string" || !value.trim()) throw new InputError(`${name} is required.`); return value.trim(); }
function publicConversation(value: StoredConversation) { return { id: value.id, messages: value.messages }; }
function runtimeSummary(health: CodexHealth, activeSessions: number) {
  if (health.status === "ready") return { state: "healthy", codex: "signed-in", activeSessions, version: health.version };
  const codex = health.status === "missing" ? "missing" : health.status === "signed_out" ? "signed-out" : health.status === "auth_expired" ? "auth-expired" : "unavailable";
  return { state: health.status === "error" ? "degraded" : "offline", codex, activeSessions, version: "unknown" };
}
class InputError extends Error {}
const consoleLogger: Logger = { write: (entry) => console.error(JSON.stringify(entry)) };
