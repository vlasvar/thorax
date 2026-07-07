import { describe, it, expect, beforeEach } from "vitest";
import type { AdapterManifest } from "@thorax/shared-types";
import {
  DispatchRegistry,
  FakeAdapter,
  ApprovalRequiredError,
  UnknownActionError,
  UnknownAdapterError,
} from "./dispatch.js";

const fakeManifest: AdapterManifest = {
  adapter: "fake",
  version: "1.0.0",
  description: "Test double adapter",
  auth: { type: "none" },
  actions: [
    {
      name: "read_data",
      risk_tier: "read_only",
      description: "Reads data, no state change",
      input_schema: { type: "object" },
      output_schema: { type: "object" },
      dry_run_supported: true,
    },
    {
      name: "write_row",
      risk_tier: "write_reversible",
      description: "Appends a row (reversible)",
      input_schema: { type: "object" },
      output_schema: { type: "object" },
      dry_run_supported: true,
      rollback: { supported: true, method: "delete_row" },
    },
    {
      name: "send_notice",
      risk_tier: "write_irreversible",
      description: "Sends a notice, cannot be undone",
      input_schema: { type: "object" },
      output_schema: { type: "object" },
      dry_run_supported: true,
    },
    {
      name: "post_ledger",
      risk_tier: "external_side_effect",
      description: "Posts to external ledger",
      input_schema: { type: "object" },
      output_schema: { type: "object" },
      dry_run_supported: true,
    },
  ],
};

describe("DispatchRegistry", () => {
  let registry: DispatchRegistry;
  let adapter: FakeAdapter;

  beforeEach(() => {
    registry = new DispatchRegistry();
    adapter = new FakeAdapter();
    registry.register(fakeManifest, adapter);
  });

  it("dispatches read_only action in dry_run without approval", async () => {
    const result = await registry.dispatch({ adapterId: "fake", action: "read_data", input: {}, mode: "dry_run" });
    expect(result.mode).toBe("dry_run");
    expect(adapter.calls).toHaveLength(1);
    expect(adapter.calls[0]?.mode).toBe("dry_run");
  });

  it("dispatches read_only action in commit without approval", async () => {
    const result = await registry.dispatch({ adapterId: "fake", action: "read_data", input: {}, mode: "commit" });
    expect(result.mode).toBe("commit");
  });

  it("dispatches write_reversible dry_run without approval", async () => {
    const result = await registry.dispatch({ adapterId: "fake", action: "write_row", input: { row: 1 }, mode: "dry_run" });
    expect(result.mode).toBe("dry_run");
    if (result.mode === "dry_run") expect(result.diff_preview).toBeTruthy();
  });

  it("dispatches write_reversible commit without approval (auto-approvable)", async () => {
    const result = await registry.dispatch({ adapterId: "fake", action: "write_row", input: { row: 1 }, mode: "commit" });
    expect(result.mode).toBe("commit");
  });

  it("refuses write_irreversible commit without approved_by", async () => {
    await expect(
      registry.dispatch({ adapterId: "fake", action: "send_notice", input: {}, mode: "commit" })
    ).rejects.toThrow(ApprovalRequiredError);
  });

  it("allows write_irreversible commit with approved_by", async () => {
    const result = await registry.dispatch({ adapterId: "fake", action: "send_notice", input: {}, mode: "commit", approved_by: "vlassis" });
    expect(result.mode).toBe("commit");
    expect(adapter.calls.at(-1)?.mode).toBe("commit");
  });

  it("refuses external_side_effect commit without approved_by", async () => {
    await expect(
      registry.dispatch({ adapterId: "fake", action: "post_ledger", input: {}, mode: "commit" })
    ).rejects.toThrow(ApprovalRequiredError);
  });

  it("throws UnknownAdapterError for unknown adapter", async () => {
    await expect(
      registry.dispatch({ adapterId: "nonexistent", action: "read_data", input: {}, mode: "dry_run" })
    ).rejects.toThrow(UnknownAdapterError);
  });

  it("throws UnknownActionError for unknown action on known adapter", async () => {
    await expect(
      registry.dispatch({ adapterId: "fake", action: "no_such_action", input: {}, mode: "dry_run" })
    ).rejects.toThrow(UnknownActionError);
  });
});

describe("FakeAdapter", () => {
  it("records every call in the call log", async () => {
    const fake = new FakeAdapter();
    await fake.dryRun("some_action", { x: 1 });
    await fake.commit("some_action", { x: 2 });
    expect(fake.calls).toHaveLength(2);
    expect(fake.calls[0]).toMatchObject({ mode: "dry_run", action: "some_action" });
    expect(fake.calls[1]).toMatchObject({ mode: "commit", action: "some_action" });
  });

  it("reset() clears the call log", async () => {
    const fake = new FakeAdapter();
    await fake.dryRun("x", {});
    fake.reset();
    expect(fake.calls).toHaveLength(0);
  });

  it("uses custom dryRunResponse factory when provided", async () => {
    const fake = new FakeAdapter({
      dryRunResponse: (action) => ({ mode: "dry_run", diff_preview: `custom preview for ${action}`, would_affect: [], reversible: false }),
    });
    const result = await fake.dryRun("my_action", {});
    expect(result.diff_preview).toBe("custom preview for my_action");
    expect(result.reversible).toBe(false);
  });

  it("uses custom commitResponse factory when provided", async () => {
    const fake = new FakeAdapter({
      commitResponse: (_action, _input) => ({ mode: "commit", result: { rows: 5 }, transaction_id: "txn-abc", rollback_token: "rt-1" }),
    });
    const result = await fake.commit("append", {});
    if (result.mode === "commit") {
      expect(result.transaction_id).toBe("txn-abc");
      expect(result.rollback_token).toBe("rt-1");
    }
  });
});
