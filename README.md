# Browser Recorder for Codex

Browser Recorder is an experimental, community-developed Codex plugin that
records one explicitly approved test flow in a fresh Codex in-app Browser tab
to a private local WebM file. The recording contains the page viewport only,
uses VP8 video with no audio, and stays on the local machine.

The plugin reuses the installed Browser plugin's permission-gated CDP session.
It does not record Codex UI, browser chrome, other tabs, or an entire browser
profile, and it does not add an upload or sharing path.

## Status

This repository implements the public recording runtime and its automated
acceptance gate. It remains pre-release software: the canonical `v0.1.0` tag,
public listing materials, submission evals, and final installed-desktop release
gate belong to a separate release-readiness plan. Do not treat the current
cachebuster manifest version or mutable `main` branch as a general
production-ready release.

Authenticated or sensitive flows remain out of scope. Use the plugin only for
non-sensitive test pages and actions that every affected person has agreed may
be recorded.

## Supported Targets

The first release accepts:

- `https:` URLs without embedded usernames or passwords;
- explicitly approved loopback development URLs using `http:` with
  `localhost`, `127.0.0.1`, or `[::1]`;
- one fresh Browser tab, one normalized approved origin, and only the Browser
  actions listed in the user's consent;
- durations from 5 through 60 seconds, with 15 seconds as the default.

Existing tabs, multiple tabs, non-loopback `http:` targets, URL credentials,
audio, authenticated or sensitive flows, and cross-origin recording are not
supported.

## Requirements

- macOS with the Codex desktop app
- The Codex Browser plugin installed and available
- A Browser runtime capable of importing the plugin's bundled Node modules
- Browser Developer mode with full CDP access already enabled by the user
- `ffmpeg` and `ffprobe` on `PATH`, including the `libvpx` VP8 encoder, WebM
  muxer, and usable FFprobe JSON output

The recorder runs a read-only environment check before capture. It does not
enable Developer mode, change policy, install packages, or bypass normal site
or full-CDP approval. Node.js 24 or newer is required only for repository
development and verification.

## Pinned Release and Local Installation

A reproducible public installation must use the canonical `v0.1.0` tag once
that release exists. That tag is not created by this runtime task, so the
current mutable repository is suitable for local development and review only.
Do not copy files into the Codex plugin cache or edit cache contents by hand.

For local development, add the repository root as a local marketplace and
install the plugin:

```sh
codex plugin marketplace add /absolute/path/to/codex-browser-recorder
codex plugin add codex-browser-recorder@codex-browser-recorder
```

After the separate release process publishes `v0.1.0`, a pinned installation
can use a checkout of that exact tag as the local marketplace source:

```sh
git clone --branch v0.1.0 --depth 1 https://github.com/flsteven87/codex-browser-recorder.git
codex plugin marketplace add /absolute/path/to/codex-browser-recorder
codex plugin add codex-browser-recorder@codex-browser-recorder
```

Start a new Codex task after installation so Codex discovers the skill. If a
new task in the same app session does not list the installed or upgraded skill,
restart Codex and create another task.

## Use `$record-browser`

Explicitly invoke `$record-browser` and provide:

- the target URL;
- the Browser actions to perform; and
- an optional recording duration.

Mentioning `$record-browser` selects the workflow but does not approve an
unknown target or scope. The skill validates the request locally before any
Browser activity, creates one fresh blank tab only after consent, performs only
the approved actions, finalizes the recording, closes the fresh tab on every
path, and reports either the local result or an allowlisted failure.

Approval denial returns `cancelled`. The plugin never retries or bypasses a
denied site or CDP approval.

## Consolidated Consent

Before creating or navigating a Browser tab, the skill presents one
consolidated consent request containing the normalized approved origin, planned
actions, duration, private temporary output, no audio, no browser chrome, no
other tabs, and the sensitive-data exclusion. Recording begins only after the
user explicitly confirms that complete scope.

Credentials, payment data, passkeys, account-recovery secrets, health data,
confidential communications, and other sensitive authenticated flows must be
refused.

## Same-Origin Navigation Policy

Consent is locked to one normalized origin. Same-origin path, query, fragment,
redirect, and single-page-application state changes may remain recordable when
they are part of the approved actions.

A cross-origin top-frame navigation stops the session, discards the entire
recording, and returns `origin_changed_during_recording`. The skill does not
broaden the approved origin during a run.

## Output and Deletion

Each run uses a unique private directory with mode `0700` under the operating
system's temporary root. A successful run contains:

- `recording.webm`, atomically published only after encoder finalization and
  media validation; and
- `result.json`, written with mode `0600` and containing schema-v3 bounded
  counters, validation metadata, an output filename, and allowlisted status or
  failure information.

The video is a validated VP8 WebM with no audio. Capture, cancellation, and
cross-origin failures discard working media. A result-persistence failure rolls
back finalized media. A validation-rejected finalized WebM may remain in the
private operating-system temporary directory. The failure response does not
promise an absolute output path. The user must delete that recording directory.
Result data excludes raw frames, CDP payloads, FFmpeg output, full URLs, page
text, credentials, and internal plugin paths.

Successful output remains in its private temporary directory until the user
deletes or moves it. The plugin does not upload, share, copy, or move the file.
The user is responsible for deleting temporary output when it is no longer
needed.

## Architecture

```mermaid
flowchart LR
    U["Explicit $record-browser invocation"] --> P["Local request policy"]
    P --> C["One consolidated consent"]
    C --> B["One fresh approved Browser tab"]
    B --> R["Public createRecording coordinator"]
    R --> O["Continuous approved-origin enforcement"]
    O --> F["Bounded frame pump and local FFmpeg"]
    F --> V["WebM and VP8 validation"]
    V --> A["Transactional private artifacts"]
```

The skills-only plugin runs inside the same persistent Browser Node runtime
that owns the tab binding. `createRecording()` is the production coordinator;
its public handle exposes only `ready`, `status()`, and idempotent `stop()`.
The runtime reacquires the current CDP capability, continuously checks
top-frame navigation against the approved origin, enforces bounded resources,
and releases its singleton reservation on every terminal path.

## Development Verification

The repository has no npm runtime dependencies and requires no development
server. Tests use local FFmpeg and FFprobe processes but do not access a browser
profile or write recording artifacts into the repository.

```sh
npm run check
npm run test:coverage
npm run test:plugin-install
```

`npm run test:plugin-install` requires the `codex` CLI. It isolates both `HOME`
and `CODEX_HOME`, installs from a copied marketplace, removes the source copy,
imports the coordinator from the isolated installed cache, and deletes the
fixture afterward.

Repository maintainers can run the official metadata validators from the
installed Codex system skills without adding a project dependency:

```sh
uv run --no-project --with pyyaml python /path/to/plugin-creator/scripts/validate_plugin.py plugins/codex-browser-recorder
uv run --no-project --with pyyaml python /path/to/skill-creator/scripts/quick_validate.py plugins/codex-browser-recorder/skills/record-browser
```

## Internal Release Gate

The fixed example scenario is repository-only release tooling, not a public
plugin mode or starter prompt. It exercises the same production
`createRecording()` entry point with deterministic disposable actions. The
separate release-readiness process must execute its installed-desktop scenario
twice sequentially and record only sanitized evidence before a public release.

Users do not need this internal example scenario to record an approved test
flow.

## Update or Uninstall

For a local marketplace checkout, update that checkout to the intended pinned
revision, then reinstall the plugin in a new Codex task:

```sh
codex plugin remove codex-browser-recorder@codex-browser-recorder
codex plugin add codex-browser-recorder@codex-browser-recorder
```

To uninstall both the plugin and its marketplace source:

```sh
codex plugin remove codex-browser-recorder@codex-browser-recorder
codex plugin marketplace remove codex-browser-recorder
```

## Privacy and Security

Frames are processed by the local Browser Node runtime and local FFmpeg; the
skill does not place them in model context. The plugin sends no telemetry and
does not automatically upload, share, or retain recordings remotely. See
[PRIVACY.md](PRIVACY.md) for retention and deletion responsibilities.

Record only non-sensitive test flows with the informed consent of everyone
whose data may appear. See [SECURITY.md](SECURITY.md) and report security issues
through [GitHub private vulnerability reporting](https://github.com/flsteven87/codex-browser-recorder/security/advisories/new),
not a public issue.

## Record & Replay

Browser Recorder and Codex Record & Replay solve different problems. This
plugin captures the visible page flow as a local WebM for review; it does not
turn the demonstrated actions into an automation or reusable skill. Record &
Replay turns a demonstrated workflow into a reusable Codex skill rather than a
video artifact.

<details>
<summary>Development history and historical evidence</summary>

- [Project design](docs/superpowers/specs/2026-07-15-codex-browser-recorder-design.md)
- [Phase 0 execution evidence](docs/superpowers/plans/2026-07-15-phase-0-browser-screencast-poc.md)
- [Phase 1 integration design](docs/superpowers/specs/2026-07-15-phase-1-plugin-integration-gate-design.md)
- [Phase 1 implementation plan](docs/superpowers/plans/2026-07-15-phase-1-plugin-integration-gate.md)
- [Public runtime product design](docs/superpowers/specs/2026-07-15-public-browser-recorder-product-design.md)

</details>

## License

[MIT](LICENSE)
