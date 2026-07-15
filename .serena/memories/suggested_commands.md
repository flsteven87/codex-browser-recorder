# Suggested commands

- Phase 0 tests once `package.json` exists: `npm test`.
- Direct test runner: `node --test tests/*.test.mjs`.
- Repository hygiene: `git diff --check` and `git status --short --branch`.
- Video inspection: `ffprobe -v error -show_streams -show_format -of json <video.webm>`; resolve it from `PATH` through the environment doctor.
- No development server is part of the Phase 0 harness.
