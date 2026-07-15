# Browser Recorder for Codex

An experimental, community-developed proof of concept for recording the page
content of one Codex in-app Browser tab through its approved CDP capability.
Recordings stay local by default and do not include Codex UI, browser chrome,
audio, cookies, storage, or request headers.

## Project status

Phase 0 feasibility is **Go** on the tested macOS Codex desktop environment:
visible capture, two-minute hidden capture, interaction fidelity, and FFmpeg
finalization all passed. This repository is still a hardened proof of concept,
not an installable production plugin.

The design and measured gate evidence live in:

- [`docs/superpowers/specs/2026-07-15-codex-browser-recorder-design.md`](docs/superpowers/specs/2026-07-15-codex-browser-recorder-design.md)
- [`docs/superpowers/plans/2026-07-15-phase-0-browser-screencast-poc.md`](docs/superpowers/plans/2026-07-15-phase-0-browser-screencast-poc.md)

## Requirements

- macOS with the Codex desktop app
- Node.js 24 or newer
- `ffmpeg` and `ffprobe` on `PATH`
- Browser Developer mode with full CDP access enabled
- Explicit approval for the selected site and CDP session

## Local validation

```sh
npm run check
npm run test:coverage
```

The test suite uses real local FFmpeg/FFprobe processes for integration coverage.
It does not start a server, install dependencies, access a browser profile, or
write recordings into the repository.

## Architecture boundary

The recorder must run in the same persistent JavaScript runtime as the in-app
Browser tab binding. Call `startBrowserPocForTab` or `runBrowserPocGate` only
after navigation is complete; each call reacquires the tab's current `cdp`
capability so a stale pre-navigation binding is never reused.

The harness applies bounded frame payloads, acknowledged CDP frames, FFmpeg
backpressure, cancellation, duration and output-size limits, optional fresh-frame
stall detection, bounded encoder shutdown, atomic output publication, and
sanitized result persistence.

## Privacy and security

Only record non-sensitive flows with the user's explicit consent. Do not record
passwords, payment details, passkeys, recovery secrets, or other confidential
content. See [PRIVACY.md](PRIVACY.md) and [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE)
