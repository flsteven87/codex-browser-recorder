import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import { validateVideo } from "./validate-video.mjs";

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
  "video_stream_count_invalid",
  "video_stream_missing",
]);

const CAPTURE_FAILURE_CODES = new Set([
  "cdp_unavailable",
  "encoder_failed",
  "encoder_finalize_failed",
  "encoder_shutdown_timeout",
  "event_stream_invalid",
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
    codes: [
      "invalid_target",
      "target_credentials_present",
      "target_scheme_not_allowed",
      "invalid_duration",
    ],
    summary: "The recording request is not allowed",
    remediation:
      "Use an HTTPS or approved loopback URL without credentials and a duration from 5 to 60 seconds",
  },
  {
    codes: [
      "browser_plugin_unavailable",
      "cdp_unavailable",
      "plugin_module_unavailable",
    ],
    summary: "The required Browser recording capability is unavailable",
    remediation:
      "Install or enable the Browser plugin and approve full CDP access, then retry",
  },
  {
    codes: [
      "unsupported_platform",
      "ffmpeg_missing",
      "ffmpeg_vp8_unavailable",
      "ffmpeg_webm_unavailable",
      "ffprobe_missing",
      "ffprobe_unusable",
      "output_directory_not_writable",
    ],
    summary: "The local recording environment is not ready",
    remediation:
      "Resolve the reported preflight blocker, then run the recording again",
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
    summary: "The page is outside the approved recording origin",
    remediation:
      "Start a new recording and keep top-level navigation within the approved site",
  },
  {
    codes: [
      "event_stream_invalid",
      "frame_stream_stalled",
      "frame_stream_unavailable",
      "frame_too_large",
      "invalid_frame",
    ],
    summary: "The Browser frame stream could not be recorded safely",
    remediation:
      "Keep the tab visible, confirm full CDP approval, and retry the recording",
  },
  {
    codes: [
      "output_monitor_failed",
      "recording_duration_limit",
      "recording_output_limit",
    ],
    summary: "A recording safety limit stopped the session",
    remediation:
      "Use a shorter or less visually intensive flow and try again",
  },
  {
    codes: [
      "encoder_failed",
      "encoder_finalize_failed",
      "encoder_shutdown_timeout",
    ],
    summary: "The local video encoder could not complete the recording",
    remediation:
      "Run preflight and verify local FFmpeg VP8 WebM support before retrying",
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
      "video_stream_count_invalid",
      "video_stream_missing",
    ],
    summary: "The recorded media did not satisfy the WebM contract",
    remediation:
      "Run preflight, keep the page visible, and record the flow again",
  },
  {
    codes: ["artifact_persistence_failed", "cleanup_failed"],
    summary: "The private local recording artifacts could not be finalized",
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
    summary: "Recording could not be completed",
    remediation: "Run preflight and retry one recording at a time",
  },
];

const USER_MESSAGES = new Map(
  MESSAGE_GROUPS.flatMap(({ codes, remediation, summary }) =>
    codes.map((code) => [code, Object.freeze({ remediation, summary })]),
  ),
);
const RECORDING_CLEANUP_DETAILS = new WeakMap();

export function getRecordingCleanupDetails(error) {
  const details = RECORDING_CLEANUP_DETAILS.get(error);
  return details === undefined ? null : { ...details };
}

export function describeRecordingFailure(code) {
  return USER_MESSAGES.get(code) ?? USER_MESSAGES.get("recording_failed");
}

export function sanitizeRecordingFailure(error) {
  const code = USER_MESSAGES.has(error?.code)
    ? error.code
    : "recording_failed";
  const { remediation, summary } = describeRecordingFailure(code);
  const publicError = Object.assign(new Error(summary), {
    code,
    remediation,
    summary,
  });
  const cleanupDetails = RECORDING_CLEANUP_DETAILS.get(error);
  if (cleanupDetails !== undefined) {
    RECORDING_CLEANUP_DETAILS.set(publicError, cleanupDetails);
  }
  return publicError;
}

export function sanitizeCaptureResult(capture) {
  return Object.fromEntries(
    CAPTURE_RESULT_FIELDS.map((field) => [field, capture[field] ?? null]),
  );
}

function captureFailureCode(error) {
  if (error == null) {
    return null;
  }
  return CAPTURE_FAILURE_CODES.has(error.code)
    ? error.code
    : "capture_failed";
}

export async function prepareRecordingArtifacts({
  _dependencies = { chmod, mkdtemp, rm },
  temporaryRoot,
}) {
  let directory = null;
  try {
    directory = await _dependencies.mkdtemp(
      join(temporaryRoot, "codex-browser-recorder-"),
    );
    await _dependencies.chmod(directory, 0o700);
  } catch {
    if (directory !== null) {
      try {
        await _dependencies.rm(directory, { force: true, recursive: true });
      } catch {
        // The bounded preparation failure remains primary.
      }
    }
    throw sanitizeRecordingFailure({ code: "artifact_persistence_failed" });
  }

  return {
    directory,
    outputPath: join(directory, "recording.webm"),
    resultPath: join(directory, "result.json"),
  };
}

export async function cleanupRecordingArtifacts(
  paths,
  { _dependencies = { rm } } = {},
) {
  if (
    typeof paths?.directory !== "string" ||
    paths.directory.length === 0
  ) {
    throw sanitizeRecordingFailure({ code: "invalid_configuration" });
  }

  try {
    await _dependencies.rm(paths.directory, { force: true, recursive: true });
  } catch {
    throw sanitizeRecordingFailure({ code: "cleanup_failed" });
  }
}

export async function finalizeRecordingArtifacts({
  _dependencies = { rm, validateVideo, writeFile },
  captureError,
  durationToleranceSeconds,
  ffprobePath,
  maxHeight,
  maxWidth,
  minBytes,
  outputPath,
  resultPath,
  session,
}) {
  let failureCode = captureFailureCode(captureError);
  let capture;
  try {
    capture = await session.stop();
  } catch (error) {
    capture = {
      ...session.stats?.framePump,
      ...session.stats?.resources,
      ...session.stats?.sink,
      elapsedMs: session.stats?.resources?.elapsedMs ?? null,
    };
    failureCode ??= captureFailureCode(error);
  }

  let validation = null;
  if (failureCode === null) {
    try {
      validation = await _dependencies.validateVideo({
        durationToleranceSeconds,
        expectedDurationSeconds: capture.elapsedMs / 1000,
        ffprobePath,
        maxHeight,
        maxWidth,
        minBytes,
        outputPath,
      });
    } catch (error) {
      if (!VIDEO_VALIDATION_FAILURE_CODES.has(error?.code)) {
        throw sanitizeRecordingFailure(error);
      }
      failureCode = error.code;
    }
  }

  const { summary, remediation } =
    failureCode === null
      ? {
          summary: "Recording completed successfully",
          remediation: "No action is required",
        }
      : describeRecordingFailure(failureCode);
  const result = {
    capture: sanitizeCaptureResult(capture),
    failureCode,
    media: validation,
    outputFile: basename(outputPath),
    recorderContractVersion: 1,
    remediation,
    schemaVersion: 3,
    status: failureCode === null ? "passed" : "failed",
    summary,
  };

  try {
    await _dependencies.writeFile(
      resultPath,
      `${JSON.stringify(result, null, 2)}\n`,
      {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      },
    );
  } catch {
    const failure = sanitizeRecordingFailure({
      code: "artifact_persistence_failed",
    });
    const directory = dirname(outputPath);
    try {
      await _dependencies.rm(directory, { force: true, recursive: true });
    } catch {
      RECORDING_CLEANUP_DETAILS.set(
        failure,
        Object.freeze({ cleanupIncomplete: true, directory }),
      );
    }
    throw failure;
  }
  return result;
}
