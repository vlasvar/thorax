# Thorax

Thorax is a lightweight, local multi-agent harness powered by your existing Codex/ChatGPT login. It does not require OpenClaw, OpenAI API keys, browser automation, or copied credentials.

V1 provides five durable specialists, project-bound conversations, Codex thread continuity, layered local memory, reviewable self-learning, and a local operator UI.

## Quick start

Requirements: Node.js 22.19+ (Node 24 recommended), Codex CLI, and a ChatGPT plan with Codex access.

```powershell
codex login
npm install
npm run dev
```

In a second terminal:

```powershell
npm run dev:web
```

Open `http://127.0.0.1:4173`. The backend listens only on `127.0.0.1:4317`.

## How learning works

Agents may emit private `<thorax-memory>` markers for reusable lessons. Thorax removes those markers from the visible reply and stages durable lessons in the Memory Review queue. Project, agent, personal, and instruction suggestions never rewrite durable state without review.

Memory precedence is project → agent → personal. Each agent’s private memory remains isolated unless a reviewed workflow promotes or shares it.

## Verify

```powershell
npm run check
```

See [the operator runbook](docs/OPERATOR_RUNBOOK.md) for configuration, recovery, and data layout.

