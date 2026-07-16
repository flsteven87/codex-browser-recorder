import assert from "node:assert/strict";
import test from "node:test";

import {
  createRecordingOutcome,
  getRecordingCleanupDetails,
  sanitizeRecordingFailure,
} from "../plugins/codex-browser-recorder/skills/record-browser/scripts/recording-outcome.mjs";

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
