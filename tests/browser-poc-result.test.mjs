import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import test from "node:test";

import {
  finalizeBrowserPoc,
  prepareBrowserPoc,
} from "../poc/run-browser-poc.mjs";
import { resolveExecutable } from "./test-tools.mjs";

const temporaryRoot = mkdtempSync(join(tmpdir(), "browser-poc-result-test-"));
const ffmpegPath = resolveExecutable("ffmpeg");
const ffprobePath = resolveExecutable("ffprobe");

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

function finalizePrepared(paths, session, overrides = {}) {
  return finalizeBrowserPoc({
    durationToleranceSeconds: 0.25,
    ffprobePath,
    maxHeight: 720,
    maxWidth: 1280,
    minBytes: 100,
    outputPath: paths.outputPath,
    resultPath: paths.resultPath,
    session,
    ...overrides,
  });
}

test("prepares unique private paths under the configured temporary root", async () => {
  const first = await prepareBrowserPoc({ temporaryRoot });
  const second = await prepareBrowserPoc({ temporaryRoot });

  assert.notEqual(first.directory, second.directory);
  assert.equal(dirname(first.outputPath), first.directory);
  assert.equal(dirname(first.resultPath), first.directory);
  assert.equal(basename(first.outputPath), "recording.webm");
  assert.equal(basename(first.resultPath), "result.json");
  assert.equal(first.directory.startsWith(`${temporaryRoot}/`), true);
  assert.equal(statSync(first.directory).mode & 0o077, 0);
});

test("finalizes a valid capture into a sanitized private JSON result", async () => {
  const paths = await prepareBrowserPoc({ temporaryRoot });
  execFileSync(ffmpegPath, [
    "-hide_banner",
    "-loglevel",
    "error",
    "-f",
    "lavfi",
    "-i",
    "color=c=green:s=320x180:d=0.5",
    "-an",
    "-c:v",
    "libvpx",
    "-pix_fmt",
    "yuv420p",
    "-y",
    paths.outputPath,
  ]);
  const session = sessionWithResult({
    backpressureDrops: 2,
    framesDropped: 1,
    outputPath: paths.outputPath,
    secretPageValue: "must-not-persist",
    visibilityChanges: 1,
    visibilityState: false,
  });
  const result = await finalizePrepared(paths, session);
  const rawResult = readFileSync(paths.resultPath, "utf8");
  const persisted = JSON.parse(rawResult);

  assert.deepEqual(persisted, result);
  assert.equal(result.schemaVersion, 1);
  assert.equal(result.status, "passed");
  assert.equal(result.failureCode, null);
  assert.equal(result.videoFile, "recording.webm");
  assert.equal(result.capture.framesReceived, 5);
  assert.equal(result.validation.width, 320);
  assert.equal(result.validation.height, 180);
  assert.equal(rawResult.includes(temporaryRoot), false);
  assert.equal(rawResult.includes("must-not-persist"), false);
  assert.equal(statSync(paths.resultPath).mode & 0o077, 0);
});

test("persists a sanitized failed result when video validation fails", async () => {
  const paths = await prepareBrowserPoc({ temporaryRoot });
  const session = sessionWithResult({
    framesAcknowledged: 0,
    framesReceived: 0,
    lastFrameTimestamp: null,
    outputSamples: 0,
    visibilityState: null,
  });
  const result = await finalizePrepared(paths, session);
  const rawResult = readFileSync(paths.resultPath, "utf8");

  assert.deepEqual(JSON.parse(rawResult), result);
  assert.equal(result.status, "failed");
  assert.equal(result.failureCode, "output_missing");
  assert.equal(result.validation, null);
  assert.equal(rawResult.includes(temporaryRoot), false);
});

test("persists available counters without encoder diagnostics when capture fails", async () => {
  const paths = await prepareBrowserPoc({ temporaryRoot });
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

  const result = await finalizePrepared(paths, session);
  const rawResult = readFileSync(paths.resultPath, "utf8");

  assert.deepEqual(JSON.parse(rawResult), result);
  assert.equal(result.status, "failed");
  assert.equal(result.failureCode, "encoder_failed");
  assert.equal(result.capture.elapsedMs, null);
  assert.equal(result.capture.framesReceived, 3);
  assert.equal(result.capture.encoderExitCode, 7);
  assert.equal(result.validation, null);
  assert.equal(rawResult.includes(temporaryRoot), false);
  assert.equal(rawResult.includes("sensitive diagnostic"), false);
});

test("preserves a sanitized readiness failure after stopping the session", async () => {
  const paths = await prepareBrowserPoc({ temporaryRoot });
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
  const result = await finalizePrepared(paths, session, { captureError });
  const rawResult = readFileSync(paths.resultPath, "utf8");

  assert.equal(result.status, "failed");
  assert.equal(result.failureCode, "frame_stream_unavailable");
  assert.equal(result.validation, null);
  assert.equal(rawResult.includes(temporaryRoot), false);
});

test("persists the multiple-video-stream validation failure", async () => {
  const paths = await prepareBrowserPoc({ temporaryRoot });
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
  const result = await finalizePrepared(
    paths,
    sessionWithResult({ lastFrameTimestamp: 789.5 }),
  );

  assert.equal(result.status, "failed");
  assert.equal(result.failureCode, "video_stream_count_invalid");
  assert.equal(result.validation, null);
});
