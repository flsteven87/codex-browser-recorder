import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { platform as hostPlatform } from "node:os";
import { delimiter, join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

async function resolveExecutableFromInheritedPath(name) {
  try {
    await execFileAsync(name, ["-version"], {
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
      timeout: 5000,
      windowsHide: true,
    });
    return name;
  } catch {
    return null;
  }
}

async function findExecutable(name, pathValue, resolveExecutableByName) {
  if (typeof pathValue !== "string") {
    try {
      const resolved = await resolveExecutableByName(name);
      return typeof resolved === "string" && resolved.length > 0
        ? resolved
        : null;
    } catch {
      return null;
    }
  }
  for (const directory of pathValue.split(delimiter).filter(Boolean)) {
    const candidate = join(directory, name);
    try {
      const candidateStat = await stat(candidate);
      if (candidateStat.isFile()) {
        await access(candidate, constants.X_OK);
        return candidate;
      }
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
  platform = hostPlatform(),
  resolveExecutableByName = resolveExecutableFromInheritedPath,
}) {
  const [ffmpegPath, ffprobePath] = await Promise.all([
    findExecutable("ffmpeg", pathValue, resolveExecutableByName),
    findExecutable("ffprobe", pathValue, resolveExecutableByName),
  ]);

  let outputDirectoryWritable = true;
  try {
    const outputStat = await stat(outputDirectory);
    if (!outputStat.isDirectory()) {
      throw new Error("Output path is not a directory");
    }
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
