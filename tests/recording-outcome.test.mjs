import assert from "node:assert/strict";
import test from "node:test";

import {
  createRecordingOutcome,
  describeRecordingFailure,
  getRecordingCleanupDetails,
  RECORDING_FAILURE_CODES,
  sanitizeRecordingFailure,
} from "../plugins/codex-browser-recorder/skills/record-browser/scripts/recording-outcome.mjs";

const FAILURE_MESSAGE_GROUPS = [
  {
    codes: ["cursor_recording_failed"],
    summary: "Cursor or click feedback was missing",
    remediation:
      "Keep the tab visible, make each pointer action clear, and record the flow again",
  },
  {
    codes: [
      "invalid_target",
      "target_credentials_present",
      "target_scheme_not_allowed",
      "invalid_duration",
    ],
    summary: "This recording request is not supported",
    remediation:
      "Use a public HTTPS page (or localhost) without a username or password, and choose 5 to 60 seconds",
  },
  {
    codes: [
      "browser_plugin_unavailable",
      "cdp_unavailable",
      "plugin_module_unavailable",
    ],
    summary: "Browser Recorder could not connect to Chrome",
    remediation:
      "Install or enable the Chrome plugin and extension, allow full browser access in Codex settings, then try again",
  },
  {
    codes: ["browser_surface_unsupported"],
    summary: "Browser Recorder currently works only with Chrome",
    remediation: "Choose Chrome instead of the Codex in-app Browser",
  },
  {
    codes: ["unsupported_platform"],
    summary: "Browser Recorder currently works only on macOS",
    remediation: "Use the Codex desktop app on a Mac",
  },
  {
    codes: ["ffmpeg_missing", "ffprobe_missing"],
    summary: "FFmpeg is not installed or is not available to Codex",
    remediation:
      "Install FFmpeg (Homebrew: brew install ffmpeg), then run the setup check again",
  },
  {
    codes: [
      "ffmpeg_h264_unavailable",
      "ffmpeg_mp4_unavailable",
      "ffprobe_unusable",
    ],
    summary: "This FFmpeg installation cannot create the required video",
    remediation:
      "Install a complete FFmpeg build with H.264 and MP4 support, then run the setup check again",
  },
  {
    codes: ["output_directory_not_writable"],
    summary: "The selected folder cannot be used for recordings",
    remediation:
      "Choose a writable local folder or allow folder access in macOS, then try again",
  },
  {
    codes: ["cancelled", "recording_cancelled"],
    summary: "Recording was cancelled",
    remediation:
      "Start again when you are ready and approve the requested scope",
  },
  {
    codes: [
      "origin_not_allowed",
      "origin_verification_failed",
      "origin_changed_during_recording",
    ],
    summary: "Recording stopped because the tab opened another website",
    remediation:
      "Start a new recording and keep the tab on the approved site",
  },
  {
    codes: [
      "event_stream_invalid",
      "frame_ack_failed",
      "frame_stream_stalled",
      "frame_stream_unavailable",
      "frame_too_large",
      "invalid_frame",
    ],
    summary: "Chrome stopped sending video frames",
    remediation:
      "Keep the Chrome tab visible, confirm full browser access in Codex settings, and try again",
  },
  {
    codes: [
      "output_monitor_failed",
      "recording_duration_limit",
      "recording_output_limit",
    ],
    summary: "Recording stopped at a safety limit",
    remediation:
      "Use a shorter or less visually intensive flow and try again",
  },
  {
    codes: [
      "encoder_failed",
      "encoder_finalize_failed",
      "encoder_shutdown_timeout",
    ],
    summary: "FFmpeg could not finish the video",
    remediation:
      "Run preflight and verify local FFmpeg H.264 MP4 support before retrying",
  },
  {
    codes: [
      "audio_stream_present",
      "codec_invalid",
      "container_invalid",
      "dimensions_out_of_bounds",
      "duration_invalid",
      "duration_mismatch",
      "ffprobe_failed",
      "output_missing",
      "output_too_small",
      "pixel_format_invalid",
      "video_stream_count_invalid",
      "video_stream_missing",
    ],
    summary: "The video could not be verified, so it was not saved",
    remediation:
      "Run preflight, keep the page visible, and record the flow again",
  },
  {
    codes: ["saved_recording_unavailable"],
    summary: "The selected folder cannot be used for recordings",
    remediation:
      "Choose a writable local folder, approve macOS file access if requested, and retry",
  },
  {
    codes: ["saved_recording_persistence_failed"],
    summary: "The recording was captured but could not be saved",
    remediation:
      "Use the temporary recovery folder shown in the result, or choose another writable folder and try again",
  },
  {
    codes: ["artifact_persistence_failed", "cleanup_failed"],
    summary: "Temporary recording files could not be cleaned up",
    remediation:
      "Check temporary storage permissions and free space, then retry",
  },
  {
    codes: [
      "capture_failed",
      "integration_failed",
      "invalid_configuration",
      "recording_already_active",
      "recording_not_started",
      "recording_failed",
    ],
    summary: "The recording could not be completed",
    remediation: "Run the setup check, then try one recording at a time",
  },
];

test("keeps every public failure code mapped to its documented message", () => {
  const expectedCodes = FAILURE_MESSAGE_GROUPS.flatMap(({ codes }) => codes)
    .toSorted();
  assert.deepEqual(RECORDING_FAILURE_CODES, expectedCodes);

  for (const { codes, remediation, summary } of FAILURE_MESSAGE_GROUPS) {
    for (const code of codes) {
      assert.deepEqual(describeRecordingFailure(code), {
        remediation,
        summary,
      });
    }
  }
});

test("maps unknown private failures to a fixed privacy-safe fallback", () => {
  const secret = "https://private.example.test/?token=must-not-leak";
  const error = sanitizeRecordingFailure({
    code: secret,
    diagnostic: secret,
    message: secret,
  });

  assert.equal(error.code, "recording_failed");
  assert.deepEqual(
    {
      message: error.message,
      remediation: error.remediation,
      summary: error.summary,
    },
    {
      message: "The recording could not be completed",
      remediation: "Run the setup check, then try one recording at a time",
      summary: "The recording could not be completed",
    },
  );
  assert.equal(JSON.stringify(error).includes(secret), false);
});

test("keeps combined artifact and Browser cleanup state bounded", () => {
  const error = sanitizeRecordingFailure(
    { code: "integration_failed" },
    {
      artifactCleanupIncomplete: true,
      browserTabCleanupIncomplete: true,
      cleanupDirectory: "/private/recording",
    },
  );

  assert.deepEqual(getRecordingCleanupDetails(error), {
    artifactCleanupIncomplete: true,
    browserTabCleanupIncomplete: true,
    cleanupIncomplete: true,
    directory: "/private/recording",
  });
  assert.equal("browserTabCleanupIncomplete" in error, false);
  assert.equal("artifactCleanupIncomplete" in error, false);
  assert.equal("cleanupIncomplete" in error, false);
  assert.equal("directory" in error, false);
});

test("builds the schema-v3 result without performing persistence", () => {
  assert.deepEqual(
    createRecordingOutcome({
      capture: { framesReceived: 3 },
      failureCode: null,
      outputFile: "recording.mp4",
      validation: { codec: "h264" },
    }),
    {
      capture: {
        backpressureDrops: null,
        elapsedMs: null,
        encoderExitCode: null,
        framesAcknowledged: null,
        framesDropped: null,
        framesReceived: 3,
        invalidFrames: null,
        lastFrameTimestamp: null,
        maxObservedOutputBytes: null,
        outputSamples: null,
        terminationReason: null,
        truncations: null,
        visibilityChanges: null,
        visibilityState: null,
      },
      failureCode: null,
      media: { codec: "h264" },
      outputFile: "recording.mp4",
      recorderContractVersion: 1,
      remediation: "No action is required",
      schemaVersion: 3,
      status: "passed",
      summary: "Recording completed successfully",
    },
  );
});
