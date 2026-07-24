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

## What stays local

- Frames are processed by local Node.js and FFmpeg processes, not placed in
  model context.
- The plugin does not upload recordings, share them, retain them remotely, or
  send telemetry.
- The target page and its embedded content may continue their normal network
  activity during recording.

## What can appear

- The complete visible page viewport is recorded.
- It includes all visible embedded frames. Browser controls and other tabs are
  excluded.
- Each run opens a fresh tab, but the Codex In-app Browser session may reuse
  existing cookies, storage, and authenticated state.
- The plugin does not inspect or copy cookies or storage.
- Existing session state can affect rendered content.
- Browser Recorder does not classify page content, redact visible fields, or
  refuse a recording based on authentication, privacy, or sensitivity.

## Cursor and result data

- Cursor capture observes only pointer type, coordinates, button state, frame
  identity, viewport dimensions, sequence, and timing.
- Page-scripted synthetic events may also be observed.
- The recorder does not authenticate the source of an observed event.
- Cursor capture does not read event targets, selectors, form values, storage,
  credentials, or network traffic.
- The bounded cursor timeline is discarded after rendering. It is not saved
  beside the video or returned in result data.
- Results contain bounded counters, media validation facts, a filename, and an
  allowlisted status or failure code. A successful result includes the saved
  local path.
- Raw frames, page text, full URLs, CDP payloads, subprocess output,
  credentials, and internal plugin paths are excluded from result data and
  diagnostics. Visible content may still appear in the video.

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

Uploading and sharing are outside this plugin.
