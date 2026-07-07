import type { AdapterAction, AdapterCommitResult, AdapterDryRunResult, AdapterManifest } from "@thorax/shared-types";

// ─── Errors ──────────────────────────────────────────────────────────────────

export class ApprovalRequiredError extends Error {
  readonly code = "APPROVAL_REQUIRED" as const;
  constructor(action: string, risk_tier: string) {
    super(`Action '${action}' has risk tier '${risk_tier}' and requires explicit approval (approved_by) before committing.`);
  }
}

export class UnknownActionError extends Error {
  readonly code = "UNKNOWN_ACTION" as const;
  constructor(adapterId: string, action: string) {
    super(`Adapter '${adapterId}' has no action named '${action}'.`);
  }
}

export class UnknownAdapterError extends Error {
  readonly code = "UNKNOWN_ADAPTER" as const;
  constructor(adapterId: string) {
    super(`No adapter registered with id '${adapterId}'.`);
  }
}

// ─── Adapter Port (interface every adapter implements) ────────────────────────

export interface AdapterPort {
  /** Dry-run a single action — MUST NOT touch real state. */
  dryRun(action: string, input: Record<string, unknown>): Promise<AdapterDryRunResult>;
  /** Commit a single action after dry-run approval. */
  commit(action: string, input: Record<string, unknown>): Promise<AdapterCommitResult>;
}

// ─── Dispatch Registry ────────────────────────────────────────────────────────

export interface DispatchRequest {
  adapterId: string;
  action: string;
  input: Record<string, unknown>;
  mode: "dry_run" | "commit";
  approved_by?: string | undefined;
}

export class DispatchRegistry {
  readonly #adapters = new Map<string, { port: AdapterPort; manifest: AdapterManifest }>();

  register(manifest: AdapterManifest, port: AdapterPort): void {
    this.#adapters.set(manifest.adapter, { port, manifest });
  }

  async dispatch(request: DispatchRequest): Promise<AdapterDryRunResult | AdapterCommitResult> {
    const entry = this.#adapters.get(request.adapterId);
    if (!entry) throw new UnknownAdapterError(request.adapterId);

    const actionDef = entry.manifest.actions.find((a) => a.name === request.action);
    if (!actionDef) throw new UnknownActionError(request.adapterId, request.action);

    // Risk tier enforcement — read_only actions always bypass approval
    if (request.mode === "commit" && !isAutoApprovable(actionDef)) {
      if (!request.approved_by?.trim()) {
        throw new ApprovalRequiredError(request.action, actionDef.risk_tier);
      }
    }

    if (request.mode === "dry_run") {
      return entry.port.dryRun(request.action, request.input);
    }
    return entry.port.commit(request.action, request.input);
  }

  has(adapterId: string): boolean {
    return this.#adapters.has(adapterId);
  }
}

/**
 * read_only actions never need approval.
 * write_reversible actions can auto-commit (policy allows it by default per the spec).
 * write_irreversible and external_side_effect ALWAYS require approval.
 */
function isAutoApprovable(action: AdapterAction): boolean {
  return action.risk_tier === "read_only" || action.risk_tier === "write_reversible";
}

// ─── FakeAdapter ──────────────────────────────────────────────────────────────

export interface FakeAdapterCall {
  mode: "dry_run" | "commit";
  action: string;
  input: Record<string, unknown>;
}

export interface FakeAdapterOptions {
  /** Custom dry-run response factory. Defaults to a generic preview. */
  dryRunResponse?: (action: string, input: Record<string, unknown>) => AdapterDryRunResult;
  /** Custom commit response factory. Defaults to a generic result with a generated transaction_id. */
  commitResponse?: (action: string, input: Record<string, unknown>) => AdapterCommitResult;
}

export class FakeAdapter implements AdapterPort {
  readonly calls: FakeAdapterCall[] = [];
  readonly #opts: FakeAdapterOptions;

  constructor(opts: FakeAdapterOptions = {}) {
    this.#opts = opts;
  }

  async dryRun(action: string, input: Record<string, unknown>): Promise<AdapterDryRunResult> {
    this.calls.push({ mode: "dry_run", action, input });
    if (this.#opts.dryRunResponse) return this.#opts.dryRunResponse(action, input);
    return {
      mode: "dry_run",
      diff_preview: `[dry-run] Would execute '${action}' with input: ${JSON.stringify(input)}`,
      would_affect: [`fake-resource-${action}`],
      reversible: true,
    };
  }

  async commit(action: string, input: Record<string, unknown>): Promise<AdapterCommitResult> {
    this.calls.push({ mode: "commit", action, input });
    if (this.#opts.commitResponse) return this.#opts.commitResponse(action, input);
    return {
      mode: "commit",
      result: { ok: true },
      transaction_id: `fake-txn-${Date.now()}`,
    };
  }

  /** Resets the call log between tests. */
  reset(): void {
    this.calls.length = 0;
  }
}
