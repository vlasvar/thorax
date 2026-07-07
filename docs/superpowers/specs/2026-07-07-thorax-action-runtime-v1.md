# Thorax Action Runtime Spec (v1)
### Stateful Workflows, Approvals, and Resumability

**Status:** Draft for developer handoff
**Follows:** `thorax-rds` (Skills), `thorax-f0u` (Adapter Contract)
**Implements:** `thorax-d5j` (Action Runtime Layer)

---

## 1. Why this exists

Basic chat turn loops (Operator Request -> Specialist Agent -> Codex response) are too ephemeral for real-world operations. If a task requires fetching rows from Excel, checking Gmail, updating SAP, and notifying the operator, it cannot happen reliably in a single chat turn.

We need an **Action Runtime Layer** that:
- Executes multi-step, stateful agent workflows.
- Handles long-running actions (e.g., waiting 10 minutes for email replies).
- Tolerates server restarts through **durable step persistence**.
- Integrates human approval gates directly into the workflow timeline.
- Logs full execution audit trails for security and debugging.

---

## 2. Architecture Overview

```
                ┌───────────────────────────────────┐
                │          Operator UI              │
                └─────────────────┬─────────────────┘
                                  │ (HTTP / SSE)
                                  ▼
                ┌───────────────────────────────────┐
                │       Thorax Server (API)         │
                └─────────────────┬─────────────────┘
                                  │
                                  ▼
┌───────────────────────────────────────────────────────────────────┐
│                    Action Runtime Engine                          │
│                                                                   │
│  ┌───────────────────────┐             ┌───────────────────────┐  │
│  │   Workflow Registry   │             │   Execution Scheduler │  │
│  └───────────────────────┘             └───────────────────────┘  │
│                                                                   │
│  ┌───────────────────────┐             ┌───────────────────────┐  │
│  │   State Store (SQL)   │             │     Approval Queue    │  │
│  └───────────────────────┘             └───────────────────────┘  │
└─────────────────────────────────┬─────────────────────────────────┘
                                  │
         ┌────────────────────────┼────────────────────────┐
         ▼                        ▼                        ▼
  ┌──────────────┐         ┌──────────────┐         ┌──────────────┐
  │ File Adapter │         │ Excel Adap.  │         │ Gmail Adap.  │
  └──────────────┘         └──────────────┘         └──────────────┘
```

The **Action Runtime Engine** manages state machines for running workflows. It reads workflow definitions, schedules execution steps, persists state, processes retries, and yields control when human approval is required.

---

## 3. Workflow Definition Schema

Workflows are declared as versioned JSON files inside `<project>/.thorax/workflows/<workflow-id>.json`:

```json
{
  "id": "lease-reconciliation",
  "version": "1.0.0",
  "description": "Reconciles incoming lease notices with the tracking sheet",
  "trigger": {
    "type": "schedule | event",
    "value": "*/15 * * * *"
  },
  "context_schema": {
    "type": "object",
    "properties": {
      "workbook_path": { "type": "string" },
      "unprocessed_emails": { "type": "array", "items": { "type": "object" } }
    }
  },
  "steps": [
    {
      "id": "fetch_emails",
      "type": "action",
      "adapter": "gmail",
      "action": "list_unread_emails",
      "input": {
        "query": "subject:'Lease Update'"
      },
      "output_path": "context.unprocessed_emails",
      "retry": {
        "max_attempts": 3,
        "backoff_ms": 1000
      }
    },
    {
      "id": "process_each_lease",
      "type": "loop",
      "over": "context.unprocessed_emails",
      "item_name": "email",
      "steps": [
        {
          "id": "extract_details",
          "type": "agent_turn",
          "agent": "research",
          "prompt": "Extract lease_id, tenant, start_date, and rent from: ${email.body}",
          "output_path": "email.lease_details"
        },
        {
          "id": "update_sheet",
          "type": "action",
          "adapter": "excel",
          "action": "update_lease_row",
          "input": {
            "workbook_path": "context.workbook_path",
            "lease_id": "email.lease_details.lease_id",
            "updates": "email.lease_details"
          }
        }
      ]
    }
  ]
}
```

### Supported Step Types:
1. `action`: Dispatches to an adapter (with automatic dry-run/approval hooks).
2. `agent_turn`: Invokes a specialist agent turn using Codex to produce structured output.
3. `loop`: Iterates over an array in the context.
4. `conditional`: Branches execution based on a JS expression.

---

## 4. Execution State Machine & Resumability

To guarantee that workflows survive server crashes, the Engine writes every step result to a local SQLite database (`.thorax/state.db`) in a single transaction.

```
 [Created] ──► [Running] ──► [Step Success] ──► [Durable Save] ──┐
                  ▲                                              │
                  │                                              ▼
                  └─────────────────────────────────────── [Next Step]
                                                                 │
 [Failed] ◄── [Max Retries] ◄── [Transient Fail] ◄───────────────┤
                                                                 │
 [Suspended] ◄── [Awaiting Approval] ◄── [Write Action] ◄────────┘
```

### State Store Schema (`workflow_executions`):
* `execution_id` (UUID)
* `workflow_id` (string)
* `status`: `running | suspended | completed | failed`
* `current_step_id` (string)
* `context` (JSON block)
* `step_logs` (JSON array of executed steps with durations and errors)
* `updated_at` (timestamp)

At server startup, the engine scans the table for any executions in the `running` state and automatically resumes them from `current_step_id`.

---

## 5. Human-in-the-Loop Approval Gating

When a step is of type `action`, and the action risk tier requires approval (`write_irreversible` or `external_side_effect`):

1. The Engine executes the action in `dry_run` mode.
2. The Engine saves the `diff_preview` in the execution state.
3. The Engine transitions the execution status to `suspended` and writes to the `approval_queue` table.
4. The Engine broadcasts an SSE/WebSocket update to the Operator UI.
5. The execution remains paused until the operator calls `/api/workflows/execute/:id/approve` or `/api/workflows/execute/:id/reject`.
   - **Approve**: Engine commits the action using `approved_by: "operator"`, updates the context, and resumes the workflow.
   - **Reject**: Engine cancels the execution, records the rejection, and transitions state to `failed` (rejection reason is logged).

---

## 6. Audit Logging & Verification

Every action executed by the runtime produces a durable, immutable audit record inside `.thorax/audit.log` (JSONL format):

```json
{
  "timestamp": "2026-07-07T10:30:00.123Z",
  "execution_id": "8f8e811c-2df5-4a69-826f-47dc3ad34ef3",
  "workflow_id": "lease-reconciliation",
  "step_id": "update_sheet",
  "adapter": "excel",
  "action": "update_lease_row",
  "mode": "commit",
  "risk_tier": "write_irreversible",
  "approved_by": "operator",
  "duration_ms": 340,
  "status": "success"
}
```

---

## 7. Next Steps for Implementation

To build this Action Runtime layer:
1. **Engine Foundation**: Build `WorkflowEngine` class that executes steps, manages context variables, and loads definitions.
2. **Durable Storage**: Implement SQL schema and repository for `workflow_executions` and `approval_queue`.
3. **HTTP Server API**: Add endpoints:
   - `GET /api/workflows` — list registered workflow definitions.
   - `POST /api/workflows/trigger` — start an execution.
   - `GET /api/workflows/executions` — list active/completed workflow executions.
   - `POST /api/workflows/executions/:id/approve` — approve a suspended action.
4. **UI Integration**: Render a "Workflow Runs" and "Approval Queue" dashboard tab to show active workflows, execution logs, and pending diff approvals.
