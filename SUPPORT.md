# Support

Browser Recorder for Codex `v0.2.3` has a deliberately narrow support boundary.

## Local preflight

Before filing an environment issue, invoke:

```text
$record-browser Check whether my local recording environment is ready.
```

A passing result begins with `Local recording preflight passed`. Otherwise,
include every returned stable blocker code and its remediation. This local check
does not open a Browser tab and does not verify Browser or CDP approval.

## Non-sensitive bugs and questions

Use a [GitHub issue](https://github.com/flsteven87/codex-browser-recorder/issues/new/choose)
for a reproducible, non-sensitive bug or usage question. Include only the
affected commit or plugin version, operating-system and Node versions, redacted
FFmpeg/FFprobe version information, the allowlisted status or failure code, and
bounded capture counters when relevant. A fully public, synthetic, no-login
fixture URL may be included when it is required for reproduction; never include
a private, authenticated, personalized, tokenized, or signed URL.

Do not attach recordings, raw frames, Browser diagnostics, CDP payloads, private
or authenticated URLs, page content, credentials, tokens, private paths, or
personal data.

## Security reports

Report vulnerabilities through
[GitHub private vulnerability reporting](https://github.com/flsteven87/codex-browser-recorder/security/advisories/new).
Do not open a public issue for a vulnerability or sensitive recording content.

## Unsupported flows

Authenticated or sensitive flows, existing-tab capture, multiple tabs,
cross-origin recording, audio, non-loopback HTTP targets, browser-profile
inspection, uploads, sharing, alternate video formats, and remote storage are
unsupported. Support requests cannot make those flows safe or supported.
