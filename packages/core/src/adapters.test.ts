import { describe, it, expect } from "vitest";
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { AdapterManifest } from "@thorax/shared-types";
import { AdapterRegistry } from "./adapters.js";

const validManifest = {
  adapter: "excel",
  version: "1.0.0",
  description: "Excel lease tracking adapter",
  auth: { type: "none" },
  actions: [
    {
      name: "read_lease_row",
      risk_tier: "read_only",
      description: "Reads a lease row by ID",
      input_schema: { type: "object", properties: { lease_id: { type: "string" } }, required: ["lease_id"] },
      output_schema: { type: "object" },
      dry_run_supported: true,
    },
    {
      name: "append_lease_row",
      risk_tier: "write_reversible",
      description: "Appends a new lease row",
      input_schema: { type: "object", properties: { row: { type: "object" } }, required: ["row"] },
      output_schema: { type: "object", properties: { row_index: { type: "integer" }, diff_preview: { type: "string" } } },
      dry_run_supported: true,
      rollback: { supported: true, method: "delete_row_by_index" },
    },
  ],
};

describe("AdapterRegistry", () => {
  it("loads a valid adapter manifest from disk", async () => {
    const dir = await mkdtemp(join(tmpdir(), "thorax-adapters-"));
    const adaptersDir = join(dir, ".thorax", "adapters");
    await mkdir(adaptersDir, { recursive: true });
    await writeFile(join(adaptersDir, "excel.json"), JSON.stringify(validManifest), "utf8");

    const registry = await AdapterRegistry.load(dir);
    const adapter = registry.get("excel");
    expect(adapter).toBeDefined();
    expect(adapter!.version).toBe("1.0.0");
    expect(adapter!.actions).toHaveLength(2);
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    expect(adapter!.actions.at(0)!.risk_tier).toBe("read_only");
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    expect(adapter!.actions.at(1)!.rollback?.method).toBe("delete_row_by_index");
  });

  it("silently ignores a missing .thorax/adapters directory", async () => {
    const dir = await mkdtemp(join(tmpdir(), "thorax-no-adapters-"));
    const registry = await AdapterRegistry.load(dir);
    expect(registry.list()).toHaveLength(0);
  });

  it("skips invalid manifests with a warning and loads the rest", async () => {
    const dir = await mkdtemp(join(tmpdir(), "thorax-adapters-mixed-"));
    const adaptersDir = join(dir, ".thorax", "adapters");
    await mkdir(adaptersDir, { recursive: true });
    await writeFile(join(adaptersDir, "valid.json"), JSON.stringify(validManifest), "utf8");
    await writeFile(join(adaptersDir, "invalid.json"), JSON.stringify({ adapter: "bad", missing: "fields" }), "utf8");

    const registry = await AdapterRegistry.load(dir);
    expect(registry.list()).toHaveLength(1);
    expect(registry.get("excel")).toBeDefined();
    expect(registry.get("bad")).toBeUndefined();
  });

  it("rejects manifests with an invalid risk_tier", async () => {
    const dir = await mkdtemp(join(tmpdir(), "thorax-adapters-risk-"));
    const adaptersDir = join(dir, ".thorax", "adapters");
    await mkdir(adaptersDir, { recursive: true });
    const bad = { ...validManifest, actions: [{ ...validManifest.actions[0], risk_tier: "not_a_tier" }] };
    await writeFile(join(adaptersDir, "bad-risk.json"), JSON.stringify(bad), "utf8");

    const registry = await AdapterRegistry.load(dir);
    expect(registry.list()).toHaveLength(0);
  });

  it("supports in-memory construction without filesystem", () => {
    const registry = new AdapterRegistry([validManifest as AdapterManifest]);
    expect(registry.get("excel")?.adapter).toBe("excel");
    expect(registry.list()).toHaveLength(1);
  });
});
