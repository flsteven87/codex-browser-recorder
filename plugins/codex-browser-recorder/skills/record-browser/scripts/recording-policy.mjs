export const DEFAULT_RECORDING_DURATION_MS = 15_000;
export const MIN_RECORDING_DURATION_MS = 5_000;
export const MAX_RECORDING_DURATION_MS = 60_000;
export const RECORDING_HARD_LIMIT_MS = 65_000;
export const RECORDING_FPS = 10;
export const RECORDING_JPEG_QUALITY = 70;
export const RECORDING_MAX_DECODED_BYTES = 5 * 1024 * 1024;
export const RECORDING_MAX_HEIGHT = 720;
export const RECORDING_MAX_OUTPUT_BYTES = 500 * 1024 * 1024;
export const RECORDING_MAX_WIDTH = 1280;

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

class RecordingPolicyError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "RecordingPolicyError";
    this.code = code;
  }
}

export function originOf(value) {
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

export function hasPointerActionEvidence({
  actionStartedAtEpochMs,
  beforeEvents,
  capture,
}) {
  return (
    Number.isFinite(actionStartedAtEpochMs) &&
    Number.isInteger(beforeEvents) &&
    Number.isInteger(capture?.cursorEventsCaptured) &&
    capture.cursorEventsCaptured > beforeEvents &&
    Number.isFinite(capture?.cursorLastEventEpochMs) &&
    capture.cursorLastEventEpochMs >= actionStartedAtEpochMs
  );
}

export function validateRecordingRequest({
  durationMs = DEFAULT_RECORDING_DURATION_MS,
  requirePointerEvents = false,
  targetUrl,
}) {
  let target;
  try {
    target = new URL(targetUrl);
  } catch {
    throw new RecordingPolicyError("invalid_target", "The recording target is not a valid URL");
  }

  if (target.username.length > 0 || target.password.length > 0) {
    throw new RecordingPolicyError(
      "target_credentials_present",
      "The recording target must not contain URL credentials",
    );
  }

  const secureTarget = target.protocol === "https:";
  const loopbackTarget =
    target.protocol === "http:" && LOOPBACK_HOSTS.has(target.hostname);
  if (!secureTarget && !loopbackTarget) {
    throw new RecordingPolicyError(
      "target_scheme_not_allowed",
      "The recording target must use HTTPS or an approved loopback origin",
    );
  }

  if (
    !Number.isInteger(durationMs) ||
    durationMs < MIN_RECORDING_DURATION_MS ||
    durationMs > MAX_RECORDING_DURATION_MS
  ) {
    throw new RecordingPolicyError(
      "invalid_duration",
      "Recording duration must be between 5 and 60 seconds",
    );
  }

  if (typeof requirePointerEvents !== "boolean") {
    throw new RecordingPolicyError(
      "invalid_configuration",
      "Pointer-event requirements must be explicit",
    );
  }

  return {
    approvedOrigin: target.origin,
    durationMs,
    requirePointerEvents,
    targetUrl,
  };
}
