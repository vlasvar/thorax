# Thorax V1 Design

## Product boundary

Thorax is a local-only, single-user multi-agent harness. It uses the user's existing Codex login as its only model path. It does not require OpenClaw, OpenAI API keys, ChatGPT browser automation, or cookie reuse.

Codex owns model execution and tool use. Thorax owns durable agent identities, project bindings, layered memory, reviewable learning, conversation continuity, scheduling, and the operator interface.

## Architecture

- `apps/server`: local HTTP and event-stream backend; the only component allowed to launch Codex processes.
- `apps/desktop-web`: browser-based operator UI served locally.
- `packages/shared-types`: runtime-neutral contracts and validation schemas.
- `packages/codex-bridge`: Codex discovery, authentication health, turn execution, resume, and event normalization.
- `packages/core`: agent registry, project access, conversation binding, and orchestration.
- `packages/memory-engine`: SQLite metadata, Markdown durable memories, retrieval, review, and reflection.

All persistent state lives beneath the configured local data directory. Secrets and Codex credentials remain owned by Codex and are never copied into Thorax.

## Agent model

V1 ships five durable specialists: `thorax-core`, `research`, `builder`, `reviewer`, and `memory-curator`. Each has stable instructions, a private memory scope, a conversation namespace, and explicit project access. Thorax routes a turn only after validating the selected agent and project binding.

## Memory and learning

Memory precedence is project, then agent, then personal. Retrieval returns evidence and origin metadata. A completed session may produce candidates classified as ephemeral, project, agent, personal, or instruction suggestions. Durable personal changes, cross-agent sharing, instruction changes, and destructive compaction require explicit approval. Promotion is idempotent and auditable.

Background reflection is a restart-safe scheduler that creates candidates; it never writes durable memory directly.

## Runtime protocol

Thorax launches the supported local Codex surface and normalizes its streamed events behind a `CodexRuntime` interface. Health reporting distinguishes missing executable, signed-out state, expired authentication, process failure, and malformed events. Tests use a fake process transport; production never reads Codex credential contents.

## UI

The local web shell contains conversation, agent/project selection, memory review, learning log, and system status. It communicates only with the Thorax backend. Failure states are actionable and never expose credentials or raw sensitive process output.

## Verification

Unit tests cover contracts, routing, memory precedence, isolation, promotion, dedupe, and runtime error mapping. Integration tests cover persistence and conversation continuity. A local end-to-end smoke test verifies server and UI behavior with a fake runtime; live Codex verification is a separate environment check.

