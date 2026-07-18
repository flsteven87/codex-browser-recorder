# Browser Recorder for Codex

Browser Recorder is an experimental, community-developed Codex plugin that
records one explicitly approved test flow in a fresh tab in the browser selected
by the installed Browser plugin. It saves a local H.264 MP4 with a visible
cursor and no audio to `~/Downloads/Codex Browser Recordings/` by default.

The plugin reuses the Browser plugin's permission-gated CDP session. It does not
record Codex UI, browser chrome, other tabs, or an entire browser profile, and it
does not add upload, sharing, or telemetry.

The fresh tab may reuse the selected Browser's existing session. The recording
contains the complete page viewport, including all visible embedded frames, so
use a logged-out Browser context with no sensitive or personalized content.

Authenticated or sensitive flows are out of scope. Record only non-sensitive
test pages and actions that every affected person has agreed may be recorded.

## Requirements and Scope

- macOS with the Codex desktop app
- The Codex Browser plugin installed and available
- Browser Developer mode with full CDP access already enabled by the user
- `ffmpeg` and `ffprobe` on `PATH`, including `libx264` and MP4 support
- `https:` targets without URL credentials, or explicit loopback development
  targets using `http:` with `localhost`, `127.0.0.1`, or `[::1]`
- One fresh tab and one approved top-level origin
- An optional explicit duration from 5 to 60 seconds; action-driven recordings
  stop when their approved actions finish, with a 15-second hard session cap
  when duration is omitted

On a Homebrew-managed Mac, `brew install ffmpeg` installs both required media
tools. Other package sources are supported when `ffmpeg` and `ffprobe` resolve
on `PATH` with the required capabilities.

Supported embedded frames include cross-origin and out-of-process iframes that
are observable through public CDP. Existing tabs, multiple tabs, non-loopback
`http:`, URL credentials, audio, authenticated or sensitive flows, and
cross-origin top-frame navigation are unsupported.

The recorder runs a read-only environment check. It does not enable Developer
mode, install packages, change policy, or bypass site or CDP approval. Node.js
24 or newer is required only for repository development and verification.

## Install

The published listing is available in the
[OpenAI directory](https://chatgpt.com/plugins/plugins_6a58f693814c8191b576ffaed4af2e78).
The directory may require sign-in and can lag the latest GitHub release.

For local development, add the repository as a marketplace and install the
plugin:

```sh
codex plugin marketplace add /absolute/path/to/codex-browser-recorder
codex plugin add codex-browser-recorder@codex-browser-recorder
```

For a reproducible installation, use an immutable release tag rather than the
mutable `main` branch:

```sh
git clone --branch v0.3.0 --depth 1 https://github.com/flsteven87/codex-browser-recorder.git
codex plugin marketplace add /absolute/path/to/codex-browser-recorder
codex plugin add codex-browser-recorder@codex-browser-recorder
```

Start a new Codex task after installation. If the skill does not appear, restart
Codex and create another task. Do not copy files into the plugin cache or edit
cache contents by hand.

## Quick Start

First, check the local dependencies and planned output location without opening
a Browser tab:

```text
$record-browser Check whether my local recording environment is ready.
```

A successful report starts with `Local recording preflight passed`. The check
reports all detected local blockers, including unsupported platform, missing
FFmpeg or FFprobe, missing H.264 or MP4 support, and an unavailable destination.
It is read-only apart from bounded media-tool subprocesses and does not verify
Browser or CDP approval.

Then request one concrete public, logged-out flow:

```text
$record-browser Open https://www.w3.org/TR/pointerevents/, click the 1. Introduction link in the table of contents, and save the approved flow as pointer-events-intro.
```

The skill shows one consent checklist before Browser activity. With no explicit
recording duration, it stops and finalizes as soon as the approved actions
finish; 15 seconds remains the hard session cap. Passive or wait-only recordings
require an explicit duration.

## Record a Flow

Explicitly invoke `$record-browser` and provide:

- the target URL;
- the Browser actions to perform;
- an optional recording duration, absolute destination folder, and recording
  name.

Mentioning the skill does not approve an unknown target or scope. Before any
Browser activity, it validates the request and presents one consolidated consent
request containing the approved origin, actions, duration, destination,
filename, H.264 MP4 with no audio, visible cursor and click feedback, and the
sensitive-data exclusion. It also discloses that all visible embedded frames are
captured and that the fresh tab may reuse the selected Browser's existing
session.

After consent, the skill creates one fresh tab in the browser selected by the
installed Browser plugin. It performs only approved actions and attempts to close the fresh tab
on every path; it reports bounded manual cleanup instructions if closure fails.
Approval denial returns `cancelled`; the plugin never retries or bypasses it.

Consent remains locked to one normalized origin. Approved same-origin path,
query, fragment, redirect, and single-page-application changes may continue. A
cross-origin top-frame navigation stops the Recording Session and discards its
media.

Credentials, payment data, passkeys, account-recovery secrets, health data,
confidential communications, and other sensitive authenticated flows must be
refused.

## Recording Lifecycle and Output

- A **Recording Session** is one authorized attempt in one approved fresh tab.
- A **Working Recording** is private temporary media that has not been validated
  or delivered.
- A **Saved Recording** is validated media atomically published to the approved
  durable destination.
- A pointer-driven Recording requires a new observed page pointer event after
  each planned pointer action begins; missing evidence fails closed.

This evidence proves observation coverage, not event provenance. Browser
controls and page scripts can both generate observed events, which may appear in
the visible-cursor timeline.

Working Recording directories use mode `0700`. Saved Recordings use mode `0600`
and default to a privacy-safe filename such as
`browser-recording-YYYY-MM-DD-HHmmss.mp4`. Filenames never derive from page
titles, hosts, URLs, or page text, and collisions never overwrite existing
files.

A successful output is a compatibility-oriented verification recording capped
at 720p and encoded at 10 frames per second. It contains one H.264 `yuv420p`
video stream in an MP4 container with no audio. Cursor observation, coordinate
mapping, composition, validation, and durable publication must all succeed
before the result is reported as `Recording completed`. This fixed profile is
intended for concise test evidence, not high-motion product demos.

Capture, cancellation, cross-origin, and validation failures do not publish a
Saved Recording; the transaction discards their Working Recording. If that
automatic cleanup fails, the plugin reports the local path for deletion. If
durable publication fails after validation, the plugin reports
`saved_recording_persistence_failed` and a retained Working Recording recovery
directory so the user can copy it to a durable folder before cleanup. Temporary
output is never reported as a successful result.

The private result contains bounded counters, validation metadata, an output
filename, and an allowlisted status or failure code. It excludes raw frames,
CDP payloads, FFmpeg output, full URLs, page text, credentials, and internal
plugin paths. The plugin does not automatically open, play, upload, share, or
delete a Saved Recording.

## Architecture

`$record-browser` owns request collection, local validation, explicit consent,
Browser selection, concrete approved actions, and user-facing reporting. It
delegates the recording transaction and per-action evidence boundary to
`createRecording()`: destination preflight, fresh-tab capture, continuous origin
enforcement, cursor composition, media validation, durable publication, and
cleanup. Its public handle exposes `ready`, `runAction()`, passive `finished`,
and idempotent `stop()`.

## Development

The repository has no npm runtime dependencies and requires no development
server. Tests use local FFmpeg and FFprobe processes without accessing a browser
profile or writing recording artifacts into the repository.

```sh
npm run check
npm run test:coverage
npm run test:coverage:cursor
npm run test:plugin-install
npm run check:release-candidate
```

These commands validate syntax, deterministic contracts, media fixtures,
coverage, plugin installation, metadata, and release structure. They do not
open the Browser plugin and are not a real Browser end-to-end test. The isolated
installation test requires the `codex` CLI.

Before release, a maintainer must also run the documented manual smoke flow in
the supported Codex desktop Browser environment against a public, logged-out
fixture and verify the Saved Recording. Do not commit or attach that recording.
Contribution and release requirements are documented in
[CONTRIBUTING.md](CONTRIBUTING.md) and [CHANGELOG.md](CHANGELOG.md).

## Update or Uninstall

To reinstall from an updated marketplace checkout:

```sh
codex plugin remove codex-browser-recorder@codex-browser-recorder
codex plugin add codex-browser-recorder@codex-browser-recorder
```

To uninstall the plugin and marketplace:

```sh
codex plugin remove codex-browser-recorder@codex-browser-recorder
codex plugin marketplace remove codex-browser-recorder
```

## Privacy, Security, and Support

Frames are processed by the local Browser Node runtime and local FFmpeg; the
skill does not place them in model context. The user controls retention and
must delete recordings when they are no longer needed.

See [PRIVACY.md](PRIVACY.md), [SECURITY.md](SECURITY.md), [TERMS.md](TERMS.md),
[SUPPORT.md](SUPPORT.md), and [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md). Report
security issues through [GitHub private vulnerability
reporting](https://github.com/flsteven87/codex-browser-recorder/security/advisories/new),
not a public issue.

## Record & Replay

Browser Recorder saves the visible page flow as a local video artifact. Codex
Record & Replay instead turns a demonstrated workflow into a reusable skill.

## License

[MIT](LICENSE)
