import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import test from "node:test";

import {
  cleanupRecordingArtifacts,
  finalizeRecordingArtifacts,
  prepareRecordingArtifacts,
} from "../plugins/codex-browser-recorder/skills/record-browser/scripts/recording-artifacts.mjs";
import {
  describeRecordingFailure,
  getRecordingCleanupDetails,
  sanitizeRecordingFailure,
} from "../plugins/codex-browser-recorder/skills/record-browser/scripts/recording-outcome.mjs";
import { resolveExecutable } from "./test-tools.mjs";

const temporaryRoot = mkdtempSync(join(tmpdir(), "recording-artifacts-test-"));
const ffmpegPath = resolveExecutable("ffmpeg");
const ffprobePath = resolveExecutable("ffprobe");

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
  codecName: "vp8",
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
  "ffmpeg_vp8_unavailable",
  "ffmpeg_webm_unavailable",
  "ffprobe_missing",
  "ffprobe_unusable",
  "output_directory_not_writable",
  "cancelled",
  "recording_cancelled",
  "origin_not_allowed",
  "origin_verification_failed",
  "origin_changed_during_recording",
  "event_stream_invalid",
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
  "video_stream_count_invalid",
  "video_stream_missing",
  "artifact_persistence_failed",
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

function sessionWithResult(overrides = {}) {
  return {
    async stop() {
      return captureResult(overrides);
    },
  };
}

function finalizeOptions(paths, session, overrides = {}) {
  return {
    durationToleranceSeconds: 0.25,
    ffprobePath,
    maxHeight: 720,
    maxWidth: 1280,
    minBytes: 100,
    outputPath: paths.outputPath,
    resultPath: paths.resultPath,
    session,
    ...overrides,
  };
}

function assertBoundedPersistenceFailure(error, privateDiagnostics) {
  const expected = describeRecordingFailure("artifact_persistence_failed");
  const serialized = `${error.message}\n${JSON.stringify(error)}`;

  assert.equal(error.code, "artifact_persistence_failed");
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
    assert.equal(sanitized.summary, first.summary, code);
    assert.equal(sanitized.remediation, first.remediation, code);
    assert.equal("cause" in sanitized, false, code);
    assert.equal("diagnostic" in sanitized, false, code);
    assert.equal(JSON.stringify(sanitized).includes(injectedDiagnostic), false);
  }
});

test("normalizes an unknown recording failure to the generic public contract", () => {
  const injectedDiagnostic = "unknown private diagnostic";
  const sanitized = sanitizeRecordingFailure(
    Object.assign(new Error(injectedDiagnostic), {
      code: "unknown_private_failure",
    }),
  );

  assert.equal(sanitized.code, "recording_failed");
  assert.deepEqual(
    {
      remediation: sanitized.remediation,
      summary: sanitized.summary,
    },
    describeRecordingFailure("recording_failed"),
  );
  assert.equal(JSON.stringify(sanitized).includes(injectedDiagnostic), false);
});

test("prepares unique private paths under the configured temporary root", async () => {
  const first = await prepareRecordingArtifacts({ temporaryRoot });
  const second = await prepareRecordingArtifacts({ temporaryRoot });

  assert.notEqual(first.directory, second.directory);
  assert.equal(dirname(first.outputPath), first.directory);
  assert.equal(dirname(first.resultPath), first.directory);
  assert.equal(basename(first.outputPath), "recording.webm");
  assert.equal(basename(first.resultPath), "result.json");
  assert.equal(first.directory.startsWith(`${temporaryRoot}/`), true);
  assert.equal(statSync(first.directory).mode & 0o077, 0);
});

test("bounds a temporary-directory creation failure", async () => {
  const privateDiagnostic = `${temporaryRoot}/private-mkdtemp-diagnostic`;
  let chmodCalled = false;
  let rmCalled = false;

  await assert.rejects(
    prepareRecordingArtifacts({
      _dependencies: {
        chmod: async () => {
          chmodCalled = true;
        },
        mkdtemp: async () => {
          throw new Error(privateDiagnostic);
        },
        rm: async () => {
          rmCalled = true;
        },
      },
      temporaryRoot,
    }),
    (error) => assertBoundedPersistenceFailure(error, [privateDiagnostic]),
  );
  assert.equal(chmodCalled, false);
  assert.equal(rmCalled, false);
});

test("removes a created directory when permission hardening fails", async () => {
  const privateDiagnostic = "private chmod diagnostic";
  let createdDirectory;

  await assert.rejects(
    prepareRecordingArtifacts({
      _dependencies: {
        chmod: async () => {
          throw new Error(privateDiagnostic);
        },
        mkdtemp: async (prefix) => {
          createdDirectory = await mkdtemp(prefix);
          return createdDirectory;
        },
        rm,
      },
      temporaryRoot,
    }),
    (error) => assertBoundedPersistenceFailure(error, [privateDiagnostic]),
  );
  assert.equal(existsSync(createdDirectory), false);
});

test("keeps preparation failure primary when directory rollback fails", async () => {
  const createdDirectory = `${temporaryRoot}/private-created-directory`;
  const chmodDiagnostic = "private chmod failure";
  const rollbackDiagnostic = "private preparation rollback failure";
  const rmCalls = [];

  await assert.rejects(
    prepareRecordingArtifacts({
      _dependencies: {
        chmod: async () => {
          throw new Error(chmodDiagnostic);
        },
        mkdtemp: async () => createdDirectory,
        rm: async (...args) => {
          rmCalls.push(args);
          throw new Error(rollbackDiagnostic);
        },
      },
      temporaryRoot,
    }),
    (error) => {
      assertBoundedPersistenceFailure(error, [
        createdDirectory,
        chmodDiagnostic,
        rollbackDiagnostic,
      ]);
      assert.deepEqual(getRecordingCleanupDetails(error), {
        cleanupIncomplete: true,
        directory: createdDirectory,
      });
      return true;
    },
  );
  assert.deepEqual(rmCalls, [
    [createdDirectory, { force: true, recursive: true }],
  ]);
});

test("removes a prepared recording directory as one cleanup unit", async () => {
  const cleanupRoot = mkdtempSync(join(tmpdir(), "browser-recorder-cleanup-"));
  try {
    const paths = await prepareRecordingArtifacts({
      temporaryRoot: cleanupRoot,
    });
    writeFileSync(`${paths.outputPath}.partial`, "partial");

    await cleanupRecordingArtifacts(paths);
    assert.equal(existsSync(paths.directory), false);

    await cleanupRecordingArtifacts(paths);
    assert.equal(existsSync(paths.directory), false);
  } finally {
    rmSync(cleanupRoot, { force: true, recursive: true });
  }
});

test("bounds a cleanup-only failure without exposing its path", async () => {
  const secretPath = `${temporaryRoot}/private-recording`;
  await assert.rejects(
    cleanupRecordingArtifacts(
      { directory: secretPath },
      {
        _dependencies: {
          rm: async () => {
            throw new Error(secretPath);
          },
        },
      },
    ),
    (error) =>
      error.code === "cleanup_failed" &&
      !JSON.stringify(error).includes(secretPath),
  );
});

test("finalizes a valid capture into an exact schema-v3 private result", async () => {
  const paths = await prepareRecordingArtifacts({ temporaryRoot });
  const session = sessionWithResult({
    outputPath: paths.outputPath,
    secretPageValue: "must-not-persist",
  });
  await writeFile(paths.outputPath, "published-video");

  const result = await finalizeRecordingArtifacts({
    ...finalizeOptions(paths, session),
    _dependencies: {
      rm,
      validateVideo: async () => expectedValidation,
      writeFile,
    },
  });
  const rawResult = readFileSync(paths.resultPath, "utf8");

  assert.deepEqual(result, {
    capture: expectedCapture,
    failureCode: null,
    media: expectedValidation,
    outputFile: "recording.webm",
    recorderContractVersion: 1,
    remediation: "No action is required",
    schemaVersion: 3,
    status: "passed",
    summary: "Recording completed successfully",
  });
  assert.deepEqual(JSON.parse(rawResult), result);
  assert.equal(rawResult.includes(temporaryRoot), false);
  assert.equal(rawResult.includes("must-not-persist"), false);
  assert.equal(statSync(paths.resultPath).mode & 0o077, 0);
});

test("removes finalized media when result persistence fails", async () => {
  const paths = await prepareRecordingArtifacts({ temporaryRoot });
  const session = sessionWithResult();
  await writeFile(paths.outputPath, "published-video");

  await assert.rejects(
    finalizeRecordingArtifacts({
      ...finalizeOptions(paths, session),
      _dependencies: {
        rm,
        validateVideo: async () => expectedValidation,
        writeFile: async () => {
          throw new Error("private filesystem diagnostic");
        },
      },
    }),
    (error) =>
      error.code === "artifact_persistence_failed" &&
      !JSON.stringify(error).includes("private filesystem diagnostic"),
  );
  assert.equal(existsSync(paths.outputPath), false);
  assert.equal(existsSync(paths.resultPath), false);
});

test("preserves persistence failure precedence when rollback also fails", async () => {
  const paths = await prepareRecordingArtifacts({ temporaryRoot });
  const secret = "private rollback diagnostic";
  const removals = [];
  let persistenceError;
  await writeFile(paths.outputPath, "residual-finalized-media");

  await assert.rejects(
    finalizeRecordingArtifacts({
      ...finalizeOptions(paths, sessionWithResult()),
      _dependencies: {
        rm: async (...arguments_) => {
          removals.push(arguments_);
          throw new Error(secret);
        },
        validateVideo: async () => expectedValidation,
        writeFile: async () => {
          throw new Error("private persistence diagnostic");
        },
      },
    }),
    (error) => {
      persistenceError = error;
      assert.equal(error.code, "artifact_persistence_failed");
      assert.equal("cause" in error, false);
      assert.equal("diagnostic" in error, false);
      assert.doesNotMatch(JSON.stringify(error), /private .* diagnostic/);
      return true;
    },
  );
  assert.deepEqual(removals, [
    [paths.directory, { force: true, recursive: true }],
  ]);
  assert.equal(existsSync(paths.outputPath), true);
  assert.deepEqual(
    getRecordingCleanupDetails(persistenceError),
    {
      cleanupIncomplete: true,
      directory: paths.directory,
    },
  );
  assert.equal(JSON.stringify(persistenceError).includes(paths.directory), false);

  const resanitized = sanitizeRecordingFailure(persistenceError);
  assert.deepEqual(
    getRecordingCleanupDetails(resanitized),
    {
      cleanupIncomplete: true,
      directory: paths.directory,
    },
  );
});

test("persists a sanitized failed result when video validation fails", async () => {
  const paths = await prepareRecordingArtifacts({ temporaryRoot });
  const session = sessionWithResult({
    framesAcknowledged: 0,
    framesReceived: 0,
    lastFrameTimestamp: null,
    outputSamples: 0,
    visibilityState: null,
  });
  const result = await finalizeRecordingArtifacts(
    finalizeOptions(paths, session),
  );
  const rawResult = readFileSync(paths.resultPath, "utf8");

  assert.deepEqual(JSON.parse(rawResult), result);
  assert.equal(result.status, "failed");
  assert.equal(result.failureCode, "output_missing");
  assert.equal(result.media, null);
  assert.deepEqual(
    {
      remediation: result.remediation,
      summary: result.summary,
    },
    describeRecordingFailure("output_missing"),
  );
  assert.equal(rawResult.includes(temporaryRoot), false);
});

test("persists available counters without encoder diagnostics when capture fails", async () => {
  const paths = await prepareRecordingArtifacts({ temporaryRoot });
  const session = {
    stats: {
      framePump: {
        framesAcknowledged: 3,
        framesDropped: 1,
        framesReceived: 3,
        invalidFrames: 0,
        lastFrameTimestamp: 456.5,
        truncations: 0,
        visibilityChanges: 1,
        visibilityState: true,
      },
      sink: {
        backpressureDrops: 2,
        encoderExitCode: 7,
        outputSamples: 4,
      },
    },
    async stop() {
      const error = new Error(`Encoder failed near ${temporaryRoot}`);
      error.code = "encoder_failed";
      error.diagnostic = `sensitive diagnostic from ${temporaryRoot}`;
      throw error;
    },
  };

  const result = await finalizeRecordingArtifacts(
    finalizeOptions(paths, session),
  );
  const rawResult = readFileSync(paths.resultPath, "utf8");

  assert.deepEqual(JSON.parse(rawResult), result);
  assert.equal(result.status, "failed");
  assert.equal(result.failureCode, "encoder_failed");
  assert.equal(result.capture.elapsedMs, null);
  assert.equal(result.capture.framesReceived, 3);
  assert.equal(result.capture.encoderExitCode, 7);
  assert.equal(result.media, null);
  assert.equal(rawResult.includes(temporaryRoot), false);
  assert.equal(rawResult.includes("sensitive diagnostic"), false);
});

test("persists sanitized resource-limit telemetry when capture is terminated", async () => {
  const paths = await prepareRecordingArtifacts({ temporaryRoot });
  const session = {
    stats: {
      framePump: captureResult({ elapsedMs: undefined }),
      resources: {
        elapsedMs: 42,
        maxObservedOutputBytes: 2048,
        terminationReason: "recording_output_limit",
      },
      sink: {
        backpressureDrops: 0,
        encoderExitCode: 0,
        outputSamples: 3,
      },
    },
    async stop() {
      const error = new Error("Output limit reached");
      error.code = "recording_output_limit";
      throw error;
    },
  };

  const result = await finalizeRecordingArtifacts(
    finalizeOptions(paths, session),
  );

  assert.equal(result.failureCode, "recording_output_limit");
  assert.equal(result.capture.elapsedMs, 42);
  assert.equal(result.capture.maxObservedOutputBytes, 2048);
  assert.equal(result.capture.terminationReason, "recording_output_limit");
});

test("preserves a sanitized readiness failure after stopping the session", async () => {
  const paths = await prepareRecordingArtifacts({ temporaryRoot });
  const captureError = new Error(`No frames from ${temporaryRoot}`);
  captureError.code = "frame_stream_unavailable";
  const session = sessionWithResult({
    elapsedMs: 25,
    framesAcknowledged: 0,
    framesReceived: 0,
    lastFrameTimestamp: null,
    outputSamples: 0,
    visibilityState: null,
  });
  const result = await finalizeRecordingArtifacts(
    finalizeOptions(paths, session, { captureError }),
  );
  const rawResult = readFileSync(paths.resultPath, "utf8");

  assert.equal(result.status, "failed");
  assert.equal(result.failureCode, "frame_stream_unavailable");
  assert.equal(result.media, null);
  assert.equal(rawResult.includes(temporaryRoot), false);
});

test("persists the multiple-video-stream validation failure", async () => {
  const paths = await prepareRecordingArtifacts({ temporaryRoot });
  execFileSync(ffmpegPath, [
    "-hide_banner",
    "-loglevel",
    "error",
    "-f",
    "lavfi",
    "-i",
    "color=c=blue:s=320x180:d=0.5",
    "-f",
    "lavfi",
    "-i",
    "color=c=red:s=160x90:d=0.5",
    "-map",
    "0:v:0",
    "-map",
    "1:v:0",
    "-an",
    "-c:v",
    "libvpx",
    "-pix_fmt",
    "yuv420p",
    "-shortest",
    "-y",
    paths.outputPath,
  ]);
  const result = await finalizeRecordingArtifacts(
    finalizeOptions(
      paths,
      sessionWithResult({ lastFrameTimestamp: 789.5 }),
    ),
  );

  assert.equal(result.status, "failed");
  assert.equal(result.failureCode, "video_stream_count_invalid");
  assert.equal(result.media, null);
});

test("persists every strict media-contract failure code", async () => {
  const variants = [
    {
      code: "container_invalid",
      outputArguments: ["-an", "-c:v", "libvpx", "-f", "matroska"],
    },
    {
      code: "codec_invalid",
      outputArguments: ["-an", "-c:v", "libvpx-vp9"],
    },
    {
      code: "audio_stream_present",
      extraInput: ["-f", "lavfi", "-i", "anullsrc=r=48000:cl=mono"],
      outputArguments: ["-t", "0.5", "-c:v", "libvpx", "-c:a", "libopus"],
    },
  ];

  for (const variant of variants) {
    const paths = await prepareRecordingArtifacts({ temporaryRoot });
    execFileSync(ffmpegPath, [
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "lavfi",
      "-i",
      "color=c=blue:s=320x180:d=0.5",
      ...(variant.extraInput ?? []),
      ...variant.outputArguments,
      "-pix_fmt",
      "yuv420p",
      "-y",
      paths.outputPath,
    ]);

    const result = await finalizeRecordingArtifacts(
      finalizeOptions(paths, sessionWithResult()),
    );
    assert.equal(result.status, "failed");
    assert.equal(result.failureCode, variant.code);
    assert.equal(result.media, null);
  }
});
