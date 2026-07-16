# Contributing

Contributions that preserve the plugin's consent, privacy, and local-only
boundaries are welcome.

## Development requirements

- Node.js 24 or newer
- FFmpeg and FFprobe on `PATH`, including the `libvpx` VP8 encoder and WebM
  muxer
- The Codex CLI for the isolated plugin-installation integration test

The project has no npm runtime dependencies and does not require a development
server.

## Workflow

1. Open or reference an issue that describes the focused change.
2. Write a failing test that demonstrates the intended behavior, and confirm
   that it fails for the expected reason.
3. Implement the smallest change that passes the test.
4. Run `npm run check`, `npm run test:coverage`, and any focused integration or
   validator command affected by the change.
5. Run `git diff --check` and review the complete diff before opening a pull
   request.

Do not commit recordings, raw frames, full URLs, Browser or CDP diagnostics,
credentials, tokens, personal data, generated temporary results, or plugin
cache contents. Tests and examples must use deterministic synthetic fixtures
and preserve the one-origin, explicit-consent, non-sensitive recording policy.

Use concise conventional commit messages. Keep pull requests narrowly scoped,
explain the privacy and security impact, identify the RED and GREEN commands,
and list every validation command run. All contributions must follow the
[Code of Conduct](CODE_OF_CONDUCT.md).
