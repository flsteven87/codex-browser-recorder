---
name: record-browser
description: Use when the user explicitly requests recording one approved Codex Browser tab to a local WebM file.
---

# Record Browser

Record only the page content of one explicitly approved Codex Browser tab.

This initial integration boundary requires the installed Browser plugin, macOS,
Node.js 24 or newer, and `ffmpeg` plus `ffprobe` on `PATH`. Use the canonical
modules in `scripts/`; never import recorder code from the source repository or
a hard-coded plugin cache path.

Do not record audio, browser chrome, Codex UI, credentials, cookies, storage,
request headers, or any tab outside the user's approved scope. Stop and clean up
on cancellation or error.
