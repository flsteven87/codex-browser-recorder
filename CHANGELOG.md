# Changelog

All notable changes to this project will be documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions
follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.0] - 2026-07-16

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
- Failed validation, publication partials, and concurrent rollback now follow
  deterministic cleanup and bounded recovery reporting.

## [0.1.0] - 2026-07-16

### Added

- Explicitly invoked recording of one approved, non-sensitive Browser test flow
  to a private local VP8 WebM file without audio.
- Same-origin enforcement, bounded capture, media validation, transactional
  local artifacts, and allowlisted diagnostics.
- Public plugin metadata, sanitized listing artwork, policies, community files,
  release checks, and submission evals.
