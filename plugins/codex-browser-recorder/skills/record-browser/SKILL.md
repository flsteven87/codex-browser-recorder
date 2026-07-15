---
name: record-browser
description: Use only when the user explicitly invokes $record-browser to record the fixed approved Codex Browser example.com gate to a local WebM file.
license: MIT
---

# Record Browser

**Compatibility:** Requires Codex desktop on macOS, the Browser plugin with
full CDP access, and FFmpeg plus FFprobe with VP8 WebM support.

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
`process.versions`. The environment doctor feature-detects the required media
capabilities and is the runtime compatibility check; importing the installed
modules only proves that they are available. Do not enable Developer mode,
change policy, install system packages, or broaden the approved origin.

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
const gateUrl = pathToFileURL(
  resolve(installedSkillRoot, "scripts/example-recording-gate.mjs"),
).href;
const { doctor } = await import(doctorUrl);
const { createExampleRecording } = await import(gateUrl);
```

`installedSkillRoot` must be the absolute directory containing this installed
skill, supplied as a quoted literal by the executing agent. If either import
fails, report `plugin_module_unavailable` without revealing the internal path.

## Recording Workflow

1. Use the Browser documentation's supported tab API to create one fresh blank
   tab without navigating it. Keep its binding only in the existing Browser
   runtime.
2. Immediately bind `navigateFreshTab(targetUrl)` and `closeFreshTab()` as
   closures over the documented API for only `freshTab`. Then enter the single
   outer lifecycle block below. Its first awaited operation must navigate the
   fresh tab to exactly `https://example.com/`; run every later action inside
   the same `try`.
3. Keep the handle in outer scope, start the deterministic fixed-policy gate,
   and wait for readiness. Perform steps 4–6 and 7–8 at the marked positions:

```js
let handle;
let recordingResult;
let primaryFailure;
try {
  await navigateFreshTab("https://example.com/");

  // Complete approval and doctor steps 4–6 here.
  handle = await createExampleRecording({
    tab: freshTab,
    temporaryRoot,
    ffmpegPath: environment.ffmpegPath,
    ffprobePath: environment.ffprobePath,
  });
  await handle.ready;

  // Complete disposable interactions and progress steps 7–8 here.
  recordingResult = await handle.stop();
} catch (error) {
  primaryFailure = error;
  throw error;
} finally {
  let cleanupFailure;
  try {
    await handle?.stop();
  } catch (error) {
    cleanupFailure ??= error;
  }
  try {
    await closeFreshTab();
  } catch (error) {
    cleanupFailure ??= error;
  }
  if (primaryFailure == null && cleanupFailure != null) {
    throw cleanupFailure;
  }
}
```

Use `recordingResult` for the final response only after the lifecycle block has
finished and the fresh tab is closed.

4. Obtain the tab's current `cdp` capability after navigation. Let the normal
   site and full-CDP approval UI run. If either approval is denied, report
   `cancelled`; do not retry, bypass approval, change origin, or switch browser.
5. Run `doctor` with only the temporary output root and whether the acquired CDP
   capability exposes both `send` and `readEvents`. `doctor` derives the host
   platform from `node:os`; when PATH metadata is unavailable, it verifies
   `ffmpeg` and `ffprobe` through bounded, shell-free inherited command
   resolution. Report all deterministic blockers and stop without mutating the
   environment.
6. Discard the preflight CDP reference. `createExampleRecording` deliberately
   reacquires the current capability for the recording session. Exact URL
   verification, the non-overridable 20-second hard stop, and singleton
   enforcement are runtime policy and cannot be overridden by the skill.
7. After readiness, reacquire the approved `cdp` capability and use bounded
   `Runtime.evaluate` calls with static quoted expressions to add the visible
   clock/CSS animation and make the SPA-style DOM text/state change. Require a
   true return value and no `exceptionDetails`, then discard that capability.
   Do not pass a JavaScript function object to `freshTab.playwright.evaluate`;
   that form is not compatible with the Browser Node execution surface. Perform
   one scroll through the documented tab API. These changes belong only to the
   fresh test tab and are discarded when it closes.
8. Record for 10–15 seconds. Read `handle.status()` at bounded intervals and
   require fresh `framesReceived`, `framesAcknowledged`, and `outputSamples`
   progress. Never place frames, page content, CDP events, or encoder diagnostics
   in model context.
   Call `handle.stop()` exactly through the stored handle when the interval
   completes. It is idempotent, so cleanup may safely call it again and receives
   the same finalization promise.

## Mandatory Cleanup

Use a `try`/`finally` around every action after the fresh tab is created. In the
`finally` path, always attempt both of these in order:

1. call `await handle?.stop()` when a handle exists;
2. close the fresh test tab using the documented Browser tab API.

The runtime gate owns recorder startup rollback and cleanup. The skill must
still stop its stored handle and close its fresh tab. Never leave a screencast,
frame pump, FFmpeg process, partial output, or fresh tab behind. Never retry a
denied approval. Keep the first cleanup failure only for the case where no
primary failure exists. When a primary failure exists, do not throw, return, or
report a cleanup failure from `finally`; let the primary failure keep its stable
code and actionable message. Sanitize a cleanup-only failure through the same
result contract.

## Report Only the Result Contract

On success, report status, elapsed duration, received and acknowledged frame
counts, output samples, bounded drop/truncation counters, validated codec,
dimensions, size, duration, and the final local audio-free VP8 WebM path.

On failure, report one stable failure code and one actionable message. A denied
site or full-CDP approval is `cancelled`. Do not expose raw frames, CDP payloads,
FFmpeg stderr, full URLs, page content, tab objects, or internal plugin paths.
