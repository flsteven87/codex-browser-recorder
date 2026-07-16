import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import {
  captureFailureCode,
  createRecordingOutcome,
  isVideoValidationFailure,
  sanitizeRecordingFailure,
} from "./recording-outcome.mjs";
import { validateVideo } from "./validate-video.mjs";

export async function prepareRecordingArtifacts({
  _dependencies = { chmod, mkdtemp, rm },
  onDirectoryCreated,
  temporaryRoot,
}) {
  let directory = null;
  try {
    directory = await _dependencies.mkdtemp(
      join(temporaryRoot, "codex-browser-recorder-"),
    );
    onDirectoryCreated?.(directory);
    await _dependencies.chmod(directory, 0o700);
  } catch {
    let cleanupDirectory;
    if (directory !== null) {
      try {
        await _dependencies.rm(directory, { force: true, recursive: true });
      } catch {
        cleanupDirectory = directory;
      }
    }
    throw sanitizeRecordingFailure(
      { code: "artifact_persistence_failed" },
      { cleanupDirectory },
    );
  }

  return {
    directory,
    outputPath: join(directory, "recording.webm"),
    resultPath: join(directory, "result.json"),
  };
}

export async function cleanupRecordingArtifacts(
  paths,
  { _dependencies = { rm } } = {},
) {
  if (
    typeof paths?.directory !== "string" ||
    paths.directory.length === 0
  ) {
    throw sanitizeRecordingFailure({ code: "invalid_configuration" });
  }

  try {
    await _dependencies.rm(paths.directory, { force: true, recursive: true });
  } catch {
    throw sanitizeRecordingFailure({ code: "cleanup_failed" });
  }
}

export async function finalizeRecordingArtifacts({
  _dependencies = { rm, validateVideo, writeFile },
  captureError,
  durationToleranceSeconds,
  ffprobePath,
  maxHeight,
  maxWidth,
  minBytes,
  outputPath,
  resultPath,
  session,
}) {
  let failureCode = captureFailureCode(captureError);
  let capture;
  try {
    capture = await session.stop();
  } catch (error) {
    capture = {
      ...session.stats?.framePump,
      ...session.stats?.resources,
      ...session.stats?.sink,
      elapsedMs: session.stats?.resources?.elapsedMs ?? null,
    };
    failureCode ??= captureFailureCode(error);
  }

  let validation = null;
  if (failureCode === null) {
    try {
      validation = await _dependencies.validateVideo({
        durationToleranceSeconds,
        expectedDurationSeconds: capture.elapsedMs / 1000,
        ffprobePath,
        maxHeight,
        maxWidth,
        minBytes,
        outputPath,
      });
    } catch (error) {
      if (!isVideoValidationFailure(error)) {
        throw sanitizeRecordingFailure(error);
      }
      failureCode = error.code;
    }
  }

  const result = createRecordingOutcome({
    capture,
    failureCode,
    outputFile: basename(outputPath),
    validation,
  });

  try {
    await _dependencies.writeFile(
      resultPath,
      `${JSON.stringify(result, null, 2)}\n`,
      {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      },
    );
  } catch {
    const directory = dirname(outputPath);
    let cleanupDirectory;
    try {
      await _dependencies.rm(directory, { force: true, recursive: true });
    } catch {
      cleanupDirectory = directory;
    }
    throw sanitizeRecordingFailure(
      { code: "artifact_persistence_failed" },
      { cleanupDirectory },
    );
  }
  return result;
}
