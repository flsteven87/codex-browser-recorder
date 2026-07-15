# Support

Browser Recorder for Codex is pre-release software with a deliberately narrow
support boundary.

## Non-sensitive bugs and questions

Use a [GitHub issue](https://github.com/flsteven87/codex-browser-recorder/issues/new/choose)
for a reproducible, non-sensitive bug or usage question. Include only the
affected commit or plugin version, operating-system and Node versions, redacted
FFmpeg/FFprobe version information, the allowlisted status or failure code, and
bounded counters from `result.json` when relevant.

Do not attach recordings, raw frames, Browser diagnostics, CDP payloads, full
URLs, page content, credentials, tokens, private paths, or personal data.

## Security reports

Report vulnerabilities through
[GitHub private vulnerability reporting](https://github.com/flsteven87/codex-browser-recorder/security/advisories/new).
Do not open a public issue for a vulnerability or sensitive recording content.

## Unsupported flows

Authenticated or sensitive flows, existing-tab capture, multiple tabs,
cross-origin recording, audio, non-loopback HTTP targets, browser-profile
inspection, uploads, and sharing are unsupported. Support requests cannot make
those flows safe or supported.
