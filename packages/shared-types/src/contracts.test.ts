import { describe, expect, it } from "vitest";
import {
  agentDefinitionSchema,
  conversationBindingSchema,
  memoryCandidateSchema,
  projectDefinitionSchema,
  thoraxConfigSchema,
} from "./index.js";

describe("Thorax contracts", () => {
  it("accepts a valid local-only configuration", () => {
    const result = thoraxConfigSchema.parse({
      dataDirectory: ".thorax",
      server: { host: "127.0.0.1", port: 4317 },
      codex: {
        command: "codex",
        approvalPolicy: "on-request",
        sandbox: "workspace-write",
      },
      memory: { autoStageEphemeral: true, reflectionIntervalMinutes: 30 },
    });
    expect(result.server.host).toBe("127.0.0.1");
  });

  it("rejects remote server binding", () => {
    expect(() =>
      thoraxConfigSchema.parse({
        dataDirectory: ".thorax",
        server: { host: "0.0.0.0", port: 4317 },
        codex: { command: "codex", approvalPolicy: "on-request", sandbox: "workspace-write" },
        memory: { autoStageEphemeral: true, reflectionIntervalMinutes: 30 },
      }),
    ).toThrow();
  });

  it("validates durable agent, project, conversation, and memory records", () => {
    expect(agentDefinitionSchema.parse({ id: "builder", name: "Builder", instructions: "Build carefully.", projectAccess: ["thorax"] }).id).toBe("builder");
    expect(projectDefinitionSchema.parse({ id: "thorax", name: "Thorax", rootPath: "C:/work/thorax" }).id).toBe("thorax");
    expect(conversationBindingSchema.parse({ id: "c1", agentId: "builder", projectId: "thorax", codexThreadId: "t1" }).codexThreadId).toBe("t1");
    expect(memoryCandidateSchema.parse({ id: "m1", content: "Use TDD", scope: "project", status: "pending", evidence: [{ conversationId: "c1", excerpt: "Test first" }] }).status).toBe("pending");
  });
});

