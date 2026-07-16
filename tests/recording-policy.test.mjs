import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_RECORDING_DURATION_MS,
  MAX_RECORDING_DURATION_MS,
  MIN_RECORDING_DURATION_MS,
  RECORDING_FPS,
  RECORDING_HARD_LIMIT_MS,
  RECORDING_JPEG_QUALITY,
  RECORDING_MAX_DECODED_BYTES,
  RECORDING_MAX_HEIGHT,
  RECORDING_MAX_OUTPUT_BYTES,
  RECORDING_MAX_WIDTH,
  hasPointerActionEvidence,
  originOf,
  validateRecordingRequest,
} from "../plugins/codex-browser-recorder/skills/record-browser/scripts/recording-policy.mjs";

test("requires pointer evidence captured after the current action boundary", () => {
  const firstActionStartedAt = 1_000;
  assert.equal(
    hasPointerActionEvidence({
      actionStartedAtEpochMs: firstActionStartedAt,
      beforeEvents: 0,
      capture: {
        cursorEventsCaptured: 4,
        cursorLastEventEpochMs: 1_010,
      },
    }),
    true,
  );

  const secondActionStartedAt = 1_020;
  assert.equal(
    hasPointerActionEvidence({
      actionStartedAtEpochMs: secondActionStartedAt,
      beforeEvents: 4,
      capture: {
        cursorEventsCaptured: 6,
        cursorLastEventEpochMs: 1_015,
      },
    }),
    false,
    "a delayed tail from the first action must not satisfy the second action",
  );
  assert.equal(
    hasPointerActionEvidence({
      actionStartedAtEpochMs: secondActionStartedAt,
      beforeEvents: 4,
      capture: {
        cursorEventsCaptured: 7,
        cursorLastEventEpochMs: 1_025,
      },
    }),
    true,
  );
});

test("normalizes approved HTTPS and loopback targets", () => {
  const cases = [
    ["https://example.com/demo#step", "https://example.com"],
    ["https://example.com:8443/demo", "https://example.com:8443"],
    ["http://localhost:3000/demo", "http://localhost:3000"],
    ["http://127.0.0.1:4173/", "http://127.0.0.1:4173"],
    ["http://[::1]:8080/", "http://[::1]:8080"],
  ];

  for (const [targetUrl, approvedOrigin] of cases) {
    assert.deepEqual(validateRecordingRequest({ targetUrl }), {
      approvedOrigin,
      durationMs: DEFAULT_RECORDING_DURATION_MS,
      requirePointerEvents: false,
      targetUrl,
    });
  }
});

test("validates whether the approved flow requires pointer evidence", () => {
  assert.equal(
    validateRecordingRequest({
      requirePointerEvents: true,
      targetUrl: "https://example.com/",
    }).requirePointerEvents,
    true,
  );
  assert.throws(
    () =>
      validateRecordingRequest({
        requirePointerEvents: "yes",
        targetUrl: "https://example.com/",
      }),
    (error) => error.code === "invalid_configuration",
  );
});

test("rejects invalid, credentialed, and unsupported targets without echoing them", () => {
  const cases = [
    ["not a URL", "invalid_target"],
    ["https://user:secret@example.com/", "target_credentials_present"],
    ["http://example.com/", "target_scheme_not_allowed"],
    ["file:///private/secret", "target_scheme_not_allowed"],
  ];

  for (const [targetUrl, code] of cases) {
    assert.throws(
      () => validateRecordingRequest({ targetUrl }),
      (error) =>
        error.code === code &&
        !error.message.includes(targetUrl) &&
        !JSON.stringify(error).includes(targetUrl),
    );
  }
});

test("accepts only bounded integer recording durations", () => {
  for (const durationMs of [MIN_RECORDING_DURATION_MS, 15_000, MAX_RECORDING_DURATION_MS]) {
    assert.equal(
      validateRecordingRequest({ durationMs, targetUrl: "https://example.com/" })
        .durationMs,
      durationMs,
    );
  }

  for (const durationMs of [4_999, 60_001, 15_000.5, Number.NaN]) {
    assert.throws(
      () => validateRecordingRequest({ durationMs, targetUrl: "https://example.com/" }),
      (error) => error.code === "invalid_duration",
    );
  }
  assert.equal(RECORDING_HARD_LIMIT_MS, 65_000);
});

test("extracts an origin without leaking invalid input", () => {
  assert.equal(originOf("https://example.com/path?token=secret"), "https://example.com");
  assert.equal(originOf("not a URL"), null);
});

test("exports the non-overridable media and resource limits", () => {
  assert.deepEqual(
    {
      fps: RECORDING_FPS,
      jpegQuality: RECORDING_JPEG_QUALITY,
      maxDecodedBytes: RECORDING_MAX_DECODED_BYTES,
      maxHeight: RECORDING_MAX_HEIGHT,
      maxOutputBytes: RECORDING_MAX_OUTPUT_BYTES,
      maxWidth: RECORDING_MAX_WIDTH,
    },
    {
      fps: 10,
      jpegQuality: 70,
      maxDecodedBytes: 5 * 1024 * 1024,
      maxHeight: 720,
      maxOutputBytes: 500 * 1024 * 1024,
      maxWidth: 1280,
    },
  );
});
