import type { ThoraxService } from "./index.js";

export interface TelegramConfig {
  botToken: string;
  allowedUserIds: number[];
}

export class TelegramTransport {
  readonly #service: ThoraxService;
  readonly #config: TelegramConfig;
  #offset = 0;
  #running = false;
  #abortController: AbortController | null = null;
  // Map of chatId -> { agentId: string; projectId: string }
  readonly #bindings = new Map<number, { agentId: string; projectId: string }>();

  constructor(service: ThoraxService, config: TelegramConfig) {
    this.#service = service;
    this.#config = config;
  }

  start() {
    if (this.#running) return;
    this.#running = true;
    this.#abortController = new AbortController();
    void this.pollLoop();
  }

  stop() {
    this.#running = false;
    this.#abortController?.abort();
  }

  private async pollLoop() {
    while (this.#running) {
      try {
        const url = `https://api.telegram.org/bot${this.#config.botToken}/getUpdates`;
        const init: RequestInit = {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            offset: this.#offset,
            timeout: 30,
            allowed_updates: ["message"],
          }),
        };
        if (this.#abortController) {
          init.signal = this.#abortController.signal;
        }
        const res = await fetch(url, init);

        if (!res.ok) {
          console.error(`Telegram API error: ${res.status}`);
          await new Promise((r) => setTimeout(r, 5000));
          continue;
        }

        const data = await res.json() as { ok: boolean; result: any[] };
        if (data.ok && data.result.length > 0) {
          for (const update of data.result) {
            this.#offset = Math.max(this.#offset, update.update_id + 1);
            if (update.message) {
              await this.handleMessage(update.message);
            }
          }
        }
      } catch (err) {
        if (!this.#running) break;
        console.error("Telegram polling failed:", err);
        await new Promise((r) => setTimeout(r, 5000));
      }
    }
  }

  private async handleMessage(message: any) {
    const fromId = message.from?.id;
    const chatId = message.chat?.id;
    const text = message.text;

    if (!chatId || !fromId || !text) return;

    // Check allowlist
    if (!this.#config.allowedUserIds.includes(fromId)) {
      await this.sendTelegram(chatId, "⚠️ Unauthorized: Your user ID is not in the allowlist.");
      return;
    }

    if (text.startsWith("/")) {
      await this.handleCommand(chatId, text);
      return;
    }

    // Route to bound agent
    const binding = this.#bindings.get(chatId);
    if (!binding) {
      await this.sendTelegram(
        chatId,
        "⚠️ No active agent/project binding.\nUse `/bind <agentId> <projectId>` first.\nSend `/status` to list options."
      );
      return;
    }

    await this.sendChatAction(chatId, "typing");

    try {
      const conversation = await this.#service.activeConversation(binding.agentId, binding.projectId);
      const reply = await this.#service.sendMessage(
        conversation.id,
        binding.agentId,
        binding.projectId,
        text
      );
      await this.sendTelegram(chatId, reply.content);
    } catch (err) {
      await this.sendTelegram(chatId, `❌ Error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async handleCommand(chatId: number, text: string) {
    const parts = text.split(/\s+/);
    const cmd = parts[0]!.toLowerCase();
    const snapshot = await this.#service.snapshot();

    if (cmd === "/start" || cmd === "/status") {
      const binding = this.#bindings.get(chatId);
      let statusStr = "🤖 *Thorax V2 Status*\n\n";
      statusStr += `*Runtime:* ${snapshot.runtime.state}\n`;
      statusStr += `*Active binding:* ${
        binding ? `Agent: \`${binding.agentId}\`, Project: \`${binding.projectId}\`` : "None"
      }\n\n`;

      statusStr += "*Available Agents:*\n";
      for (const agent of snapshot.agents) {
        statusStr += `- \`${agent.id}\` (${agent.name})\n`;
      }

      statusStr += "\n*Available Projects:*\n";
      for (const proj of snapshot.projects) {
        statusStr += `- \`${proj.id}\` (${proj.name})\n`;
      }

      statusStr += "\n*Commands:*\n";
      statusStr += "`/bind <agentId> <projectId>` - Bind chat context\n";
      statusStr += "`/workflows` - List workflow runs\n";
      statusStr += "`/approve <execId>` - Approve suspended run\n";
      statusStr += "`/reject <execId>` - Reject suspended run\n";

      await this.sendTelegram(chatId, statusStr);
      return;
    }

    if (cmd === "/bind") {
      const agentId = parts[1];
      const projectId = parts[2];
      if (!agentId || !projectId) {
        await this.sendTelegram(chatId, "⚠️ Usage: `/bind <agentId> <projectId>`");
        return;
      }

      const agentExists = snapshot.agents.some((a) => a.id === agentId);
      const projectExists = snapshot.projects.some((p) => p.id === projectId);

      if (!agentExists) {
        await this.sendTelegram(chatId, `❌ Unknown agent: ${agentId}`);
        return;
      }
      if (!projectExists) {
        await this.sendTelegram(chatId, `❌ Unknown project: ${projectId}`);
        return;
      }

      this.#bindings.set(chatId, { agentId, projectId });
      await this.sendTelegram(chatId, `✅ Bound to Agent: \`${agentId}\`, Project: \`${projectId}\`.`);
      return;
    }

    if (cmd === "/workflows") {
      const list = this.#service.listWorkflowExecutions();
      if (list.length === 0) {
        await this.sendTelegram(chatId, "No workflow executions found.");
        return;
      }
      let wfStr = "📋 *Workflow Executions*\n\n";
      for (const run of list) {
        wfStr += `• \`${run.id.slice(0, 8)}\` - *${run.status}* (${run.workflowId})\n`;
      }
      await this.sendTelegram(chatId, wfStr);
      return;
    }

    if (cmd === "/approve" || cmd === "/reject") {
      const execId = parts[1];
      if (!execId) {
        await this.sendTelegram(chatId, `⚠️ Usage: \`${cmd} <execId>\``);
        return;
      }

      const list = this.#service.listWorkflowExecutions();
      const match = list.find((x) => x.id === execId || x.id.startsWith(execId));
      if (!match) {
        await this.sendTelegram(chatId, `❌ Execution not found: ${execId}`);
        return;
      }

      if (match.status !== "suspended") {
        await this.sendTelegram(chatId, `❌ Execution is not suspended (status: ${match.status})`);
        return;
      }

      const approved = cmd === "/approve";
      try {
        const definition = await this.#service.loadWorkflowDefinition(match.workflowId);
        await this.#service.resumeWorkflow(match.id, definition, approved);
        await this.sendTelegram(
          chatId,
          `✅ Execution \`${match.id.slice(0, 8)}\` ${approved ? "approved" : "rejected"}.`
        );
      } catch (err) {
        await this.sendTelegram(chatId, `❌ Failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  private async sendTelegram(chatId: number, text: string) {
    try {
      await fetch(`https://api.telegram.org/bot${this.#config.botToken}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          text,
          parse_mode: "Markdown",
        }),
      });
    } catch (err) {
      console.error("Failed to send Telegram message:", err);
    }
  }

  private async sendChatAction(chatId: number, action: string) {
    try {
      await fetch(`https://api.telegram.org/bot${this.#config.botToken}/sendChatAction`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          action,
        }),
      });
    } catch {}
  }
}
