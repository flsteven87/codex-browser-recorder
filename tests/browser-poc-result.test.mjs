import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  inspectTopLevelFrame,
  runBrowserPocGate,
  startBrowserPocForTab,
} from "../plugins/codex-browser-recorder/skills/record-browser/scripts/run-browser-recording.mjs";
import { resolveExecutable } from "./test-tools.mjs";

const temporaryRoot = mkdtempSync(join(tmpdir(), "browser-poc-result-test-"));
const ffmpegPath = resolveExecutable("ffmpeg");
const ffprobePath = resolveExecutable("ffprobe");

test.after(() => {
  rmSync(temporaryRoot, { force: true, recursive: true });
});

test("accepts a top-level frame on the approved origin", async () => {
  const methods = [];
  const cdp = {
    async send(method) {
      methods.push(method);
      return {
        frameTree: {
          frame: { id: "main-frame", url: "https://example.com/next" },
        },
      };
    },
  };

  assert.deepEqual(
    await inspectTopLevelFrame({
      approvedOrigin: "https://example.com",
      cdp,
    }),
    { frameId: "main-frame" },
  );
  assert.deepEqual(methods, ["Page.getFrameTree"]);
});

test("rejects invalid top-level origin verification configuration", async () => {
  for (const variant of [
    { approvedOrigin: "https://example.com", cdp: {} },
    { approvedOrigin: "", cdp: { async send() {} } },
    { approvedOrigin: "https://example.com/path", cdp: { async send() {} } },
  ]) {
    await assert.rejects(
      inspectTopLevelFrame(variant),
      (error) =>
        error.code === "invalid_configuration" &&
        error.message ===
          "Top-level origin verification configuration is invalid",
    );
  }
});

test("rejects a different origin without exposing it", async () => {
  const secretUrl = "https://other.example/?token=must-not-leak";
  const cdp = {
    async send() {
      return { frameTree: { frame: { id: "main-frame", url: secretUrl } } };
    },
  };

  await assert.rejects(
    inspectTopLevelFrame({
      approvedOrigin: "https://example.com",
      cdp,
    }),
    (error) =>
      error.code === "origin_not_allowed" &&
      !error.message.includes(secretUrl) &&
      !JSON.stringify(error).includes(secretUrl),
  );
});

test("maps missing or failed frame-tree inspection to a stable error", async () => {
  for (const send of [
    async () => ({}),
    async () => {
      throw new Error("raw CDP diagnostic");
    },
  ]) {
    await assert.rejects(
      inspectTopLevelFrame({
        approvedOrigin: "https://example.com",
        cdp: { send },
      }),
      (error) =>
        error.code === "origin_verification_failed" &&
        !error.message.includes("raw CDP diagnostic"),
    );
  }
});

test("acquires a fresh CDP capability for every recording session", async () => {
  const acquired = [];
  const commandOrders = [];
  const createdCdps = [];
  const tab = {
    capabilities: {
      async get(name) {
        acquired.push(name);
        const methods = [];
        let reads = 0;
        const cdp = {
          async send(method) {
            methods.push(method);
            if (method === "Page.getFrameTree") {
              return {
                frameTree: {
                  frame: {
                    id: "main-frame",
                    url: "https://example.com/start",
                  },
                },
              };
            }
          },
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
            if (reads === 2) {
              return {
                cursor: 2,
                events: [
                  {
                    method: "Page.screencastFrame",
                    params: {
                      data: Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString(
                        "base64",
                      ),
                      metadata: { timestamp: 1 },
                      sessionId: 1,
                    },
                  },
                ],
                hasMore: false,
                truncated: false,
              };
            }
            await new Promise((resolve) => setTimeout(resolve, 2));
            return {
              cursor: 2,
              events: [],
              hasMore: false,
              truncated: false,
            };
          },
        };
        commandOrders.push(methods);
        createdCdps.push(cdp);
        return cdp;
      },
    },
  };

  for (let index = 0; index < 2; index += 1) {
    const session = await startBrowserPocForTab({
      approvedOrigin: "https://example.com",
      ffmpegPath: "/unused/ffmpeg",
      fps: 10,
      maxDecodedBytes: 1024,
      outputPath: `/tmp/unused-${index}.webm`,
      readTimeoutMs: 1,
      sinkFactory: () => ({
        stats: {
          backpressureDrops: 0,
          encoderExitCode: null,
          outputSamples: 0,
        },
        accept() {
          this.stats.outputSamples += 1;
          return true;
        },
        async stop() {
          this.stats.encoderExitCode = 0;
          return this.stats;
        },
      }),
      tab,
    });
    await session.ready;
    await session.stop();
  }

  assert.deepEqual(acquired, ["cdp", "cdp"]);
  assert.notEqual(createdCdps[0], createdCdps[1]);
  assert.deepEqual(
    commandOrders.map((methods) => methods.slice(0, 3)),
    [
      ["Page.enable", "Page.getFrameTree", "Page.startScreencast"],
      ["Page.enable", "Page.getFrameTree", "Page.startScreencast"],
    ],
  );
});

test("runs a complete recording gate and writes a validated result", async () => {
  let reads = 0;
  const tab = {
    capabilities: {
      async get() {
        return {
          async send(method) {
            if (method === "Page.getFrameTree") {
              return {
                frameTree: {
                  frame: {
                    id: "main-frame",
                    url: "https://example.com/start",
                  },
                },
              };
            }
          },
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
            if (reads === 2) {
              return {
                cursor: 2,
                events: [
                  {
                    method: "Page.screencastFrame",
                    params: {
                      data: Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString(
                        "base64",
                      ),
                      metadata: { timestamp: 1 },
                      sessionId: 1,
                    },
                  },
                ],
                hasMore: false,
                truncated: false,
              };
            }
            await new Promise((resolve) => setTimeout(resolve, 2));
            return {
              cursor: 2,
              events: [],
              hasMore: false,
              truncated: false,
            };
          },
        };
      },
    },
  };

  const gate = await runBrowserPocGate({
    approvedOrigin: "https://example.com",
    durationToleranceSeconds: 1,
    ffmpegPath,
    ffprobePath,
    fps: 10,
    maxDecodedBytes: 1024,
    maxHeight: 720,
    maxWidth: 1280,
    minBytes: 100,
    readTimeoutMs: 1,
    recordingDurationMs: 10,
    sinkFactory: ({ outputPath }) => ({
      stats: {
        backpressureDrops: 0,
        encoderExitCode: null,
        outputSamples: 1,
      },
      accept: () => true,
      async stop() {
        execFileSync(ffmpegPath, [
          "-hide_banner",
          "-loglevel",
          "error",
          "-f",
          "lavfi",
          "-i",
          "color=c=purple:s=320x180:d=0.2",
          "-an",
          "-c:v",
          "libvpx",
          "-pix_fmt",
          "yuv420p",
          "-y",
          outputPath,
        ]);
        this.stats.encoderExitCode = 0;
        return this.stats;
      },
    }),
    tab,
    temporaryRoot,
  });

  assert.equal(gate.result.status, "passed");
  assert.equal(gate.result.media.codecName, "vp8");
  assert.equal(readFileSync(gate.paths.resultPath, "utf8").length > 0, true);
});

test("cancels the recording-window timer after an automatic limit", async () => {
  let reads = 0;
  const tab = {
    capabilities: {
      async get() {
        return {
          async send(method) {
            if (method === "Page.getFrameTree") {
              return {
                frameTree: {
                  frame: {
                    id: "main-frame",
                    url: "https://example.com/start",
                  },
                },
              };
            }
          },
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
            if (reads === 2) {
              return {
                cursor: 2,
                events: [
                  {
                    method: "Page.screencastFrame",
                    params: {
                      data: Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString(
                        "base64",
                      ),
                      metadata: { timestamp: 1 },
                      sessionId: 1,
                    },
                  },
                ],
                hasMore: false,
                truncated: false,
              };
            }
            await new Promise((resolve) => setTimeout(resolve, 2));
            return {
              cursor: 2,
              events: [],
              hasMore: false,
              truncated: false,
            };
          },
        };
      },
    },
  };
  const timeoutCount = () =>
    process
      .getActiveResourcesInfo()
      .filter((resource) => resource === "Timeout").length;
  const before = timeoutCount();

  const gate = await runBrowserPocGate({
    approvedOrigin: "https://example.com",
    durationToleranceSeconds: 1,
    ffmpegPath,
    ffprobePath,
    fps: 10,
    maxDecodedBytes: 1024,
    maxDurationMs: 15,
    maxHeight: 720,
    maxWidth: 1280,
    minBytes: 100,
    readTimeoutMs: 1,
    recordingDurationMs: 1000,
    sinkFactory: () => ({
      stats: {
        backpressureDrops: 0,
        encoderExitCode: null,
        outputSamples: 1,
      },
      accept: () => true,
      async stop() {
        this.stats.encoderExitCode = 0;
        return this.stats;
      },
    }),
    tab,
    temporaryRoot,
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(gate.result.failureCode, "recording_duration_limit");
  assert.equal(timeoutCount(), before);
});
