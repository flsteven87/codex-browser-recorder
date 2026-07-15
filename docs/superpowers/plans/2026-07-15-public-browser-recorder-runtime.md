# Public Browser Recorder Runtime Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the fixed `example.com` user workflow with one safe public `$record-browser` workflow whose target, duration, origin lock, media lifecycle, artifacts, and cleanup are enforced by deterministic code.

**Architecture:** Add a pure request-policy boundary, continuously enforce the approved top-level origin through the existing CDP event stream, extract transactional artifacts and a schema-v3 result contract, and wrap the lower-level session with one public `createRecording()` coordinator. Move the fixed example workflow outside the shipped plugin so it remains a release gate that exercises the production entry point rather than a user-visible product mode.

**Tech Stack:** Node.js 24 built-ins, `node:test`, Codex Browser tab-scoped CDP, FFmpeg/FFprobe, VP8 WebM, Agent Skills and Codex plugin validators.

## Global Constraints

- Keep the plugin skills-only; do not add an MCP server, app, hook, remote service, upload path, or separate browser process.
- Keep invocation explicit through `$record-browser`; `policy.allow_implicit_invocation` remains `false`.
- Accept only `https:` targets and explicitly approved loopback `http:` targets with host `localhost`, `127.0.0.1`, or `[::1]`.
- Reject target URLs containing a username or password before Browser activity.
- Scope consent and continuous recording policy to one normalized origin; allow same-origin path, fragment, and SPA state changes.
- A top-level cross-origin navigation must stop the session, discard the entire recording, and return `origin_changed_during_recording`.
- Default to 15,000 ms; accept 5,000 through 60,000 ms; enforce a non-overridable 65,000 ms hard limit.
- Keep 10 fps, JPEG quality 70, maximum dimensions 1280x720, maximum decoded frame size 5 MiB, and an implementation-selected output limit no larger than the current 500 MiB boundary.
- Keep output private, temporary, local, audio-free, VP8, and WebM.
- Never put raw frames, page text, full URLs, CDP payloads, Browser objects, FFmpeg stderr, credentials, or internal plugin paths in model context or result JSON.
- Preserve normal Browser site and full-CDP approvals. Denial maps to `cancelled`; never retry or bypass it.
- Use TDD for every behavior change. Observe each focused test fail for the intended missing behavior before writing production code.
- Preserve the user's untracked `MEMORY.md`; do not stage, modify, or delete it.
- Do not change GitHub settings, create tags/releases, push, or submit the plugin in this plan.

---

## File Structure

### Shipped plugin

- `scripts/recording-policy.mjs` — pure URL, origin, duration, and fixed-limit policy.
- `scripts/browser-recording.mjs` — CDP session startup, continuous navigation enforcement, resource limits, and lower-level adapter.
- `scripts/media-recorder.mjs` — frame parsing/pump and FFmpeg sink.
- `scripts/recording-artifacts.mjs` — private paths, schema-v3 result, allowlisted messages, and artifact transaction.
- `scripts/create-recording.mjs` — singleton, public state machine, requested-duration timer, and public handle.
- `scripts/doctor.mjs` — unchanged read-only environment feature probes.
- `scripts/validate-video.mjs` — unchanged strict WebM/VP8/no-audio validator except imports required by artifact extraction.
- `SKILL.md` — consent and Browser orchestration only.
- `agents/openai.yaml` — public skill copy and explicit invocation policy.

### Repository-only verification

- `scripts/example-recording-release-gate.mjs` — fixed `example.com` release scenario built on `createRecording()`.
- `tests/recording-policy.test.mjs` — request-policy tests.
- `tests/create-recording.test.mjs` — public coordinator and state-machine tests.
- `tests/browser-recording.test.mjs` — CDP session, navigation, lifecycle, and adapter tests.
- `tests/media-recorder.test.mjs` — renamed frame and FFmpeg tests.
- `tests/recording-artifacts.test.mjs` — schema, persistence, cleanup, and validation tests.
- `tests/example-recording-release-gate.test.mjs` — repository-only example gate tests.
- Existing plugin structure, skill contract, doctor, validator, and installation tests remain focused on their corresponding boundaries.

---

### Task 1: Add The Recording Request Policy

**Files:**
- Create: `plugins/codex-browser-recorder/skills/record-browser/scripts/recording-policy.mjs`
- Create: `tests/recording-policy.test.mjs`

**Interfaces:**
- Produces `validateRecordingRequest({ durationMs?, targetUrl }): { approvedOrigin, durationMs, targetUrl }`.
- Produces `originOf(value): string | null` without throwing or returning the input.
- Produces fixed duration constants plus `RECORDING_FPS`,
  `RECORDING_JPEG_QUALITY`, `RECORDING_MAX_DECODED_BYTES`,
  `RECORDING_MAX_HEIGHT`, `RECORDING_MAX_OUTPUT_BYTES`, and
  `RECORDING_MAX_WIDTH`.
- Throws errors with allowlisted codes `invalid_target`, `target_credentials_present`, `target_scheme_not_allowed`, or `invalid_duration`.

- [ ] **Step 1: Write the failing policy tests**

Create `tests/recording-policy.test.mjs`:

```js
import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_RECORDING_DURATION_MS,
  MAX_RECORDING_DURATION_MS,
  MIN_RECORDING_DURATION_MS,
  RECORDING_FPS,
  RECORDING_HARD_LIMIT_MS,
  RECORDING_JPEG_QUALITY,
  RECORDING_MAX_DECODED_BYTES,
  RECORDING_MAX_HEIGHT,
  RECORDING_MAX_OUTPUT_BYTES,
  RECORDING_MAX_WIDTH,
  originOf,
  validateRecordingRequest,
} from "../plugins/codex-browser-recorder/skills/record-browser/scripts/recording-policy.mjs";

test("normalizes approved HTTPS and loopback targets", () => {
  const cases = [
    ["https://example.com/demo#step", "https://example.com"],
    ["https://example.com:8443/demo", "https://example.com:8443"],
    ["http://localhost:3000/demo", "http://localhost:3000"],
    ["http://127.0.0.1:4173/", "http://127.0.0.1:4173"],
    ["http://[::1]:8080/", "http://[::1]:8080"],
  ];

  for (const [targetUrl, approvedOrigin] of cases) {
    assert.deepEqual(validateRecordingRequest({ targetUrl }), {
      approvedOrigin,
      durationMs: DEFAULT_RECORDING_DURATION_MS,
      targetUrl,
    });
  }
});

test("rejects invalid, credentialed, and unsupported targets without echoing them", () => {
  const cases = [
    ["not a URL", "invalid_target"],
    ["https://user:secret@example.com/", "target_credentials_present"],
    ["http://example.com/", "target_scheme_not_allowed"],
    ["file:///private/secret", "target_scheme_not_allowed"],
  ];

  for (const [targetUrl, code] of cases) {
    assert.throws(
      () => validateRecordingRequest({ targetUrl }),
      (error) =>
        error.code === code &&
        !error.message.includes(targetUrl) &&
        !JSON.stringify(error).includes(targetUrl),
    );
  }
});

test("accepts only bounded integer recording durations", () => {
  for (const durationMs of [MIN_RECORDING_DURATION_MS, 15_000, MAX_RECORDING_DURATION_MS]) {
    assert.equal(
      validateRecordingRequest({ durationMs, targetUrl: "https://example.com/" })
        .durationMs,
      durationMs,
    );
  }

  for (const durationMs of [4_999, 60_001, 15_000.5, Number.NaN]) {
    assert.throws(
      () => validateRecordingRequest({ durationMs, targetUrl: "https://example.com/" }),
      (error) => error.code === "invalid_duration",
    );
  }
  assert.equal(RECORDING_HARD_LIMIT_MS, 65_000);
});

test("extracts an origin without leaking invalid input", () => {
  assert.equal(originOf("https://example.com/path?token=secret"), "https://example.com");
  assert.equal(originOf("not a URL"), null);
});

test("exports the non-overridable media and resource limits", () => {
  assert.deepEqual(
    {
      fps: RECORDING_FPS,
      jpegQuality: RECORDING_JPEG_QUALITY,
      maxDecodedBytes: RECORDING_MAX_DECODED_BYTES,
      maxHeight: RECORDING_MAX_HEIGHT,
      maxOutputBytes: RECORDING_MAX_OUTPUT_BYTES,
      maxWidth: RECORDING_MAX_WIDTH,
    },
    {
      fps: 10,
      jpegQuality: 70,
      maxDecodedBytes: 5 * 1024 * 1024,
      maxHeight: 720,
      maxOutputBytes: 500 * 1024 * 1024,
      maxWidth: 1280,
    },
  );
});
```

- [ ] **Step 2: Run the policy test and verify RED**

Run:

```bash
node --test tests/recording-policy.test.mjs
```

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `recording-policy.mjs`.

- [ ] **Step 3: Implement the pure policy module**

Create `recording-policy.mjs`:

```js
export const DEFAULT_RECORDING_DURATION_MS = 15_000;
export const MIN_RECORDING_DURATION_MS = 5_000;
export const MAX_RECORDING_DURATION_MS = 60_000;
export const RECORDING_HARD_LIMIT_MS = 65_000;
export const RECORDING_FPS = 10;
export const RECORDING_JPEG_QUALITY = 70;
export const RECORDING_MAX_DECODED_BYTES = 5 * 1024 * 1024;
export const RECORDING_MAX_HEIGHT = 720;
export const RECORDING_MAX_OUTPUT_BYTES = 500 * 1024 * 1024;
export const RECORDING_MAX_WIDTH = 1280;

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

class RecordingPolicyError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "RecordingPolicyError";
    this.code = code;
  }
}

export function originOf(value) {
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

export function validateRecordingRequest({
  durationMs = DEFAULT_RECORDING_DURATION_MS,
  targetUrl,
}) {
  let target;
  try {
    target = new URL(targetUrl);
  } catch {
    throw new RecordingPolicyError("invalid_target", "The recording target is not a valid URL");
  }

  if (target.username.length > 0 || target.password.length > 0) {
    throw new RecordingPolicyError(
      "target_credentials_present",
      "The recording target must not contain URL credentials",
    );
  }

  const secureTarget = target.protocol === "https:";
  const loopbackTarget =
    target.protocol === "http:" && LOOPBACK_HOSTS.has(target.hostname);
  if (!secureTarget && !loopbackTarget) {
    throw new RecordingPolicyError(
      "target_scheme_not_allowed",
      "The recording target must use HTTPS or an approved loopback origin",
    );
  }

  if (
    !Number.isInteger(durationMs) ||
    durationMs < MIN_RECORDING_DURATION_MS ||
    durationMs > MAX_RECORDING_DURATION_MS
  ) {
    throw new RecordingPolicyError(
      "invalid_duration",
      "Recording duration must be between 5 and 60 seconds",
    );
  }

  return { approvedOrigin: target.origin, durationMs, targetUrl };
}
```

- [ ] **Step 4: Add the new test to the standard test glob and verify GREEN**

No script change is required because `npm test` already runs `tests/*.test.mjs`. Run:

```bash
node --test tests/recording-policy.test.mjs
npm run check
git diff --check
```

Expected: policy tests PASS; the existing 94 tests also PASS.

- [ ] **Step 5: Commit the request-policy boundary**

```bash
git add plugins/codex-browser-recorder/skills/record-browser/scripts/recording-policy.mjs tests/recording-policy.test.mjs
git commit -m "feat: define browser recording request policy"
```

---

### Task 2: Enforce The Approved Origin Throughout Recording

**Files:**
- Modify: `plugins/codex-browser-recorder/skills/record-browser/scripts/screencast-recorder.mjs:57-225`
- Modify: `plugins/codex-browser-recorder/skills/record-browser/scripts/run-browser-recording.mjs:11-14,261-605`
- Modify: `tests/screencast-recorder.test.mjs:132-299,643-984`
- Modify: `tests/browser-poc-result.test.mjs:337-510`

**Interfaces:**
- `startFramePump()` additionally consumes `mainFrameId` and `onTopFrameNavigation(url)`.
- `startFramePump()` additionally produces `completion: Promise<{ error: Error | null }>`.
- Replace exact-URL startup checking with `inspectTopLevelFrame({ approvedOrigin, cdp }): Promise<{ frameId: string }>`.
- `startBrowserPocForTab()` and `createBrowserRecording()` consume `approvedOrigin` rather than `expectedTopLevelUrl`.
- Stable failure `origin_changed_during_recording` terminates and discards output.

- [ ] **Step 1: Write failing frame-navigation tests**

Add to `tests/screencast-recorder.test.mjs`. First add a queue-backed helper
beside `createLiveCdp`; it must append each published event with an increasing
integer `sequence`, honor `afterSequence`, expose `publish(event)` and
`flush()`, and return empty timed batches while no event is pending. Use that
helper in these tests:

```js
test("reports top-frame navigation through the frame pump", async () => {
  const navigations = [];
  const cdp = createQueuedCdp();
  const pump = startFramePump({
    cdp,
    initialCursor: 0,
    mainFrameId: "main-frame",
    maxDecodedBytes: 1024,
    onFrame: async () => true,
    onTopFrameNavigation(url) {
      navigations.push(url);
    },
    readTimeoutMs: 0,
  });

  cdp.publish({
    method: "Page.frameNavigated",
    params: { frame: { id: "child-frame", parentId: "main-frame", url: "https://other.example/" } },
  });
  cdp.publish({
    method: "Page.frameNavigated",
    params: { frame: { id: "main-frame", url: "https://example.com/next" } },
  });
  await cdp.flush();
  await pump.stop();

  assert.deepEqual(navigations, ["https://example.com/next"]);
});

test("exposes a frame-pump policy failure through completion", async () => {
  const cdp = createQueuedCdp();
  const policyError = Object.assign(new Error("Origin changed"), {
    code: "origin_changed_during_recording",
  });
  const pump = startFramePump({
    cdp,
    initialCursor: 0,
    mainFrameId: "main-frame",
    maxDecodedBytes: 1024,
    onFrame: async () => true,
    onTopFrameNavigation() {
      throw policyError;
    },
    readTimeoutMs: 0,
  });

  cdp.publish({
    method: "Page.frameNavigated",
    params: { frame: { id: "main-frame", url: "https://other.example/" } },
  });

  assert.deepEqual(await pump.completion, { error: policyError });
  await assert.rejects(pump.stop(), (error) => error === policyError);
});
```

- [ ] **Step 2: Write failing same-origin and cross-origin session tests**

Add to the `startBrowserPoc` section of `tests/screencast-recorder.test.mjs`.
Create one `createNavigationSessionHarness()` beside the existing session
fakes; it must return `{ cdp, flush, publishFrame, publishNavigation, sink,
sinkStopOptions }`, serve the supplied `Page.getFrameTree` result, and capture
the argument passed to `sink.stop(options)`. This keeps navigation and frame
events in the same cursor stream:

```js
test("keeps recording after same-origin top-frame navigation", async () => {
  const harness = createNavigationSessionHarness({
    approvedOrigin: "https://example.com",
    frameTree: { frameTree: { frame: { id: "main", url: "https://example.com/start" } } },
  });
  const session = await harness.start();
  harness.publishFrame();
  await session.ready;
  harness.publishNavigation({ id: "main", url: "https://example.com/next" });
  harness.publishFrame();
  await harness.flush();

  const result = await session.stop();
  assert.equal(result.framesReceived, 2);
});

test("discards output after cross-origin top-frame navigation", async () => {
  const harness = createNavigationSessionHarness({
    approvedOrigin: "https://example.com",
    frameTree: { frameTree: { frame: { id: "main", url: "https://example.com/start" } } },
  });
  const session = await harness.start();
  harness.publishFrame();
  await session.ready;
  harness.publishNavigation({ id: "main", url: "https://other.example/" });

  const outcome = await session.completion;
  assert.equal(outcome.error.code, "origin_changed_during_recording");
  await assert.rejects(
    session.stop(),
    (error) => error.code === "origin_changed_during_recording",
  );
  assert.equal(harness.sinkStopOptions.discard, true);
});
```

The helper's `start()` calls `startBrowserPoc()` with its queue-backed CDP,
memory sink, and `approvedOrigin`. `publishNavigation(frame)` enqueues a
`Page.frameNavigated` event. Update every pre-existing direct
`startFramePump()` call with `mainFrameId: "main-frame"` and a no-op
`onTopFrameNavigation() {}` so the stricter configuration contract is explicit.
Update every pre-existing direct `startBrowserPoc()` call with
`approvedOrigin: "https://example.com"`; its CDP stub must return
`{ frameTree: { frame: { id: "main-frame", url: "https://example.com/start" }
} } }` for `Page.getFrameTree`.

- [ ] **Step 3: Run the focused tests and verify RED**

```bash
node --test tests/screencast-recorder.test.mjs tests/browser-poc-result.test.mjs
```

Expected: FAIL because the frame pump ignores `Page.frameNavigated`, has no `completion`, and startup still consumes `expectedTopLevelUrl`.

- [ ] **Step 4: Extend the frame pump with the typed navigation callback**

In `screencast-recorder.mjs`, replace `SCREENCAST_EVENT_METHODS` and the navigation portion of `handleEvent` with:

```js
const SCREENCAST_EVENT_METHODS = [
  "Page.frameNavigated",
  "Page.screencastFrame",
  "Page.screencastVisibilityChanged",
];

async function handleEvent(event) {
  if (event?.method === "Page.frameNavigated") {
    const frame = event.params?.frame;
    if (
      frame?.id === mainFrameId &&
      !Object.hasOwn(frame, "parentId") &&
      typeof frame.url === "string"
    ) {
      await onTopFrameNavigation(frame.url);
    }
    return;
  }
  if (event?.method === "Page.screencastVisibilityChanged") {
    const visible = event.params?.visible;
    if (typeof visible === "boolean" && visible !== stats.visibilityState) {
      stats.visibilityState = visible;
      stats.visibilityChanges += 1;
    }
    return;
  }
  if (event?.method !== "Page.screencastFrame") return;

  stats.framesReceived += 1;
  const sessionId = event.params?.sessionId;
  if (Number.isInteger(sessionId) && sessionId >= 0) {
    await cdp.send("Page.screencastFrameAck", { sessionId });
    stats.framesAcknowledged += 1;
  }
  let frame;
  try {
    frame = parseScreencastFrame(event, maxDecodedBytes);
  } catch (error) {
    if (error instanceof RecorderError) {
      stats.invalidFrames += 1;
      return;
    }
    throw error;
  }
  const accepted = await onFrame(frame);
  if (accepted === false) stats.framesDropped += 1;
  stats.lastFrameTimestamp = frame.timestamp;
  if (!readySettled) {
    readySettled = true;
    resolveReady(true);
  }
}
```

Add `mainFrameId` and `onTopFrameNavigation` to configuration validation, default neither value, and require a non-empty frame ID plus a function. Return completion with the existing caught loop error:

```js
const completion = loop.then(() => ({ error: loopError }));

return {
  completion,
  ready,
  stats,
  async stop() {
    stopped = true;
    await loop;
    if (loopError !== null) throw loopError;
    return stats;
  },
};
```

- [ ] **Step 5: Replace one-time exact-URL policy with origin inspection and continuous enforcement**

In `run-browser-recording.mjs`, import `originOf`, add `origin_changed_during_recording` to `CAPTURE_FAILURE_CODES`, and replace `assertTopLevelUrl` with:

```js
export async function inspectTopLevelFrame({ approvedOrigin, cdp }) {
  if (typeof cdp?.send !== "function" || originOf(approvedOrigin) !== approvedOrigin) {
    throw new PocError(
      "invalid_configuration",
      "Top-level origin verification configuration is invalid",
    );
  }
  let frameTree;
  try {
    frameTree = await cdp.send("Page.getFrameTree");
  } catch {
    throw new PocError(
      "origin_verification_failed",
      "The recording page origin could not be verified",
    );
  }
  const frame = frameTree?.frameTree?.frame;
  if (
    typeof frame?.id !== "string" ||
    frame.id.length === 0 ||
    originOf(frame.url) !== approvedOrigin
  ) {
    throw new PocError(
      originOf(frame?.url) === null ? "origin_verification_failed" : "origin_not_allowed",
      "The recording page is outside the approved origin",
    );
  }
  return { frameId: frame.id };
}
```

Import all fixed media/resource constants from `recording-policy.mjs` and use
them as the lower-level defaults and screencast settings. Keep overrides only
as private test/release seams; `createRecording()` never forwards similarly
named user options.

Change `startBrowserPoc` to call `Page.enable`, capture the baseline, call
`inspectTopLevelFrame`, then start screencast. Update the test doubles so every
`Page.getFrameTree` response includes both `frame.id` and `frame.url`. Pass
`mainFrameId` and this callback to the frame pump:

```js
onTopFrameNavigation(url) {
  if (originOf(url) !== approvedOrigin) {
    throw new PocError(
      "origin_changed_during_recording",
      "The recording page left the approved origin",
    );
  }
},
```

Observe `pump.completion`; if it resolves with an error before explicit stop, call the existing `terminate(error)`. Pass `approvedOrigin` through `startBrowserPocForTab()` and `createBrowserRecording()` without exposing it through status or result fields.

Arm the lower-level 65-second hard-limit timer only after `pump.ready` resolves.
The separate 5-second first-frame timeout bounds startup. Add a fake-clock or
short real-time regression proving time spent awaiting the first frame does not
consume recording time, while 65 seconds after readiness still terminates with
`recording_duration_limit`. This prevents a valid 60-second request from racing
the hard limit because of startup latency.

Set `startedAt` on the first accepted frame using the same monotonic `now()`
sample assigned to `lastFrameAt`; compute successful `elapsedMs` from that
sample. A pre-readiness failure may report null/zero elapsed time but must never
enter media validation. Update the existing monotonic-clock test to prove
startup wait is excluded from recorded duration.

- [ ] **Step 6: Run focused and full tests and verify GREEN**

```bash
node --test tests/screencast-recorder.test.mjs tests/browser-poc-result.test.mjs tests/browser-recording-adapter.test.mjs
npm run check
npm run test:coverage
git diff --check
```

Expected: all tests PASS; same-origin navigation records; cross-origin navigation returns the stable code and discards output; startup order is `Page.enable`, event baseline, `Page.getFrameTree`, `Page.startScreencast`.

- [ ] **Step 7: Commit continuous origin enforcement**

```bash
git add plugins/codex-browser-recorder/skills/record-browser/scripts/recording-policy.mjs plugins/codex-browser-recorder/skills/record-browser/scripts/screencast-recorder.mjs plugins/codex-browser-recorder/skills/record-browser/scripts/run-browser-recording.mjs tests/screencast-recorder.test.mjs tests/browser-poc-result.test.mjs tests/browser-recording-adapter.test.mjs
git commit -m "fix: enforce recording origin continuously"
```

---

### Task 3: Extract Transactional Schema-V3 Recording Artifacts

**Files:**
- Create: `plugins/codex-browser-recorder/skills/record-browser/scripts/recording-artifacts.mjs`
- Create: `tests/recording-artifacts.test.mjs`
- Modify: `plugins/codex-browser-recorder/skills/record-browser/scripts/run-browser-recording.mjs:1-179,608-740`
- Modify: `tests/browser-poc-result.test.mjs` by removing only the artifact cases moved to the new focused test file

**Interfaces:**
- Produces `prepareRecordingArtifacts({ temporaryRoot })` and
  `cleanupRecordingArtifacts(paths, internalTestOptions?)`.
- Produces `finalizeRecordingArtifacts(options): Promise<result>`; the Browser
  adapter keeps private `paths` separate and returns `{ paths, result }`.
- Produces `describeRecordingFailure(code)` and
  `sanitizeRecordingFailure(error)` so policy, preflight, runtime, validation,
  persistence, and cleanup failures share one public message contract.
- Schema version 3 includes fixed `summary`, `remediation`, and `recorderContractVersion: 1`.
- Result persistence failure removes the finalized video and throws `artifact_persistence_failed`.

- [ ] **Step 1: Write the failing schema-v3 and transaction tests**

Move the existing `captureResult`, `sessionWithResult`, and `finalizePrepared`
helpers plus every private-path, cleanup, validation, and sanitized-result case
into `tests/recording-artifacts.test.mjs`. Rename `finalizePrepared` to
`finalizeOptions` so it returns the argument object rather than invoking the
function. Keep top-frame, tab-session, and historical-gate cases temporarily in
`tests/browser-poc-result.test.mjs`; Task 5 migrates those before deleting that
mixed test file. Change the successful assertion and add the persistence
rollback case:

```js
assert.deepEqual(result, {
  capture: expectedCapture,
  failureCode: null,
  media: expectedValidation,
  outputFile: "recording.webm",
  recorderContractVersion: 1,
  remediation: "No action is required",
  schemaVersion: 3,
  status: "passed",
  summary: "Recording completed successfully",
});

test("removes finalized media when result persistence fails", async () => {
  const paths = await prepareRecordingArtifacts({ temporaryRoot });
  const session = sessionWithResult();
  await writeFile(paths.outputPath, "published-video");

  await assert.rejects(
    finalizeRecordingArtifacts({
      ...finalizeOptions(paths, session),
      _dependencies: {
        rm,
        validateVideo: async () => expectedValidation,
        writeFile: async () => {
          throw new Error("private filesystem diagnostic");
        },
      },
    }),
    (error) =>
      error.code === "artifact_persistence_failed" &&
      !JSON.stringify(error).includes("private filesystem diagnostic"),
  );
  assert.equal(existsSync(paths.outputPath), false);
  assert.equal(existsSync(paths.resultPath), false);
});

test("bounds a cleanup-only failure without exposing its path", async () => {
  const secretPath = `${temporaryRoot}/private-recording`;
  await assert.rejects(
    cleanupRecordingArtifacts(
      { directory: secretPath },
      { _dependencies: { rm: async () => { throw new Error(secretPath); } } },
    ),
    (error) =>
      error.code === "cleanup_failed" &&
      !JSON.stringify(error).includes(secretPath),
  );
});
```

Also table-test every known failure code and assert that `summary` and
`remediation` are non-empty fixed strings, that no known code reaches the
generic fallback, and that serialization contains no injected error message.

- [ ] **Step 2: Run artifact tests and verify RED**

```bash
node --test tests/recording-artifacts.test.mjs
```

Expected: FAIL because `recording-artifacts.mjs` does not exist and current results use schema version 2.

- [ ] **Step 3: Implement allowlisted messages and schema-v3 persistence**

Create `recording-artifacts.mjs` by moving private path preparation, cleanup, capture sanitization, known failure sets, session finalization, video validation, and result writing out of `run-browser-recording.mjs`.

Define fixed message groups in code. Each listed code must resolve directly;
only an unknown code is normalized to `recording_failed`:

```js
const MESSAGE_GROUPS = [
  {
    codes: ["invalid_target", "target_credentials_present", "target_scheme_not_allowed", "invalid_duration"],
    summary: "The recording request is not allowed",
    remediation: "Use an HTTPS or approved loopback URL without credentials and a duration from 5 to 60 seconds",
  },
  {
    codes: ["browser_plugin_unavailable", "cdp_unavailable", "plugin_module_unavailable"],
    summary: "The required Browser recording capability is unavailable",
    remediation: "Install or enable the Browser plugin and approve full CDP access, then retry",
  },
  {
    codes: ["unsupported_platform", "ffmpeg_missing", "ffmpeg_vp8_unavailable", "ffmpeg_webm_unavailable", "ffprobe_missing", "ffprobe_unusable", "output_directory_not_writable"],
    summary: "The local recording environment is not ready",
    remediation: "Resolve the reported preflight blocker, then run the recording again",
  },
  {
    codes: ["cancelled", "recording_cancelled"],
    summary: "Recording was cancelled",
    remediation: "Start again when you are ready and approve the requested scope",
  },
  {
    codes: ["origin_not_allowed", "origin_verification_failed", "origin_changed_during_recording"],
    summary: "The page is outside the approved recording origin",
    remediation: "Start a new recording and keep top-level navigation within the approved site",
  },
  {
    codes: ["event_stream_invalid", "frame_stream_stalled", "frame_stream_unavailable", "frame_too_large", "invalid_frame"],
    summary: "The Browser frame stream could not be recorded safely",
    remediation: "Keep the tab visible, confirm full CDP approval, and retry the recording",
  },
  {
    codes: ["output_monitor_failed", "recording_duration_limit", "recording_output_limit"],
    summary: "A recording safety limit stopped the session",
    remediation: "Use a shorter or less visually intensive flow and try again",
  },
  {
    codes: ["encoder_failed", "encoder_finalize_failed", "encoder_shutdown_timeout"],
    summary: "The local video encoder could not complete the recording",
    remediation: "Run preflight and verify local FFmpeg VP8 WebM support before retrying",
  },
  {
    codes: ["audio_stream_present", "codec_invalid", "container_invalid", "dimensions_out_of_bounds", "duration_invalid", "duration_mismatch", "ffprobe_failed", "output_missing", "output_too_small", "video_stream_count_invalid", "video_stream_missing"],
    summary: "The recorded media did not satisfy the WebM contract",
    remediation: "Run preflight, keep the page visible, and record the flow again",
  },
  {
    codes: ["artifact_persistence_failed", "cleanup_failed"],
    summary: "The private local recording artifacts could not be finalized",
    remediation: "Check temporary storage permissions and free space, then retry",
  },
  {
    codes: ["capture_failed", "integration_failed", "invalid_configuration", "recording_already_active", "recording_not_started", "recording_failed"],
    summary: "Recording could not be completed",
    remediation: "Run preflight and retry one recording at a time",
  },
];

const USER_MESSAGES = new Map(
  MESSAGE_GROUPS.flatMap(({ codes, remediation, summary }) =>
    codes.map((code) => [code, Object.freeze({ remediation, summary })]),
  ),
);

export function describeRecordingFailure(code) {
  return USER_MESSAGES.get(code) ?? USER_MESSAGES.get("recording_failed");
}

export function sanitizeRecordingFailure(error) {
  const code = USER_MESSAGES.has(error?.code) ? error.code : "recording_failed";
  const { remediation, summary } = describeRecordingFailure(code);
  return Object.assign(new Error(summary), { code, remediation, summary });
}
```

Build the result exactly as:

```js
const { summary, remediation } =
  failureCode === null
    ? { summary: "Recording completed successfully", remediation: "No action is required" }
    : describeRecordingFailure(failureCode);
const result = {
  capture: sanitizeCaptureResult(capture),
  failureCode,
  media: validation,
  outputFile: basename(outputPath),
  recorderContractVersion: 1,
  remediation,
  schemaVersion: 3,
  status: failureCode === null ? "passed" : "failed",
  summary,
};
```

Inject `{ rm, validateVideo, writeFile }` only through an undocumented
`_dependencies` test seam. A cleanup-only filesystem rejection becomes a new
bounded `cleanup_failed` error. On result write failure, best-effort remove
`outputPath` and `resultPath`, ignore rollback diagnostics so the persistence
failure remains primary, then throw a new bounded error with code
`artifact_persistence_failed` and no cause or diagnostic property.

- [ ] **Step 4: Rewire the lower-level adapter to the artifact module**

Import `prepareRecordingArtifacts`, `cleanupRecordingArtifacts`, and `finalizeRecordingArtifacts` into `run-browser-recording.mjs`. Rename adapter dependency keys and calls accordingly. Delete the moved artifact implementations and constants from the orchestration file. Keep the returned `{ paths, result }` shape.

- [ ] **Step 5: Run artifact, adapter, media, and full tests**

```bash
node --test tests/recording-artifacts.test.mjs tests/browser-recording-adapter.test.mjs tests/validate-video.test.mjs
npm run check
npm run test:coverage
git diff --check
```

Expected: all tests PASS; every new result is schema 3; a failed result write removes finalized media; no bounded error serialization contains injected diagnostics.

- [ ] **Step 6: Commit transactional artifacts**

```bash
git add plugins/codex-browser-recorder/skills/record-browser/scripts/recording-artifacts.mjs plugins/codex-browser-recorder/skills/record-browser/scripts/run-browser-recording.mjs tests/recording-artifacts.test.mjs tests/browser-recording-adapter.test.mjs tests/browser-poc-result.test.mjs
git commit -m "refactor: make recording artifacts transactional"
```

---

### Task 4: Add The Public Recording Coordinator And State Machine

**Files:**
- Create: `plugins/codex-browser-recorder/skills/record-browser/scripts/create-recording.mjs`
- Create: `tests/create-recording.test.mjs`
- Modify: `plugins/codex-browser-recorder/skills/record-browser/scripts/run-browser-recording.mjs:608-740`

**Interfaces:**
- Produces synchronous `createRecording(options): { ready, status, stop }`.
- Consumes `targetUrl`, optional `durationMs`, `tab`, `temporaryRoot`, `ffmpegPath`, `ffprobePath`, and optional `signal`.
- Reserves the Browser-runtime singleton synchronously before asynchronous startup.
- Status state is `preparing`, `awaiting_frame`, `recording`, `stopping`, `completed`, `failed`, or `cancelled`.
- Requested duration starts after first-frame readiness and calls the memoized stop path cleanly; lower-level `maxDurationMs` remains fixed at 65,000 ms as a hard failure boundary.
- The internal lower-level handle additionally exposes `completion`, which
  settles only after media validation and artifact finalization. The public
  handle does not expose it.

- [ ] **Step 1: Write the failing public coordinator tests**

Create `tests/create-recording.test.mjs` with a deferred lower-level harness and these behaviors:

```js
test("returns a preparing handle and validates before allocating Browser resources", async () => {
  const harness = createHarness();
  const handle = createRecording({
    _dependencies: harness.dependencies,
    durationMs: 15_000,
    maxDecodedBytes: 1,
    maxOutputBytes: 1,
    maxWidth: 9_999,
    targetUrl: "https://example.com/demo",
    tab: {},
  });

  assert.deepEqual(Object.keys(handle).sort(), ["ready", "status", "stop"]);
  assert.equal(handle.status().state, "preparing");
  await handle.ready;
  assert.deepEqual(harness.recordingOptions, {
    approvedOrigin: "https://example.com",
    maxDurationMs: 65_000,
  });
});

test("rejects invalid targets before lower-level allocation", async () => {
  const harness = createHarness();
  const handle = createRecording({
    _dependencies: harness.dependencies,
    targetUrl: "file:///private/secret",
    tab: {},
  });
  await assert.rejects(handle.ready, (error) => error.code === "target_scheme_not_allowed");
  assert.equal(harness.calls.createBrowserRecording, 0);
  assert.equal(handle.status().state, "failed");
});

test("stops cleanly at the requested duration and memoizes finalization", async () => {
  const clock = createFakeClock();
  const harness = createHarness();
  const handle = createRecording({
    _dependencies: { ...harness.dependencies, clock },
    durationMs: 5_000,
    targetUrl: "https://example.com/",
    tab: {},
  });
  await handle.ready;
  assert.equal(handle.status().state, "recording");
  clock.advance(5_000);
  const first = handle.stop();
  const second = handle.stop();
  assert.equal(first, second);
  await first;
  assert.equal(harness.calls.stop, 1);
  assert.equal(handle.status().state, "completed");
});

test("reserves and releases the singleton across every terminal path", async () => {
  const first = createRecording(validOptions());
  const concurrent = createRecording(validOptions());
  await assert.rejects(
    concurrent.ready,
    (error) => error.code === "recording_already_active",
  );
  await first.ready;
  await first.stop();
  const next = createRecording(validOptions());
  await next.ready;
  await next.stop();
});
```

Add table-driven cases for readiness failure, lower-level terminal failure,
lower-level completion racing readiness, abort, rejected finalization, and
cancellation state. Every case must assert singleton release, exact public
status keys, and that no terminal state transitions back to `recording`.

Define `createHarness()` in the same file with deferred `ready` and
`completion` promises, one memoized fake `stop()`, captured lower-level options,
and call counters. Define `createFakeClock()` with deterministic
`setTimeout`/`clearTimeout` and `advance(ms)`. Define `validOptions()` with a
fresh fake lower-level dependency per call so no test shares terminal state.
The fake lower-level handle must have exactly `{ completion, ready, status,
stop }`.
Add `test.afterEach(() => { delete globalThis[Symbol.for("codex-browser-recorder.active")]; });`
so an assertion failure cannot contaminate later singleton cases.

- [ ] **Step 2: Run coordinator tests and verify RED**

```bash
node --test tests/create-recording.test.mjs
```

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `create-recording.mjs`.

- [ ] **Step 3: Implement the synchronous public coordinator**

First update `createBrowserRecording()` so its private lower-level handle
includes a `completion` promise. Explicit `stop()`, automatic session
termination, readiness cleanup, and artifact finalization must all settle that
stable deferred promise exactly once. Add adapter tests proving
`await completion` equals `await stop()` for explicit stop and that automatic
terminal failure settles only after finalization.

Then create `create-recording.mjs` with these fixed dependencies and shape:

```js
import { createBrowserRecording } from "./run-browser-recording.mjs";
import {
  describeRecordingFailure,
  sanitizeRecordingFailure,
} from "./recording-artifacts.mjs";
import {
  RECORDING_HARD_LIMIT_MS,
  validateRecordingRequest,
} from "./recording-policy.mjs";

export { describeRecordingFailure };

const ACTIVE_RECORDING_KEY = Symbol.for("codex-browser-recorder.active");

export function createRecording(options) {
  const dependencies = options?._dependencies ?? {
    clock: { clearTimeout, setTimeout },
    createBrowserRecording,
  };
  let state = "preparing";
  let inner;
  let durationTimer;
  let stopPromise;
  let terminal = false;
  const reservation = {};

  if (globalThis[ACTIVE_RECORDING_KEY] != null) {
    const error = sanitizeRecordingFailure({ code: "recording_already_active" });
    const failure = Promise.reject(error);
    void failure.catch(() => {});
    return {
      ready: failure,
      status: () => ({ capture: null, state: "failed" }),
      stop: () => failure,
    };
  }
  globalThis[ACTIVE_RECORDING_KEY] = reservation;

  let handle;
  let ready;

  function release() {
    if (
      globalThis[ACTIVE_RECORDING_KEY] === reservation ||
      globalThis[ACTIVE_RECORDING_KEY] === handle
    ) {
      delete globalThis[ACTIVE_RECORDING_KEY];
    }
  }

  function setTerminalState(output) {
    dependencies.clock.clearTimeout(durationTimer);
    terminal = true;
    state = output?.result?.status === "passed" ? "completed" : "failed";
    release();
  }

  function status() {
    return { capture: inner?.status().capture ?? null, state };
  }

  function stop() {
    stopPromise ??= ready
      .then(async () => {
        dependencies.clock.clearTimeout(durationTimer);
        if (!new Set(["failed", "cancelled", "completed"]).has(state)) {
          state = "stopping";
        }
        try {
          const output = await inner.stop();
          setTerminalState(output);
          return output;
        } catch (error) {
          const publicError = sanitizeRecordingFailure(error);
          terminal = true;
          state = ["cancelled", "recording_cancelled"].includes(publicError.code)
            ? "cancelled"
            : "failed";
          throw publicError;
        }
      })
      .finally(release);
    return stopPromise;
  }

  ready = Promise.resolve().then(async () => {
    const request = validateRecordingRequest(options);
    inner = await dependencies.createBrowserRecording({
      approvedOrigin: request.approvedOrigin,
      ffmpegPath: options.ffmpegPath,
      ffprobePath: options.ffprobePath,
      maxDurationMs: RECORDING_HARD_LIMIT_MS,
      signal: options.signal,
      tab: options.tab,
      temporaryRoot: options.temporaryRoot,
    });
    state = "awaiting_frame";
    void inner.completion.then(
      setTerminalState,
      (error) => {
        dependencies.clock.clearTimeout(durationTimer);
        terminal = true;
        state = ["cancelled", "recording_cancelled"].includes(error?.code)
          ? "cancelled"
          : "failed";
        release();
      },
    );
    await inner.ready;
    if (terminal) return true;
    state = "recording";
    durationTimer = dependencies.clock.setTimeout(() => {
      void stop().catch(() => {});
    }, request.durationMs);
    return true;
  }).catch(async (error) => {
    dependencies.clock.clearTimeout(durationTimer);
    if (inner != null) {
      try {
        await inner.stop();
      } catch {
        // Preserve the bounded readiness failure after cleanup completes.
      }
    }
    const publicError = sanitizeRecordingFailure(error);
    terminal = true;
    state = ["cancelled", "recording_cancelled"].includes(publicError.code)
      ? "cancelled"
      : "failed";
    release();
    throw publicError;
  });

  handle = { ready, status, stop };
  globalThis[ACTIVE_RECORDING_KEY] = handle;
  return handle;
}
```

During GREEN, keep `stop()` after a rejected `ready` memoized and rejected with
the same bounded primary failure. Do not add another public method, expose the
internal `completion`, or release the singleton before readiness cleanup has
finished.

- [ ] **Step 4: Run coordinator and lower-level adapter tests and verify GREEN**

```bash
node --test tests/create-recording.test.mjs tests/browser-recording-adapter.test.mjs
npm run check
git diff --check
```

Expected: public states and singleton lifecycle PASS; lower-level adapter remains reusable and sanitized.

- [ ] **Step 5: Commit the public coordinator**

```bash
git add plugins/codex-browser-recorder/skills/record-browser/scripts/create-recording.mjs tests/create-recording.test.mjs
git commit -m "feat: add public browser recording coordinator"
```

---

### Task 5: Ship Only Focused Production Modules

**Files:**
- Rename: `plugins/codex-browser-recorder/skills/record-browser/scripts/screencast-recorder.mjs` to `plugins/codex-browser-recorder/skills/record-browser/scripts/media-recorder.mjs`
- Rename: `plugins/codex-browser-recorder/skills/record-browser/scripts/run-browser-recording.mjs` to `plugins/codex-browser-recorder/skills/record-browser/scripts/browser-recording.mjs`
- Delete: `plugins/codex-browser-recorder/skills/record-browser/scripts/example-recording-gate.mjs`
- Create: `scripts/example-recording-release-gate.mjs`
- Rename: `tests/screencast-recorder.test.mjs` to `tests/media-recorder.test.mjs`
- Rename: `tests/browser-recording-adapter.test.mjs` to `tests/browser-recording.test.mjs`
- Rename: `tests/example-recording-gate.test.mjs` to `tests/example-recording-release-gate.test.mjs`
- Delete after migration: `tests/browser-poc-result.test.mjs`
- Modify: all imports in plugin scripts and tests
- Modify: `tests/plugin-structure.test.mjs:18-24`

**Interfaces:**
- `browser-recording.mjs` exports only `createBrowserRecording`,
  `inspectTopLevelFrame`, `startBrowserRecording`,
  `startBrowserRecordingForTab`, and focused test seams required by
  artifact/session tests.
- `media-recorder.mjs` exports `createFfmpegSink`, `estimateDecodedBytes`, `parseScreencastFrame`, and `startFramePump`.
- The shipped plugin contains no `EXAMPLE_PAGE_URL`, `createExampleRecording`, `runBrowserPocGate`, recording-window helper, or empty historical session.
- Repository `scripts/example-recording-release-gate.mjs` exports `runExampleRecordingReleaseGate(options)` and calls production `createRecording()`.

- [ ] **Step 1: Tighten the plugin-structure test before moving files**

Replace `requiredScripts` and add a shipped-source prohibition:

```js
const requiredScripts = [
  "browser-recording.mjs",
  "create-recording.mjs",
  "doctor.mjs",
  "media-recorder.mjs",
  "recording-artifacts.mjs",
  "recording-policy.mjs",
  "validate-video.mjs",
];

for (const forbidden of [
  "example-recording-gate.mjs",
  "run-browser-recording.mjs",
  "screencast-recorder.mjs",
]) {
  assert.equal(existsSync(join(skillRoot, "scripts", forbidden)), false);
}
```

Assert every shipped `.mjs` source does not contain `createExampleRecording`, `runBrowserPocGate`, or `EXAMPLE_PAGE_URL`.

- [ ] **Step 2: Run the structure test and verify RED**

```bash
node --test tests/plugin-structure.test.mjs
```

Expected: FAIL because old filenames and example-specific production code are still present.

- [ ] **Step 3: Perform the mechanical module moves**

```bash
git mv plugins/codex-browser-recorder/skills/record-browser/scripts/screencast-recorder.mjs plugins/codex-browser-recorder/skills/record-browser/scripts/media-recorder.mjs
git mv plugins/codex-browser-recorder/skills/record-browser/scripts/run-browser-recording.mjs plugins/codex-browser-recorder/skills/record-browser/scripts/browser-recording.mjs
git mv tests/screencast-recorder.test.mjs tests/media-recorder.test.mjs
git mv tests/browser-recording-adapter.test.mjs tests/browser-recording.test.mjs
git mv tests/example-recording-gate.test.mjs tests/example-recording-release-gate.test.mjs
```

Update imports exactly to `media-recorder.mjs`, `browser-recording.mjs`, `recording-artifacts.mjs`, and `create-recording.mjs`. Update `create-recording.mjs` to import `createBrowserRecording` from `browser-recording.mjs`.

- [ ] **Step 4: Remove historical helpers from the shipped Browser module**

Delete `createRecordingWindow`, `emptyCaptureSession`, and `runBrowserPocGate` from `browser-recording.mjs`. Rename `startBrowserPoc` to `startBrowserRecording`, `startBrowserPocForTab` to `startBrowserRecordingForTab`, and `PocError` to `BrowserRecordingError`. Update focused tests and internal calls to those names.

Move the remaining top-frame inspection and tab-session cases from
`tests/browser-poc-result.test.mjs` into `tests/browser-recording.test.mjs`.
Move only the still-relevant fixed-example behavior into
`tests/example-recording-release-gate.test.mjs`, then delete
`tests/browser-poc-result.test.mjs`. Do not preserve tests for
`createRecordingWindow`, `emptyCaptureSession`, or `runBrowserPocGate`.

- [ ] **Step 5: Move the fixed example policy to the repository release gate**

Create `scripts/example-recording-release-gate.mjs`:

```js
import { createRecording } from "../plugins/codex-browser-recorder/skills/record-browser/scripts/create-recording.mjs";

export const EXAMPLE_PAGE_URL = "https://example.com/";

export function runExampleRecordingReleaseGate({
  _dependencies = { createRecording },
  durationMs = 12_000,
  ffmpegPath,
  ffprobePath,
  signal,
  tab,
  temporaryRoot,
}) {
  return _dependencies.createRecording({
    durationMs,
    ffmpegPath,
    ffprobePath,
    signal,
    tab,
    targetUrl: EXAMPLE_PAGE_URL,
    temporaryRoot,
  });
}
```

Rewrite `tests/example-recording-release-gate.test.mjs` to inject
`{ createRecording(options) { captured = options; return sentinelHandle; } }`,
then assert the helper returns `sentinelHandle` and supplies the fixed URL plus
12,000 ms default duration. Keep singleton/state tests in
`tests/create-recording.test.mjs`.

- [ ] **Step 6: Run all focused tests and verify GREEN**

```bash
node --test tests/plugin-structure.test.mjs tests/media-recorder.test.mjs tests/browser-recording.test.mjs tests/recording-artifacts.test.mjs tests/create-recording.test.mjs tests/example-recording-release-gate.test.mjs
npm run check
npm run test:coverage
git diff --check
```

Expected: all tests PASS; shipped plugin has seven focused scripts and no example-specific or historical harness symbols.

- [ ] **Step 7: Commit the production module boundary**

```bash
git add plugins/codex-browser-recorder/skills/record-browser/scripts scripts tests
git commit -m "refactor: separate recorder runtime from release gate"
```

---

### Task 6: Replace The Integration-Gate Skill With The Public Workflow

**Files:**
- Modify: `plugins/codex-browser-recorder/skills/record-browser/SKILL.md`
- Modify: `plugins/codex-browser-recorder/skills/record-browser/agents/openai.yaml`
- Modify: `tests/skill-contract.test.mjs`
- Modify: `tests/plugin-structure.test.mjs`
- Modify: `tests/plugin-installation.integration.mjs`

**Interfaces:**
- Explicit invocation requires `targetUrl`, planned Browser actions, and optional `durationMs`.
- The skill performs one consolidated consent before any Browser action.
- The skill runs pure `validateRecordingRequest()` and resolves fixed failure
  messages before consent, then imports installed `doctor.mjs` and
  `create-recording.mjs` by skill-relative file URL.
- The skill never injects diagnostic clock, animation, text, or scroll actions.
- The Browser tab lifecycle remains one outer `try`/`finally` with `handle.stop()` before tab closure.

- [ ] **Step 1: Rewrite contract tests for public language and workflow**

Replace fixed-gate assertions in `tests/skill-contract.test.mjs` with:

```js
test("skill requires explicit user recording intent and one consolidated consent", () => {
  assert.match(agent, /allow_implicit_invocation: false/);
  assert.match(frontmatter, /explicitly invokes \$record-browser/);
  assert.match(skill, /target URL/i);
  assert.match(skill, /planned Browser actions/i);
  assert.match(skill, /recording duration/i);
  assert.match(skill, /one consolidated consent/i);
  assert.match(skill, /before any Browser action/i);
});

test("skill validates before Browser activity and delegates recording to production code", () => {
  assert.match(skill, /scripts\/recording-policy[.]mjs/);
  assert.match(skill, /scripts\/recording-artifacts[.]mjs/);
  assert.match(skill, /scripts\/create-recording[.]mjs/);
  assert.match(skill, /scripts\/doctor[.]mjs/);
  assert.match(skill, /validateRecordingRequest/);
  assert.match(skill, /createRecording/);
  assert.match(skill, /await handle[.]ready/);
  assert.match(skill, /handle[.]status[(][)]/);
  assert.match(skill, /handle[.]stop[(][)]/);
  assert.match(skill, /stop performing Browser actions/i);
  assert.doesNotMatch(skill, /example[.]com|integration gate|createExampleRecording/i);
  assert.doesNotMatch(skill, /clock|animation|DOM state change/i);
});

test("skill reports product results before bounded diagnostics", () => {
  assert.match(skill, /duration/i);
  assert.match(skill, /VP8 WebM/i);
  assert.match(skill, /no audio/i);
  assert.match(skill, /saved locally/i);
  assert.match(skill, /diagnostics/i);
  assert.match(skill, /summary/i);
  assert.match(skill, /remediation/i);
});
```

Retain and adapt the existing lifecycle parser so it requires `createRecording`, one outer-scoped handle, `finally`, idempotent stop, and tab closure in that order.

- [ ] **Step 2: Run contract and installation tests and verify RED**

```bash
node --test tests/skill-contract.test.mjs tests/plugin-structure.test.mjs tests/plugin-installation.integration.mjs
```

Expected: FAIL because current skill imports `createExampleRecording`, mentions the integration gate, and injects diagnostic page mutations.

- [ ] **Step 3: Rewrite `SKILL.md` as the public orchestration contract**

Use this exact section order and imperative content:

```markdown
---
name: record-browser
description: Use only when the user explicitly invokes $record-browser to record one fresh approved Codex Browser tab to a private local WebM file.
license: MIT
---

# Record Browser

## Collect The Request

Require a target URL and planned Browser actions. Use 15 seconds when the user does not provide a duration. Do not create or navigate a Browser tab yet.

## Validate The Request Locally

Resolve this installed skill directory from the catalog entry that loaded this file. Convert `scripts/recording-policy.mjs` and `scripts/recording-artifacts.mjs` with `pathToFileURL`; import `validateRecordingRequest` and `describeRecordingFailure`. Validate the target plus duration using local computation only. This module resolution and pure computation are not Browser activity. On rejection, report only its code plus the summary and remediation returned by `describeRecordingFailure(error.code)`. Stop before creating, navigating, or acquiring any Browser tab or CDP capability.

## Confirm Once Before Browser Activity

Present one consolidated consent containing the validated normalized approved origin, planned actions, duration, private temporary output, no audio, no browser chrome, no other tabs, and the sensitive-data exclusion. Continue only after explicit confirmation; denial returns `cancelled` and performs no Browser action. A `$record-browser` mention selects the workflow but does not approve an unknown target or scope. Refuse credentials, payment data, passkeys, recovery secrets, health data, or confidential communications as out of scope for the first release.

## Resolve Installed Modules

Using the already resolved installed skill directory, convert `scripts/doctor.mjs` and `scripts/create-recording.mjs` with `pathToFileURL`. Never guess a cache path or fall back to a source checkout. Import both modules inside the persistent Browser Node runtime.

## Run The Recording

Create one fresh blank Browser tab. Bind navigation and closure functions to only that tab. In one outer `try`/`finally`, navigate to the validated target, allow normal site and full-CDP approval, run `doctor()`, call `createRecording()`, await `handle.ready`, perform only the approved Browser actions, and read bounded status until the deterministic duration completes. A denied site or CDP approval returns `cancelled`; never retry or bypass it. Call `handle.stop()` to obtain the memoized result.

Do not inject clocks, animations, test text, or diagnostic interactions. Do not enable Developer mode, change policy, install packages, retry denied approval, broaden the origin, switch browsers, use an existing tab, or expose Browser/CDP objects.

## Clean Up

Always call `await handle?.stop()` before closing the fresh tab. Preserve the primary failure if cleanup also fails. Never leave a screencast, frame pump, FFmpeg process, partial output, singleton, or fresh tab active.

## Report The Result

On success, lead with `Recording completed`, duration, VP8 WebM, dimensions, no audio, and `Saved locally: <path>`. Offer bounded capture counters only as diagnostics. On failure, report the stable failure code plus its allowlisted summary and remediation. Never report full URLs, page text, raw frames, CDP payloads, FFmpeg stderr, credentials, or internal plugin paths.
```

Replace the old example-gate block with this complete lifecycle. The `request`
object comes only from `validateRecordingRequest({ durationMs, targetUrl })`
before consent; navigation is the first awaited Browser tab/CDP action inside
the outer `try`:

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

The full skill text must also state that it checks `handle.status()` before and
after each approved action, stops performing Browser actions immediately when
the state is no longer `recording`, and keeps bounded progress polling until the
requested-duration timer or another terminal condition settles the recording.
`handle.stop()` then returns the same memoized finalization result.

- [ ] **Step 4: Update UI metadata and installed-cache coverage**

Set `agents/openai.yaml` to:

```yaml
interface:
  display_name: "Record Browser"
  short_description: "Record one approved Browser test flow to local WebM"
  default_prompt: "Use $record-browser to record an approved Browser test flow."
policy:
  allow_implicit_invocation: false
```

Change installation tests to import `scripts/create-recording.mjs` from the isolated installed cache and assert its source checkout has been removed. Update required script assertions to the seven-file production list from Task 5.

- [ ] **Step 5: Run skill, structure, installation, and full tests**

```bash
node --test tests/skill-contract.test.mjs tests/plugin-structure.test.mjs tests/plugin-installation.integration.mjs
npm run check
npm run test:coverage
npm run test:plugin-install
git diff --check
```

Expected: all tests PASS; no shipped skill or UI metadata mentions an integration gate or `example.com`; isolated cache imports `createRecording()`.

- [ ] **Step 6: Commit the public skill workflow**

```bash
git add plugins/codex-browser-recorder/skills/record-browser/SKILL.md plugins/codex-browser-recorder/skills/record-browser/agents/openai.yaml tests/skill-contract.test.mjs tests/plugin-structure.test.mjs tests/plugin-installation.integration.mjs
git commit -m "feat: expose the public browser recording workflow"
```

---

### Task 7: Complete The Runtime Acceptance Gate

**Files:**
- Modify: `README.md`
- Modify: `PRIVACY.md`
- Modify: `plugins/codex-browser-recorder/.codex-plugin/plugin.json`
- Modify: `docs/superpowers/plans/2026-07-15-public-browser-recorder-runtime.md`
- Modify: focused tests only if final verification exposes an uncovered specified case

**Interfaces:**
- README describes the user workflow, target policy, origin lock, output retention, internal release gate, and the difference from Record & Replay.
- Privacy policy states local frame processing, temporary retention, deletion responsibility, and no automatic model-context or telemetry transfer.
- Manifest product copy describes recording rather than an integration gate. Canonical release version remains a later release-plan action; local cachebuster stays unchanged in this task.

- [ ] **Step 1: Add failing public-copy assertions**

Extend `tests/plugin-structure.test.mjs`:

```js
assert.equal(
  plugin.description,
  "Record one explicitly approved Codex Browser test flow to a private local WebM file.",
);
assert.equal(
  plugin.interface.shortDescription,
  "Record an approved Browser test flow to local WebM.",
);
assert.doesNotMatch(JSON.stringify(plugin.interface), /integration gate|example[.]com/i);
```

Add README assertions to `tests/skill-contract.test.mjs` by loading `README.md` and requiring `$record-browser`, `same-origin`, `cross-origin`, `Record & Replay`, `temporary`, and `no audio`, while rejecting public instructions that tell users to run an integration gate.

- [ ] **Step 2: Run copy tests and verify RED**

```bash
node --test tests/plugin-structure.test.mjs tests/skill-contract.test.mjs
```

Expected: FAIL because current manifest and README describe the fixed integration gate.

- [ ] **Step 3: Rewrite public documentation around the approved product contract**

Update README sections in this order: product summary, status, supported targets, requirements, pinned/local installation distinction, `$record-browser` usage, consolidated consent, same-origin navigation policy, output and deletion, architecture, development verification, internal release gate, update/uninstall, privacy/security, and Record & Replay distinction.

Remove Phase 0/Phase 1 tables from the primary user flow. Preserve links to historical evidence under a collapsed or clearly labeled development-history section. Do not claim general production readiness or support for authenticated/sensitive flows.

Update `PRIVACY.md` to state:

```markdown
- Frames are processed by the local Browser Node runtime and local FFmpeg and are not placed in model context by the skill.
- Output remains in a private operating-system temporary directory until the user deletes or moves it.
- The plugin does not automatically upload, share, retain remotely, or send telemetry.
- The user must delete temporary output when it is no longer needed.
```

Change manifest description and interface copy to the exact asserted strings. Keep the existing local cachebuster version until the separate release-readiness plan creates `v0.1.0`.

- [ ] **Step 4: Run the complete automated runtime gate**

```bash
npm run check
npm run test:coverage
npm run test:plugin-install
uv run --no-project --with pyyaml python /Users/po-chi/.codex/skills/.system/plugin-creator/scripts/validate_plugin.py plugins/codex-browser-recorder
uv run --no-project --with pyyaml python /Users/po-chi/.codex/skills/.system/skill-creator/scripts/quick_validate.py plugins/codex-browser-recorder/skills/record-browser
git diff --check
git status --short
```

Expected: every test and validator PASS; coverage remains at least 90% lines and 80% branches; the only untracked pre-existing file is `MEMORY.md`; no WebM, partial file, result JSON, or recording temporary directory exists in the repository.

- [ ] **Step 5: Record sanitized execution evidence in this plan**

Append an `Automated Execution Status — 2026-07-15` table containing exact test counts, coverage percentages, validator results, isolated installation result, origin-policy cases, navigation-policy cases, schema-v3 transaction cases, public coordinator cases, and repository artifact count. Do not include absolute cache paths, subprocess output, frame data, full URLs, or page content.

- [ ] **Step 6: Commit the runtime acceptance result**

```bash
git add README.md PRIVACY.md plugins/codex-browser-recorder/.codex-plugin/plugin.json docs/superpowers/plans/2026-07-15-public-browser-recorder-runtime.md tests/plugin-structure.test.mjs tests/skill-contract.test.mjs
git commit -m "docs: complete public recorder runtime gate"
```

#### Automated Execution Status — 2026-07-15

| Gate | Result | Numeric evidence |
| --- | --- | --- |
| Complete Node test suite and syntax check | PASS | 126 passed, 0 failed, 0 skipped, 0 cancelled |
| Coverage thresholds | PASS | Lines 94.57%, branches 88.16%, functions 94.83% |
| Focused structure, skill, public-copy, and retention contract | PASS | 14 passed, 0 failed |
| Plugin validator | PASS | 1 validator passed, 0 errors |
| Skill validator | PASS | 1 validator passed, 0 errors |
| Isolated plugin installation and cache-only import | PASS | 1 passed, 0 failed |
| Origin-policy cases | PASS | 5 passed, 0 failed |
| Navigation-policy cases | PASS | 13 passed, 0 failed |
| Schema-v3 artifact transaction cases | PASS | 17 passed, 0 failed |
| Public coordinator and state-machine cases | PASS | 12 passed, 0 failed |
| Repository whitespace | PASS | 0 errors |
| Repository recording artifacts | PASS | 0 total: 0 WebM files, 0 partial files, 0 result JSON files, 0 recording temporary directories |

## Follow-Up Plan Boundary

After this plan passes, write a separate public release-readiness implementation plan for brand assets, privacy/terms/support URLs, contributor and community files, exactly five positive plus three negative submission eval fixtures, pinned Codex CLI CI installation, CodeQL, Dependabot, OpenSSF Scorecard, protected GitHub settings, a twice-sequential installed-desktop release gate, canonical `0.1.0`, tag `v0.1.0`, release evidence, and plugin submission. External GitHub mutations require explicit user authorization at execution time.
