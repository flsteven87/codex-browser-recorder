# Support

Browser Recorder for Codex `v0.3.1` has a deliberately narrow support boundary.
It supersedes the original 2026-07-18 GitHub `v0.3.0` plugin tree with the
runtime fixes prepared for OpenAI resubmission.

## Browser support

| Surface | Status | Behavior |
| --- | --- | --- |
| Chrome plugin and extension | Supported release target | Every candidate must pass the real Chrome contract and full MP4 smoke before submission. |
| Codex in-app Browser | Unsupported in this release | Preparation returns `browser_surface_unsupported` before consent or Browser activity. |

The recorder does not switch surfaces after a failure. Deterministic tests cover
cross-origin and out-of-process embedded frames, but they are not a claim of
real-browser OOPIF compatibility.

## Local preflight

Before filing an environment issue, invoke:

```text
$codex-browser-recorder:record-browser Check whether my local recording environment is ready.
```

A passing result begins with `Local recording preflight passed`. Otherwise,
include every returned stable blocker code and its remediation. This local check
does not open a Browser tab and does not verify Browser or CDP approval.

See [Troubleshooting](docs/troubleshooting.md) for installation checks, every
local preflight blocker, common recording failure groups, and safe recovery
steps.

## Non-sensitive bugs and questions

Use a [GitHub issue](https://github.com/flsteven87/codex-browser-recorder/issues/new/choose)
for a reproducible, non-sensitive bug or usage question. Include only the
affected commit or plugin version, operating-system version, Codex desktop app
version, Chrome and extension versions, redacted FFmpeg/FFprobe version
information, the
allowlisted status or failure code, and bounded capture counters when relevant.
Include the Node.js version only for repository development failures. A fully
public, synthetic, no-login fixture URL may be included when it is required for
reproduction; never include a private, authenticated, personalized, tokenized,
or signed URL.

Do not attach recordings, raw frames, Browser diagnostics, CDP payloads, private
or authenticated URLs, page content, credentials, tokens, private paths, or
personal data.

## Security reports

Report vulnerabilities through
[GitHub private vulnerability reporting](https://github.com/flsteven87/codex-browser-recorder/security/advisories/new).
Do not open a public issue for a vulnerability or sensitive recording content.

## Unsupported flows

Authenticated or sensitive flows, existing-tab capture, multiple tabs,
cross-origin top-level navigation, audio, non-loopback HTTP targets,
browser-profile inspection, the Codex in-app Browser, uploads, sharing,
alternate video formats, and remote storage are unsupported. Support requests
cannot make those flows safe or supported.
