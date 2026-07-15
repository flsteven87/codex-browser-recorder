import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { platform as hostPlatform } from "node:os";
import { delimiter, join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

async function commandMatches(executable, arguments_, pattern) {
  try {
    const { stdout } = await execFileAsync(executable, arguments_, {
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
      timeout: 5000,
      windowsHide: true,
    });
    return pattern.test(stdout);
  } catch {
    return false;
  }
}

async function ffprobeSupportsJson(executable) {
  try {
    const { stdout } = await execFileAsync(
      executable,
      ["-v", "error", "-show_program_version", "-of", "json"],
      {
        encoding: "utf8",
        maxBuffer: 1024 * 1024,
        timeout: 5000,
        windowsHide: true,
      },
    );
    const parsed = JSON.parse(stdout);
    return (
      parsed !== null &&
      typeof parsed === "object" &&
      !Array.isArray(parsed) &&
      parsed.program_version !== null &&
      typeof parsed.program_version === "object" &&
      !Array.isArray(parsed.program_version) &&
      typeof parsed.program_version.version === "string" &&
      parsed.program_version.version.length > 0
    );
  } catch {
    return false;
  }
}

async function inspectMediaCapabilities(ffmpegPath, ffprobePath) {
  const [ffmpegVp8Available, ffmpegWebmAvailable, ffprobeUsable] =
    await Promise.all([
      ffmpegPath === null
        ? false
        : commandMatches(
            ffmpegPath,
            ["-hide_banner", "-loglevel", "error", "-h", "encoder=libvpx"],
            /^Encoder libvpx \[/m,
          ),
      ffmpegPath === null
        ? false
        : commandMatches(
            ffmpegPath,
            ["-hide_banner", "-loglevel", "error", "-h", "muxer=webm"],
            /^Muxer webm \[/m,
          ),
      ffprobePath === null
        ? false
        : ffprobeSupportsJson(ffprobePath),
    ]);
  return { ffmpegVp8Available, ffmpegWebmAvailable, ffprobeUsable };
}

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
  probeMediaCapabilities = inspectMediaCapabilities,
  resolveExecutableByName = resolveExecutableFromInheritedPath,
}) {
  const [ffmpegPath, ffprobePath] = await Promise.all([
    findExecutable("ffmpeg", pathValue, resolveExecutableByName),
    findExecutable("ffprobe", pathValue, resolveExecutableByName),
  ]);
  const capabilities = await probeMediaCapabilities(ffmpegPath, ffprobePath);
  const ffmpegVp8Available =
    ffmpegPath !== null && capabilities.ffmpegVp8Available === true;
  const ffmpegWebmAvailable =
    ffmpegPath !== null && capabilities.ffmpegWebmAvailable === true;
  const ffprobeUsable =
    ffprobePath !== null && capabilities.ffprobeUsable === true;

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
  } else {
    if (!ffmpegVp8Available) {
      blockingReasons.push("ffmpeg_vp8_unavailable");
    }
    if (!ffmpegWebmAvailable) {
      blockingReasons.push("ffmpeg_webm_unavailable");
    }
  }
  if (ffprobePath === null) {
    blockingReasons.push("ffprobe_missing");
  } else if (!ffprobeUsable) {
    blockingReasons.push("ffprobe_unusable");
  }
  if (!outputDirectoryWritable) {
    blockingReasons.push("output_directory_not_writable");
  }

  return {
    blockingReasons,
    cdpAvailable,
    ffmpegPath,
    ffmpegVp8Available,
    ffmpegWebmAvailable,
    ffprobePath,
    ffprobeUsable,
    outputDirectoryWritable,
    platform,
    supported: blockingReasons.length === 0,
  };
}
