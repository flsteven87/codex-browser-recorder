import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  access,
  chmod,
  copyFile,
  link,
  mkdir,
  mkdtemp,
  open,
  rm,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { basename, isAbsolute, join, parse } from "node:path";

import {
  createRecordingOutcome,
  isVideoValidationFailure,
  sanitizeRecordingFailure,
} from "./recording-outcome.mjs";
import {
  RECORDING_MAX_HEIGHT,
  RECORDING_MAX_WIDTH,
} from "./recording-policy.mjs";
import { validateVideo } from "./validate-video.mjs";

const VIDEO_DURATION_TOLERANCE_SECONDS = 5;
const VIDEO_MINIMUM_BYTES = 100;

function artifactDependencies(overrides = {}) {
  return {
    access,
    chmod,
    copyFile,
    link,
    mkdir,
    mkdtemp,
    open,
    randomUUID,
    rm,
    stat,
    unlink,
    validateVideo,
    writeFile,
    ...overrides,
  };
}

function validateSavedRecordingConfiguration({
  destinationDirectory,
  outputFilename,
  temporaryRoot,
}) {
  if (
    typeof destinationDirectory !== "string" ||
    !isAbsolute(destinationDirectory) ||
    typeof temporaryRoot !== "string" ||
    !isAbsolute(temporaryRoot) ||
    typeof outputFilename !== "string" ||
    basename(outputFilename) !== outputFilename ||
    !outputFilename.endsWith(".mp4")
  ) {
    throw sanitizeRecordingFailure({ code: "invalid_configuration" });
  }
}

function collisionFilename(outputFilename, recordingId) {
  const { ext, name } = parse(outputFilename);
  return `${name}-${recordingId.slice(0, 8)}${ext}`;
}

function timestampForFilename(now) {
  const pad = (value) => String(value).padStart(2, "0");
  return [
    now.getFullYear(),
    "-",
    pad(now.getMonth() + 1),
    "-",
    pad(now.getDate()),
    "-",
    pad(now.getHours()),
    pad(now.getMinutes()),
    pad(now.getSeconds()),
  ].join("");
}

function normalizeDate(value) {
  let timestamp;
  try {
    timestamp = Date.prototype.getTime.call(value);
  } catch {
    throw sanitizeRecordingFailure({ code: "invalid_configuration" });
  }
  if (!Number.isFinite(timestamp)) {
    throw sanitizeRecordingFailure({ code: "invalid_configuration" });
  }
  return new Date(timestamp);
}

function cleanRecordingName(recordingName) {
  if (typeof recordingName !== "string") {
    throw sanitizeRecordingFailure({ code: "invalid_configuration" });
  }
  const normalized = recordingName
    .normalize("NFKC")
    .trim()
    .replace(/[.]mp4$/iu, "")
    .replace(/[^\p{L}\p{N}._ -]+/gu, "-")
    .replace(/\s+/gu, " ")
    .replace(/-{2,}/gu, "-")
    .replace(/^[ .-]+|[ .-]+$/gu, "");
  const cleaned = Array.from(normalized)
    .slice(0, 80)
    .join("")
    .replace(/[ .-]+$/gu, "");
  if (cleaned.length === 0) {
    throw sanitizeRecordingFailure({ code: "invalid_configuration" });
  }
  return cleaned;
}

export function planSavedRecording({
  destinationDirectory,
  homeDirectory = homedir(),
  now = new Date(),
  recordingName,
} = {}) {
  const normalizedDate = normalizeDate(now);
  const resolvedDestination =
    destinationDirectory ??
    join(homeDirectory, "Downloads", "Codex Browser Recordings");
  if (
    typeof resolvedDestination !== "string" ||
    !isAbsolute(resolvedDestination)
  ) {
    throw sanitizeRecordingFailure({ code: "invalid_configuration" });
  }
  const stem =
    recordingName === undefined
      ? `browser-recording-${timestampForFilename(normalizedDate)}`
      : cleanRecordingName(recordingName);
  return {
    destinationDirectory: resolvedDestination,
    outputFilename: `${stem}.mp4`,
  };
}

export async function createRecordingArtifactTransaction({
  _dependencies,
  destinationDirectory,
  outputFilename,
  temporaryRoot,
}) {
  validateSavedRecordingConfiguration({
    destinationDirectory,
    outputFilename,
    temporaryRoot,
  });
  const dependencies = artifactDependencies(_dependencies);

  let destinationProbe;
  let destinationLinkProbePath;
  let destinationProbePath;
  try {
    await dependencies.mkdir(destinationDirectory, {
      mode: 0o700,
      recursive: true,
    });
    const destination = await dependencies.stat(destinationDirectory);
    if (!destination.isDirectory()) throw new Error("Not a directory");
    await dependencies.access(destinationDirectory, constants.W_OK);
    destinationProbePath = join(
      destinationDirectory,
      `.codex-browser-recorder-${dependencies.randomUUID()}.probe`,
    );
    destinationProbe = await dependencies.open(
      destinationProbePath,
      "wx",
      0o600,
    );
    await destinationProbe.close();
    destinationProbe = null;
    destinationLinkProbePath = `${destinationProbePath}.linked`;
    await dependencies.link(destinationProbePath, destinationLinkProbePath);
    await dependencies.rm(destinationLinkProbePath, { force: true });
    destinationLinkProbePath = undefined;
    await dependencies.rm(destinationProbePath, { force: true });
    destinationProbePath = undefined;
  } catch {
    try {
      await destinationProbe?.close();
    } catch {
      // The destination is still rejected below.
    }
    for (const probePath of [destinationLinkProbePath, destinationProbePath]) {
      if (probePath === undefined) continue;
      try {
        await dependencies.rm(probePath, { force: true });
      } catch {
        // The destination is still rejected below.
      }
    }
    throw sanitizeRecordingFailure({ code: "saved_recording_unavailable" });
  }

  let workingDirectory;
  try {
    workingDirectory = await dependencies.mkdtemp(
      join(temporaryRoot, "codex-browser-recorder-"),
    );
    await dependencies.chmod(workingDirectory, 0o700);
  } catch {
    if (workingDirectory != null) {
      try {
        await dependencies.rm(workingDirectory, {
          force: true,
          recursive: true,
        });
      } catch {
        throw sanitizeRecordingFailure(
          { code: "artifact_persistence_failed" },
          { cleanupDirectory: workingDirectory },
        );
      }
    }
    throw sanitizeRecordingFailure({ code: "artifact_persistence_failed" });
  }

  const capturePath = join(workingDirectory, "recording.mp4");
  const resultPath = join(workingDirectory, "result.json");
  let finalizationPromise;
  let phase = "open";
  let rollbackPromise;

  async function discardWorkingRecording() {
    try {
      await dependencies.rm(workingDirectory, {
        force: true,
        recursive: true,
      });
      return undefined;
    } catch {
      return workingDirectory;
    }
  }

  async function finalize({ capture, failureCode = null, ffprobePath }) {
    let validation = null;
    if (failureCode === null) {
      try {
        validation = await dependencies.validateVideo({
          durationToleranceSeconds: VIDEO_DURATION_TOLERANCE_SECONDS,
          expectedDurationSeconds: capture.elapsedMs / 1000,
          ffprobePath,
          maxHeight: RECORDING_MAX_HEIGHT,
          maxWidth: RECORDING_MAX_WIDTH,
          minBytes: VIDEO_MINIMUM_BYTES,
          outputPath: capturePath,
        });
      } catch (error) {
        if (!isVideoValidationFailure(error)) {
          const cleanupDirectory = await discardWorkingRecording();
          throw sanitizeRecordingFailure(error, { cleanupDirectory });
        }
        failureCode = error.code;
      }
    }

    let result = createRecordingOutcome({
      capture,
      failureCode,
      outputFile: outputFilename,
      validation,
    });

    if (result.status !== "passed") {
      const cleanupDirectory = await discardWorkingRecording();
      return {
        paths:
          cleanupDirectory === undefined ? {} : { cleanupDirectory },
        result,
      };
    }

    try {
      await dependencies.writeFile(
        resultPath,
        `${JSON.stringify(result, null, 2)}\n`,
        { encoding: "utf8", flag: "wx", mode: 0o600 },
      );
    } catch {
      throw sanitizeRecordingFailure(
        { code: "saved_recording_persistence_failed" },
        { cleanupDirectory: workingDirectory },
      );
    }

    const recordingId = dependencies.randomUUID();
    const publishingPath = join(
      destinationDirectory,
      `.${outputFilename}.${recordingId}.partial`,
    );
    let savedRecordingPath = join(destinationDirectory, outputFilename);
    try {
      await dependencies.copyFile(
        capturePath,
        publishingPath,
        constants.COPYFILE_EXCL,
      );
      await dependencies.chmod(publishingPath, 0o600);
      try {
        await dependencies.link(publishingPath, savedRecordingPath);
      } catch (error) {
        if (error?.code !== "EEXIST") throw error;
        savedRecordingPath = join(
          destinationDirectory,
          collisionFilename(outputFilename, recordingId),
        );
        await dependencies.link(publishingPath, savedRecordingPath);
      }
    } catch {
      let cleanupFile;
      try {
        await dependencies.rm(publishingPath, { force: true });
      } catch {
        cleanupFile = publishingPath;
      }
      throw sanitizeRecordingFailure(
        { code: "saved_recording_persistence_failed" },
        { cleanupDirectory: workingDirectory, cleanupFile },
      );
    }

    if (basename(savedRecordingPath) !== result.outputFile) {
      result = createRecordingOutcome({
        capture,
        failureCode,
        outputFile: basename(savedRecordingPath),
        validation,
      });
      try {
        await dependencies.writeFile(
          resultPath,
          `${JSON.stringify(result, null, 2)}\n`,
          { encoding: "utf8", flag: "w", mode: 0o600 },
        );
      } catch {
        // A durable Saved Recording is already committed. Do not downgrade it.
      }
    }

    let cleanupFile;
    try {
      await dependencies.unlink(publishingPath);
    } catch {
      try {
        await dependencies.rm(publishingPath, { force: true });
      } catch {
        cleanupFile = publishingPath;
      }
    }
    let cleanupDirectory;
    try {
      await dependencies.rm(workingDirectory, {
        force: true,
        recursive: true,
      });
    } catch {
      cleanupDirectory = workingDirectory;
    }

    return {
      paths: {
        ...(cleanupDirectory === undefined ? {} : { cleanupDirectory }),
        ...(cleanupFile === undefined ? {} : { cleanupFile }),
        outputPath: savedRecordingPath,
      },
      result,
    };
  }

  return {
    capturePath,
    finalize(options) {
      if (finalizationPromise !== undefined) return finalizationPromise;
      if (phase !== "open") {
        finalizationPromise = Promise.reject(
          sanitizeRecordingFailure({ code: "invalid_configuration" }),
        );
        void finalizationPromise.catch(() => {});
        return finalizationPromise;
      }
      phase = "finalizing";
      finalizationPromise = finalize(options).finally(() => {
        phase = "terminal";
      });
      return finalizationPromise;
    },
    rollback() {
      if (rollbackPromise !== undefined) return rollbackPromise;
      if (phase !== "open") {
        rollbackPromise = Promise.resolve();
        return rollbackPromise;
      }
      phase = "rolling_back";
      rollbackPromise = dependencies
        .rm(workingDirectory, {
          force: true,
          recursive: true,
        })
        .catch(() => {
          throw sanitizeRecordingFailure(
            { code: "cleanup_failed" },
            { cleanupDirectory: workingDirectory },
          );
        })
        .finally(() => {
          phase = "terminal";
        });
      return rollbackPromise;
    },
  };
}
