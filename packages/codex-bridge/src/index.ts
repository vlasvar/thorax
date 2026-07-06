import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";

export type RpcId = number | string;
export type RpcError = { code?: number; message: string; data?: unknown };
export type RpcMessage = { id?: RpcId; method?: string; params?: unknown; result?: unknown; error?: RpcError };

export interface AppServerConnection {
  send(message: RpcMessage): Promise<void>;
  messages(): AsyncIterable<string>;
  close(): Promise<void>;
  terminate(): Promise<void>;
}

export interface ProcessTransport {
  run(command: string, args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }>;
  open(command: string, args: string[]): Promise<AppServerConnection>;
}

export type CodexHealth =
  | { status: "ready"; version: string; auth: "chatgpt"; message: string }
  | { status: "missing" | "signed_out" | "auth_expired" | "error"; message: string; action: string };

export type CodexEvent =
  | { type: "thread.started" | "thread.resumed"; threadId: string }
  | { type: "turn.started"; threadId: string; turnId: string }
  | { type: "message.delta"; threadId: string; turnId: string; itemId: string; delta: string }
  | { type: "item.started" | "item.completed"; threadId: string; turnId: string; item: Record<string, unknown> }
  | { type: "turn.completed"; threadId: string; turnId: string; status: "completed" | "interrupted" | "failed" }
  | { type: "error"; threadId?: string; turnId?: string; message: string };

export type BridgeErrorCode =
  | "CODEX_MISSING"
  | "AUTH_REQUIRED"
  | "AUTH_EXPIRED"
  | "CANCELLED"
  | "PROCESS_FAILURE"
  | "MALFORMED_EVENT"
  | "PROTOCOL_ERROR"
  | "STARTUP_TIMEOUT"
  | "HANDSHAKE_TIMEOUT"
  | "TURN_TIMEOUT"
  | "INTERRUPT_TIMEOUT"
  | "SHUTDOWN_TIMEOUT";

export class CodexBridgeError extends Error {
  constructor(
    readonly code: BridgeErrorCode,
    message: string,
    readonly action: string,
    readonly details?: unknown,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "CodexBridgeError";
  }
}

export type RunTurnOptions = { prompt: string; cwd?: string; threadId?: string; signal?: AbortSignal };
export type ServerRequest = { id: RpcId; method: string; params: Record<string, unknown> };
export type ServerRequestResolution = { result: unknown } | { error: RpcError };
export type ServerRequestHandler = (request: ServerRequest) => Promise<ServerRequestResolution> | ServerRequestResolution;

export interface RuntimeTimeouts {
  healthMs: number;
  startupMs: number;
  handshakeMs: number;
  turnMs: number;
  interruptMs: number;
  shutdownMs: number;
}

export interface CodexRuntimeOptions {
  command?: string;
  timeouts?: Partial<RuntimeTimeouts>;
  serverRequestHandler?: ServerRequestHandler;
}

const DEFAULT_TIMEOUTS: RuntimeTimeouts = {
  healthMs: 5_000,
  startupMs: 30_000,
  handshakeMs: 60_000,
  turnMs: 10 * 60_000,
  interruptMs: 10_000,
  shutdownMs: 3_000,
};
const LOGIN_ACTION = "Run `codex login` and choose ChatGPT authentication.";
const REFRESH_ACTION = "Run `codex login` to refresh ChatGPT authentication.";
const PROTOCOL_ACTION = "Update Codex CLI or report the incompatible app-server event.";

export class CodexRuntime {
  readonly #command: string;
  readonly #timeouts: RuntimeTimeouts;
  readonly #handleServerRequest: ServerRequestHandler;

  constructor(
    private readonly transport: ProcessTransport = new NodeProcessTransport(),
    options: CodexRuntimeOptions = {},
  ) {
    this.#command = options.command ?? "codex";
    this.#timeouts = { ...DEFAULT_TIMEOUTS, ...options.timeouts };
    this.#handleServerRequest = options.serverRequestHandler ?? safeServerRequestPolicy;
  }

  async health(): Promise<CodexHealth> {
    let versionResult: Awaited<ReturnType<ProcessTransport["run"]>>;
    try {
      versionResult = await withTimeout(
        this.transport.run(this.#command, ["--version"]),
        this.#timeouts.healthMs,
        "PROCESS_FAILURE",
        "Codex version check timed out.",
      );
    } catch (error) {
      if (isMissingExecutable(error)) {
        return { status: "missing", message: "Codex CLI was not found.", action: "Install Codex CLI and ensure `codex` is available on PATH." };
      }
      return { status: "error", message: errorMessage(error), action: "Verify the Codex CLI installation and retry." };
    }
    if (versionResult.exitCode !== 0) {
      return { status: "error", message: cleanOutput(versionResult), action: "Verify the Codex CLI installation and retry." };
    }

    let loginResult: Awaited<ReturnType<ProcessTransport["run"]>>;
    try {
      loginResult = await withTimeout(
        this.transport.run(this.#command, ["login", "status"]),
        this.#timeouts.healthMs,
        "PROCESS_FAILURE",
        "Codex login status check timed out.",
      );
    } catch (error) {
      return { status: "error", message: errorMessage(error), action: LOGIN_ACTION };
    }
    const loginOutput = cleanOutput(loginResult);
    if (isExplicitlyExpired(loginOutput)) return { status: "auth_expired", message: loginOutput, action: REFRESH_ACTION };
    if (loginResult.exitCode !== 0 || isAuthRequired(loginOutput)) {
      return { status: "signed_out", message: loginOutput || "Codex is not signed in.", action: LOGIN_ACTION };
    }
    if (!/logged in using chatgpt/i.test(loginOutput)) {
      return { status: "error", message: loginOutput || "Codex authentication status was not recognized.", action: "Sign in with ChatGPT using `codex login`; Thorax does not use API keys." };
    }
    return {
      status: "ready",
      version: versionResult.stdout.match(/codex-cli\s+([^\s]+)/i)?.[1] ?? "unknown",
      auth: "chatgpt",
      message: "Codex is installed and signed in with ChatGPT.",
    };
  }

  async *runTurn(options: RunTurnOptions): AsyncGenerator<CodexEvent> {
    if (options.signal?.aborted) throw bridgeError("CANCELLED", "The turn was cancelled before startup.");

    let connection: AppServerConnection;
    try {
      connection = await withTimeout(
        this.transport.open(this.#command, ["app-server", "--stdio"]),
        this.#timeouts.startupMs,
        "STARTUP_TIMEOUT",
        "Codex app-server did not start in time.",
      );
    } catch (error) {
      if (error instanceof CodexBridgeError) throw error;
      if (isMissingExecutable(error)) throw new CodexBridgeError("CODEX_MISSING", "Codex CLI was not found.", "Install Codex CLI and ensure `codex` is available on PATH.", undefined, { cause: error });
      throw new CodexBridgeError("PROCESS_FAILURE", errorMessage(error), "Restart Codex and retry the turn.", undefined, { cause: error });
    }

    const iterator = connection.messages()[Symbol.asyncIterator]();
    let threadId: string | undefined;
    let turnId: string | undefined;
    let turnRequested = false;
    let abortRequested = false;
    let interruptSent = false;
    let interruptWrite: Promise<void> | undefined;
    let phase: "handshake" | "turn" | "interrupt" = "handshake";
    let deadline = Date.now() + this.#timeouts.handshakeMs;
    let completed = false;
    let pendingNext: Promise<IteratorResult<string>> | undefined;
    let wakeAbort!: () => void;
    const abortWake = new Promise<"abort">((resolve) => { wakeAbort = () => resolve("abort"); });

    const requestInterrupt = (): Promise<void> => {
      abortRequested = true;
      if (!turnRequested || !threadId || !turnId) return Promise.resolve();
      if (!interruptSent) {
        interruptSent = true;
        phase = "interrupt";
        deadline = Date.now() + this.#timeouts.interruptMs;
        interruptWrite = withTimeout(
          connection.send({ id: 4, method: "turn/interrupt", params: { threadId, turnId } }),
          this.#timeouts.interruptMs,
          "INTERRUPT_TIMEOUT",
          "Writing the Codex interrupt request timed out.",
        );
      }
      return interruptWrite ?? Promise.resolve();
    };
    const onAbort = () => {
      abortRequested = true;
      wakeAbort();
    };
    options.signal?.addEventListener("abort", onAbort);

    let activeError: unknown = null;
    try {
      await withTimeout(
        connection.send({
          id: 1,
          method: "initialize",
          params: {
            clientInfo: { name: "thorax", title: "Thorax", version: "0.1.0" },
            capabilities: { experimentalApi: false, requestAttestation: false },
          },
        }),
        this.#timeouts.handshakeMs,
        "HANDSHAKE_TIMEOUT",
        "Writing the Codex initialize request timed out.",
      );

      while (!completed) {
        if (options.signal?.aborted) {
          abortRequested = true;
          if (!turnRequested) throw bridgeError("CANCELLED", "The turn was cancelled before turn startup.");
          await requestInterrupt();
        }
        const currentPhase: "handshake" | "turn" | "interrupt" = phase;
        const timeoutCode = timeoutCodeFor(currentPhase);
        pendingNext ??= iterator.next();
        const remaining = Math.max(1, deadline - Date.now());
        const raced = options.signal && !abortRequested
          ? await withTimeout(
              Promise.race([
                pendingNext.then((next) => ({ kind: "next" as const, next })),
                abortWake.then(() => ({ kind: "abort" as const })),
              ]),
              remaining,
              timeoutCode,
              timeoutMessageFor(currentPhase),
            )
          : { kind: "next" as const, next: await withTimeout(pendingNext, remaining, timeoutCode, timeoutMessageFor(currentPhase)) };
        let next: IteratorResult<string>;
        if (raced.kind === "abort") {
          if (!turnRequested || !threadId || !turnId) throw bridgeError("CANCELLED", "The turn was cancelled before turn startup.");
          await requestInterrupt();
          next = await withTimeout(
            pendingNext,
            Math.max(1, deadline - Date.now()),
            "INTERRUPT_TIMEOUT",
            "Codex did not acknowledge cancellation in time.",
          );
        } else {
          next = raced.next;
        }
        pendingNext = undefined;
        if (next.done) throw new CodexBridgeError("PROCESS_FAILURE", "Codex app-server exited before the turn completed.", "Restart Codex and retry the turn.");
        const message = parseMessage(next.value);

        if (message.method && message.id !== undefined) {
          const request = readServerRequest(message);
          const remaining = Math.max(1, deadline - Date.now());
          const code = timeoutCodeFor(phase);
          const resolution = validateResolution(await withAbort(
            withTimeout(
              Promise.resolve().then(() => this.#handleServerRequest(request)),
              remaining,
              code,
              "Thorax server request handling timed out.",
            ),
            options.signal,
          ));
          await withAbort(
            withTimeout(connection.send({ id: request.id, ...resolution }), remaining, code, "Writing a server request response timed out."),
            options.signal,
          );
          continue;
        }
        if (message.error) throw mapProtocolError(message.error);

        if (message.id === 1) {
          validateResponse(message, 1);
          asRecord(message.result);
          await withTimeout(connection.send({ method: "initialized" }), this.#timeouts.handshakeMs, "HANDSHAKE_TIMEOUT", "Writing the initialized notification timed out.");
          await withTimeout(
            connection.send({
              id: 2,
              method: options.threadId ? "thread/resume" : "thread/start",
              params: options.threadId
                ? { threadId: options.threadId, ...(options.cwd ? { cwd: options.cwd } : {}) }
                : options.cwd ? { cwd: options.cwd } : {},
            }),
            this.#timeouts.handshakeMs,
            "HANDSHAKE_TIMEOUT",
            "Writing the Codex thread request timed out.",
          );
          deadline = Date.now() + this.#timeouts.handshakeMs;
          continue;
        }
        if (message.id === 2) {
          validateResponse(message, 2);
          threadId = readNestedString(asRecord(message.result), "thread", "id");
          yield { type: options.threadId ? "thread.resumed" : "thread.started", threadId };
          if (options.signal?.aborted || abortRequested) throw bridgeError("CANCELLED", "The turn was cancelled before turn startup.");
          turnRequested = true;
          phase = "turn";
          deadline = Date.now() + this.#timeouts.turnMs;
          await withAbort(
            withTimeout(
              connection.send({ id: 3, method: "turn/start", params: { threadId, input: [{ type: "text", text: options.prompt }] } }),
              this.#timeouts.turnMs,
              "TURN_TIMEOUT",
              "Writing the Codex turn request timed out.",
            ),
            options.signal,
          );
          continue;
        }
        if (message.id === 3) {
          validateResponse(message, 3);
          const turn = asRecord(asRecord(message.result).turn);
          turnId = readString(turn, "id");
          readTurnStatus(turn.status, true);
          if (abortRequested || options.signal?.aborted) await requestInterrupt();
          continue;
        }
        if (message.id !== undefined) {
          validateResponse(message, message.id);
          continue;
        }

        const method = message.method;
        if (!method) throw malformed("Codex message has neither an id nor a method.");
        const params = asRecord(message.params);
        if (method === "turn/started") {
          threadId = readString(params, "threadId");
          turnId = readNestedString(params, "turn", "id");
          if (abortRequested || options.signal?.aborted) await requestInterrupt();
          yield { type: "turn.started", threadId, turnId };
          continue;
        }
        if (method === "item/agentMessage/delta") {
          yield {
            type: "message.delta",
            threadId: readString(params, "threadId"),
            turnId: readString(params, "turnId"),
            itemId: readString(params, "itemId"),
            delta: readString(params, "delta"),
          };
          continue;
        }
        if (method === "item/started" || method === "item/completed") {
          const item = asRecord(params.item);
          readString(item, "id");
          readString(item, "type");
          yield {
            type: method === "item/started" ? "item.started" : "item.completed",
            threadId: readString(params, "threadId"),
            turnId: readString(params, "turnId"),
            item,
          };
          continue;
        }
        if (method === "error") {
          const error = asRecord(params.error);
          const messageText = readString(error, "message");
          if (typeof params.willRetry !== "boolean") throw malformed("Codex error notification is missing willRetry.");
          if (!params.willRetry) throw mapProtocolError({ message: messageText });
          yield {
            type: "error",
            ...(typeof params.threadId === "string" ? { threadId: params.threadId } : {}),
            ...(typeof params.turnId === "string" ? { turnId: params.turnId } : {}),
            message: messageText,
          };
          continue;
        }
        if (method === "turn/completed") {
          const completedThreadId = readString(params, "threadId");
          const turn = asRecord(params.turn);
          const completedTurnId = readString(turn, "id");
          const status = readCompletedTurnStatus(turn.status);
          if (!Array.isArray(turn.items)) throw malformed("Codex completed turn is missing items.");
          completed = true;
          yield { type: "turn.completed", threadId: completedThreadId, turnId: completedTurnId, status };
        }
      }
    } catch (error) {
      activeError = error instanceof CodexBridgeError ? error : new CodexBridgeError("PROCESS_FAILURE", errorMessage(error), "Restart Codex and retry the turn.", undefined, { cause: error });
    } finally {
      options.signal?.removeEventListener("abort", onAbort);
      try {
        await withTimeout(connection.close(), this.#timeouts.shutdownMs, "SHUTDOWN_TIMEOUT", "Codex app-server did not shut down in time.");
      } catch (error) {
        await withTimeout(connection.terminate(), this.#timeouts.shutdownMs, "SHUTDOWN_TIMEOUT", "Forced Codex shutdown timed out.").catch(() => undefined);
        if (!activeError) {
          if (error instanceof CodexBridgeError) activeError = error;
          else activeError = new CodexBridgeError("PROCESS_FAILURE", "Codex app-server cleanup failed.", "Restart Codex and retry.", undefined, { cause: error });
        }
      }
      if (activeError) throw activeError;
    }
  }
}

export class NodeProcessTransport implements ProcessTransport {
  run(command: string, args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    return new Promise((resolve, reject) => {
      execFile(command, args, { windowsHide: true, timeout: 10_000, killSignal: "SIGKILL" }, (error, stdout, stderr) => {
        if (error && "code" in error && typeof error.code === "string") return reject(error);
        resolve({ stdout, stderr, exitCode: typeof error?.code === "number" ? error.code : error ? 1 : 0 });
      });
    });
  }

  open(command: string, args: string[]): Promise<AppServerConnection> {
    return new Promise((resolve, reject) => {
      const child = spawn(command, args, { windowsHide: true, stdio: "pipe" });
      const onError = (error: Error) => reject(error);
      child.once("error", onError);
      child.once("spawn", () => {
        child.off("error", onError);
        resolve(new NodeAppServerConnection(child));
      });
    });
  }
}

class NodeAppServerConnection implements AppServerConnection {
  #failure: Error | undefined;

  constructor(private readonly child: ChildProcessWithoutNullStreams) {
    child.stderr.on("data", (data) => console.error("CODEX APP-SERVER STDERR:", data.toString().trim()));
    child.on("error", (error) => { this.#failure = error; });
  }

  send(message: RpcMessage): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.child.stdin.writable || this.child.stdin.destroyed) return reject(new Error("Codex app-server stdin is closed."));
      console.error("CODEX APP-SERVER SENDING:", JSON.stringify(message));
      this.child.stdin.write(`${JSON.stringify(message)}\n`, (error) => error ? reject(error) : resolve());
    });
  }

  async *messages(): AsyncIterable<string> {
    const lines = createInterface({ input: this.child.stdout, crlfDelay: Infinity });
    for await (const line of lines) {
      if (line.trim()) {
        console.error("CODEX APP-SERVER RECEIVED:", line);
        yield line;
      }
    }
    if (this.#failure) throw this.#failure;
  }

  close(): Promise<void> {
    if (this.child.exitCode !== null || this.child.killed) return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => resolve();
      this.child.once("exit", done);
      this.child.once("close", done);
      this.child.stdin.end();
    });
  }

  async terminate(): Promise<void> {
    this.child.stdin.destroy();
    this.child.stdout.destroy();
    this.child.stderr.destroy();
    if (this.child.exitCode !== null) return;
    if (process.platform === "win32" && this.child.pid) {
      const { command, args } = windowsProcessTreeCommand(this.child.pid);
      try {
        await execFilePromise(command, args, 5_000);
        return;
      } catch {
        // Fall back to the direct child if taskkill races with normal exit.
      }
    }
    if (!this.child.killed) this.child.kill("SIGKILL");
  }
}

export function windowsProcessTreeCommand(pid: number): { command: string; args: string[] } {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("Process id must be a positive integer");
  return { command: "taskkill.exe", args: ["/PID", String(pid), "/T", "/F"] };
}

function execFilePromise(command: string, args: string[], timeout: number): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { windowsHide: true, timeout, killSignal: "SIGKILL" }, (error) => error ? reject(error) : resolve());
  });
}

function parseMessage(line: string): RpcMessage {
  let value: unknown;
  try { value = JSON.parse(line); } catch (error) { throw malformed("Codex app-server emitted malformed JSON.", error); }
  const message = asRecord(value) as RpcMessage;
  if (message.id !== undefined && typeof message.id !== "number" && typeof message.id !== "string") throw malformed("Codex message has an invalid id.");
  if (message.method !== undefined && typeof message.method !== "string") throw malformed("Codex message has an invalid method.");
  if (message.error !== undefined) {
    const error = asRecord(message.error);
    if (typeof error.message !== "string") throw malformed("Codex error response is missing a message.");
  }
  return message;
}

function validateResponse(message: RpcMessage, expectedId: RpcId): void {
  if (message.method !== undefined || message.id !== expectedId) throw malformed(`Unexpected Codex response for request ${String(expectedId)}.`);
  const hasResult = Object.prototype.hasOwnProperty.call(message, "result");
  const hasError = Object.prototype.hasOwnProperty.call(message, "error");
  if (hasResult === hasError) throw malformed("Codex response must contain exactly one of result or error.");
}

function readServerRequest(message: RpcMessage): ServerRequest {
  if (message.id === undefined || !message.method) throw malformed("Codex server request is missing id or method.");
  return { id: message.id, method: message.method, params: asRecord(message.params) };
}

function validateResolution(value: ServerRequestResolution): ServerRequestResolution {
  const record = asRecord(value);
  const hasResult = Object.prototype.hasOwnProperty.call(record, "result");
  const hasError = Object.prototype.hasOwnProperty.call(record, "error");
  if (hasResult === hasError) throw new CodexBridgeError("PROTOCOL_ERROR", "Server request handler returned an invalid response.", "Fix the Thorax server request handler.");
  if (hasError) {
    const error = asRecord(record.error);
    if (typeof error.message !== "string") throw new CodexBridgeError("PROTOCOL_ERROR", "Server request handler returned an invalid error.", "Fix the Thorax server request handler.");
  }
  return value;
}

function safeServerRequestPolicy(request: ServerRequest): ServerRequestResolution {
  if (request.method === "item/commandExecution/requestApproval" || request.method === "item/fileChange/requestApproval") return { result: { decision: "decline" } };
  if (request.method === "execCommandApproval" || request.method === "applyPatchApproval") return { result: { decision: "denied" } };
  if (request.method === "mcpServer/elicitation/request") return { result: { action: "decline", content: null, _meta: null } };
  if (request.method === "item/tool/requestUserInput") return serverRequestError("Thorax has no user input handler for this request.");
  if (request.method === "account/chatgptAuthTokens/refresh") return serverRequestError("Thorax will not handle token contents; refresh authentication with `codex login`.");
  if (request.method === "item/permissions/requestApproval") return serverRequestError("Thorax does not grant runtime permissions automatically.");
  return serverRequestError(`Thorax does not support app-server request ${request.method}.`);
}

function serverRequestError(message: string): ServerRequestResolution {
  return { error: { code: -32601, message } };
}

function mapProtocolError(error: RpcError): CodexBridgeError {
  if (isExplicitlyExpired(error.message)) return new CodexBridgeError("AUTH_EXPIRED", error.message, REFRESH_ACTION, error.data);
  if (isAuthRequired(error.message)) return new CodexBridgeError("AUTH_REQUIRED", error.message, LOGIN_ACTION, error.data);
  return new CodexBridgeError("PROTOCOL_ERROR", error.message, "Update Codex CLI and retry the turn.", error.data);
}

function isExplicitlyExpired(message: string): boolean {
  return /(?:access|refresh|authentication|auth) token (?:has )?(?:expired|revoked|invalid)|refresh token failure/i.test(message);
}

function isAuthRequired(message: string): boolean {
  return /not logged in|signed out|login required|authentication required|unauthorized|no (?:chatgpt )?credentials/i.test(message);
}

function readNestedString(record: Record<string, unknown>, key: string, nestedKey: string): string {
  return readString(asRecord(record[key]), nestedKey);
}

function readString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || !value) throw malformed(`Codex event is missing ${key}.`);
  return value;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw malformed("Codex event has an invalid payload.");
  return value as Record<string, unknown>;
}

function readTurnStatus(value: unknown, allowInProgress: boolean): "completed" | "interrupted" | "failed" | "inProgress" {
  if (value === "completed" || value === "interrupted" || value === "failed" || (allowInProgress && value === "inProgress")) return value;
  throw malformed("Codex turn has an invalid status.");
}

function readCompletedTurnStatus(value: unknown): "completed" | "interrupted" | "failed" {
  if (value === "completed" || value === "interrupted" || value === "failed") return value;
  throw malformed("Codex completed turn has an invalid status.");
}

function timeoutCodeFor(phase: "handshake" | "turn" | "interrupt"): BridgeErrorCode {
  if (phase === "handshake") return "HANDSHAKE_TIMEOUT";
  if (phase === "interrupt") return "INTERRUPT_TIMEOUT";
  return "TURN_TIMEOUT";
}

function timeoutMessageFor(phase: "handshake" | "turn" | "interrupt"): string {
  if (phase === "handshake") return "Codex app-server handshake timed out.";
  if (phase === "interrupt") return "Codex did not acknowledge cancellation in time.";
  return "Codex turn timed out.";
}

function malformed(message: string, cause?: unknown): CodexBridgeError {
  return new CodexBridgeError("MALFORMED_EVENT", message, PROTOCOL_ACTION, undefined, cause === undefined ? undefined : { cause });
}

function bridgeError(code: BridgeErrorCode, message: string): CodexBridgeError {
  return new CodexBridgeError(code, message, code.endsWith("TIMEOUT") ? "Restart Codex and retry the turn." : "Retry when ready.");
}

function withTimeout<T>(promise: Promise<T>, ms: number, code: BridgeErrorCode, message: string): Promise<T> {
  if (!Number.isFinite(ms) || ms <= 0) return Promise.reject(bridgeError(code, message));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(bridgeError(code, message)), ms);
    timer.unref?.();
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
}

function withAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  let onAbort: (() => void) | undefined;
  const aborted = signal.aborted
    ? new Promise<T>((_resolve, reject) => setTimeout(() => reject(bridgeError("CANCELLED", "The turn was cancelled.")), 0))
    : new Promise<T>((_resolve, reject) => {
      onAbort = () => reject(bridgeError("CANCELLED", "The turn was cancelled."));
      signal.addEventListener("abort", onAbort, { once: true });
    });
  return Promise.race([promise, aborted]).finally(() => {
    if (onAbort) signal.removeEventListener("abort", onAbort);
  });
}

function isMissingExecutable(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function cleanOutput(result: { stdout: string; stderr: string }): string { return `${result.stdout}\n${result.stderr}`.trim(); }
