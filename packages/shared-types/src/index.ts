import { z } from "zod";

export const agentIdSchema = z.string().regex(/^[a-z][a-z0-9-]*$/);
export const projectIdSchema = z.string().regex(/^[a-z][a-z0-9-]*$/);

export const agentDefinitionSchema = z.object({
  id: agentIdSchema,
  name: z.string().min(1),
  instructions: z.string().min(1),
  projectAccess: z.array(projectIdSchema),
  memoryDirectory: z.string().min(1).optional(),
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

export type AgentDefinition = z.infer<typeof agentDefinitionSchema>;
export type ProjectDefinition = z.infer<typeof projectDefinitionSchema>;
export type MemoryCandidate = z.infer<typeof memoryCandidateSchema>;
export type MemoryScope = z.infer<typeof memoryScopeSchema>;
export type MemoryStatus = z.infer<typeof memoryStatusSchema>;
export type LearningRule = z.infer<typeof learningRuleSchema>;
export type ConversationBinding = z.infer<typeof conversationBindingSchema>;
export type ThoraxConfig = z.infer<typeof thoraxConfigSchema>;

