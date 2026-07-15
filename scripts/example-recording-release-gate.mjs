import { createRecording } from "../plugins/codex-browser-recorder/skills/record-browser/scripts/create-recording.mjs";

export const EXAMPLE_PAGE_URL = "https://example.com/";

export function runExampleRecordingReleaseGate({
  _dependencies = { createRecording },
  durationMs = 12_000,
  ffmpegPath,
  ffprobePath,
  signal,
  tab,
  temporaryRoot,
}) {
  return _dependencies.createRecording({
    durationMs,
    ffmpegPath,
    ffprobePath,
    signal,
    tab,
    targetUrl: EXAMPLE_PAGE_URL,
    temporaryRoot,
  });
}
