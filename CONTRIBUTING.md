# Contributing

Contributions that preserve the plugin's consent, privacy, and local-only
boundaries are welcome.

## Development requirements

- Node.js 24 or newer
- FFmpeg and FFprobe on `PATH`, including the `libx264` H.264 encoder and MP4
  muxer
- The Codex CLI for the isolated plugin-installation integration test

The project has no npm runtime dependencies and does not require a development
server.

Read [Architecture](docs/architecture.md) before changing session ownership,
capture, cursor evidence, artifact publication, or public failure handling. The
[official Codex plugin guide](https://learn.chatgpt.com/docs/build-plugins) is
the source of truth for marketplace and manifest behavior.

## Workflow

1. Open or reference an issue that describes the focused change.
2. Write a failing test that demonstrates the intended behavior, and confirm
   that it fails for the expected reason. For documentation-only changes,
   capture the stale source or verified mismatch instead of manufacturing a
   failing code test.
3. Implement the smallest change that passes the test.
4. Run `npm run check`, `npm run test:coverage`,
   `npm run test:coverage:cursor`, and any focused integration or validator
   command affected by the change.
5. Run `git diff --check` and review the complete diff before opening a pull
   request.

Do not commit recordings, raw frames, full URLs, Browser or CDP diagnostics,
credentials, tokens, personal data, generated temporary results, or plugin
cache contents. Automated tests must use deterministic synthetic fixtures;
submission cases must declare a public, no-login reviewer fixture. Both must
preserve the one-origin, explicit-consent, non-sensitive recording policy.

Use concise conventional commit messages. Keep pull requests narrowly scoped,
explain the privacy and security impact, identify the RED and GREEN commands,
and list every validation command run. All contributions must follow the
[Code of Conduct](CODE_OF_CONDUCT.md).

## Release verification

Automated checks do not control a real Browser and must not be described as
Browser end-to-end coverage. Before a release, a maintainer must manually:

1. install the release candidate in a clean Codex desktop task;
2. run the local preflight and resolve every blocker;
3. record the same approved pointer-driven flow on the public, no-login W3C
   Pointer Events fixture in the in-app **Browser** and in **Chrome**, using a
   separate clean task for each surface;
4. record the Codex desktop, Browser or Chrome, and extension versions used for
   each smoke without retaining the recording or sensitive diagnostics;
5. verify each run reports `Recording completed`, produces a playable H.264 MP4
   capped at 720p and encoded at 10 frames per second with no audio, shows the
   cursor and click feedback, terminates after the approved actions, and leaves
   no fresh tab behind;
6. recheck the current official Plugins, Browser, Chrome, and Build plugins
   documentation linked from the README, plus the version-specific GitHub
   release commit and archive digest recorded there. Treat embedded-frame
   support as deterministic-fixture coverage unless the release notes identify
   a separate real-browser public iframe smoke and its tested versions; and
7. run `npm run check:release` only after setting the canonical manifest
   version, replacing the generic Unreleased changelog section with the matching
   versioned and dated release entry, and synchronizing all public version
   references.

`npm run check:release-candidate` is the normal documentation and metadata gate
during development. `npm run check:release` is deliberately stricter and is
reserved for a versioned, dated release state.

Record the pass/fail result and tested commit in the release notes. Never commit,
upload, or attach the generated recording or Browser/CDP diagnostics.
