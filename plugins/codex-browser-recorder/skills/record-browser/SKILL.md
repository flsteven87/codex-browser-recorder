---
name: record-browser
description: Preflight or record an explicitly approved, non-sensitive Chrome Browser flow as a local H.264 MP4; pointer flows add a visible cursor and click feedback. Use only when the user explicitly invokes $record-browser; never record authenticated, sensitive, payment, credential, health, or confidential content.
---

# Record Browser

## Build A Local Plan

Collect the request without Browser activity:

- Set `preflightOnly` only for an explicit doctor, diagnose, check, or preflight request.
- For recording, require an HTTPS or approved loopback target plus either one or more concrete actions or an explicit passive duration.
- Set `durationWasExplicit` from the user's words. Use 15 seconds when omitted, but end after the last action and any bounded pointer-feedback tail. Require an explicit 5–60 second duration for passive or wait-only recording.
- Classify every action as `pointer`, `keyboard`, or `programmatic`. Pointer includes click, hover, drag, and pointer-positioned scroll.
- Accept an optional absolute destination and privacy-safe recording name. Otherwise use `~/Downloads/Codex Browser Recordings/` and a timestamp name.
- Set `browserSurface` to `iab` only when explicitly requested; otherwise use `chrome`. This release fails closed on IAB because it has not satisfied the frame-stream contract. Never switch surfaces automatically after failure.

Resolve the installed skill directory from the catalog entry that loaded this file. Never guess a cache path or use a source checkout. Import `scripts/record-browser-flow.mjs` from that exact directory with `pathToFileURL` in the persistent Node runtime.

Define each action before preparation. Its `perform({ tab })` function must contain exactly the approved Browser call. Labels must describe the visible user action without sensitive values.

```js
const plannedActions = [
  // {
  //   label: "Open the pricing section",
  //   modality: "pointer",
  //   perform: ({ tab }) => tab.<exact approved Browser call>,
  // },
];

const preparation = await prepareRecording({
  actions: plannedActions,
  browserSurface,
  destinationDirectory,
  durationMs,
  durationWasExplicit,
  now: new Date(),
  preflightOnly,
  recordingName,
  targetUrl,
  temporaryRoot,
});
```

`prepareRecording()` performs pure request validation plus local FFmpeg/FFprobe and destination checks. It must not create, navigate, or acquire a Browser tab or CDP capability. Treat the returned preparation as opaque: do not clone, spread, reconstruct, or mutate it.

If `status` is `blocked`, report every blocker in order using only its `code`, `summary`, and `remediation`, then stop. For `preflight_passed`, lead with `Local recording preflight passed`, report the planned destination and returned platform/media booleans, state that Browser/CDP was not tested, then stop.

## Obtain One Consent

For `status: "prepared"`, present one compact confirmation before any Browser activity:

- approved origin, concrete action labels, Chrome surface, and the exact returned `consent.end` duration or action-driven hard limit;
- destination, filename, H.264 MP4, no audio, and visible project cursor/click feedback when pointer actions occur;
- complete page viewport including visible embedded frames, excluding browser chrome and other tabs;
- a fresh tab that may reuse the user's existing Chrome session;
- exclusion of authenticated, sensitive, credential, payment, passkey, recovery, health, and confidential content;
- fail-closed behavior for missing frames, pointer evidence, origin changes, or publication, plus explicit bounded cleanup warnings.

Explain that macOS may request file access and page-scripted synthetic pointer events can be observed. Continue only after explicit confirmation. Denial performs no Browser action.

## Record The Approved Plan

After consent, follow the installed Browser control skill. Resolve its installed plugin root from its catalog entry, initialize `browser-client.mjs` once, and emit the Chrome Browser documentation once. Acquire only `agent.browsers.get("extension")`; do not use IAB, `getForUrl`, an existing tab, or another control surface.

Call `recordApproved()` once with the exact opaque preparation and selected Browser:

```js
const outcome = await recordApproved(preparation, {
  browser: selectedBrowser,
  signal,
});
```

The Recording Flow owns the fresh tab, navigation, CDP acquisition, first-frame gate, origin enforcement, per-action pointer evidence, duration, media validation, publication, rollback, verified exact-tab cleanup, and singleton release. It consumes the preparation exactly once and returns one terminal outcome. Do not call lower-level recording modules, perform extra actions, retry approval, broaden the origin, enable Developer mode, install packages, or switch browsers.

## Report The Terminal Outcome

For `completed`, require `outcome.result.status === "passed"`. Lead with `Recording completed`, then report duration, dimensions, H.264 MP4, and no audio. For a pointer plan, also report the visible project cursor, successful per-action pointer evidence, and click feedback. For a plan with no pointer action, do not claim that a cursor is visible. Then provide `[Saved Recording](<absolute output path>)` plus the same plain absolute path. Offer `Open in Finder`; do not open or play it without a request.

Offer bounded capture counters only as diagnostics after the product result.

For `failed` or `cancelled`, report only `outcome.failure.code`, `.summary`, and `.remediation`. Never expose URLs, page text, raw frames, CDP payloads, FFmpeg stderr, credentials, or internal plugin paths.

Report bounded cleanup state after the primary result:

- `cleanup.directory`: `Cleanup incomplete; delete locally: <path>`. For `saved_recording_persistence_failed`, instead identify it as a temporary Working Recording to copy before deletion.
- `cleanup.file`: `Cleanup incomplete; delete local file: <path>`.
- `artifactCleanupIncomplete` without a directory: inspect the operating-system temporary directory for a `codex-browser-recorder-` entry.
- `browserTabCleanupIncomplete`: close the fresh recording tab manually without reporting its URL.

Never convert a failed outcome into success or publish a failed recording.
