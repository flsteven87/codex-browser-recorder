# Project core

- Status: Phase 0 PoC harness implemented and locally tested; live Browser CDP, visible-capture, and hidden-capture gates remain blocked pending a fresh app/task runtime.
- Canonical design: `docs/superpowers/specs/2026-07-15-codex-browser-recorder-design.md`.
- Current validation plan: `docs/superpowers/plans/2026-07-15-phase-0-browser-screencast-poc.md`.
- Product invariant: record the actual Codex in-app Browser tab; never represent a separate Playwright browser as the same session.
- Feasibility invariant: hidden two-minute capture must pass before building the full plugin.
- Runtime/toolchain details: `mem:tech_stack`.
- Stable project workflow and naming rules: `mem:conventions`.
- Useful project commands: `mem:suggested_commands`.
- Completion gates: `mem:task_completion`.
