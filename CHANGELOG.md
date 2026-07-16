# Changelog

All notable changes to this project will be documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions
follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.0] - 2026-07-16

### Added

- Cursor-complete recording for top-level and supported embedded-frame pointer
  actions using public-CDP isolated-world observation, a project-owned
  Codex-style cursor, and 200 ms click feedback.
- Fail-closed cursor coverage across dynamic frames, reloads, cross-origin
  frames, and Browser-managed out-of-process iframe targets.
- Per-action pointer evidence uses the trusted event occurrence boundary, and
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
- Cursor capture ignores page-scripted synthetic input, drains buffered tail
  events, rejects unsupported perspective frame geometry, and owns a bounded,
  killable composition deadline so timed-out media cannot publish later.

## [0.1.0] - 2026-07-16

### Added

- Explicitly invoked recording of one approved, non-sensitive Browser test flow
  to a private local VP8 WebM file without audio.
- Same-origin enforcement, bounded capture, media validation, transactional
  local artifacts, and allowlisted diagnostics.
- Public plugin metadata, sanitized listing artwork, policies, community files,
  release checks, and submission evals.
