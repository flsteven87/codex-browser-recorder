# Contributing

Thanks for helping improve Browser Recorder. Small, focused changes are
welcome—especially clearer docs, better error messages, and fixes that preserve
explicit consent and local-only output.

## Quick start

You need Node.js 24 or newer. FFmpeg and FFprobe are needed only for recording
and media-related tests; the project has no npm runtime dependencies or
development server.

```bash
npm test
```

For a code change:

1. Describe the problem in an issue, or link an existing issue. Tiny typo,
   wording, and broken-link fixes can go straight to a pull request.
2. Add or update a focused test when behavior changes.
3. Make the smallest change that solves the problem.
4. Run `npm run check` and any focused test for the changed area.
5. Run `git diff --check` and review the complete diff.

Before opening a pull request, also run `npm run check:release-candidate` when
you changed public docs, plugin metadata, packaging, or release behavior.

## Keep test data safe

Do not commit recordings, raw frames, private or authenticated URLs, page
content, Browser/CDP diagnostics, credentials, tokens, personal data, local
private paths, temporary results, or plugin cache contents.

Tests must use deterministic synthetic fixtures. Submission examples must use a
public, logged-out reviewer page. Changes must keep the one-site,
explicit-consent, non-sensitive recording boundary.

Use a concise conventional commit message and keep the pull request focused.
Explain what changed, any privacy or security impact, and the validation you
ran. Follow the [Code of Conduct](CODE_OF_CONDUCT.md).

## Working on recording internals

Read [Architecture](docs/architecture.md) before changing session ownership,
capture, cursor evidence, artifact publication, or public failure handling. The
[official Codex plugin guide](https://learn.chatgpt.com/docs/build-plugins) is
the source of truth for manifest and marketplace behavior.

For substantial behavior changes, first show the problem with a failing test,
then implement the fix and run:

```bash
npm run check
npm run test:coverage
npm run test:coverage:cursor
npm run check:release-candidate
```

## Maintainer release checklist

Automated tests do not control a real browser. Before a release, a maintainer
must:

1. Install the candidate in a clean Codex desktop task and pass the local setup
   check.
2. Run `runChromeFrameContractGate()` from
   `scripts/browser-frame-contract-gate.mjs` in the persistent Browser Node
   runtime. Require `status: "passed"`, one received and acknowledged frame,
   and a closed fresh tab.
3. Run `runExampleRecordingReleaseGate()` from
   `scripts/example-recording-release-gate.mjs`. It must complete two full
   recordings in sequence with different output paths.
4. Record the candidate SHA, plugin version, Codex desktop version, Chrome
   plugin and extension version, Chrome version, and both machine-readable gate
   results locally. Do not commit this attestation or the recordings.
5. Verify both videos are playable H.264 MP4 files, capped at 720p and 10 frames
   per second, with no audio or leftover tab or temporary recording. Delete the
   generated files after review.
6. Run one approved pointer flow on the public W3C Pointer Events page and
   verify cursor and click feedback.
7. Recheck the current official Plugins, Browser, Chrome, and Build plugins
   documentation linked from the README. Treat embedded-frame support as
   deterministic-fixture coverage unless the release notes record a separate
   real-browser smoke test.
8. Run `npm run check:release` only after setting the final manifest version,
   replacing the Unreleased changelog section with a matching dated release,
   and synchronizing public version references.

The Codex in-app Browser is not a release-smoke surface and must stop with
`browser_surface_unsupported`. Never commit, upload, or attach generated
recordings or Browser/CDP diagnostics.
