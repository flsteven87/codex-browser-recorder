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
    dependencies: {
      async prepareRecording(options) {
        attempt += 1;
        const current = attempt;
        calls.push(`prepare:${current}`);
        assert.equal(options.destinationDirectory, "/private/tmp");
        assert.equal(options.targetUrl, EXAMPLE_PAGE_URL);
        assert.equal(options.browserSurface, "chrome");
        assert.equal(options.durationWasExplicit, true);
        assert.deepEqual(options.actions, []);
        return { id: current, status: "prepared" };
      },
      async recordApproved(prepared, options) {
        calls.push(`record:${prepared.id}`);
        assert.equal(options.browser, browser);
        return {
          cleanup: {},
          paths: { outputPath: `/private/recording-${prepared.id}.mp4` },
          result: { failureCode: null, status: "passed" },
          status: "completed",
        };
      },
    },
    browser,
    durationMs: 12_000,
    temporaryRoot: "/private/tmp",
  });

  assert.deepEqual(calls, [
    "prepare:1",
    "record:1",
    "prepare:2",
    "record:2",
  ]);
  assert.deepEqual(result, {
    attempts: [
      {
        outputPath: "/private/recording-1.mp4",
      },
      {
        outputPath: "/private/recording-2.mp4",
      },
    ],
    contractVersion: 1,
    surface: "chrome",
    status: "passed",
  });
});
