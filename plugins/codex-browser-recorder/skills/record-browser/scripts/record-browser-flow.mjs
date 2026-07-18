import { tmpdir } from "node:os";

import { createRecording } from "./create-recording.mjs";
import { inspectLocalRecordingEnvironment } from "./doctor.mjs";
import { planSavedRecording } from "./recording-artifacts.mjs";
import {
  describeRecordingFailure,
  getRecordingCleanupDetails,
  sanitizeRecordingFailure,
} from "./recording-outcome.mjs";
import {
  DEFAULT_RECORDING_DURATION_MS,
  validateRecordingRequest,
} from "./recording-policy.mjs";

const ACTION_MODALITIES = new Set(["keyboard", "pointer", "programmatic"]);

function dependenciesWith(overrides = {}) {
  return {
    createSession: createRecording,
    inspectLocalEnvironment: inspectLocalRecordingEnvironment,
    planOutput: planSavedRecording,
    validateRequest: validateRecordingRequest,
    ...overrides,
  };
}

function blocker(code) {
  const failure = describeRecordingFailure(code);
  return Object.freeze({ code, ...failure });
}

function blocked(codes, output = null) {
  return Object.freeze({
    blockers: Object.freeze(codes.map(blocker)),
    output,
    status: "blocked",
  });
}

function publicEnvironment(environment) {
  return Object.freeze({
    ffmpegH264Available: environment?.ffmpegH264Available === true,
    ffmpegMp4Available: environment?.ffmpegMp4Available === true,
    ffprobeUsable: environment?.ffprobeUsable === true,
    outputDirectoryWritable: environment?.outputDirectoryWritable === true,
    platform:
      typeof environment?.platform === "string"
        ? environment.platform
        : "unknown",
    supported: environment?.supported === true,
  });
}

function publicOutput(savedRecording) {
  return Object.freeze({
    destinationDirectory: savedRecording.destinationDirectory,
    outputFilename: savedRecording.outputFilename,
  });
}

function normalizeActions(actions, durationWasExplicit) {
  if (!Array.isArray(actions)) {
    throw sanitizeRecordingFailure({ code: "invalid_configuration" });
  }
  if (actions.length === 0 && durationWasExplicit !== true) {
    throw sanitizeRecordingFailure({ code: "invalid_configuration" });
  }
  return Object.freeze(
    actions.map((action) => {
      const label = action?.label?.trim();
      if (
        typeof label !== "string" ||
        label.length === 0 ||
        label.length > 200 ||
        !ACTION_MODALITIES.has(action?.modality) ||
        typeof action?.perform !== "function"
      ) {
        throw sanitizeRecordingFailure({ code: "invalid_configuration" });
      }
      return Object.freeze({
        label,
        modality: action.modality,
        perform: action.perform,
      });
    }),
  );
}

function cleanupDetails({ errors = [], output } = {}) {
  const details = errors
    .map((error) => getRecordingCleanupDetails(error))
    .filter((value) => value !== null);
  return Object.freeze({
    artifactCleanupIncomplete:
      output?.cleanup?.artifactCleanupIncomplete === true ||
      details.some(
        ({ artifactCleanupIncomplete }) =>
          artifactCleanupIncomplete === true,
      ),
    browserTabCleanupIncomplete:
      output?.cleanup?.browserTabCleanupIncomplete === true ||
      details.some(
        ({ browserTabCleanupIncomplete }) =>
          browserTabCleanupIncomplete === true,
      ),
    directory:
      details.find(({ directory }) => typeof directory === "string")
        ?.directory ?? output?.paths?.cleanupDirectory ?? null,
    file:
      details.find(({ cleanupFile }) => typeof cleanupFile === "string")
        ?.cleanupFile ?? output?.paths?.cleanupFile ?? null,
  });
}

function failureOutcome(error, { output } = {}) {
  const publicError = sanitizeRecordingFailure(error);
  return Object.freeze({
    cleanup: cleanupDetails({ errors: [publicError], output }),
    failure: Object.freeze({
      code: publicError.code,
      remediation: publicError.remediation,
      summary: publicError.summary,
    }),
    paths: output?.paths ?? null,
    result: output?.result ?? null,
    status: ["cancelled", "recording_cancelled"].includes(publicError.code)
      ? "cancelled"
      : "failed",
  });
}

function terminalOutcome(output) {
  if (
    output?.result?.status === "passed" &&
    typeof output?.paths?.outputPath === "string" &&
    output.paths.outputPath.length > 0
  ) {
    return Object.freeze({
      cleanup: cleanupDetails({ output }),
      paths: output.paths,
      result: output.result,
      status: "completed",
    });
  }
  if (output?.result?.status === "failed") {
    return failureOutcome(
      { code: output.result.failureCode ?? "recording_failed" },
      { output },
    );
  }
  return failureOutcome({ code: "integration_failed" }, { output });
}

export function createRecordingFlow({ dependencies: overrides } = {}) {
  const dependencies = dependenciesWith(overrides);
  const preparedPlans = new WeakMap();
  const consumedPlans = new WeakSet();

  async function prepareRecording(spec = {}) {
    let savedRecording;
    try {
      savedRecording = dependencies.planOutput({
        destinationDirectory: spec.destinationDirectory,
        now: spec.now,
        recordingName: spec.recordingName,
      });
    } catch (error) {
      return blocked([sanitizeRecordingFailure(error).code]);
    }
    const output = publicOutput(savedRecording);

    if (
      spec.preflightOnly !== true &&
      spec.preflightOnly !== false &&
      spec.preflightOnly !== undefined
    ) {
      return blocked(["invalid_configuration"], output);
    }
    const browserSurface = spec.browserSurface ?? "chrome";
    if (spec.preflightOnly !== true && browserSurface !== "chrome") {
      return blocked(["browser_surface_unsupported"], output);
    }

    let actions;
    let request;
    let durationWasExplicit;
    if (spec.preflightOnly !== true) {
      try {
        durationWasExplicit = spec.durationWasExplicit === true;
        if (
          spec.durationWasExplicit !== true &&
          spec.durationWasExplicit !== false
        ) {
          throw sanitizeRecordingFailure({ code: "invalid_configuration" });
        }
        actions = normalizeActions(spec.actions, durationWasExplicit);
        request = dependencies.validateRequest({
          durationMs: durationWasExplicit
            ? spec.durationMs
            : DEFAULT_RECORDING_DURATION_MS,
          requirePointerEvents: actions.some(
            ({ modality }) => modality === "pointer",
          ),
          targetUrl: spec.targetUrl,
        });
      } catch (error) {
        return blocked([sanitizeRecordingFailure(error).code], output);
      }
    }

    let environment;
    try {
      environment = await dependencies.inspectLocalEnvironment({
        outputDirectory: savedRecording.destinationDirectory,
      });
    } catch (error) {
      return blocked([sanitizeRecordingFailure(error).code], output);
    }
    const blockerCodes = Array.isArray(environment?.blockingReasons)
      ? environment.blockingReasons
      : ["integration_failed"];
    if (environment?.supported !== true || blockerCodes.length > 0) {
      return blocked(
        blockerCodes.length > 0 ? blockerCodes : ["integration_failed"],
        output,
      );
    }

    if (spec.preflightOnly === true) {
      return Object.freeze({
        environment: publicEnvironment(environment),
        output,
        status: "preflight_passed",
      });
    }

    const consentActions = Object.freeze(
      actions.map(({ label, modality }) => Object.freeze({ label, modality })),
    );
    const consent = Object.freeze({
      actions: consentActions,
      approvedOrigin: request.approvedOrigin,
      browserSurface,
      end: Object.freeze(
        durationWasExplicit
          ? { durationMs: request.durationMs, kind: "duration" }
          : {
              hardLimitMs: request.durationMs,
              kind: "actions_complete",
            },
      ),
      output,
      requirePointerEvents: request.requirePointerEvents,
    });
    const prepared = Object.freeze({ consent, status: "prepared" });
    preparedPlans.set(
      prepared,
      Object.freeze({
        actions,
        durationWasExplicit,
        request,
        savedRecording,
        temporaryRoot: spec.temporaryRoot ?? tmpdir(),
      }),
    );
    return prepared;
  }

  async function recordApproved(prepared, { browser, signal } = {}) {
    const plan = preparedPlans.get(prepared);
    if (
      plan === undefined ||
      consumedPlans.has(prepared) ||
      browser == null ||
      (signal != null && !(signal instanceof AbortSignal))
    ) {
      return failureOutcome({ code: "invalid_configuration" });
    }
    consumedPlans.add(prepared);

    let session;
    let terminal = false;
    try {
      session = dependencies.createSession({
        browser,
        destinationDirectory: plan.savedRecording.destinationDirectory,
        durationMs: plan.request.durationMs,
        recordingName: plan.savedRecording.outputFilename.replace(
          /[.]mp4$/u,
          "",
        ),
        requirePointerEvents: plan.request.requirePointerEvents,
        signal,
        targetUrl: plan.request.targetUrl,
        temporaryRoot: plan.temporaryRoot,
      });
      const tab = await session.ready;
      for (const action of plan.actions) {
        await session.runAction({
          perform: () => action.perform({ tab }),
          requiresPointerEvidence: action.modality === "pointer",
        });
      }
      const output = plan.durationWasExplicit
        ? await session.finished
        : await session.stop();
      terminal = true;
      return terminalOutcome(output);
    } catch (error) {
      let output;
      let cleanupError;
      if (session != null && !terminal) {
        try {
          output = await session.stop();
        } catch (stopError) {
          cleanupError = stopError;
        }
      }
      const primary = sanitizeRecordingFailure(error);
      const cleanup = cleanupDetails({
        errors: [primary, cleanupError].filter(Boolean),
        output,
      });
      const outcome = failureOutcome(primary, { output });
      return Object.freeze({ ...outcome, cleanup });
    }
  }

  return Object.freeze({ prepareRecording, recordApproved });
}

const defaultFlow = createRecordingFlow();

export const prepareRecording = defaultFlow.prepareRecording;
export const recordApproved = defaultFlow.recordApproved;
