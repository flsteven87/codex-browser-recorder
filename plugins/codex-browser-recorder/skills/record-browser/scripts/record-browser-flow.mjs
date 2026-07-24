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
const CONTENT_WARNING =
  "The complete approved page viewport may include private, authenticated, or sensitive content. Continue only if you are authorized to record it and will handle the local file appropriately.";
const RECORDING_SURFACE = "Codex In-app Browser";
const SETUP_CLEANUP_TIMEOUT_MS = 5000;
const SETUP_OPERATION_TIMEOUT_MS = 5000;

function dependenciesWith(overrides = {}) {
  return {
    createSession: createRecording,
    inspectLocalEnvironment: inspectLocalRecordingEnvironment,
    planOutput: planSavedRecording,
    setupCleanupTimeoutMs: SETUP_CLEANUP_TIMEOUT_MS,
    setupOperationTimeoutMs: SETUP_OPERATION_TIMEOUT_MS,
    validateRequest: validateRecordingRequest,
    ...overrides,
  };
}

function setupOperationFailure(code) {
  return Object.assign(new Error(code), { code });
}

function runSetupOperation(
  operation,
  { signal, timeoutMs },
) {
  const operationPromise = Promise.resolve().then(operation);
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      callback(value);
    };
    const abort = () => {
      finish(reject, setupOperationFailure("setup_cancelled"));
    };
    const timer = setTimeout(() => {
      finish(reject, setupOperationFailure("setup_timeout"));
    }, timeoutMs);

    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted === true) abort();
    operationPromise.then(
      (value) => finish(resolve, value),
      (error) => finish(reject, error),
    );
  });
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

function publicEnvironment(
  environment,
  { codexInAppBrowserAvailable, fullCdpAvailable } = {},
) {
  return Object.freeze({
    ...(typeof codexInAppBrowserAvailable === "boolean"
      ? { codexInAppBrowserAvailable }
      : {}),
    ffmpegH264Available: environment?.ffmpegH264Available === true,
    ffmpegMp4Available: environment?.ffmpegMp4Available === true,
    ffprobeUsable: environment?.ffprobeUsable === true,
    ...(typeof fullCdpAvailable === "boolean"
      ? { fullCdpAvailable }
      : {}),
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
      const requiresChildFramePointerEvidence =
        action?.requiresChildFramePointerEvidence === true;
      const requiresFrameEvidence =
        action?.requiresFrameEvidence === true;
      if (
        typeof label !== "string" ||
        label.length === 0 ||
        label.length > 200 ||
        !ACTION_MODALITIES.has(action?.modality) ||
        typeof action?.perform !== "function" ||
        (action?.requiresChildFramePointerEvidence !== undefined &&
          typeof action.requiresChildFramePointerEvidence !== "boolean") ||
        (action?.requiresFrameEvidence !== undefined &&
          typeof action.requiresFrameEvidence !== "boolean") ||
        ((requiresChildFramePointerEvidence || requiresFrameEvidence) &&
          action.modality !== "pointer")
      ) {
        throw sanitizeRecordingFailure({ code: "invalid_configuration" });
      }
      return Object.freeze({
        label,
        modality: action.modality,
        perform: action.perform,
        requiresChildFramePointerEvidence,
        requiresFrameEvidence,
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
    resourceCleanupIncomplete:
      output?.cleanup?.resourceCleanupIncomplete === true ||
      details.some(
        ({ resourceCleanupIncomplete }) =>
          resourceCleanupIncomplete === true,
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
  const setupPlans = new WeakMap();
  const consumedSetupPlans = new WeakSet();

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
    if (Object.hasOwn(spec, "browserSurface")) {
      return blocked(["invalid_configuration"], output);
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
      const prepared = Object.freeze({
        environment: publicEnvironment(environment),
        output,
        status: "preflight_prepared",
      });
      setupPlans.set(prepared, Object.freeze({ environment, output }));
      return prepared;
    }

    const consentActions = Object.freeze(
      actions.map(({ label, modality }) => Object.freeze({ label, modality })),
    );
    const consent = Object.freeze({
      actions: consentActions,
      approvedOrigin: request.approvedOrigin,
      browserSurface: RECORDING_SURFACE,
      contentWarning: CONTENT_WARNING,
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

  async function checkSetup(
    prepared,
    { acquireBrowser, signal } = {},
  ) {
    const plan = setupPlans.get(prepared);
    if (
      plan === undefined ||
      consumedSetupPlans.has(prepared) ||
      typeof acquireBrowser !== "function" ||
      (signal != null && !(signal instanceof AbortSignal))
    ) {
      return blocked(["invalid_configuration"]);
    }
    consumedSetupPlans.add(prepared);
    if (signal?.aborted === true) {
      return blocked(["setup_cancelled"], plan.output);
    }

    let browser;
    let cleanupFailed = false;
    let diagnosticTab;
    let failureCode = null;
    let stage = "acquire_browser";
    let tabCreationSettlement;
    const cleanupDiagnosticTab = async (tab) => {
      const tabId =
        typeof tab?.id === "string" && tab.id.length > 0
          ? tab.id
          : null;
      await tab.close();
      const tabs = await browser.tabs.list();
      if (
        tabId === null ||
        !Array.isArray(tabs) ||
        tabs.some(({ id }) => id === tabId)
      ) {
        throw new Error("Owned setup diagnostic tab remains open");
      }
    };
    const cleanupOwnedDiagnosticTab = (tab) =>
      runSetupOperation(() => cleanupDiagnosticTab(tab), {
        timeoutMs: dependencies.setupCleanupTimeoutMs,
      });
    const bounded = (operation) =>
      runSetupOperation(operation, {
        signal,
        timeoutMs: dependencies.setupOperationTimeoutMs,
      });
    try {
      browser = await bounded(acquireBrowser);
      if (typeof browser?.tabs?.new !== "function") {
        failureCode = "browser_plugin_unavailable";
      } else {
        stage = "create_tab";
        const tabCreation = Promise.resolve().then(() =>
          browser.tabs.new(),
        );
        tabCreationSettlement = tabCreation.then(
          (value) => ({ status: "fulfilled", value }),
          (reason) => ({ reason, status: "rejected" }),
        );
        diagnosticTab = await bounded(() => tabCreation);
        if (typeof diagnosticTab?.capabilities?.get !== "function") {
          failureCode = "cdp_unavailable";
        } else {
          stage = "acquire_cdp";
          const cdp = await bounded(() =>
            diagnosticTab.capabilities.get("cdp"),
          );
          if (
            typeof cdp?.readEvents !== "function" ||
            typeof cdp?.send !== "function"
          ) {
            failureCode = "cdp_unavailable";
          }
        }
      }
    } catch (error) {
      failureCode = ["setup_cancelled", "setup_timeout"].includes(error?.code)
        ? error.code
        : ["acquire_browser", "create_tab"].includes(stage)
          ? "browser_plugin_unavailable"
          : "cdp_unavailable";
      if (
        ["setup_cancelled", "setup_timeout"].includes(failureCode) &&
        stage === "create_tab" &&
        tabCreationSettlement != null
      ) {
        try {
          const settlement = await runSetupOperation(
            () => tabCreationSettlement,
            { timeoutMs: dependencies.setupCleanupTimeoutMs },
          );
          if (settlement.status === "fulfilled") {
            diagnosticTab = settlement.value;
          }
        } catch {
          cleanupFailed = true;
          // The terminal result already reports cleanup incomplete. If the tab
          // appears later, make one best-effort close with its own deadline.
          void tabCreationSettlement
            .then((settlement) =>
              settlement.status === "fulfilled"
                ? cleanupOwnedDiagnosticTab(settlement.value)
                : undefined,
            )
            .catch(() => {});
        }
      }
    } finally {
      if (diagnosticTab != null) {
        try {
          await cleanupOwnedDiagnosticTab(diagnosticTab);
        } catch {
          cleanupFailed = true;
        }
      }
    }

    if (failureCode === null && signal?.aborted === true) {
      failureCode = "setup_cancelled";
    }
    if (failureCode !== null || cleanupFailed) {
      return blocked(
        [
          failureCode,
          ...(cleanupFailed ? ["browser_tab_cleanup_failed"] : []),
        ].filter(Boolean),
        plan.output,
      );
    }
    return Object.freeze({
      environment: publicEnvironment(plan.environment, {
        codexInAppBrowserAvailable: true,
        fullCdpAvailable: true,
      }),
      output: plan.output,
      status: "preflight_passed",
    });
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
          requiresChildFramePointerEvidence:
            action.requiresChildFramePointerEvidence,
          requiresFrameEvidence: action.requiresFrameEvidence,
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

  return Object.freeze({ checkSetup, prepareRecording, recordApproved });
}

const defaultFlow = createRecordingFlow();

export const checkSetup = defaultFlow.checkSetup;
export const prepareRecording = defaultFlow.prepareRecording;
export const recordApproved = defaultFlow.recordApproved;
