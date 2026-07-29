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
   diagnostic-tab cleanup. The probe takes one in-memory Browser screenshot
   before the first CDP command to initialize the runtime pixel pipeline, then
   discards it; only a later `Page.screencastFrame` can satisfy the diagnostic.
   This is a low-level CDP probe, not product acceptance.
3. Prove that the runtime can present and hide the Browser on demand before
   spending a full qualification run. Import
   `probeCodexInAppBrowserVisibility()` from
   `scripts/codex-in-app-browser-release-qualification.mjs`, pass the same
   `acquireBrowser` callback, and require `status: "passed"`. The probe creates
   one fresh blank tab before requesting visibility because an empty Browser
   has no surface to present. It does not navigate or acquire CDP, and it closes
   that exact tab and verifies its disappearance before returning. Cleanup is
   bounded and shares one retry across close, inventory, and still-listed-tab
   failures. A failed probe names which step broke:
   `capabilityAvailable: false` means the capability is missing,
   `requestRejected` means `set()` itself failed, and a settled `false` with a
   high `observations` count means the runtime accepted `set()` without ever
   reporting the requested state. A rejected
   `qualification_tab_cleanup_failed` means the diagnostic tab needs manual
   cleanup. Interactive Recording cannot pass qualification while
   `show.settled` is `false`.
4. Run the qualification harness rather than assembling gate options by hand.
   Import `runCodexInAppBrowserReleaseQualification()` from
   `scripts/codex-in-app-browser-release-qualification.mjs`, which supplies the
   pointer-hidden, sequential, and cross-origin flows against public HTTPS
   fixtures and routes the hide action through the exact Browser the gate
   acquired:

   ```js
   const qualification = await runCodexInAppBrowserReleaseQualification({
     acquireBrowser,
     approveQualification,
     browserPluginVersion,
     codexDesktopVersion,
   });
   ```

   The harness fixes `pointerHiddenFlow.actions` as exactly `pointer`,
   `programmatic`, `pointer`: the first changes `await tab.url()` without
   changing its origin, the second sets the Browser visibility capability to
   `false` and holds that state for 500 ms so the first click ring clears before
   the encoded cursor moves, and the third performs its pointer interaction
   only after the gate verifies the Browser is hidden. Pass `fixtures` to
   retarget the links when a fixture page changes; keep every target a public
   HTTPS page and keep the two pointer-hidden link names distinct. The gate
   observes the Browser capability
   changing from visible to hidden and requires the final hidden pointer action
   to add both fresh pointer evidence and a fresh captured frame inside the
   same production action boundary. CDP page-visibility events are recorded as
   diagnostic evidence only; they are not the source of truth for whether the
   Codex Browser panel is shown. Production capture likewise uses one discarded
   in-memory Browser screenshot to initialize pixel capture before the first
   CDP command; it never uses that screenshot as a recording frame. The harness
   decodes the resulting MP4 through FFmpeg and independently requires two
   visible click rings plus cursor movement between distinct positions.
5. The sequential flow is a second real action-driven recording. The gate runs
   it as an Unattended Recording and verifies at its first production action
   boundary that the Browser began and remained hidden. The cross-origin flow
   navigates outside its approved origin. The harness declares embedded-frame
   coverage as `runtime_unsupported` by default. Pass `embeddedFrame` with
   `status: "exercised"` only with exactly one pointer action that targets a
   child frame, for example:

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
