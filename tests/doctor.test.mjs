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

writeFileSync(
  join(binDirectory, "ffmpeg"),
  [
    "#!/bin/sh",
    "case \"$*\" in",
    "  *\"encoder=libx264\"*) printf 'Encoder libx264 [libx264 H264]:\\n' ;;",
    "  *\"muxer=mp4\"*) printf 'Muxer mp4 [MP4]:\\n' ;;",
    "  *) printf 'ffmpeg version test\\n' ;;",
    "esac",
  ].join("\n"),
);
writeFileSync(
  join(binDirectory, "ffprobe"),
  [
    "#!/bin/sh",
    "case \"$*\" in",
    "  *\"-show_program_version\"*) printf '{\"program_version\":{\"version\":\"test\"}}\\n' ;;",
    "  *) printf 'ffprobe version test\\n' ;;",
    "esac",
  ].join("\n"),
);
chmodSync(join(binDirectory, "ffmpeg"), 0o755);
chmodSync(join(binDirectory, "ffprobe"), 0o755);

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
  assert.equal(result.ffmpegH264Available, true);
  assert.equal(result.ffmpegMp4Available, true);
  assert.equal(result.ffprobeUsable, true);
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
  assert.equal(result.ffmpegH264Available, false);
  assert.equal(result.ffmpegMp4Available, false);
  assert.equal(result.ffprobeUsable, false);
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
    probeMediaCapabilities: async () => ({
      ffmpegH264Available: true,
      ffmpegMp4Available: true,
      ffprobeUsable: true,
    }),
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
    probeMediaCapabilities: async () => ({
      ffmpegH264Available: true,
      ffmpegMp4Available: true,
      ffprobeUsable: true,
    }),
    resolveExecutableByName: async () => null,
  });

  assert.equal(result.ffmpegPath, null);
  assert.equal(result.ffprobePath, null);
  assert.equal(result.ffmpegH264Available, false);
  assert.equal(result.ffmpegMp4Available, false);
  assert.equal(result.ffprobeUsable, false);
  assert.deepEqual(result.blockingReasons, ["ffmpeg_missing", "ffprobe_missing"]);
});

for (const variant of [
  {
    name: "missing-h264",
    ffmpegH264Output: "H264 HELP OMITTED",
    ffmpegMp4Output: "Muxer mp4 [MP4]:",
    ffprobeOutput: '{"program_version":{"version":"test"}}',
    ffmpegH264Available: false,
    ffmpegMp4Available: true,
    ffprobeUsable: true,
    blockingReasons: ["ffmpeg_h264_unavailable"],
  },
  {
    name: "missing-mp4",
    ffmpegH264Output: "Encoder libx264 [libx264 H264]:",
    ffmpegMp4Output: "MP4 HELP OMITTED",
    ffprobeOutput: '{"program_version":{"version":"test"}}',
    ffmpegH264Available: true,
    ffmpegMp4Available: false,
    ffprobeUsable: true,
    blockingReasons: ["ffmpeg_mp4_unavailable"],
  },
  {
    name: "version-only-ffprobe",
    ffmpegH264Output: "Encoder libx264 [libx264 H264]:",
    ffmpegMp4Output: "Muxer mp4 [MP4]:",
    ffprobeOutput: "ffprobe version secret-test-token",
    ffmpegH264Available: true,
    ffmpegMp4Available: true,
    ffprobeUsable: false,
    blockingReasons: ["ffprobe_unusable"],
  },
  {
    name: "malformed-json-ffprobe",
    ffmpegH264Output: "Encoder libx264 [libx264 H264]:",
    ffmpegMp4Output: "Muxer mp4 [MP4]:",
    ffprobeOutput: '{"program_version":',
    ffmpegH264Available: true,
    ffmpegMp4Available: true,
    ffprobeUsable: false,
    blockingReasons: ["ffprobe_unusable"],
  },
  {
    name: "wrong-shape-ffprobe",
    ffmpegH264Output: "Encoder libx264 [libx264 H264]:",
    ffmpegMp4Output: "Muxer mp4 [MP4]:",
    ffprobeOutput: '{"program_version":{"version":7},"secret":"test-token"}',
    ffmpegH264Available: true,
    ffmpegMp4Available: true,
    ffprobeUsable: false,
    blockingReasons: ["ffprobe_unusable"],
  },
  {
    name: "all-unavailable",
    ffmpegH264Output: "H264 HELP OMITTED",
    ffmpegMp4Output: "MP4 HELP OMITTED",
    ffprobeOutput: "FFPROBE JSON OMITTED",
    ffmpegH264Available: false,
    ffmpegMp4Available: false,
    ffprobeUsable: false,
    blockingReasons: [
      "ffmpeg_h264_unavailable",
      "ffmpeg_mp4_unavailable",
      "ffprobe_unusable",
    ],
  },
]) {
  test(`reports ${variant.name} capabilities from exit-zero probe output`, async () => {
    const fixtureBinDirectory = join(directory, variant.name);
    mkdirSync(fixtureBinDirectory);
    writeFileSync(
      join(fixtureBinDirectory, "ffmpeg"),
      [
        "#!/bin/sh",
        "case \"$*\" in",
        `  *\"encoder=libx264\"*) printf '${variant.ffmpegH264Output}\\n' ;;`,
        `  *\"muxer=mp4\"*) printf '${variant.ffmpegMp4Output}\\n' ;;`,
        "esac",
        "exit 0",
      ].join("\n"),
    );
    writeFileSync(
      join(fixtureBinDirectory, "ffprobe"),
      `#!/bin/sh\nprintf '${variant.ffprobeOutput}\\n'\nexit 0\n`,
    );
    chmodSync(join(fixtureBinDirectory, "ffmpeg"), 0o755);
    chmodSync(join(fixtureBinDirectory, "ffprobe"), 0o755);

    const result = await doctor({
      cdpAvailable: true,
      outputDirectory,
      pathValue: fixtureBinDirectory,
      platform: "darwin",
    });

    assert.equal(result.supported, false);
    assert.equal(result.ffmpegH264Available, variant.ffmpegH264Available);
    assert.equal(result.ffmpegMp4Available, variant.ffmpegMp4Available);
    assert.equal(result.ffprobeUsable, variant.ffprobeUsable);
    assert.deepEqual(result.blockingReasons, variant.blockingReasons);
    assert.doesNotMatch(
      JSON.stringify(result),
      /Encoder libx264|Muxer mp4|ffprobe version|program_version|test-token|HELP OMITTED|JSON OMITTED/,
    );
  });
}
