import { execFile } from "node:child_process";
import { open, stat } from "node:fs/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const EBML_HEADER_ID = 0x1a45dfa3;
const EBML_DOCTYPE_ID = 0x4282;
const MAX_EBML_HEADER_BYTES = 4096;

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

function readVariableInteger(buffer, offset, { preserveMarker = false } = {}) {
  const first = buffer[offset];
  if (first === undefined || first === 0) return null;

  let marker = 0x80;
  let length = 1;
  while ((first & marker) === 0) {
    marker >>= 1;
    length += 1;
  }
  if (length > 8 || offset + length > buffer.length) return null;

  let value = BigInt(preserveMarker ? first : first & (marker - 1));
  for (let index = 1; index < length; index += 1) {
    value = (value << 8n) | BigInt(buffer[offset + index]);
  }

  if (!preserveMarker) {
    const unknownValue = (1n << BigInt(7 * length)) - 1n;
    if (value === unknownValue) return null;
  }
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) return null;

  return { length, value: Number(value) };
}

async function readEbmlDocType(outputPath) {
  const handle = await open(outputPath, "r");
  try {
    const buffer = Buffer.alloc(MAX_EBML_HEADER_BYTES);
    const { bytesRead } = await handle.read(
      buffer,
      0,
      MAX_EBML_HEADER_BYTES,
      0,
    );
    const header = buffer.subarray(0, bytesRead);
    const headerId = readVariableInteger(header, 0, { preserveMarker: true });
    if (headerId?.value !== EBML_HEADER_ID) return null;

    const headerSize = readVariableInteger(header, headerId.length);
    if (headerSize === null) return null;
    let offset = headerId.length + headerSize.length;
    const headerEnd = offset + headerSize.value;
    if (headerEnd > header.length) return null;

    while (offset < headerEnd) {
      const elementId = readVariableInteger(header, offset, {
        preserveMarker: true,
      });
      if (elementId === null || elementId.length > 4) return null;
      offset += elementId.length;

      const elementSize = readVariableInteger(header, offset);
      if (elementSize === null) return null;
      offset += elementSize.length;

      const elementEnd = offset + elementSize.value;
      if (elementEnd > headerEnd) return null;
      if (elementId.value === EBML_DOCTYPE_ID) {
        return header.subarray(offset, elementEnd).toString("ascii");
      }
      offset = elementEnd;
    }
    return null;
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
}) {
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
      { encoding: "utf8", maxBuffer: 1024 * 1024 },
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

  if ((await readEbmlDocType(outputPath)) !== "webm") {
    throw new VideoValidationError(
      "container_invalid",
      "Video output must use the WebM container",
    );
  }
  if (video.codec_name !== "vp8") {
    throw new VideoValidationError(
      "codec_invalid",
      "Video output must use the VP8 codec",
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
