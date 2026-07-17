import { tmpdir } from "node:os";

import { startBrowserRecordingForTab } from "./browser-recording.mjs";
import { doctor as inspectRecordingEnvironment } from "./doctor.mjs";
import {
  createRecordingArtifactTransaction,
  planSavedRecording,
} from "./recording-artifacts.mjs";
import {
  captureFailureCode,
  describeRecordingFailure,
  getRecordingCleanupDetails,
  sanitizeCaptureStatus,
  sanitizeRecordingFailure,
} from "./recording-outcome.mjs";
import {
  RECORDING_HARD_LIMIT_MS,
  validateRecordingRequest,
} from "./recording-policy.mjs";

export { describeRecordingFailure };

const ACTIVE_RECORDING_KEY = Symbol.for("codex-browser-recorder.active");
const ACTION_EVIDENCE_INTERVAL_MS = 50;
const ACTION_EVIDENCE_TIMEOUT_MS = 1000;
const CLEANUP_DEADLINE_MS = 5000;
const FINALIZATION_DEADLINE_MS = 10_000;
const TERMINAL_STATES = new Set(["cancelled", "completed", "failed"]);
const NATIVE_ADD_EVENT_LISTENER = AbortSignal.prototype.addEventListener;
const NATIVE_REMOVE_EVENT_LISTENER = AbortSignal.prototype.removeEventListener;
const NATIVE_ABORTED_GETTER = Object.getOwnPropertyDescriptor(
  AbortSignal.prototype,
  "aborted",
).get;

function addAbortListener(signal, listener) {
  Reflect.apply(NATIVE_ADD_EVENT_LISTENER, signal, ["abort", listener, {
    once: true,
  }]);
}

function isAborted(signal) {
  return Reflect.apply(NATIVE_ABORTED_GETTER, signal, []);
}

function removeAbortListener(signal, listener) {
  Reflect.apply(NATIVE_REMOVE_EVENT_LISTENER, signal, ["abort", listener]);
}

function awaitAbortable(operation, signal) {
  const operationPromise = Promise.resolve(operation);
  return new Promise((resolve, reject) => {
    let settled = false;
    const abort = () => {
      if (settled) return;
      settled = true;
      removeAbortListener(signal, abort);
      reject(sanitizeRecordingFailure({ code: "recording_cancelled" }));
    };

    addAbortListener(signal, abort);
    if (isAborted(signal)) abort();
    operationPromise.then(
      (value) => {
        if (settled) return;
        settled = true;
        removeAbortListener(signal, abort);
        resolve(value);
      },
      (error) => {
        if (settled) return;
        settled = true;
        removeAbortListener(signal, abort);
        reject(error);
      },
    );
  });
}

function clockNow(clock) {
  return typeof clock.now === "function" ? clock.now() : Date.now();
}

function hasPointerEvidenceAfterActionBoundary({
  actionStartedAtEpochMs,
  beforeEvents,
  capture,
}) {
  return (
    Number.isFinite(actionStartedAtEpochMs) &&
    Number.isInteger(beforeEvents) &&
    Number.isInteger(capture?.cursorEventsCaptured) &&
    capture.cursorEventsCaptured > beforeEvents &&
    Number.isFinite(capture?.cursorLastEventEpochMs) &&
    capture.cursorLastEventEpochMs >= actionStartedAtEpochMs
  );
}

function waitForClockDelay(clock, delayMs, signal) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clock.clearTimeout(timer);
      removeAbortListener(signal, abort);
      if (error == null) {
        resolve();
      } else {
        reject(error);
      }
    };
    const abort = () => {
      finish(sanitizeRecordingFailure({ code: "recording_cancelled" }));
    };

    timer = clock.setTimeout(() => finish(), delayMs);
    addAbortListener(signal, abort);
    if (isAborted(signal)) abort();
  });
}

function settleBeforeDeadline(
  operation,
  clock,
  deadlineMs = CLEANUP_DEADLINE_MS,
) {
  const operationPromise = Promise.resolve(operation);
  return new Promise((resolve) => {
    let settled = false;
    let timer;
    const finish = (settlement) => {
      if (settled) return;
      settled = true;
      clock.clearTimeout(timer);
      resolve(settlement);
    };
    timer = clock.setTimeout(
      () => finish({ status: "timed_out" }),
      deadlineMs,
    );
    operationPromise.then(
      (value) => finish({ status: "fulfilled", value }),
      (reason) => finish({ reason, status: "rejected" }),
    );
  });
}

function closeTabBestEffort(tab) {
  return Promise.resolve().then(() => {
    if (typeof tab?.close !== "function") {
      throw new Error("Fresh Browser tab cannot be closed");
    }
    return tab.close();
  });
}

async function createFreshTab(browser, signal, clock) {
  const operation = Promise.resolve().then(() => browser.tabs.new());
  try {
    return await awaitAbortable(operation, signal);
  } catch (error) {
    if (error?.code !== "recording_cancelled") throw error;

    const creation = await settleBeforeDeadline(operation, clock);
    if (creation.status === "rejected") {
      throw error;
    }
    if (creation.status === "timed_out") {
      void operation.then(
        (lateTab) => closeTabBestEffort(lateTab).catch(() => {}),
        () => {},
      );
      throw sanitizeRecordingFailure(error, {
        browserTabCleanupIncomplete: true,
      });
    }
    const cleanup = await settleBeforeDeadline(
      closeTabBestEffort(creation.value),
      clock,
    );
    if (cleanup.status !== "fulfilled") {
      throw sanitizeRecordingFailure(error, {
        browserTabCleanupIncomplete: true,
      });
    }
    throw error;
  }
}

async function prepareArtifactTransaction({
  dependencies,
  options,
  savedRecording,
  signal,
}) {
  let lateCleanupStarted = false;
  const cleanupLateTransaction = (transaction) => {
    if (lateCleanupStarted) return;
    lateCleanupStarted = true;
    void Promise.resolve()
      .then(() => transaction.rollback())
      .catch(() => {});
  };
  const preparation = Promise.resolve().then(() =>
    dependencies.createRecordingArtifactTransaction({
      destinationDirectory: savedRecording.destinationDirectory,
      outputFilename: savedRecording.outputFilename,
      signal,
      temporaryRoot: options.temporaryRoot ?? tmpdir(),
    }),
  );
  try {
    return await awaitAbortable(preparation, signal);
  } catch (error) {
    if (error?.code !== "recording_cancelled") throw error;

    const prepared = await settleBeforeDeadline(
      preparation,
      dependencies.clock,
    );
    if (prepared.status === "rejected") {
      throw error;
    }
    if (prepared.status === "timed_out") {
      void preparation.then(
        cleanupLateTransaction,
        () => {},
      );
      throw sanitizeRecordingFailure(error, {
        artifactCleanupIncomplete: true,
      });
    }
    const transaction = prepared.value;
    if (transaction == null) throw error;
    const cleanup = await settleBeforeDeadline(
      Promise.resolve().then(() => transaction.rollback()),
      dependencies.clock,
    );
    if (cleanup.status !== "fulfilled") {
      const details = getRecordingCleanupDetails(cleanup.reason);
      throw sanitizeRecordingFailure(error, {
        artifactCleanupIncomplete: details == null,
        cleanupDirectory: details?.directory,
        cleanupFile: details?.cleanupFile,
      });
    }
    throw error;
  }
}

function stateForFailureCode(code) {
  return ["cancelled", "recording_cancelled"].includes(code)
    ? "cancelled"
    : "failed";
}

function isBrowserApprovalDenial(error) {
  const message = error instanceof Error ? error.message : "";
  return /Browser Use rejected this action due to browser security policy[.] Reason: The user has requested that .+(?:should not be used|not be used on)/su.test(
    message,
  );
}

function sanitizeBrowserFailure(error, options) {
  return sanitizeRecordingFailure(
    {
      code: isBrowserApprovalDenial(error) ? "cancelled" : "integration_failed",
    },
    options,
  );
}

function sanitizeActionFailure(error) {
  if (!isBrowserApprovalDenial(error)) {
    return sanitizeRecordingFailure(error);
  }
  const cleanup = getRecordingCleanupDetails(error);
  return sanitizeRecordingFailure(
    { code: "cancelled" },
    {
      artifactCleanupIncomplete:
        cleanup?.artifactCleanupIncomplete === true,
      browserTabCleanupIncomplete:
        cleanup?.browserTabCleanupIncomplete === true,
      cleanupDirectory: cleanup?.directory,
      cleanupFile: cleanup?.cleanupFile,
    },
  );
}

function failedHandle(code) {
  const error = sanitizeRecordingFailure({ code });
  const failure = Promise.reject(error);
  void failure.catch(() => {});
  return {
    ready: failure,
    runAction: () => failure,
    status: () => ({ capture: null, state: "failed" }),
    stop: () => failure,
  };
}

async function startRecordingTransaction({
  artifacts,
  dependencies,
  getForcedFailureCode,
  options,
  request,
  signal,
  tab,
}) {
  let session;
  try {
    session = await dependencies.startBrowserRecordingForTab({
      approvedOrigin: request.approvedOrigin,
      ffmpegPath: options.ffmpegPath,
      firstFrameTimeoutMs: 5000,
      maxDurationMs: RECORDING_HARD_LIMIT_MS,
      outputPath: artifacts.capturePath,
      readTimeoutMs: 1000,
      requirePointerEvents: request.requirePointerEvents,
      resourceCheckIntervalMs: 1000,
      signal,
      tab,
    });
  } catch (error) {
    const cleanup = await settleBeforeDeadline(
      Promise.resolve().then(() =>
        artifacts.rollback(),
      ),
      dependencies.clock,
    );
    const cleanupDetails = getRecordingCleanupDetails(cleanup.reason);
    throw sanitizeRecordingFailure(
      {
        code:
          typeof error?.code === "string"
            ? error.code
            : "integration_failed",
      },
      {
        artifactCleanupIncomplete:
          cleanup.status !== "fulfilled" && cleanupDetails == null,
        cleanupDirectory: cleanupDetails?.directory,
        cleanupFile: cleanupDetails?.cleanupFile,
      },
    );
  }

  let captureError = null;
  let finalizationPromise;
  const ready = Promise.resolve(session.ready).catch((error) => {
    captureError = error;
    throw error;
  });
  if (typeof session.completion?.then === "function") {
    void session.completion.then(
      (outcome) => {
        if (outcome?.error) captureError ??= outcome.error;
      },
      (error) => {
        captureError ??= error;
      },
    );
  }

  return {
    completion: session.completion,
    ready,
    status() {
      return {
        capture: sanitizeCaptureStatus({
          ...session.stats?.cursor,
          ...session.stats?.framePump,
          ...session.stats?.resources,
          ...session.stats?.sink,
        }),
      };
    },
    stop() {
      finalizationPromise ??= (async () => {
        let capture;
        try {
          capture = await session.stop();
        } catch (error) {
          capture = {
            ...session.stats?.cursor,
            ...session.stats?.framePump,
            ...session.stats?.resources,
            ...session.stats?.sink,
            elapsedMs: session.stats?.resources?.elapsedMs ?? null,
          };
          captureError ??= error;
        }
        if (signal.aborted) {
          captureError ??= Object.assign(new Error("Recording was cancelled"), {
            code: "recording_cancelled",
          });
        }
        return artifacts.finalize({
          capture,
          failureCode:
            getForcedFailureCode() ?? captureFailureCode(captureError),
          ffprobePath: options.ffprobePath,
        });
      })();
      return finalizationPromise;
    },
  };
}

export function createRecording(options) {
  let callerSignal;
  let dependencies;
  try {
    callerSignal = options?.signal;
    if (callerSignal != null && !(callerSignal instanceof AbortSignal)) {
      return failedHandle("invalid_configuration");
    }
    if (callerSignal != null) isAborted(callerSignal);
    dependencies = options?._dependencies ?? {
      clock: { clearTimeout, setTimeout },
      createRecordingArtifactTransaction,
      doctor: inspectRecordingEnvironment,
      startBrowserRecordingForTab,
    };
  } catch {
    return failedHandle("invalid_configuration");
  }
  let state = "preparing";
  let inner;
  let durationTimer;
  let freshTab;
  let artifactTransaction;
  let actionFailure;
  let actionInFlight = false;
  let forcedFailureCode;
  let recordingDeadlineMs;
  let sessionRequiresPointerEvidence;
  let stopPromise;
  let terminal = false;
  let ownsFreshTab = false;
  const reservation = {};
  const cancellation = new AbortController();
  const cancelFromCaller = () => cancellation.abort();

  if (globalThis[ACTIVE_RECORDING_KEY] != null) {
    return failedHandle("recording_already_active");
  }
  globalThis[ACTIVE_RECORDING_KEY] = reservation;
  try {
    if (callerSignal != null) {
      addAbortListener(callerSignal, cancelFromCaller);
      if (isAborted(callerSignal)) cancelFromCaller();
    }
  } catch {
    if (globalThis[ACTIVE_RECORDING_KEY] === reservation) {
      delete globalThis[ACTIVE_RECORDING_KEY];
    }
    return failedHandle("invalid_configuration");
  }

  let handle;
  let ready;

  function release() {
    if (callerSignal != null) {
      try {
        removeAbortListener(callerSignal, cancelFromCaller);
      } catch {
        // Releasing the singleton must not depend on caller-controlled state.
      }
    }
    if (
      globalThis[ACTIVE_RECORDING_KEY] === reservation ||
      globalThis[ACTIVE_RECORDING_KEY] === handle
    ) {
      delete globalThis[ACTIVE_RECORDING_KEY];
    }
  }

  function setTerminalState(output) {
    dependencies.clock.clearTimeout(durationTimer);
    if (terminal) return;
    terminal = true;
    state =
      output?.result?.status === "passed"
        ? "completed"
        : stateForFailureCode(output?.result?.failureCode);
    release();
  }

  function setTerminalFailure(error) {
    dependencies.clock.clearTimeout(durationTimer);
    if (terminal) return;
    terminal = true;
    state = stateForFailureCode(error?.code);
    release();
  }

  function status() {
    return { capture: inner?.status().capture ?? null, state };
  }

  function latchActionFailure(error) {
    actionFailure ??= sanitizeActionFailure(error);
    forcedFailureCode ??=
      actionFailure.code === "cancelled"
        ? "recording_cancelled"
        : actionFailure.code;
    return actionFailure;
  }

  async function failAction(error) {
    const primaryFailure = latchActionFailure(error);
    cancellation.abort();

    let cleanupOptions = {};
    try {
      const output = await finish({ cancelPending: true });
      cleanupOptions = {
        cleanupDirectory: output?.paths?.cleanupDirectory,
        cleanupFile: output?.paths?.cleanupFile,
      };
    } catch (cleanupError) {
      const cleanup = getRecordingCleanupDetails(cleanupError);
      cleanupOptions = {
        artifactCleanupIncomplete:
          cleanup?.artifactCleanupIncomplete === true,
        browserTabCleanupIncomplete:
          cleanup?.browserTabCleanupIncomplete === true,
        cleanupDirectory: cleanup?.directory,
        cleanupFile: cleanup?.cleanupFile,
      };
    }
    throw sanitizeRecordingFailure(primaryFailure, cleanupOptions);
  }

  async function waitForPointerEvidence({
    actionStartedAtEpochMs,
    beforeEvents,
  }) {
    const evidenceDeadline = Math.min(
      clockNow(dependencies.clock) + ACTION_EVIDENCE_TIMEOUT_MS,
      recordingDeadlineMs ?? Number.POSITIVE_INFINITY,
    );
    while (true) {
      if (state !== "recording") {
        throw sanitizeRecordingFailure({ code: "integration_failed" });
      }
      if (
        hasPointerEvidenceAfterActionBoundary({
          actionStartedAtEpochMs,
          beforeEvents,
          capture: inner.status().capture,
        })
      ) {
        return;
      }
      const remainingMs = evidenceDeadline - clockNow(dependencies.clock);
      if (remainingMs <= 0) {
        throw sanitizeRecordingFailure({ code: "cursor_recording_failed" });
      }
      await waitForClockDelay(
        dependencies.clock,
        Math.min(ACTION_EVIDENCE_INTERVAL_MS, remainingMs),
        cancellation.signal,
      );
    }
  }

  async function runAction({ perform, requiresPointerEvidence } = {}) {
    if (
      typeof perform !== "function" ||
      typeof requiresPointerEvidence !== "boolean"
    ) {
      return failAction({ code: "invalid_configuration" });
    }
    if (
      requiresPointerEvidence &&
      sessionRequiresPointerEvidence !== true
    ) {
      return failAction({ code: "invalid_configuration" });
    }
    if (actionInFlight || state !== "recording") {
      return failAction({ code: "integration_failed" });
    }

    actionInFlight = true;
    try {
      const beforeEvents = inner.status().capture?.cursorEventsCaptured;
      const actionStartedAtEpochMs = clockNow(dependencies.clock);
      const result = await awaitAbortable(
        Promise.resolve().then(perform),
        cancellation.signal,
      );
      if (state !== "recording") {
        throw sanitizeRecordingFailure({ code: "integration_failed" });
      }
      if (requiresPointerEvidence) {
        await waitForPointerEvidence({
          actionStartedAtEpochMs,
          beforeEvents,
        });
      }
      return result;
    } catch (error) {
      return failAction(error);
    } finally {
      actionInFlight = false;
    }
  }

  async function closeFreshTab() {
    if (!ownsFreshTab || freshTab == null) return;
    const tab = freshTab;
    freshTab = null;
    const cleanup = await settleBeforeDeadline(
      closeTabBestEffort(tab),
      dependencies.clock,
    );
    if (cleanup.status !== "fulfilled") {
      throw sanitizeBrowserFailure(cleanup.reason, {
        browserTabCleanupIncomplete: true,
      });
    }
  }

  function finish({ cancelPending }) {
    if (actionInFlight) {
      latchActionFailure({ code: "integration_failed" });
      cancellation.abort();
    }
    if (cancelPending && ["preparing", "awaiting_frame"].includes(state)) {
      cancellation.abort();
    }
    if (state === "recording") state = "stopping";
    stopPromise ??= ready
      .then(async () => {
        dependencies.clock.clearTimeout(durationTimer);
        if (!TERMINAL_STATES.has(state)) state = "stopping";
        try {
          const finalization = await settleBeforeDeadline(
            inner.stop(),
            dependencies.clock,
            FINALIZATION_DEADLINE_MS,
          );
          if (finalization.status === "timed_out") {
            cancellation.abort();
            throw sanitizeRecordingFailure(
              { code: "integration_failed" },
              { artifactCleanupIncomplete: true },
            );
          }
          if (finalization.status === "rejected") {
            throw finalization.reason;
          }
          const output = finalization.value;
          try {
            await closeFreshTab();
          } catch (cleanupError) {
            if (output?.result?.status !== "failed") throw cleanupError;
            const cleanup = getRecordingCleanupDetails(cleanupError);
            throw sanitizeRecordingFailure(
              {
                code: output.result.failureCode ?? "recording_failed",
              },
              {
                browserTabCleanupIncomplete:
                  cleanup?.browserTabCleanupIncomplete === true,
              },
            );
          }
          setTerminalState(output);
          return output;
        } catch (error) {
          let browserTabCleanupIncomplete = false;
          try {
            await closeFreshTab();
          } catch (cleanupError) {
            browserTabCleanupIncomplete =
              getRecordingCleanupDetails(cleanupError)
                ?.browserTabCleanupIncomplete === true;
          }
          const publicError = sanitizeRecordingFailure(error, {
            browserTabCleanupIncomplete,
          });
          setTerminalFailure(publicError);
          throw publicError;
        }
      })
      .finally(release);
    void stopPromise.catch(() => {});
    return stopPromise;
  }

  function stop() {
    return finish({ cancelPending: true });
  }

  ready = Promise.resolve()
    .then(async () => {
      if (cancellation.signal.aborted) {
        throw sanitizeRecordingFailure({ code: "recording_cancelled" });
      }
      const request = validateRecordingRequest(options);
      sessionRequiresPointerEvidence = request.requirePointerEvents;
      const savedRecording = planSavedRecording(options);
      if (cancellation.signal.aborted) {
        throw sanitizeRecordingFailure({ code: "recording_cancelled" });
      }
      let ffmpegPath = options.ffmpegPath;
      let ffprobePath = options.ffprobePath;
      if (
        options.tab != null ||
        typeof options.browser?.tabs?.new !== "function"
      ) {
        throw sanitizeRecordingFailure({ code: "invalid_configuration" });
      }
      artifactTransaction = await prepareArtifactTransaction({
        dependencies: {
          clock: dependencies.clock,
          createRecordingArtifactTransaction:
            dependencies.createRecordingArtifactTransaction ??
            createRecordingArtifactTransaction,
        },
        options,
        savedRecording,
        signal: cancellation.signal,
      });
      try {
        freshTab = await createFreshTab(
          options.browser,
          cancellation.signal,
          dependencies.clock,
        );
        ownsFreshTab = true;
        await awaitAbortable(
          freshTab.goto(request.targetUrl),
          cancellation.signal,
        );
        let preflightCdp = await awaitAbortable(
          freshTab.capabilities.get("cdp"),
          cancellation.signal,
        );
        const cdpAvailable =
          typeof preflightCdp?.send === "function" &&
          typeof preflightCdp?.readEvents === "function";
        preflightCdp = null;
        const environment = await awaitAbortable(
          (dependencies.doctor ?? inspectRecordingEnvironment)({
            cdpAvailable,
            outputDirectory: savedRecording.destinationDirectory,
          }),
          cancellation.signal,
        );
        if (environment?.supported !== true) {
          throw sanitizeRecordingFailure({
            code: environment?.blockingReasons?.[0] ?? "integration_failed",
          });
        }
        ffmpegPath = environment.ffmpegPath;
        ffprobePath = environment.ffprobePath;
      } catch (error) {
        if (error?.summary === undefined) {
          throw sanitizeBrowserFailure(error);
        }
        throw error;
      }
      const startingArtifacts = artifactTransaction;
      artifactTransaction = null;
      inner = await startRecordingTransaction({
        artifacts: startingArtifacts,
        dependencies: {
          clock: dependencies.clock,
          startBrowserRecordingForTab:
            dependencies.startBrowserRecordingForTab ??
            startBrowserRecordingForTab,
        },
        getForcedFailureCode: () => forcedFailureCode,
        options: { ...options, ffmpegPath, ffprobePath },
        request,
        signal: cancellation.signal,
        tab: freshTab,
      });
      state = "awaiting_frame";
      if (typeof inner.completion?.then === "function") {
        void inner.completion.then(
          (outcome) => {
            if (actionInFlight && outcome?.error != null) {
              latchActionFailure(outcome.error);
            }
            void finish({ cancelPending: false }).catch(() => {});
          },
          (error) => {
            if (actionInFlight) latchActionFailure(error);
            void finish({ cancelPending: false }).catch(() => {});
          },
        );
      }
      await inner.ready;
      state = "recording";
      recordingDeadlineMs = clockNow(dependencies.clock) + request.durationMs;
      durationTimer = dependencies.clock.setTimeout(() => {
        void stop().catch(() => {});
      }, request.durationMs);
      return freshTab;
    })
    .catch(async (error) => {
      dependencies.clock.clearTimeout(durationTimer);
      let artifactCleanupIncomplete = false;
      let cleanupDirectory;
      let cleanupFile;
      if (inner != null) {
        const cleanup = await settleBeforeDeadline(
          inner.stop(),
          dependencies.clock,
          FINALIZATION_DEADLINE_MS,
        );
        if (cleanup.status === "timed_out") {
          cancellation.abort();
          artifactCleanupIncomplete = true;
        } else if (cleanup.status === "rejected") {
          const details = getRecordingCleanupDetails(cleanup.reason);
          artifactCleanupIncomplete =
            details?.artifactCleanupIncomplete === true;
          if (details?.cleanupIncomplete === true) {
            cleanupDirectory = details.directory;
            cleanupFile = details.cleanupFile;
          }
        }
      } else if (artifactTransaction != null) {
        const cleanup = await settleBeforeDeadline(
          artifactTransaction.rollback(),
          dependencies.clock,
        );
        if (cleanup.status !== "fulfilled") {
          const details = getRecordingCleanupDetails(cleanup.reason);
          artifactCleanupIncomplete = details == null;
          cleanupDirectory = details?.directory;
          cleanupFile = details?.cleanupFile;
        }
      }
      let browserTabCleanupIncomplete = false;
      try {
        await closeFreshTab();
      } catch (cleanupError) {
        browserTabCleanupIncomplete =
          getRecordingCleanupDetails(cleanupError)
            ?.browserTabCleanupIncomplete === true;
      }
      const publicError = sanitizeRecordingFailure(error, {
        artifactCleanupIncomplete,
        browserTabCleanupIncomplete,
        cleanupDirectory,
        cleanupFile,
      });
      setTerminalFailure(publicError);
      release();
      throw publicError;
    });
  void ready.catch(() => {});

  handle = { ready, runAction, status, stop };
  globalThis[ACTIVE_RECORDING_KEY] = handle;
  return handle;
}
