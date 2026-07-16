import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { validateVideo } from "../plugins/codex-browser-recorder/skills/record-browser/scripts/validate-video.mjs";
import { resolveExecutable } from "./test-tools.mjs";

const directory = mkdtempSync(join(tmpdir(), "browser-recorder-validator-"));
const validPath = join(directory, "valid.webm");
const multipleVideoPath = join(directory, "multiple-video.webm");
const matroskaPath = join(directory, "not-webm.mkv");
const vp9Path = join(directory, "vp9.webm");
const audioPath = join(directory, "with-audio.webm");
const emptyPath = join(directory, "empty.webm");
const corruptPath = join(directory, "corrupt.webm");
const ffmpegPath = resolveExecutable("ffmpeg");
const ffprobePath = resolveExecutable("ffprobe");

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
  "libvpx",
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
  "libvpx",
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
  "libvpx",
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
  "libvpx-vp9",
  "-pix_fmt",
  "yuv420p",
  "-y",
  vp9Path,
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
  "libvpx",
  "-c:a",
  "libopus",
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

test("accepts a parseable video with plausible dimensions and duration", async () => {
  const result = await validateVideo({ ...defaults, outputPath: validPath });

  assert.equal(result.codecName, "vp8");
  assert.equal(result.width, 320);
  assert.equal(result.height, 180);
  assert.ok(result.durationSeconds > 0);
  assert.ok(result.sizeBytes >= defaults.minBytes);
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

test("rejects a Matroska container even when its video uses VP8", async () => {
  await assert.rejects(
    validateVideo({ ...defaults, outputPath: matroskaPath }),
    (error) => error.code === "container_invalid",
  );
});

test("rejects a WebM video that does not use VP8", async () => {
  await assert.rejects(
    validateVideo({ ...defaults, outputPath: vp9Path }),
    (error) => error.code === "codec_invalid",
  );
});

test("rejects a VP8 WebM that contains an audio stream", async () => {
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
      outputPath: join(directory, "does-not-exist.webm"),
    }),
    (error) => error.code === "invalid_configuration",
  );
});
