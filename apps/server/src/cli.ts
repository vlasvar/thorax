import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { CodexRuntime } from "@thorax/codex-bridge";
import { ThoraxService, startThoraxServer } from "./index.js";
import { TelegramTransport } from "./telegram.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const service = await ThoraxService.open({
  dataDirectory: resolve(root, ".thorax"),
  runtime: new CodexRuntime(),
  project: { id: "thorax", name: "Thorax", rootPath: root },
});
const running = await startThoraxServer(service, { host: "127.0.0.1", port: Number(process.env.THORAX_PORT ?? 4317) });
console.log(`Thorax server listening at ${running.url}`);

let telegram: TelegramTransport | undefined;
const botToken = process.env.TELEGRAM_BOT_TOKEN;
if (botToken) {
  const allowedUserIds = (process.env.TELEGRAM_ALLOWED_USER_IDS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map(Number)
    .filter((n) => !isNaN(n));
  
  telegram = new TelegramTransport(service, { botToken, allowedUserIds });
  telegram.start();
  console.log("Telegram transport registered and listening.");
}

const shutdown = async () => {
  if (telegram) telegram.stop();
  await running.close();
  service.close();
  process.exit(0);
};
process.once("SIGINT", () => { void shutdown(); });
process.once("SIGTERM", () => { void shutdown(); });
