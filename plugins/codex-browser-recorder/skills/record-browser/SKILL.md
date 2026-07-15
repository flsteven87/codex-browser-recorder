---
name: record-browser
description: Use when the user explicitly requests recording one approved Codex Browser tab to a local WebM file.
---

# Record Browser

Run the experimental integration gate that records only the page content of one
fresh, explicitly approved Codex in-app Browser tab. This skill may run only
when the user explicitly selected `$record-browser`; its presence in the plugin
catalog is not recording consent.

## Confirm Scope First

Before any Browser action, confirm all of the following with the user:

- the fixed target is a fresh `https://example.com/` test tab;
- the duration is 10–15 seconds;
- output is one local temporary audio-free VP8 WebM;
- the test page will receive a disposable clock, animation, scroll, and DOM
  state change;
- recording excludes Codex UI, browser chrome, audio, credentials, cookies,
  storage, request headers, and every other tab.

Stop if the page may contain credentials, payment data, passkeys, recovery
secrets, or confidential information. A general Browser request is not consent
to record.

## Preconditions

Require the installed Browser plugin, macOS, `ffmpeg` and `ffprobe` on the
inherited command path, a writable temporary directory, and normal site plus
full-CDP approval. The Browser Node execution surface does not expose global
`process` metadata, so do not read `process.platform`, `process.env`, or
`process.versions`. Successful import of the installed modules is the runtime
compatibility check. Do not enable Developer mode, change policy, install
system packages, or broaden the approved origin.

If the Browser skill is not available, or its plugin root does not contain
`scripts/browser-client.mjs`, stop with `browser_plugin_unavailable`. Follow the
installed Browser skill completely. Use its Node `js` execution surface, reuse
an existing runtime when `agent.browsers` is already initialized, and never
initialize a second Browser client. Select the in-app Browser binding and read
its complete `documentation()` before creating or controlling a tab.

## Resolve Installed Modules

Resolve the absolute skill root from the catalog entry that loaded this
`SKILL.md`. Do not guess a cache directory and do not fall back to a source
checkout. Inside the same persistent JavaScript runtime that owns the Browser
tab, convert the two canonical module paths with `pathToFileURL`:

```js
const { resolve } = await import("node:path");
const { tmpdir } = await import("node:os");
const { pathToFileURL } = await import("node:url");
const temporaryRoot = tmpdir();
const doctorUrl = pathToFileURL(
  resolve(installedSkillRoot, "scripts/doctor.mjs"),
).href;
const recorderUrl = pathToFileURL(
  resolve(installedSkillRoot, "scripts/run-browser-recording.mjs"),
).href;
const { doctor } = await import(doctorUrl);
const { createBrowserRecording } = await import(recorderUrl);
```

`installedSkillRoot` must be the absolute directory containing this installed
skill, supplied as a quoted literal by the executing agent. If either import
fails, report `plugin_module_unavailable` without revealing the internal path.

## Recording Workflow

1. Use the Browser documentation's supported tab API to create a fresh tab and
   navigate it to exactly `https://example.com/`. Keep its binding only in the
   existing Browser runtime.
2. Obtain the tab's current `cdp` capability after navigation. Let the normal
   site and full-CDP approval UI run. If either approval is denied, report
   `cancelled`; do not retry, bypass approval, change origin, or switch browser.
3. Run `doctor` with only the temporary output root and whether the acquired CDP
   capability exposes both `send` and `readEvents`. `doctor` derives the host
   platform from `node:os`; when PATH metadata is unavailable, it verifies
   `ffmpeg` and `ffprobe` through bounded, shell-free inherited command
   resolution. Report all deterministic blockers and stop without mutating the
   environment.
4. Discard the preflight CDP reference. `createBrowserRecording` deliberately
   reacquires the current capability for the recording session.
5. Use one active-handle key and reject concurrent recording:

```js
const activeKey = Symbol.for("codex-browser-recorder.active");
if (globalThis[activeKey] != null) {
  throw Object.assign(new Error("A recording is already active"), {
    code: "recording_already_active",
  });
}
const handle = await createBrowserRecording({
  tab: freshTab,
  temporaryRoot,
  ffmpegPath: environment.ffmpegPath,
  ffprobePath: environment.ffprobePath,
  fps: 10,
  maxDecodedBytes: 5 * 1024 * 1024,
});
globalThis[activeKey] = handle;
await handle.ready;
```

6. After readiness, reacquire the approved `cdp` capability and use bounded
   `Runtime.evaluate` calls with static quoted expressions to add the visible
   clock/CSS animation and make the SPA-style DOM text/state change. Require a
   true return value and no `exceptionDetails`, then discard that capability.
   Do not pass a JavaScript function object to `freshTab.playwright.evaluate`;
   that form is not compatible with the Browser Node execution surface. Perform
   one scroll through the documented tab API. These changes belong only to the
   fresh test tab and are discarded when it closes.
7. Record for 10–15 seconds. Read `handle.status()` at bounded intervals and
   require fresh `framesReceived`, `framesAcknowledged`, and `outputSamples`
   progress. Never place frames, page content, CDP events, or encoder diagnostics
   in model context.
8. Call `handle.stop()` exactly through the stored handle. It is idempotent, so
   cleanup may safely call it again and receives the same finalization promise.

## Mandatory Cleanup

Use a `try`/`finally` around every action after the fresh tab is created. In the
`finally` path, preserve the primary failure while performing all of these:

1. call `await globalThis[activeKey]?.stop()` when a handle exists;
2. delete `globalThis[activeKey]`;
3. close the fresh test tab using the documented Browser tab API.

Never leave the active key, screencast, frame pump, FFmpeg process, partial
output, or fresh tab behind. Never retry a denied approval.

## Report Only the Result Contract

On success, report status, elapsed duration, received and acknowledged frame
counts, output samples, bounded drop/truncation counters, validated codec,
dimensions, size, duration, and the final local audio-free VP8 WebM path.

On failure, report one stable failure code and one actionable message. A denied
site or full-CDP approval is `cancelled`. Do not expose raw frames, CDP payloads,
FFmpeg stderr, full URLs, page content, tab objects, or internal plugin paths.
