import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { renderCursorRecording } from "../plugins/codex-browser-recorder/skills/record-browser/scripts/cursor-recording.mjs";
import { confirmEncodedPointerVisualEvidence } from "../scripts/confirm-pointer-visual-evidence.mjs";
import { createPointerMovementClickEvents } from "./pointer-visual-fixture.mjs";
import { resolveExecutable } from "./test-tools.mjs";

const ffmpegPath = resolveExecutable("ffmpeg");

function createBaseVideo(
  directory,
  { durationSeconds = 1, size = "320x180", videoFilter } = {},
) {
  const path = join(directory, "base.mp4");
  const filterArguments =
    typeof videoFilter === "string" ? ["-vf", videoFilter] : [];
  execFileSync(
    ffmpegPath,
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "lavfi",
      "-i",
      `color=c=#204060:s=${size}:r=10:d=${durationSeconds}`,
      ...filterArguments,
      "-an",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-y",
      path,
    ],
    { stdio: "pipe" },
  );
  return path;
}

async function renderEvidence({
  baseVideo = {},
  durationMs = 1000,
  events,
  prefix,
  viewport = { height: 180, width: 320 },
}) {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  const inputPath = createBaseVideo(directory, baseVideo);
  const outputPath = join(directory, "cursor.mp4");
  try {
    await renderCursorRecording({
      ffmpegPath,
      inputPath,
      outputPath,
      timeline: { durationMs, events, viewport },
    });
    return await confirmEncodedPointerVisualEvidence({ outputPath });
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
}

test("returns no visual evidence for an unmodified recording", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pointer-no-overlay-"));
  const outputPath = createBaseVideo(directory);
  try {
    assert.deepEqual(
      await confirmEncodedPointerVisualEvidence({ outputPath }),
      {
        clickFeedbackVisible: false,
        pointerMovementVisible: false,
      },
    );
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test("rejects a missing recording without exposing its path", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pointer-missing-media-"));
  const outputPath = join(directory, "private-recording.mp4");
  try {
    await assert.rejects(
      confirmEncodedPointerVisualEvidence({ outputPath }),
      (error) =>
        error.code === "pointer_visual_evidence_failed" &&
        !error.message.includes(outputPath),
    );
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test("rejects media above the recording resolution limit", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pointer-oversize-media-"));
  const outputPath = createBaseVideo(directory, { size: "1282x10" });
  try {
    await assert.rejects(
      confirmEncodedPointerVisualEvidence({ outputPath }),
      (error) => error.code === "pointer_visual_evidence_failed",
    );
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test("rejects media above the recording duration hard limit", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pointer-overlong-media-"));
  const outputPath = createBaseVideo(directory, {
    durationSeconds: 66,
    size: "16x16",
  });
  try {
    await assert.rejects(
      confirmEncodedPointerVisualEvidence({ outputPath }),
      (error) => error.code === "pointer_visual_evidence_failed",
    );
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test("confirms two encoded click rings with visible cursor movement", async () => {
  assert.deepEqual(
    await renderEvidence({
      events: createPointerMovementClickEvents(),
      prefix: "pointer-visual-evidence-",
    }),
    {
      clickFeedbackVisible: true,
      pointerMovementVisible: true,
    },
  );
});

test("finds late movement after more than the bounded retained-frame window", async () => {
  assert.deepEqual(
    await renderEvidence({
      baseVideo: { durationSeconds: 15 },
      durationMs: 15_000,
      events: [
        {
          atMs: 100,
          button: 0,
          buttons: 0,
          frameId: "main",
          type: "move",
          x: 80,
          y: 90,
        },
        {
          atMs: 200,
          button: 0,
          buttons: 1,
          frameId: "main",
          type: "down",
          x: 80,
          y: 90,
        },
        {
          atMs: 13_700,
          button: 0,
          buttons: 0,
          frameId: "main",
          type: "move",
          x: 160,
          y: 90,
        },
        {
          atMs: 14_000,
          button: 0,
          buttons: 1,
          frameId: "main",
          type: "down",
          x: 160,
          y: 90,
        },
      ],
      prefix: "pointer-long-gap-",
    }),
    {
      clickFeedbackVisible: true,
      pointerMovementVisible: true,
    },
  );
});

test("does not confirm two clicks when only one click ring was encoded", async () => {
  assert.deepEqual(
    await renderEvidence({
      events: [
        {
          atMs: 100,
          button: 0,
          buttons: 0,
          frameId: "main",
          type: "move",
          x: 80,
          y: 90,
        },
        {
          atMs: 200,
          button: 0,
          buttons: 1,
          frameId: "main",
          type: "down",
          x: 80,
          y: 90,
        },
        {
          atMs: 600,
          button: 0,
          buttons: 0,
          frameId: "main",
          type: "move",
          x: 160,
          y: 90,
        },
      ],
      prefix: "pointer-one-click-",
    }),
    {
      clickFeedbackVisible: false,
      pointerMovementVisible: false,
    },
  );
});

test("ignores unrelated green page content around encoded click rings", async () => {
  assert.deepEqual(
    await renderEvidence({
      baseVideo: {
        videoFilter: "drawbox=x=250:y=10:w=40:h=40:color=#10A37F:t=fill",
      },
      events: createPointerMovementClickEvents(),
      prefix: "pointer-green-content-",
    }),
    {
      clickFeedbackVisible: true,
      pointerMovementVisible: true,
    },
  );
});

test("does not mistake green controls beneath a moving cursor for clicks", async () => {
  assert.deepEqual(
    await renderEvidence({
      baseVideo: {
        videoFilter:
          "drawbox=x=60:y=70:w=40:h=40:color=#10A37F:t=fill," +
          "drawbox=x=140:y=70:w=40:h=40:color=#10A37F:t=fill",
      },
      events: [
        {
          atMs: 100,
          button: 0,
          buttons: 0,
          frameId: "main",
          type: "move",
          x: 80,
          y: 90,
        },
        {
          atMs: 600,
          button: 0,
          buttons: 0,
          frameId: "main",
          type: "move",
          x: 160,
          y: 90,
        },
      ],
      prefix: "pointer-green-controls-",
    }),
    {
      clickFeedbackVisible: false,
      pointerMovementVisible: false,
    },
  );
});

test("does not claim movement for two nearby clicks at one position", async () => {
  assert.deepEqual(
    await renderEvidence({
      events: [
        {
          atMs: 50,
          button: 0,
          buttons: 0,
          frameId: "main",
          type: "move",
          x: 120,
          y: 90,
        },
        {
          atMs: 100,
          button: 0,
          buttons: 1,
          frameId: "main",
          type: "down",
          x: 120,
          y: 90,
        },
        {
          atMs: 400,
          button: 0,
          buttons: 1,
          frameId: "main",
          type: "down",
          x: 120,
          y: 90,
        },
      ],
      prefix: "pointer-static-evidence-",
    }),
    {
      clickFeedbackVisible: true,
      pointerMovementVisible: false,
    },
  );
});
