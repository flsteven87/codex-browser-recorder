---
name: record-browser
description: Use only when the user explicitly invokes $record-browser to record one fresh approved Codex Browser tab to a private local WebM file.
license: MIT
---

# Record Browser

## Collect The Request

Require a target URL and planned Browser actions. Use 15 seconds when the user does not provide a recording duration. Do not create or navigate a Browser tab yet.

## Validate The Request Locally

Resolve this installed skill directory from the catalog entry that loaded this file. Use that exact absolute directory for `installedSkillRoot`; do not leave the placeholder below unchanged. The collected `targetUrl` and `durationMs` are the values supplied by the user, with 15 seconds converted to milliseconds when the duration was omitted. Convert the bundled modules with `pathToFileURL`, then validate by local computation only. This module resolution and pure computation are not Browser activity. On rejection, report only its code plus the summary and remediation returned by `describeRecordingFailure(error.code)`. Stop before creating, navigating, or acquiring any Browser tab or CDP capability.

```js
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const installedSkillRoot = "<absolute installed record-browser skill directory from the loaded catalog entry>";
const temporaryRoot = tmpdir();
const policyUrl = pathToFileURL(
  resolve(installedSkillRoot, "scripts/recording-policy.mjs"),
).href;
const artifactsUrl = pathToFileURL(
  resolve(installedSkillRoot, "scripts/recording-artifacts.mjs"),
).href;
const { validateRecordingRequest } = await import(policyUrl);
const {
  describeRecordingFailure,
  getRecordingCleanupDetails,
} = await import(artifactsUrl);
const request = validateRecordingRequest({ durationMs, targetUrl });
```

## Confirm Once Before Browser Activity

Present one consolidated consent before any Browser action. Include the validated normalized approved origin, planned actions, duration, private temporary output, no audio, no browser chrome, no other tabs, and the sensitive-data exclusion. Continue only after explicit confirmation; denial returns `cancelled` and performs no Browser action. A `$record-browser` mention selects the workflow but does not approve an unknown target or scope. Refuse credentials, payment data, passkeys, recovery secrets, health data, or confidential communications as out of scope for the first release.

## Resolve Installed Modules

Using the already resolved installed skill directory, convert `scripts/doctor.mjs` and `scripts/create-recording.mjs` with `pathToFileURL`. Never guess a cache path or fall back to a source checkout. Import both modules inside the persistent Browser Node runtime.

Follow the installed Browser control skill for its exact Node runtime tool and resolve its plugin root from that loaded catalog entry. Initialize `browser-client.mjs` once, select the Browser for the validated target with `getForUrl`, and emit the selected Browser's complete documentation exactly once before using it. Do not substitute another browser-control surface.

```js
const browserPluginRoot = "<absolute installed Browser plugin root from the loaded catalog entry>";
if (globalThis.agent?.browsers == null) {
  const browserClientUrl = pathToFileURL(
    resolve(browserPluginRoot, "scripts/browser-client.mjs"),
  ).href;
  const { setupBrowserRuntime } = await import(browserClientUrl);
  await setupBrowserRuntime({ globals: globalThis });
}
if (globalThis.browser == null) {
  globalThis.browser = await agent.browsers.getForUrl(request.targetUrl);
  nodeRepl.write(await browser.documentation());
}

const doctorUrl = pathToFileURL(
  resolve(installedSkillRoot, "scripts/doctor.mjs"),
).href;
const recordingUrl = pathToFileURL(
  resolve(installedSkillRoot, "scripts/create-recording.mjs"),
).href;
const { doctor } = await import(doctorUrl);
const { createRecording } = await import(recordingUrl);
```

## Run The Recording

Create one fresh blank Browser tab with `browser.tabs.new()`. Bind navigation and closure only to that returned tab. Navigate it with `freshTab.goto()`, then acquire `freshTab.capabilities.get("cdp")` once as a preflight for full-CDP approval. A denied site or CDP approval returns `cancelled`; never retry or bypass it. Check that the capability exposes both `send` and `readEvents`, discard the preflight reference, and call `doctor({ cdpAvailable, outputDirectory: temporaryRoot })`. If `supported` is false, stop on the first allowlisted blocker. `createRecording()` deliberately reacquires a fresh CDP capability for the actual session.

Keep top-level navigation within `request.approvedOrigin`; stop if the page leaves that approved origin. Check `handle.status()` before and after each approved action. Stop performing Browser actions immediately when the state is no longer `recording`. Poll at most every 250 milliseconds and never beyond the requested duration plus 10 seconds. `handle.stop()` then returns the same memoized finalization result.

Do not inject clocks, animations, test text, or diagnostic interactions such as an unapproved scroll. Do not enable Developer mode, change policy, install packages, retry denied approval, broaden the origin, switch browsers, use an existing tab, or expose Browser/CDP objects.

```js
let freshTab;
let handle;
let recordingResult;
let primaryFailure;
let incompleteCleanup;
const isBrowserApprovalDenial = (error) => {
  const message = error instanceof Error ? error.message : "";
  return /Browser Use rejected this action due to browser security policy[.] Reason: The user has requested that .+(?:should not be used|not be used on)/su.test(
    message,
  );
};
const mapBrowserRuntimeFailure = (error) => {
  const code = isBrowserApprovalDenial(error) ? "cancelled" : "integration_failed";
  const failure = describeRecordingFailure(code);
  return Object.assign(new Error(failure.summary), { code, ...failure });
};
const navigateFreshTab = async () => {
  try {
    freshTab = await browser.tabs.new();
    await freshTab.goto(request.targetUrl);
  } catch (error) {
    throw mapBrowserRuntimeFailure(error);
  }
};
const closeFreshTab = async () => {
  await freshTab?.close();
};
try {
  await navigateFreshTab(request.targetUrl);

  let preflightCdp;
  try {
    preflightCdp = await freshTab.capabilities.get("cdp");
  } catch (error) {
    throw mapBrowserRuntimeFailure(error);
  }
  const cdpAvailable =
    typeof preflightCdp?.send === "function" &&
    typeof preflightCdp?.readEvents === "function";
  preflightCdp = null;

  const environment = await doctor({
    cdpAvailable,
    outputDirectory: temporaryRoot,
  });
  if (!environment.supported) {
    const code = environment.blockingReasons[0] ?? "integration_failed";
    const blocker = describeRecordingFailure(code);
    throw Object.assign(new Error(blocker.summary), { code, ...blocker });
  }

  handle = createRecording({
    durationMs: request.durationMs,
    ffmpegPath: environment.ffmpegPath,
    ffprobePath: environment.ffprobePath,
    tab: freshTab,
    targetUrl: request.targetUrl,
    temporaryRoot,
  });
  await handle.ready;

  // Perform each concrete Browser call from the approved action list here.
  // Before and after every call, require handle.status().state === "recording".
  const pollDeadline = Date.now() + request.durationMs + 10_000;
  const terminalStates = new Set(["cancelled", "completed", "failed"]);
  while (Date.now() < pollDeadline) {
    const current = handle.status();
    if (terminalStates.has(current.state)) break;
    await new Promise((resolvePoll) => setTimeout(resolvePoll, 250));
  }
  recordingResult = await handle.stop();
  if (recordingResult.result.status === "passed") {
    // Continue to the bounded success report below.
  } else if (recordingResult.result.status === "failed") {
    const code = recordingResult.result.failureCode ?? "recording_failed";
    const failure = describeRecordingFailure(code);
    throw Object.assign(new Error(failure.summary), { code, ...failure });
  } else {
    const failure = describeRecordingFailure("integration_failed");
    throw Object.assign(new Error(failure.summary), {
      code: "integration_failed",
      ...failure,
    });
  }
} catch (error) {
  primaryFailure = error;
  throw error;
} finally {
  let cleanupFailure;
  try {
    await handle?.stop();
  } catch (error) {
    cleanupFailure ??= error;
    incompleteCleanup ??= getRecordingCleanupDetails(error);
  }
  try {
    await closeFreshTab();
  } catch (error) {
    cleanupFailure ??= error;
  }
  if (primaryFailure == null && cleanupFailure != null) {
    primaryFailure = cleanupFailure;
    throw cleanupFailure;
  }
}
```

## Clean Up

Always call `await handle?.stop()` before closing the fresh tab. Preserve the primary failure if cleanup also fails. Never leave a screencast, frame pump, FFmpeg process, partial output, singleton, or fresh tab active.

## Report The Result

On success, require `recordingResult.result.status === "passed"`, then lead with `Recording completed`, duration, VP8 WebM, dimensions, no audio, and `Saved locally: <recordingResult.paths.outputPath>`. Offer bounded capture counters only as diagnostics.

On failure, report the stable failure code plus its allowlisted summary and remediation. Read `getRecordingCleanupDetails(primaryFailure) ?? incompleteCleanup` after the outer cleanup finishes. Only when it returns `{ cleanupIncomplete: true, directory }`, add `Cleanup incomplete; delete locally: <directory>`. This private temporary recording directory is the sole failure-path exception to path suppression. Never report full URLs, page text, raw frames, CDP payloads, FFmpeg stderr, credentials, or internal plugin paths.
