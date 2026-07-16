---
name: record-browser
description: Use only when the user explicitly invokes $record-browser to save one test flow in a fresh approved tab in the browser selected by the installed Browser plugin as a cursor-complete local H.264 MP4 recording.
license: MIT
---

# Record Browser

## Collect The Request

Require a target URL and planned Browser actions. Use 15 seconds when the user does not provide a recording duration. Accept an optional absolute destination directory and optional recording name; otherwise use `~/Downloads/Codex Browser Recordings/` and a privacy-safe timestamp name. Set `requestedBrowser` to `"iab"` only when the user explicitly requests the Codex in-app Browser, to `"chrome"` only when the user explicitly requests Chrome, and to `null` otherwise. Classify the approved action list semantically and set `requirePointerEvents` to `true` when any action uses a pointer-driven click, hover, drag, or scroll; keep it `false` for keyboard-only, programmatic, or passive flows. Do not create or navigate a Browser tab yet.

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
let hasPointerActionEvidence;
let planSavedRecording;
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
  const artifactsUrl = pathToFileURL(
    resolve(installedSkillRoot, "scripts/recording-artifacts.mjs"),
  ).href;
  ({
    hasPointerActionEvidence,
    validateRecordingRequest,
  } = await import(policyUrl));
  ({ planSavedRecording } = await import(artifactsUrl));
  ({
    describeRecordingFailure,
    getRecordingCleanupDetails,
    sanitizeRecordingFailure,
  } = await import(outcomeUrl));
} catch {
  throw stableFailure("plugin_module_unavailable");
}
let request;
let savedRecording;
const recordingTimestamp = new Date();
try {
  request = validateRecordingRequest({
    durationMs,
    requirePointerEvents,
    targetUrl,
  });
  savedRecording = planSavedRecording({
    destinationDirectory,
    now: recordingTimestamp,
    recordingName,
  });
} catch (error) {
  throw stableFailure(error?.code);
}
```

## Confirm Once Before Browser Activity

Present one consolidated consent before any Browser action. Include the validated normalized approved origin, planned actions, duration, `savedRecording.destinationDirectory`, `savedRecording.outputFilename`, H.264 MP4 with no audio, the project-owned visible cursor and 200 ms click feedback, no browser chrome, no other tabs, and the sensitive-data exclusion. Explain that macOS may request file access and that an unavailable destination stops before Browser activity. Continue only after explicit confirmation; denial returns `cancelled` and performs no Browser action. Explain that a planned pointer action must produce an observable pointer event in the page or a supported embedded frame; otherwise the run fails closed without publishing cursor-incomplete media. A `$record-browser` mention selects the workflow but does not approve an unknown target or scope. Refuse credentials, payment data, passkeys, recovery secrets, health data, or confidential communications as out of scope for the first release.

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

Keep top-level navigation within `request.approvedOrigin`; stop if the page leaves that approved origin. Route every concrete approved Browser call through `runApprovedAction()` below and mark each click, hover, drag, or pointer-positioned scroll with `requiresPointerEvidence: true`. The helper proves that every pointer action produced a new observed pointer event whose trusted page timestamp is at or after the current action boundary; a delayed event from an earlier action never satisfies a later pointer action. Check `handle.status()` before and after each approved action. Stop performing Browser actions immediately when the state is no longer `recording`. Poll at most every 250 milliseconds and never beyond the requested duration plus 10 seconds. `handle.stop()` then returns the same memoized finalization result.

Do not inject clocks, animations, test text, or diagnostic interactions such as an unapproved scroll. Do not enable Developer mode, change policy, install packages, retry denied approval, broaden the origin, switch browsers, use an existing tab, or expose Browser/CDP objects.

Treat every failure during approved actions as untrusted. Preserve allowlisted failure codes and trusted cleanup metadata, map an action-time Browser approval denial to `cancelled`, and map every other unknown action failure through the generic allowlisted recording failure without exposing its message or diagnostics.

```js
let freshTab;
let handle;
let recordingResult;
let primaryFailure;
let incompleteCleanup;
const actionAbortController = new AbortController();
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
    {
      artifactCleanupIncomplete:
        cleanup?.artifactCleanupIncomplete === true,
      browserTabCleanupIncomplete:
        cleanup?.browserTabCleanupIncomplete === true,
      cleanupDirectory: cleanup?.directory,
      cleanupFile: cleanup?.cleanupFile,
    },
  );
};
try {
  handle = createRecording({
    browser: selectedBrowser,
    destinationDirectory: savedRecording.destinationDirectory,
    durationMs: request.durationMs,
    now: recordingTimestamp,
    recordingName,
    requirePointerEvents: request.requirePointerEvents,
    signal: actionAbortController.signal,
    targetUrl: request.targetUrl,
    temporaryRoot,
  });
  freshTab = await handle.ready;

  const pollDeadline = Date.now() + request.durationMs + 10_000;
  const terminalStates = new Set(["cancelled", "completed", "failed"]);
  const runApprovedAction = async ({ perform, requiresPointerEvidence }) => {
    const before = handle.status();
    if (before.state !== "recording") {
      throw stableFailure("integration_failed");
    }
    const beforeEvents = before.capture?.cursorEventsCaptured;
    const actionStartedAtEpochMs = Date.now();
    await perform();
    if (requiresPointerEvidence !== true) {
      if (handle.status().state !== "recording") {
        throw stableFailure("integration_failed");
      }
      return;
    }
    const evidenceDeadline = Math.min(Date.now() + 1_000, pollDeadline);
    while (Date.now() <= evidenceDeadline) {
      const current = handle.status();
      if (current.state !== "recording") {
        throw stableFailure("integration_failed");
      }
      if (hasPointerActionEvidence({
        actionStartedAtEpochMs,
        beforeEvents,
        capture: current.capture,
      })) {
        return;
      }
      await new Promise((resolveEvidence) =>
        setTimeout(resolveEvidence, 50),
      );
    }
    throw stableFailure("cursor_recording_failed");
  };

  // Perform each concrete approved Browser call here with runApprovedAction().
  // Use requiresPointerEvidence: true for every planned pointer action.
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
    if (typeof recordingResult.paths?.cleanupDirectory === "string") {
      incompleteCleanup = {
        cleanupIncomplete: true,
        directory: recordingResult.paths.cleanupDirectory,
        ...(typeof recordingResult.paths?.cleanupFile === "string"
          ? { cleanupFile: recordingResult.paths.cleanupFile }
          : {}),
      };
    } else if (typeof recordingResult.paths?.cleanupFile === "string") {
      incompleteCleanup = {
        cleanupFile: recordingResult.paths.cleanupFile,
        cleanupIncomplete: true,
      };
    }
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
  actionAbortController.abort();
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

On success, require `recordingResult.result.status === "passed"`, then lead with `Recording completed`. Report that the output is cursor-complete, plus duration, dimensions, H.264 MP4, no audio, and a clickable `[Saved Recording](<absolute path>)` link using `recordingResult.paths.outputPath`. Also report the absolute path as plain text for copyability. If `recordingResult.paths.cleanupDirectory` or `cleanupFile` is present, report that bounded local path for manual deletion without downgrading the Saved Recording. Offer `Open in Finder`, but do not open Finder or auto-play the recording unless the user asks. Offer bounded capture counters only as diagnostics.

On failure, report the stable failure code plus its allowlisted summary and remediation. Read `getRecordingCleanupDetails(primaryFailure) ?? incompleteCleanup` after the outer cleanup finishes. For `saved_recording_persistence_failed`, when `cleanupIncomplete` and `directory` are present, report `Working Recording retained temporarily for recovery: <directory>` and tell the user to copy it to a durable folder before cleanup. For other failures with the same metadata, add `Cleanup incomplete; delete locally: <directory>`. When `cleanupFile` is present, also add `Cleanup incomplete; delete local file: <cleanupFile>`. When `artifactCleanupIncomplete` is true without a known directory, add `Local artifact cleanup may be incomplete; inspect the operating-system temporary directory for a codex-browser-recorder entry.` When `browserTabCleanupIncomplete` is true, add `Browser cleanup incomplete; close the fresh recording tab manually.` This message must not include its URL. A private Working Recording directory or destination partial explicitly returned as cleanup metadata is the sole failure-path exception to path suppression. Never report full URLs, page text, raw frames, CDP payloads, FFmpeg stderr, credentials, or internal plugin paths.
