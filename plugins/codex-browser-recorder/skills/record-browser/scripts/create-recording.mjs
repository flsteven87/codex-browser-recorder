import { tmpdir } from "node:os";

import { startBrowserRecordingForTab } from "./browser-recording.mjs";
import { doctor as inspectRecordingEnvironment } from "./doctor.mjs";
import {
  cleanupRecordingArtifacts,
  finalizeRecordingArtifacts,
  prepareRecordingArtifacts,
} from "./recording-artifacts.mjs";
import {
  describeRecordingFailure,
  getRecordingCleanupDetails,
  sanitizeCaptureResult,
  sanitizeRecordingFailure,
} from "./recording-outcome.mjs";
import {
  RECORDING_HARD_LIMIT_MS,
  RECORDING_MAX_HEIGHT,
  RECORDING_MAX_WIDTH,
  validateRecordingRequest,
} from "./recording-policy.mjs";

export { describeRecordingFailure };

const ACTIVE_RECORDING_KEY = Symbol.for("codex-browser-recorder.active");
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

async function prepareArtifactsForRecording({ dependencies, options, signal }) {
  let cancellationExpired = false;
  let knownDirectory;
  let lateCleanupStarted = false;
  const cleanupLateArtifacts = (paths) => {
    if (lateCleanupStarted) return;
    lateCleanupStarted = true;
    void Promise.resolve()
      .then(() => dependencies.cleanupRecordingArtifacts(paths))
      .catch(() => {});
  };
  const preparation = Promise.resolve().then(() =>
    dependencies.prepareRecordingArtifacts({
      onDirectoryCreated(directory) {
        knownDirectory = directory;
        if (cancellationExpired) {
          cleanupLateArtifacts({ directory });
        }
      },
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
      cancellationExpired = true;
      void preparation.then(
        cleanupLateArtifacts,
        () => {},
      );
    }
    const paths = prepared.value ?? (
      typeof knownDirectory === "string"
        ? { directory: knownDirectory }
        : null
    );
    if (paths === null) {
      throw sanitizeRecordingFailure(error, {
        artifactCleanupIncomplete: true,
      });
    }
    const cleanup = await settleBeforeDeadline(
      Promise.resolve().then(() =>
        dependencies.cleanupRecordingArtifacts(paths),
      ),
      dependencies.clock,
    );
    if (cleanup.status !== "fulfilled") {
      throw sanitizeRecordingFailure(error, {
        cleanupDirectory: paths?.directory,
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

function failedHandle(code) {
  const error = sanitizeRecordingFailure({ code });
  const failure = Promise.reject(error);
  void failure.catch(() => {});
  return {
    ready: failure,
    status: () => ({ capture: null, state: "failed" }),
    stop: () => failure,
  };
}

async function startRecordingTransaction({
  dependencies,
  options,
  request,
  signal,
  tab,
}) {
  const paths = await prepareArtifactsForRecording({
    dependencies,
    options,
    signal,
  });
  let session;
  try {
    session = await dependencies.startBrowserRecordingForTab({
      approvedOrigin: request.approvedOrigin,
      ffmpegPath: options.ffmpegPath,
      firstFrameTimeoutMs: 5000,
      maxDurationMs: RECORDING_HARD_LIMIT_MS,
      maxFrameStallMs: 5000,
      outputPath: paths.outputPath,
      readTimeoutMs: 1000,
      resourceCheckIntervalMs: 1000,
      signal,
      tab,
    });
  } catch (error) {
    const cleanup = await settleBeforeDeadline(
      Promise.resolve().then(() =>
        dependencies.cleanupRecordingArtifacts(paths),
      ),
      dependencies.clock,
    );
    const cleanupDirectory =
      cleanup.status === "fulfilled" ? undefined : paths.directory;
    throw sanitizeRecordingFailure(
      {
        code:
          typeof error?.code === "string"
            ? error.code
            : "integration_failed",
      },
      { cleanupDirectory },
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
    cleanupDirectory: paths.directory,
    completion: session.completion,
    ready,
    status() {
      return {
        capture: sanitizeCaptureResult({
          ...session.stats?.framePump,
          ...session.stats?.resources,
          ...session.stats?.sink,
        }),
      };
    },
    stop() {
      finalizationPromise ??= dependencies
        .finalizeRecordingArtifacts({
          captureError,
          durationToleranceSeconds: 5,
          ffprobePath: options.ffprobePath,
          maxHeight: RECORDING_MAX_HEIGHT,
          maxWidth: RECORDING_MAX_WIDTH,
          minBytes: 100,
          outputPath: paths.outputPath,
          resultPath: paths.resultPath,
          session,
        })
        .then((result) => ({ paths, result }));
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
      cleanupRecordingArtifacts,
      clock: { clearTimeout, setTimeout },
      doctor: inspectRecordingEnvironment,
      finalizeRecordingArtifacts,
      prepareRecordingArtifacts,
      startBrowserRecordingForTab,
    };
  } catch {
    return failedHandle("invalid_configuration");
  }
  let state = "preparing";
  let inner;
  let durationTimer;
  let freshTab;
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
              { cleanupDirectory: inner.cleanupDirectory },
            );
          }
          if (finalization.status === "rejected") {
            throw finalization.reason;
          }
          const output = finalization.value;
          await closeFreshTab();
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
            outputDirectory: options.temporaryRoot ?? tmpdir(),
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
      inner = await startRecordingTransaction({
        dependencies: {
          clock: dependencies.clock,
          cleanupRecordingArtifacts:
            dependencies.cleanupRecordingArtifacts ??
            cleanupRecordingArtifacts,
          finalizeRecordingArtifacts:
            dependencies.finalizeRecordingArtifacts ??
            finalizeRecordingArtifacts,
          prepareRecordingArtifacts:
            dependencies.prepareRecordingArtifacts ??
            prepareRecordingArtifacts,
          startBrowserRecordingForTab:
            dependencies.startBrowserRecordingForTab ??
            startBrowserRecordingForTab,
        },
        options: { ...options, ffmpegPath, ffprobePath },
        request,
        signal: cancellation.signal,
        tab: freshTab,
      });
      state = "awaiting_frame";
      if (typeof inner.completion?.then === "function") {
        void inner.completion.then(
          () => {
            void finish({ cancelPending: false }).catch(() => {});
          },
          () => {
            void finish({ cancelPending: false }).catch(() => {});
          },
        );
      }
      await inner.ready;
      state = "recording";
      durationTimer = dependencies.clock.setTimeout(() => {
        void stop().catch(() => {});
      }, request.durationMs);
      return freshTab;
    })
    .catch(async (error) => {
      dependencies.clock.clearTimeout(durationTimer);
      let artifactCleanupIncomplete = false;
      let cleanupDirectory;
      if (inner != null) {
        const cleanup = await settleBeforeDeadline(
          inner.stop(),
          dependencies.clock,
          FINALIZATION_DEADLINE_MS,
        );
        if (cleanup.status === "timed_out") {
          cancellation.abort();
          cleanupDirectory = inner.cleanupDirectory;
        } else if (cleanup.status === "rejected") {
          const details = getRecordingCleanupDetails(cleanup.reason);
          artifactCleanupIncomplete =
            details?.artifactCleanupIncomplete === true;
          if (details?.cleanupIncomplete === true) {
            cleanupDirectory = details.directory;
          }
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
      });
      setTerminalFailure(publicError);
      release();
      throw publicError;
    });
  void ready.catch(() => {});

  handle = { ready, status, stop };
  globalThis[ACTIVE_RECORDING_KEY] = handle;
  return handle;
}
