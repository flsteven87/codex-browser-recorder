import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";

import { doctor } from "../plugins/codex-browser-recorder/skills/record-browser/scripts/doctor.mjs";

const directory = mkdtempSync(join(tmpdir(), "browser-recorder-doctor-"));
const binDirectory = join(directory, "bin");
const emptyBinDirectory = join(directory, "empty-bin");
const outputDirectory = join(directory, "output");
mkdirSync(binDirectory);
mkdirSync(emptyBinDirectory);
mkdirSync(outputDirectory);

for (const executable of ["ffmpeg", "ffprobe"]) {
  const executablePath = join(binDirectory, executable);
  writeFileSync(executablePath, "#!/bin/sh\nexit 0\n");
  chmodSync(executablePath, 0o755);
}

test.after(() => {
  rmSync(directory, { force: true, recursive: true });
});

test("reports a supported environment with resolved executable paths", async () => {
  const result = await doctor({
    cdpAvailable: true,
    outputDirectory,
    pathValue: [emptyBinDirectory, binDirectory].join(delimiter),
    platform: "darwin",
  });

  assert.equal(result.supported, true);
  assert.equal(result.platform, "darwin");
  assert.equal(result.cdpAvailable, true);
  assert.equal(result.ffmpegPath, join(binDirectory, "ffmpeg"));
  assert.equal(result.ffprobePath, join(binDirectory, "ffprobe"));
  assert.equal(result.outputDirectoryWritable, true);
  assert.deepEqual(result.blockingReasons, []);
});

test("returns every deterministic blocking reason without changing the system", async () => {
  const result = await doctor({
    cdpAvailable: false,
    outputDirectory: join(directory, "missing-output"),
    pathValue: emptyBinDirectory,
    platform: "linux",
  });

  assert.equal(result.supported, false);
  assert.equal(result.ffmpegPath, null);
  assert.equal(result.ffprobePath, null);
  assert.equal(result.outputDirectoryWritable, false);
  assert.deepEqual(result.blockingReasons, [
    "unsupported_platform",
    "cdp_unavailable",
    "ffmpeg_missing",
    "ffprobe_missing",
    "output_directory_not_writable",
  ]);
});

test("does not treat executable directories as ffmpeg binaries", async () => {
  const directoryBin = join(directory, "directory-bin");
  mkdirSync(directoryBin);
  mkdirSync(join(directoryBin, "ffmpeg"), { mode: 0o755 });
  mkdirSync(join(directoryBin, "ffprobe"), { mode: 0o755 });

  const result = await doctor({
    cdpAvailable: true,
    outputDirectory,
    pathValue: directoryBin,
    platform: "darwin",
  });

  assert.equal(result.ffmpegPath, null);
  assert.equal(result.ffprobePath, null);
  assert.deepEqual(result.blockingReasons, ["ffmpeg_missing", "ffprobe_missing"]);
});

test("supports the Browser runtime when global process metadata is unavailable", async () => {
  const result = await doctor({
    cdpAvailable: true,
    outputDirectory,
    pathValue: undefined,
    resolveExecutableByName: async (name) => name,
  });

  assert.equal(result.platform, "darwin");
  assert.equal(result.ffmpegPath, "ffmpeg");
  assert.equal(result.ffprobePath, "ffprobe");
  assert.equal(result.supported, true);
  assert.deepEqual(result.blockingReasons, []);
});

test("reports missing tools when inherited command resolution fails", async () => {
  const result = await doctor({
    cdpAvailable: true,
    outputDirectory,
    pathValue: undefined,
    platform: "darwin",
    resolveExecutableByName: async () => null,
  });

  assert.equal(result.ffmpegPath, null);
  assert.equal(result.ffprobePath, null);
  assert.deepEqual(result.blockingReasons, ["ffmpeg_missing", "ffprobe_missing"]);
});
