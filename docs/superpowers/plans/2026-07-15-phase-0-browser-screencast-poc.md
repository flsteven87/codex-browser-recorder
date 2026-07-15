# Phase 0 Browser Screencast PoC Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prove whether the Codex in-app Browser permits CDP screencast capture and continues delivering usable frames while hidden for two minutes.

**Architecture:** A disposable Node.js harness runs inside the same persistent JavaScript runtime as the Browser binding. It polls buffered CDP events, acknowledges every valid frame immediately, samples the latest JPEG at a fixed 10 fps, and streams those samples into a local FFmpeg process. Browser navigation and visibility changes remain controlled by the installed Browser runtime; the harness writes only a temporary WebM file and a sanitized JSON result.

**Tech Stack:** Node.js 24 built-ins, `node:test`, Codex Browser raw CDP capability, FFmpeg/FFprobe, VP8 WebM.

## Global Constraints

- Limit scope to Phase 0 feasibility; do not scaffold the complete plugin.
- Use the existing in-app Browser session and a fresh non-sensitive test tab.
- Require the Browser runtime's normal site and full-CDP approvals.
- Do not start a development server or install dependencies.
- Capture page content only; no Codex UI, browser chrome, audio, cookies, storage, headers, or credentials.
- Use 1280×720 maximum dimensions, JPEG quality 70, 10 output fps, a 5 MiB maximum decoded frame, and a two-minute hidden interval.
- Write videos and diagnostic JSON under a unique temporary directory outside the repository.
- Stop screencasting and terminate FFmpeg on every success or failure path.

---

### Task 1: Define and test the frame event boundary

**Files:**
- Create: `package.json`
- Create: `tests/screencast-recorder.test.mjs`
- Create: `poc/screencast-recorder.mjs`

**Interfaces:**
- Consumes: Browser CDP events shaped as `{ method, params, sequence }`.
- Produces: `parseScreencastFrame(event, maxDecodedBytes)` returning `{ jpeg, sessionId, timestamp }`, and `estimateDecodedBytes(base64)` returning an integer byte count.

- [x] **Step 1: Add the Node test command and failing frame-parser tests**

```json
{
  "name": "codex-browser-recorder",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "node --test"
  }
}
```

Tests must cover a valid frame, a non-frame event, missing session ID, malformed base64, and an oversized payload.

- [x] **Step 2: Run the parser tests and verify RED**

Run: `npm test`

Expected: FAIL because `poc/screencast-recorder.mjs` does not exist or lacks the exported functions.

- [x] **Step 3: Implement the minimal validated parser**

The parser must reject malformed payloads before decoding and must never include raw frame data in thrown error messages.

- [x] **Step 4: Run the parser tests and verify GREEN**

Run: `npm test`

Expected: all parser tests pass with no warnings.

### Task 2: Test and implement the CDP frame pump

**Files:**
- Modify: `tests/screencast-recorder.test.mjs`
- Modify: `poc/screencast-recorder.mjs`

**Interfaces:**
- Consumes: a CDP capability exposing `send(method, params)` and `readEvents(options)`.
- Produces: `startFramePump({ cdp, onFrame, maxDecodedBytes, readTimeoutMs })` returning `{ ready, stop, stats }`.

- [x] **Step 1: Write failing tests for acknowledgement and cursor handling**

Use an in-memory fake CDP capability. Verify that every valid frame is acknowledged before `onFrame`, dropped frames are still acknowledged, cursors advance, visibility events update statistics, and `stop()` ends a pending poll.

- [x] **Step 2: Run the pump tests and verify RED**

Run: `npm test`

Expected: FAIL because `startFramePump` is not exported.

- [x] **Step 3: Implement the minimal bounded polling loop**

Filter only screencast-frame and screencast-visibility events, page through `hasMore`, detect `truncated`, and expose sanitized counters without frame contents or URLs.

- [x] **Step 4: Run the pump tests and verify GREEN**

Run: `npm test`

Expected: all tests pass with no leaked timers or handles.

### Task 3: Test and implement fixed-rate FFmpeg sampling

**Files:**
- Modify: `tests/screencast-recorder.test.mjs`
- Modify: `poc/screencast-recorder.mjs`

**Interfaces:**
- Consumes: decoded JPEG buffers from the frame pump.
- Produces: `createFfmpegSink({ ffmpegPath, outputPath, fps })` returning `{ accept, stop, stats }`.

- [x] **Step 1: Write a failing lifecycle test with an injected process factory**

Verify that the latest frame is repeated at a fixed cadence, stdin backpressure drops output samples rather than buffering without limit, and `stop()` closes stdin and rejects a non-zero encoder exit.

- [x] **Step 2: Run the lifecycle test and verify RED**

Run: `npm test`

Expected: FAIL because `createFfmpegSink` is not exported.

- [x] **Step 3: Implement the minimal FFmpeg sink**

Spawn FFmpeg with MJPEG image-pipe input at 10 fps and VP8 WebM output. Retain only the latest JPEG buffer and sanitized stderr tail.

- [x] **Step 4: Run unit tests and a local FFmpeg smoke test**

Run: `npm test`

Expected: all tests pass; the smoke test produces a parseable short WebM under a temporary directory.

### Task 4: Run the visible Browser feasibility gate

**Files:**
- Create: `poc/run-browser-poc.mjs`

**Interfaces:**
- Consumes: a selected Browser tab, its raw CDP capability, and an output directory.
- Produces: `startBrowserPoc(...)` and `stopBrowserPoc(...)`, plus a sanitized result object containing duration, frame counts, truncation count, visibility changes, encoder samples, and output path.

- [x] **Step 1: Compose the tested pump and sink without adding new behavior**

Start the page domain and JPEG screencast, start the pump, and guarantee screencast shutdown in a finalization path.

- [x] **Step 2: Connect to a fresh in-app Browser tab**

Navigate to `https://example.com/`, obtain normal full-CDP approval, and inject a clearly visible clock and CSS animation using page-runtime evaluation. Close the tab after testing so the modification is not retained.

- [x] **Step 3: Record at least 15 visible seconds**

Pass condition: frames arrive continuously, all valid frame session IDs are acknowledged, the event buffer is not truncated, and FFmpeg exits successfully.

- [x] **Step 4: Validate with FFprobe**

Run FFprobe with JSON output and require one video stream, positive dimensions no larger than 1280×720, and duration within three seconds of the measured recording interval.

### Task 5: Run the two-minute hidden Browser feasibility gate

**Files:**
- Modify: `poc/run-browser-poc.mjs` only if the visible run exposes a harness defect, following a new failing test first.

**Interfaces:**
- Consumes: the same fresh test tab and recorder composition used by Task 4.
- Produces: a second validated WebM and sanitized result JSON.

- [x] **Step 1: Start recording while the test animation is visible**

Wait for the first frame and establish baseline frame and sample counts.

- [x] **Step 2: Hide the in-app Browser for 120 seconds**

Keep polling events and sample the latest frame. Poll status in intervals shorter than 60 seconds so progress remains observable.

- [x] **Step 3: Restore visibility and stop recording**

Pass condition: no unrecoverable stall, output sample count continues increasing for the full interval, and at least one fresh source frame arrives during the hidden interval.

- [x] **Step 4: Validate output and write the result JSON**

Require a positive video stream and duration within five seconds of the measured session. Record a No-Go if hidden source frames cease entirely, even when repeated output frames keep the video duration plausible.

### Task 6: Report the feasibility decision

**Files:**
- Modify: `docs/superpowers/plans/2026-07-15-phase-0-browser-screencast-poc.md`

**Interfaces:**
- Consumes: visible and hidden result JSON plus FFprobe output.
- Produces: a concise evidence table with PASS, FAIL, or BLOCKED for CDP availability, visible capture, hidden capture, and finalization.

- [x] **Step 1: Run the complete local test gate**

Run: `npm test && git diff --check`

Expected: tests pass and no whitespace errors are reported.

- [x] **Step 2: Record exact evidence without raw frames or sensitive page data**

Include elapsed duration, received and acknowledged frames, dropped samples, visibility transitions, event truncations, FFprobe duration, dimensions, and sanitized failure codes.

- [x] **Step 3: State Go, No-Go, or Blocked**

Use Go only when all executed gates pass. Use No-Go when hidden capture is proven to stall. Use Blocked when approval, policy, missing capability, or environment prevents the gate from being executed.

## Execution Status — 2026-07-15

| Gate | Status | Evidence |
| --- | --- | --- |
| Local frame boundary | PASS | Valid, malformed, missing-session, and oversized payload cases pass. |
| CDP frame pump | PASS | Cursor, acknowledgement ordering, dropped-frame acknowledgement, visibility, and truncation cases pass. |
| FFmpeg/FFprobe integration | PASS | A generated JPEG is sampled into a parseable VP8 WebM with positive dimensions and duration. |
| Encoder backpressure | PASS | Sampling pauses while FFmpeg stdin is backpressured, preventing unbounded queued frames. |
| First-frame timeout | PASS | A missing frame stream fails with `frame_stream_unavailable` instead of waiting indefinitely. |
| Output validator | PASS | Valid video, empty file, corrupt file, excessive dimensions, and duration mismatch cases pass. |
| Temporary workspace | PASS | Each run receives a unique `0700` directory outside the repository with fixed video and result filenames. |
| Sanitized result finalization | PASS | Successful, readiness-failed, encoder-failed, and validation-failed sessions write a private `0600` JSON result without absolute paths, raw diagnostics, or extra capture fields. |
| Single video stream | PASS | FFprobe validation rejects outputs containing zero or multiple video streams. |
| Environment doctor | PASS | Supported and multi-blocker results are deterministic and read-only. |
| Browser CDP availability | PASS | A fresh post-navigation capability supported `Page.enable`, `Page.startScreencast`, frame acknowledgement, and event reads. |
| Visible capture | PASS | 15.611 s elapsed; 804 received and acknowledged frames; 154 samples; zero drops, invalid frames, backpressure drops, or truncations; VP8 output 15.4 s at 357×720. |
| Hidden capture | PASS | 122.183 s elapsed with a 120 s hidden interval; 5,916 received and acknowledged frames; 1,218 samples; zero drops, invalid frames, backpressure drops, or truncations; VP8 output 121.8 s at 357×720. |
| Interaction fidelity | PASS | Typing, scrolling, SPA state change, and cross-page navigation were captured; 52 received and acknowledged frames; VP8 output 10.5 s at 357×720. |
| Hardened hidden regression | PASS | After lifecycle hardening: 35.072 s elapsed with a 30 s hidden interval; 2,580 received and acknowledged frames; 350 samples; zero drops or truncations; schema 2 VP8 output 35.0 s at 1280×720. |
| Hardened interaction regression | PASS | After per-session CDP reacquisition and atomic output: typing, scrolling, SPA update, and navigation passed; 19 received and acknowledged frames; 100 samples; zero drops or truncations; schema 2 VP8 output 10.0 s at 357×720. |

Current decision: **Go** for the exact-session Phase 0 architecture. This does not make the repository a production-ready plugin; Phase 1 controls and packaging remain separate work.

## Implementation hardening completed — 2026-07-15

- FFmpeg spawn errors are contained until the caller observes `stop()`.
- Encoder startup and early-exit failures proactively terminate the Browser session; shutdown is bounded and escalates to `SIGKILL`.
- Successful output is size-checked after encoder flush and atomically published from a `.partial` file; failed, cancelled, and oversized captures remove the partial output.
- Readiness failure automatically stops screencasting, the frame pump, and the encoder.
- Recording sessions support AbortSignal cancellation, a 20-minute default hard limit, a 500 MiB default output limit, and optional fresh-frame stall detection.
- Elapsed time uses a monotonic clock and excludes encoder flush time.
- Every new tab recording reacquires the current CDP capability after navigation.
- CDP batches, cursors, public configuration, executable paths, and video validation inputs are bounded and validated.
- The reusable `runBrowserPocGate` path performs prepare, fresh capability acquisition, recording, cleanup, FFprobe validation, and sanitized result persistence end to end.
- Page-level `Page.screencastVisibilityChanged` remained `true` while the Browser surface was hidden; frame freshness and the Browser visibility capability are the reliable hidden-state evidence.
