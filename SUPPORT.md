# Support

Browser Recorder for Codex `v0.3.2` is a small, local-only tool for recording
one approved Chrome test flow. The fastest way to get help is to start with the
setup check, then choose the issue form that matches your question.

## Start with the setup check

Invoke:

```text
$codex-browser-recorder:record-browser Check whether this Mac is ready to record without opening Chrome.
```

A passing result begins with `Local recording preflight passed`. If it fails,
follow the next step shown beside each error code. This check does not open
Chrome and does not verify Browser or CDP approval; those permissions are
checked only when a recording starts.

For symptom-based help and a searchable error-code index, see
[Troubleshooting](docs/troubleshooting.md).

## Choose where to ask

| I need to… | Use |
| --- | --- |
| Ask how to use the tool | [Question form](https://github.com/flsteven87/codex-browser-recorder/issues/new?template=question.yml) |
| Report a reproducible problem | [Bug report](https://github.com/flsteven87/codex-browser-recorder/issues/new?template=bug_report.yml) |
| Suggest a focused improvement | [Feature request](https://github.com/flsteven87/codex-browser-recorder/issues/new?template=feature_request.yml) |
| Report a vulnerability | [Private vulnerability report](https://github.com/flsteven87/codex-browser-recorder/security/advisories/new) |

Do not open a public issue for a vulnerability or sensitive recording content.

## What to include

For a bug, share only:

- what you tried, what you expected, and what happened;
- the plugin version, macOS version, and Codex desktop version;
- the returned error code, such as `ffmpeg_missing`;
- Chrome, Chrome extension, and redacted FFmpeg versions when relevant; and
- minimal steps using a public, logged-out test page.

Do not attach a recording, screenshot of private content, raw frame, private or
authenticated URL, page content, credential, token, local private path, or
Browser/CDP diagnostic.

## Supported scope

This release supports Chrome on macOS. It records one fresh tab, one approved
site, local MP4 output, no audio, and no upload. The Codex in-app Browser is not
supported.

Authenticated or sensitive flows, existing-tab capture, multiple tabs,
cross-site top-level navigation, non-loopback HTTP pages, browser-profile
inspection, uploads, sharing, remote storage, and alternate video formats are
outside the supported scope.
