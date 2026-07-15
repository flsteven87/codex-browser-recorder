# Tech stack

- Initial platform: macOS Codex desktop app.
- Planned implementation: dependency-light Node.js ESM (`.mjs`) helper modules.
- Browser integration target: Codex in-app Browser raw CDP command/event capability. The current task runtime did not advertise raw CDP, so live capture remains blocked until a fresh runtime exposes it.
- Video: user-installed FFmpeg/FFprobe, JPEG screencast input, VP8 WebM output.
- Local environment observed 2026-07-15: Node 24.15.0, Codex CLI 0.144.1, FFmpeg and FFprobe under `/opt/homebrew/bin`.
- Tests: Node built-in `node:test`; avoid adding dependencies during Phase 0.
