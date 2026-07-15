import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

class VideoValidationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "VideoValidationError";
    this.code = code;
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
}) {
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
      { encoding: "utf8", maxBuffer: 1024 * 1024 },
    );
    probe = JSON.parse(stdout);
  } catch {
    throw new VideoValidationError(
      "ffprobe_failed",
      "FFprobe could not parse the video output",
    );
  }

  const video = Array.isArray(probe.streams)
    ? probe.streams.find((stream) => stream?.codec_type === "video")
    : undefined;
  if (video === undefined) {
    throw new VideoValidationError(
      "video_stream_missing",
      "Video output has no video stream",
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
