# Thorax V1 Implementation Plan

The authoritative task graph is the `thorax-1fb` Beads epic. Work proceeds through these checkpoints:

1. Bootstrap the npm/TypeScript workspace, design, configuration, and contracts (`thorax-1fb.1`).
2. In parallel, implement the Codex runtime bridge, layered memory engine, and local UI shell (`thorax-1fb.2`, `.4`, `.6`).
3. Build specialist routing after the runtime contract, then build learning after routing and memory (`thorax-1fb.3`, `.5`).
4. Add reflection and resilience, integrate the system, and verify all acceptance scenarios (`thorax-1fb.7`, `.8`, `.9`).
5. Write the operator runbook and close the epic (`thorax-1fb.10`).

Every feature follows test-first development, receives independent review, and is committed with its Beads identifier. Stable checkpoints are pushed to `origin`.

