import { execFile } from "node:child_process";
import { open, stat } from "node:fs/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const MP4_BRANDS = new Set([
  "M4V ",
  "avc1",
  "iso2",
  "iso3",
  "iso4",
  "iso5",
  "iso6",
  "isom",
  "mp41",
  "mp42",
]);

class VideoValidationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "VideoValidationError";
    this.code = code;
  }
}

function validateConfiguration({
  durationToleranceSeconds,
  expectedDurationSeconds,
  ffprobePath,
  maxHeight,
  maxWidth,
  minBytes,
  outputPath,
}) {
  const positiveIntegers = [maxHeight, maxWidth, minBytes];
  if (
    typeof ffprobePath !== "string" ||
    ffprobePath.length === 0 ||
    typeof outputPath !== "string" ||
    outputPath.length === 0 ||
    !Number.isFinite(durationToleranceSeconds) ||
    durationToleranceSeconds < 0 ||
    !Number.isFinite(expectedDurationSeconds) ||
    expectedDurationSeconds <= 0 ||
    positiveIntegers.some(
      (value) => !Number.isInteger(value) || value <= 0,
    )
  ) {
    throw new VideoValidationError(
      "invalid_configuration",
      "Video validation configuration is invalid",
    );
  }
}

async function readMp4Brand(outputPath) {
  const handle = await open(outputPath, "r");
  try {
    const header = Buffer.alloc(12);
    const { bytesRead } = await handle.read(header, 0, header.length, 0);
    if (
      bytesRead !== header.length ||
      header.readUInt32BE(0) < 16 ||
      header.subarray(4, 8).toString("ascii") !== "ftyp"
    ) {
      return null;
    }
    return header.subarray(8, 12).toString("ascii");
  } finally {
    await handle.close();
  }
}

export async function validateVideo({
  durationToleranceSeconds,
  expectedDurationSeconds,
  ffprobePath,
  maxHeight,
  maxWidth,
  minBytes,
  outputPath,
  signal,
}) {
  if (signal != null && !(signal instanceof AbortSignal)) {
    throw new VideoValidationError(
      "invalid_configuration",
      "Video validation configuration is invalid",
    );
  }
  validateConfiguration({
    durationToleranceSeconds,
    expectedDurationSeconds,
    ffprobePath,
    maxHeight,
    maxWidth,
    minBytes,
    outputPath,
  });

  let file;
  try {
    file = await stat(outputPath);
  } catch {
    throw new VideoValidationError("output_missing", "Video output is missing");
  }

  if (!file.isFile() || file.size < minBytes) {
    throw new VideoValidationError(
      "output_too_small",
      "Video output is below the minimum size",
    );
  }

  let probe;
  try {
    const { stdout } = await execFileAsync(
      ffprobePath,
      [
        "-v",
        "error",
        "-show_streams",
        "-show_format",
        "-of",
        "json",
        outputPath,
      ],
      { encoding: "utf8", maxBuffer: 1024 * 1024, signal },
    );
    probe = JSON.parse(stdout);
  } catch {
    throw new VideoValidationError(
      "ffprobe_failed",
      "FFprobe could not parse the video output",
    );
  }

  const videoStreams = Array.isArray(probe.streams)
    ? probe.streams.filter((stream) => stream?.codec_type === "video")
    : [];
  if (videoStreams.length === 0) {
    throw new VideoValidationError(
      "video_stream_missing",
      "Video output has no video stream",
    );
  }
  if (videoStreams.length !== 1) {
    throw new VideoValidationError(
      "video_stream_count_invalid",
      "Video output must contain exactly one video stream",
    );
  }
  const [video] = videoStreams;

  const mp4Brand = await readMp4Brand(outputPath);
  if (
    !MP4_BRANDS.has(mp4Brand) ||
    !String(probe.format?.format_name ?? "")
      .split(",")
      .includes("mp4")
  ) {
    throw new VideoValidationError(
      "container_invalid",
      "Video output must use the MP4 container",
    );
  }
  if (video.codec_name !== "h264") {
    throw new VideoValidationError(
      "codec_invalid",
      "Video output must use the H.264 codec",
    );
  }
  if (video.pix_fmt !== "yuv420p") {
    throw new VideoValidationError(
      "pixel_format_invalid",
      "Video output must use the yuv420p pixel format",
    );
  }
  if (probe.streams.some((stream) => stream?.codec_type === "audio")) {
    throw new VideoValidationError(
      "audio_stream_present",
      "Video output must not contain audio",
    );
  }

  const width = Number(video.width);
  const height = Number(video.height);
  if (
    !Number.isInteger(width) ||
    width <= 0 ||
    width > maxWidth ||
    !Number.isInteger(height) ||
    height <= 0 ||
    height > maxHeight
  ) {
    throw new VideoValidationError(
      "dimensions_out_of_bounds",
      "Video dimensions are outside configured bounds",
    );
  }

  const durationSeconds = Number(video.duration ?? probe.format?.duration);
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    throw new VideoValidationError(
      "duration_invalid",
      "Video duration is invalid",
    );
  }
  if (
    Math.abs(durationSeconds - expectedDurationSeconds) >
    durationToleranceSeconds
  ) {
    throw new VideoValidationError(
      "duration_mismatch",
      "Video duration is inconsistent with the recording session",
    );
  }

  return {
    codecName: video.codec_name ?? null,
    durationSeconds,
    height,
    sizeBytes: file.size,
    width,
  };
}
