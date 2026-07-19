import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { validateVideo } from "../plugins/codex-browser-recorder/skills/record-browser/scripts/validate-video.mjs";
import { resolveExecutable } from "./test-tools.mjs";

const directory = mkdtempSync(join(tmpdir(), "browser-recorder-validator-"));
const validPath = join(directory, "valid.mp4");
const multipleVideoPath = join(directory, "multiple-video.mp4");
const matroskaPath = join(directory, "not-mp4.mkv");
const wrongCodecPath = join(directory, "mpeg4.mp4");
const wrongPixelFormatPath = join(directory, "yuv444p.mp4");
const audioPath = join(directory, "with-audio.mp4");
const emptyPath = join(directory, "empty.mp4");
const corruptPath = join(directory, "corrupt.mp4");
const ffmpegPath = resolveExecutable("ffmpeg");
const ffprobePath = resolveExecutable("ffprobe");
const hangingProbePath = join(directory, "hanging-ffprobe.js");
const hangingProbeStartedPath = join(directory, "hanging-ffprobe-started");
const hangingProbeTerminatedPath = join(
  directory,
  "hanging-ffprobe-terminated",
);

writeFileSync(
  hangingProbePath,
  `#!/usr/bin/env node
const { writeFileSync } = require("node:fs");
writeFileSync(${JSON.stringify(hangingProbeStartedPath)}, "started");
process.on("SIGTERM", () => {
  writeFileSync(${JSON.stringify(hangingProbeTerminatedPath)}, "terminated");
  process.exit(0);
});
setInterval(() => {}, 1000);
`,
);
chmodSync(hangingProbePath, 0o700);

execFileSync(ffmpegPath, [
  "-hide_banner",
  "-loglevel",
  "error",
  "-f",
  "lavfi",
  "-i",
  "color=c=blue:s=320x180:d=0.5",
  "-an",
  "-c:v",
  "libx264",
  "-pix_fmt",
  "yuv420p",
  "-y",
  validPath,
]);
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
  "libx264",
  "-pix_fmt",
  "yuv420p",
  "-shortest",
  "-y",
  multipleVideoPath,
]);
execFileSync(ffmpegPath, [
  "-hide_banner",
  "-loglevel",
  "error",
  "-f",
  "lavfi",
  "-i",
  "color=c=blue:s=320x180:d=0.5",
  "-an",
  "-c:v",
  "libx264",
  "-pix_fmt",
  "yuv420p",
  "-f",
  "matroska",
  "-y",
  matroskaPath,
]);
execFileSync(ffmpegPath, [
  "-hide_banner",
  "-loglevel",
  "error",
  "-f",
  "lavfi",
  "-i",
  "color=c=blue:s=320x180:d=0.5",
  "-an",
  "-c:v",
  "mpeg4",
  "-pix_fmt",
  "yuv420p",
  "-y",
  wrongCodecPath,
]);
execFileSync(ffmpegPath, [
  "-hide_banner",
  "-loglevel",
  "error",
  "-f",
  "lavfi",
  "-i",
  "color=c=blue:s=320x180:d=0.5",
  "-an",
  "-c:v",
  "libx264",
  "-pix_fmt",
  "yuv444p",
  "-y",
  wrongPixelFormatPath,
]);
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
  "anullsrc=r=48000:cl=mono",
  "-t",
  "0.5",
  "-c:v",
  "libx264",
  "-c:a",
  "aac",
  "-pix_fmt",
  "yuv420p",
  "-y",
  audioPath,
]);
writeFileSync(emptyPath, "");
writeFileSync(corruptPath, "not a video");

test.after(() => {
  rmSync(directory, { force: true, recursive: true });
});

const defaults = {
  durationToleranceSeconds: 0.25,
  expectedDurationSeconds: 0.5,
  ffprobePath,
  maxHeight: 720,
  maxWidth: 1280,
  minBytes: 100,
};

async function waitForFile(path, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) return true;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return existsSync(path);
}

test("accepts a parseable video with plausible dimensions and duration", async () => {
  const result = await validateVideo({ ...defaults, outputPath: validPath });

  assert.equal(result.codecName, "h264");
  assert.equal(result.width, 320);
  assert.equal(result.height, 180);
  assert.ok(result.durationSeconds > 0);
  assert.ok(result.sizeBytes >= defaults.minBytes);
});

test("aborts the production FFprobe subprocess when validation is cancelled", async () => {
  const cancellation = new AbortController();
  const validation = validateVideo({
    ...defaults,
    ffprobePath: hangingProbePath,
    outputPath: validPath,
    signal: cancellation.signal,
  });

  assert.equal(await waitForFile(hangingProbeStartedPath), true);
  cancellation.abort();

  await assert.rejects(validation, (error) => error.code === "ffprobe_failed");
  assert.equal(await waitForFile(hangingProbeTerminatedPath), true);
});

test("rejects an empty output file", async () => {
  await assert.rejects(
    validateVideo({ ...defaults, outputPath: emptyPath }),
    (error) => error.code === "output_too_small",
  );
});

test("rejects a corrupt output file", async () => {
  await assert.rejects(
    validateVideo({ ...defaults, minBytes: 1, outputPath: corruptPath }),
    (error) => error.code === "ffprobe_failed",
  );
});

test("rejects dimensions above the configured bound", async () => {
  await assert.rejects(
    validateVideo({ ...defaults, maxWidth: 100, outputPath: validPath }),
    (error) => error.code === "dimensions_out_of_bounds",
  );
});

test("rejects a duration inconsistent with the recording session", async () => {
  await assert.rejects(
    validateVideo({
      ...defaults,
      expectedDurationSeconds: 10,
      outputPath: validPath,
    }),
    (error) => error.code === "duration_mismatch",
  );
});

test("rejects an output containing multiple video streams", async () => {
  await assert.rejects(
    validateVideo({ ...defaults, outputPath: multipleVideoPath }),
    (error) => error.code === "video_stream_count_invalid",
  );
});

test("rejects a Matroska container even when its video uses H.264", async () => {
  await assert.rejects(
    validateVideo({ ...defaults, outputPath: matroskaPath }),
    (error) => error.code === "container_invalid",
  );
});

test("rejects an MP4 video that does not use H.264", async () => {
  await assert.rejects(
    validateVideo({ ...defaults, outputPath: wrongCodecPath }),
    (error) => error.code === "codec_invalid",
  );
});

test("rejects an H.264 MP4 that is not yuv420p", async () => {
  await assert.rejects(
    validateVideo({ ...defaults, outputPath: wrongPixelFormatPath }),
    (error) => error.code === "pixel_format_invalid",
  );
});

test("rejects an H.264 MP4 that contains an audio stream", async () => {
  await assert.rejects(
    validateVideo({ ...defaults, outputPath: audioPath }),
    (error) => error.code === "audio_stream_present",
  );
});

test("rejects non-finite validation configuration", async () => {
  await assert.rejects(
    validateVideo({
      ...defaults,
      expectedDurationSeconds: Number.NaN,
      outputPath: validPath,
    }),
    (error) => error.code === "invalid_configuration",
  );
});

test("rejects invalid configured bounds before probing the output", async () => {
  await assert.rejects(
    validateVideo({
      ...defaults,
      maxWidth: 0,
      outputPath: join(directory, "does-not-exist.mp4"),
    }),
    (error) => error.code === "invalid_configuration",
  );
});
