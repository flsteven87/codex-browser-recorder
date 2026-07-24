const CAPTURE_RESULT_FIELDS = [
  "backpressureDrops",
  "elapsedMs",
  "encoderExitCode",
  "framesAcknowledged",
  "framesDropped",
  "framesReceived",
  "invalidFrames",
  "lastFrameTimestamp",
  "maxObservedOutputBytes",
  "outputSamples",
  "terminationReason",
  "truncations",
  "visibilityChanges",
  "visibilityState",
];

const VIDEO_VALIDATION_FAILURE_CODES = new Set([
  "audio_stream_present",
  "codec_invalid",
  "container_invalid",
  "dimensions_out_of_bounds",
  "duration_invalid",
  "duration_mismatch",
  "ffprobe_failed",
  "invalid_configuration",
  "output_missing",
  "output_too_small",
  "pixel_format_invalid",
  "video_stream_count_invalid",
  "video_stream_missing",
]);

const CAPTURE_FAILURE_CODES = new Set([
  "cdp_unavailable",
  "cursor_recording_failed",
  "encoder_failed",
  "encoder_finalize_failed",
  "encoder_shutdown_timeout",
  "event_stream_invalid",
  "frame_ack_failed",
  "frame_stream_stalled",
  "frame_stream_unavailable",
  "integration_failed",
  "invalid_configuration",
  "origin_not_allowed",
  "origin_changed_during_recording",
  "origin_verification_failed",
  "output_monitor_failed",
  "recording_cancelled",
  "recording_duration_limit",
  "recording_output_limit",
]);

const MESSAGE_GROUPS = [
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
    remediation:
      "Choose Chrome instead of the Codex in-app Browser",
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

const USER_MESSAGES = new Map(
  MESSAGE_GROUPS.flatMap(({ codes, remediation, summary }) =>
    codes.map((code) => [code, Object.freeze({ remediation, summary })]),
  ),
);
export const RECORDING_FAILURE_CODES = Object.freeze(
  [...USER_MESSAGES.keys()].toSorted(),
);
const RECORDING_CLEANUP_DETAILS = new WeakMap();

export function getRecordingCleanupDetails(error) {
  const details = RECORDING_CLEANUP_DETAILS.get(error);
  return details === undefined ? null : { ...details };
}

export function describeRecordingFailure(code) {
  return USER_MESSAGES.get(code) ?? USER_MESSAGES.get("recording_failed");
}

export function sanitizeRecordingFailure(
  error,
  {
    artifactCleanupIncomplete = false,
    browserTabCleanupIncomplete = false,
    cleanupDirectory,
    cleanupFile,
  } = {},
) {
  const code = USER_MESSAGES.has(error?.code)
    ? error.code
    : "recording_failed";
  const { remediation, summary } = describeRecordingFailure(code);
  const publicError = Object.assign(new Error(summary), {
    code,
    remediation,
    summary,
  });
  const inherited = RECORDING_CLEANUP_DETAILS.get(error) ?? {};
  const details = {
    ...inherited,
    ...(artifactCleanupIncomplete === true
      ? { artifactCleanupIncomplete: true }
      : {}),
    ...(browserTabCleanupIncomplete === true
      ? { browserTabCleanupIncomplete: true }
      : {}),
    ...(typeof cleanupDirectory === "string" && cleanupDirectory.length > 0
      ? {
          cleanupIncomplete: true,
          directory: cleanupDirectory,
        }
      : {}),
    ...(typeof cleanupFile === "string" && cleanupFile.length > 0
      ? {
          cleanupFile,
          cleanupIncomplete: true,
        }
      : {}),
  };
  if (Object.keys(details).length > 0) {
    RECORDING_CLEANUP_DETAILS.set(publicError, Object.freeze(details));
  }
  return publicError;
}

export function sanitizeCaptureResult(capture) {
  return Object.fromEntries(
    CAPTURE_RESULT_FIELDS.map((field) => [field, capture[field] ?? null]),
  );
}

export function sanitizeCaptureStatus(capture) {
  return {
    ...sanitizeCaptureResult(capture),
    cursorEventsCaptured: capture.cursorEventsCaptured ?? null,
    cursorFramesObserved: capture.cursorFramesObserved ?? null,
    cursorLastEventEpochMs: capture.cursorLastEventEpochMs ?? null,
  };
}

export function captureFailureCode(error) {
  if (error == null) return null;
  return CAPTURE_FAILURE_CODES.has(error.code)
    ? error.code
    : "capture_failed";
}

export function isVideoValidationFailure(error) {
  return VIDEO_VALIDATION_FAILURE_CODES.has(error?.code);
}

export function createRecordingOutcome({
  capture,
  failureCode,
  outputFile,
  validation,
}) {
  const { summary, remediation } =
    failureCode === null
      ? {
          summary: "Recording completed successfully",
          remediation: "No action is required",
        }
      : describeRecordingFailure(failureCode);
  return {
    capture: sanitizeCaptureResult(capture),
    failureCode,
    media: validation,
    outputFile,
    recorderContractVersion: 1,
    remediation,
    schemaVersion: 3,
    status: failureCode === null ? "passed" : "failed",
    summary,
  };
}
