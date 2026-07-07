import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { adapterManifestSchema, type AdapterManifest } from "@thorax/shared-types";

export class AdapterRegistry {
  readonly #adapters = new Map<string, AdapterManifest>();

  constructor(adapters: readonly AdapterManifest[] = []) {
    for (const adapter of adapters) {
      this.#adapters.set(adapter.adapter, structuredClone(adapter));
    }
  }

  static async load(projectRootPath: string): Promise<AdapterRegistry> {
    const registry = new AdapterRegistry();
    const adaptersDir = join(projectRootPath, ".thorax", "adapters");
    try {
      const files = await readdir(adaptersDir);
      for (const file of files) {
        if (file.endsWith(".json")) {
          try {
            const content = await readFile(join(adaptersDir, file), "utf8");
            const parsed = adapterManifestSchema.parse(JSON.parse(content));
            registry.#adapters.set(parsed.adapter, parsed);
          } catch (error) {
            console.warn(`[AdapterRegistry] Skipping invalid adapter manifest ${file}:`, error instanceof Error ? error.message : error);
          }
        }
      }
    } catch (error) {
      if (typeof error !== "object" || error === null || !("code" in error) || error.code !== "ENOENT") {
        throw error;
      }
      // .thorax/adapters/ directory does not exist — silently ignored
    }
    return registry;
  }

  get(adapterId: string): AdapterManifest | undefined {
    return this.#adapters.get(adapterId);
  }

  list(): AdapterManifest[] {
    return [...this.#adapters.values()];
  }
}
