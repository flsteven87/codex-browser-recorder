---
name: record-browser
description: Check setup or record an explicitly approved, non-sensitive Codex In-app Browser flow as a private local MP4; pointer flows add a visible cursor and click feedback. Use only when the user explicitly invokes $codex-browser-recorder:record-browser; never record authenticated, sensitive, payment, credential, health, or confidential content.
---

# Record Browser

## Build A Local Plan

Collect the request without Browser activity:

- Set `preflightOnly` only for an explicit doctor, diagnose, check, or preflight request.
- For recording, require an HTTPS or approved loopback target plus either one or more concrete actions or an explicit passive duration.
- Treat the normalized target site as the approved origin for the whole recording.
- Set `durationWasExplicit` from the user's words. Use 15 seconds when omitted, but end after the last action and any bounded pointer-feedback tail. Require an explicit 5–60 second duration for passive or wait-only recording.
- Classify every action as `pointer`, `keyboard`, or `programmatic`. Pointer includes click, hover, drag, and pointer-positioned scroll.
- Accept an optional absolute destination and privacy-safe recording name. Otherwise use `~/Downloads/Codex Browser Recordings/` and a timestamp name.

Resolve the installed skill directory from the catalog entry that loaded this file. Never guess a cache path or use a source checkout. Import `checkSetup`, `prepareRecording`, and `recordApproved` from `scripts/record-browser-flow.mjs` in that exact directory with `pathToFileURL` in the persistent Node runtime.

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

If `status` is `blocked`, report every Technical Blocker in order using only its `code`, `summary`, and `remediation`, then stop. For `preflight_prepared`, continue only with the explicit setup-check path below. For `prepared`, continue to consent. Do not expose raw booleans.

## Complete The Setup Check

For `status: "preflight_prepared"`, follow the installed Browser control skill. Resolve its installed plugin root from its catalog entry, and pass one bounded Codex In-app Browser acquisition callback to the Recording Flow:

```js
const acquireBrowser = async () => {
  if (globalThis.agent?.browsers == null) {
    const { setupBrowserRuntime } =
      await import("<Browser plugin root>/scripts/browser-client.mjs");
    await setupBrowserRuntime({ globals: globalThis });
  }
  if (globalThis.iab == null) {
    globalThis.iab = await agent.browsers.get("iab");
    nodeRepl.write(await iab.documentation());
  }
  return globalThis.iab;
};

const setupOutcome = await checkSetup(preparation, {
  acquireBrowser,
  signal,
});
```

Do not use Chrome, `getForUrl`, `getDefault`, an existing arbitrary tab, or any fallback Recording Surface. The Recording Flow owns the bounded Browser acquisition, one fresh diagnostic tab when needed, full-CDP capability probe, and verified exact-tab cleanup. It consumes the setup preparation exactly once. Do not call lower-level tab creation or capability APIs directly.

The setup check must not navigate to a requested recording site, start a Recording Session, create an MP4 or raw frame dump, or upload anything.

If `status` is `blocked`, report every Technical Blocker in order using only its `code`, `summary`, and `remediation`, then stop. For `preflight_passed`, lead with `Local recording preflight passed`, report the planned destination, and state that the local media toolchain, destination, Codex In-app Browser, and full CDP access checks passed. Do not expose raw booleans. Stop after this setup result; do not request recording consent or start a recording.

## Obtain One Consent

For `status: "prepared"`, present one compact confirmation before any Browser activity:

- **What:** the approved site, concrete actions, and when the recording will end;
- **Where:** the exact local filename and folder; the MP4 has no audio and is not uploaded;
- **What is visible:** the full page viewport, including visible embedded frames, plus cursor and click feedback for pointer actions; browser controls and other tabs are excluded;
- **Privacy:** recording opens a fresh Codex In-app Browser tab, so continue only with public, logged-out, non-sensitive content. Never record authenticated, credential, payment, passkey, recovery, health, or confidential content.

Explain that macOS may request folder access and that verification failure means no final video is saved. Continue only after explicit confirmation. Denial performs no Browser action.

## Record The Approved Plan

After consent, follow the installed Browser control skill. Resolve its installed plugin root from its catalog entry, initialize `browser-client.mjs` once, and emit the Codex In-app Browser documentation once. Acquire only the Codex In-app Browser:

```js
if (globalThis.agent?.browsers == null) {
  const { setupBrowserRuntime } =
    await import("<Browser plugin root>/scripts/browser-client.mjs");
  await setupBrowserRuntime({ globals: globalThis });
}
if (globalThis.iab == null) {
  globalThis.iab = await agent.browsers.get("iab");
  nodeRepl.write(await iab.documentation());
}
const selectedBrowser = globalThis.iab;
```

Do not use Chrome, `getForUrl`, `getDefault`, an existing arbitrary tab, or any fallback Recording Surface.

Call `recordApproved()` once with the exact opaque preparation and selected Browser:

```js
const outcome = await recordApproved(preparation, {
  browser: selectedBrowser,
  signal,
});
```

The Recording Flow owns the fresh tab, navigation, CDP acquisition, first-frame gate, origin enforcement, per-action pointer evidence, duration, media validation, publication, rollback, verified exact-tab cleanup, and singleton release. It consumes the preparation exactly once and returns one terminal outcome. Do not call lower-level recording modules, perform extra actions, retry approval, broaden the origin, enable Developer mode, install packages, or switch the Browser. Never switch to another Recording Surface.

## Report The Terminal Outcome

For `completed`, require `outcome.result.status === "passed"`. Lead with `Recording completed`, then report duration, dimensions, and `MP4 video (H.264, no audio)`. For a pointer plan, also report the visible project cursor and click feedback. For a plan with no pointer action, do not claim that a cursor is visible. Then provide `[Saved video](<absolute output path>)` plus the same plain absolute path. Offer `Open in Finder`; do not open or play it without a request.

Offer bounded capture counters only as diagnostics after the product result.

For `failed` or `cancelled`, report only `outcome.failure.code`, `.summary`, and `.remediation`. Never expose URLs, page text, raw frames, CDP payloads, FFmpeg stderr, credentials, or internal plugin paths.

Report bounded cleanup state after the primary result:

- `cleanup.directory`: `Cleanup incomplete; delete locally: <path>`. For `saved_recording_persistence_failed`, instead identify it as a temporary unfinished video to copy before deletion.
- `cleanup.file`: `Cleanup incomplete; delete local file: <path>`.
- `artifactCleanupIncomplete` without a directory: inspect the operating-system temporary directory for a `codex-browser-recorder-` entry.
- `browserTabCleanupIncomplete`: close the fresh recording tab manually without reporting its URL.

Never convert a failed outcome into success or publish a failed recording.
