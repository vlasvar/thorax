import { resolve } from "node:path";
import { CodexRuntime } from "@thorax/codex-bridge";
import { ThoraxService, startThoraxServer } from "./index.js";

const root = process.cwd();
const service = await ThoraxService.open({
  dataDirectory: resolve(root, ".thorax"),
  runtime: new CodexRuntime(),
  project: { id: "thorax", name: "Thorax", rootPath: root },
});
const running = await startThoraxServer(service, { host: "127.0.0.1", port: Number(process.env.THORAX_PORT ?? 4317) });
console.log(`Thorax server listening at ${running.url}`);

const shutdown = async () => { await running.close(); service.close(); process.exit(0); };
process.once("SIGINT", () => { void shutdown(); });
process.once("SIGTERM", () => { void shutdown(); });
