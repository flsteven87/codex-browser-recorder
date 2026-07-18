import {
  prepareRecording,
  recordApproved,
} from "../plugins/codex-browser-recorder/skills/record-browser/scripts/record-browser-flow.mjs";

export const EXAMPLE_PAGE_URL = "https://example.com/";

export async function runExampleRecordingReleaseGate({
  browser,
  dependencies = { prepareRecording, recordApproved },
  durationMs = 12_000,
  signal,
  targetUrl = EXAMPLE_PAGE_URL,
  temporaryRoot,
}) {
  const attempts = [];
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const prepared = await dependencies.prepareRecording({
      actions: [],
      browserSurface: "chrome",
      destinationDirectory: temporaryRoot,
      durationMs,
      durationWasExplicit: true,
      recordingName: `release-gate-${attempt + 1}`,
      targetUrl,
      temporaryRoot,
    });
    if (prepared?.status !== "prepared") {
      throw Object.assign(new Error("Example recording preflight failed"), {
        code: prepared?.blockers?.[0]?.code ?? "release_gate_failed",
      });
    }
    const output = await dependencies.recordApproved(prepared, {
      browser,
      signal,
    });
    if (
      output?.status !== "completed" ||
      output.result?.status !== "passed" ||
      output.cleanup?.artifactCleanupIncomplete === true ||
      output.cleanup?.browserTabCleanupIncomplete === true ||
      output.cleanup?.directory != null ||
      output.cleanup?.file != null ||
      typeof output?.paths?.outputPath !== "string" ||
      output.paths.outputPath.length === 0
    ) {
      throw Object.assign(new Error("Example recording release gate failed"), {
        code: output?.result?.failureCode ?? "release_gate_failed",
      });
    }
    attempts.push({ outputPath: output.paths.outputPath });
  }

  if (attempts[0].outputPath === attempts[1].outputPath) {
    throw Object.assign(new Error("Example recording isolation check failed"), {
      code: "release_gate_isolation_failed",
    });
  }
  return {
    attempts,
    contractVersion: 1,
    status: "passed",
    surface: "chrome",
  };
}
