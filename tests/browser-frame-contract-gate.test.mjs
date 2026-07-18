import assert from "node:assert/strict";
import test from "node:test";

import {
  runChromeFrameContractGate,
} from "../scripts/browser-frame-contract-gate.mjs";

const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

test("proves one direct Chrome frame and leaves no Browser tab", async () => {
  const calls = [];
  let reads = 0;
  const cdp = {
    async readEvents(options) {
      calls.push(["readEvents", options]);
      reads += 1;
      if (reads === 1) {
        return { cursor: 4, events: [], hasMore: false, truncated: false };
      }
      return {
        cursor: 5,
        events: [
          {
            method: "Page.screencastFrame",
            params: {
              data: jpeg.toString("base64"),
              metadata: { timestamp: 1 },
              sessionId: 7,
            },
          },
        ],
        hasMore: false,
        truncated: false,
      };
    },
    async send(method, params) {
      calls.push([method, params]);
      if (method === "Page.captureScreenshot") {
        throw new Error("contract gate must use the streamed frame");
      }
      if (method === "Page.getFrameTree") {
        return {
          frameTree: {
            frame: { id: "main", url: "https://example.com/" },
          },
        };
      }
    },
  };
  const tab = {
    capabilities: {
      async get(name) {
        calls.push(["capability", name]);
        return cdp;
      },
    },
    async close() {
      calls.push(["tab.close"]);
    },
    async goto(url) {
      calls.push(["tab.goto", url]);
    },
  };
  const browser = {
    tabs: {
      async new() {
        calls.push(["tabs.new"]);
        return tab;
      },
    },
  };

  const result = await runChromeFrameContractGate({ browser });

  assert.deepEqual(result, {
    contractVersion: 1,
    framesAcknowledged: 1,
    framesReceived: 1,
    status: "passed",
    surface: "chrome",
  });
  assert.equal(
    calls.some(([method]) => method === "Page.captureScreenshot"),
    false,
  );
  assert.equal(
    calls.filter(([method]) => method === "Page.screencastFrameAck").length,
    1,
  );
  assert.deepEqual(calls.at(-2), ["Page.stopScreencast", undefined]);
  assert.deepEqual(calls.at(-1), ["tab.close"]);
});

test("fails closed when Chrome produces no frame and still closes the tab", async () => {
  let now = 0;
  let tabClose = 0;
  const cdp = {
    async readEvents() {
      return { cursor: 0, events: [], hasMore: false, truncated: false };
    },
    async send(method) {
      if (method === "Page.getFrameTree") {
        return {
          frameTree: {
            frame: { id: "main", url: "https://example.com/" },
          },
        };
      }
    },
  };
  const browser = {
    tabs: {
      async new() {
        return {
          capabilities: { async get() { return cdp; } },
          async close() {
            tabClose += 1;
          },
          async goto() {},
        };
      },
    },
  };

  await assert.rejects(
    runChromeFrameContractGate({
      browser,
      dependencies: {
        now: () => now,
        async waitTurn() { now += 5; },
      },
      firstFrameTimeoutMs: 5,
    }),
    (error) => error.code === "frame_stream_unavailable",
  );
  assert.equal(tabClose, 1);
});

test("maps an invalid main-frame URL to the stable origin failure", async () => {
  let tabClose = 0;
  const browser = {
    tabs: {
      async new() {
        return {
          capabilities: {
            async get() {
              return {
                async readEvents() {
                  throw new Error("events must not be read");
                },
                async send(method) {
                  if (method === "Page.getFrameTree") {
                    return { frameTree: { frame: { url: undefined } } };
                  }
                },
              };
            },
          },
          async close() { tabClose += 1; },
          async goto() {},
        };
      },
    },
  };

  await assert.rejects(
    runChromeFrameContractGate({ browser }),
    (error) =>
      error.code === "origin_verification_failed" &&
      error.cause instanceof Error,
  );
  assert.equal(tabClose, 1);
});

test("bounds a hanging fresh-tab close", async () => {
  let reads = 0;
  const browser = {
    tabs: {
      async new() {
        return {
          capabilities: {
            async get() {
              return {
                async readEvents() {
                  reads += 1;
                  return reads === 1
                    ? { cursor: 1, events: [], truncated: false }
                    : {
                        cursor: 2,
                        events: [
                          {
                            method: "Page.screencastFrame",
                            params: {
                              data: jpeg.toString("base64"),
                              metadata: {},
                              sessionId: 1,
                            },
                          },
                        ],
                        truncated: false,
                      };
                },
                async send(method) {
                  if (method === "Page.getFrameTree") {
                    return {
                      frameTree: {
                        frame: { url: "https://example.com/" },
                      },
                    };
                  }
                },
              };
            },
          },
          close() {
            return new Promise(() => {});
          },
          async goto() {},
        };
      },
    },
  };

  await assert.rejects(
    runChromeFrameContractGate({ browser, cleanupTimeoutMs: 5 }),
    (error) => error.code === "release_gate_cleanup_failed",
  );
});

test("keeps primary gate failure and annotates cleanup failure", async () => {
  let now = 0;
  const browser = {
    tabs: {
      async new() {
        return {
          capabilities: {
            async get() {
              return {
                async readEvents() {
                  return { cursor: 0, events: [], truncated: false };
                },
                async send(method) {
                  if (method === "Page.getFrameTree") {
                    return {
                      frameTree: {
                        frame: { url: "https://example.com/" },
                      },
                    };
                  }
                },
              };
            },
          },
          async close() {
            throw new Error("close failed");
          },
          async goto() {},
        };
      },
    },
  };

  await assert.rejects(
    runChromeFrameContractGate({
      browser,
      dependencies: {
        now: () => now,
        async waitTurn() {
          now += 5;
        },
      },
      firstFrameTimeoutMs: 5,
    }),
    (error) =>
      error.code === "frame_stream_unavailable" &&
      error.cleanupFailure?.code === "release_gate_cleanup_failed",
  );
});

test("reports simultaneous frame-stream and Browser-tab cleanup failures", async () => {
  let reads = 0;
  const cdp = {
    async readEvents() {
      reads += 1;
      return reads === 1
        ? { cursor: 1, events: [], truncated: false }
        : {
            cursor: 2,
            events: [
              {
                method: "Page.screencastFrame",
                params: {
                  data: jpeg.toString("base64"),
                  metadata: {},
                  sessionId: 1,
                },
              },
            ],
            truncated: false,
          };
    },
    async send(method) {
      if (method === "Page.getFrameTree") {
        return {
          frameTree: { frame: { url: "https://example.com/" } },
        };
      }
      if (method === "Page.stopScreencast") {
        throw new Error("private stop failure");
      }
    },
  };
  const browser = {
    tabs: {
      async new() {
        return {
          capabilities: { async get() { return cdp; } },
          async close() {
            throw new Error("private close failure");
          },
          async goto() {},
        };
      },
    },
  };

  await assert.rejects(
    runChromeFrameContractGate({ browser }),
    (error) => {
      assert.equal(error.code, "release_gate_cleanup_failed");
      assert.equal(error.frameStreamCleanupIncomplete, true);
      assert.equal(error.browserTabCleanupIncomplete, true);
      assert.match(error.message, /frame stream and fresh Browser tab/u);
      assert.doesNotMatch(error.message, /private/u);
      return true;
    },
  );
});

test("reclaims a tab that appears after its acquisition timeout", async () => {
  const pendingTab = deferred();
  let tabClose = 0;
  const tab = {
    async close() {
      tabClose += 1;
    },
  };
  const running = runChromeFrameContractGate({
    browser: { tabs: { new: () => pendingTab.promise } },
    cleanupTimeoutMs: 50,
    operationTimeoutMs: 5,
  });
  setTimeout(() => pendingTab.resolve(tab), 10);

  await assert.rejects(
    running,
    (error) => error.code === "release_gate_timeout",
  );
  assert.equal(tabClose, 1);
});

test("stops a screencast that starts after its operation timeout", async () => {
  const pendingStart = deferred();
  let stopCalls = 0;
  const cdp = {
    async readEvents() {
      return { cursor: 0, events: [], truncated: false };
    },
    async send(method) {
      if (method === "Page.getFrameTree") {
        return {
          frameTree: { frame: { url: "https://example.com/" } },
        };
      }
      if (method === "Page.startScreencast") return pendingStart.promise;
      if (method === "Page.stopScreencast") stopCalls += 1;
    },
  };
  const browser = {
    tabs: {
      async new() {
        return {
          capabilities: { async get() { return cdp; } },
          async close() {},
          async goto() {},
        };
      },
    },
  };
  const running = runChromeFrameContractGate({
    browser,
    cleanupTimeoutMs: 50,
    operationTimeoutMs: 5,
  });
  setTimeout(() => pendingStart.resolve(), 10);

  await assert.rejects(
    running,
    (error) => error.code === "release_gate_timeout",
  );
  assert.equal(stopCalls, 1);
});
