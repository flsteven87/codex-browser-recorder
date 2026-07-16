# Public Browser Recorder Product Design

**Status:** Approved on 2026-07-15; Saved Recording amendment approved on
2026-07-16.

## v0.2 Saved Recording Amendment

Version `0.2.0` changes the user outcome from a temporary artifact to a Saved
Recording. The default destination is
`~/Downloads/Codex Browser Recordings/`, with an explicit absolute local
override. Consent shows the destination and privacy-safe filename before any
Browser activity. The default filename is
`browser-recording-YYYY-MM-DD-HHmmss.mp4`; it never uses page-derived text, and
a collision adds a short recording ID instead of overwriting a file.

New recordings use one H.264 `yuv420p` video stream in an MP4 container with no
audio. This is a user-delivery compatibility decision, not a format framework:
v0.2 has no format selector, retained WebM output branch, pluggable storage
backend, generic media sink, or cross-platform destination abstraction.
Existing WebM files remain untouched.

`recording-artifacts.mjs` exposes one deep artifact transaction. It owns the
Working Recording directory, fixed validation policy, private result
persistence, atomic durable publication, collision handling, rollback, and
idempotent cleanup. It does not own Browser capture shutdown, CDP teardown,
FFmpeg shutdown, or capture-failure precedence; those stay in the recording
coordinator. Ordinary callers receive one transaction-issued capture path and
do not configure validation internals.

Only durable publication permits `Recording completed`. Destination access is
checked after consent and before creating a Browser tab, with no silent
temporary fallback. If publication fails after validation, the Working
Recording is retained temporarily and reported for recovery. Success returns a
clickable Saved Recording plus duration, dimensions, H.264 MP4, no audio, and
the absolute local path. Finder is offered but never opened automatically.

This amendment deliberately uses the existing skill, coordinator, media
recorder, validator, and artifact module. It adds no ADR subsystem, service,
database, upload path, MCP server, or additional public mode.

## Objective

Provide one focused, user-facing Codex plugin workflow that records a fresh,
explicitly approved Browser tab to a durable local H.264 MP4 Saved Recording.
Keep environment diagnosis and the fixed example recording as internal
preflight and release-verification mechanisms rather than user-facing product
modes.

The current candidate is `0.2.0` with the future immutable Git tag `v0.2.0`.
Until that tag is published, `v0.1.0` remains the latest immutable release.
Release artifacts use the canonical manifest version without build metadata.

## Product Decision

The plugin exposes one public skill: `$record-browser`.

The user supplies a target URL, the Browser actions to perform, and an optional
duration. The skill owns consent, fresh-tab orchestration, progress reporting,
and the final user response. Deterministic modules own URL policy, origin
enforcement, runtime limits, media encoding, artifact transactions, result
sanitization, and cleanup.

The product does not expose a diagnostic skill or an integration-gate mode.
`doctor()` runs automatically before recording, and the fixed
`https://example.com/` workflow remains repository-only release tooling that
exercises the same production entry point.

## User Outcome

A successful run produces one validated, audio-free H.264 MP4 Saved Recording
in the consented local destination. The final response leads with a clickable
file, duration, format, dimensions, lack of audio, and the absolute local path.
Capture counters and encoder details are diagnostics and are not part of the
primary user experience.

A failed run returns one allowlisted failure code, a concise summary, and an
actionable remediation. It never exposes raw frames, page text, full URLs, CDP
payloads, Browser objects, subprocess output, credentials, or internal plugin
paths.

## User Workflow

1. The user explicitly invokes `$record-browser` and provides the target URL,
   intended Browser actions, and optional recording duration.
2. The skill presents one consolidated consent prompt containing the approved
   origin, planned actions, duration, Saved Recording destination and filename,
   and the exclusions for audio, browser chrome, other tabs, and sensitive data.
3. Only after consent, the runtime proves that the destination supports the
   exact atomic no-overwrite publication primitive. Failure stops before any
   Browser activity and never falls back to a temporary user outcome.
4. The skill creates one fresh Browser tab and navigates it to the validated
   target URL.
5. Normal Browser site and full-CDP approval remain platform-controlled. A
   denial maps to `cancelled` and is never retried or bypassed.
6. The skill runs automatic preflight. It reports allowlisted blockers without
   changing system configuration or installing dependencies.
7. The skill starts the deterministic recording entry point and performs only
   the Browser actions approved by the user. It does not inject clocks,
   animations, test text, or other diagnostic page mutations.
8. The skill reports bounded progress while the runtime records.
9. The skill stops the runtime, validates and durably publishes the media,
   closes the fresh tab, and reports the user-facing result.

Every operation after fresh-tab creation is protected by one outer
`try`/`finally`. Finalization is attempted before tab closure. A primary
recording failure remains primary if cleanup also fails.

## Scope And Consent Policy

- Invocation remains explicit; `policy.allow_implicit_invocation` is `false`.
- The workflow accepts `https:` targets and explicitly approved loopback
  development targets using `http:` with host `localhost`, `127.0.0.1`, or
  `[::1]`.
- URLs containing a username or password are rejected before Browser activity.
- Consent is scoped to one normalized origin. Same-origin paths, fragments, and
  SPA state changes are allowed after recording starts.
- A top-level navigation to a different origin terminates the session,
  discards the entire recording, and returns
  `origin_changed_during_recording`.
- The workflow records one fresh tab only. It does not record an existing
  tab, multiple tabs, browser chrome, Codex UI, audio, or an entire profile.
- The workflow publishes the Saved Recording only to the consented local
  destination. It does not upload, share, or move it afterward; those are
  separate user-authorized actions outside the recording skill.
- The default duration is 15 seconds. Accepted user durations are 5,000 through
  60,000 milliseconds. The non-overridable runtime hard limit is 65,000
  milliseconds.
- Sensitive authenticated flows, credentials, payment data, passkeys, recovery
  secrets, health data, and confidential communications remain out of scope.

## Architecture

The plugin remains skills-only and reuses the installed Browser runtime. It
does not add an MCP server, app, hook, separate browser process, remote service,
or upload path.

### `recording-policy.mjs`

Owns target parsing, URL scheme and loopback rules, normalized-origin creation,
duration validation, and fixed capture limits. It exports pure functions and
constants. Callers cannot override the hard limit, maximum dimensions, frame
payload limit, output limit, or media format.

### `browser-recording.mjs`

Owns the CDP recording transaction. It acquires the current tab capability,
enables the Page domain, captures the event baseline, verifies the current top
frame, starts screencasting, monitors top-frame navigation, enforces runtime
resources, and finalizes stop or abort.

Startup order is fixed:

1. `Page.enable`
2. capture the event baseline cursor
3. `Page.getFrameTree` and verify the approved origin
4. `Page.startScreencast`
5. consume events after the baseline, including `Page.frameNavigated`

The top-frame ID from `Page.getFrameTree` identifies relevant navigation
events. Any top-frame origin mismatch records the stable policy failure and
causes finalization to discard the working output. This closes the gap between
one-time startup verification and continuous recording policy.

### `media-recorder.mjs`

Owns bounded frame parsing, immediate frame acknowledgement, latest-frame
sampling, FFmpeg backpressure, output-size enforcement, encoder shutdown, and
creation of the private H.264 `yuv420p` MP4 Working Recording. It normalizes odd
Browser dimensions to even values required by H.264 and never returns
subprocess output or frame content.

### `validate-video.mjs`

Owns bounded MP4 signature inspection and FFprobe validation. A valid output
contains exactly one H.264 `yuv420p` video stream, no audio stream, an MP4
container, bounded dimensions, a plausible duration, and a bounded file size.

### `recording-artifacts.mjs`

Owns destination capability preflight, private Working Recording allocation,
fixed media validation, schema-v3 result writing, atomic no-overwrite durable
publication, collision naming, rollback, cleanup, and file modes. Capture and
validation failures are discarded. A validated Working Recording is retained
only when pre-commit result persistence or durable publication fails; a
committed Saved Recording is never downgraded by later cleanup failure.

### `doctor.mjs`

Remains a read-only feature probe for macOS, CDP availability, Saved Recording
destination access, the FFmpeg `libx264` encoder, the MP4 muxer, and usable
FFprobe JSON. It returns only resolved capabilities and allowlisted blockers.

### `create-recording.mjs`

Exposes the only production orchestration entry point:

```js
const handle = createRecording({
  browser,
  destinationDirectory,
  durationMs,
  recordingName,
  targetUrl,
});
```

The public handle remains:

```js
{
  ready,
  status(),
  stop(),
}
```

`stop()` is idempotent and returns one memoized finalization promise. The
process-wide Browser-runtime singleton is reserved before asynchronous startup
and released on every terminal path.

## State Model

The public state is one of:

```text
preparing
awaiting_frame
recording
stopping
completed
failed
cancelled
```

Transitions are deterministic. A terminal state cannot transition back to an
active state. Status contains state and bounded counters only; it never contains
paths, URLs, Browser or CDP objects, frames, page content, or diagnostics.

## Result Contract

Schema version 3 contains:

- `schemaVersion`
- `status`
- `failureCode`
- allowlisted `summary`
- allowlisted `remediation`
- bounded capture counters
- media validation metadata
- recorder contract version
- output filename

The JSON result never contains the absolute output path. On success, the outer
skill receives the Saved Recording path separately and shows it directly to the
user after finalization. Failure paths expose only bounded cleanup metadata when
manual recovery or deletion is required.

Stable user-facing failures include invalid target, unsupported target scheme,
URL credentials present, invalid duration, unavailable Browser or CDP,
approval cancellation, unsupported media capabilities, origin verification
failure, origin change during recording, missing frames, resource limits,
encoder failure, media validation failure, artifact persistence failure, and
cleanup failure. Every code maps to one fixed summary and remediation.

## Internal Release Gate

The fixed `https://example.com/` scenario stays outside the public skill and
plugin starter prompts. Repository-only release tooling uses the production
`createRecording()` entry point with a fresh Browser tab, a 10-to-15-second
duration, a disposable Saved Recording destination, and bounded clock,
animation, scroll, and DOM-state actions.

Every candidate release must run the scenario twice sequentially to verify
singleton release and final cleanup. Recorded evidence remains sanitized and
contains no absolute plugin-cache paths, page payloads, frame data, or
subprocess output.

## Testing And Evals

Behavior changes use test-driven development. Each production change begins
with a focused test that fails for the intended missing behavior.

Required test layers are:

- policy tests for schemes, URL credentials, loopback, origin normalization,
  and duration bounds;
- navigation tests for same-origin changes, cross-origin changes, redirects,
  baseline races, output discard, and stop races;
- lifecycle tests for startup, first-frame readiness, abort, repeated stop,
  encoder exit, cleanup failure, and result-persistence failure;
- parser tests with generated malformed base64, event batches, and bounded EBML
  inputs;
- static skill contract tests for explicit invocation, consolidated consent,
  product language, deterministic delegation, and mandatory cleanup;
- plugin structure and manifest tests;
- isolated installation and installed-cache import tests;
- exactly five positive and three negative plugin-submission eval fixtures;
- a manual installed-desktop release gate against the final plugin tree.

CI must fail when the pinned Codex CLI installation or isolated plugin install
cannot run. It must not convert a missing CLI into a successful skipped gate.
Critical media and policy modules receive explicit focused coverage rather than
relying only on aggregate repository thresholds.

## User-Facing Metadata

The public listing uses plain product language and does not mention integration
gates, Phase 0, or diagnostics. It includes:

- publisher name, contact, repository, and public website;
- privacy, terms, and support URLs;
- accurate capabilities and compatibility information;
- brand color, composer icon, light and dark logos, and sanitized screenshots;
- two or three adaptable starter prompts for recording approved test flows.

The README distinguishes H.264 MP4 page recording from Codex Record & Replay,
which turns a demonstrated workflow into a reusable skill.

## Open-Source And Release Baseline

The repository adds a contributor guide, code of conduct, support policy,
changelog, issue forms, pull-request template, CODEOWNERS, and Dependabot
configuration. CI adds static analysis and supply-chain checks with minimal
permissions and full-SHA action pinning.

Before `v0.2.0`, local release gates must pass and the maintainer must separately
authorize these external GitHub changes:

- enable private vulnerability reporting and its notifications;
- enable Dependabot security updates and CodeQL;
- protect `main` with required CI, no force push or deletion, and linear PR
  integration;
- use one documented merge strategy and delete merged branches;
- create the `v0.2.0` tag and GitHub release;
- submit the plugin for public review only after listing materials and evals are
  final.

After publication, installation documentation pins the marketplace to `v0.2.0`
rather than an unbounded mutable `main`. Manifest version, Git tag, changelog,
and release notes must agree.

## Migration From The Current Proof

The v0.1 capture, validation, doctor, and artifact logic is retained only where
its behavior matches this design. No parallel `v2`, `new`, WebM fallback, or
alternate runtime is kept, and existing user-created WebM files are untouched.

The existing fixed-origin skill is replaced in place by the public workflow.
Source and installed-cache paths remain single and canonical. Existing schema-2
results are historical evidence; schema 3 is the only new runtime output.

## Acceptance Criteria

The design is complete when all of the following are true:

- `$record-browser` is the only public workflow and uses plain user-facing
  language.
- One consolidated consent occurs before any Browser action.
- The runtime accepts only the approved target classes and enforces duration
  bounds in code.
- Same-origin navigation remains recordable; cross-origin top-frame navigation
  stops and discards the recording.
- No sensitive runtime payload enters model context or result JSON.
- Stop, abort, startup failure, resource termination, validation failure, and
  cleanup are deterministic and idempotent.
- The shipped plugin contains no example-specific or historical test harness.
- Fresh tests, coverage, validators, isolated installation, the eight
  submission evals, and two sequential desktop recordings pass.
- Public metadata, legal/support links, community files, protected release
  settings, and the pinned `v0.2.0` installation path are in place before public
  submission.
