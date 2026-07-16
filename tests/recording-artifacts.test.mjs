import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import test from "node:test";

import {
  createRecordingArtifactTransaction,
  planSavedRecording,
} from "../plugins/codex-browser-recorder/skills/record-browser/scripts/recording-artifacts.mjs";
import {
  describeRecordingFailure,
  getRecordingCleanupDetails,
  sanitizeRecordingFailure,
} from "../plugins/codex-browser-recorder/skills/record-browser/scripts/recording-outcome.mjs";

const temporaryRoot = mkdtempSync(join(tmpdir(), "recording-artifacts-test-"));

const expectedCapture = {
  backpressureDrops: 0,
  elapsedMs: 500,
  encoderExitCode: 0,
  framesAcknowledged: 5,
  framesDropped: 0,
  framesReceived: 5,
  invalidFrames: 0,
  lastFrameTimestamp: 123.5,
  maxObservedOutputBytes: null,
  outputSamples: 5,
  terminationReason: null,
  truncations: 0,
  visibilityChanges: 0,
  visibilityState: true,
};
const expectedValidation = {
  codecName: "h264",
  durationSeconds: 0.5,
  height: 180,
  sizeBytes: 512,
  width: 320,
};

const knownFailureCodes = [
  "invalid_target",
  "target_credentials_present",
  "target_scheme_not_allowed",
  "invalid_duration",
  "browser_plugin_unavailable",
  "cdp_unavailable",
  "plugin_module_unavailable",
  "unsupported_platform",
  "ffmpeg_missing",
  "ffmpeg_h264_unavailable",
  "ffmpeg_mp4_unavailable",
  "ffprobe_missing",
  "ffprobe_unusable",
  "output_directory_not_writable",
  "saved_recording_unavailable",
  "cancelled",
  "recording_cancelled",
  "cursor_recording_failed",
  "origin_not_allowed",
  "origin_verification_failed",
  "origin_changed_during_recording",
  "event_stream_invalid",
  "frame_ack_failed",
  "frame_stream_stalled",
  "frame_stream_unavailable",
  "frame_too_large",
  "invalid_frame",
  "output_monitor_failed",
  "recording_duration_limit",
  "recording_output_limit",
  "encoder_failed",
  "encoder_finalize_failed",
  "encoder_shutdown_timeout",
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
  "artifact_persistence_failed",
  "saved_recording_persistence_failed",
  "cleanup_failed",
  "capture_failed",
  "integration_failed",
  "invalid_configuration",
  "recording_already_active",
  "recording_not_started",
  "recording_failed",
];

test.after(() => {
  rmSync(temporaryRoot, { force: true, recursive: true });
});

function captureResult(overrides = {}) {
  return {
    backpressureDrops: 0,
    elapsedMs: 500,
    encoderExitCode: 0,
    framesAcknowledged: 5,
    framesDropped: 0,
    framesReceived: 5,
    invalidFrames: 0,
    lastFrameTimestamp: 123.5,
    outputSamples: 5,
    truncations: 0,
    visibilityChanges: 0,
    visibilityState: true,
    ...overrides,
  };
}

function validationFailure(code) {
  return Object.assign(new Error(`private ${code} diagnostic`), { code });
}

function assertBoundedFailure(error, code, privateDiagnostics = []) {
  const expected = describeRecordingFailure(code);
  const serialized = `${error.message}\n${JSON.stringify(error)}`;

  assert.equal(error.code, code);
  assert.equal(error.message, expected.summary);
  assert.equal(error.summary, expected.summary);
  assert.equal(error.remediation, expected.remediation);
  assert.equal("cause" in error, false);
  assert.equal("diagnostic" in error, false);
  for (const diagnostic of privateDiagnostics) {
    assert.equal(serialized.includes(diagnostic), false);
  }
  return true;
}

async function createTransaction({
  _dependencies,
  destinationDirectory,
  outputFilename = "browser-recording-2026-07-16-143122.mp4",
} = {}) {
  return createRecordingArtifactTransaction({
    _dependencies: {
      validateVideo: async () => expectedValidation,
      ..._dependencies,
    },
    destinationDirectory:
      destinationDirectory ??
      mkdtempSync(join(tmpdir(), "browser-recorder-saved-")),
    outputFilename,
    temporaryRoot,
  });
}

test("describes and sanitizes every known recording failure deterministically", () => {
  const injectedDiagnostic = "private injected failure diagnostic";

  for (const code of knownFailureCodes) {
    const first = describeRecordingFailure(code);
    const second = describeRecordingFailure(code);
    const sanitized = sanitizeRecordingFailure(
      Object.assign(new Error(injectedDiagnostic), {
        cause: injectedDiagnostic,
        code,
        diagnostic: injectedDiagnostic,
      }),
    );

    assert.equal(typeof first.summary, "string", code);
    assert.equal(first.summary.length > 0, true, code);
    assert.equal(typeof first.remediation, "string", code);
    assert.equal(first.remediation.length > 0, true, code);
    assert.deepEqual(second, first, code);
    assert.equal(sanitized.code, code, code);
    assert.equal(sanitized.message, first.summary, code);
    assert.equal(JSON.stringify(sanitized).includes(injectedDiagnostic), false);
  }
});

test("normalizes an unknown recording failure to the generic public contract", () => {
  const sanitized = sanitizeRecordingFailure(
    Object.assign(new Error("unknown private diagnostic"), {
      code: "unknown_private_failure",
    }),
  );

  assert.equal(sanitized.code, "recording_failed");
  assert.deepEqual(
    { remediation: sanitized.remediation, summary: sanitized.summary },
    describeRecordingFailure("recording_failed"),
  );
  assert.equal(JSON.stringify(sanitized).includes("private diagnostic"), false);
});

test("plans a privacy-safe Saved Recording in Downloads by default", () => {
  assert.deepEqual(
    planSavedRecording({
      homeDirectory: "/Users/example",
      now: new Date(2026, 6, 16, 14, 31, 22),
    }),
    {
      destinationDirectory:
        "/Users/example/Downloads/Codex Browser Recordings",
      outputFilename: "browser-recording-2026-07-16-143122.mp4",
    },
  );
});

test("cleans an explicitly requested Saved Recording name without page data", () => {
  assert.deepEqual(
    planSavedRecording({
      destinationDirectory: "/Users/example/Desktop",
      homeDirectory: "/Users/example",
      now: new Date(2026, 6, 16, 14, 31, 22),
      recordingName: "  登入 / smoke:test.mp4  ",
    }),
    {
      destinationDirectory: "/Users/example/Desktop",
      outputFilename: "登入 - smoke-test.mp4",
    },
  );
});

test("rejects empty names and relative Saved Recording destinations", () => {
  assert.throws(
    () => planSavedRecording({ recordingName: "..." }),
    (error) => error.code === "invalid_configuration",
  );
  assert.throws(
    () => planSavedRecording({ destinationDirectory: "Downloads" }),
    (error) => error.code === "invalid_configuration",
  );
});

test("preflights the durable destination and prepares one private MP4 path", async () => {
  const destinationDirectory = mkdtempSync(
    join(tmpdir(), "browser-recorder-destination-"),
  );
  try {
    const first = await createTransaction({ destinationDirectory });
    const second = await createTransaction({ destinationDirectory });
    const firstWorkingDirectory = dirname(first.capturePath);
    const secondWorkingDirectory = dirname(second.capturePath);

    assert.notEqual(firstWorkingDirectory, secondWorkingDirectory);
    assert.equal(basename(first.capturePath), "recording.mp4");
    assert.equal(firstWorkingDirectory.startsWith(`${temporaryRoot}/`), true);
    assert.equal(statSync(firstWorkingDirectory).mode & 0o077, 0);
    assert.equal("workingDirectory" in first, false);
    assert.equal("destinationDirectory" in first, false);
    await first.rollback();
    await second.rollback();
  } finally {
    rmSync(destinationDirectory, { force: true, recursive: true });
  }
});

test("proves atomic no-overwrite publication before working allocation", async () => {
  let workingAllocationStarted = false;
  const destinationDirectory = mkdtempSync(
    join(tmpdir(), "browser-recorder-no-link-"),
  );
  try {
    await assert.rejects(
      createRecordingArtifactTransaction({
        _dependencies: {
          link: async () => {
            throw new Error("private unsupported link diagnostic");
          },
          mkdtemp: async () => {
            workingAllocationStarted = true;
          },
        },
        destinationDirectory,
        outputFilename: "browser-recording-2026-07-16-143122.mp4",
        temporaryRoot,
      }),
      (error) => error.code === "saved_recording_unavailable",
    );
    assert.equal(workingAllocationStarted, false);
  } finally {
    rmSync(destinationDirectory, { force: true, recursive: true });
  }
});

test("rejects an unavailable Saved Recording destination before working allocation", async () => {
  let workingAllocationStarted = false;
  const privateDiagnostic = "private destination diagnostic";

  await assert.rejects(
    createRecordingArtifactTransaction({
      _dependencies: {
        mkdir: async () => {
          throw new Error(privateDiagnostic);
        },
        mkdtemp: async () => {
          workingAllocationStarted = true;
        },
      },
      destinationDirectory: "/private/unavailable",
      outputFilename: "browser-recording-2026-07-16-143122.mp4",
      temporaryRoot,
    }),
    (error) =>
      assertBoundedFailure(error, "saved_recording_unavailable", [
        privateDiagnostic,
      ]),
  );
  assert.equal(workingAllocationStarted, false);
});

test("proves destination file creation before allocating a Working Recording", async () => {
  let workingAllocationStarted = false;
  const destinationDirectory = mkdtempSync(
    join(tmpdir(), "browser-recorder-denied-"),
  );
  try {
    await assert.rejects(
      createRecordingArtifactTransaction({
        _dependencies: {
          mkdtemp: async () => {
            workingAllocationStarted = true;
          },
          open: async () => {
            throw new Error("private macOS permission diagnostic");
          },
        },
        destinationDirectory,
        outputFilename: "browser-recording-2026-07-16-143122.mp4",
        temporaryRoot,
      }),
      (error) => error.code === "saved_recording_unavailable",
    );
    assert.equal(workingAllocationStarted, false);
  } finally {
    rmSync(destinationDirectory, { force: true, recursive: true });
  }
});

test("publishes a validated MP4 as the Saved Recording outcome", async () => {
  const destinationDirectory = mkdtempSync(
    join(tmpdir(), "browser-recorder-saved-"),
  );
  try {
    const transaction = await createTransaction({ destinationDirectory });
    writeFileSync(transaction.capturePath, "validated-video");

    const output = await transaction.finalize({
      capture: captureResult(),
      ffprobePath: "/opt/ffprobe",
    });

    assert.deepEqual(output.result, {
      capture: expectedCapture,
      failureCode: null,
      media: expectedValidation,
      outputFile: "browser-recording-2026-07-16-143122.mp4",
      recorderContractVersion: 1,
      remediation: "No action is required",
      schemaVersion: 3,
      status: "passed",
      summary: "Recording completed successfully",
    });
    assert.deepEqual(output.paths, {
      outputPath: join(
        destinationDirectory,
        "browser-recording-2026-07-16-143122.mp4",
      ),
    });
    assert.equal(readFileSync(output.paths.outputPath, "utf8"), "validated-video");
    assert.equal(existsSync(dirname(transaction.capturePath)), false);
    assert.equal(statSync(output.paths.outputPath).mode & 0o077, 0);
  } finally {
    rmSync(destinationDirectory, { force: true, recursive: true });
  }
});

test("adds a short recording ID instead of overwriting a filename collision", async () => {
  const destinationDirectory = mkdtempSync(
    join(tmpdir(), "browser-recorder-collision-"),
  );
  const outputFilename = "browser-recording-2026-07-16-143122.mp4";
  const originalPath = join(destinationDirectory, outputFilename);
  writeFileSync(originalPath, "existing-video");
  try {
    const transaction = await createTransaction({
      _dependencies: {
        randomUUID: () => "12345678-1234-1234-1234-123456789abc",
      },
      destinationDirectory,
      outputFilename,
    });
    writeFileSync(transaction.capturePath, "new-video");

    const output = await transaction.finalize({
      capture: captureResult(),
      ffprobePath: "/opt/ffprobe",
    });

    assert.equal(readFileSync(originalPath, "utf8"), "existing-video");
    assert.equal(
      basename(output.paths.outputPath),
      "browser-recording-2026-07-16-143122-12345678.mp4",
    );
    assert.equal(output.result.outputFile, basename(output.paths.outputPath));
    assert.equal(readFileSync(output.paths.outputPath, "utf8"), "new-video");
  } finally {
    rmSync(destinationDirectory, { force: true, recursive: true });
  }
});

test("keeps a committed Saved Recording successful when Working cleanup fails", async () => {
  const destinationDirectory = mkdtempSync(
    join(tmpdir(), "browser-recorder-committed-"),
  );
  const privateDiagnostic = "private post-commit cleanup diagnostic";
  try {
    const transaction = await createTransaction({
      _dependencies: {
        rm: async (path, options) => {
          if (path === destinationDirectory || options?.recursive !== true) {
            rmSync(path, options);
            return;
          }
          throw new Error(privateDiagnostic);
        },
      },
      destinationDirectory,
    });
    const workingDirectory = dirname(transaction.capturePath);
    writeFileSync(transaction.capturePath, "committed-video");

    const output = await transaction.finalize({
      capture: captureResult(),
      ffprobePath: "/opt/ffprobe",
    });

    assert.equal(output.result.status, "passed");
    assert.equal(readFileSync(output.paths.outputPath, "utf8"), "committed-video");
    assert.equal(output.paths.cleanupDirectory, workingDirectory);
    assert.equal(existsSync(workingDirectory), true);
    assert.equal(JSON.stringify(output).includes(privateDiagnostic), false);
  } finally {
    rmSync(destinationDirectory, { force: true, recursive: true });
  }
});

test("memoizes finalization and validates a successful capture once", async () => {
  let validationCalls = 0;
  const transaction = await createTransaction({
    _dependencies: {
      validateVideo: async () => {
        validationCalls += 1;
        return expectedValidation;
      },
    },
  });
  writeFileSync(transaction.capturePath, "validated-video");

  const first = transaction.finalize({
    capture: captureResult(),
    ffprobePath: "/opt/ffprobe",
  });
  const second = transaction.finalize({
    capture: captureResult(),
    ffprobePath: "/different/ffprobe",
  });

  assert.equal(first, second);
  await first;
  assert.equal(validationCalls, 1);
});

test("discards a rejected Working Recording without publishing it", async () => {
  const destinationDirectory = mkdtempSync(
    join(tmpdir(), "browser-recorder-rejected-"),
  );
  try {
    const transaction = await createTransaction({
      _dependencies: {
        validateVideo: async () => {
          throw validationFailure("codec_invalid");
        },
      },
      destinationDirectory,
    });
    writeFileSync(transaction.capturePath, "invalid-video");

    const output = await transaction.finalize({
      capture: captureResult(),
      ffprobePath: "/opt/ffprobe",
    });

    assert.equal(output.result.status, "failed");
    assert.equal(output.result.failureCode, "codec_invalid");
    assert.equal(output.result.media, null);
    assert.deepEqual(output.paths, {});
    assert.equal(existsSync(dirname(transaction.capturePath)), false);
    assert.equal(
      existsSync(join(destinationDirectory, output.result.outputFile)),
      false,
    );
  } finally {
    rmSync(destinationDirectory, { force: true, recursive: true });
  }
});

test("discards a bounded coordinator-selected capture failure without validation", async () => {
  let validationCalled = false;
  const transaction = await createTransaction({
    _dependencies: {
      validateVideo: async () => {
        validationCalled = true;
      },
    },
  });
  const output = await transaction.finalize({
    capture: captureResult({ encoderExitCode: 7 }),
    failureCode: "encoder_failed",
    ffprobePath: "/opt/ffprobe",
  });

  assert.equal(validationCalled, false);
  assert.equal(output.result.failureCode, "encoder_failed");
  assert.equal(output.result.capture.encoderExitCode, 7);
  assert.deepEqual(output.paths, {});
  assert.equal(existsSync(dirname(transaction.capturePath)), false);
});

test("discards media when validation throws an unexpected private failure", async () => {
  const transaction = await createTransaction({
    _dependencies: {
      validateVideo: async () => {
        throw new Error("private unexpected validator diagnostic");
      },
    },
  });
  const workingDirectory = dirname(transaction.capturePath);
  writeFileSync(transaction.capturePath, "untrusted-video");

  await assert.rejects(
    transaction.finalize({
      capture: captureResult(),
      failureCode: null,
      ffprobePath: "/opt/ffprobe",
    }),
    (error) =>
      assertBoundedFailure(error, "recording_failed", [
        "private unexpected validator diagnostic",
      ]),
  );
  assert.equal(existsSync(workingDirectory), false);
});

test("reports a failed-outcome cleanup path only when automatic discard fails", async () => {
  const transaction = await createTransaction({
    _dependencies: {
      rm: async (path, options) => {
        if (options?.recursive === true) {
          throw new Error("private discard diagnostic");
        }
        rmSync(path, options);
      },
      validateVideo: async () => {
        throw validationFailure("codec_invalid");
      },
    },
  });
  const workingDirectory = dirname(transaction.capturePath);
  writeFileSync(transaction.capturePath, "invalid-video");

  const output = await transaction.finalize({
    capture: captureResult(),
    ffprobePath: "/opt/ffprobe",
  });

  assert.equal(output.result.status, "failed");
  assert.deepEqual(output.paths, {
    cleanupDirectory: workingDirectory,
  });
  assert.equal(JSON.stringify(output).includes("private discard"), false);
});

test("retains the Working Recording when durable publication fails", async () => {
  const privateDiagnostic = "private copy diagnostic";
  const transaction = await createTransaction({
    _dependencies: {
      copyFile: async () => {
        throw new Error(privateDiagnostic);
      },
    },
  });
  const workingDirectory = dirname(transaction.capturePath);
  writeFileSync(transaction.capturePath, "recoverable-video");

  let publicError;
  await assert.rejects(
    transaction.finalize({
      capture: captureResult(),
      ffprobePath: "/opt/ffprobe",
    }),
    (error) => {
      publicError = error;
      return assertBoundedFailure(
        error,
        "saved_recording_persistence_failed",
        [privateDiagnostic],
      );
    },
  );
  assert.equal(existsSync(transaction.capturePath), true);
  assert.deepEqual(getRecordingCleanupDetails(publicError), {
    cleanupIncomplete: true,
    directory: workingDirectory,
  });
});

test("retains a validated Working Recording when result persistence fails", async () => {
  const transaction = await createTransaction({
    _dependencies: {
      writeFile: async () => {
        throw new Error("private result diagnostic");
      },
    },
  });
  const workingDirectory = dirname(transaction.capturePath);
  writeFileSync(transaction.capturePath, "recoverable-video");

  let publicError;
  await assert.rejects(
    transaction.finalize({
      capture: captureResult(),
      failureCode: null,
      ffprobePath: "/opt/ffprobe",
    }),
    (error) => {
      publicError = error;
      return assertBoundedFailure(
        error,
        "saved_recording_persistence_failed",
        ["private result diagnostic"],
      );
    },
  );
  assert.equal(existsSync(transaction.capturePath), true);
  assert.deepEqual(getRecordingCleanupDetails(publicError), {
    cleanupIncomplete: true,
    directory: workingDirectory,
  });
});

test("reports a destination partial when pre-commit cleanup also fails", async () => {
  const destinationDirectory = mkdtempSync(
    join(tmpdir(), "browser-recorder-partial-"),
  );
  const recordingId = "12345678-1234-1234-1234-123456789abc";
  let publicationStarted = false;
  try {
    const transaction = await createTransaction({
      _dependencies: {
        link: async () => {
          if (!publicationStarted) return;
          throw new Error("private publish diagnostic");
        },
        randomUUID: () => recordingId,
        rm: async (path, options) => {
          if (publicationStarted && path.endsWith(".partial")) {
            throw new Error("private partial cleanup diagnostic");
          }
          rmSync(path, options);
        },
        copyFile: async (source, destination) => {
          publicationStarted = true;
          writeFileSync(destination, readFileSync(source));
        },
      },
      destinationDirectory,
    });
    const workingDirectory = dirname(transaction.capturePath);
    writeFileSync(transaction.capturePath, "recoverable-video");

    let publicError;
    await assert.rejects(
      transaction.finalize({
        capture: captureResult(),
        failureCode: null,
        ffprobePath: "/opt/ffprobe",
      }),
      (error) => {
        publicError = error;
        return error.code === "saved_recording_persistence_failed";
      },
    );
    assert.deepEqual(getRecordingCleanupDetails(publicError), {
      cleanupFile: join(
        destinationDirectory,
        ".browser-recording-2026-07-16-143122.mp4.12345678-1234-1234-1234-123456789abc.partial",
      ),
      cleanupIncomplete: true,
      directory: workingDirectory,
    });
  } finally {
    rmSync(destinationDirectory, { force: true, recursive: true });
  }
});

test("discards a failed capture even when private result persistence is unavailable", async () => {
  const transaction = await createTransaction({
    _dependencies: {
      writeFile: async () => {
        throw new Error("private result diagnostic");
      },
    },
  });
  const workingDirectory = dirname(transaction.capturePath);
  writeFileSync(transaction.capturePath, "failed-video");

  const output = await transaction.finalize({
    capture: captureResult({ encoderExitCode: 7 }),
    failureCode: "encoder_failed",
    ffprobePath: "/opt/ffprobe",
  });

  assert.equal(output.result.failureCode, "encoder_failed");
  assert.equal(existsSync(workingDirectory), false);
});

test("does not let rollback erase a Working Recording retained by finalization", async () => {
  const transaction = await createTransaction({
    _dependencies: {
      copyFile: async () => {
        throw new Error("private copy diagnostic");
      },
    },
  });
  writeFileSync(transaction.capturePath, "recoverable-video");

  const finalization = transaction.finalize({
    capture: captureResult(),
    failureCode: null,
    ffprobePath: "/opt/ffprobe",
  });
  const rollback = transaction.rollback();

  await assert.rejects(finalization, {
    code: "saved_recording_persistence_failed",
  });
  await rollback;
  assert.equal(existsSync(transaction.capturePath), true);
});

test("rolls back the private Working Recording idempotently", async () => {
  const transaction = await createTransaction();
  const workingDirectory = dirname(transaction.capturePath);
  writeFileSync(transaction.capturePath, "working-video");

  const first = transaction.rollback();
  const second = transaction.rollback();

  assert.equal(first, second);
  await first;
  assert.equal(existsSync(workingDirectory), false);
});
