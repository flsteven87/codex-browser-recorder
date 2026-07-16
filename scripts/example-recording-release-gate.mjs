import { createRecording } from "../plugins/codex-browser-recorder/skills/record-browser/scripts/create-recording.mjs";

export const EXAMPLE_PAGE_URL = "https://example.com/";

export async function runExampleRecordingReleaseGate({
  _dependencies = { createRecording },
  browser,
  durationMs = 12_000,
  signal,
  temporaryRoot,
}) {
  const attempts = [];
  const tabs = [];
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const handle = _dependencies.createRecording({
      browser,
      destinationDirectory: temporaryRoot,
      durationMs,
      signal,
      targetUrl: EXAMPLE_PAGE_URL,
      temporaryRoot,
    });
    const tab = await handle.ready;
    const output = await handle.stop();
    if (
      output?.result?.status !== "passed" ||
      typeof output?.paths?.outputPath !== "string" ||
      output.paths.outputPath.length === 0
    ) {
      throw Object.assign(new Error("Example recording release gate failed"), {
        code: output?.result?.failureCode ?? "release_gate_failed",
      });
    }
    attempts.push({ outputPath: output.paths.outputPath });
    tabs.push(tab);
  }

  if (
    tabs[0] === tabs[1] ||
    attempts[0].outputPath === attempts[1].outputPath
  ) {
    throw Object.assign(new Error("Example recording isolation check failed"), {
      code: "release_gate_isolation_failed",
    });
  }
  return { attempts, status: "passed" };
}
