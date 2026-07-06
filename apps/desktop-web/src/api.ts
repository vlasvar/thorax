import type { AgentDefinition, MemoryScope, ProjectDefinition } from "@thorax/shared-types";

export type AgentSummary = Pick<AgentDefinition, "id" | "name"> & {
  role: string;
  state: "ready" | "working" | "offline";
};

export type ProjectSummary = Pick<ProjectDefinition, "id" | "name" | "rootPath">;

export interface ConversationMessage {
  id: string;
  author: "operator" | string;
  content: string;
  createdAt: string;
}

export interface ConversationSummary {
  id: string;
  messages: ConversationMessage[];
}

export interface MemoryReviewCandidate {
  id: string;
  content: string;
  scope: MemoryScope;
  source: string;
  createdAt: string;
}

export interface LearningEvent {
  id: string;
  title: string;
  detail: string;
  createdAt: string;
}

export interface RuntimeSummary {
  state: "healthy" | "degraded" | "offline";
  codex: "signed-in" | "signed-out" | "auth-expired" | "missing" | "unavailable";
  activeSessions: number;
  version: string;
}

export interface OperatorSnapshot {
  activeAgentId: string;
  activeProjectId: string;
  agents: AgentSummary[];
  projects: ProjectSummary[];
  conversation: ConversationSummary;
  memoryCandidates: MemoryReviewCandidate[];
  learningEvents: LearningEvent[];
  runtime: RuntimeSummary;
}

export interface OperatorApi {
  loadSnapshot(): Promise<OperatorSnapshot>;
  loadConversation(agentId: string, projectId: string): Promise<ConversationSummary>;
  reviewMemory(id: string, decision: "approve" | "reject"): Promise<void>;
  sendMessage(conversationId: string, agentId: string, projectId: string, content: string): Promise<ConversationMessage>;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: { "content-type": "application/json", ...init?.headers },
  });

  if (!response.ok) {
    throw new Error(`Thorax request failed (${response.status})`);
  }

  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

export const operatorApi: OperatorApi = {
  loadSnapshot: () => request<OperatorSnapshot>("/api/operator/snapshot"),
  loadConversation: (agentId, projectId) =>
    request<ConversationSummary>(`/api/conversations/active?agentId=${encodeURIComponent(agentId)}&projectId=${encodeURIComponent(projectId)}`),
  reviewMemory: async (id, decision) => {
    await request(`/api/memory/candidates/${encodeURIComponent(id)}/review`, {
      method: "POST",
      body: JSON.stringify({ decision }),
    });
  },
  sendMessage: (conversationId, agentId, projectId, content) =>
    request<ConversationMessage>(`/api/conversations/${encodeURIComponent(conversationId)}/messages`, {
      method: "POST",
      body: JSON.stringify({ agentId, projectId, content }),
    }),
};
