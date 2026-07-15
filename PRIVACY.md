# Privacy

Browser Recorder for Codex is designed for private, local recording of one
explicitly approved non-sensitive Browser test flow.

## Local processing

- Frames are processed by the local Browser Node runtime and local FFmpeg and
  are not placed in model context by the skill.
- The plugin does not automatically upload, share, retain remotely, or send
  telemetry.
- Raw frames, page text, full URLs, CDP payloads, subprocess output,
  credentials, and internal plugin paths are excluded from result JSON and
  skill diagnostics.

The local result contains only bounded counters, media validation metadata, an
output filename, and an allowlisted status or failure code with its fixed
summary and remediation. On success, the skill may report the local video path
to the user after cleanup completes.

## Retention and deletion

- Output remains in a private operating-system temporary directory until the
  user deletes or moves it.
- The user must delete temporary output when it is no longer needed.

The plugin does not automatically copy, move, delete, upload, or share a
successful recording. Failed and cancelled recording transactions remove video
output; a sanitized local result may remain when an artifact directory was
created.

## User responsibilities

Obtain informed consent from everyone whose information may appear. Do not
record passwords, payment data, passkeys, account-recovery secrets, health
data, confidential communications, or other sensitive authenticated flows.
The user is responsible for choosing an appropriate target, limiting approved
actions, protecting the local output, and deleting it when it is no longer
needed.

Any future upload or sharing feature must be a separate, explicit,
user-authorized action. It is not part of this plugin.
