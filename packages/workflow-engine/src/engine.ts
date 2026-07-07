import { randomUUID } from "node:crypto";
import type {
  WorkflowDefinition,
  WorkflowExecution,
  WorkflowStep,
  StepExecutionLog,
  AdapterDryRunResult,
  AdapterCommitResult,
} from "@thorax/shared-types";
import type { AdapterRegistry, DispatchRegistry } from "@thorax/core";
import type { ExecutionStateStore } from "./store.js";

// ─── Interfaces ──────────────────────────────────────────────────────────────

export interface AgentRunner {
  runTurn(agentId: string, prompt: string): Promise<string>;
}

// ─── Path Resolver Helpers ───────────────────────────────────────────────────

export function getPathValue(path: string, context: Record<string, any>, item?: { name: string; value: any }): any {
  const parts = path.split(".");
  let current: any = context;
  if (item && parts[0] === item.name) {
    current = item.value;
    parts.shift();
  } else if (parts[0] === "context") {
    parts.shift();
  }
  for (const part of parts) {
    if (current === null || current === undefined) return undefined;
    current = current[part];
  }
  return current;
}

export function setPathValue(path: string, value: any, context: Record<string, any>, item?: { name: string; value: any }): void {
  const parts = path.split(".");
  let current: any = context;
  if (item && parts[0] === item.name) {
    current = item.value;
    parts.shift();
  } else if (parts[0] === "context") {
    parts.shift();
  }
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i]!;
    if (!current[part] || typeof current[part] !== "object") {
      current[part] = {};
    }
    current = current[part];
  }
  const lastPart = parts[parts.length - 1]!;
  current[lastPart] = value;
}

export function resolveValue(expression: unknown, context: Record<string, any>, item?: { name: string; value: any }): any {
  if (typeof expression === "string") {
    if (expression.includes("${")) {
      return expression.replace(/\$\{([^}]+)\}/g, (_, path) => {
        const val = getPathValue(path, context, item);
        return val !== undefined ? String(val) : "";
      });
    }
    if (expression.startsWith("context.") || (item && (expression === item.name || expression.startsWith(`${item.name}.`)))) {
      return getPathValue(expression, context, item);
    }
  }
  if (expression && typeof expression === "object" && !Array.isArray(expression)) {
    const resolvedObj: Record<string, any> = {};
    for (const [key, val] of Object.entries(expression)) {
      resolvedObj[key] = resolveValue(val, context, item);
    }
    return resolvedObj;
  }
  return expression;
}

// ─── WorkflowEngine ──────────────────────────────────────────────────────────

export class WorkflowEngine {
  readonly #store: ExecutionStateStore;
  readonly #adapters: AdapterRegistry;
  readonly #dispatch: DispatchRegistry;
  readonly #agentRunner: AgentRunner;

  constructor(
    store: ExecutionStateStore,
    adapters: AdapterRegistry,
    dispatch: DispatchRegistry,
    agentRunner: AgentRunner
  ) {
    this.#store = store;
    this.#adapters = adapters;
    this.#dispatch = dispatch;
    this.#agentRunner = agentRunner;
  }

  async start(definition: WorkflowDefinition, initialContext: Record<string, unknown> = {}): Promise<WorkflowExecution> {
    const execution: WorkflowExecution = {
      id: randomUUID(),
      workflowId: definition.id,
      status: "running",
      context: { ...initialContext },
      stepLogs: [],
      updatedAt: new Date().toISOString(),
    };
    this.#store.save(execution);

    // Run steps in background/async fashion but wait to return the execution state
    void this.#run(execution, definition.steps, undefined, true);
    return execution;
  }

  async resume(executionId: string, approved = true): Promise<WorkflowExecution | undefined> {
    const exec = this.#store.load(executionId);
    if (!exec) return undefined;
    if (exec.status !== "suspended") {
      throw new Error(`Execution '${executionId}' is not suspended (status is '${exec.status}').`);
    }

    // Retrieve active step details
    const lastLog = exec.stepLogs.at(-1);
    if (!lastLog || lastLog.status !== "suspended") {
      throw new Error("No suspended step found in step logs.");
    }

    // Retrieve workflow definition (we'll fetch it from the registry or pass a lookup helper)
    // For simplicity, we assume the caller passes or we can find it. Wait! Let's pass the definition inside resume
    // or let the engine have a registry of workflow definitions.
    // Let's add a registry of definitions or just have resume accept the definition!
    // Passing the definition to resume is very simple. Let's do that!
    return exec;
  }

  async resumeWithDefinition(
    executionId: string,
    definition: WorkflowDefinition,
    approved = true
  ): Promise<WorkflowExecution> {
    const exec = this.#store.load(executionId);
    if (!exec) throw new Error(`Execution '${executionId}' not found.`);
    if (exec.status !== "suspended") {
      throw new Error(`Execution '${executionId}' is not suspended (status is '${exec.status}').`);
    }

    const lastLog = exec.stepLogs.at(-1);
    if (!lastLog || lastLog.status !== "suspended") {
      throw new Error("No suspended step found in step logs.");
    }

    exec.status = "running";
    exec.updatedAt = new Date().toISOString();
    this.#store.save(exec);

    if (!approved) {
      lastLog.status = "failed";
      lastLog.completedAt = new Date().toISOString();
      lastLog.error = "Action rejected by operator.";
      exec.status = "failed";
      exec.updatedAt = new Date().toISOString();
      this.#store.save(exec);
      return exec;
    }

    // Find the step we suspended on
    const currentStepId = exec.currentStepId;
    const allSteps = this.#flattenSteps(definition.steps);
    const stepIdx = allSteps.findIndex((s) => s.id === currentStepId);
    if (stepIdx === -1) {
      throw new Error(`Step '${currentStepId}' not found in workflow definition.`);
    }

    const currentStep = allSteps[stepIdx]!;

    // Resolve dry-run request context/input
    const resolvedInput = resolveValue(currentStep.input ?? {}, exec.context);

    // Commit the action
    const startMs = Date.now();
    try {
      const commitRes = await this.#dispatch.dispatch({
        adapterId: currentStep.adapter!,
        action: currentStep.action!,
        input: resolvedInput,
        mode: "commit",
        approved_by: "operator",
      }) as AdapterCommitResult;

      // Update step log
      lastLog.status = "success";
      lastLog.completedAt = new Date().toISOString();
      lastLog.duration_ms = Date.now() - startMs;

      // Save output
      if (currentStep.output_path) {
        setPathValue(currentStep.output_path, commitRes.result, exec.context);
      }

      this.#store.save(exec);

      // Run remaining steps
      const remainingSteps = allSteps.slice(stepIdx + 1);
      void this.#run(exec, remainingSteps, undefined, true);
    } catch (err) {
      lastLog.status = "failed";
      lastLog.completedAt = new Date().toISOString();
      lastLog.error = err instanceof Error ? err.message : String(err);
      exec.status = "failed";
      exec.updatedAt = new Date().toISOString();
      this.#store.save(exec);
    }

    return exec;
  }

  // Flatten nested loop/conditional steps for resume indexing
  #flattenSteps(steps: WorkflowStep[]): WorkflowStep[] {
    const flat: WorkflowStep[] = [];
    for (const step of steps) {
      flat.push(step);
      if (step.steps) flat.push(...this.#flattenSteps(step.steps));
      if (step.then) flat.push(...this.#flattenSteps(step.then));
      if (step.otherwise) flat.push(...this.#flattenSteps(step.otherwise));
    }
    return flat;
  }

  async #run(exec: WorkflowExecution, steps: WorkflowStep[], loopItem?: { name: string; value: any }, isTopLevel = false): Promise<void> {
    for (const step of steps) {
      if (exec.status !== "running") return;

      exec.currentStepId = step.id;
      exec.updatedAt = new Date().toISOString();
      this.#store.save(exec);

      const logEntry: StepExecutionLog = {
        stepId: step.id,
        status: "running",
        startedAt: new Date().toISOString(),
      };
      exec.stepLogs.push(logEntry);
      this.#store.save(exec);

      const startMs = Date.now();

      try {
        switch (step.type) {
          case "action": {
            const adapterId = step.adapter!;
            const action = step.action!;
            const input = resolveValue(step.input ?? {}, exec.context, loopItem);

            const manifest = this.#adapters.get(adapterId);
            if (!manifest) throw new Error(`No manifest loaded for adapter '${adapterId}'.`);
            const actionDef = manifest.actions.find((a) => a.name === action);
            if (!actionDef) throw new Error(`Action '${action}' not found on adapter '${adapterId}'.`);

            // Execute dry_run first
            const dryRunRes = await this.#dispatch.dispatch({
              adapterId,
              action,
              input,
              mode: "dry_run",
            }) as AdapterDryRunResult;

            // Check if approval is required before committing
            const needsApproval = actionDef.risk_tier === "write_irreversible" || actionDef.risk_tier === "external_side_effect";
            if (needsApproval) {
              // Suspend workflow execution and await human confirmation
              logEntry.status = "suspended";
              logEntry.completedAt = new Date().toISOString();
              logEntry.duration_ms = Date.now() - startMs;
              exec.status = "suspended";
              exec.updatedAt = new Date().toISOString();
              this.#store.save(exec);
              return; // Halt step loop
            }

            // Otherwise execute commit directly
            const commitRes = await this.#dispatch.dispatch({
              adapterId,
              action,
              input,
              mode: "commit",
            }) as AdapterCommitResult;

            logEntry.status = "success";
            logEntry.completedAt = new Date().toISOString();
            logEntry.duration_ms = Date.now() - startMs;

            if (step.output_path) {
              setPathValue(step.output_path, commitRes.result, exec.context, loopItem);
            }
            break;
          }

          case "agent_turn": {
            const prompt = resolveValue(step.prompt!, exec.context, loopItem);
            const result = await this.#agentRunner.runTurn(step.agent!, prompt);
            
            logEntry.status = "success";
            logEntry.completedAt = new Date().toISOString();
            logEntry.duration_ms = Date.now() - startMs;

            if (step.output_path) {
              setPathValue(step.output_path, result, exec.context, loopItem);
            }
            break;
          }

          case "conditional": {
            const conditionPath = step.condition!;
            const conditionVal = getPathValue(conditionPath, exec.context, loopItem);

            logEntry.status = "success";
            logEntry.completedAt = new Date().toISOString();
            logEntry.duration_ms = Date.now() - startMs;

            const branchSteps = conditionVal ? (step.then ?? []) : (step.otherwise ?? []);
            await this.#run(exec, branchSteps, loopItem);
            break;
          }

          case "loop": {
            const arrayPath = step.over!;
            const items = getPathValue(arrayPath, exec.context, loopItem);

            logEntry.status = "success";
            logEntry.completedAt = new Date().toISOString();
            logEntry.duration_ms = Date.now() - startMs;

            if (Array.isArray(items)) {
              for (const itemVal of items) {
                const subItem = { name: step.item_name!, value: itemVal };
                await this.#run(exec, step.steps ?? [], subItem);
              }
            }
            break;
          }

          default:
            throw new Error(`Unsupported step type: '${step.type}'`);
        }

        this.#store.save(exec);
      } catch (err) {
        logEntry.status = "failed";
        logEntry.completedAt = new Date().toISOString();
        logEntry.error = err instanceof Error ? err.message : String(err);
        exec.status = "failed";
        exec.updatedAt = new Date().toISOString();
        this.#store.save(exec);
        return; // Halt step execution
      }
    }

    // If we completed the final step successfully
    if (isTopLevel && exec.status === "running") {
      exec.status = "completed";
      exec.updatedAt = new Date().toISOString();
      this.#store.save(exec);
    }
  }
}
