# Troubleshooting

Start with the built-in preflight. It checks the supported platform, media
tools, codecs, container support, and destination without opening a Browser tab:

```text
$record-browser Check whether my local recording environment is ready.
```

A passing result begins with `Local recording preflight passed`. Preflight does
not confirm that the Chrome plugin and extension are installed, that a site is
approved, or that full CDP access will be granted.

## Installation and discovery

If `$record-browser` is missing:

1. In the ChatGPT desktop app, select Codex and open **Plugins**.
2. Confirm that **Codex Browser Recorder** and **Chrome** are installed.
3. For Chrome, finish the Chrome extension setup and confirm its side chat
   loads in the active Chrome profile.
4. For a local checkout, confirm that its marketplace appears in
   `codex plugin marketplace list` and points to the expected root.
5. Start a new task. Installed plugins are loaded into new tasks, not retrofitted
   into an existing one.
6. If it is still missing, restart the desktop app and create another task.

Do not edit plugin cache files or copy source files into the cache. Refresh or
reinstall from the marketplace source instead.

## Preflight blockers

| Code | Meaning | What to do |
| --- | --- | --- |
| `unsupported_platform` | Recording is currently limited to macOS. | Run it in the supported Codex desktop environment on macOS. |
| `ffmpeg_missing` | `ffmpeg` was not found on `PATH`. | Install FFmpeg and ensure the Codex desktop runtime can resolve it. Homebrew users can run `brew install ffmpeg`. |
| `ffmpeg_h264_unavailable` | FFmpeg does not expose the required `libx264` encoder. | Install an FFmpeg build that includes `libx264`. |
| `ffmpeg_mp4_unavailable` | FFmpeg does not expose the required MP4 muxer. | Install an FFmpeg build with MP4 support. |
| `ffprobe_missing` | `ffprobe` was not found on `PATH`. | Install the complete FFmpeg toolset and verify `ffprobe` resolves. |
| `ffprobe_unusable` | `ffprobe` cannot produce the JSON metadata the validator needs. | Replace or repair the FFmpeg installation, then rerun preflight. |
| `output_directory_not_writable` | The planned destination or its nearest existing parent is not writable. | Choose another absolute local directory or approve macOS file access. |

Preflight reports every blocker it finds. Resolve all of them before retrying a
recording.

## Browser or CDP unavailable

`browser_plugin_unavailable`, `cdp_unavailable`, and
`plugin_module_unavailable` mean the required Chrome recording capability could
not be loaded or approved.

1. Install or enable **Chrome** plus its extension.
2. Open **Settings > Browser** and enable **Developer mode > Enable full CDP
   access**. Workspace policy can prevent this setting from being enabled.
3. Start a new task after changing plugin installation state.
4. Retry against a public, logged-out page and approve the requested site and
   full-CDP scope.

Approval denial returns `cancelled`; cancellation after a Recording Session has
started can return `recording_cancelled`. The recorder does not retry or bypass
either result.

`browser_surface_unsupported` means the request selected the Codex in-app
Browser. This release supports Chrome only and stops before consent or Browser
activity; choose Chrome rather than retrying or expecting an automatic switch.

## Request rejected

`invalid_target`, `target_credentials_present`, `target_scheme_not_allowed`, or
`invalid_duration` means the request is outside the supported contract. Use:

- an `https:` URL without embedded username or password; or
- an `http:` loopback URL on `localhost`, `127.0.0.1`, or `[::1]`; and
- a duration from 5 to 60 seconds when a duration is explicit.

Passive or wait-only recording needs an explicit duration. Action-driven
recording can omit it and will finish after the last approved action, with a
15-second session cap.

## Recording stopped safely

Every stable code currently recognized by the public failure sanitizer appears
in this guide so the exact returned code is searchable. Component failures can
be normalized to a group fallback before the final result; for example, the
current coordinator reports `frame_too_large` and `invalid_frame` capture
failures as `capture_failed`.

| Failure group | Recognized public codes | What to do |
| --- | --- | --- |
| Origin changed | `origin_not_allowed`, `origin_verification_failed`, `origin_changed_during_recording` | Start again and keep top-level navigation within the approved origin. |
| Browser surface unsupported | `browser_surface_unsupported` | Use Chrome; the Codex in-app Browser is not supported by this release. |
| Frame stream failed | `event_stream_invalid`, `frame_ack_failed`, `frame_stream_stalled`, `frame_stream_unavailable`, `frame_too_large`, `invalid_frame` | Use the supported Chrome surface, keep the tab visible, confirm full CDP approval, and retry a shorter flow. |
| Pointer evidence failed | `cursor_recording_failed` | Keep every participating frame available and retry each pointer action visibly. |
| Safety limit reached | `recording_duration_limit`, `recording_output_limit`, `output_monitor_failed` | Shorten the flow or reduce visual activity. |
| Encoder failed | `encoder_failed`, `encoder_finalize_failed`, `encoder_shutdown_timeout` | Rerun preflight and verify local H.264 MP4 support. |
| Media validation failed | `audio_stream_present`, `codec_invalid`, `container_invalid`, `dimensions_out_of_bounds`, `duration_invalid`, `duration_mismatch`, `ffprobe_failed`, `output_missing`, `output_too_small`, `pixel_format_invalid`, `video_stream_count_invalid`, `video_stream_missing` | Rerun preflight, keep the page visible, and record again. Failed media is not published. |
| Session state failed | `recording_already_active`, `recording_not_started`, `capture_failed`, `integration_failed`, `invalid_configuration`, `recording_failed` | Run preflight, start a new task if plugin state changed, and retry only one recording at a time. |

These failures intentionally do not publish a Saved Recording. If automatic
cleanup is incomplete, follow the returned bounded local path and delete the
private Working Recording after confirming it is no longer needed.

## Saved Recording failures

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
