import { z } from "zod";

export const agentIdSchema = z.string().regex(/^[a-z][a-z0-9-]*$/);
export const projectIdSchema = z.string().regex(/^[a-z][a-z0-9-]*$/);

export const skillSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]*$/),
  name: z.string().min(1),
  description: z.string().min(1),
  rules: z.array(z.string()),
  systemPrompt: z.string().min(1),
});

export const adapterRiskTierSchema = z.enum([
  "read_only",
  "write_reversible",
  "write_irreversible",
  "external_side_effect",
]);

export const adapterActionSchema = z.object({
  name: z.string().regex(/^[a-z][a-z0-9_]*$/),
  risk_tier: adapterRiskTierSchema,
  description: z.string().min(1),
  input_schema: z.record(z.unknown()),
  output_schema: z.record(z.unknown()),
  dry_run_supported: z.boolean(),
  rollback: z.object({
    supported: z.boolean(),
    method: z.string().min(1),
  }).optional(),
});

export const adapterManifestSchema = z.object({
  adapter: z.string().regex(/^[a-z][a-z0-9-]*$/),
  version: z.string().min(1),
  description: z.string().min(1),
  auth: z.object({
    type: z.enum(["none", "oauth", "service_account", "credentials_file"]),
    config_ref: z.string().optional(),
  }),
  actions: z.array(adapterActionSchema).min(1),
});

export const adapterDryRunResultSchema = z.object({
  mode: z.literal("dry_run"),
  diff_preview: z.string(),
  would_affect: z.array(z.string()),
  reversible: z.boolean(),
});

export const adapterCommitResultSchema = z.object({
  mode: z.literal("commit"),
  result: z.unknown(),
  transaction_id: z.string().min(1),
  rollback_token: z.string().optional(),
});

export const adapterExecuteRequestSchema = z.object({
  adapterId: z.string().regex(/^[a-z][a-z0-9-]*$/),
  action: z.string().regex(/^[a-z][a-z0-9_]*/),
  input: z.record(z.unknown()),
  mode: z.enum(["dry_run", "commit"]),
  approved_by: z.string().optional(),
});

export const workflowTriggerSchema = z.object({
  type: z.enum(["schedule", "event"]),
  value: z.string().min(1),
});

export const workflowStepSchema: z.ZodType<any> = z.lazy(() => z.object({
  id: z.string().regex(/^[a-z][a-z0-9_]*$/),
  type: z.enum(["action", "agent_turn", "loop", "conditional"]),
  adapter: z.string().optional(),
  action: z.string().optional(),
  input: z.record(z.unknown()).optional(),
  output_path: z.string().optional(),
  agent: z.string().optional(),
  prompt: z.string().optional(),
  over: z.string().optional(),
  item_name: z.string().optional(),
  steps: z.array(workflowStepSchema).optional(),
  condition: z.string().optional(),
  then: z.array(workflowStepSchema).optional(),
  otherwise: z.array(workflowStepSchema).optional(),
  retry: z.object({
    max_attempts: z.number().int().positive(),
    backoff_ms: z.number().int().nonnegative(),
  }).optional(),
}));

export const workflowDefinitionSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]*$/),
  version: z.string().min(1),
  description: z.string().min(1),
  trigger: workflowTriggerSchema,
  context_schema: z.record(z.unknown()).optional(),
  steps: z.array(workflowStepSchema).min(1),
});

export const stepExecutionLogSchema = z.object({
  stepId: z.string(),
  status: z.enum(["running", "success", "failed", "suspended"]),
  startedAt: z.string(),
  completedAt: z.string().optional(),
  error: z.string().optional(),
  duration_ms: z.number().optional(),
});

export const workflowExecutionSchema = z.object({
  id: z.string().uuid(),
  workflowId: z.string(),
  status: z.enum(["running", "suspended", "completed", "failed"]),
  currentStepId: z.string().optional(),
  context: z.record(z.unknown()),
  stepLogs: z.array(stepExecutionLogSchema),
  updatedAt: z.string(),
});


export const agentDefinitionSchema = z.object({
  id: agentIdSchema,
  name: z.string().min(1),
  instructions: z.string().min(1),
  projectAccess: z.array(projectIdSchema),
  memoryDirectory: z.string().min(1).optional(),
  skills: z.array(z.string()).optional(),
});

export const projectDefinitionSchema = z.object({
  id: projectIdSchema,
  name: z.string().min(1),
  rootPath: z.string().min(1),
  instructions: z.string().optional(),
});

export const memoryScopeSchema = z.enum(["ephemeral", "project", "agent", "personal", "instruction-suggestion"]);
export const memoryStatusSchema = z.enum(["pending", "staged", "approved", "rejected", "promoted"]);

export const memoryEvidenceSchema = z.object({
  conversationId: z.string().min(1),
  excerpt: z.string().min(1),
  turnId: z.string().min(1).optional(),
});

export const memoryCandidateSchema = z.object({
  id: z.string().min(1),
  content: z.string().min(1),
  scope: memoryScopeSchema,
  status: memoryStatusSchema,
  agentId: agentIdSchema.optional(),
  projectId: projectIdSchema.optional(),
  evidence: z.array(memoryEvidenceSchema).min(1),
  fingerprint: z.string().min(1).optional(),
  createdAt: z.string().datetime().optional(),
});

export const learningRuleSchema = z.object({
  id: z.string().min(1),
  candidateScope: memoryScopeSchema,
  action: z.enum(["auto-stage", "require-review", "reject"]),
});

export const conversationBindingSchema = z.object({
  id: z.string().min(1),
  agentId: agentIdSchema,
  projectId: projectIdSchema,
  codexThreadId: z.string().min(1).optional(),
  updatedAt: z.string().datetime().optional(),
});

export const thoraxConfigSchema = z.object({
  dataDirectory: z.string().min(1),
  server: z.object({
    host: z.literal("127.0.0.1"),
    port: z.number().int().min(1024).max(65535),
  }),
  codex: z.object({
    command: z.string().min(1),
    approvalPolicy: z.enum(["untrusted", "on-request", "never"]),
    sandbox: z.enum(["read-only", "workspace-write", "danger-full-access"]),
  }),
  memory: z.object({
    autoStageEphemeral: z.boolean(),
    reflectionIntervalMinutes: z.number().int().positive(),
  }),
});

export const agentSummarySchema = agentDefinitionSchema.pick({ id: true, name: true }).extend({
  role: z.string().min(1),
  state: z.enum(["ready", "working", "offline"]),
  skills: z.array(skillSchema),
});
export const projectSummarySchema = projectDefinitionSchema.pick({ id: true, name: true, rootPath: true });
export const conversationMessageSchema = z.object({
  id: z.string().min(1), author: z.string().min(1), content: z.string().min(1), createdAt: z.string().datetime(),
});
export const conversationSummarySchema = z.object({ id: z.string().min(1), messages: z.array(conversationMessageSchema) });
export const memoryReviewCandidateSchema = z.object({
  id: z.string().min(1), content: z.string().min(1), scope: memoryScopeSchema,
  source: z.string().min(1), createdAt: z.string().datetime(),
});
export const learningEventSchema = z.object({
  id: z.string().min(1), title: z.string().min(1), detail: z.string().min(1), createdAt: z.string().datetime(),
});
export const runtimeSummarySchema = z.object({
  state: z.enum(["healthy", "degraded", "offline"]),
  codex: z.enum(["signed-in", "signed-out", "auth-expired", "missing", "unavailable"]),
  activeSessions: z.number().int().nonnegative(), version: z.string().min(1),
});
export const operatorSnapshotSchema = z.object({
  activeAgentId: agentIdSchema,
  activeProjectId: projectIdSchema,
  agents: z.array(agentSummarySchema),
  projects: z.array(projectSummarySchema),
  conversation: conversationSummarySchema,
  memoryCandidates: z.array(memoryReviewCandidateSchema),
  learningEvents: z.array(learningEventSchema),
  runtime: runtimeSummarySchema,
});

export type Skill = z.infer<typeof skillSchema>;
export type AdapterRiskTier = z.infer<typeof adapterRiskTierSchema>;
export type AdapterAction = z.infer<typeof adapterActionSchema>;
export type AdapterManifest = z.infer<typeof adapterManifestSchema>;
export type AdapterDryRunResult = z.infer<typeof adapterDryRunResultSchema>;
export type AdapterCommitResult = z.infer<typeof adapterCommitResultSchema>;
export type AdapterExecuteRequest = z.infer<typeof adapterExecuteRequestSchema>;
export type WorkflowDefinition = z.infer<typeof workflowDefinitionSchema>;
export type WorkflowStep = z.infer<typeof workflowStepSchema>;
export type StepExecutionLog = z.infer<typeof stepExecutionLogSchema>;
export type WorkflowExecution = z.infer<typeof workflowExecutionSchema>;
export type AgentDefinition = z.infer<typeof agentDefinitionSchema>;
export type ProjectDefinition = z.infer<typeof projectDefinitionSchema>;
export type MemoryCandidate = z.infer<typeof memoryCandidateSchema>;
export type MemoryScope = z.infer<typeof memoryScopeSchema>;
export type MemoryStatus = z.infer<typeof memoryStatusSchema>;
export type LearningRule = z.infer<typeof learningRuleSchema>;
export type ConversationBinding = z.infer<typeof conversationBindingSchema>;
export type ThoraxConfig = z.infer<typeof thoraxConfigSchema>;
export type AgentSummary = z.infer<typeof agentSummarySchema>;
export type ProjectSummary = z.infer<typeof projectSummarySchema>;
export type ConversationMessage = z.infer<typeof conversationMessageSchema>;
export type ConversationSummary = z.infer<typeof conversationSummarySchema>;
export type MemoryReviewCandidate = z.infer<typeof memoryReviewCandidateSchema>;
export type LearningEvent = z.infer<typeof learningEventSchema>;
export type RuntimeSummary = z.infer<typeof runtimeSummarySchema>;
export type OperatorSnapshot = z.infer<typeof operatorSnapshotSchema>;
