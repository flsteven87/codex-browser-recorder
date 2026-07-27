import { execFile, spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import {
  RECORDING_HARD_LIMIT_MS,
  RECORDING_MAX_HEIGHT,
  RECORDING_MAX_WIDTH,
} from "../plugins/codex-browser-recorder/skills/record-browser/scripts/recording-policy.mjs";

const execFileAsync = promisify(execFile);
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cursorAssetPath = resolve(
  repositoryRoot,
  "plugins/codex-browser-recorder/skills/record-browser/assets/codex-style-cursor.xpm",
);
const MAX_RETAINED_FRAMES = 120;

function evidenceError(message) {
  return Object.assign(new Error(message), {
    code: "pointer_visual_evidence_failed",
  });
}

function parseXpmAsset(source) {
  const quoted = [...source.matchAll(/"([^"]*)"/gu)].map(
    (match) => match[1],
  );
  const [width, height, colorCount] = quoted[0]
    ?.split(" ")
    .map(Number) ?? [];
  if (
    !Number.isInteger(width) ||
    width <= 0 ||
    !Number.isInteger(height) ||
    height <= 0 ||
    !Number.isInteger(colorCount) ||
    colorCount <= 0
  ) {
    throw evidenceError("Pointer visual evidence asset is invalid");
  }
  const colors = new Map();
  for (let index = 0; index < colorCount; index += 1) {
    const line = quoted[1 + index];
    if (typeof line !== "string" || line.length < 5) {
      throw evidenceError("Pointer visual evidence asset is invalid");
    }
    colors.set(line[0], line.slice(4));
  }
  const rows = quoted.slice(1 + colorCount, 1 + colorCount + height);
  if (
    rows.length !== height ||
    rows.some((row) => row.length !== width)
  ) {
    throw evidenceError("Pointer visual evidence asset is invalid");
  }
  const pointsByColor = new Map();
  for (const [y, row] of rows.entries()) {
    for (let x = 0; x < width; x += 1) {
      const color = colors.get(row[x]);
      if (color === undefined) {
        throw evidenceError("Pointer visual evidence asset is invalid");
      }
      if (color === "None") continue;
      const points = pointsByColor.get(color) ?? [];
      points.push([x, y]);
      pointsByColor.set(color, points);
    }
  }
  return { height, pointsByColor, width };
}

function greenPixel(frame, offset) {
  const red = frame[offset];
  const green = frame[offset + 1];
  const blue = frame[offset + 2];
  return (
    red <= 100 &&
    green >= 100 &&
    green <= 225 &&
    blue >= 65 &&
    blue <= 195 &&
    green - red >= 55 &&
    green - blue >= 8
  );
}

function createRingDetector(width, height) {
  const component = new Int32Array(width * height);
  const mask = new Uint8Array(width * height);
  const stack = new Int32Array(width * height);
  return (frame) => {
    mask.fill(0);
    const candidates = [];
    for (
      let pixelIndex = 0, offset = 0;
      pixelIndex < mask.length;
      pixelIndex += 1, offset += 3
    ) {
      if (greenPixel(frame, offset)) mask[pixelIndex] = 1;
    }
    for (let start = 0; start < mask.length; start += 1) {
      if (mask[start] !== 1) continue;
      let stackSize = 1;
      stack[0] = start;
      mask[start] = 2;
      let count = 0;
      let minX = width;
      let minY = height;
      let maxX = -1;
      let maxY = -1;
      const visit = (neighbor) => {
        if (mask[neighbor] !== 1) return;
        mask[neighbor] = 2;
        stack[stackSize] = neighbor;
        stackSize += 1;
      };
      while (stackSize > 0) {
        stackSize -= 1;
        const pixelIndex = stack[stackSize];
        const x = pixelIndex % width;
        const y = Math.floor(pixelIndex / width);
        component[count] = pixelIndex;
        count += 1;
        minX = Math.min(minX, x);
        maxX = Math.max(maxX, x);
        minY = Math.min(minY, y);
        maxY = Math.max(maxY, y);
        if (x > 0) visit(pixelIndex - 1);
        if (x + 1 < width) visit(pixelIndex + 1);
        if (y > 0) visit(pixelIndex - width);
        if (y + 1 < height) visit(pixelIndex + width);
      }
      if (count < 120) continue;
      const boxWidth = maxX - minX + 1;
      const boxHeight = maxY - minY + 1;
      if (
        boxWidth < 30 ||
        boxWidth > 80 ||
        boxHeight < 30 ||
        boxHeight > 80
      ) {
        continue;
      }
      const centralMinX = minX + boxWidth * 0.3;
      const centralMaxX = minX + boxWidth * 0.7;
      const centralMinY = minY + boxHeight * 0.3;
      const centralMaxY = minY + boxHeight * 0.7;
      let centralCount = 0;
      for (let index = 0; index < count; index += 1) {
        const pixelIndex = component[index];
        const x = pixelIndex % width;
        const y = Math.floor(pixelIndex / width);
        if (
          x >= centralMinX &&
          x <= centralMaxX &&
          y >= centralMinY &&
          y <= centralMaxY
        ) {
          centralCount += 1;
        }
      }
      if (centralCount / count > 0.05) continue;
      candidates.push({
        x: (minX + maxX) / 2,
        y: (minY + maxY) / 2,
      });
    }
    return candidates;
  };
}

function ringForFrame(frame, context, detectRings) {
  const { height, template, width } = context;
  let best = null;
  for (const candidate of detectRings(frame)) {
    const match = bestCursorNear(
      frame,
      context,
      candidate.x,
      candidate.y,
    );
    if (
      cursorMatchPassed(match) &&
      (best === null || match.score > best.match.score)
    ) {
      best = { candidate, match };
    }
  }
  return best?.candidate ?? null;
}

function cursorScoreAt(frame, context, left, top) {
  const { height, template, width } = context;
  if (
    left < 0 ||
    top < 0 ||
    left + template.width > width ||
    top + template.height > height
  ) {
    return null;
  }
  let darkMatches = 0;
  for (const [x, y] of template.darkPoints) {
    const offset = ((top + y) * width + left + x) * 3;
    if (
      frame[offset] <= 105 &&
      frame[offset + 1] <= 115 &&
      frame[offset + 2] <= 135
    ) {
      darkMatches += 1;
    }
  }
  let lightMatches = 0;
  for (const [x, y] of template.lightPoints) {
    const offset = ((top + y) * width + left + x) * 3;
    if (
      frame[offset] >= 185 &&
      frame[offset + 1] >= 185 &&
      frame[offset + 2] >= 185
    ) {
      lightMatches += 1;
    }
  }
  const darkRate = darkMatches / template.darkPoints.length;
  const lightRate = lightMatches / template.lightPoints.length;
  return {
    darkRate,
    lightRate,
    score: darkRate * 0.75 + lightRate * 0.25,
  };
}

function bestCursorNear(frame, context, pointerX, pointerY, radius = 4) {
  let best = null;
  for (let deltaY = -radius; deltaY <= radius; deltaY += 1) {
    for (let deltaX = -radius; deltaX <= radius; deltaX += 1) {
      const left = Math.round(pointerX) - 1 + deltaX;
      const top = Math.round(pointerY) - 1 + deltaY;
      const candidate = cursorScoreAt(frame, context, left, top);
      if (
        candidate !== null &&
        (best === null || candidate.score > best.score)
      ) {
        best = candidate;
      }
    }
  }
  return best;
}

function cursorMatchPassed(match) {
  return (
    match?.darkRate >= 0.52 &&
    match.lightRate >= 0.65 &&
    match.score >= 0.58
  );
}

function distanceBetween(left, right) {
  return Math.hypot(left.x - right.x, left.y - right.y);
}

function findIntermediateCursor(frames, context, first, second) {
  const deltaX = second.x - first.x;
  const deltaY = second.y - first.y;
  const perpendicularLength = Math.max(1, Math.hypot(deltaX, deltaY));
  let best = null;
  for (const { frame, ring } of frames) {
    if (ring !== null) continue;
    for (let step = 2; step <= 18; step += 1) {
      const progress = step / 20;
      const lineX = first.x + deltaX * progress;
      const lineY = first.y + deltaY * progress;
      for (let perpendicular = -3; perpendicular <= 3; perpendicular += 1) {
        const pointerX =
          lineX - deltaY / perpendicularLength * perpendicular;
        const pointerY =
          lineY + deltaX / perpendicularLength * perpendicular;
        const match = bestCursorNear(frame, context, pointerX, pointerY, 1);
        if (match !== null && (best === null || match.score > best.score)) {
          best = match;
        }
      }
    }
  }
  return best;
}

async function inspectDimensions(outputPath) {
  let stdout;
  try {
    ({ stdout } = await execFileAsync(
      "ffprobe",
      [
        "-v",
        "error",
        "-select_streams",
        "v:0",
        "-show_entries",
        "stream=width,height:format=duration",
        "-of",
        "json",
        outputPath,
      ],
      { encoding: "utf8", maxBuffer: 1024 * 1024 },
    ));
  } catch {
    throw evidenceError("Pointer visual evidence media could not be inspected");
  }
  let durationSeconds;
  let stream;
  try {
    const probe = JSON.parse(stdout);
    durationSeconds = Number(probe.format?.duration);
    stream = probe.streams?.[0];
  } catch {
    throw evidenceError("Pointer visual evidence media is invalid");
  }
  if (
    !Number.isInteger(stream?.width) ||
    stream.width <= 0 ||
    stream.width > RECORDING_MAX_WIDTH ||
    !Number.isInteger(stream?.height) ||
    stream.height <= 0 ||
    stream.height > RECORDING_MAX_HEIGHT ||
    !Number.isFinite(durationSeconds) ||
    durationSeconds <= 0 ||
    durationSeconds > RECORDING_HARD_LIMIT_MS / 1000
  ) {
    throw evidenceError("Pointer visual evidence media is invalid");
  }
  return { height: stream.height, width: stream.width };
}

function analyzeDecodedFrames(outputPath, context) {
  const { height, template, width } = context;
  const frameBytes = width * height * 3;
  return new Promise((resolvePromise, rejectPromise) => {
    const decoder = spawn(
      "ffmpeg",
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-i",
        outputPath,
        "-an",
        "-f",
        "rawvideo",
        "-pix_fmt",
        "rgb24",
        "pipe:1",
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let pending = Buffer.alloc(0);
    let stderr = "";
    let currentCluster = null;
    let frameIndex = 0;
    const detectRings = createRingDetector(width, height);
    const retainedFrames = [];
    const summaries = [];
    const finishCluster = () => {
      if (currentCluster === null) return;
      const x =
        currentCluster.observations.reduce(
          (sum, item) => sum + item.x,
          0,
        ) / currentCluster.observations.length;
      const y =
        currentCluster.observations.reduce(
          (sum, item) => sum + item.y,
          0,
        ) / currentCluster.observations.length;
      const cursorVisible = cursorMatchPassed(
        bestCursorNear(currentCluster.representativeFrame, context, x, y),
      );
      if (cursorVisible && summaries.length < 2) {
        summaries.push({
          cursorVisible,
          firstFrameIndex: currentCluster.firstFrameIndex,
          lastFrameIndex: currentCluster.lastFrameIndex,
          x,
          y,
        });
      }
      currentCluster = null;
    };
    const inspectFrame = (frame) => {
      if (summaries.length >= 2) {
        frameIndex += 1;
        return;
      }
      const ring = ringForFrame(frame, context, detectRings);
      if (ring !== null) {
        if (currentCluster === null) {
          currentCluster = {
            firstFrameIndex: frameIndex,
            lastFrameIndex: frameIndex,
            observations: [ring],
            representativeFrame: frame,
          };
        } else {
          currentCluster.lastFrameIndex = frameIndex;
          currentCluster.observations.push(ring);
        }
      } else {
        finishCluster();
        if (summaries.length === 1) {
          retainedFrames.push({ frame, frameIndex, ring });
          if (retainedFrames.length > MAX_RETAINED_FRAMES) {
            retainedFrames.shift();
          }
        }
      }
      frameIndex += 1;
    };
    decoder.stderr.setEncoding("utf8");
    decoder.stderr.on("data", (chunk) => {
      if (stderr.length < 8192) {
        stderr += chunk.slice(0, 8192 - stderr.length);
      }
    });
    decoder.stdout.on("data", (chunk) => {
      pending =
        pending.length === 0 ? chunk : Buffer.concat([pending, chunk]);
      while (pending.length >= frameBytes) {
        inspectFrame(Buffer.from(pending.subarray(0, frameBytes)));
        pending = pending.subarray(frameBytes);
      }
    });
    decoder.once("error", () => {
      rejectPromise(
        evidenceError("Pointer visual evidence media could not be decoded"),
      );
    });
    decoder.once("close", (code, signal) => {
      if (code === 0 && signal === null && pending.length === 0) {
        finishCluster();
        resolvePromise({ retainedFrames, summaries });
      } else {
        rejectPromise(
          evidenceError(
            stderr.length > 0
              ? "Pointer visual evidence media could not be decoded"
              : "Pointer visual evidence media ended unexpectedly",
          ),
        );
      }
    });
  });
}

export async function confirmEncodedPointerVisualEvidence({ outputPath } = {}) {
  if (typeof outputPath !== "string" || outputPath.length === 0) {
    throw evidenceError("Pointer visual evidence path is invalid");
  }
  const dimensions = await inspectDimensions(outputPath);
  let assetSource;
  try {
    assetSource = await readFile(cursorAssetPath, "utf8");
  } catch {
    throw evidenceError("Pointer visual evidence asset is unavailable");
  }
  const asset = parseXpmAsset(assetSource);
  const template = {
    ...asset,
    darkPoints: asset.pointsByColor.get("#111827") ?? [],
    lightPoints: asset.pointsByColor.get("#F8FAFC") ?? [],
  };
  if (template.darkPoints.length === 0 || template.lightPoints.length === 0) {
    throw evidenceError("Pointer visual evidence asset is invalid");
  }
  const context = { ...dimensions, template };
  const { retainedFrames, summaries } = await analyzeDecodedFrames(outputPath, context);
  const first = summaries[0];
  const second = summaries[1];
  const clickFeedbackVisible =
    first?.cursorVisible === true && second?.cursorVisible === true;
  const movementDistance =
    first !== undefined && second !== undefined
      ? distanceBetween(first, second)
      : 0;
  const between =
    first !== undefined && second !== undefined
      ? retainedFrames.filter(
          ({ frameIndex }) =>
            frameIndex > first.lastFrameIndex &&
            frameIndex < second.firstFrameIndex,
        )
      : [];
  const intermediate =
    movementDistance >= 8
      ? findIntermediateCursor(between, context, first, second)
      : null;
  return {
    clickFeedbackVisible,
    pointerMovementVisible:
      clickFeedbackVisible &&
      movementDistance >= 8 &&
      cursorMatchPassed(intermediate),
  };
}
