import { spawn } from "node:child_process";
import { rename, rm, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import {
  RECORDING_FPS,
  RECORDING_MAX_OUTPUT_BYTES,
} from "./recording-policy.mjs";

const BINDING_NAME = "__codexBrowserRecorderCursor";
const WORLD_NAME = "codex-browser-recorder-cursor";
const EVENT_METHODS = [
  "Page.frameAttached",
  "Page.frameDetached",
  "Page.frameNavigated",
  "Runtime.bindingCalled",
  "Target.attachedToTarget",
  "Target.detachedFromTarget",
];
const TARGET_EVENT_METHODS = [
  "Target.attachedToTarget",
  "Target.detachedFromTarget",
];
const POINTER_TYPES = new Set([
  "click",
  "double",
  "down",
  "move",
  "up",
  "wheel",
]);
const READ_TIMEOUT_MS = 250;
const MAX_STARTUP_TARGET_BATCHES = 8;
const MAX_CURSOR_EVENTS = 6000;
const CURSOR_RENDER_TIMEOUT_MS = 8000;
const CURSOR_RENDER_FORCE_KILL_MS = 500;
const CURSOR_ASSET_PATH = fileURLToPath(
  new URL("../assets/codex-style-cursor.xpm", import.meta.url),
);
const RING_ASSET_PATH = fileURLToPath(
  new URL("../assets/codex-style-click-ring.xpm", import.meta.url),
);
const CURSOR_HOTSPOT_OFFSET = 1;
const CLICK_RING_OFFSET = 28;
const CLICK_RING_DURATION_MS = 200;
const MOVE_DURATION_MS = 250;

class CursorRecordingError extends Error {
  constructor(message) {
    super(message);
    this.name = "CursorRecordingError";
    this.code = "cursor_recording_failed";
  }
}

function invalidCursorRecording() {
  return new CursorRecordingError("Cursor recording could not be completed");
}

function validateConfiguration({ cdp, mainFrameId, now }) {
  if (
    typeof cdp?.readEvents !== "function" ||
    typeof cdp?.send !== "function" ||
    typeof mainFrameId !== "string" ||
    mainFrameId.length === 0 ||
    typeof now !== "function"
  ) {
    throw invalidCursorRecording();
  }
}

function validateEventBatch(batch, currentCursor) {
  if (
    batch === null ||
    typeof batch !== "object" ||
    !Number.isInteger(batch.cursor) ||
    batch.cursor < currentCursor ||
    !Array.isArray(batch.events) ||
    typeof batch.hasMore !== "boolean" ||
    batch.truncated === true
  ) {
    throw invalidCursorRecording();
  }
}

function parsePointerPayload(payload) {
  let parsed;
  try {
    parsed = JSON.parse(payload);
  } catch {
    throw invalidCursorRecording();
  }
  if (
    parsed === null ||
    typeof parsed !== "object" ||
    parsed.version !== 1 ||
    !POINTER_TYPES.has(parsed.type) ||
    !Number.isFinite(parsed.x) ||
    !Number.isFinite(parsed.y) ||
    !Number.isFinite(parsed.width) ||
    parsed.width <= 0 ||
    !Number.isFinite(parsed.height) ||
    parsed.height <= 0 ||
    !Number.isFinite(parsed.observedAtEpochMs) ||
    parsed.observedAtEpochMs < 0 ||
    !Number.isInteger(parsed.button) ||
    !Number.isInteger(parsed.buttons)
  ) {
    throw invalidCursorRecording();
  }
  return parsed;
}

function installerExpression() {
  return `(() => {
    const bindingName = ${JSON.stringify(BINDING_NAME)};
    const cleanupName = "__codexBrowserRecorderCursorCleanup";
    globalThis[cleanupName]?.();
    const emit = (type, pointer) => globalThis[bindingName](JSON.stringify({
      button: Number.isInteger(pointer.button) ? pointer.button : 0,
      buttons: Number.isInteger(pointer.buttons) ? pointer.buttons : 0,
      height: innerHeight,
      observedAtEpochMs: Number.isFinite(pointer.observedAtEpochMs)
        ? pointer.observedAtEpochMs
        : performance.timeOrigin + pointer.timeStamp,
      type,
      version: 1,
      width: innerWidth,
      x: pointer.clientX,
      y: pointer.clientY,
    }));
    let animationFrame = null;
    let pendingMove = null;
    const flushMove = () => {
      if (animationFrame !== null) cancelAnimationFrame(animationFrame);
      animationFrame = null;
      if (pendingMove === null) return;
      const move = pendingMove;
      pendingMove = null;
      emit("move", move);
    };
    const queueMove = (event) => {
      if (!event.isTrusted) return;
      pendingMove = {
        button: event.button,
        buttons: event.buttons,
        clientX: event.clientX,
        clientY: event.clientY,
        observedAtEpochMs: performance.timeOrigin + event.timeStamp,
      };
      if (animationFrame === null) {
        animationFrame = requestAnimationFrame(flushMove);
      }
    };
    const emitBoundary = (type, event) => {
      if (!event.isTrusted) return;
      flushMove();
      emit(type, event);
    };
    const listeners = [
      ["mousemove", queueMove],
      ["mousedown", (event) => emitBoundary("down", event)],
      ["mouseup", (event) => emitBoundary("up", event)],
      ["click", (event) => emitBoundary("click", event)],
      ["dblclick", (event) => emitBoundary("double", event)],
      ["wheel", (event) => emitBoundary("wheel", event)],
    ];
    for (const [type, listener] of listeners) {
      addEventListener(type, listener, { capture: true, passive: true });
    }
    globalThis[cleanupName] = () => {
      if (animationFrame !== null) cancelAnimationFrame(animationFrame);
      animationFrame = null;
      pendingMove = null;
      for (const [type, listener] of listeners) {
        removeEventListener(type, listener, { capture: true });
      }
      delete globalThis[cleanupName];
    };
    return { height: innerHeight, width: innerWidth };
  })()`;
}

function cleanupExpression() {
  return `(() => {
    globalThis.__codexBrowserRecorderCursorCleanup?.();
    return true;
  })()`;
}

function validateTimeline(timeline) {
  if (
    timeline === null ||
    !Number.isFinite(timeline?.durationMs) ||
    timeline.durationMs <= 0 ||
    !Number.isFinite(timeline?.viewport?.height) ||
    timeline.viewport.height <= 0 ||
    !Number.isFinite(timeline?.viewport?.width) ||
    timeline.viewport.width <= 0 ||
    !Array.isArray(timeline?.events)
  ) {
    throw invalidCursorRecording();
  }
  let lastAtMs = 0;
  for (const event of timeline.events) {
    if (
      event === null ||
      typeof event !== "object" ||
      !Number.isFinite(event.atMs) ||
      event.atMs < lastAtMs ||
      event.atMs > timeline.durationMs ||
      !POINTER_TYPES.has(event.type) ||
      !Number.isFinite(event.x) ||
      !Number.isFinite(event.y) ||
      !Number.isInteger(event.button) ||
      !Number.isInteger(event.buttons) ||
      typeof event.frameId !== "string" ||
      event.frameId.length === 0
    ) {
      throw invalidCursorRecording();
    }
    lastAtMs = event.atMs;
  }
}

function collapsePositions(events) {
  const positions = [];
  for (const event of events) {
    const previous = positions.at(-1);
    if (previous?.atMs === event.atMs) {
      previous.x = event.x;
      previous.y = event.y;
    } else {
      positions.push({ atMs: event.atMs, x: event.x, y: event.y });
    }
  }
  return positions;
}

function positionAt(positions, atMs) {
  if (positions.length === 0 || atMs < positions[0].atMs) return null;
  let previous = positions[0];
  for (let index = 1; index < positions.length; index += 1) {
    const next = positions[index];
    if (atMs >= next.atMs) {
      previous = next;
      continue;
    }
    const movementDuration = Math.min(
      MOVE_DURATION_MS,
      next.atMs - previous.atMs,
    );
    const movementStart = next.atMs - movementDuration;
    if (atMs <= movementStart) return previous;
    const progress = (atMs - movementStart) / movementDuration;
    return {
      x: previous.x + (next.x - previous.x) * progress,
      y: previous.y + (next.y - previous.y) * progress,
    };
  }
  return previous;
}

function activePressAt(presses, atMs) {
  let active = null;
  for (const press of presses) {
    if (press.atMs > atMs) break;
    if (atMs < press.atMs + CLICK_RING_DURATION_MS) active = press;
  }
  return active;
}

function expressionFor(samples, property, offset, viewportSize) {
  const visible = samples
    .map((sample, index) =>
      sample === null
        ? null
        : {
            index: index + 1,
            value: Number(sample[property].toFixed(3)),
          },
    )
    .filter((sample) => sample !== null);
  if (visible.length === 0) return "-1000";

  const runs = [];
  for (const sample of visible) {
    const previous = runs.at(-1);
    if (
      previous !== undefined &&
      previous.end + 1 === sample.index &&
      previous.value === sample.value
    ) {
      previous.end = sample.index;
    } else {
      runs.push({ end: sample.index, start: sample.index, value: sample.value });
    }
  }

  const first = runs[0].start;
  const terms = first === 0 ? [] : [`-1000*lt(n,${first})`];
  for (const [index, run] of runs.entries()) {
    const isLast = index === runs.length - 1 && run.end === samples.length - 1;
    const selector = isLast
      ? `gte(n,${run.start})`
      : run.start === run.end
        ? `eq(n,${run.start})`
        : `between(n,${run.start},${run.end})`;
    const mainSize = property === "x" ? "main_w" : "main_h";
    terms.push(
      `(${run.value}*${mainSize}/${Number(viewportSize).toFixed(3)}-${offset})*${selector}`,
    );
  }
  const lastVisible = visible.at(-1).index;
  if (lastVisible < samples.length) {
    terms.push(`-1000*gt(n,${lastVisible})`);
  }
  return terms.join("+");
}

function cursorExpressions(timeline) {
  const frameDurationMs = 1000 / RECORDING_FPS;
  const frameCount = Math.ceil(timeline.durationMs / frameDurationMs);
  const positions = collapsePositions(timeline.events);
  const presses = timeline.events.filter((event) => event.type === "down");
  const cursorSamples = [];
  const ringSamples = [];
  for (let frame = 0; frame < frameCount; frame += 1) {
    const atMs = frame * frameDurationMs;
    cursorSamples.push(positionAt(positions, atMs));
    ringSamples.push(activePressAt(presses, atMs));
  }
  return {
    cursorX: expressionFor(
      cursorSamples,
      "x",
      CURSOR_HOTSPOT_OFFSET,
      timeline.viewport.width,
    ),
    cursorY: expressionFor(
      cursorSamples,
      "y",
      CURSOR_HOTSPOT_OFFSET,
      timeline.viewport.height,
    ),
    ringX: expressionFor(
      ringSamples,
      "x",
      CLICK_RING_OFFSET,
      timeline.viewport.width,
    ),
    ringY: expressionFor(
      ringSamples,
      "y",
      CLICK_RING_OFFSET,
      timeline.viewport.height,
    ),
  };
}

function flattenFrameTree(frameTree, parentFrameId = null, frames = []) {
  const frame = frameTree?.frame;
  if (typeof frame?.id !== "string" || frame.id.length === 0) {
    throw invalidCursorRecording();
  }
  frames.push({
    frameId: frame.id,
    parentFrameId:
      typeof frame.parentId === "string" ? frame.parentId : parentFrameId,
  });
  for (const child of frameTree.childFrames ?? []) {
    flattenFrameTree(child, frame.id, frames);
  }
  return frames;
}

function validateViewport(value) {
  if (
    value === null ||
    typeof value !== "object" ||
    !Number.isFinite(value.width) ||
    value.width <= 0 ||
    !Number.isFinite(value.height) ||
    value.height <= 0
  ) {
    throw invalidCursorRecording();
  }
  return { height: value.height, width: value.width };
}

function validateOwnerQuad(value) {
  if (
    !Array.isArray(value) ||
    value.length !== 8 ||
    value.some((coordinate) => !Number.isFinite(coordinate))
  ) {
    throw invalidCursorRecording();
  }
  const [x0, y0, x1, y1, x2, y2, x3, y3] = value;
  const affineTolerance = 0.01;
  const isAffine =
    Math.abs(x2 - x1 - x3 + x0) <= affineTolerance &&
    Math.abs(y2 - y1 - y3 + y0) <= affineTolerance;
  const determinant = (x1 - x0) * (y3 - y0) - (y1 - y0) * (x3 - x0);
  if (!isAffine || Math.abs(determinant) <= Number.EPSILON) {
    throw invalidCursorRecording();
  }
  return [...value];
}

function mapPointToTop(frames, frameId, x, y, visited = new Set()) {
  const frame = frames.get(frameId);
  if (frame === undefined || visited.has(frameId)) {
    throw invalidCursorRecording();
  }
  if (frame.parentFrameId === null) return { x, y };
  visited.add(frameId);
  const parent = frames.get(frame.parentFrameId);
  if (parent === undefined || frame.ownerQuad === null) {
    throw invalidCursorRecording();
  }
  const u = x / frame.viewport.width;
  const v = y / frame.viewport.height;
  const [x0, y0, x1, y1, x2, y2, x3, y3] = frame.ownerQuad;
  const parentX =
    (1 - u) * (1 - v) * x0 +
    u * (1 - v) * x1 +
    u * v * x2 +
    (1 - u) * v * x3;
  const parentY =
    (1 - u) * (1 - v) * y0 +
    u * (1 - v) * y1 +
    u * v * y2 +
    (1 - u) * v * y3;
  if (!Number.isFinite(parentX) || !Number.isFinite(parentY)) {
    throw invalidCursorRecording();
  }
  return mapPointToTop(
    frames,
    parent.frameId,
    parentX,
    parentY,
    visited,
  );
}

function runFfmpeg(ffmpegPath, args, { signal, timeoutMs }) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let terminationRequested = false;
    let forceKillTimer;
    let timeoutTimer;
    const child = spawn(ffmpegPath, args, {
      stdio: ["ignore", "ignore", "ignore"],
    });
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      clearTimeout(forceKillTimer);
      signal?.removeEventListener("abort", requestTermination);
      if (error === null) resolve();
      else reject(error);
    };
    const requestTermination = () => {
      if (terminationRequested || settled) return;
      terminationRequested = true;
      child.kill("SIGTERM");
      forceKillTimer = setTimeout(() => {
        if (!settled) child.kill("SIGKILL");
      }, CURSOR_RENDER_FORCE_KILL_MS);
    };
    child.once("error", () => {
      finish(invalidCursorRecording());
    });
    child.once("exit", (code, signal) => {
      if (!terminationRequested && code === 0 && signal === null) {
        finish(null);
      } else {
        finish(invalidCursorRecording());
      }
    });
    signal?.addEventListener("abort", requestTermination, { once: true });
    if (signal?.aborted) requestTermination();
    timeoutTimer = setTimeout(requestTermination, timeoutMs);
  });
}

export async function renderCursorRecording({
  ffmpegPath,
  inputPath,
  outputPath,
  signal,
  timeoutMs = CURSOR_RENDER_TIMEOUT_MS,
  timeline,
}) {
  if (
    typeof ffmpegPath !== "string" ||
    ffmpegPath.length === 0 ||
    typeof inputPath !== "string" ||
    inputPath.length === 0 ||
    typeof outputPath !== "string" ||
    outputPath.length === 0 ||
    inputPath === outputPath ||
    (signal !== undefined && !(signal instanceof AbortSignal)) ||
    !Number.isInteger(timeoutMs) ||
    timeoutMs <= 0
  ) {
    throw invalidCursorRecording();
  }
  validateTimeline(timeline);

  const workingOutputPath = `${outputPath}.partial`;
  await rm(workingOutputPath, { force: true }).catch(() => {});
  try {
    const expressions = cursorExpressions(timeline);
    const filter = [
      `[0:v][1:v]overlay=x='${expressions.cursorX}':y='${expressions.cursorY}':eval=frame:shortest=1:eof_action=repeat[cursor]`,
      `[cursor][2:v]overlay=x='${expressions.ringX}':y='${expressions.ringY}':eval=frame:shortest=1:eof_action=repeat[video]`,
    ].join(";");
    await runFfmpeg(ffmpegPath, [
      "-hide_banner",
      "-loglevel",
      "error",
      "-filter_complex_threads",
      "1",
      "-i",
      inputPath,
      "-loop",
      "1",
      "-framerate",
      String(RECORDING_FPS),
      "-i",
      CURSOR_ASSET_PATH,
      "-loop",
      "1",
      "-framerate",
      String(RECORDING_FPS),
      "-i",
      RING_ASSET_PATH,
      "-filter_complex",
      filter,
      "-map",
      "[video]",
      "-an",
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-crf",
      "18",
      "-pix_fmt",
      "yuv420p",
      "-movflags",
      "+faststart",
      "-f",
      "mp4",
      "-y",
      workingOutputPath,
    ], { signal, timeoutMs });
    if (signal?.aborted) throw invalidCursorRecording();
    const outputBytes = (await stat(workingOutputPath)).size;
    if (outputBytes <= 0 || outputBytes > RECORDING_MAX_OUTPUT_BYTES) {
      throw invalidCursorRecording();
    }
    if (signal?.aborted) throw invalidCursorRecording();
    await rename(workingOutputPath, outputPath);
    return { outputBytes, outputPath };
  } catch (error) {
    await rm(workingOutputPath, { force: true }).catch(() => {});
    throw error?.code === "cursor_recording_failed"
      ? error
      : invalidCursorRecording();
  }
}

export async function startCursorCapture({ cdp, mainFrameId, now }) {
  validateConfiguration({ cdp, mainFrameId, now });
  const startedAt = now();
  const contexts = new Map();
  const frames = new Map();
  const events = [];
  const discoveredParents = new Map();
  const pendingFrames = new Map();
  const bindingTargets = new Map();
  const targetSessions = new Map();
  let cursor = 0;
  let recordingViewport;

  const targetKey = (target) => target?.sessionId ?? "root";
  const contextKey = (target, contextId) =>
    `${targetKey(target)}:${contextId}`;
  const sendTo = (target, method, params) =>
    target === null
      ? cdp.send(method, params)
      : cdp.send(method, params, { target });
  const targetFromSource = (source) => {
    if (typeof source?.sessionId !== "string") return null;
    const target = targetSessions.get(source.sessionId);
    if (target === undefined) throw invalidCursorRecording();
    return target;
  };
  const rememberPendingFrame = (discovered, target) => {
    pendingFrames.set(discovered.frameId, {
      discovered: { ...discovered },
      target,
    });
  };

  async function addBinding(target) {
    const key = targetKey(target);
    if (bindingTargets.has(key)) return;
    await sendTo(target, "Runtime.addBinding", {
      executionContextName: WORLD_NAME,
      name: BINDING_NAME,
    });
    bindingTargets.set(key, target);
  }

  async function removeFrame(frameId, cleanup = false) {
    for (const child of [...frames.values()]) {
      if (child.parentFrameId === frameId) {
        await removeFrame(child.frameId, cleanup);
      }
    }
    const frame = frames.get(frameId);
    if (frame === undefined) return;
    frames.delete(frameId);
    contexts.delete(contextKey(frame.target, frame.contextId));
    if (cleanup) {
      await sendTo(frame.target, "Runtime.evaluate", {
        contextId: frame.contextId,
        expression: cleanupExpression(),
        returnByValue: true,
      });
    }
  }

  async function installFrame(discovered, target = null) {
    if (
      typeof discovered?.frameId !== "string" ||
      discovered.frameId.length === 0 ||
      (discovered.parentFrameId !== null &&
        (typeof discovered.parentFrameId !== "string" ||
          !frames.has(discovered.parentFrameId)))
    ) {
      throw invalidCursorRecording();
    }
    if (frames.has(discovered.frameId)) {
      await removeFrame(discovered.frameId).catch(() => {});
    }

    let ownerQuad = null;
    if (discovered.parentFrameId !== null) {
      const parent = frames.get(discovered.parentFrameId);
      const owner = await sendTo(parent.target, "DOM.getFrameOwner", {
        frameId: discovered.frameId,
      });
      if (!Number.isInteger(owner?.backendNodeId)) {
        throw invalidCursorRecording();
      }
      const boxModel = await sendTo(parent.target, "DOM.getBoxModel", {
        backendNodeId: owner.backendNodeId,
      });
      ownerQuad = validateOwnerQuad(boxModel?.model?.content);
    }
    const isolatedWorld = await sendTo(target, "Page.createIsolatedWorld", {
      frameId: discovered.frameId,
      grantUniveralAccess: false,
      worldName: WORLD_NAME,
    });
    const contextId = isolatedWorld?.executionContextId;
    if (!Number.isInteger(contextId) || contextId < 0) {
      throw invalidCursorRecording();
    }
    try {
      const installed = await sendTo(target, "Runtime.evaluate", {
        contextId,
        expression: installerExpression(),
        returnByValue: true,
      });
      const frame = {
        contextId,
        frameId: discovered.frameId,
        ownerQuad,
        parentFrameId: discovered.parentFrameId,
        target,
        viewport: validateViewport(installed?.result?.value),
      };
      frames.set(frame.frameId, frame);
      contexts.set(contextKey(target, contextId), frame.frameId);
    } catch (error) {
      await sendTo(target, "Runtime.evaluate", {
        contextId,
        expression: cleanupExpression(),
        returnByValue: true,
      }).catch(() => {});
      throw error;
    }
  }

  async function readFrameViewport(frame) {
    const result = await sendTo(frame.target, "Runtime.evaluate", {
      contextId: frame.contextId,
      expression: "({ height: innerHeight, width: innerWidth })",
      returnByValue: true,
    });
    return validateViewport(result?.result?.value);
  }

  async function refreshGeometry(frameId, sourceViewport) {
    let frame = frames.get(frameId);
    if (frame === undefined) throw invalidCursorRecording();
    frame.viewport = validateViewport(sourceViewport);
    while (frame.parentFrameId !== null) {
      const parent = frames.get(frame.parentFrameId);
      if (parent === undefined) throw invalidCursorRecording();
      const owner = await sendTo(parent.target, "DOM.getFrameOwner", {
        frameId: frame.frameId,
      });
      if (!Number.isInteger(owner?.backendNodeId)) {
        throw invalidCursorRecording();
      }
      const boxModel = await sendTo(parent.target, "DOM.getBoxModel", {
        backendNodeId: owner.backendNodeId,
      });
      frame.ownerQuad = validateOwnerQuad(boxModel?.model?.content);
      parent.viewport = await readFrameViewport(parent);
      frame = parent;
    }
    if (frame.frameId !== mainFrameId) throw invalidCursorRecording();
    return frame.viewport;
  }

  async function attachTarget(params) {
    const sessionId = params?.sessionId;
    const targetInfo = params?.targetInfo;
    if (targetInfo?.type !== "iframe") return;
    if (
      typeof sessionId !== "string" ||
      typeof targetInfo.targetId !== "string"
    ) {
      throw invalidCursorRecording();
    }
    const target = { sessionId };
    targetSessions.set(sessionId, target);
    await sendTo(target, "Page.enable");
    await sendTo(target, "Runtime.enable");
    await addBinding(target);
    const frameTree = await sendTo(target, "Page.getFrameTree");
    const localFrames = flattenFrameTree(frameTree?.frameTree);
    for (const [index, localFrame] of localFrames.entries()) {
      const fallbackParent =
        discoveredParents.get(localFrame.frameId) ??
        discoveredParents.get(targetInfo.targetId) ??
        null;
      const discovered = {
        frameId: localFrame.frameId,
        parentFrameId:
          index === 0 && localFrame.parentFrameId === null
            ? fallbackParent
            : localFrame.parentFrameId,
      };
      discoveredParents.set(discovered.frameId, discovered.parentFrameId);
      if (
        discovered.parentFrameId === null ||
        !frames.has(discovered.parentFrameId)
      ) {
        rememberPendingFrame(discovered, target);
      } else {
        await installFrame(discovered, target);
        pendingFrames.delete(discovered.frameId);
        pendingFrames.delete(targetInfo.targetId);
      }
    }
  }

  async function detachTarget(params) {
    const sessionId = params?.sessionId;
    if (typeof sessionId !== "string") throw invalidCursorRecording();
    const target = targetSessions.get(sessionId);
    if (target === undefined) return;
    for (const frame of [...frames.values()]) {
      if (targetKey(frame.target) === sessionId) {
        await removeFrame(frame.frameId).catch(() => {});
      }
    }
    for (const [frameId, pending] of pendingFrames) {
      if (targetKey(pending.target) === sessionId) {
        pendingFrames.delete(frameId);
      }
    }
    bindingTargets.delete(sessionId);
    targetSessions.delete(sessionId);
  }

  const stats = {
    cursorEventsCaptured: 0,
    cursorFramesObserved: 0,
    cursorLastEventEpochMs: null,
  };

  async function handleEvent(event) {
    if (event?.method === "Target.attachedToTarget") {
      await attachTarget(event.params);
      stats.cursorFramesObserved = frames.size;
      return;
    }
    if (event?.method === "Target.detachedFromTarget") {
      await detachTarget(event.params);
      stats.cursorFramesObserved = frames.size;
      return;
    }
    if (event?.method === "Page.frameAttached") {
      const frameId = event.params?.frameId;
      const parentFrameId = event.params?.parentFrameId;
      if (
        typeof frameId !== "string" ||
        typeof parentFrameId !== "string"
      ) {
        throw invalidCursorRecording();
      }
      discoveredParents.set(frameId, parentFrameId);
      const pending = pendingFrames.get(frameId);
      const target = pending?.target ?? targetFromSource(event.source);
      const discovered = { frameId, parentFrameId };
      rememberPendingFrame(discovered, target);
      if (frames.has(parentFrameId)) {
        try {
          await installFrame(discovered, target);
          pendingFrames.delete(frameId);
        } catch {
          // Navigation or target attachment may make the frame observable next.
        }
      }
      stats.cursorFramesObserved = frames.size;
      return;
    }
    if (event?.method === "Page.frameNavigated") {
      const frame = event.params?.frame;
      if (typeof frame?.id !== "string") throw invalidCursorRecording();
      const target = targetFromSource(event.source);
      const parentFrameId =
        typeof frame.parentId === "string"
          ? frame.parentId
          : discoveredParents.get(frame.id) ?? null;
      discoveredParents.set(frame.id, parentFrameId);
      await installFrame({ frameId: frame.id, parentFrameId }, target);
      pendingFrames.delete(frame.id);
      stats.cursorFramesObserved = frames.size;
      return;
    }
    if (event?.method === "Page.frameDetached") {
      const frameId = event.params?.frameId;
      if (typeof frameId !== "string") throw invalidCursorRecording();
      await removeFrame(frameId).catch(() => {});
      pendingFrames.delete(frameId);
      discoveredParents.delete(frameId);
      stats.cursorFramesObserved = frames.size;
      return;
    }
    if (
      event?.method !== "Runtime.bindingCalled" ||
      event.params?.name !== BINDING_NAME
    ) {
      return;
    }
    const target = targetFromSource(event.source);
    const frameId = contexts.get(
      contextKey(target, event.params.executionContextId),
    );
    if (frameId === undefined || typeof event.params.payload !== "string") {
      throw invalidCursorRecording();
    }
    const pointer = parsePointerPayload(event.params.payload);
    const eventAtMs = Math.max(0, now() - startedAt);
    const currentTopViewport = await refreshGeometry(frameId, {
      height: pointer.height,
      width: pointer.width,
    });
    const point = mapPointToTop(frames, frameId, pointer.x, pointer.y);
    if (events.length >= MAX_CURSOR_EVENTS) {
      throw invalidCursorRecording();
    }
    events.push({
      atMs: eventAtMs,
      button: pointer.button,
      buttons: pointer.buttons,
      frameId,
      type: pointer.type,
      x: Number(
        (
          point.x *
          recordingViewport.width /
          currentTopViewport.width
        ).toFixed(3),
      ),
      y: Number(
        (
          point.y *
          recordingViewport.height /
          currentTopViewport.height
        ).toFixed(3),
      ),
    });
    stats.cursorEventsCaptured += 1;
    stats.cursorLastEventEpochMs = pointer.observedAtEpochMs;
  }

  async function cleanup() {
    let failed = false;
    for (const frame of [...frames.values()].reverse()) {
      try {
        await sendTo(frame.target, "Runtime.evaluate", {
          contextId: frame.contextId,
          expression: cleanupExpression(),
          returnByValue: true,
        });
      } catch {
        failed = true;
      }
    }
    for (const target of [...bindingTargets.values()].reverse()) {
      try {
        await sendTo(target, "Runtime.removeBinding", { name: BINDING_NAME });
      } catch {
        failed = true;
      }
    }
    bindingTargets.clear();
    return failed;
  }

  try {
    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");
    const bufferedTargetEvents = [];
    let targetHistoryComplete = false;
    for (
      let batchCount = 0;
      batchCount < MAX_STARTUP_TARGET_BATCHES;
      batchCount += 1
    ) {
      const batch = await cdp.readEvents({
        afterSequence: cursor,
        limit: 1000,
        methods: TARGET_EVENT_METHODS,
        timeoutMs: 0,
      });
      validateEventBatch(batch, cursor);
      cursor = batch.cursor;
      bufferedTargetEvents.push(...batch.events);
      if (!batch.hasMore) {
        targetHistoryComplete = true;
        break;
      }
    }
    if (!targetHistoryComplete) throw invalidCursorRecording();
    const frameTree = await cdp.send("Page.getFrameTree");
    const discoveredFrames = flattenFrameTree(frameTree?.frameTree);
    if (discoveredFrames[0]?.frameId !== mainFrameId) {
      throw invalidCursorRecording();
    }
    await addBinding(null);
    for (const discovered of discoveredFrames) {
      discoveredParents.set(discovered.frameId, discovered.parentFrameId);
      try {
        await installFrame(discovered);
      } catch (error) {
        if (discovered.parentFrameId === null) throw error;
        rememberPendingFrame(discovered, null);
      }
    }
    for (const event of bufferedTargetEvents) await handleEvent(event);
    for (
      let batchCount = 0;
      pendingFrames.size > 0 && batchCount < MAX_STARTUP_TARGET_BATCHES;
      batchCount += 1
    ) {
      const batch = await cdp.readEvents({
        afterSequence: cursor,
        limit: 1000,
        methods: EVENT_METHODS,
        timeoutMs: READ_TIMEOUT_MS,
      });
      validateEventBatch(batch, cursor);
      cursor = batch.cursor;
      if (batch.events.length === 0 && !batch.hasMore) break;
      for (const event of batch.events) await handleEvent(event);
    }
    if (pendingFrames.size > 0) throw invalidCursorRecording();
    stats.cursorFramesObserved = frames.size;
    recordingViewport = { ...frames.get(mainFrameId).viewport };
  } catch (error) {
    await cleanup().catch(() => {});
    throw error?.code === "cursor_recording_failed"
      ? error
      : invalidCursorRecording();
  }

  let stopped = false;
  let stopPromise;
  let loopError = null;
  const loop = (async () => {
    while (true) {
      const batch = await cdp.readEvents({
        afterSequence: cursor,
        limit: 1000,
        methods: EVENT_METHODS,
        timeoutMs: stopped ? 0 : READ_TIMEOUT_MS,
      });
      validateEventBatch(batch, cursor);
      cursor = batch.cursor;
      for (const event of batch.events) await handleEvent(event);
      if (stopped && !batch.hasMore) break;
    }
  })().catch((error) => {
    loopError =
      error?.code === "cursor_recording_failed"
        ? error
        : invalidCursorRecording();
    throw loopError;
  });
  const completion = loop.then(
    () => ({ error: null }),
    (error) => ({ error }),
  );

  return {
    completion,
    stats,
    stop() {
      if (stopPromise === undefined) {
        stopped = true;
        stopPromise = (async () => {
          await loop.catch(() => {});
          const cleanupFailed = await cleanup();
          if (loopError !== null) throw loopError;
          if (cleanupFailed) throw invalidCursorRecording();
          if (pendingFrames.size > 0) throw invalidCursorRecording();
          if (recordingViewport === undefined) throw invalidCursorRecording();
          return {
            durationMs: Math.max(0, now() - startedAt),
            events: events.map((event) => ({ ...event })),
            viewport: { ...recordingViewport },
          };
        })();
      }
      return stopPromise;
    },
  };
}
