import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import type { AdapterPort } from "@thorax/core";
import type { AdapterCommitResult, AdapterDryRunResult } from "@thorax/shared-types";

// xlsx is a CommonJS package — import default
import xlsx from "xlsx";

// ─── Input shape helpers ──────────────────────────────────────────────────────

function requireString(input: Record<string, unknown>, key: string): string {
  const v = input[key];
  if (typeof v !== "string" || !v.trim()) throw new Error(`Input field '${key}' must be a non-empty string.`);
  return v.trim();
}

function requireObject(input: Record<string, unknown>, key: string): Record<string, unknown> {
  const v = input[key];
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error(`Input field '${key}' must be an object.`);
  return v as Record<string, unknown>;
}

// ─── Workbook helpers ─────────────────────────────────────────────────────────

function loadWorkbook(workbookPath: string): ReturnType<typeof xlsx.readFile> {
  if (!existsSync(workbookPath)) {
    // Create an empty workbook with a Leases sheet if the file does not exist
    const wb = xlsx.utils.book_new();
    const ws = xlsx.utils.aoa_to_sheet([["lease_id", "tenant", "start_date", "end_date", "rent"]]);
    xlsx.utils.book_append_sheet(wb, ws, "Leases");
    return wb;
  }
  return xlsx.readFile(workbookPath);
}

function saveWorkbook(workbook: ReturnType<typeof xlsx.readFile>, workbookPath: string): void {
  xlsx.writeFile(workbook, workbookPath);
}

function getSheet(workbook: ReturnType<typeof xlsx.readFile>): xlsx.WorkSheet {
  const name = workbook.SheetNames[0];
  if (!name) throw new Error("Workbook has no sheets.");
  return workbook.Sheets[name]!;
}

function sheetToRows(sheet: xlsx.WorkSheet): Record<string, unknown>[] {
  return xlsx.utils.sheet_to_json<Record<string, unknown>>(sheet);
}

function formatRowPreview(row: Record<string, unknown>): string {
  return Object.entries(row)
    .map(([k, v]) => `${k}: ${String(v)}`)
    .join(", ");
}

// ─── ExcelAdapter ─────────────────────────────────────────────────────────────

export class ExcelAdapter implements AdapterPort {
  async dryRun(action: string, input: Record<string, unknown>): Promise<AdapterDryRunResult> {
    switch (action) {
      case "read_lease_row": {
        // read_only — dry_run identical to commit, no state change possible
        const workbookPath = requireString(input, "workbook_path");
        const leaseId = requireString(input, "lease_id");
        const wb = loadWorkbook(workbookPath);
        const rows = sheetToRows(getSheet(wb));
        const row = rows.find((r) => String(r["lease_id"]) === leaseId);
        return {
          mode: "dry_run",
          diff_preview: row
            ? `[read] Found lease ${leaseId}: ${formatRowPreview(row)}`
            : `[read] No lease found with id '${leaseId}'.`,
          would_affect: row ? [`lease_row:${leaseId}`] : [],
          reversible: true,
        };
      }

      case "append_lease_row": {
        const workbookPath = requireString(input, "workbook_path");
        const row = requireObject(input, "row");
        const wb = loadWorkbook(workbookPath);
        const rows = sheetToRows(getSheet(wb));
        const nextIndex = rows.length + 2; // +1 for header, +1 for 1-based
        return {
          mode: "dry_run",
          diff_preview: `+ Row ${nextIndex}: ${formatRowPreview(row)}`,
          would_affect: [`workbook:${workbookPath}`],
          reversible: true,
        };
      }

      case "update_lease_row": {
        const workbookPath = requireString(input, "workbook_path");
        const leaseId = requireString(input, "lease_id");
        const updates = requireObject(input, "updates");
        const wb = loadWorkbook(workbookPath);
        const rows = sheetToRows(getSheet(wb));
        const existing = rows.find((r) => String(r["lease_id"]) === leaseId);
        if (!existing) {
          return {
            mode: "dry_run",
            diff_preview: `[update] No lease found with id '${leaseId}' — nothing to update.`,
            would_affect: [],
            reversible: false,
          };
        }
        const before = formatRowPreview(existing);
        const after = formatRowPreview({ ...existing, ...updates });
        return {
          mode: "dry_run",
          diff_preview: `~ Lease ${leaseId}\n  before: ${before}\n   after: ${after}`,
          would_affect: [`lease_row:${leaseId}`],
          reversible: false,
        };
      }

      default:
        throw new Error(`Unknown action: '${action}'`);
    }
  }

  async commit(action: string, input: Record<string, unknown>): Promise<AdapterCommitResult> {
    switch (action) {
      case "read_lease_row": {
        // read_only — commit behaves same as dry_run (just returns the data)
        const workbookPath = requireString(input, "workbook_path");
        const leaseId = requireString(input, "lease_id");
        const wb = loadWorkbook(workbookPath);
        const rows = sheetToRows(getSheet(wb));
        const row = rows.find((r) => String(r["lease_id"]) === leaseId);
        return {
          mode: "commit",
          result: row ?? null,
          transaction_id: `excel-read-${Date.now()}`,
        };
      }

      case "append_lease_row": {
        const workbookPath = requireString(input, "workbook_path");
        const row = requireObject(input, "row");
        const wb = loadWorkbook(workbookPath);
        const sheet = getSheet(wb);
        const rows = sheetToRows(sheet);
        const rowIndex = rows.length + 2; // 1-based, +1 for header
        rows.push(row);
        const newSheet = xlsx.utils.json_to_sheet(rows);
        wb.Sheets[wb.SheetNames[0]!] = newSheet;
        saveWorkbook(wb, workbookPath);
        return {
          mode: "commit",
          result: { row_index: rowIndex, appended: row },
          transaction_id: `excel-append-${Date.now()}`,
          rollback_token: String(rowIndex),
        };
      }

      case "update_lease_row": {
        const workbookPath = requireString(input, "workbook_path");
        const leaseId = requireString(input, "lease_id");
        const updates = requireObject(input, "updates");
        const wb = loadWorkbook(workbookPath);
        const sheet = getSheet(wb);
        const rows = sheetToRows(sheet);
        const idx = rows.findIndex((r) => String(r["lease_id"]) === leaseId);
        if (idx === -1) throw new Error(`Lease '${leaseId}' not found.`);
        rows[idx] = { ...rows[idx], ...updates };
        const newSheet = xlsx.utils.json_to_sheet(rows);
        wb.Sheets[wb.SheetNames[0]!] = newSheet;
        saveWorkbook(wb, workbookPath);
        return {
          mode: "commit",
          result: rows[idx],
          transaction_id: `excel-update-${Date.now()}`,
        };
      }

      default:
        throw new Error(`Unknown action: '${action}'`);
    }
  }
}
