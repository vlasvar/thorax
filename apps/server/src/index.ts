import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { once } from "node:events";
import { readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import type { CodexEvent, CodexHealth, RunTurnOptions } from "@thorax/codex-bridge";
import { AgentRegistry, ConversationStore, LearningPipeline, SkillRegistry, AdapterRegistry, DispatchRegistry, ApprovalRequiredError, UnknownActionError, UnknownAdapterError, defaultAgents, extractLearning, parseSkillMarkdown, stringifySkillMarkdown, applyPatch, getSkillHash, type StoredConversation, type StoredMessage, type AdapterPort } from "@thorax/core";
import { MemoryEngine } from "@thorax/memory-engine";
import { adapterExecuteRequestSchema, conversationMessageSchema, conversationSummarySchema, operatorSnapshotSchema, workflowDefinitionSchema, workflowExecutionSchema, type AdapterCommitResult, type AdapterDryRunResult, type ProjectDefinition, type Skill, type WorkflowExecution, type SkillRun, type SkillEdit, type WorkflowDefinition } from "@thorax/shared-types";
import { ExcelAdapter } from "@thorax/excel-adapter";
import { ExecutionStateStore, WorkflowEngine, SkillOptimizationStore } from "@thorax/workflow-engine";

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

const SKILLS_ADAPTER_MANIFEST = {
  adapter: "skills",
  version: "1.0.0",
  description: "Thorax Skill Self-Optimization Adapter",
  auth: { type: "none" as const },
  actions: [
    {
      name: "optimize_skill",
      risk_tier: "write_irreversible" as const,
      description: "Runs reflection and proposes/applies skill edits",
      input_schema: {},
      output_schema: {},
      dry_run_supported: true
    }
  ]
};

class SkillsAdapter implements AdapterPort {
  constructor(
    private readonly service: ThoraxService,
    private readonly store: SkillOptimizationStore
  ) {}

  async dryRun(action: string, input: Record<string, unknown>): Promise<AdapterDryRunResult> {
    if (action !== "optimize_skill") {
      throw new Error(`Unknown action: ${action}`);
    }
    const skillId = String(input.skillId);

    const skill = this.service.getSkillRegistry().get(skillId);
    if (!skill) {
      throw new Error(`Skill '${skillId}' not found in registry.`);
    }

    const currentMarkdown = stringifySkillMarkdown(skill);
    const currentVersion = skill.version || getSkillHash(skill);

    const runs = this.store.listRunsForSkill(skillId, 20);
    const successes = runs.filter(r => r.outcome === "success");
    const failures = runs.filter(r => r.outcome === "failure");

    const edits = this.store.listEditsForSkill(skillId);
    const rejectedEdits = edits.filter(e => e.status === "rejected");

    const prompt = this.formatOptimizationPrompt(
      currentMarkdown,
      failures,
      successes,
      rejectedEdits
    );

    const llmOutput = await this.service.executeLLM(prompt);

    const { diagnosis, diff, risk, confidence } = parseOptimizerOutput(llmOutput);
    if (!diff) {
      throw new Error("Optimizer did not propose any diff.");
    }

    let proposedMarkdown: string;
    try {
      proposedMarkdown = applyPatch(currentMarkdown, diff);
    } catch (err: any) {
      throw new Error(`Failed to apply proposed diff: ${err.message}`);
    }

    const proposedSkill = parseSkillMarkdown(proposedMarkdown);
    proposedSkill.id = skillId;

    const validationCases = await this.service.loadValidationCases(skillId);

    const scoreBefore = await this.service.runValidation(skill, validationCases);
    const scoreAfter = await this.service.runValidation(proposedSkill, validationCases);

    const editId = randomUUID();

    if (scoreAfter <= scoreBefore + 0.049) {
      const reason = `No improvement on validation set (Before: ${(scoreBefore * 100).toFixed(1)}%, After: ${(scoreAfter * 100).toFixed(1)}%)`;
      const rejectedEdit: SkillEdit = {
        id: editId,
        skillName: skillId,
        baseVersion: currentVersion,
        proposedDiff: diff,
        rationale: diagnosis,
        validationScoreBefore: scoreBefore,
        validationScoreAfter: scoreAfter,
        status: "rejected",
        rejectionReason: reason
      };
      this.store.saveEdit(rejectedEdit);
      throw new Error(`Validation gating failed: ${reason}`);
    }

    const proposedEdit: SkillEdit = {
      id: editId,
      skillName: skillId,
      baseVersion: currentVersion,
      proposedDiff: diff,
      rationale: diagnosis,
      validationScoreBefore: scoreBefore,
      validationScoreAfter: scoreAfter,
      status: "proposed",
      rejectionReason: null
    };
    this.store.saveEdit(proposedEdit);

    return {
      mode: "dry_run",
      diff_preview: `DIAGNOSIS: ${diagnosis}\n\nRISK: ${risk}\n\nCONFIDENCE: ${confidence}\n\nVALIDATION SCORE:\nBefore: ${(scoreBefore * 100).toFixed(1)}%\nAfter: ${(scoreAfter * 100).toFixed(1)}%`,
      would_affect: [
        `skill:${skillId}`,
        `edit:${editId}`,
        `diagnosis:${diagnosis}`,
        `scoreBefore:${scoreBefore}`,
        `scoreAfter:${scoreAfter}`,
        `diff:${diff}`
      ],
      reversible: true
    };
  }

  async commit(action: string, input: Record<string, unknown>): Promise<AdapterCommitResult> {
    if (action !== "optimize_skill") {
      throw new Error(`Unknown action: ${action}`);
    }
    const skillId = String(input.skillId);
    const edits = this.store.listEditsForSkill(skillId);
    const proposedEdit = edits.find(e => e.status === "proposed");
    if (!proposedEdit) {
      throw new Error(`No pending proposed edit found for skill '${skillId}'.`);
    }

    const skill = this.service.getSkillRegistry().get(skillId);
    if (!skill) {
      throw new Error(`Skill '${skillId}' not found.`);
    }

    const currentMarkdown = stringifySkillMarkdown(skill);
    const patchedMarkdown = applyPatch(currentMarkdown, proposedEdit.proposedDiff);

    const skillFileDir = join(this.service.project.rootPath, ".thorax", "skills", skillId);
    const skillFilePath = join(skillFileDir, "SKILL.md");
    
    const { mkdirSync } = await import("node:fs");
    mkdirSync(skillFileDir, { recursive: true });
    
    await writeFile(skillFilePath, patchedMarkdown, "utf8");

    await this.service.reloadSkills();

    this.store.updateEditStatus(proposedEdit.id, "accepted");

    return {
      mode: "commit",
      result: {
        status: "promoted",
        skillId,
        editId: proposedEdit.id,
        version: proposedEdit.validationScoreAfter
      },
      transaction_id: `txn-skill-opt-${proposedEdit.id}`
    };
  }

  private formatOptimizationPrompt(
    currentSkillMd: string,
    failures: SkillRun[],
    successes: SkillRun[],
    rejectedEdits: SkillEdit[]
  ): string {
    const failuresText = failures.map((f, idx) => {
      return `Failure #${idx + 1}:\nInput: ${f.inputSummary}\nOutput produced: ${f.output}\nCorrection notes: ${f.correctionNotes || "None"}`;
    }).join("\n\n") || "No failures recorded.";

    const successesText = successes.map((s, idx) => {
      return `Success #${idx + 1}: Task summary: ${s.inputSummary}`;
    }).join("\n") || "No successes recorded.";

    const rejectedEditsText = rejectedEdits.map((e, idx) => {
      return `Rejected Edit #${idx + 1}:\nProposed Diff:\n${e.proposedDiff}\nRejection Reason: ${e.rejectionReason || "None"}`;
    }).join("\n\n") || "No previously rejected edits.";

    return `You are optimizing a skill file for an autonomous agent. The skill file is below. You will see recent successful and failed runs of an agent using this skill, plus a list of edits that were already tried and rejected — do not repeat these.

Your job: propose a SMALL, targeted edit (diff format) that would have fixed the failures without breaking the successes. Do not rewrite the whole file. If you cannot identify a specific, low-risk fix, say so explicitly rather than proposing a speculative change.
No more than 5 changed lines per edit is allowed.

CURRENT SKILL FILE:
${currentSkillMd}

RECENT FAILURES (${failures.length} runs):
${failuresText}

RECENT SUCCESSES (${successes.length} runs, for context — do not break these):
${successesText}

PREVIOUSLY REJECTED EDITS (do not repeat):
${rejectedEditsText}

Output format:
1. DIAGNOSIS: one paragraph, what pattern in the failures you're addressing
2. DIFF: unified diff against the current skill file
3. RISK: what this edit could break, if anything
4. CONFIDENCE: low / medium / high`;
  }
}

function evaluateValidationCase(output: string, expected: unknown): boolean {
  if (typeof expected === "string") {
    return output.toLowerCase().includes(expected.toLowerCase());
  }
  if (typeof expected === "object" && expected !== null) {
    try {
      const jsonStart = output.indexOf("{");
      const jsonEnd = output.lastIndexOf("}");
      if (jsonStart === -1 || jsonEnd === -1) return false;
      const jsonStr = output.slice(jsonStart, jsonEnd + 1);
      const parsed = JSON.parse(jsonStr);
      for (const [key, val] of Object.entries(expected)) {
        if (String(parsed[key]).toLowerCase() !== String(val).toLowerCase()) {
          return false;
        }
      }
      return true;
    } catch {
      return false;
    }
  }
  return false;
}

function parseOptimizerOutput(output: string): { diagnosis: string; diff: string; risk: string; confidence: string } {
  const diagnosisMatch = /1\.\s*DIAGNOSIS:\s*([\s\S]*?)(?=2\.\s*DIFF:|$)/i.exec(output);
  const diffMatch = /2\.\s*DIFF:\s*([\s\S]*?)(?=3\.\s*RISK:|$)/i.exec(output);
  const riskMatch = /3\.\s*RISK:\s*([\s\S]*?)(?=4\.\s*CONFIDENCE:|$)/i.exec(output);
  const confidenceMatch = /4\.\s*CONFIDENCE:\s*([\s\S]*)/i.exec(output);

  const diagnosis = diagnosisMatch ? diagnosisMatch[1]!.trim() : "";
  let diff = diffMatch ? diffMatch[1]!.trim() : "";
  const risk = riskMatch ? riskMatch[1]!.trim() : "";
  const confidence = confidenceMatch ? confidenceMatch[1]!.trim() : "medium";

  if (diff.startsWith("```")) {
    const lines = diff.split("\n");
    if (lines[0]?.startsWith("```")) lines.shift();
    if (lines[lines.length - 1]?.startsWith("```")) lines.pop();
    diff = lines.join("\n").trim();
  }

  return { diagnosis, diff, risk, confidence };
}

export class ThoraxService {
  readonly #registry: AgentRegistry;
  #skills: SkillRegistry;
  readonly #adapters: AdapterRegistry;
  readonly #dispatch: DispatchRegistry;
  readonly #learning: LearningPipeline;
  readonly #stateStore: ExecutionStateStore;
  readonly #skillsStore: SkillOptimizationStore;
  readonly #engine: WorkflowEngine;
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
    adapters: AdapterRegistry,
    stateStore: ExecutionStateStore,
    skillsStore: SkillOptimizationStore,
  ) {
    this.#registry = new AgentRegistry(defaultAgents.map((agent) => ({ ...agent, projectAccess: [project.id] })));
    this.#skills = skills;
    this.#adapters = adapters;
    this.#dispatch = new DispatchRegistry();
    const excelManifest = this.#adapters.get("excel");
    if (excelManifest) {
      this.#dispatch.register(excelManifest, new ExcelAdapter());
    }
    this.#skillsStore = skillsStore;
    this.registerAdapter(SKILLS_ADAPTER_MANIFEST, new SkillsAdapter(this, this.#skillsStore));
    this.#learning = new LearningPipeline(memory);
    this.#stateStore = stateStore;

    const agentRunner = {
      runTurn: async (agentId: string, prompt: string) => {
        const agent = this.#registry.requireAccess(agentId, this.project.id);
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

        const fullPrompt = `${agent.instructions}${skillsSection}\n\nProject: ${this.project.name}\nProject root: ${this.project.rootPath}\n\nTask:\n${prompt}`;
        
        let response = "";
        let completed = false;
        try {
          for await (const event of this.runtime.runTurn({ prompt: fullPrompt, cwd: this.project.rootPath })) {
            if (event.type === "message.delta") response += event.delta;
            else if (event.type === "turn.completed") {
              if (event.status === "failed") throw new Error("Agent workflow turn failed.");
              completed = true;
            }
          }
          if (!completed) throw new Error("Agent workflow turn ended without completion.");
          await this.logSkillRuns(activeSkills, prompt, response);
          return response;
        } catch (error) {
          await this.logSkillRuns(activeSkills, prompt, "", error);
          throw error;
        }
      }
    };

    this.#engine = new WorkflowEngine(this.#stateStore, this.#adapters, this.#dispatch, agentRunner);
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
    const adapters = await AdapterRegistry.load(options.project.rootPath);
    const stateStore = new ExecutionStateStore(options.dataDirectory);
    const skillsStore = new SkillOptimizationStore(options.dataDirectory);
    return new ThoraxService(options.dataDirectory, options.project, options.runtime, conversations, memory, skills, adapters, stateStore, skillsStore);
  }

  close(): void {
    this.memory.close();
    this.#stateStore.close();
    this.#skillsStore.close();
  }

  async snapshot() {
    const health = await this.#health();
    const agents = this.#registry.list();
    const activeAgentId = agents[0]?.id;
    if (!activeAgentId) throw new Error("Thorax has no configured agents.");
    const conversation = await this.conversations.getOrCreate(activeAgentId, this.project.id);
    const pending = await this.memory.pendingReview();
    const pendingEdits = this.#skillsStore.listAllEdits().filter(e => e.status === "proposed");
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
      pendingSkillEdits: pendingEdits,
    });
  }

  async activeConversation(agentId: string, projectId: string) {
    this.#registry.requireAccess(agentId, projectId);
    if (projectId !== this.project.id) throw new InputError("Unknown project.");
    return conversationSummarySchema.parse(publicConversation(await this.conversations.getOrCreate(agentId, projectId)));
  }

  /** Register a live adapter port so dispatch can route to it. */
  registerAdapter(manifest: import("@thorax/shared-types").AdapterManifest, port: import("@thorax/core").AdapterPort): void {
    this.#adapters.register(manifest);
    this.#dispatch.register(manifest, port);
  }

  async executeAdapterAction(request: import("@thorax/shared-types").AdapterExecuteRequest): Promise<AdapterDryRunResult | AdapterCommitResult> {
    const manifest = this.#adapters.get(request.adapterId);
    if (!manifest) throw new InputError(`No adapter manifest loaded for '${request.adapterId}'.`);
    if (!this.#dispatch.has(request.adapterId)) throw new InputError(`Adapter '${request.adapterId}' has a manifest but no registered port. Is the adapter package loaded?`);
    try {
      return await this.#dispatch.dispatch(request);
    } catch (error) {
      if (error instanceof ApprovalRequiredError || error instanceof UnknownActionError || error instanceof UnknownAdapterError) {
        throw new InputError((error as any).message);
      }
      throw error;
    }
  }

  async triggerWorkflow(definition: import("@thorax/shared-types").WorkflowDefinition, initialContext: Record<string, unknown>) {
    return this.#engine.start(definition, initialContext);
  }

  async resumeWorkflow(executionId: string, definition: import("@thorax/shared-types").WorkflowDefinition, approved: boolean) {
    if (!approved) {
      const exec = this.#stateStore.load(executionId);
      if (exec && exec.context && exec.context.skillId) {
        const edits = this.#skillsStore.listEditsForSkill(String(exec.context.skillId));
        const proposedEdit = edits.find(e => e.status === "proposed");
        if (proposedEdit) {
          this.#skillsStore.updateEditStatus(proposedEdit.id, "rejected", "Rejected by operator");
        }
      }
    }
    return this.#engine.resumeWithDefinition(executionId, definition, approved);
  }

  listWorkflowExecutions() {
    return this.#stateStore.listAll();
  }

  async loadWorkflowDefinition(id: string): Promise<import("@thorax/shared-types").WorkflowDefinition> {
    const file = join(this.project.rootPath, ".thorax", "workflows", `${id}.json`);
    const content = await readFile(file, "utf8");
    return workflowDefinitionSchema.parse(JSON.parse(content));
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
    const messageId = randomUUID();
    try {
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
      await this.logSkillRuns(activeSkills, cleanContent, response, undefined, messageId);
      const extracted = extractLearning(response, { conversationId, agentId, projectId, ...(turnId ? { turnId } : {}) });
      await this.#learning.ingest(extracted.candidates);
      return conversationMessageSchema.parse(await this.conversations.append(conversationId, { id: messageId, author: agentId, content: extracted.visibleText || "Codex completed without a text response." }));
    } catch (error) {
      await this.logSkillRuns(activeSkills, cleanContent, "", error, messageId);
      throw error;
    }
  }

  async logSkillRuns(skills: Skill[], input: string, output: string, error?: any, runIdPrefix?: string): Promise<void> {
    const outcome = error ? "failure" : "success";
    const score = error ? 0.0 : 1.0;
    const inputSummary = input.slice(0, 100);
    for (const skill of skills) {
      const version = skill.version || getSkillHash(skill);
      const id = runIdPrefix
        ? (skills.length === 1 ? runIdPrefix : `${runIdPrefix}-${skill.id}`)
        : randomUUID();
      const run: SkillRun = {
        id,
        skillName: skill.id,
        skillVersion: version,
        timestamp: new Date().toISOString(),
        inputSummary,
        output: error ? (error instanceof Error ? error.message : String(error)) : output,
        outcome,
        score,
        humanOverride: false,
        correctionNotes: null
      };
      this.#skillsStore.saveRun(run);
    }
  }

  async executeLLM(prompt: string): Promise<string> {
    let response = "";
    let completed = false;
    for await (const event of this.runtime.runTurn({ prompt, cwd: this.project.rootPath })) {
      if (event.type === "message.delta") response += event.delta;
      else if (event.type === "turn.completed") {
        if (event.status === "failed") throw new Error("Agent turn failed.");
        completed = true;
      }
    }
    if (!completed) throw new Error("Agent turn ended without completion.");
    return response;
  }

  async loadValidationCases(skillId: string): Promise<{ input: string; expected: unknown }[]> {
    const filePath = join(this.project.rootPath, ".thorax", "validation", `${skillId}.json`);
    try {
      const content = await readFile(filePath, "utf8");
      const parsed = JSON.parse(content);
      if (Array.isArray(parsed.cases)) {
        return parsed.cases;
      }
      return [];
    } catch {
      if (skillId === "sap_lease_entry" || skillId === "coordination") {
        return [
          {
            input: "Tenant: Alice, Rent: $1500, Term: 1 year starting 2026-01-01",
            expected: {
              tenant: "Alice",
              rent: 1500,
              start_date: "2026-01-01",
              end_date: "2026-12-31"
            }
          },
          {
            input: "Tenant: Bob, Rent: $2000, Term: 1 year starting 2026-02-01",
            expected: {
              tenant: "Bob",
              rent: 2000,
              start_date: "2026-02-01",
              end_date: "2027-01-31"
            }
          }
        ];
      }
      return [];
    }
  }

  async runValidation(skill: Skill, cases: { input: string; expected: unknown }[]): Promise<number> {
    if (cases.length === 0) return 1.0;
    let scoreSum = 0;
    for (const c of cases) {
      const rulesStr = skill.rules.map((r) => `- ${r}`).join("\n");
      const systemPrompt = `### Skill: ${skill.name} (${skill.id})\n${skill.systemPrompt}\nGuidelines:\n${rulesStr}`;
      const prompt = `${systemPrompt}\n\nTask:\n${c.input}`;
      try {
        const output = await this.executeLLM(prompt);
        if (evaluateValidationCase(output, c.expected)) {
          scoreSum += 1.0;
        }
      } catch (error) {
        console.error("Validation case run failed:", error);
      }
    }
    return scoreSum / cases.length;
  }

  async reloadSkills(): Promise<void> {
    this.#skills = await SkillRegistry.load(this.project.rootPath);
  }

  getSkillRegistry(): SkillRegistry {
    return this.#skills;
  }

  getSkillsStore(): SkillOptimizationStore {
    return this.#skillsStore;
  }

  async triggerSkillOptimization(skillId: string): Promise<WorkflowExecution> {
    const definition: WorkflowDefinition = {
      id: `optimize-skill-${skillId}-${Date.now()}`,
      version: "1.0.0",
      description: `Optimize skill ${skillId}`,
      trigger: { type: "event", value: "manual" },
      steps: [
        {
          id: "optimize_step",
          type: "action",
          adapter: "skills",
          action: "optimize_skill",
          input: { skillId }
        }
      ]
    };
    return this.triggerWorkflow(definition, { skillId });
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
    if (request.method === "POST" && url.pathname === "/api/adapter/execute") {
      const body = await readJson(request);
      const parseResult = adapterExecuteRequestSchema.safeParse(body);
      if (!parseResult.success) throw new InputError(`Invalid adapter execute request: ${parseResult.error.issues.map((i: any) => i.message).join(", ")}`);
      return json(response, 200, await service.executeAdapterAction(parseResult.data));
    }
    if (request.method === "GET" && url.pathname === "/api/workflows/executions") {
      return json(response, 200, service.listWorkflowExecutions());
    }
    if (request.method === "POST" && url.pathname === "/api/workflows/trigger") {
      const body = await readJson(request);
      const definition = workflowDefinitionSchema.parse(body.definition);
      const context = (body.context as Record<string, unknown>) ?? {};
      return json(response, 200, await service.triggerWorkflow(definition, context));
    }
    const approveMatch = /^\/api\/workflows\/executions\/([^/]+)\/approve$/.exec(url.pathname);
    if (request.method === "POST" && approveMatch) {
      const body = await readJson(request);
      const definition = workflowDefinitionSchema.parse(body.definition);
      return json(response, 200, await service.resumeWorkflow(decodeURIComponent(approveMatch[1]!), definition, true));
    }
    const rejectMatch = /^\/api\/workflows\/executions\/([^/]+)\/reject$/.exec(url.pathname);
    if (request.method === "POST" && rejectMatch) {
      const body = await readJson(request);
      const definition = workflowDefinitionSchema.parse(body.definition);
      return json(response, 200, await service.resumeWorkflow(decodeURIComponent(rejectMatch[1]!), definition, false));
    }
    if (request.method === "GET" && url.pathname === "/api/skills/runs") {
      const skillName = url.searchParams.get("skillName");
      if (skillName) {
        return json(response, 200, service.getSkillsStore().listRunsForSkill(skillName));
      }
      return json(response, 400, { error: "skillName query parameter is required." });
    }
    if (request.method === "POST" && /^\/api\/skills\/runs\/([^/]+)\/feedback$/.test(url.pathname)) {
      const runId = /^\/api\/skills\/runs\/([^/]+)\/feedback$/.exec(url.pathname)![1]!;
      const body = await readJson(request);
      const score = Number(body.score);
      const outcome = String(body.outcome) as any;
      const humanOverride = Boolean(body.humanOverride);
      const correctionNotes = body.correctionNotes ? String(body.correctionNotes) : null;
      
      const store = service.getSkillsStore();
      const run = store.loadRun(runId);
      if (!run) {
        return json(response, 404, { error: `Skill run ${runId} not found.` });
      }
      run.score = score;
      run.outcome = outcome;
      run.humanOverride = humanOverride;
      run.correctionNotes = correctionNotes;
      store.saveRun(run);
      return json(response, 200, run);
    }
    if (request.method === "GET" && url.pathname === "/api/skills/edits") {
      return json(response, 200, service.getSkillsStore().listAllEdits());
    }
    if (request.method === "POST" && url.pathname === "/api/skills/optimize") {
      const body = await readJson(request);
      const skillId = requireText(body.skillId, "skillId");
      const exec = await service.triggerSkillOptimization(skillId);
      return json(response, 200, exec);
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
