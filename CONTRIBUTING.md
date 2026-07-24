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

Tests must use deterministic synthetic fixtures. Submission examples that need
real Browser access must use a public reviewer page; content-warning cases must
use synthetic descriptions rather than real private data. Changes must keep the
one-site, explicit-consent, content-neutral recording boundary.

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
2. In the persistent Browser runtime, read the current Codex In-app Browser
   documentation and acquire only `agent.browsers.get("iab")`. Import
   `runCodexInAppBrowserFrameDiagnostic()` from
   `scripts/codex-in-app-browser-frame-diagnostic.mjs`, pass the acquired
   Browser as `browser`, and require diagnostic contract version 2,
   `releaseAcceptance: false`, one received and acknowledged frame, and exact
   diagnostic-tab cleanup. This is a low-level CDP probe, not product
   acceptance.
3. Define privacy-safe actions against public HTTPS fixtures using only APIs
   exposed by the current Browser documentation. Import
   `runCodexInAppBrowserReleaseGate()` from
   `scripts/codex-in-app-browser-release-gate.mjs` and provide:
   `approveQualification`, `acquireBrowser`, `codexDesktopVersion`,
   `browserPluginVersion`, `confirmPointerVisualEvidence`,
   `pointerHiddenFlow`, `sequentialFlow`, `crossOriginFlow`, and
   `embeddedFrame`.
4. Define `pointerHiddenFlow.actions` as exactly `pointer`, `programmatic`,
   `pointer`, in that order. The first action must change `await tab.url()`
   without changing its origin, the second must change the Browser visibility
   capability from `true` to `false`, and the third must perform its pointer
   interaction only after the gate verifies the Browser is hidden. For example:

   ```js
   actions: [
     { label: "Follow same-origin link", modality: "pointer", perform: ({ tab }) => tab.playwright.getByRole("link", { name: "Next" }).click() },
     { label: "Hide Browser", modality: "programmatic", perform: () => visibility.set(false) },
     { label: "Click while hidden", modality: "pointer", perform: ({ tab }) => tab.playwright.getByRole("link", { name: "Previous" }).click() },
   ]
   ```

   The gate observes the Browser capability changing from visible to hidden and
   requires the final hidden pointer action to add both fresh pointer evidence
   and a fresh captured frame inside the same production action boundary. CDP
   page-visibility events are recorded as diagnostic evidence only; they are
   not the source of truth for whether the Codex Browser panel is shown. Let
   the visual-evidence callback independently confirm both pointer movement and
   click feedback.
5. The sequential flow must be a second real action-driven recording. The
   cross-origin flow must navigate outside its approved origin. Declare
   embedded-frame coverage as `exercised` only with exactly one pointer action
   that targets a child frame, for example:

   ```js
   embeddedFrame: {
     status: "exercised",
     targetUrl,
     actions: [{
       label: "Use child-frame control",
       modality: "pointer",
       perform: ({ tab }) => tab.playwright.frameLocator("#fixture").getByRole("button", { name: "Run" }).click(),
     }],
   }
   ```

   The gate must observe a valid main frame and one or more child-frame
   identities through that owned tab, and the production capture must report a
   bounded child-frame pointer-event count that increases across that exact
   action boundary. A child-frame event captured before the action, or a fresh
   main-frame event alone, does not qualify. If either fact cannot be proved,
   use `runtime_unsupported` with
   `runtime_does_not_expose_embedded_frame_control`.
6. Require the production gate to return contract version 2 and
   `status: "passed"`, and confirm every
   scenario, independent H.264/yuv420p MP4 validation with no audio, candidate
   and runtime versions, restored tab state, deleted recordings, and a removed
   temporary workspace. The cancellation scenario is created by the gate and
   aborts only after the production action seam becomes active.
7. Keep the two machine-readable results only in the private task transcript.
   Do not write, commit, upload, or attach an attestation, recording, raw frame,
   page content, URL, or CDP diagnostic. The production gate deletes its exact
   owned recordings and workspace after validation.
8. Recheck the current official Plugins, Browser, and Build plugins
   documentation linked from the README.
9. Run `npm run check:release` only after setting the final manifest version,
   replacing the Unreleased changelog section with a matching dated release,
   and synchronizing public version references.

The Codex In-app Browser is the only release-smoke Recording Surface. Never
switch to Chrome or another Browser after a failure, and never commit, upload,
or attach generated recordings or Browser/CDP diagnostics.
