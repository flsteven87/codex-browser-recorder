import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { delimiter, join } from "node:path";

async function findExecutable(name, pathValue) {
  for (const directory of pathValue.split(delimiter).filter(Boolean)) {
    const candidate = join(directory, name);
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Continue through the configured search path.
    }
  }
  return null;
}

export async function doctor({
  cdpAvailable,
  outputDirectory,
  pathValue,
  platform,
}) {
  const [ffmpegPath, ffprobePath] = await Promise.all([
    findExecutable("ffmpeg", pathValue),
    findExecutable("ffprobe", pathValue),
  ]);

  let outputDirectoryWritable = true;
  try {
    await access(outputDirectory, constants.W_OK);
  } catch {
    outputDirectoryWritable = false;
  }

  const blockingReasons = [];
  if (platform !== "darwin") {
    blockingReasons.push("unsupported_platform");
  }
  if (!cdpAvailable) {
    blockingReasons.push("cdp_unavailable");
  }
  if (ffmpegPath === null) {
    blockingReasons.push("ffmpeg_missing");
  }
  if (ffprobePath === null) {
    blockingReasons.push("ffprobe_missing");
  }
  if (!outputDirectoryWritable) {
    blockingReasons.push("output_directory_not_writable");
  }

  return {
    blockingReasons,
    cdpAvailable,
    ffmpegPath,
    ffprobePath,
    outputDirectoryWritable,
    platform,
    supported: blockingReasons.length === 0,
  };
}
