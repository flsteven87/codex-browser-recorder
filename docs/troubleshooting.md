# Troubleshooting

## Start here

| What you see | First thing to try |
| --- | --- |
| Recording does not start | Run the setup check below. Then confirm the Codex In-app Browser is available. |
| Recording stops partway through | Stay on the approved website and search this page for the error code you received. |
| No video appears in the chosen folder | Check whether macOS allowed folder access. Search for `saved_recording_unavailable` or `saved_recording_persistence_failed`. |
| The record skill is missing | Follow [Installation and discovery](#installation-and-discovery), then start a new Codex task. |

Run the built-in setup check:

```text
$codex-browser-recorder:record-browser Check whether this recording setup is ready.
```

A passing result begins with `Local recording preflight passed`. It checks the
Mac, FFmpeg, destination folder, Codex In-app Browser, and full CDP access. It
may briefly open one fresh diagnostic tab, which it closes after the bounded
probe. It does not create a video, raw frame dump, or upload.

## Installation and discovery

If `$codex-browser-recorder:record-browser` is missing:

1. In the ChatGPT desktop app, select Codex and open **Plugins**.
2. Confirm that **Codex Browser Recorder** and **Browser** are installed.
3. For a local checkout, confirm that its marketplace appears in
   `codex plugin marketplace list` and points to the expected root.
4. Start a new task. Installed plugins are loaded into new tasks, not retrofitted
   into an existing one.
5. If it is still missing, restart the desktop app and create another task.

Do not edit plugin cache files or copy source files into the cache. Refresh or
reinstall from the marketplace source instead.

## Setup-check errors

| Code | Meaning | What to do |
| --- | --- | --- |
| `unsupported_platform` | Recording is currently limited to macOS. | Run it in the supported Codex desktop environment on macOS. |
| `ffmpeg_missing` | `ffmpeg` was not found on `PATH`. | Install FFmpeg and ensure the Codex desktop runtime can resolve it. Homebrew users can run `brew install ffmpeg`. |
| `ffmpeg_h264_unavailable` | FFmpeg does not expose the required `libx264` encoder. | Install an FFmpeg build that includes `libx264`. |
| `ffmpeg_mp4_unavailable` | FFmpeg does not expose the required MP4 muxer. | Install an FFmpeg build with MP4 support. |
| `ffprobe_missing` | `ffprobe` was not found on `PATH`. | Install the complete FFmpeg toolset and verify `ffprobe` resolves. |
| `ffprobe_unusable` | `ffprobe` cannot produce the JSON metadata the validator needs. | Replace or repair the FFmpeg installation, then rerun preflight. |
| `output_directory_not_writable` | The planned destination or its nearest existing parent is not writable. | Choose another absolute local directory or approve macOS file access. |
| `browser_plugin_unavailable` | The Codex In-app Browser or its fresh-tab API is unavailable. | Confirm that the Browser plugin is available in this Codex task, then rerun the setup check. |
| `cdp_unavailable` | The fresh diagnostic tab does not expose the required full CDP capability. | Enable **Developer mode > Enable full CDP access** in Codex Browser settings, then rerun the setup check. |
| `setup_cancelled` | The setup check was cancelled before it completed. | Run the setup check again when ready. |
| `setup_timeout` | A bounded Codex In-app Browser readiness operation did not finish in time. | Keep Codex open, confirm the Codex In-app Browser is responsive, and rerun the setup check. |
| `browser_tab_cleanup_failed` | The owned fresh diagnostic tab could not be verified as closed. | Close the fresh setup diagnostic tab manually, then rerun the setup check. |

The setup check reports every problem it finds. Resolve all of them before
retrying a recording.

## Codex In-app Browser does not connect

`browser_plugin_unavailable`, `cdp_unavailable`, and
`plugin_module_unavailable` mean the required Codex In-app Browser recording
capability could not be loaded or approved.

1. Confirm that the **Browser** plugin is available in the current Codex task.
2. [Open Browser settings](codex://settings/browser-use), then enable
   **Developer mode > Enable full CDP access**. If the link does not open, use
   **Settings > Browser**. Workspace policy can prevent this setting from being
   enabled.
3. Start a new task after changing plugin installation state.
4. Retry against a public, logged-out page and approve the requested site and
   full-CDP scope.

Approval denial returns `cancelled`; cancellation after a Recording Session has
started can return `recording_cancelled`. The recorder does not retry or bypass
either result.

## The request is not supported

`invalid_target`, `target_credentials_present`, `target_scheme_not_allowed`, or
`invalid_duration` means the request is outside the supported contract. Use:

- an `https:` URL without embedded username or password; or
- an `http:` loopback URL on `localhost`, `127.0.0.1`, or `[::1]`; and
- a duration from 5 to 60 seconds when a duration is explicit.

Passive or wait-only recording needs an explicit duration. Action-driven
recording can omit it and will finish after the last approved action, with a
15-second session cap.

## Recording stopped

Use the short code shown in the result to find the matching row. Every public
code appears here so it remains searchable. Some low-level failures may be
reported as their group code; for example, `frame_too_large` and
`invalid_frame` can appear as `capture_failed`.

| Failure group | Recognized public codes | What to do |
| --- | --- | --- |
| Browser visibility unavailable | `browser_visibility_unavailable` | Keep Codex open, make sure the Codex In-app Browser can be displayed, and retry. |
| Origin changed | `origin_not_allowed`, `origin_verification_failed`, `origin_changed_during_recording` | Start again and keep top-level navigation within the approved origin. |
| Frame stream failed | `event_stream_invalid`, `frame_ack_failed`, `frame_stream_stalled`, `frame_stream_unavailable`, `frame_too_large`, `invalid_frame` | Confirm full CDP approval in the Codex In-app Browser and retry a shorter flow. |
| Pointer evidence failed | `cursor_recording_failed` | Make each pointer action clear, then retry the flow. |
| Safety limit reached | `recording_duration_limit`, `recording_output_limit`, `output_monitor_failed` | Shorten the flow or reduce visual activity. |
| Encoder failed | `encoder_failed`, `encoder_finalize_failed`, `encoder_shutdown_timeout` | Rerun preflight and verify local H.264 MP4 support. |
| Media validation failed | `audio_stream_present`, `codec_invalid`, `container_invalid`, `dimensions_out_of_bounds`, `duration_invalid`, `duration_mismatch`, `ffprobe_failed`, `output_missing`, `output_too_small`, `pixel_format_invalid`, `video_stream_count_invalid`, `video_stream_missing` | Rerun preflight, verify local H.264 MP4 support, and record again. Failed media is not published. |
| Session state failed | `recording_already_active`, `recording_not_started`, `capture_failed`, `integration_failed`, `invalid_configuration`, `recording_failed` | Run preflight, start a new task if plugin state changed, and retry only one recording at a time. |

These failures intentionally do not publish a Saved Recording. If automatic
cleanup is incomplete, follow the returned bounded local path and delete the
private Working Recording after confirming it is no longer needed.

## Video was not saved

- `saved_recording_unavailable` occurs before Browser activity when the
  destination cannot support safe publication. Choose a writable absolute local
  folder and approve macOS file access if requested.
- `saved_recording_persistence_failed` occurs after capture and validation when
  durable publication fails. The result includes a bounded Working Recording
  recovery directory. Copy the recording to a durable folder before deleting
  the recovery directory.
- `artifact_persistence_failed` or `cleanup_failed` indicates a private
  temporary-artifact problem. Check local free space and temporary-directory
  permissions, then remove only the exact cleanup path reported by the plugin.

Do not post recordings, raw frames, Browser/CDP diagnostics, private URLs,
credentials, tokens, or local private paths in a public issue. Follow
[SUPPORT.md](../SUPPORT.md) for a safe issue report or [SECURITY.md](../SECURITY.md)
for private vulnerability reporting.
