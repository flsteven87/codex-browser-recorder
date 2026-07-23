# Changelog

All notable changes to this project will be documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions
follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- Hide click feedback between non-contiguous click-ring windows instead of
  rendering a ghost ring at the viewport origin.
- Publish the installed skill's canonical
  `$codex-browser-recorder:record-browser` invocation across starter prompts,
  documentation, support guidance, and submission evals so explicit invocation
  resolves through the plugin namespace.
- Verify that the exact owned recording tab disappears from Chrome's tab
  inventory after `close()` fulfills. A tab that remains listed now consumes
  the existing bounded retry and reports manual cleanup if both attempts fail.

## [0.3.1] - 2026-07-19

This patch release is the OpenAI resubmission candidate that supersedes the
original `v0.3.0` plugin tree. Historical `v0.3.0` release artifacts remain
unchanged for audit and reproduction.

### Changed

- Re-attest the current top-level page through CDP after every approved Browser
  action, before pointer evidence, visual-tail handling, or the next sequential
  action may proceed.
- Propagate recording cancellation into FFprobe validation so a terminal
  recording no longer leaves an unbounded validator subprocess running.

### Fixed

- Prevent a delayed artifact validator from publishing a Saved Recording after
  the public recording session has already timed out or failed. Cancellation is
  now fenced across each durable-publication boundary and removes any exact
  partial or committed file created by the cancelled transaction.
- Close the action-boundary navigation race in which a same-origin action could
  redirect the fresh tab to a different origin and allow the next approved
  action to start before the asynchronous navigation event pump observed it.

## [0.3.0] - 2026-07-19

This is the finalized OpenAI resubmission candidate. The original GitHub
`v0.3.0` tag and archive were published on 2026-07-18; the README records that
archive's commit and digest separately from this later candidate.

### Added

- Added a user-visible, no-Browser local preflight that reports all detected
  platform, media-tool, codec, container, and destination blockers.

### Changed

- Replaced the skill-facing four-operation recording handle with the two-phase
  `prepareRecording()` and `recordApproved()` flow. Prepared plans are opaque,
  immutable, single-use, derive pointer policy from action modality, and return
  one `completed`, `failed`, or `cancelled` outcome.
- Restricted this release's recording support to Chrome and made explicit
  in-app Browser requests fail before consent with
  `browser_surface_unsupported`; runtime failure never triggers a silent
  surface switch.
- Added a no-output Chrome frame contract gate and moved the two-sequential-run
  full MP4 release gate onto the same production Recording Flow.
- Reworked installation guidance around the current Plugins Directory and local
  marketplace flows, removed the obsolete direct directory listing URL,
  documented Directory and local removal paths, added tag-specific archive
  checksum verification, and documented the explicit Chrome-only support
  boundary.
- Added architecture and troubleshooting guides grounded in the recording
  modules, stable failure taxonomy, and current official Codex documentation.
- Clarified browser-version-sensitive embedded-frame coverage and distinguished
  local recorder processing from the target page's normal network activity.
- Updated issue and pull-request guidance for the released plugin, user-relevant
  environment details, documentation-only contributions, and the
  release-candidate documentation gate.
- Centralized release-required public document paths and added regression tests
  for local Markdown links, anchors, synchronized release references, and the
  complete public failure-code catalog.
- Distinguished deterministic embedded-frame fixtures from real-browser
  compatibility evidence and expanded the release smoke checklist to cover both
  frame transport and two sequential full Chrome recordings.
- Action-driven recordings now finalize when approved actions and any bounded
  pointer visual tail finish while retaining a 15-second hard cap; passive flows
  require an explicit duration.
- Consent and public policies now disclose visible embedded frames and reuse of
  Chrome's existing session.
- Documented the fixed 720p, 10-frames-per-second verification profile and the
  manual real-browser release smoke test.
- Added synchronized public-version checks and a dedicated cursor-module
  coverage floor to release and CI verification.

### Fixed

- Encoded the JPEG delivered by each `Page.screencastFrame` event directly
  instead of issuing an additional `Page.captureScreenshot` request for every
  event. This removes the redundant CDP dependency that caused Chrome recordings
  to fail despite a healthy screencast transport.
- Kept ownership of the exact fresh tab until close succeeds, memoized concurrent
  close requests, bounded timeouts, and retried one immediate transient close
  rejection without losing primary failure metadata.
- Drained in-flight top-level navigation policy events during shutdown,
  recognized replacement main-frame IDs, and reverified the approved origin
  before successful publication.
- Wrote the first accepted frame to FFmpeg eagerly and kept a bounded 200 ms
  visual tail after action-driven pointer flows, preventing zero-sample media
  and missing final click feedback.

## [0.2.3] - 2026-07-18

### Changed

- Moved approved Browser action coordination into the Recording Session so the
  skill supplies only the concrete action and its pointer-evidence requirement;
  state checks, evidence timing, failure sanitation, cancellation, and
  no-publication cleanup now share the recording transaction boundary.
- Replaced caller-side lifecycle polling and public capture status with the
  Recording Session's passive `finished` promise while preserving `stop()` as
  the idempotent immediate-finalization command.

### Fixed

- Accepted valid recording timestamps created in Codex's Browser Node runtime
  instead of rejecting cross-realm `Date` values as invalid configuration.
- Closed the frame pump before stopping the CDP screencast so buffered frames
  cannot produce a late `frame_ack_failed` during normal finalization.

## [0.2.2] - 2026-07-16

### Fixed

- Aligned skills-only ZIP metadata with the submission portal by using the
  square plugin icon as the listing logo and removing unsupported screenshot
  configuration.

## [0.2.1] - 2026-07-16

### Changed

- Reframed the visible cursor guarantee around observable per-action evidence
  instead of claiming event provenance that the Browser runtime cannot prove.
- Replaced the private loopback submission case with a public, no-login W3C
  fixture and made reviewer expectations explicit.
- Made the release validator derive the release version from the manifest.

### Fixed

- Corrected the privacy disclosure for page-scripted synthetic pointer events.

## [0.2.0] - 2026-07-16

### Added

- Visible cursor recording for top-level and supported embedded-frame pointer
  actions using public-CDP isolated-world observation, a project-owned
  Codex-style cursor, and 200 ms click feedback.
- Fail-closed cursor coverage across dynamic frames, reloads, cross-origin
  frames, and Browser-managed out-of-process iframe targets.
- Per-action pointer evidence uses the captured event occurrence boundary, and
  any missing evidence aborts before finalization can publish media.

### Changed

- Successful recordings are now Saved Recordings in H.264 MP4 format under
  `~/Downloads/Codex Browser Recordings/` by default, with an explicit local
  destination override and privacy-safe filenames.
- Consolidated the artifact lifecycle behind one transaction that owns fixed
  validation, atomic durable publication, collision handling, result
  persistence, rollback, and idempotent cleanup.
- Consent and result reporting now show the destination, return a clickable
  Saved Recording, and offer—but never automatically perform—Open in Finder.

### Fixed

- A temporary Working Recording is no longer reported as a successful result.
- Durable publication failures retain a validated Working Recording for
  recovery and return a specific allowlisted remediation.
- Odd Browser viewport dimensions are normalized for H.264 encoding.
- Static pages now reuse their latest frame instead of being treated as a
  stalled stream, and recording readiness seeds the encoder from a fresh page
  screenshot instead of a transient compositor frame. Navigation policy is
  enforced before that screenshot and re-verified before the frame is accepted;
  later screencast frames trigger the same full-viewport capture instead of
  entering the encoder directly, and the frame timeout bounds a stalled
  screenshot request.
- Failed validation, publication partials, and concurrent rollback now follow
  deterministic cleanup and bounded recovery reporting.
- Normal stop no longer misclassifies an already in-flight final screenshot as
  a frame-stream failure.
- Cursor capture records Browser-dispatched input even when Codex in-app
  Browser exposes it with DOM `isTrusted: false`, drains buffered tail events,
  rejects unsupported perspective frame geometry, and owns a bounded, killable
  composition deadline so timed-out media cannot publish later.

## [0.1.0] - 2026-07-16

### Added

- Explicitly invoked recording of one approved, non-sensitive Browser test flow
  to a private local VP8 WebM file without audio.
- Same-origin enforcement, bounded capture, media validation, transactional
  local artifacts, and allowlisted diagnostics.
- Public plugin metadata, sanitized listing artwork, policies, community files,
  release checks, and submission evals.
