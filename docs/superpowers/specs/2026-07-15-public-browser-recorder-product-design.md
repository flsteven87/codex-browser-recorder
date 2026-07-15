# Public Browser Recorder Product Design

**Status:** Approved for implementation on 2026-07-15.

## Objective

Turn the fixed `https://example.com/` integration proof into one focused,
user-facing Codex plugin workflow that records a fresh, explicitly approved
Browser tab to a private local WebM file. Keep environment diagnosis and the
fixed example recording as internal preflight and release-verification
mechanisms rather than user-facing product modes.

The first public release is `0.1.0` with Git tag `v0.1.0`. During local
development, Codex cachebuster build metadata may remain on the manifest
version, but release artifacts must use the canonical version without build
metadata.

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

A successful run produces one validated, audio-free VP8 WebM in a unique
private operating-system temporary directory. The final response leads with
duration, format, dimensions, lack of audio, and the local path. Capture
counters and encoder details are diagnostics and are not part of the primary
user experience.

A failed run returns one allowlisted failure code, a concise summary, and an
actionable remediation. It never exposes raw frames, page text, full URLs, CDP
payloads, Browser objects, subprocess output, credentials, or internal plugin
paths.

## User Workflow

1. The user explicitly invokes `$record-browser` and provides the target URL,
   intended Browser actions, and optional recording duration.
2. The skill presents one consolidated consent prompt containing the approved
   origin, planned actions, duration, private local output behavior, and the
   exclusions for audio, browser chrome, other tabs, and sensitive data.
3. Only after consent, the skill creates one fresh Browser tab and navigates it
   to the validated target URL.
4. Normal Browser site and full-CDP approval remain platform-controlled. A
   denial maps to `cancelled` and is never retried or bypassed.
5. The skill runs automatic preflight. It reports allowlisted blockers without
   changing system configuration or installing dependencies.
6. The skill starts the deterministic recording entry point and performs only
   the Browser actions approved by the user. It does not inject clocks,
   animations, test text, or other diagnostic page mutations.
7. The skill reports bounded progress while the runtime records.
8. The skill stops the runtime, validates the media, closes the fresh tab, and
   reports the user-facing result.

Every operation after fresh-tab creation is protected by one outer
`try`/`finally`. Finalization is attempted before tab closure. A primary
recording failure remains primary if cleanup also fails.

## Scope And Consent Policy

- Invocation remains explicit; `policy.allow_implicit_invocation` is `false`.
- The first release accepts `https:` targets and explicitly approved loopback
  development targets using `http:` with host `localhost`, `127.0.0.1`, or
  `[::1]`.
- URLs containing a username or password are rejected before Browser activity.
- Consent is scoped to one normalized origin. Same-origin paths, fragments, and
  SPA state changes are allowed after recording starts.
- A top-level navigation to a different origin terminates the session,
  discards the entire recording, and returns
  `origin_changed_during_recording`.
- The first release records one fresh tab only. It does not record an existing
  tab, multiple tabs, browser chrome, Codex UI, audio, or an entire profile.
- The first release does not upload, share, copy, or move the resulting file.
  Those are separate user-authorized actions outside the recording skill.
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
atomic publication of the WebM working file. It never returns subprocess output
or frame content.

### `validate-video.mjs`

Owns bounded EBML inspection and FFprobe validation. A valid output contains
exactly one VP8 video stream, no audio stream, WebM `DocType`, bounded
dimensions, a plausible duration, and a bounded file size.

### `recording-artifacts.mjs`

Owns private directory creation, path construction, schema-v3 result writing,
transactional artifact cleanup, and file modes. If result persistence fails
after media validation, it removes the finalized video so the operation cannot
appear successful with an incomplete artifact set.

### `doctor.mjs`

Remains a read-only feature probe for macOS, CDP availability, temporary output
access, the FFmpeg `libvpx` encoder, the WebM muxer, and usable FFprobe JSON.
It returns only resolved capabilities and allowlisted blockers.

### `create-recording.mjs`

Exposes the only production orchestration entry point:

```js
const handle = await createRecording({
  durationMs,
  ffmpegPath,
  ffprobePath,
  tab,
  targetUrl,
  temporaryRoot,
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
skill receives the private paths separately and may show the final video path
directly to the user after cleanup has completed.

Stable user-facing failures include invalid target, unsupported target scheme,
URL credentials present, invalid duration, unavailable Browser or CDP,
approval cancellation, unsupported media capabilities, origin verification
failure, origin change during recording, missing frames, resource limits,
encoder failure, media validation failure, artifact persistence failure, and
cleanup failure. Every code maps to one fixed summary and remediation.

## Internal Release Gate

The fixed `https://example.com/` scenario moves out of the public skill and
plugin starter prompts. Repository-only release tooling uses the production
`createRecording()` entry point with a fresh Browser tab, a 10-to-15-second
duration, and disposable clock, animation, scroll, and DOM-state actions.

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

The README distinguishes WebM page recording from Codex Record & Replay, which
turns a demonstrated workflow into a reusable skill.

## Open-Source And Release Baseline

The repository adds a contributor guide, code of conduct, support policy,
changelog, issue forms, pull-request template, CODEOWNERS, and Dependabot
configuration. CI adds static analysis and supply-chain checks with minimal
permissions and full-SHA action pinning.

Before `v0.1.0`, local release gates must pass and the maintainer must separately
authorize these external GitHub changes:

- enable private vulnerability reporting and its notifications;
- enable Dependabot security updates and CodeQL;
- protect `main` with required CI, no force push or deletion, and linear PR
  integration;
- use one documented merge strategy and delete merged branches;
- create the `v0.1.0` tag and GitHub release;
- submit the plugin for public review only after listing materials and evals are
  final.

Installation documentation pins the marketplace to `v0.1.0` rather than an
unbounded mutable `main`. Manifest version, Git tag, changelog, and release
notes must agree.

## Migration From The Current Proof

The current capture, validation, doctor, and artifact logic is retained where
its behavior matches this design. The 863-line orchestration module is split by
responsibility. Historical Phase 0 helpers and example-specific orchestration
move outside the shipped plugin. No parallel `v2`, `new`, or fallback runtime
is kept.

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
  settings, and the pinned `v0.1.0` installation path are in place before public
  submission.
