# Support

Browser Recorder for Codex `v0.4.0` is a small, local-only tool for recording
one approved Codex In-app Browser test flow. The fastest way to get help is to
start with the setup check, then choose the issue form that matches your
question.

## Start with the setup check

Invoke:

```text
$codex-browser-recorder:record-browser Check whether this recording setup is ready.
```

A passing result begins with `Local recording preflight passed`. If it fails,
follow the next step shown beside each error code. A passing result states that
the local media toolchain, destination, Codex In-app Browser, and full CDP access
checks passed. The check may briefly open one fresh diagnostic tab that it owns
and closes; it does not create a recording or upload an artifact.

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
- Browser plugin and redacted FFmpeg versions when relevant; and
- minimal steps using a public synthetic test page.

Do not attach a recording, screenshot of private content, raw frame, private or
authenticated URL, page content, credential, token, local private path, or
Browser/CDP diagnostic.

## Supported scope

This release supports the Codex In-app Browser on macOS. It records one fresh
tab, one approved site, local MP4 output, no audio, and no upload. Chrome is not
a fallback Recording Surface. Before Browser activity, its non-blocking Content
Warning discloses that the full viewport may contain private, authenticated, or
sensitive content and leaves authorization and local-file handling to the user.

Existing-tab capture, multiple tabs, cross-site top-level navigation,
non-loopback HTTP pages, browser-profile inspection, uploads, sharing, remote
storage, and alternate video formats are outside the supported scope.
