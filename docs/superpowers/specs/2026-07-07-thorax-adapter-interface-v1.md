# Thorax Adapter Interface Spec (v1)
### Generalizing `builder` → `operator` for non-coding domains

**Status:** Draft for developer handoff
**Precedes:** `thorax-d5j` (Action Runtime Layer)
**Depends on:** existing `.thorax/skills/*.json` mechanism from `thorax-rds`

---

## 1. Why this exists

Today, the `builder` specialist only knows how to act inside a dev environment: edit files, run tests, call git. To support non-coding business domains (SAP, Excel, Gmail, presentation tools), we need to decouple "the specialist that takes action" from "the specific system it acts on."

This spec defines:
- The renamed **`operator`** role (generalized `builder`)
- The **adapter contract** — a declared, versioned interface each integrated system must implement
- The **risk tier taxonomy** that drives whether an action can run automatically or needs approval
- The **dry-run contract**, which is mandatory, not optional

This is additive to the existing skill system — an adapter is a skill file with extra required fields plus a runnable implementation.

---

## 2. Core concepts

```
thorax-core (orchestrator)
      │
      ├── research specialist        (domain-agnostic, unchanged)
      ├── operator specialist        (was "builder" — now domain-generic)
      │       │
      │       ├── adapter: filesystem   (existing — code editing, tests)
      │       ├── adapter: excel        (new — pilot domain, see §6)
      │       ├── adapter: gmail        (new — reuse NanoClaw plumbing)
      │       └── adapter: sap          (future — phase 2, see §7)
      │
      └── reviewer specialist        (domain-agnostic, validates operator output)
```

The `operator` specialist never talks to SAP/Excel/Gmail directly. It only ever calls **declared actions** on an **adapter**, and every adapter call is intercepted by the (future) action runtime for logging, dry-run, and approval gating.

---

## 3. Adapter manifest schema

Every adapter ships a manifest at `<project>/.thorax/adapters/<adapter-name>.json`:

```json
{
  "adapter": "excel",
  "version": "1.0.0",
  "description": "Reads and writes local Excel/Google Sheets workbooks for lease tracking",
  "auth": {
    "type": "none | oauth | service_account | credentials_file",
    "config_ref": "path or env var name, never inline secrets"
  },
  "actions": [
    {
      "name": "read_lease_row",
      "risk_tier": "read_only",
      "description": "Reads a single lease row by ID from the tracking workbook",
      "input_schema": {
        "type": "object",
        "properties": {
          "workbook_path": { "type": "string" },
          "lease_id": { "type": "string" }
        },
        "required": ["workbook_path", "lease_id"]
      },
      "output_schema": {
        "type": "object",
        "properties": {
          "lease_id": { "type": "string" },
          "tenant": { "type": "string" },
          "start_date": { "type": "string" },
          "end_date": { "type": "string" },
          "rent": { "type": "number" }
        }
      },
      "dry_run_supported": true
    },
    {
      "name": "append_lease_row",
      "risk_tier": "write_reversible",
      "description": "Appends a new lease entry to the tracking workbook",
      "input_schema": {
        "type": "object",
        "properties": {
          "workbook_path": { "type": "string" },
          "row": { "type": "object" }
        },
        "required": ["workbook_path", "row"]
      },
      "output_schema": {
        "type": "object",
        "properties": {
          "row_index": { "type": "integer" },
          "diff_preview": { "type": "string" }
        }
      },
      "dry_run_supported": true,
      "rollback": {
        "supported": true,
        "method": "delete_row_by_index"
      }
    }
  ]
}
```

**Required fields per action**, no exceptions:
- `risk_tier` (see §4)
- `input_schema` / `output_schema` (JSON Schema, so `thorax-core` can validate before dispatch)
- `dry_run_supported` (boolean — if `false`, the action is automatically escalated to manual approval regardless of risk tier, since you can't preview it safely)

---

## 4. Risk tier taxonomy

Four tiers, each with a fixed approval behavior. This is intentionally simple — resist the urge to add more tiers later; ambiguity gets resolved by escalating up, not by adding a tier 2.5.

| Tier | Meaning | Default behavior |
|---|---|---|
| `read_only` | No state change anywhere (reads, queries, searches) | Runs automatically, always logged |
| `write_reversible` | Changes state, but a rollback method exists and is cheap (append a row, create a draft email, write a new file) | Runs automatically **only** if dry-run diff was shown and auto-approval policy allows this adapter+action; otherwise queued for approval |
| `write_irreversible` | Changes state with no clean rollback (send an email, submit a SAP posting, delete a record) | **Always** requires explicit human approval of the dry-run diff, no exceptions, no policy override |
| `external_side_effect` | Action has consequences outside the system of record entirely (notifies a third party, triggers a payment, changes a legal document status) | Always requires approval **and** a named human approver is logged against the transaction (not just "approved," but "approved by Vlassis at 14:02") |

A lease entered into SAP is `write_irreversible` at minimum, arguably `external_side_effect` if it feeds downstream reporting or triggers accounting entries. An Excel tracking-sheet row is `write_reversible`. This tiering is why Excel is the right pilot and SAP is not — you want to prove the whole approval/dry-run/rollback loop somewhere the worst case is "delete a row," not "wrong number in a regulated ledger."

---

## 5. Dry-run contract

Every non-`read_only` action must implement a dry-run mode that returns a **human-readable diff preview** without touching real state. This is the single most important part of this spec — it's what makes the approval queue reviewable in seconds instead of requiring the operator to re-derive what an action will do from its description.

```
operator calls: adapter.execute(action, input, mode="dry_run")
  → returns: { diff_preview: string, would_affect: [...], reversible: bool }

operator/core presents diff_preview to human
human approves →
operator calls: adapter.execute(action, input, mode="commit")
  → returns: { result, transaction_id, rollback_token? }
```

`diff_preview` should read like a code review diff, adapted to the domain:
- Excel: `"+ Row 47: Lease ID L-2231, Tenant 'ΕΥΔΑΠ', Start 2026-08-01, Rent €4,200/mo"`
- Gmail: `"Draft to: tenant@example.com | Subject: Change of Ownership Notice | Body: [preview]"`
- SAP (future): `"Would post lease contract 4500123456, company code 1000, effective 2026-08-01"`

---

## 6. Pilot adapter: Excel/Sheets (build this first)

Scope for v1, deliberately small:
- `read_lease_row`, `append_lease_row`, `update_lease_row` (the last one is `write_reversible` only if the adapter keeps an undo log — otherwise treat as `write_irreversible`)
- Local `.xlsx` via a library like `openpyxl`/SheetJS equivalent, no cloud auth needed for v1 — save Google Sheets OAuth for v1.1
- This proves: manifest schema, dry-run diff rendering, rollback token, and the approval queue UI end-to-end, with zero risk to any system of record

## 7. Future adapter: SAP (do not build yet)

When you do get here (post credibility-building, with IT/Basis buy-in):
- Start with **read-only** actions only (`read_lease_contract`, `read_building_master_data`) — this alone is useful (agents can answer questions, do research/reconciliation) with zero write risk
- Do not attempt UI-automation (RPA) against production SAP without your IT/Basis team's explicit sign-off — this is a "ask permission first" domain, not a "build it and demo it" domain, given the regulatory/audit context of real estate financial records
- Any write action is `external_side_effect` by definition, full stop

---

## 8. What to hand the developer as the actual work items

1. Extend the existing skill-loader (`thorax-rds`) to also load `.thorax/adapters/*.json` manifests and validate them against the schema in §3.
2. Rename `builder` → `operator` in code/config (mechanical rename, no behavior change yet).
3. Implement the dry-run/commit dispatch contract in §5 as the calling convention `operator` uses — this can be built and tested against a fake/mock adapter before any real one exists.
4. Build the Excel adapter (§6) as the first real integration end-to-end.
5. Wire a minimal approval surface (even a CLI prompt or Telegram message is fine for v1) that shows `diff_preview` and accepts approve/reject — this doesn't need to wait for the full `thorax-d5j` action runtime; it can be a stub that the real runtime later replaces.

This order lets you demo "an agent that safely proposes and, on approval, makes a real change" within one adapter, before touching anything domain-risky.
