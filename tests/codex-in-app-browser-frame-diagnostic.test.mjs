import assert from "node:assert/strict";
import test from "node:test";

import {
  runCodexInAppBrowserFrameDiagnostic,
} from "../scripts/codex-in-app-browser-frame-diagnostic.mjs";

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

function addOwnedTabInventory(browser) {
  const owned = new Map();
  const createTab = browser.tabs.new;
  let nextId = 0;
  browser.tabs.new = async function newTrackedTab(...args) {
    const tab = await Reflect.apply(createTab, this, args);
    tab.id ??= `owned-diagnostic-${nextId += 1}`;
    tab.screenshot ??= async () => jpeg;
    const close = tab.close;
    tab.close = async function closeTrackedTab(...closeArgs) {
      const result = await Reflect.apply(close, this, closeArgs);
      owned.delete(tab.id);
      return result;
    };
    owned.set(tab.id, tab);
    return tab;
  };
  browser.tabs.list = async () =>
    [...owned.values()].map(({ id }) => ({ id }));
  return browser;
}

test("reports one direct Codex In-app Browser frame as diagnostic-only evidence", async () => {
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
    id: "owned-diagnostic-tab",
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
    async screenshot(options) {
      calls.push(["tab.screenshot", options]);
      return jpeg;
    },
  };
  const browser = {
    tabs: {
      async list() {
        calls.push(["tabs.list"]);
        return [];
      },
      async new() {
        calls.push(["tabs.new"]);
        return tab;
      },
    },
  };

  const result = await runCodexInAppBrowserFrameDiagnostic({ browser });

  assert.deepEqual(result, {
    contractVersion: 2,
    diagnostic: "low_level_cdp_frame_probe",
    framesAcknowledged: 1,
    framesReceived: 1,
    releaseAcceptance: false,
    status: "passed",
    surface: "Codex In-app Browser",
  });
  assert.equal(
    calls.some(([method]) => method === "Page.captureScreenshot"),
    false,
  );
  assert.deepEqual(calls.slice(0, 4), [
    ["tabs.new"],
    ["tab.goto", "https://example.com/"],
    ["tab.screenshot", { fullPage: false }],
    ["capability", "cdp"],
  ]);
  assert.equal(
    calls.filter(([method]) => method === "Page.screencastFrameAck").length,
    1,
  );
  assert.deepEqual(calls.slice(-3), [
    ["Page.stopScreencast", undefined],
    ["tab.close"],
    ["tabs.list"],
  ]);
});

test("fails closed when the Codex In-app Browser produces no frame and still closes the tab", async () => {
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
  addOwnedTabInventory(browser);

  await assert.rejects(
    runCodexInAppBrowserFrameDiagnostic({
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

test("retries transient inventory failure without closing the tab twice", async () => {
  let closeCalls = 0;
  let inventoryCalls = 0;
  let reads = 0;
  const cdp = {
    async readEvents() {
      reads += 1;
      return reads === 1
        ? { cursor: 1, events: [], hasMore: false, truncated: false }
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
            hasMore: false,
            truncated: false,
          };
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
  const tab = {
    id: "owned-diagnostic-tab",
    capabilities: { async get() { return cdp; } },
    async close() {
      closeCalls += 1;
    },
    async goto() {},
    async screenshot() {
      return jpeg;
    },
  };
  const browser = {
    tabs: {
      async list() {
        inventoryCalls += 1;
        if (inventoryCalls === 1) {
          throw new Error("transient inventory failure");
        }
        return [];
      },
      async new() {
        return tab;
      },
    },
  };

  const result = await runCodexInAppBrowserFrameDiagnostic({ browser });

  assert.equal(result.status, "passed");
  assert.equal(closeCalls, 1);
  assert.equal(inventoryCalls, 2);
});

test("maps an invalid main-frame URL to the stable origin failure", async () => {
  let tabClose = 0;
  const secret = "diagnostic-url-secret-token";
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
                    return {
                      frameTree: {
                        frame: {
                          url: {
                            toString() {
                              throw new Error(secret);
                            },
                          },
                        },
                      },
                    };
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
  addOwnedTabInventory(browser);

  await assert.rejects(
    runCodexInAppBrowserFrameDiagnostic({ browser }),
    (error) => {
      assert.equal(error.code, "origin_verification_failed");
      assert.equal(
        error.message,
        "Codex In-app Browser diagnostic fixture returned an invalid main-frame URL",
      );
      assert.equal(error.cause, undefined);
      assert.doesNotMatch(JSON.stringify(error), new RegExp(secret, "u"));
      assert.doesNotMatch(error.stack, new RegExp(secret, "u"));
      return true;
    },
  );
  assert.equal(tabClose, 1);
});

test("maps immediate Browser and CDP rejections to fixed safe failures", async (t) => {
  const secret = "diagnostic-operation-secret-token";
  const cases = [
    {
      browser: {
        tabs: {
          async list() {
            return [];
          },
          async new() {
            throw new Error(secret);
          },
        },
      },
      name: "fresh-tab creation",
    },
    {
      browser: addOwnedTabInventory({
        tabs: {
          async new() {
            return {
              capabilities: {
                async get() {
                  return {
                    async readEvents() {
                      return {
                        cursor: 0,
                        events: [],
                        truncated: false,
                      };
                    },
                    async send() {
                      throw new Error(secret);
                    },
                  };
                },
              },
              async close() {},
              async goto() {},
            };
          },
        },
      }),
      name: "CDP command",
    },
  ];

  for (const current of cases) {
    await t.test(current.name, async () => {
      await assert.rejects(
        runCodexInAppBrowserFrameDiagnostic({
          browser: current.browser,
        }),
        (error) => {
          assert.equal(error.code, "diagnostic_operation_failed");
          assert.equal(
            error.message,
            "Codex In-app Browser frame diagnostic operation failed",
          );
          assert.equal(error.cause, undefined);
          assert.doesNotMatch(JSON.stringify(error), new RegExp(secret, "u"));
          assert.doesNotMatch(error.stack, new RegExp(secret, "u"));
          return true;
        },
      );
    });
  }
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
  addOwnedTabInventory(browser);

  await assert.rejects(
    runCodexInAppBrowserFrameDiagnostic({ browser, cleanupTimeoutMs: 5 }),
    (error) => error.code === "diagnostic_cleanup_failed",
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
  addOwnedTabInventory(browser);

  await assert.rejects(
    runCodexInAppBrowserFrameDiagnostic({
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
      error.cleanupFailure?.code === "diagnostic_cleanup_failed",
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
  addOwnedTabInventory(browser);

  await assert.rejects(
    runCodexInAppBrowserFrameDiagnostic({ browser }),
    (error) => {
      assert.equal(error.code, "diagnostic_cleanup_failed");
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
  const browser = addOwnedTabInventory({
    tabs: { new: () => pendingTab.promise },
  });
  const running = runCodexInAppBrowserFrameDiagnostic({
    browser,
    cleanupTimeoutMs: 50,
    operationTimeoutMs: 5,
  });
  setTimeout(() => pendingTab.resolve(tab), 10);

  await assert.rejects(
    running,
    (error) => error.code === "diagnostic_timeout",
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
  addOwnedTabInventory(browser);
  const running = runCodexInAppBrowserFrameDiagnostic({
    browser,
    cleanupTimeoutMs: 50,
    operationTimeoutMs: 5,
  });
  setTimeout(() => pendingStart.resolve(), 10);

  await assert.rejects(
    running,
    (error) => error.code === "diagnostic_timeout",
  );
  assert.equal(stopCalls, 1);
});
