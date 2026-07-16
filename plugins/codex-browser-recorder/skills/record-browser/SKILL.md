---
name: record-browser
description: Use only when the user explicitly invokes $record-browser to record one fresh approved tab in the browser selected by the installed Browser plugin to a private local WebM file.
license: MIT
---

# Record Browser

## Collect The Request

Require a target URL and planned Browser actions. Use 15 seconds when the user does not provide a recording duration. Set `requestedBrowser` to `"iab"` only when the user explicitly requests the Codex in-app Browser, to `"chrome"` only when the user explicitly requests Chrome, and to `null` otherwise. Do not create or navigate a Browser tab yet.

## Validate The Request Locally

Resolve this installed skill directory from the catalog entry that loaded this file. Use that exact absolute directory for `installedSkillRoot`; do not leave the placeholder below unchanged. The collected `targetUrl` and `durationMs` are the values supplied by the user, with 15 seconds converted to milliseconds when the duration was omitted. Convert the bundled modules with `pathToFileURL`, then validate by local computation only. This module resolution and pure computation are not Browser activity. On rejection, report only its code plus the summary and remediation returned by `describeRecordingFailure(error.code)`. Stop before creating, navigating, or acquiring any Browser tab or CDP capability.

```js
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const installedSkillRoot = "<absolute installed record-browser skill directory from the loaded catalog entry>";
const temporaryRoot = tmpdir();
const moduleFailure = Object.freeze({
  remediation: "Install or enable the Browser plugin and approve full CDP access, then retry",
  summary: "The required Browser recording capability is unavailable",
});
let describeRecordingFailure;
let getRecordingCleanupDetails;
let sanitizeRecordingFailure;
let validateRecordingRequest;
const stableFailure = (code) => {
  if (typeof sanitizeRecordingFailure === "function") {
    return sanitizeRecordingFailure({ code });
  }
  return Object.assign(new Error(moduleFailure.summary), {
    code: "plugin_module_unavailable",
    ...moduleFailure,
  });
};
try {
  const policyUrl = pathToFileURL(
    resolve(installedSkillRoot, "scripts/recording-policy.mjs"),
  ).href;
  const outcomeUrl = pathToFileURL(
    resolve(installedSkillRoot, "scripts/recording-outcome.mjs"),
  ).href;
  ({ validateRecordingRequest } = await import(policyUrl));
  ({
    describeRecordingFailure,
    getRecordingCleanupDetails,
    sanitizeRecordingFailure,
  } = await import(outcomeUrl));
} catch {
  throw stableFailure("plugin_module_unavailable");
}
let request;
try {
  request = validateRecordingRequest({ durationMs, targetUrl });
} catch (error) {
  throw stableFailure(error?.code);
}
```

## Confirm Once Before Browser Activity

Present one consolidated consent before any Browser action. Include the validated normalized approved origin, planned actions, duration, private temporary output, no audio, no browser chrome, no other tabs, and the sensitive-data exclusion. Continue only after explicit confirmation; denial returns `cancelled` and performs no Browser action. A `$record-browser` mention selects the workflow but does not approve an unknown target or scope. Refuse credentials, payment data, passkeys, recovery secrets, health data, or confidential communications as out of scope for the first release.

## Resolve Installed Modules

Using the already resolved installed skill directory, convert `scripts/create-recording.mjs` with `pathToFileURL`. Never guess a cache path or fall back to a source checkout. Import it inside the persistent Browser Node runtime.

Follow the installed Browser control skill for its exact Node runtime tool and resolve its plugin root from that loaded catalog entry. Initialize `browser-client.mjs` once. Preserve an explicit Browser choice with `get("iab")` or `get("extension")`; only use `getForUrl` when the user did not choose a Browser. Emit the selected Browser's complete documentation exactly once before using it. Do not substitute another browser-control surface.

```js
const browserPluginRoot = "<absolute installed Browser plugin root from the loaded catalog entry>";
let createRecording;
try {
  const recordingUrl = pathToFileURL(
    resolve(installedSkillRoot, "scripts/create-recording.mjs"),
  ).href;
  ({ createRecording } = await import(recordingUrl));
} catch {
  throw stableFailure("plugin_module_unavailable");
}
try {
  if (globalThis.agent?.browsers == null) {
    const browserClientUrl = pathToFileURL(
      resolve(browserPluginRoot, "scripts/browser-client.mjs"),
    ).href;
    const { setupBrowserRuntime } = await import(browserClientUrl);
    await setupBrowserRuntime({ globals: globalThis });
  }
} catch {
  throw stableFailure("browser_plugin_unavailable");
}
try {
  if (requestedBrowser === "iab") {
    if (globalThis.iab == null) {
      globalThis.iab = await agent.browsers.get("iab");
      nodeRepl.write(await iab.documentation());
    }
    globalThis.selectedBrowser = globalThis.iab;
  } else if (requestedBrowser === "chrome") {
    if (globalThis.chrome == null) {
      globalThis.chrome = await agent.browsers.get("extension");
      nodeRepl.write(await chrome.documentation());
    }
    globalThis.selectedBrowser = globalThis.chrome;
  } else {
    if (globalThis.browser == null) {
      globalThis.browser = await agent.browsers.getForUrl(request.targetUrl);
      nodeRepl.write(await browser.documentation());
    }
    globalThis.selectedBrowser = globalThis.browser;
  }
} catch {
  throw stableFailure("integration_failed");
}
```

## Run The Recording

Call `createRecording()` once with `selectedBrowser` after consent. The coordinator owns creation, navigation, full-CDP preflight, environment doctor, capture startup, finalization, fresh-tab closure, and rollback for exactly one fresh blank Browser tab. Its `ready` promise returns only that fresh tab for the approved Browser actions. A denied site or CDP approval returns `cancelled`; never retry or bypass it.

Keep top-level navigation within `request.approvedOrigin`; stop if the page leaves that approved origin. Check `handle.status()` before and after each approved action. Stop performing Browser actions immediately when the state is no longer `recording`. Poll at most every 250 milliseconds and never beyond the requested duration plus 10 seconds. `handle.stop()` then returns the same memoized finalization result.

Do not inject clocks, animations, test text, or diagnostic interactions such as an unapproved scroll. Do not enable Developer mode, change policy, install packages, retry denied approval, broaden the origin, switch browsers, use an existing tab, or expose Browser/CDP objects.

Treat every failure during approved actions as untrusted. Preserve allowlisted failure codes and trusted cleanup metadata, map an action-time Browser approval denial to `cancelled`, and map every other unknown action failure through the generic allowlisted recording failure without exposing its message or diagnostics.

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
const sanitizeActionFailure = (error) => {
  if (!isBrowserApprovalDenial(error)) {
    return sanitizeRecordingFailure(error);
  }
  const cleanup = getRecordingCleanupDetails(error);
  return sanitizeRecordingFailure(
    { code: "cancelled" },
    cleanup?.cleanupIncomplete === true
      ? { cleanupDirectory: cleanup.directory }
      : undefined,
  );
};
try {
  handle = createRecording({
    browser: selectedBrowser,
    durationMs: request.durationMs,
    targetUrl: request.targetUrl,
    temporaryRoot,
  });
  freshTab = await handle.ready;

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
  primaryFailure = sanitizeActionFailure(error);
  throw primaryFailure;
} finally {
  let cleanupFailure;
  try {
    await handle?.stop();
  } catch (error) {
    cleanupFailure ??= error;
    incompleteCleanup ??= getRecordingCleanupDetails(error);
  }
  if (primaryFailure == null && cleanupFailure != null) {
    primaryFailure = cleanupFailure;
    throw cleanupFailure;
  }
}
```

## Clean Up

Always call `await handle?.stop()`. It finalizes the recording before closing its fresh tab. Preserve the primary failure if cleanup also fails, retain only bounded manual-cleanup state, and do not resume Browser actions. Never silently leave a screencast, frame pump, FFmpeg process, partial output, singleton, or fresh tab active.

## Report The Result

On success, require `recordingResult.result.status === "passed"`, then lead with `Recording completed`, duration, VP8 WebM, dimensions, no audio, and `Saved locally: <recordingResult.paths.outputPath>`. Offer bounded capture counters only as diagnostics.

On failure, report the stable failure code plus its allowlisted summary and remediation. Read `getRecordingCleanupDetails(primaryFailure) ?? incompleteCleanup` after the outer cleanup finishes. When `cleanupIncomplete` and `directory` are present, add `Cleanup incomplete; delete locally: <directory>`. When `artifactCleanupIncomplete` is true without a known directory, add `Local artifact cleanup may be incomplete; inspect the operating-system temporary directory for a codex-browser-recorder entry.` When `browserTabCleanupIncomplete` is true, add `Browser cleanup incomplete; close the fresh recording tab manually.` This message must not include its URL. The private temporary recording directory is the sole failure-path exception to path suppression. Never report full URLs, page text, raw frames, CDP payloads, FFmpeg stderr, credentials, or internal plugin paths.
