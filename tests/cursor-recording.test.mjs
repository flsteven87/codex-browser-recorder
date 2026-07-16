import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runInNewContext } from "node:vm";

import {
  renderCursorRecording,
  startCursorCapture,
} from "../plugins/codex-browser-recorder/skills/record-browser/scripts/cursor-recording.mjs";
import { startBrowserRecording } from "../plugins/codex-browser-recorder/skills/record-browser/scripts/browser-recording.mjs";
import { resolveExecutable } from "./test-tools.mjs";

const ffmpegPath = resolveExecutable("ffmpeg");
const ffprobePath = resolveExecutable("ffprobe");
const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);

function deferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function waitFor(predicate) {
  while (!predicate()) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

function visibleBounds(videoPath, frameIndex) {
  const width = 320;
  const height = 180;
  const pixels = execFileSync(
    ffmpegPath,
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-i",
      videoPath,
      "-vf",
      `select=eq(n\\,${frameIndex})`,
      "-frames:v",
      "1",
      "-fps_mode",
      "vfr",
      "-f",
      "rawvideo",
      "-pix_fmt",
      "rgb24",
      "pipe:1",
    ],
    { encoding: "buffer", maxBuffer: width * height * 4 },
  );
  const background = [pixels[0], pixels[1], pixels[2]];
  let minX = width;
  let maxX = -1;
  let minY = height;
  let maxY = -1;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 3;
      const distance =
        Math.abs(pixels[offset] - background[0]) +
        Math.abs(pixels[offset + 1] - background[1]) +
        Math.abs(pixels[offset + 2] - background[2]);
      if (distance < 80) continue;
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
    }
  }
  return maxX < 0 ? null : { maxX, maxY, minX, minY };
}

test("starts cursor capture at the current retained IAB event baseline", async () => {
  const eventRead = deferred();
  const reads = [];
  const cdp = {
    async readEvents(options) {
      reads.push(options);
      if (options.afterSequence === 0) {
        return {
          cursor: 100,
          events: [],
          hasMore: false,
          truncated: true,
        };
      }
      if (options.afterSequence === undefined) {
        return {
          cursor: 100,
          events: [],
          hasMore: false,
          truncated: false,
        };
      }
      if (reads.length === 2) return eventRead.promise;
      throw new Error("unexpected event read");
    },
    async send(method) {
      if (method === "Page.getFrameTree") {
        return { frameTree: { frame: { id: "main-frame" } } };
      }
      if (method === "Page.createIsolatedWorld") {
        return { executionContextId: 7 };
      }
      if (method === "Runtime.evaluate") {
        return { result: { value: { height: 720, width: 1280 } } };
      }
    },
  };

  const capture = await startCursorCapture({
    cdp,
    mainFrameId: "main-frame",
    now: () => 0,
  });
  assert.equal(reads[0].afterSequence, undefined);
  assert.equal(reads[1].afterSequence, 100);

  const stopping = capture.stop();
  eventRead.resolve({
    cursor: 100,
    events: [],
    hasMore: false,
    truncated: false,
  });
  assert.deepEqual((await stopping).events, []);
});

test("captures a top-frame pointer event through an isolated world", async () => {
  const eventRead = deferred();
  const finalRead = deferred();
  const operations = [];
  let clock = 100;
  let reads = 0;
  const cdp = {
    async readEvents(options) {
      operations.push(["readEvents", options]);
      reads += 1;
      if (reads === 1) {
        return { cursor: 4, events: [], hasMore: false, truncated: false };
      }
      if (reads === 2) return eventRead.promise;
      return finalRead.promise;
    },
    async send(method, params, options) {
      operations.push([method, params, options]);
      if (method === "Target.setAutoAttach") {
        throw new Error("This method is not supported through raw CDP.");
      }
      if (method === "Page.getFrameTree") {
        return {
          frameTree: {
            frame: { id: "main-frame", url: "https://example.com/" },
          },
        };
      }
      if (method === "Page.createIsolatedWorld") {
        return { executionContextId: 17 };
      }
      if (method === "Runtime.evaluate") {
        return { result: { value: { height: 720, width: 1280 } } };
      }
    },
  };

  const capture = await startCursorCapture({
    cdp,
    mainFrameId: "main-frame",
    now: () => clock,
  });

  clock = 250;
  eventRead.resolve({
    cursor: 5,
    events: [
      {
        method: "Runtime.bindingCalled",
        params: {
          executionContextId: 17,
          name: "__codexBrowserRecorderCursor",
          payload: JSON.stringify({
            button: 0,
            buttons: 0,
            height: 720,
            observedAtEpochMs: 10_250,
            type: "move",
            version: 1,
            width: 1280,
            x: 320,
            y: 180,
          }),
        },
        sequence: 5,
      },
    ],
    hasMore: false,
    truncated: false,
  });
  let completed = false;
  void capture.completion.then(() => {
    completed = true;
  });
  await waitFor(() => reads === 3 || completed);
  assert.equal(capture.stats.cursorLastEventEpochMs, 10_250);

  const stopping = capture.stop();
  finalRead.resolve({
    cursor: 5,
    events: [],
    hasMore: false,
    truncated: false,
  });
  const timeline = await stopping;

  assert.deepEqual(timeline, {
    durationMs: 150,
    events: [
      {
        atMs: 150,
        button: 0,
        buttons: 0,
        frameId: "main-frame",
        type: "move",
        x: 320,
        y: 180,
      },
    ],
    viewport: { height: 720, width: 1280 },
  });
  assert.deepEqual(
    operations
      .filter(([name]) => name !== "readEvents")
      .map(([name]) => name),
    [
      "Page.enable",
      "Runtime.enable",
      "Page.getFrameTree",
      "Runtime.addBinding",
      "Page.createIsolatedWorld",
      "Runtime.evaluate",
      "Runtime.evaluate",
      "Runtime.removeBinding",
    ],
  );
});

test("maps an embedded-frame pointer through its public owner geometry", async () => {
  const eventRead = deferred();
  const finalRead = deferred();
  const operations = [];
  let clock = 0;
  let reads = 0;
  let ownerReads = 0;
  const cdp = {
    async readEvents() {
      reads += 1;
      if (reads === 1) {
        return { cursor: 10, events: [], hasMore: false, truncated: false };
      }
      if (reads === 2) return eventRead.promise;
      return finalRead.promise;
    },
    async send(method, params) {
      operations.push([method, params]);
      if (method === "Page.getFrameTree") {
        return {
          frameTree: {
            childFrames: [
              {
                frame: {
                  id: "child-frame",
                  parentId: "main-frame",
                  url: "https://embedded.example/",
                },
              },
            ],
            frame: { id: "main-frame", url: "https://example.com/" },
          },
        };
      }
      if (method === "DOM.getFrameOwner") return { backendNodeId: 42 };
      if (method === "DOM.getBoxModel") {
        ownerReads += 1;
        if (ownerReads === 2) clock = 400;
        return {
          model: {
            content:
              ownerReads === 1
                ? [100, 50, 300, 50, 300, 150, 100, 150]
                : [150, 80, 350, 80, 350, 180, 150, 180],
          },
        };
      }
      if (method === "Page.createIsolatedWorld") {
        return {
          executionContextId: params.frameId === "main-frame" ? 21 : 22,
        };
      }
      if (method === "Runtime.evaluate") {
        return {
          result: {
            value:
              params.contextId === 22
                ? { height: 100, width: 200 }
                : { height: 300, width: 400 },
          },
        };
      }
    },
  };

  const capture = await startCursorCapture({
    cdp,
    mainFrameId: "main-frame",
    now: () => clock,
  });
  clock = 100;
  eventRead.resolve({
    cursor: 11,
    events: [
      {
        method: "Runtime.bindingCalled",
        params: {
          executionContextId: 22,
          name: "__codexBrowserRecorderCursor",
          payload: JSON.stringify({
            button: 0,
            buttons: 0,
            height: 100,
            observedAtEpochMs: 10_100,
            type: "move",
            version: 1,
            width: 200,
            x: 20,
            y: 10,
          }),
        },
        sequence: 11,
      },
    ],
    hasMore: false,
    truncated: false,
  });
  let completed = false;
  void capture.completion.then(() => {
    completed = true;
  });
  await waitFor(() => reads === 3 || completed);
  const stopping = capture.stop();
  finalRead.resolve({
    cursor: 11,
    events: [],
    hasMore: false,
    truncated: false,
  });

  assert.deepEqual(await stopping, {
    durationMs: 400,
    events: [
      {
        atMs: 100,
        button: 0,
        buttons: 0,
        frameId: "child-frame",
        type: "move",
        x: 170,
        y: 90,
      },
    ],
    viewport: { height: 300, width: 400 },
  });
  assert.deepEqual(
    operations
      .filter(([method]) => method === "Page.createIsolatedWorld")
      .map(([, params]) => params.frameId),
    ["main-frame", "child-frame"],
  );
});

test("re-arms a dynamically navigated frame before its first pointer event", async () => {
  const eventRead = deferred();
  const finalRead = deferred();
  const operations = [];
  let clock = 0;
  let reads = 0;
  const cdp = {
    async readEvents() {
      reads += 1;
      if (reads === 1) {
        return { cursor: 0, events: [], hasMore: false, truncated: false };
      }
      if (reads === 2) return eventRead.promise;
      return finalRead.promise;
    },
    async send(method, params) {
      operations.push([method, params]);
      if (method === "Page.getFrameTree") {
        return {
          frameTree: {
            frame: { id: "main-frame", url: "https://example.com/" },
          },
        };
      }
      if (method === "DOM.getFrameOwner") return { backendNodeId: 52 };
      if (method === "DOM.getBoxModel") {
        return {
          model: {
            content: [50, 40, 250, 40, 250, 140, 50, 140],
          },
        };
      }
      if (method === "Page.createIsolatedWorld") {
        return {
          executionContextId: params.frameId === "main-frame" ? 31 : 32,
        };
      }
      if (method === "Runtime.evaluate") {
        return {
          result: {
            value:
              params.contextId === 32
                ? { height: 50, width: 100 }
                : { height: 300, width: 400 },
          },
        };
      }
    },
  };

  const capture = await startCursorCapture({
    cdp,
    mainFrameId: "main-frame",
    now: () => clock,
  });
  clock = 200;
  eventRead.resolve({
    cursor: 2,
    events: [
      {
        method: "Page.frameNavigated",
        params: {
          frame: {
            id: "dynamic-frame",
            parentId: "main-frame",
            url: "https://embedded.example/",
          },
        },
        sequence: 1,
      },
      {
        method: "Runtime.bindingCalled",
        params: {
          executionContextId: 32,
          name: "__codexBrowserRecorderCursor",
          payload: JSON.stringify({
            button: 0,
            buttons: 0,
            height: 50,
            observedAtEpochMs: 10_200,
            type: "move",
            version: 1,
            width: 100,
            x: 10,
            y: 5,
          }),
        },
        sequence: 2,
      },
    ],
    hasMore: false,
    truncated: false,
  });
  let completed = false;
  void capture.completion.then(() => {
    completed = true;
  });
  await waitFor(() => reads === 3 || completed);
  const stopping = capture.stop();
  finalRead.resolve({
    cursor: 2,
    events: [],
    hasMore: false,
    truncated: false,
  });

  assert.deepEqual(await stopping, {
    durationMs: 200,
    events: [
      {
        atMs: 200,
        button: 0,
        buttons: 0,
        frameId: "dynamic-frame",
        type: "move",
        x: 70,
        y: 50,
      },
    ],
    viewport: { height: 300, width: 400 },
  });
  assert.deepEqual(
    operations
      .filter(([method]) => method === "Page.createIsolatedWorld")
      .map(([, params]) => params.frameId),
    ["main-frame", "dynamic-frame"],
  );
});

test("captures an out-of-process iframe through its flattened target", async () => {
  const eventRead = deferred();
  const finalRead = deferred();
  const operations = [];
  let clock = 0;
  let reads = 0;
  const cdp = {
    async readEvents() {
      reads += 1;
      if (reads === 1) {
        return {
          cursor: 1,
          events: [],
          hasMore: false,
          truncated: false,
        };
      }
      if (reads === 2) return eventRead.promise;
      return finalRead.promise;
    },
    async send(method, params, options) {
      const target =
        options?.target?.sessionId ?? options?.target?.targetId ?? null;
      operations.push([method, params, target]);
      if (method === "Page.getFrameTree") {
        if (target === "oopif-frame") {
          return {
            frameTree: {
              frame: {
                id: "oopif-frame",
                url: "https://embedded.example/",
              },
            },
          };
        }
        return {
          frameTree: {
            childFrames: [
              {
                frame: {
                  id: "oopif-frame",
                  parentId: "main-frame",
                  url: "https://embedded.example/",
                },
              },
            ],
            frame: { id: "main-frame", url: "https://example.com/" },
          },
        };
      }
      if (method === "DOM.getFrameOwner") return { backendNodeId: 62 };
      if (method === "DOM.getBoxModel") {
        return {
          model: {
            content: [100, 100, 300, 100, 300, 200, 100, 200],
          },
        };
      }
      if (method === "Page.createIsolatedWorld") {
        if (params.frameId === "oopif-frame" && target === null) {
          throw new Error("private renderer diagnostic");
        }
        return {
          executionContextId: target === "oopif-frame" ? 41 : 40,
        };
      }
      if (method === "Runtime.evaluate") {
        return {
          result: {
            value:
              target === "oopif-frame"
                ? { height: 100, width: 200 }
                : { height: 300, width: 400 },
          },
        };
      }
    },
  };

  const capture = await startCursorCapture({
    cdp,
    mainFrameId: "main-frame",
    now: () => clock,
  });
  const oopifBinding = operations.find(
    ([method, , target]) =>
      method === "Runtime.addBinding" && target === "oopif-frame",
  )?.[1]?.name;
  assert.equal(typeof oopifBinding, "string");
  clock = 300;
  eventRead.resolve({
    cursor: 2,
    events: [
      {
        method: "Runtime.bindingCalled",
        params: {
          executionContextId: 41,
          name: oopifBinding,
          payload: JSON.stringify({
            button: 0,
            buttons: 0,
            height: 100,
            observedAtEpochMs: 10_300,
            type: "move",
            version: 1,
            width: 200,
            x: 50,
            y: 25,
          }),
        },
        sequence: 2,
        source: { sessionId: "unreplayed-oopif-session" },
      },
    ],
    hasMore: false,
    truncated: false,
  });
  await waitFor(() => reads === 3);
  const stopping = capture.stop();
  finalRead.resolve({
    cursor: 2,
    events: [],
    hasMore: false,
    truncated: false,
  });

  assert.deepEqual(await stopping, {
    durationMs: 300,
    events: [
      {
        atMs: 300,
        button: 0,
        buttons: 0,
        frameId: "oopif-frame",
        type: "move",
        x: 150,
        y: 125,
      },
    ],
    viewport: { height: 300, width: 400 },
  });
  assert.ok(
    operations.some(
      ([method, params, target]) =>
        method === "Page.createIsolatedWorld" &&
        params.frameId === "oopif-frame" &&
        target === "oopif-frame",
    ),
  );
});

test("uses frame attachment state to map a dynamically attached OOPIF", async () => {
  const eventRead = deferred();
  const finalRead = deferred();
  let reads = 0;
  const cdp = {
    async readEvents() {
      reads += 1;
      if (reads === 1) {
        return { cursor: 0, events: [], hasMore: false, truncated: false };
      }
      if (reads === 2) return eventRead.promise;
      return finalRead.promise;
    },
    async send(method, params, options) {
      const target = options?.target?.sessionId ?? null;
      if (method === "Page.getFrameTree") {
        return {
          frameTree: {
            frame:
              target === null
                ? { id: "main-frame", url: "https://example.com/" }
                : {
                    id: "dynamic-oopif",
                    url: "https://embedded.example/",
                  },
          },
        };
      }
      if (method === "DOM.getFrameOwner") return { backendNodeId: 72 };
      if (method === "DOM.getBoxModel") {
        return {
          model: {
            content: [80, 60, 280, 60, 280, 160, 80, 160],
          },
        };
      }
      if (method === "Page.createIsolatedWorld") {
        if (params.frameId === "dynamic-oopif" && target === null) {
          throw new Error("frame is owned by its child target");
        }
        return {
          executionContextId: target === null ? 50 : 51,
        };
      }
      if (method === "Runtime.evaluate") {
        return {
          result: {
            value:
              target === null
                ? { height: 300, width: 400 }
                : { height: 100, width: 200 },
          },
        };
      }
    },
  };

  let clock = 0;
  const capture = await startCursorCapture({
    cdp,
    mainFrameId: "main-frame",
    now: () => clock,
  });
  clock = 200;
  eventRead.resolve({
    cursor: 3,
    events: [
      {
        method: "Page.frameAttached",
        params: {
          frameId: "dynamic-oopif",
          parentFrameId: "main-frame",
        },
        sequence: 1,
      },
      {
        method: "Target.attachedToTarget",
        params: {
          sessionId: "dynamic-oopif-session",
          targetInfo: { targetId: "dynamic-oopif", type: "iframe" },
        },
        sequence: 2,
      },
      {
        method: "Runtime.bindingCalled",
        params: {
          executionContextId: 51,
          name: "__codexBrowserRecorderCursor_1",
          payload: JSON.stringify({
            button: 0,
            buttons: 0,
            height: 100,
            observedAtEpochMs: 10_400,
            type: "move",
            version: 1,
            width: 200,
            x: 20,
            y: 10,
          }),
        },
        sequence: 3,
        source: { sessionId: "dynamic-oopif-session" },
      },
    ],
    hasMore: false,
    truncated: false,
  });
  let dynamicCompleted = false;
  void capture.completion.then(() => {
    dynamicCompleted = true;
  });
  await waitFor(() => reads === 3 || dynamicCompleted);
  const stopping = capture.stop();
  finalRead.resolve({
    cursor: 3,
    events: [],
    hasMore: false,
    truncated: false,
  });

  assert.deepEqual((await stopping).events, [
    {
      atMs: 200,
      button: 0,
      buttons: 0,
      frameId: "dynamic-oopif",
      type: "move",
      x: 100,
      y: 70,
    },
  ]);
});

test("drains every buffered tail event before cursor capture stops", async () => {
  const firstTail = deferred();
  let reads = 0;
  const pointerEvent = (sequence, type, x) => ({
    method: "Runtime.bindingCalled",
    params: {
      executionContextId: 61,
      name: "__codexBrowserRecorderCursor",
      payload: JSON.stringify({
        button: 0,
        buttons: type === "down" ? 1 : 0,
        height: 100,
        observedAtEpochMs: 10_500 + sequence,
        type,
        version: 1,
        width: 200,
        x,
        y: 20,
      }),
    },
    sequence,
  });
  const cdp = {
    async readEvents() {
      reads += 1;
      if (reads === 1) {
        return { cursor: 0, events: [], hasMore: false, truncated: false };
      }
      if (reads === 2) return firstTail.promise;
      return {
        cursor: 2,
        events: [pointerEvent(2, "down", 30)],
        hasMore: false,
        truncated: false,
      };
    },
    async send(method, params) {
      if (method === "Page.getFrameTree") {
        return { frameTree: { frame: { id: "main-frame" } } };
      }
      if (method === "Page.createIsolatedWorld") {
        return { executionContextId: 61 };
      }
      if (method === "Runtime.evaluate") {
        return { result: { value: { height: 100, width: 200 } } };
      }
    },
  };
  let clock = 0;
  const capture = await startCursorCapture({
    cdp,
    mainFrameId: "main-frame",
    now: () => clock,
  });
  clock = 100;
  const stopping = capture.stop();
  firstTail.resolve({
    cursor: 1,
    events: [pointerEvent(1, "move", 10)],
    hasMore: true,
    truncated: false,
  });

  assert.deepEqual(
    (await stopping).events.map(({ type, x }) => ({ type, x })),
    [
      { type: "move", x: 10 },
      { type: "down", x: 30 },
    ],
  );
});

test("rejects perspective frame geometry instead of shifting endpoints", async () => {
  let reads = 0;
  const cdp = {
    async readEvents() {
      reads += 1;
      if (reads > 2) return new Promise(() => {});
      return { cursor: 0, events: [], hasMore: false, truncated: false };
    },
    async send(method, params) {
      if (method === "Page.getFrameTree") {
        return {
          frameTree: {
            childFrames: [
              {
                frame: {
                  id: "perspective-frame",
                  parentId: "main-frame",
                },
              },
            ],
            frame: { id: "main-frame" },
          },
        };
      }
      if (method === "DOM.getFrameOwner") return { backendNodeId: 81 };
      if (method === "DOM.getBoxModel") {
        return {
          model: { content: [0, 0, 200, 0, 180, 100, 20, 100] },
        };
      }
      if (method === "Page.createIsolatedWorld") {
        return { executionContextId: params.frameId === "main-frame" ? 80 : 81 };
      }
      if (method === "Runtime.evaluate") {
        return { result: { value: { height: 100, width: 200 } } };
      }
    },
  };

  await assert.rejects(
    startCursorCapture({ cdp, mainFrameId: "main-frame", now: () => 0 }),
    { code: "cursor_recording_failed" },
  );
  assert.equal(reads >= 1, true);
});

test("captures observed pointer events without relying on DOM trust provenance", async () => {
  const eventRead = deferred();
  const finalRead = deferred();
  const listeners = new Map();
  const payloads = [];
  let reads = 0;
  const sandbox = {
    __codexBrowserRecorderCursor(payload) {
      payloads.push(payload);
    },
    addEventListener(type, listener) {
      listeners.set(type, listener);
    },
    cancelAnimationFrame() {},
    innerHeight: 100,
    innerWidth: 200,
    performance: { timeOrigin: 10_000 },
    removeEventListener() {},
    requestAnimationFrame(callback) {
      callback();
      return 1;
    },
  };
  const cdp = {
    async readEvents() {
      reads += 1;
      if (reads === 1) {
        return { cursor: 0, events: [], hasMore: false, truncated: false };
      }
      if (reads === 2) return eventRead.promise;
      return finalRead.promise;
    },
    async send(method, params) {
      if (method === "Page.getFrameTree") {
        return { frameTree: { frame: { id: "main-frame" } } };
      }
      if (method === "Page.createIsolatedWorld") {
        return { executionContextId: 91 };
      }
      if (
        method === "Runtime.evaluate" &&
        params.expression.includes("const bindingName")
      ) {
        const value = runInNewContext(params.expression, sandbox);
        return { result: { value } };
      }
      if (method === "Runtime.evaluate") {
        return { result: { value: { height: 100, width: 200 } } };
      }
    },
  };

  let clock = 0;
  const capture = await startCursorCapture({
    cdp,
    mainFrameId: "main-frame",
    now: () => clock,
  });
  const event = {
    button: 0,
    buttons: 0,
    clientX: 40,
    clientY: 30,
    timeStamp: 600,
  };
  listeners.get("click")({ ...event, isTrusted: false });
  listeners.get("wheel")({ ...event, isTrusted: true });
  assert.equal(payloads.length, 2);

  clock = 100;
  eventRead.resolve({
    cursor: 2,
    events: payloads.map((payload, index) => ({
      method: "Runtime.bindingCalled",
      params: {
        executionContextId: 91,
        name: "__codexBrowserRecorderCursor",
        payload,
      },
      sequence: index + 1,
    })),
    hasMore: false,
    truncated: false,
  });
  await waitFor(() => reads === 3);
  const stopping = capture.stop();
  finalRead.resolve({
    cursor: 2,
    events: [],
    hasMore: false,
    truncated: false,
  });
  assert.deepEqual((await stopping).events.map(({ type }) => type), [
    "click",
    "wheel",
  ]);
});

test("fails closed when the bounded cursor timeline overflows", async () => {
  const finalRead = deferred();
  const operations = [];
  const batches = [];
  let sequence = 0;
  for (let batchIndex = 0; batchIndex < 7; batchIndex += 1) {
    const batchSize = batchIndex === 6 ? 1 : 1000;
    const events = [];
    for (let index = 0; index < batchSize; index += 1) {
      sequence += 1;
      events.push({
        method: "Runtime.bindingCalled",
        params: {
          executionContextId: 71,
          name: "__codexBrowserRecorderCursor",
          payload: JSON.stringify({
            button: 0,
            buttons: 0,
            height: 300,
            observedAtEpochMs: 20_000 + sequence,
            type: "move",
            version: 1,
            width: 400,
            x: index % 400,
            y: index % 300,
          }),
        },
        sequence,
      });
    }
    batches.push({
      cursor: sequence,
      events,
      hasMore: batchIndex < 6,
      truncated: false,
    });
  }
  let reads = 0;
  const cdp = {
    async readEvents() {
      reads += 1;
      if (reads === 1) {
        return { cursor: 0, events: [], hasMore: false, truncated: false };
      }
      return batches.shift() ?? finalRead.promise;
    },
    async send(method, params) {
      operations.push([method, params]);
      if (method === "Page.getFrameTree") {
        return {
          frameTree: {
            frame: { id: "main-frame", url: "https://example.com/" },
          },
        };
      }
      if (method === "Page.createIsolatedWorld") {
        return { executionContextId: 71 };
      }
      if (method === "Runtime.evaluate") {
        return { result: { value: { height: 300, width: 400 } } };
      }
    },
  };

  const capture = await startCursorCapture({
    cdp,
    mainFrameId: "main-frame",
    now: () => 100,
  });
  let completed = false;
  void capture.completion.then(() => {
    completed = true;
  });
  await waitFor(() => reads === 9 || completed);
  const stopping = capture.stop();
  finalRead.resolve({
    cursor: sequence,
    events: [],
    hasMore: false,
    truncated: false,
  });

  await assert.rejects(stopping, { code: "cursor_recording_failed" });
  assert.ok(
    operations.some(([method]) => method === "Runtime.removeBinding"),
  );
  assert.equal(
    operations.some(([method]) => method === "Target.setAutoAttach"),
    false,
  );
});

test("renders first-event visibility, movement, and a bounded click ring", async () => {
  const directory = mkdtempSync(join(tmpdir(), "cursor-recording-render-"));
  const inputPath = join(directory, "base.mp4");
  const outputPath = join(directory, "cursor.mp4");
  try {
    execFileSync(
      ffmpegPath,
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-f",
        "lavfi",
        "-i",
        "color=c=#204060:s=320x180:r=10:d=1",
        "-an",
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
        "-y",
        inputPath,
      ],
      { stdio: "pipe" },
    );

    await renderCursorRecording({
      ffmpegPath,
      inputPath,
      outputPath,
      timeline: {
        durationMs: 1000,
        events: [
          {
            atMs: 300,
            button: 0,
            buttons: 0,
            frameId: "main-frame",
            type: "move",
            x: 80,
            y: 90,
          },
          {
            atMs: 600,
            button: 0,
            buttons: 0,
            frameId: "main-frame",
            type: "move",
            x: 160,
            y: 90,
          },
          {
            atMs: 600,
            button: 0,
            buttons: 1,
            frameId: "main-frame",
            type: "down",
            x: 160,
            y: 90,
          },
        ],
        viewport: { height: 180, width: 320 },
      },
    });

    assert.equal(visibleBounds(outputPath, 1), null);
    const first = visibleBounds(outputPath, 3);
    assert.ok(first.minX >= 78 && first.minX <= 82);
    const moving = visibleBounds(outputPath, 5);
    assert.ok(moving.minX > first.minX && moving.minX < 160);
    const pressed = visibleBounds(outputPath, 6);
    assert.ok(pressed.minX < 150);
    assert.ok(pressed.maxX > 180);
    const settled = visibleBounds(outputPath, 9);
    assert.ok(settled.minX >= 158 && settled.minX <= 162);
    assert.ok(settled.maxX < pressed.maxX);

    const probe = JSON.parse(
      execFileSync(
        ffprobePath,
        [
          "-v",
          "error",
          "-show_entries",
          "stream=codec_name,pix_fmt,codec_type",
          "-of",
          "json",
          outputPath,
        ],
        { encoding: "utf8" },
      ),
    );
    assert.deepEqual(probe.streams, [
      { codec_name: "h264", codec_type: "video", pix_fmt: "yuv420p" },
    ]);
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test("kills a timed-out cursor compositor before it can write late output", async () => {
  const directory = mkdtempSync(join(tmpdir(), "cursor-render-timeout-"));
  const executable = join(directory, "late-ffmpeg.mjs");
  const outputPath = join(directory, "cursor.mp4");
  try {
    writeFileSync(
      executable,
      `#!/usr/bin/env node\nimport { writeFile } from "node:fs/promises";\nconst output = process.argv.at(-1);\nsetTimeout(() => void writeFile(output, "late"), 150);\nsetTimeout(() => {}, 10_000);\n`,
    );
    chmodSync(executable, 0o700);

    await assert.rejects(
      renderCursorRecording({
        ffmpegPath: executable,
        inputPath: join(directory, "base.mp4"),
        outputPath,
        timeoutMs: 25,
        timeline: {
          durationMs: 1000,
          events: [],
          viewport: { height: 180, width: 320 },
        },
      }),
      { code: "cursor_recording_failed" },
    );
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(existsSync(outputPath), false);
    assert.equal(existsSync(`${outputPath}.partial`), false);
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test("coordinates cursor capture and composition inside the recording transaction", async () => {
  const finalRead = deferred();
  const operations = [];
  let reads = 0;
  const cdp = {
    async readEvents() {
      reads += 1;
      if (reads === 1) {
        return { cursor: 0, events: [], hasMore: false, truncated: false };
      }
      if (reads === 2) {
        return {
          cursor: 1,
          events: [
            {
              method: "Page.screencastFrame",
              params: {
                data: jpeg.toString("base64"),
                metadata: { timestamp: 1 },
                sessionId: 9,
              },
              sequence: 1,
            },
          ],
          hasMore: false,
          truncated: false,
        };
      }
      return finalRead.promise;
    },
    async send(method) {
      operations.push(method);
      if (method === "Page.getFrameTree") {
        return {
          frameTree: {
            frame: { id: "main-frame", url: "https://example.com/" },
          },
        };
      }
      if (method === "Page.captureScreenshot") {
        return { data: jpeg.toString("base64") };
      }
    },
  };
  const timeline = {
    durationMs: 500,
    events: [
      {
        atMs: 200,
        button: 0,
        buttons: 0,
        frameId: "main-frame",
        type: "move",
        x: 100,
        y: 80,
      },
    ],
    viewport: { height: 180, width: 320 },
  };
  const sink = {
    stats: { encoderExitCode: null, outputBytes: 100, outputSamples: 0 },
    accept() {
      this.stats.outputSamples += 1;
      return true;
    },
    async stop(options) {
      operations.push(["sink.stop", options]);
      this.stats.encoderExitCode = 0;
      return this.stats;
    },
  };

  const session = await startBrowserRecording({
    approvedOrigin: "https://example.com",
    cdp,
    cursorCaptureFactory: async (options) => {
      operations.push(["cursor.start", options.mainFrameId]);
      return {
        completion: new Promise(() => {}),
        stats: { cursorEventsCaptured: 1, cursorFramesObserved: 1 },
        async stop() {
          operations.push("cursor.stop");
          return timeline;
        },
      };
    },
    cursorRenderer: async (options) => {
      operations.push(["cursor.render", options]);
      return { outputBytes: 120, outputPath: options.outputPath };
    },
    ffmpegPath: "/unused/ffmpeg",
    firstFrameTimeoutMs: 1000,
    getOutputSize: async () => 0,
    maxDecodedBytes: 1024,
    maxDurationMs: 1000,
    maxOutputBytes: 1024,
    now: () => 100,
    outputPath: "/tmp/visible-cursor.mp4",
    readTimeoutMs: 0,
    resourceCheckIntervalMs: 1000,
    sinkFactory: (options) => {
      operations.push(["sink.start", options.outputPath]);
      sink.workingOutputPath = `${options.outputPath}.partial`;
      return sink;
    },
  });
  await session.ready;
  assert.deepEqual(session.stats.cursor, {
    cursorEventsCaptured: 1,
    cursorFramesObserved: 1,
  });
  await waitFor(() => reads === 3);
  const stopping = session.stop();
  finalRead.resolve({
    cursor: 1,
    events: [],
    hasMore: false,
    truncated: false,
  });
  const result = await stopping;

  const sinkStart = operations.find(([name]) => name === "sink.start");
  assert.notEqual(sinkStart[1], "/tmp/visible-cursor.mp4");
  const render = operations.find(([name]) => name === "cursor.render");
  assert.equal(render[1].inputPath, sinkStart[1]);
  assert.equal(render[1].outputPath, "/tmp/visible-cursor.mp4");
  assert.deepEqual(render[1].timeline, timeline);
  assert.equal(result.cursorEventsCaptured, 1);
  assert.equal(result.cursorFramesObserved, 1);
  assert.equal(result.outputPath, "/tmp/visible-cursor.mp4");
  assert.ok(operations.indexOf("cursor.stop") < operations.indexOf(render));
});
