# Privacy

Browser Recorder for Codex is designed for private, local recording of one
explicitly approved Codex In-app Browser flow.

> **Content Warning:** The complete approved page viewport may include private
> or authenticated data and other sensitive content. Continue only if you are
> authorized to record it and will handle the local recording appropriately.

## At a glance

| Question | Answer |
| --- | --- |
| What is recorded? | One approved Codex In-app Browser tab's visible page area, including visible embedded frames. Browser controls, other tabs, and audio are excluded. |
| Where is the video saved? | A local folder you approve; the default is `~/Downloads/Codex Browser Recordings/`. |
| Is anything uploaded? | No. The plugin has no upload, sharing, remote-retention, or telemetry feature. |
| Can my Browser session affect the video? | Yes. The fresh recording tab may reuse the active Codex In-app Browser session, so authenticated or personalized content can appear. |
| Who decides whether recording is appropriate? | You must be authorized to record everything that may appear and are responsible for downstream handling of the local file. |
| How do I delete a video? | Delete the local MP4 when you no longer need it. The plugin does not delete saved videos automatically. |

## Local processing

- Frames are processed by the local plugin Node runtime and local FFmpeg and
  are not placed in model context by the skill.
- The plugin does not automatically upload, share, retain remotely, or send
  telemetry.
- Local recorder processing does not make the target page offline. The page and
  its embedded content can still make their normal network requests while they
  load and run.
- The recording contains the complete visible page viewport, including all
  visible embedded frames. Browser chrome and other tabs are excluded.
- A fresh tab may reuse the Codex In-app Browser's existing session. The plugin does
  not inspect cookies or storage, but existing session state can affect rendered
  content, including authenticated or personalized content.
- Browser Recorder does not classify page content, redact visible fields, or
  refuse a technically valid recording based on authentication, privacy, or
  sensitivity.
- Raw frames, page text, full URLs, CDP payloads, subprocess output,
  credentials, and internal plugin paths are excluded from result JSON and
  skill diagnostics. These diagnostic exclusions do not remove anything from
  the video: visible content may be recorded.
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

Obtain informed consent from everyone whose information may appear and confirm
that you are authorized to record the complete top-level and embedded-frame
viewport. Browser Recorder does not determine whether visible private,
authenticated, or sensitive content may lawfully or appropriately be recorded.
The user is responsible for choosing the target, limiting approved actions,
handling and sharing the local output appropriately, and deleting it when it is
no longer needed.

Any future upload or sharing feature must be a separate, explicit,
user-authorized action. It is not part of this plugin.
