# Task completion gates

- Run `npm test` when Node test scaffolding exists.
- Run `git diff --check` before handoff.
- For recording work, validate output with FFprobe: one video stream, positive bounded dimensions, positive plausible duration.
- Report received frames, acknowledgements, dropped samples, event truncations, visibility transitions, elapsed duration, FFprobe duration, and sanitized failure codes.
- A Phase 0 feasibility result is Go only if executed gates pass; hidden-frame stall is No-Go; unavailable permission/capability/environment is Blocked.
- State explicitly what was not run and any remaining risk.
