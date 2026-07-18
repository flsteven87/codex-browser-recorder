import { setImmediate as waitImmediate } from "node:timers/promises";

import {
  parseScreencastFrame,
} from "../plugins/codex-browser-recorder/skills/record-browser/scripts/media-recorder.mjs";

export const FRAME_CONTRACT_FIXTURE_URL = "https://example.com/";

const EVENT_METHODS = [
  "Page.frameNavigated",
  "Page.screencastFrame",
  "Page.screencastVisibilityChanged",
];
const MAX_DECODED_FRAME_BYTES = 5 * 1024 * 1024;

function gateError(code, message, { cause } = {}) {
  const error =
    cause === undefined ? new Error(message) : new Error(message, { cause });
  return Object.assign(error, { code });
}

function settleWithin(operation, timeoutMs, dependencies) {
  const operationPromise = Promise.resolve().then(operation);
  return new Promise((resolve) => {
    let settled = false;
    let timer;
    const finish = (settlement) => {
      if (settled) return;
      settled = true;
      dependencies.clearTimeout(timer);
      resolve(settlement);
    };
    timer = dependencies.setTimeout(
      () => finish({ pending: operationPromise, status: "timed_out" }),
      timeoutMs,
    );
    operationPromise.then(
      (value) => finish({ status: "fulfilled", value }),
      (reason) => finish({ reason, status: "rejected" }),
    );
  });
}

async function runBounded(
  operation,
  {
    code,
    dependencies,
    message,
    onLateSuccess,
    registerLateCleanup,
    timeoutMs,
  },
) {
  const settlement = await settleWithin(operation, timeoutMs, dependencies);
  if (settlement.status === "fulfilled") return settlement.value;
  if (settlement.status === "rejected") throw settlement.reason;
  if (typeof onLateSuccess === "function") {
    registerLateCleanup(
      settlement.pending.then(onLateSuccess, () => undefined),
    );
  }
  throw gateError(code, message);
}

function validateBatch(batch, cursor) {
  if (
    batch == null ||
    !Number.isInteger(batch.cursor) ||
    batch.cursor < cursor ||
    !Array.isArray(batch.events) ||
    batch.truncated === true
  ) {
    throw gateError(
      "event_stream_invalid",
      "Chrome returned an invalid frame event batch",
    );
  }
}

async function closeTab(tab, { cleanupTimeoutMs, dependencies }) {
  let error;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const settlement = await settleWithin(
      () => tab.close(),
      cleanupTimeoutMs,
      dependencies,
    );
    if (settlement.status === "fulfilled") {
      return;
    }
    if (settlement.status === "timed_out") {
      throw gateError(
        "release_gate_cleanup_failed",
        "Chrome contract gate timed out while closing its fresh tab",
      );
    }
    error = settlement.reason;
  }
  throw gateError(
    "release_gate_cleanup_failed",
    "Chrome contract gate could not close its fresh tab",
    { cause: error },
  );
}

async function stopScreencast(cdp, { cleanupTimeoutMs, dependencies }) {
  const settlement = await settleWithin(
    () => cdp.send("Page.stopScreencast"),
    cleanupTimeoutMs,
    dependencies,
  );
  if (settlement.status === "fulfilled") return;
  throw gateError(
    "release_gate_cleanup_failed",
    settlement.status === "timed_out"
      ? "Chrome contract gate timed out while stopping its frame stream"
      : "Chrome contract gate could not stop its frame stream",
    { cause: settlement.reason },
  );
}

function createCleanupError({
  browserTabCleanupIncomplete,
  frameStreamCleanupIncomplete,
  lateResourceCleanupIncomplete,
}) {
  const resources = [];
  if (frameStreamCleanupIncomplete) resources.push("frame stream");
  if (lateResourceCleanupIncomplete) resources.push("late Browser resource");
  if (browserTabCleanupIncomplete) resources.push("fresh Browser tab");
  const summary = `Chrome contract gate could not clean up its ${resources.join(
    resources.length === 2 ? " and " : ", ",
  )}`;
  return Object.assign(
    gateError("release_gate_cleanup_failed", summary),
    {
      browserTabCleanupIncomplete,
      frameStreamCleanupIncomplete,
      lateResourceCleanupIncomplete,
    },
  );
}

function attachCleanupFailure(primaryError, cleanupError) {
  primaryError.cleanupFailure = Object.freeze({
    browserTabCleanupIncomplete:
      cleanupError.browserTabCleanupIncomplete === true,
    code: cleanupError.code ?? "release_gate_cleanup_failed",
    frameStreamCleanupIncomplete:
      cleanupError.frameStreamCleanupIncomplete === true,
    lateResourceCleanupIncomplete:
      cleanupError.lateResourceCleanupIncomplete === true,
    summary: cleanupError.message,
  });
}

export async function runChromeFrameContractGate({
  browser,
  cleanupTimeoutMs = 5_000,
  dependencies: overrides = {},
  firstFrameTimeoutMs = 5_000,
  operationTimeoutMs = 5_000,
  targetUrl = FRAME_CONTRACT_FIXTURE_URL,
}) {
  if (
    typeof browser?.tabs?.new !== "function" ||
    !Number.isInteger(cleanupTimeoutMs) ||
    cleanupTimeoutMs <= 0 ||
    !Number.isInteger(firstFrameTimeoutMs) ||
    firstFrameTimeoutMs <= 0 ||
    !Number.isInteger(operationTimeoutMs) ||
    operationTimeoutMs <= 0
  ) {
    throw gateError("invalid_configuration", "Invalid contract gate configuration");
  }
  const dependencies = {
    clearTimeout,
    now: Date.now,
    setTimeout,
    waitTurn: () => waitImmediate(),
    ...overrides,
  };
  let approvedOrigin;
  try {
    approvedOrigin = new URL(targetUrl).origin;
  } catch {
    throw gateError("invalid_configuration", "Invalid contract gate target");
  }

  let cdp;
  const lateCleanups = [];
  let primaryError;
  let screencastStarted = false;
  let tab;
  try {
    const boundedOperation = (
      operation,
      message,
      timeoutMs = operationTimeoutMs,
      onLateSuccess,
    ) =>
      runBounded(operation, {
        code: "release_gate_timeout",
        dependencies,
        message,
        onLateSuccess,
        registerLateCleanup(promise) {
          lateCleanups.push(promise);
        },
        timeoutMs,
      });
    tab = await boundedOperation(
      () => browser.tabs.new(),
      "Chrome contract gate timed out while creating its fresh tab",
      operationTimeoutMs,
      (lateTab) => closeTab(lateTab, { cleanupTimeoutMs, dependencies }),
    );
    await boundedOperation(
      () => tab.goto(targetUrl),
      "Chrome contract gate timed out while navigating its fresh tab",
    );
    cdp = await boundedOperation(
      () => tab.capabilities.get("cdp"),
      "Chrome contract gate timed out while acquiring CDP",
    );
    if (
      typeof cdp?.send !== "function" ||
      typeof cdp?.readEvents !== "function"
    ) {
      throw gateError("cdp_unavailable", "Chrome CDP is unavailable");
    }

    await boundedOperation(
      () => cdp.send("Page.enable"),
      "Chrome contract gate timed out while enabling Page events",
    );
    const frameTree = await boundedOperation(
      () => cdp.send("Page.getFrameTree"),
      "Chrome contract gate timed out while verifying the main frame",
    );
    let observedOrigin;
    try {
      observedOrigin = new URL(frameTree?.frameTree?.frame?.url).origin;
    } catch (error) {
      throw gateError(
        "origin_verification_failed",
        "Chrome contract fixture returned an invalid main-frame URL",
        { cause: error },
      );
    }
    if (observedOrigin !== approvedOrigin) {
      throw gateError(
        "origin_verification_failed",
        "Chrome contract fixture left its approved origin",
      );
    }
    const baseline = await boundedOperation(
      () =>
        cdp.readEvents({
          methods: EVENT_METHODS,
          timeoutMs: 1_000,
        }),
      "Chrome contract gate timed out while reading its event baseline",
    );
    validateBatch(baseline, 0);
    let cursor = baseline.cursor;

    await boundedOperation(
      () =>
        cdp.send("Page.startScreencast", {
          everyNthFrame: 1,
          format: "jpeg",
          maxHeight: 720,
          maxWidth: 1280,
          quality: 70,
        }),
      "Chrome contract gate timed out while starting the frame stream",
      operationTimeoutMs,
      () => stopScreencast(cdp, { cleanupTimeoutMs, dependencies }),
    );
    screencastStarted = true;
    const deadline = dependencies.now() + firstFrameTimeoutMs;
    while (dependencies.now() < deadline) {
      const remainingMs = deadline - dependencies.now();
      const readTimeoutMs = Math.max(1, Math.min(1_000, remainingMs));
      const batch = await boundedOperation(
        () =>
          cdp.readEvents({
            afterSequence: cursor,
            methods: EVENT_METHODS,
            timeoutMs: readTimeoutMs,
          }),
        "Chrome contract gate timed out while waiting for a frame",
        readTimeoutMs + 250,
      );
      validateBatch(batch, cursor);
      cursor = batch.cursor;
      for (const event of batch.events) {
        if (event?.method !== "Page.screencastFrame") continue;
        const frame = parseScreencastFrame(
          event,
          MAX_DECODED_FRAME_BYTES,
        );
        if (frame === null) continue;
        await boundedOperation(
          () =>
            cdp.send("Page.screencastFrameAck", {
              sessionId: frame.sessionId,
            }),
          "Chrome contract gate timed out while acknowledging a frame",
        );
        return {
          contractVersion: 1,
          framesAcknowledged: 1,
          framesReceived: 1,
          status: "passed",
          surface: "chrome",
        };
      }
      await dependencies.waitTurn();
    }
    throw gateError(
      "frame_stream_unavailable",
      "Chrome produced no frame before the contract deadline",
    );
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    const cleanup = {
      browserTabCleanupIncomplete: false,
      frameStreamCleanupIncomplete: false,
      lateResourceCleanupIncomplete: false,
    };
    if (screencastStarted) {
      try {
        await stopScreencast(cdp, { cleanupTimeoutMs, dependencies });
      } catch (error) {
        cleanup.frameStreamCleanupIncomplete = true;
      }
    }
    if (lateCleanups.length > 0) {
      const settlement = await settleWithin(
        () => Promise.allSettled(lateCleanups),
        cleanupTimeoutMs,
        dependencies,
      );
      const lateCleanupFailed =
        settlement.status !== "fulfilled" ||
        settlement.value.some(({ status }) => status === "rejected");
      if (lateCleanupFailed) {
        cleanup.lateResourceCleanupIncomplete = true;
      }
    }
    if (tab != null) {
      try {
        await closeTab(tab, { cleanupTimeoutMs, dependencies });
      } catch (error) {
        cleanup.browserTabCleanupIncomplete = true;
      }
    }
    if (Object.values(cleanup).some(Boolean)) {
      const cleanupError = createCleanupError(cleanup);
      if (primaryError === undefined) throw cleanupError;
      attachCleanupFailure(primaryError, cleanupError);
    }
  }
}
