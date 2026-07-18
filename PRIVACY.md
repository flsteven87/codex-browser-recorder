# Privacy

Browser Recorder for Codex is designed for private, local recording of one
explicitly approved non-sensitive Chrome Browser test flow.

## Local processing

- Frames are processed by the local plugin Node runtime and local FFmpeg and
  are not placed in model context by the skill.
- The plugin does not automatically upload, share, retain remotely, or send
  telemetry.
- Local recorder processing does not make the target page offline. The page and
  its embedded content can still make their normal network requests while they
  load and run; use only a public, logged-out, non-sensitive fixture.
- The recording contains the complete visible page viewport, including all
  visible embedded frames. Browser chrome and other tabs are excluded.
- A fresh tab may reuse Chrome's existing session. The plugin does
  not inspect cookies or storage, but existing session state can affect rendered
  content. Use a logged-out Chrome profile without sensitive or personalized
  content.
- Raw frames, page text, full URLs, CDP payloads, subprocess output,
  credentials, and internal plugin paths are excluded from result JSON and
  skill diagnostics.
- Cursor capture uses temporary isolated-world listeners in the approved page
  and supported embedded frames. It observes only pointer event type,
  coordinates, button state, frame identity, viewport dimensions, sequence,
  page-event occurrence time, and recorder-relative time. Browser controls can
  expose pointer events with the same DOM trust flag as script-dispatched
  events, so page-scripted synthetic events may also be observed. The recorder
  uses occurrence time only to require new evidence after an approved action
  begins; it does not authenticate the source of an observed event or persist
  the occurrence time in result JSON. The plugin does not read event targets,
  selectors, form values, storage, credentials, or network traffic.

For a pointer flow, the bounded cursor timeline is held locally only long enough
to composite the project-owned cursor and click feedback. It is not written
beside the Saved Recording or returned in result JSON.

The local result contains only bounded counters, media validation metadata, an
output filename, and an allowlisted status or failure code with its fixed
summary and remediation. On success, the skill reports the Saved Recording
path after durable publication and private Working Recording cleanup.

## Retention and deletion

- The Saved Recording defaults to
  `~/Downloads/Codex Browser Recordings/browser-recording-<timestamp>.mp4` or
  an explicitly approved absolute local destination and cleaned custom name.
- Default filenames do not contain the page title, host, URL, or page text.
- The user controls how long the Saved Recording remains in that durable
  destination and must delete it when it is no longer needed.

The plugin does not automatically open, play, delete, upload, or share a Saved
Recording. Capture, cancellation, cross-origin, and validation failures do not
publish a Saved Recording; the transaction discards their Working Recording.
If that automatic cleanup fails, the plugin reports the local path for
deletion. If durable publication fails after validation, the plugin reports
the retained Working Recording recovery directory so the user can copy it to a
durable folder before cleanup. Other failure responses do not promise an
absolute output path.

## User responsibilities

Obtain informed consent from everyone whose information may appear. Do not
record passwords, payment data, passkeys, account-recovery secrets, health
data, confidential communications, or other sensitive authenticated flows.
Before consent, confirm that Chrome is logged out of the target
and that no visible top-level or embedded-frame content is sensitive or
personalized. The user is responsible for choosing an appropriate target,
limiting approved actions, protecting the local output, and deleting it when it
is no longer needed.

Any future upload or sharing feature must be a separate, explicit,
user-authorized action. It is not part of this plugin.
