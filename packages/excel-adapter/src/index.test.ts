import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { existsSync } from "node:fs";
import { ExcelAdapter } from "./index.js";
import xlsx from "xlsx";

describe("ExcelAdapter", () => {
  let adapter: ExcelAdapter;
  let tmpDir: string;
  let workbookPath: string;

  beforeEach(async () => {
    adapter = new ExcelAdapter();
    tmpDir = await mkdtemp(join(tmpdir(), "thorax-excel-test-"));
    workbookPath = join(tmpDir, "leases.xlsx");
  });

  afterEach(async () => {
    if (existsSync(tmpDir)) {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("handles non-existent workbook automatically by creating it with headers", async () => {
    // read non-existent
    const result = await adapter.dryRun("read_lease_row", {
      workbook_path: workbookPath,
      lease_id: "L1"
    });
    expect(result.mode).toBe("dry_run");
    expect(result.diff_preview).toContain("No lease found with id 'L1'");
    expect(existsSync(workbookPath)).toBe(false); // dryRun shouldn't write it yet
  });

  it("appends a lease row on commit and creates the workbook if it doesn't exist", async () => {
    const appendDry = await adapter.dryRun("append_lease_row", {
      workbook_path: workbookPath,
      row: { lease_id: "L1", tenant: "Alice", start_date: "2026-01-01", end_date: "2026-12-31", rent: 1500 }
    });
    expect(appendDry.mode).toBe("dry_run");
    expect(appendDry.diff_preview).toContain("lease_id: L1, tenant: Alice");
    expect(existsSync(workbookPath)).toBe(false);

    const appendCommit = await adapter.commit("append_lease_row", {
      workbook_path: workbookPath,
      row: { lease_id: "L1", tenant: "Alice", start_date: "2026-01-01", end_date: "2026-12-31", rent: 1500 }
    });
    expect(appendCommit.mode).toBe("commit");
    expect(existsSync(workbookPath)).toBe(true);

    const readCommit = await adapter.commit("read_lease_row", {
      workbook_path: workbookPath,
      lease_id: "L1"
    });
    expect(readCommit.mode).toBe("commit");
    expect(readCommit.result).toMatchObject({
      lease_id: "L1",
      tenant: "Alice",
      rent: 1500
    });
  });

  it("updates an existing lease row on commit", async () => {
    // First append one row
    await adapter.commit("append_lease_row", {
      workbook_path: workbookPath,
      row: { lease_id: "L1", tenant: "Alice", rent: 1500 }
    });

    const updateDry = await adapter.dryRun("update_lease_row", {
      workbook_path: workbookPath,
      lease_id: "L1",
      updates: { rent: 1600 }
    });
    expect(updateDry.mode).toBe("dry_run");
    expect(updateDry.diff_preview).toContain("before: lease_id: L1, tenant: Alice, rent: 1500");
    expect(updateDry.diff_preview).toContain("after: lease_id: L1, tenant: Alice, rent: 1600");

    const updateCommit = await adapter.commit("update_lease_row", {
      workbook_path: workbookPath,
      lease_id: "L1",
      updates: { rent: 1600 }
    });
    expect(updateCommit.mode).toBe("commit");

    const readCommit = await adapter.commit("read_lease_row", {
      workbook_path: workbookPath,
      lease_id: "L1"
    });
    expect(readCommit.result).toMatchObject({
      lease_id: "L1",
      tenant: "Alice",
      rent: 1600
    });
  });
});
