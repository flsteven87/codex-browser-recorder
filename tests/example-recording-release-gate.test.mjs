import assert from "node:assert/strict";
import test from "node:test";

import {
  EXAMPLE_PAGE_URL,
  runExampleRecordingReleaseGate,
} from "../scripts/example-recording-release-gate.mjs";

test("completes two isolated recordings strictly in sequence", async () => {
  const browser = { id: "selected-browser" };
  const calls = [];
  let attempt = 0;
  const result = await runExampleRecordingReleaseGate({
    _dependencies: {
      createRecording(options) {
        attempt += 1;
        const current = attempt;
        calls.push(`create:${current}`);
        assert.equal(options.browser, browser);
        assert.equal(options.targetUrl, EXAMPLE_PAGE_URL);
        return {
          ready: Promise.resolve({ id: `tab-${current}` }),
          status() {
            return { capture: null, state: "recording" };
          },
          async stop() {
            calls.push(`stop:${current}`);
            return {
              paths: { directory: `/private/recording-${current}` },
              result: { failureCode: null, status: "passed" },
            };
          },
        };
      },
    },
    browser,
    durationMs: 12_000,
    temporaryRoot: "/private/tmp",
  });

  assert.deepEqual(calls, ["create:1", "stop:1", "create:2", "stop:2"]);
  assert.deepEqual(result, {
    attempts: [
      {
        directory: "/private/recording-1",
      },
      {
        directory: "/private/recording-2",
      },
    ],
    status: "passed",
  });
});
