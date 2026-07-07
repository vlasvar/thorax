import {
  conversationMessageSchema,
  conversationSummarySchema,
  operatorSnapshotSchema,
  adapterDryRunResultSchema,
  adapterCommitResultSchema,
  type ConversationMessage,
  type ConversationSummary,
  type OperatorSnapshot,
  type AdapterDryRunResult,
  type AdapterCommitResult,
} from "@thorax/shared-types";
export type {
  AgentSummary,
  ConversationMessage,
  ConversationSummary,
  LearningEvent,
  MemoryReviewCandidate,
  OperatorSnapshot,
  ProjectSummary,
  RuntimeSummary,
  AdapterDryRunResult,
  AdapterCommitResult,
} from "@thorax/shared-types";

export interface OperatorApi {
  loadSnapshot(): Promise<OperatorSnapshot>;
  loadConversation(agentId: string, projectId: string): Promise<ConversationSummary>;
  reviewMemory(id: string, decision: "approve" | "reject"): Promise<void>;
  sendMessage(conversationId: string, agentId: string, projectId: string, content: string): Promise<ConversationMessage>;
  executeAdapterAction(request: { adapterId: string; action: string; input: Record<string, unknown>; mode: "dry_run" | "commit"; approved_by?: string }): Promise<AdapterDryRunResult | AdapterCommitResult>;
  triggerWorkflow(definition: any, context: Record<string, unknown>): Promise<any>;
  resumeWorkflow(executionId: string, definition: any, approved: boolean): Promise<any>;
  listWorkflowExecutions(): Promise<any[]>;
}

interface Parser<T> { parse(value: unknown): T }

async function request<T>(baseUrl: string, path: string, parser: Parser<T> | undefined, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  headers.set("content-type", "application/json");
  const response = await fetch(`${baseUrl}${path}`, { ...init, headers: Object.fromEntries(headers.entries()) });
  if (!response.ok) throw new Error(`Thorax request failed (${response.status})`);
  if (response.status === 204) return undefined as T;
  const value: unknown = await response.json();
  return parser ? parser.parse(value) : value as T;
}

export function createOperatorApi(baseUrl = ""): OperatorApi {
  const normalized = baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
  return {
    loadSnapshot: () => request(normalized, "/api/operator/snapshot", operatorSnapshotSchema),
    loadConversation: (agentId, projectId) =>
      request(normalized, `/api/conversations/active?agentId=${encodeURIComponent(agentId)}&projectId=${encodeURIComponent(projectId)}`, conversationSummarySchema),
    reviewMemory: async (id, decision) => {
      await request(normalized, `/api/memory/candidates/${encodeURIComponent(id)}/review`, undefined, {
        method: "POST", body: JSON.stringify({ decision }),
      });
    },
    sendMessage: (conversationId, agentId, projectId, content) =>
      request(normalized, `/api/conversations/${encodeURIComponent(conversationId)}/messages`, conversationMessageSchema, {
        method: "POST", body: JSON.stringify({ agentId, projectId, content }),
      }),
    executeAdapterAction: (reqBody) =>
      request(normalized, "/api/adapter/execute", {
        parse: (val) => {
          const parsedDry = adapterDryRunResultSchema.safeParse(val);
          if (parsedDry.success) return parsedDry.data;
          return adapterCommitResultSchema.parse(val);
        }
      }, {
        method: "POST", body: JSON.stringify(reqBody),
      }),
    triggerWorkflow: (definition, context) =>
      request(normalized, "/api/workflows/trigger", undefined, {
        method: "POST", body: JSON.stringify({ definition, context }),
      }),
    resumeWorkflow: (executionId, definition, approved) =>
      request(normalized, `/api/workflows/executions/${encodeURIComponent(executionId)}/${approved ? "approve" : "reject"}`, undefined, {
        method: "POST", body: JSON.stringify({ definition }),
      }),
    listWorkflowExecutions: () =>
      request(normalized, "/api/workflows/executions", undefined),
  };
}

export const operatorApi = createOperatorApi();
