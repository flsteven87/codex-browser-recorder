# Cursor-complete Browser Recording Design

**Status:** Implemented and validated on 2026-07-16.

## Objective

Make every Saved Recording accurately communicate the pointer interactions
that occurred in the approved Browser tab, including interactions inside
embedded frames. The output remains a local, audio-free H.264 `yuv420p` MP4;
the existing `$record-browser` workflow and `createRecording()` handle remain
the only public product surface.

## User Contract

- Browser page pixels include top-level and iframe content but exclude browser
  chrome and Codex UI.
- An original, project-owned Codex-style arrow is composited into the video.
  It follows exact observed event positions with deterministic interpolation;
  it does not claim to copy Codex's private cursor asset or animation.
- The cursor is hidden until the first observed pointer event and then remains
  at its last observed position.
- A pointer press starts or restarts one subtle 200 ms ring at its coordinate;
  overlapping presses share this single feedback ring instead of creating an
  animation-layer system.
- The fixed arrow does not reproduce CSS cursor variants such as link hands,
  text beams, resize handles, or drag icons.
- A planned pointer interaction with no corresponding observed event fails the
  session. Keyboard-only or passive recordings may have no cursor because the
  recorder never invents an initial position.
- Media may become a Saved Recording only when cursor observation, timeline
  retention, composition, media validation, and publication all succeed.

All cursor failures map to one allowlisted user-facing failure code,
`cursor_recording_failed`, with no CDP payload, frame URL, page data, FFmpeg
diagnostic, or private path in the response.

## Scope

The recorder supports the top-level document, same-process frames, nested
frames, cross-origin frames, dynamically attached frames, reloaded documents,
and out-of-process iframe targets that are observable through the Browser
plugin's public CDP capability. It observes only pointer event type, local
coordinates, button state, sequence, frame identity, page-event occurrence
time, and recorder-relative time. It never reads element text, form values,
credentials, page storage, or network traffic for cursor capture.

The following remain out of scope:

- native window or screen capture;
- private Browser transport or Codex UI hooks;
- copying private cursor assets;
- generic animation, theme, cursor, or output-format settings;
- audio, browser chrome, multiple tabs, or an existing tab;
- silently publishing a recording after an observer, transform, event buffer,
  or compositor failure.

## Architecture

The existing public handle stays unchanged:

```js
createRecording(options) -> { ready, status(), stop() }
```

One deep internal module, `cursor-recording.mjs`, owns both cursor capture and
cursor composition. Its two testable seams are:

```js
startCursorCapture({ cdp, mainFrameId, now })
renderCursorRecording({ ffmpegPath, inputPath, outputPath, timeline })
```

The module does not expose frame registries, binding payloads, interpolation
helpers, FFmpeg command construction, or asset materialization. The recording
coordinator remains responsible for lifecycle ordering and failure precedence.
The artifact transaction remains responsible for validation, publication, and
rollback.

### Cursor capture

`startCursorCapture()` establishes its own bounded CDP event baseline before
approved Browser actions begin. It uses public `Page`, `Runtime`, `DOM`, and
`Target` commands to:

1. enable required domains in the root target and Browser-managed attached
   iframe targets;
2. establish the current retained event baseline, discover the top document
   and existing frames, and address already-attached OOPIFs through their
   public frame target identifiers;
3. add one name-scoped Runtime binding per target;
4. create an isolated world for each participating frame;
5. install capture-phase listeners for Browser-dispatched move, press, release,
   click, double-click, and wheel lifecycle events;
6. consume binding and frame/target lifecycle events from its own event cursor;
7. re-arm new execution contexts after navigation, reload, attachment, or
   process changes; and
8. remove observers and bindings during bounded cleanup without changing the
   Browser plugin's target-attachment policy.

The page-side listener emits only a versioned, bounded cursor payload. Move
events are coalesced to a bounded cadence while press and release boundaries
are never coalesced. DOM `isTrusted` is not used as an eligibility signal
because Codex in-app Browser control calls intentionally expose their input as
untrusted DOM events. Instead, each approved action must advance the event
counter at or after its own action boundary or the run fails closed. The
recorder includes `performance.timeOrigin + event.timeStamp` as that bounded
occurrence time. It separately timestamps accepted events before geometry
queries with its injected monotonic `now()` clock for composition, so CDP query
latency cannot shift click feedback. The occurrence time is live status only
and is not persisted in schema-v3 results. Malformed payloads are rejected
rather than repaired.

Frame-local CSS coordinates are mapped through the public frame-owner geometry
for every ancestor until they reach top-level viewport CSS coordinates. The
mapping accounts for iframe borders, nesting, scrolling, scale, and transformed
owner quads. Coordinates are then scaled to the actual encoded frame geometry,
including the existing no-upscale and even-dimension rules. Missing geometry,
an unsupported transform, a detached target during an accepted event, or an
unobservable participating frame invalidates the session.

The timeline is strictly ordered and bounded. Event-buffer truncation, a
backwards cursor, an event-count overflow, an observer re-arm failure, or
incomplete cleanup sets `cursor_recording_failed`. The Working Recording is
discarded on every such path. Stop drains every buffered `hasMore` page of the
cursor event stream before cleanup so a final interaction cannot be omitted.

### Cursor timeline

The first accepted cursor event establishes the visible position. Later moves
use a deterministic, bounded interpolation that ends at the exact observed
event position; it approximates the visible Codex movement without claiming to
observe its private animation samples. Press events start or restart one 200 ms
ring at the exact latest press coordinate. The timeline contains no
page-derived labels or URLs.

The existing recording rate remains 10 FPS. Interpolation is evaluated at
output-frame timestamps, so the same timeline always produces the same cursor
frames. No new user setting is introduced.

### Video composition

The existing sink first produces a private base Working Recording. After
capture and cursor cleanup succeed, `renderCursorRecording()` performs one
bounded local FFmpeg composition pass using project-owned transparent cursor
and ring assets plus deterministic output-frame overlay expressions. It writes
a separate partial file, preserves one H.264 `yuv420p` video stream with no
audio, enforces an owned deadline with bounded process termination, checks the
output-size limit, and replaces the private base file only after FFmpeg
succeeds.

The compositor never edits a page or injects a visible DOM cursor, so the live
Codex in-app Browser does not show a duplicated pointer. Composition failure or
partial-output cleanup failure remains a recording failure and cannot reach
durable publication.

## Lifecycle

The recording coordinator orders the transaction as follows:

1. validate consented request and durable destination;
2. create and navigate one fresh approved Browser tab;
3. acquire public full-CDP capability and verify the top-level origin;
4. start cursor capture and prove all current frames are observed;
5. start the existing page-frame capture and base encoder;
6. resolve `ready` only after both cursor observation and the initial frame are
   ready;
7. perform only approved Browser actions while both pumps remain healthy and
   require the cursor-event counter to advance after every planned pointer
   action before the next action begins;
8. stop page-frame capture and cursor capture, preserving the primary failure;
9. stop the base encoder and obtain the validated cursor timeline;
10. compose cursor and click feedback into a separate private partial MP4;
11. run the existing media validation and durable publication transaction; and
12. clean up observers, temporary media, and the fresh tab on every path.

`stop()` remains idempotent. A cursor failure racing with encoder or cleanup
failure stays primary when it occurred first. No base or cursor-partial media
is reported as a successful user outcome.

## TDD Contract

Tests use the two confirmed module seams and the existing `createRecording()`
result. Private helper behavior is asserted only through those outcomes.

Vertical slices proceed in this order:

1. top-level isolated-world event becomes a bounded timeline position;
2. first-event visibility, deterministic interpolation, and 200 ms press ring;
3. same-process, nested, and dynamically re-armed frame coordinate mapping;
4. flattened child-target/OOPIF observation and teardown;
5. malformed payload, truncation, overflow, transform, and re-arm failures all
   fail closed with `cursor_recording_failed`;
6. FFmpeg composition produces a visible cursor and ring in H.264 `yuv420p`
   MP4 while preserving duration, dimensions, no-audio, and size limits;
7. coordinator readiness, idempotent stop, failure precedence, rollback, and
   zero-event pointer-action enforcement; and
8. end-to-end recording across a reload and embedded frame, followed by the
   existing full test, coverage, plugin-install, submission-eval, and release
   candidate gates.

## Acceptance

- A normal top-level click is visible at the correct encoded coordinate.
- A click inside nested or cross-origin iframe content is visible at the
  correct top-level encoded coordinate.
- A frame reload or dynamic attachment does not create an unobserved interval.
- The cursor never appears before a real pointer event and persists afterward.
- The click ring lasts 200 ms from the latest press and does not obscure the
  target beyond its small local footprint.
- Static page pixels continue to record for the requested duration.
- No Cursor-complete claim is made after any observer, timeline, target,
  coordinate, compositor, or cleanup integrity failure.
- The output remains a validated local H.264 `yuv420p` MP4 with no audio and no
  browser chrome.
- The plugin adds one focused module and project-owned assets, with no service,
  dependency framework, database, upload path, or user-facing settings system.

## Validation Record

The installed Codex in-app Browser path produced a real 1280 x 720 H.264
`yuv420p` MP4 with one video stream, no audio, a cursor hidden before the first
event, a visible project-owned arrow at the observed click coordinate, and a
two-frame 200 ms click ring at 10 FPS. The approved click also changed the page
state, proving the captured interaction was real rather than a synthetic video
fixture. Public-CDP tests cover same-process nested frames, dynamic re-arming,
Browser-managed OOPIF sessions, current geometry refresh, bounded overflow,
cleanup, and fail-closed behavior.

The live integration also established that the Browser plugin rejects a direct
`Target.setAutoAttach` command. The implementation therefore addresses
already-present OOPIFs through public frame target identifiers and consumes
future Browser-managed `Target.attachedToTarget` and `Target.detachedFromTarget`
events instead of attempting to own target attachment.
