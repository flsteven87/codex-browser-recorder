# Privacy

Browser Recorder for Codex is designed to keep recordings on the user's local
machine. The project does not upload recordings or telemetry and does not include
an analytics service.

## Data processed

During an approved recording, the recorder processes JPEG screencast frames for
one selected in-app Browser page and encodes them into a local WebM file. A local
JSON result stores only bounded counters, validation metadata, a sanitized failure
code, and the recording filename.

The recorder is not designed to collect Codex UI, browser chrome, audio, cookies,
local storage, passwords, authorization headers, full URLs, raw page text, or raw
frames in diagnostics.

## User responsibilities

Obtain consent from everyone whose information may appear in a recording. Do not
record passwords, payment forms, passkeys, account-recovery secrets, health data,
or other sensitive flows. The user controls retention and deletion of local output.

Any future upload or sharing feature must be a separate, explicit action with its
own approval. It is not part of this proof of concept.
