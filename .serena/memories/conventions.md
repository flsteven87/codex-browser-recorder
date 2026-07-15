# Project conventions

- Explicit user preference: develop directly on `main`; do not create Git worktrees for this project. This overrides workflow skills that merely recommend worktree isolation.
- Preserve unrelated changes and avoid destructive Git operations.
- Do not push, publish, upload recordings, or make other external writes without explicit approval.
- Code, comments, commit messages, and documentation use professional English; user-facing Chinese responses use Traditional Chinese.
- Keep Phase 0 disposable and scoped to feasibility; do not scaffold the full plugin until hidden capture passes.
- Do not start development servers unless the user explicitly requests one.
- Never log raw frames, secrets, form values, cookies, storage, authorization headers, or sensitive query parameters.
