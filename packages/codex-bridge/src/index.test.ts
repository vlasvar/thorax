import { describe, expect, it } from "vitest";
import {
  CodexBridgeError,
  CodexRuntime,
  windowsProcessTreeCommand,
  type AppServerConnection,
  type ProcessTransport,
  type RpcMessage,
} from "./index.js";

class FakeConnection implements AppServerConnection {
  readonly sent: RpcMessage[] = [];
  closed = false;
  terminated = false;

  constructor(
    private readonly lines: readonly string[],
    private readonly options: { hang?: boolean; closeHangs?: boolean; sendHangsFor?: string; sendRejectsFor?: string; onSend?: (message: RpcMessage) => void } = {},
  ) {}

  async send(message: RpcMessage): Promise<void> {
    this.sent.push(message);
    this.options.onSend?.(message);
    if (this.options.sendRejectsFor !== undefined && message.method === this.options.sendRejectsFor) throw new Error("simulated write failure");
    if (this.options.sendHangsFor !== undefined && message.method === this.options.sendHangsFor) await new Promise(() => undefined);
  }

  async *messages(): AsyncIterable<string> {
    for (const line of this.lines) yield line;
    if (this.options.hang) await new Promise(() => undefined);
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.options.closeHangs) await new Promise(() => undefined);
  }

  async terminate(): Promise<void> {
    this.terminated = true;
  }
}

function fakeTransport(options: {
  version?: { stdout: string; stderr?: string; exitCode?: number } | Error;
  login?: { stdout: string; stderr?: string; exitCode?: number } | Error;
  lines?: readonly string[];
  hang?: boolean;
  closeHangs?: boolean;
  sendHangsFor?: string;
  sendRejectsFor?: string;
  onSend?: (message: RpcMessage) => void;
  openHangs?: boolean;
  runHangs?: boolean;
}) {
  const connection = new FakeConnection(options.lines ?? [], options);
  const transport: ProcessTransport = {
    async run(_command, args) {
      if (options.runHangs) return new Promise(() => undefined);
      const result = args[0] === "--version" ? options.version : options.login;
      if (result instanceof Error) throw result;
      return { stdout: "", stderr: "", exitCode: 0, ...result };
    },
    async open() {
      if (options.openHangs) return new Promise(() => undefined);
      return connection;
    },
  };
  return { transport, connection };
}

const response = (id: number, result: unknown) => JSON.stringify({ id, result });
const notification = (method: string, params: unknown) => JSON.stringify({ method, params });
async function collect<T>(source: AsyncIterable<T>): Promise<T[]> {
  const values: T[] = [];
  for await (const value of source) values.push(value);
  return values;
}

describe("CodexRuntime health", () => {
  it("reports a ready ChatGPT-backed Codex login without reading credentials", async () => {
    const { transport } = fakeTransport({
      version: { stdout: "codex-cli 0.141.0\n" },
      login: { stdout: "Logged in using ChatGPT\n" },
    });

    await expect(new CodexRuntime(transport).health()).resolves.toEqual({
      status: "ready",
      version: "0.141.0",
      auth: "chatgpt",
      message: "Codex is installed and signed in with ChatGPT.",
    });
  });

  it("maps a missing executable to an actionable health result", async () => {
    const missing = Object.assign(new Error("spawn codex ENOENT"), { code: "ENOENT" });
    const { transport } = fakeTransport({ version: missing });

    await expect(new CodexRuntime(transport).health()).resolves.toMatchObject({
      status: "missing",
      action: "Install Codex CLI and ensure `codex` is available on PATH.",
    });
  });

  it("maps signed-out status to the supported login command", async () => {
    const { transport } = fakeTransport({
      version: { stdout: "codex-cli 0.141.0" },
      login: { stdout: "", stderr: "Not logged in", exitCode: 1 },
    });

    await expect(new CodexRuntime(transport).health()).resolves.toMatchObject({
      status: "signed_out",
      action: "Run `codex login` and choose ChatGPT authentication.",
    });
  });

  it("distinguishes an expired login from a user who has not signed in", async () => {
    const { transport } = fakeTransport({
      version: { stdout: "codex-cli 0.141.0" },
      login: { stdout: "", stderr: "ChatGPT authentication token expired", exitCode: 1 },
    });

    await expect(new CodexRuntime(transport).health()).resolves.toMatchObject({
      status: "auth_expired",
      action: "Run `codex login` to refresh ChatGPT authentication.",
    });
  });

  it("bounds a hung Codex health command", async () => {
    const { transport } = fakeTransport({ runHangs: true });

    await expect(new CodexRuntime(transport, { timeouts: { healthMs: 5 } }).health()).resolves.toMatchObject({
      status: "error",
      action: expect.stringContaining("retry"),
    });
  });
});

describe("CodexRuntime turns", () => {
  it("starts a thread and streams normalized events from app-server JSONL", async () => {
    const { transport, connection } = fakeTransport({
      lines: [
        response(1, {}),
        response(2, { thread: { id: "thread-new" } }),
        response(3, { turn: { id: "turn-1", status: "inProgress" } }),
        notification("turn/started", { threadId: "thread-new", turn: { id: "turn-1", status: "inProgress" } }),
        notification("item/agentMessage/delta", { threadId: "thread-new", turnId: "turn-1", itemId: "item-1", delta: "Hello" }),
        notification("turn/completed", { threadId: "thread-new", turn: { id: "turn-1", status: "completed", items: [] } }),
      ],
    });

    const events = await collect(new CodexRuntime(transport).runTurn({ prompt: "Hi", cwd: "C:\\work" }));

    expect(events).toEqual([
      { type: "thread.started", threadId: "thread-new" },
      { type: "turn.started", threadId: "thread-new", turnId: "turn-1" },
      { type: "message.delta", threadId: "thread-new", turnId: "turn-1", itemId: "item-1", delta: "Hello" },
      { type: "turn.completed", threadId: "thread-new", turnId: "turn-1", status: "completed" },
    ]);
    expect(connection.sent).toEqual([
      { id: 1, method: "initialize", params: { clientInfo: { name: "thorax", title: "Thorax", version: "0.1.0" }, capabilities: { experimentalApi: false, requestAttestation: false } } },
      { method: "initialized" },
      { id: 2, method: "thread/start", params: { cwd: "C:\\work" } },
      { id: 3, method: "turn/start", params: { threadId: "thread-new", input: [{ type: "text", text: "Hi" }] } },
    ]);
    expect(connection.closed).toBe(true);
  });

  it("resumes the requested thread before starting a turn", async () => {
    const { transport, connection } = fakeTransport({
      lines: [
        response(1, {}),
        response(2, { thread: { id: "thread-old" } }),
        response(3, { turn: { id: "turn-2", status: "inProgress" } }),
        notification("turn/completed", { threadId: "thread-old", turn: { id: "turn-2", status: "completed", items: [] } }),
      ],
    });

    await collect(new CodexRuntime(transport).runTurn({ prompt: "Continue", threadId: "thread-old" }));

    expect(connection.sent[2]).toEqual({ id: 2, method: "thread/resume", params: { threadId: "thread-old" } });
  });

  it("interrupts the active turn when cancellation is requested", async () => {
    const controller = new AbortController();
    const { transport, connection } = fakeTransport({
      lines: [
        response(1, {}),
        response(2, { thread: { id: "thread-1" } }),
        response(3, { turn: { id: "turn-1", status: "inProgress" } }),
        notification("turn/started", { threadId: "thread-1", turn: { id: "turn-1", status: "inProgress" } }),
        notification("item/agentMessage/delta", { threadId: "thread-1", turnId: "turn-1", itemId: "item-1", delta: "partial" }),
        notification("turn/completed", { threadId: "thread-1", turn: { id: "turn-1", status: "interrupted", items: [] } }),
      ],
    });
    const events = [];

    for await (const event of new CodexRuntime(transport).runTurn({ prompt: "Go", signal: controller.signal })) {
      events.push(event);
      if (event.type === "turn.started") controller.abort();
    }

    expect(connection.sent).toContainEqual({ id: 4, method: "turn/interrupt", params: { threadId: "thread-1", turnId: "turn-1" } });
    expect(events.at(-1)).toMatchObject({ type: "turn.completed", status: "interrupted" });
  });

  it("does not start a process for a signal that is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const { transport, connection } = fakeTransport({});

    await expect(collect(new CodexRuntime(transport).runTurn({ prompt: "Go", signal: controller.signal }))).rejects.toMatchObject({
      code: "CANCELLED",
    });
    expect(connection.sent).toEqual([]);
  });

  it("interrupts when aborted after turn/start is sent but before turn/started", async () => {
    const controller = new AbortController();
    const { transport, connection } = fakeTransport({
      onSend(message) {
        if (message.method === "turn/start") controller.abort();
      },
      lines: [
        response(1, {}),
        response(2, { thread: { id: "thread-1" } }),
        response(3, { turn: { id: "turn-1", status: "inProgress" } }),
        notification("turn/completed", { threadId: "thread-1", turn: { id: "turn-1", status: "interrupted", items: [] } }),
      ],
    });

    await collect(new CodexRuntime(transport).runTurn({ prompt: "Go", signal: controller.signal }));

    expect(connection.sent).toContainEqual({ id: 4, method: "turn/interrupt", params: { threadId: "thread-1", turnId: "turn-1" } });
  });

  it("wakes an in-flight turn wait on abort and applies interrupt timeout immediately", async () => {
    const controller = new AbortController();
    const startedAt = Date.now();
    const { transport, connection } = fakeTransport({
      hang: true,
      onSend(message) { if (message.method === "turn/start") setTimeout(() => controller.abort(), 5); },
      lines: [response(1, {}), response(2, { thread: { id: "t" } }), response(3, { turn: { id: "u", status: "inProgress" } })],
    });
    const runtime = new CodexRuntime(transport, { timeouts: { turnMs: 200, interruptMs: 10, shutdownMs: 20 } });

    await expect(collect(runtime.runTurn({ prompt: "Go", signal: controller.signal }))).rejects.toMatchObject({ code: "INTERRUPT_TIMEOUT" });
    expect(Date.now() - startedAt).toBeLessThan(100);
    expect(connection.sent).toContainEqual({ id: 4, method: "turn/interrupt", params: { threadId: "t", turnId: "u" } });
  });

  it("observes a rejected interrupt write instead of creating an unhandled rejection", async () => {
    const controller = new AbortController();
    const startedAt = Date.now();
    const { transport } = fakeTransport({
      hang: true,
      sendRejectsFor: "turn/interrupt",
      onSend(message) { if (message.method === "turn/start") setTimeout(() => controller.abort(), 5); },
      lines: [response(1, {}), response(2, { thread: { id: "t" } }), response(3, { turn: { id: "u", status: "inProgress" } })],
    });
    const runtime = new CodexRuntime(transport, { timeouts: { turnMs: 200, interruptMs: 20, shutdownMs: 20 } });

    await expect(collect(runtime.runTurn({ prompt: "Go", signal: controller.signal }))).rejects.toMatchObject({ code: "PROCESS_FAILURE" });
    expect(Date.now() - startedAt).toBeLessThan(100);
  });

  it("cancels after startup but before a thread response without starting a turn", async () => {
    const controller = new AbortController();
    const { transport, connection } = fakeTransport({
      hang: true,
      onSend(message) { if (message.method === "thread/start") controller.abort(); },
      lines: [response(1, {})],
    });
    const runtime = new CodexRuntime(transport, { timeouts: { handshakeMs: 30, shutdownMs: 20 } });

    await expect(collect(runtime.runTurn({ prompt: "Go", signal: controller.signal }))).rejects.toMatchObject({ code: "CANCELLED" });
    expect(connection.sent.some((message) => message.method === "turn/start")).toBe(false);
  });

  it("cancels promptly when the turn/start write is blocked before a turn id exists", async () => {
    const controller = new AbortController();
    const startedAt = Date.now();
    const { transport, connection } = fakeTransport({
      sendHangsFor: "turn/start",
      onSend(message) { if (message.method === "turn/start") setTimeout(() => controller.abort(), 5); },
      lines: [response(1, {}), response(2, { thread: { id: "thread-1" } })],
    });
    const runtime = new CodexRuntime(transport, { timeouts: { turnMs: 200, interruptMs: 10, shutdownMs: 20 } });

    await expect(collect(runtime.runTurn({ prompt: "Go", signal: controller.signal }))).rejects.toMatchObject({ code: "CANCELLED" });
    expect(Date.now() - startedAt).toBeLessThan(100);
    expect(connection.closed).toBe(true);
  });

  it("cancels promptly while a custom server request handler is blocked", async () => {
    const controller = new AbortController();
    const startedAt = Date.now();
    const { transport, connection } = fakeTransport({
      lines: [
        response(1, {}),
        response(2, { thread: { id: "thread-1" } }),
        response(3, { turn: { id: "turn-1", status: "inProgress" } }),
        JSON.stringify({ id: "approval", method: "item/commandExecution/requestApproval", params: {} }),
      ],
    });
    const runtime = new CodexRuntime(transport, {
      timeouts: { turnMs: 200, interruptMs: 10, shutdownMs: 20 },
      serverRequestHandler: async () => {
        setTimeout(() => controller.abort(), 5);
        await new Promise(() => undefined);
        return { result: {} };
      },
    });

    await expect(collect(runtime.runTurn({ prompt: "Go", signal: controller.signal }))).rejects.toMatchObject({ code: "CANCELLED" });
    expect(Date.now() - startedAt).toBeLessThan(100);
    expect(connection.closed).toBe(true);
  });

  it("handles colliding server request ids with a deny-or-error policy instead of treating them as responses", async () => {
    const { transport, connection } = fakeTransport({
      lines: [
        response(1, {}),
        response(2, { thread: { id: "thread-1" } }),
        response(3, { turn: { id: "turn-1", status: "inProgress" } }),
        JSON.stringify({ id: 2, method: "item/commandExecution/requestApproval", params: { threadId: "thread-1", turnId: "turn-1", itemId: "i1" } }),
        JSON.stringify({ id: "input-1", method: "item/tool/requestUserInput", params: { threadId: "thread-1", turnId: "turn-1", itemId: "i2", questions: [] } }),
        JSON.stringify({ id: "auth-1", method: "account/chatgptAuthTokens/refresh", params: { reason: "expired" } }),
        notification("turn/completed", { threadId: "thread-1", turn: { id: "turn-1", status: "completed", items: [] } }),
      ],
    });

    await collect(new CodexRuntime(transport).runTurn({ prompt: "Go" }));

    expect(connection.sent).toContainEqual({ id: 2, result: { decision: "decline" } });
    expect(connection.sent).toContainEqual({ id: "input-1", error: expect.objectContaining({ message: expect.stringContaining("user input") }) });
    expect(connection.sent).toContainEqual({ id: "auth-1", error: expect.objectContaining({ message: expect.stringContaining("token") }) });
  });

  it("validates item payload shapes", async () => {
    const { transport } = fakeTransport({
      lines: [
        response(1, {}),
        response(2, { thread: { id: "thread-1" } }),
        response(3, { turn: { id: "turn-1", status: "inProgress" } }),
        notification("item/started", { threadId: "thread-1", turnId: "turn-1", item: "not-an-item" }),
      ],
    });

    await expect(collect(new CodexRuntime(transport).runTurn({ prompt: "Go" }))).rejects.toMatchObject({ code: "MALFORMED_EVENT" });
  });

  it("does not misclassify a generic login-required error as an expired token", async () => {
    const { transport } = fakeTransport({ lines: [response(1, {}), JSON.stringify({ id: 2, error: { message: "login required" } })] });

    await expect(collect(new CodexRuntime(transport).runTurn({ prompt: "Hi" }))).rejects.toMatchObject({ code: "AUTH_REQUIRED" });
  });

  it.each([
    ["startup", { openHangs: true }, "STARTUP_TIMEOUT"],
    ["handshake", { hang: true }, "HANDSHAKE_TIMEOUT"],
    ["turn", { hang: true, lines: [response(1, {}), response(2, { thread: { id: "t" } }), response(3, { turn: { id: "u", status: "inProgress" } })] }, "TURN_TIMEOUT"],
  ] as const)("fails an unresponsive %s phase with an actionable timeout", async (_phase, fakeOptions, code) => {
    const { transport } = fakeTransport(fakeOptions);
    const runtime = new CodexRuntime(transport, { timeouts: { startupMs: 5, handshakeMs: 5, turnMs: 5, interruptMs: 5, shutdownMs: 5 } });

    await expect(collect(runtime.runTurn({ prompt: "Go" }))).rejects.toMatchObject({ code });
  });

  it("times out an unacknowledged interrupt", async () => {
    const controller = new AbortController();
    const { transport } = fakeTransport({
      hang: true,
      onSend(message) { if (message.method === "turn/start") controller.abort(); },
      lines: [response(1, {}), response(2, { thread: { id: "t" } }), response(3, { turn: { id: "u", status: "inProgress" } })],
    });
    const runtime = new CodexRuntime(transport, { timeouts: { startupMs: 20, handshakeMs: 20, turnMs: 100, interruptMs: 5, shutdownMs: 20 } });

    await expect(collect(runtime.runTurn({ prompt: "Go", signal: controller.signal }))).rejects.toMatchObject({ code: "INTERRUPT_TIMEOUT" });
  });

  it.each([
    ["initialize", "HANDSHAKE_TIMEOUT"],
    ["turn/start", "TURN_TIMEOUT"],
    ["turn/interrupt", "INTERRUPT_TIMEOUT"],
  ] as const)("times out a blocked %s write", async (method, code) => {
    const controller = new AbortController();
    const lines = method === "initialize" ? [] : [
      response(1, {}), response(2, { thread: { id: "t" } }), response(3, { turn: { id: "u", status: "inProgress" } }),
    ];
    const { transport } = fakeTransport({
      lines,
      hang: true,
      sendHangsFor: method,
      onSend(message) { if (method === "turn/interrupt" && message.method === "turn/start") controller.abort(); },
    });
    const runtime = new CodexRuntime(transport, { timeouts: { handshakeMs: 5, turnMs: 5, interruptMs: 5, shutdownMs: 20 } });

    await expect(collect(runtime.runTurn({ prompt: "Go", signal: controller.signal }))).rejects.toMatchObject({ code });
  });

  it("bounds a custom server request handler so it cannot deadlock the turn", async () => {
    const { transport } = fakeTransport({
      lines: [
        response(1, {}), response(2, { thread: { id: "t" } }), response(3, { turn: { id: "u", status: "inProgress" } }),
        JSON.stringify({ id: "approval", method: "item/commandExecution/requestApproval", params: { threadId: "t", turnId: "u", itemId: "i" } }),
      ],
      hang: true,
    });
    const runtime = new CodexRuntime(transport, {
      serverRequestHandler: async () => new Promise(() => undefined),
      timeouts: { turnMs: 5, shutdownMs: 20 },
    });

    await expect(collect(runtime.runTurn({ prompt: "Go" }))).rejects.toMatchObject({ code: "TURN_TIMEOUT" });
  });

  it("terminates a connection whose graceful shutdown hangs", async () => {
    const { transport, connection } = fakeTransport({
      closeHangs: true,
      lines: [
        response(1, {}), response(2, { thread: { id: "t" } }), response(3, { turn: { id: "u", status: "inProgress" } }),
        notification("turn/completed", { threadId: "t", turn: { id: "u", status: "completed", items: [] } }),
      ],
    });
    const runtime = new CodexRuntime(transport, { timeouts: { shutdownMs: 5 } });

    await expect(collect(runtime.runTurn({ prompt: "Go" }))).rejects.toMatchObject({ code: "SHUTDOWN_TIMEOUT" });
    expect(connection.terminated).toBe(true);
  });

  it("rejects malformed protocol lines with an actionable bridge error", async () => {
    const { transport } = fakeTransport({ lines: [response(1, {}), "not-json"] });

    const read = collect(new CodexRuntime(transport).runTurn({ prompt: "Hi" }));
    await expect(read).rejects.toMatchObject({
      code: "MALFORMED_EVENT",
      action: "Update Codex CLI or report the incompatible app-server event.",
    });
  });

  it("maps app-server authentication failures to a login action", async () => {
    const { transport } = fakeTransport({
      lines: [response(1, {}), JSON.stringify({ id: 2, error: { code: -32000, message: "authentication token expired" } })],
    });

    await expect(collect(new CodexRuntime(transport).runTurn({ prompt: "Hi" }))).rejects.toMatchObject({
      code: "AUTH_EXPIRED",
      action: "Run `codex login` to refresh ChatGPT authentication.",
    });
  });

  it("maps a terminal authentication error notification to the same login action", async () => {
    const { transport } = fakeTransport({
      lines: [
        response(1, {}),
        response(2, { thread: { id: "thread-1" } }),
        response(3, { turn: { id: "turn-1", status: "inProgress" } }),
        notification("error", {
          threadId: "thread-1",
          turnId: "turn-1",
          willRetry: false,
          error: { message: "ChatGPT authentication token expired" },
        }),
      ],
    });

    await expect(collect(new CodexRuntime(transport).runTurn({ prompt: "Hi" }))).rejects.toMatchObject({
      code: "AUTH_EXPIRED",
      action: "Run `codex login` to refresh ChatGPT authentication.",
    });
  });
});

describe("Node process safety", () => {
  it("builds a non-shell Windows process-tree termination command", () => {
    expect(windowsProcessTreeCommand(1234)).toEqual({ command: "taskkill.exe", args: ["/PID", "1234", "/T", "/F"] });
  });
});
