import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { platform as hostPlatform } from "node:os";
import { delimiter, dirname, join } from "node:path";
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
  const [ffmpegH264Available, ffmpegMp4Available, ffprobeUsable] =
    await Promise.all([
      ffmpegPath === null
        ? false
        : commandMatches(
            ffmpegPath,
            ["-hide_banner", "-loglevel", "error", "-h", "encoder=libx264"],
            /^Encoder libx264 \[/m,
          ),
      ffmpegPath === null
        ? false
        : commandMatches(
            ffmpegPath,
            ["-hide_banner", "-loglevel", "error", "-h", "muxer=mp4"],
            /^Muxer mp4 \[/m,
          ),
      ffprobePath === null
        ? false
        : ffprobeSupportsJson(ffprobePath),
    ]);
  return { ffmpegH264Available, ffmpegMp4Available, ffprobeUsable };
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

async function outputDirectoryIsWritable(outputDirectory, { allowPlanned }) {
  let candidate = outputDirectory;
  while (typeof candidate === "string" && candidate.length > 0) {
    try {
      const candidateStat = await stat(candidate);
      if (!candidateStat.isDirectory()) return false;
      await access(candidate, constants.W_OK);
      return true;
    } catch (error) {
      if (!allowPlanned || error?.code !== "ENOENT") return false;
      const parent = dirname(candidate);
      if (parent === candidate) return false;
      candidate = parent;
    }
  }
  return false;
}

async function inspectEnvironment({
  allowPlannedOutputDirectory,
  cdpAvailable,
  includeCdp,
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
  const ffmpegH264Available =
    ffmpegPath !== null && capabilities.ffmpegH264Available === true;
  const ffmpegMp4Available =
    ffmpegPath !== null && capabilities.ffmpegMp4Available === true;
  const ffprobeUsable =
    ffprobePath !== null && capabilities.ffprobeUsable === true;

  const outputDirectoryWritable = await outputDirectoryIsWritable(
    outputDirectory,
    { allowPlanned: allowPlannedOutputDirectory },
  );

  const blockingReasons = [];
  if (platform !== "darwin") {
    blockingReasons.push("unsupported_platform");
  }
  if (includeCdp && !cdpAvailable) {
    blockingReasons.push("cdp_unavailable");
  }
  if (ffmpegPath === null) {
    blockingReasons.push("ffmpeg_missing");
  } else {
    if (!ffmpegH264Available) {
      blockingReasons.push("ffmpeg_h264_unavailable");
    }
    if (!ffmpegMp4Available) {
      blockingReasons.push("ffmpeg_mp4_unavailable");
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
    ...(includeCdp ? { cdpAvailable } : {}),
    ffmpegPath,
    ffmpegH264Available,
    ffmpegMp4Available,
    ffprobePath,
    ffprobeUsable,
    outputDirectoryWritable,
    platform,
    supported: blockingReasons.length === 0,
  };
}

export function inspectLocalRecordingEnvironment(options) {
  return inspectEnvironment({
    ...options,
    allowPlannedOutputDirectory: true,
    includeCdp: false,
  });
}

export function doctor(options) {
  return inspectEnvironment({
    ...options,
    allowPlannedOutputDirectory: false,
    includeCdp: true,
  });
}
