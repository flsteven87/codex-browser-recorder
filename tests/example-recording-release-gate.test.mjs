import assert from "node:assert/strict";
import test from "node:test";

import {
  EXAMPLE_PAGE_URL,
  runExampleRecordingReleaseGate,
} from "../scripts/example-recording-release-gate.mjs";

test("calls the production coordinator with the fixed example policy", () => {
  let captured;
  const sentinelHandle = {};
  const signal = new AbortController().signal;
  const tab = { id: "approved-tab" };

  const handle = runExampleRecordingReleaseGate({
    _dependencies: {
      createRecording(options) {
        captured = options;
        return sentinelHandle;
      },
    },
    ffmpegPath: "/usr/local/bin/ffmpeg",
    ffprobePath: "/usr/local/bin/ffprobe",
    signal,
    tab,
    temporaryRoot: "/private/tmp",
  });

  assert.equal(handle, sentinelHandle);
  assert.equal(EXAMPLE_PAGE_URL, "https://example.com/");
  assert.deepEqual(captured, {
    durationMs: 12_000,
    ffmpegPath: "/usr/local/bin/ffmpeg",
    ffprobePath: "/usr/local/bin/ffprobe",
    signal,
    tab,
    targetUrl: "https://example.com/",
    temporaryRoot: "/private/tmp",
  });
});
