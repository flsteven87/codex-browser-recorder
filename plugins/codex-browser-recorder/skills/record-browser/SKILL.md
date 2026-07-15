---
name: record-browser
description: Use only when the user explicitly invokes $record-browser to record one fresh approved Codex Browser tab to a private local WebM file.
license: MIT
---

# Record Browser

## Collect The Request

Require a target URL and planned Browser actions. Use 15 seconds when the user does not provide a recording duration. Do not create or navigate a Browser tab yet.

## Validate The Request Locally

Resolve this installed skill directory from the catalog entry that loaded this file. Convert `scripts/recording-policy.mjs` and `scripts/recording-artifacts.mjs` with `pathToFileURL`; import `validateRecordingRequest` and `describeRecordingFailure`. Validate the target plus duration using local computation only. This module resolution and pure computation are not Browser activity. On rejection, report only its code plus the summary and remediation returned by `describeRecordingFailure(error.code)`. Stop before creating, navigating, or acquiring any Browser tab or CDP capability.

```js
const policyUrl = pathToFileURL(
  resolve(installedSkillRoot, "scripts/recording-policy.mjs"),
).href;
const artifactsUrl = pathToFileURL(
  resolve(installedSkillRoot, "scripts/recording-artifacts.mjs"),
).href;
const { validateRecordingRequest } = await import(policyUrl);
const { describeRecordingFailure } = await import(artifactsUrl);
const request = validateRecordingRequest({ durationMs, targetUrl });
```

## Confirm Once Before Browser Activity

Present one consolidated consent before any Browser action. Include the validated normalized approved origin, planned actions, duration, private temporary output, no audio, no browser chrome, no other tabs, and the sensitive-data exclusion. Continue only after explicit confirmation; denial returns `cancelled` and performs no Browser action. A `$record-browser` mention selects the workflow but does not approve an unknown target or scope. Refuse credentials, payment data, passkeys, recovery secrets, health data, or confidential communications as out of scope for the first release.

## Resolve Installed Modules

Using the already resolved installed skill directory, convert `scripts/doctor.mjs` and `scripts/create-recording.mjs` with `pathToFileURL`. Never guess a cache path or fall back to a source checkout. Import both modules inside the persistent Browser Node runtime.

```js
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

Create one fresh blank Browser tab. Bind navigation and closure functions to only that tab. In one outer `try`/`finally`, navigate to the validated target, allow normal site and full-CDP approval, run `doctor()`, call `createRecording()`, await `handle.ready`, perform only the approved Browser actions, and read bounded status until the deterministic duration completes. A denied site or CDP approval returns `cancelled`; never retry or bypass it. Call `handle.stop()` to obtain the memoized result.

Keep top-level navigation within `request.approvedOrigin`; stop if the page leaves that approved origin. Check `handle.status()` before and after each approved action. Stop performing Browser actions immediately when the state is no longer `recording`. Keep bounded progress polling until the requested-duration timer or another terminal condition settles the recording. `handle.stop()` then returns the same memoized finalization result.

Do not inject clocks, animations, test text, or diagnostic interactions such as an unapproved scroll. Do not enable Developer mode, change policy, install packages, retry denied approval, broaden the origin, switch browsers, use an existing tab, or expose Browser/CDP objects.

```js
let handle;
let recordingResult;
let primaryFailure;
try {
  await navigateFreshTab(request.targetUrl);

  // Complete normal site/CDP approval and the bounded doctor preflight here.
  handle = createRecording({
    durationMs: request.durationMs,
    ffmpegPath: environment.ffmpegPath,
    ffprobePath: environment.ffprobePath,
    tab: freshTab,
    targetUrl: request.targetUrl,
    temporaryRoot,
  });
  await handle.ready;

  // Perform only the actions listed in the approved consent.
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

## Clean Up

Always call `await handle?.stop()` before closing the fresh tab. Preserve the primary failure if cleanup also fails. Never leave a screencast, frame pump, FFmpeg process, partial output, singleton, or fresh tab active.

## Report The Result

On success, lead with `Recording completed`, duration, VP8 WebM, dimensions, no audio, and `Saved locally: <path>`. Offer bounded capture counters only as diagnostics. On failure, report the stable failure code plus its allowlisted summary and remediation. Never report full URLs, page text, raw frames, CDP payloads, FFmpeg stderr, credentials, or internal plugin paths.
