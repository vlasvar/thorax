# Thorax V1 Operator Runbook

## Install and authenticate

1. Install Node.js 22.19 or newer and the Codex CLI.
2. Run `codex login` and select ChatGPT authentication.
3. Confirm `codex login status` prints `Logged in using ChatGPT`.
4. Run `npm install` in the Thorax repository.

Thorax calls `codex app-server` locally. It never reads or stores Codex credential contents and does not use OpenAI API keys.

## Start Thorax

Start the backend from the project you want Thorax to operate on:

```powershell
npm run dev
```

Start the UI in another terminal:

```powershell
npm run dev:web
```

Open `http://127.0.0.1:4173`. Both services bind to loopback only. Set `THORAX_PORT` to change the backend port; update the Vite proxy if it is not `4317`.

## Agents and projects

V1 includes `thorax-core`, `research`, `builder`, `reviewer`, and `memory-curator`. They are durable identities with separate conversation bindings. The current working directory is the V1 project root, and each binding resumes its saved Codex thread after restart.

`thorax.config.json` documents the supported local configuration contract. V1’s CLI uses the current directory as the project and `THORAX_PORT` as the runtime port override.

## Memory and learning

Persistent state is stored beneath `.thorax/`:

- `conversations.json`: agent/project conversation bindings and visible messages.
- `memory/metadata.sqlite`: review state, evidence, fingerprints, promotion mappings, and audit history.
- `memory/content/`: durable Markdown memory content.

The effective order is project memory, then agent memory, then personal memory. Model-proposed durable lessons enter the UI review queue. Approve writes reviewed memory; reject preserves an audit event without promoting the lesson. Instruction suggestions are staged under the memory curator and are never applied automatically.

Delete `.thorax/` only when you intentionally want to erase all Thorax conversations and memory. Back it up before migration or repair.

## Health and recovery

- **Codex missing:** install the Codex CLI and ensure `codex` is on `PATH`.
- **Signed out or expired:** run `codex login` again and choose ChatGPT.
- **Project missing:** start Thorax inside an existing project directory.
- **Port occupied:** set `THORAX_PORT` to a free port and update the UI proxy.
- **Corrupt state:** stop Thorax, back up `.thorax/`, and inspect the structured server error. Do not manually edit SQLite while Thorax is running.
- **Interrupted turn:** retry from the same agent/project binding; Thorax retains the Codex thread id and visible conversation.

## Development and recovery checks

```powershell
npm run check
bd prime
bd ready --json
bd blocked --json
git status --short --branch
```

Stable checkpoints are pushed to `codex/thorax-v1` on [vlasvar/thorax](https://github.com/vlasvar/thorax).

