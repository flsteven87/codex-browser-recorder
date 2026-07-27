import { execFile } from "node:child_process";
import { readFile, mkdtemp, readdir, rm, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import {
  prepareRecording,
  recordApproved,
} from "../plugins/codex-browser-recorder/skills/record-browser/scripts/record-browser-flow.mjs";
import {
  instrumentReleaseQualificationFlows,
  verifyReleaseQualificationEvidence,
} from "./codex-in-app-browser-release-evidence.mjs";
import {
  getReleaseQualificationScenario,
  getReleaseQualificationScenarios,
} from "./codex-in-app-browser-release-scenarios.mjs";
import {
  RECORDING_FPS,
  RECORDING_MAX_HEIGHT,
  RECORDING_MAX_WIDTH,
} from "../plugins/codex-browser-recorder/skills/record-browser/scripts/recording-policy.mjs";

const execFileAsync = promisify(execFile);
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SURFACE = "Codex In-app Browser";
const FRAME_RATE_TOLERANCE = 0.01;
const VERSION_PATTERN = /^[\x20-\x7e]{1,160}$/u;
const REVISION_PATTERN = /^[0-9a-f]{40}$/u;
const RELEASE_QUALIFICATION_SCENARIOS =
  getReleaseQualificationScenarios();
const GATE_ERROR_BRAND = Symbol("codex-browser-recorder.release-gate-error");

function gateError(code, message) {
  const error = Object.assign(new Error(message), { code });
  Object.defineProperty(error, GATE_ERROR_BRAND, { value: true });
  return error;
}

function publicError(code, message) {
  return Object.assign(new Error(message), { code });
}

function publicGateError(error) {
  if (error?.[GATE_ERROR_BRAND] === true) {
    const safeError = publicError(error.code, error.message);
    if (
      getReleaseQualificationScenario(error.scenario)
        ?.publicErrorScenario === true
    ) {
      safeError.scenario = error.scenario;
    }
    return safeError;
  }
  return publicError(
    "release_gate_internal_error",
    "Codex In-app Browser release qualification failed",
  );
}

function qualificationEvidenceGateError(scenario, code) {
  if (scenario.evidenceKind === "embedded_frame") {
    return gateError(
      "embedded_frame_qualification_failed",
      "Embedded-frame qualification action evidence failed",
    );
  }
  if (code === "release_gate_visibility_failed") {
    return gateError(
      "release_gate_visibility_failed",
      scenario.evidenceKind === "unattended"
        ? "Unattended Recording did not begin and remain hidden"
        : "Recording did not continue from visible to hidden Browser state",
    );
  }
  return gateError(
    "release_gate_action_evidence_failed",
    "Pointer qualification action evidence failed",
  );
}

function validateVersion(value, label) {
  if (typeof value !== "string" || !VERSION_PATTERN.test(value)) {
    throw gateError(
      "release_gate_invalid_configuration",
      `Invalid ${label} version evidence`,
    );
  }
  return value;
}

function validateActions(
  actions,
  { modalities, pointerRequired = false } = {},
) {
  if (
    !Array.isArray(actions) ||
    actions.length === 0 ||
    actions.some(
      (action) =>
        typeof action?.label !== "string" ||
        action.label.trim().length === 0 ||
        !["keyboard", "pointer", "programmatic"].includes(action?.modality) ||
        typeof action?.perform !== "function",
    ) ||
    (Array.isArray(modalities) &&
      (actions.length !== modalities.length ||
        actions.some(
          ({ modality }, index) => modality !== modalities[index],
        ))) ||
    (pointerRequired &&
      !actions.some(({ modality }) => modality === "pointer"))
  ) {
    throw gateError(
      "release_gate_invalid_configuration",
      "Invalid release qualification actions",
    );
  }
  return actions;
}

function validateFlow(flow, options) {
  let target;
  try {
    target = new URL(flow?.targetUrl);
  } catch {
    throw gateError(
      "release_gate_invalid_configuration",
      "Invalid release qualification target",
    );
  }
  if (target.protocol !== "https:") {
    throw gateError(
      "release_gate_invalid_configuration",
      "Release qualification requires a public HTTPS fixture",
    );
  }
  return Object.freeze({
    actions: validateActions(flow?.actions, options),
    targetUrl: target.href,
  });
}

function validateOptions(options) {
  if (
    typeof options?.acquireBrowser !== "function" ||
    typeof options?.approveQualification !== "function" ||
    typeof options?.confirmPointerVisualEvidence !== "function"
  ) {
    throw gateError(
      "release_gate_invalid_configuration",
      "Invalid release qualification callbacks",
    );
  }
  for (const scenario of RELEASE_QUALIFICATION_SCENARIOS) {
    if (scenario.availability !== "when_exercised") continue;
    const flow = options[scenario.flowProperty];
    const unsupported = scenario.runtimeUnsupportedResult;
    if (
      !(
        flow?.status === unsupported.status &&
        flow.limitation === unsupported.limitation
      ) &&
      flow?.status !== "exercised"
    ) {
      throw gateError(
        "release_gate_invalid_configuration",
        "Embedded-frame runtime coverage must be declared",
      );
    }
  }
  const browserPluginVersion = validateVersion(
    options.browserPluginVersion,
    "Browser plugin",
  );
  const codexDesktopVersion = validateVersion(
    options.codexDesktopVersion,
    "Codex desktop",
  );
  const flows = {};
  const flowScenarios = RELEASE_QUALIFICATION_SCENARIOS.filter(
    ({ flowValidationOrder }) => flowValidationOrder !== null,
  ).toSorted(
    (left, right) => left.flowValidationOrder - right.flowValidationOrder,
  );
  for (const scenario of flowScenarios) {
    const flow = options[scenario.flowProperty];
    if (scenario.availability === "when_exercised") {
      const unsupported = scenario.runtimeUnsupportedResult;
      flows[scenario.flowProperty] =
        flow.status === "exercised"
          ? Object.freeze({
              ...validateFlow(flow, {
                modalities: scenario.actionModalities,
              }),
              status: "exercised",
            })
          : unsupported;
      continue;
    }
    flows[scenario.flowProperty] = validateFlow(flow, {
      modalities: scenario.actionModalities ?? undefined,
    });
  }
  return Object.freeze({
    browserPluginVersion,
    codexDesktopVersion,
    flows: Object.freeze(flows),
  });
}

function parseRate(value) {
  if (typeof value !== "string") return Number.NaN;
  const [numerator, denominator = "1"] = value.split("/");
  const rate = Number(numerator) / Number(denominator);
  return Number.isFinite(rate) ? rate : Number.NaN;
}

function validateMediaEvidence(media) {
  if (
    media?.audioStreams !== 0 ||
    media?.codecName !== "h264" ||
    media?.container !== "mp4" ||
    media?.pixelFormat !== "yuv420p" ||
    !Number.isFinite(media?.framesPerSecond) ||
    media.framesPerSecond <= 0 ||
    media.framesPerSecond > RECORDING_FPS + FRAME_RATE_TOLERANCE ||
    !Number.isFinite(media?.durationSeconds) ||
    media.durationSeconds <= 0 ||
    !Number.isInteger(media?.width) ||
    media.width <= 0 ||
    media.width > RECORDING_MAX_WIDTH ||
    !Number.isInteger(media?.height) ||
    media.height <= 0 ||
    media.height > RECORDING_MAX_HEIGHT
  ) {
    throw gateError(
      "media_qualification_failed",
      "Published recording does not satisfy the release media contract",
    );
  }
  return Object.freeze({
    audioStreams: media.audioStreams,
    codecName: media.codecName,
    container: media.container,
    durationSeconds: media.durationSeconds,
    framesPerSecond: media.framesPerSecond,
    height: media.height,
    pixelFormat: media.pixelFormat,
    width: media.width,
  });
}

async function inspectPublishedVideo(outputPath) {
  let probe;
  try {
    const { stdout } = await execFileAsync(
      "ffprobe",
      [
        "-v",
        "error",
        "-show_streams",
        "-show_format",
        "-of",
        "json",
        outputPath,
      ],
      { encoding: "utf8", maxBuffer: 1024 * 1024 },
    );
    probe = JSON.parse(stdout);
  } catch {
    throw gateError(
      "media_qualification_failed",
      "Published recording could not be independently inspected",
    );
  }
  const streams = Array.isArray(probe?.streams) ? probe.streams : [];
  const videoStreams = streams.filter(({ codec_type }) => codec_type === "video");
  const audioStreams = streams.filter(({ codec_type }) => codec_type === "audio");
  const video = videoStreams[0];
  const formats = String(probe?.format?.format_name ?? "").split(",");
  const framesPerSecond = parseRate(
    video?.avg_frame_rate ?? video?.r_frame_rate,
  );
  const durationSeconds = Number(
    video?.duration ?? probe?.format?.duration,
  );
  const width = Number(video?.width);
  const height = Number(video?.height);
  if (videoStreams.length !== 1) {
    throw gateError(
      "media_qualification_failed",
      "Published recording does not carry exactly one video stream",
    );
  }
  try {
    await execFileAsync(
      "ffmpeg",
      [
        "-v",
        "error",
        "-i",
        outputPath,
        "-map",
        "0:v:0",
        "-f",
        "null",
        "-",
      ],
      { encoding: "utf8", maxBuffer: 1024 * 1024 },
    );
  } catch {
    throw gateError(
      "media_qualification_failed",
      "Published recording could not be decoded",
    );
  }
  return Object.freeze({
    audioStreams: audioStreams.length,
    codecName: video?.codec_name,
    container: formats.includes("mp4") ? "mp4" : formats[0],
    durationSeconds,
    framesPerSecond,
    height,
    pixelFormat: video?.pix_fmt,
    width,
  });
}

async function firstVersionLine(command) {
  const { stdout } = await execFileAsync(command, ["-version"], {
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
  });
  return stdout.split(/\r?\n/u, 1)[0];
}

async function collectEnvironmentEvidence() {
  const [
    { stdout: revision },
    { stdout: worktreeStatus },
    manifestSource,
    ffmpegVersion,
    ffprobeVersion,
  ] = await Promise.all([
    execFileAsync("git", ["rev-parse", "HEAD"], {
      cwd: repositoryRoot,
      encoding: "utf8",
      maxBuffer: 1024,
    }),
    execFileAsync("git", ["status", "--porcelain", "--untracked-files=all"], {
      cwd: repositoryRoot,
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
    }),
    readFile(
      join(
        repositoryRoot,
        "plugins/codex-browser-recorder/.codex-plugin/plugin.json",
      ),
      "utf8",
    ),
    firstVersionLine("ffmpeg"),
    firstVersionLine("ffprobe"),
  ]);
  if (worktreeStatus.length !== 0) {
    throw gateError(
      "release_gate_invalid_configuration",
      "Release qualification requires a clean candidate worktree",
    );
  }
  const recorderPluginVersion = JSON.parse(manifestSource)?.version;
  return {
    candidateRevision: revision.trim(),
    ffmpegVersion,
    ffprobeVersion,
    recorderPluginVersion,
  };
}

function defaultDependencies() {
  return {
    collectEnvironmentEvidence,
    createTemporaryWorkspace: () =>
      mkdtemp(join(tmpdir(), "codex-browser-recorder-release-")),
    inspectPublishedVideo,
    listWorkspaceEntries: (path) => readdir(path),
    prepareRecording,
    recordApproved,
    removePublishedRecording: (path) => unlink(path),
    removeTemporaryWorkspace: (path) =>
      rm(path, { force: true, recursive: true }),
  };
}

function validateEnvironmentEvidence(evidence) {
  if (!REVISION_PATTERN.test(evidence?.candidateRevision)) {
    throw gateError(
      "release_gate_invalid_configuration",
      "Candidate revision evidence is invalid",
    );
  }
  return Object.freeze({
    candidateRevision: evidence.candidateRevision,
    ffmpegVersion: validateVersion(evidence.ffmpegVersion, "FFmpeg"),
    ffprobeVersion: validateVersion(evidence.ffprobeVersion, "FFprobe"),
    recorderPluginVersion: validateVersion(
      evidence.recorderPluginVersion,
      "Browser Recorder plugin",
    ),
  });
}

function assertOwnedPath(workspace, path) {
  const root = resolve(workspace);
  const candidate = resolve(path);
  if (candidate === root || !candidate.startsWith(`${root}${sep}`)) {
    throw gateError(
      "temporary_artifact_cleanup_failed",
      "Release qualification produced an artifact outside its workspace",
    );
  }
  return candidate;
}

function assertCleanOutcome(output, { expectedStatus }) {
  if (
    output?.status !== expectedStatus ||
    output?.cleanup?.artifactCleanupIncomplete === true ||
    output?.cleanup?.browserTabCleanupIncomplete === true ||
    output?.cleanup?.resourceCleanupIncomplete === true ||
    output?.cleanup?.directory != null ||
    output?.cleanup?.file != null
  ) {
    throw gateError(
      "release_gate_outcome_failed",
      "Production Recording Flow reported an invalid terminal outcome",
    );
  }
}

function tabIds(tabs) {
  if (
    !Array.isArray(tabs) ||
    tabs.some(({ id }) => typeof id !== "string" || id.length === 0)
  ) {
    throw gateError(
      "release_gate_tab_cleanup_failed",
      "Codex In-app Browser tab inventory is unavailable",
    );
  }
  return tabs.map(({ id }) => id).toSorted();
}

async function assertTabState(browser, baseline) {
  if (typeof browser?.tabs?.list !== "function") {
    throw gateError(
      "release_gate_tab_cleanup_failed",
      "Codex In-app Browser tab inventory is unavailable",
    );
  }
  const current = tabIds(await browser.tabs.list());
  if (
    current.length !== baseline.length ||
    current.some((id, index) => id !== baseline[index])
  ) {
    throw gateError(
      "release_gate_tab_cleanup_failed",
      "Release qualification left an owned Browser tab open",
    );
  }
}

async function preparePlan(
  dependencies,
  workspace,
  { actions, scenario, targetUrl },
) {
  const prepared = await dependencies.prepareRecording({
    actions,
    destinationDirectory: workspace,
    durationWasExplicit: false,
    recordingMode: scenario.recordingMode,
    recordingName: scenario.recordingName,
    targetUrl,
    temporaryRoot: workspace,
  });
  if (prepared?.status !== "prepared" || prepared?.consent == null) {
    throw gateError(
      "release_gate_preparation_failed",
      "Production Recording Flow preparation failed",
    );
  }
  return prepared;
}

function cancellationPlan(actionStarted) {
  return Object.freeze({
    actions: Object.freeze([
      Object.freeze({
        label: "Hold the active capture until cancellation",
        modality: "programmatic",
        perform() {
          actionStarted.resolve();
          return new Promise(() => {});
        },
      }),
    ]),
  });
}

function createDeferred() {
  let resolvePromise;
  const promise = new Promise((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
}

async function runSuccessScenario({
  browser,
  dependencies,
  evidence,
  scenario,
  outputPaths,
  prepared,
  workspace,
}) {
  let output;
  try {
    output = await dependencies.recordApproved(prepared, { browser });
  } catch (error) {
    if (evidence?.failureCode != null) {
      throw qualificationEvidenceGateError(scenario, evidence.failureCode);
    }
    throw error;
  }
  let outputPath;
  if (typeof output?.paths?.outputPath === "string") {
    outputPath = assertOwnedPath(workspace, output.paths.outputPath);
    outputPaths.add(outputPath);
  }
  const failureCode =
    output?.failure?.code ?? output?.result?.failureCode;
  if (
    output?.status === "failed" &&
    failureCode === "browser_visibility_unavailable" &&
    (output?.failure == null || output.failure.code === failureCode) &&
    (output?.result == null ||
      (output.result.status === "failed" &&
        output.result.failureCode === failureCode)) &&
    output?.paths?.outputPath == null
  ) {
    assertCleanOutcome(output, { expectedStatus: "failed" });
    throw Object.assign(
      gateError(
        "browser_visibility_unavailable",
        "The Codex In-app Browser could not enter the approved visibility mode during release qualification",
      ),
      { scenario: scenario.key },
    );
  }
  if (evidence?.failureCode != null) {
    if (output?.status === "failed") {
      assertCleanOutcome(output, { expectedStatus: "failed" });
      if (outputPath !== undefined) {
        throw gateError(
          "release_gate_outcome_failed",
          "Failed qualification unexpectedly published a recording",
        );
      }
    }
    throw qualificationEvidenceGateError(scenario, evidence.failureCode);
  }
  assertCleanOutcome(output, { expectedStatus: "completed" });
  if (
    output?.result?.status !== "passed" ||
    output.result.failureCode != null ||
    outputPath === undefined
  ) {
    throw gateError(
      "release_gate_outcome_failed",
      "Production Recording Flow did not publish a valid recording",
    );
  }
  let verifiedEvidence;
  try {
    verifiedEvidence = verifyReleaseQualificationEvidence({
      capture: output.result.capture,
      evidence,
      scenario,
    });
  } catch (error) {
    throw qualificationEvidenceGateError(scenario, error?.code);
  }
  return {
    evidence: verifiedEvidence,
    media: validateMediaEvidence(
      await dependencies.inspectPublishedVideo(outputPath),
    ),
    outputPath,
  };
}

async function runExpectedFailure({
  browser,
  dependencies,
  outputPaths,
  prepared,
  workspace,
}) {
  const output = await dependencies.recordApproved(prepared, { browser });
  if (typeof output?.paths?.outputPath === "string") {
    outputPaths.add(assertOwnedPath(workspace, output.paths.outputPath));
  }
  if (
    output?.status !== "failed" ||
    output?.result?.status !== "failed" ||
    ![
      "origin_changed_during_recording",
      "origin_verification_failed",
    ].includes(output.result.failureCode) ||
    output?.paths?.outputPath != null
  ) {
    throw gateError(
      "cross_origin_boundary_failed",
      "Cross-origin qualification did not fail without publication",
    );
  }
  assertCleanOutcome(output, { expectedStatus: "failed" });
  return Object.freeze({
    failureCode: output.result.failureCode,
    status: "passed",
  });
}

async function runCancellation({
  actionStarted,
  browser,
  cancellation,
  dependencies,
  outputPaths,
  prepared,
  workspace,
}) {
  const recording = dependencies.recordApproved(prepared, {
    browser,
    signal: cancellation.signal,
  });
  const actionBegan = await Promise.race([
    actionStarted.promise.then(() => true),
    recording.then(() => false),
  ]);
  if (!actionBegan) {
    throw gateError(
      "cancellation_cleanup_failed",
      "Cancellation qualification did not reach active capture",
    );
  }
  cancellation.abort();
  const output = await recording;
  if (typeof output?.paths?.outputPath === "string") {
    outputPaths.add(assertOwnedPath(workspace, output.paths.outputPath));
  }
  assertCleanOutcome(output, { expectedStatus: "cancelled" });
  if (
    output?.result?.failureCode !== "recording_cancelled" ||
    output?.paths?.outputPath != null
  ) {
    throw gateError(
      "cancellation_cleanup_failed",
      "Cancellation qualification did not cleanly stop without publication",
    );
  }
  return Object.freeze({
    failureCode: "recording_cancelled",
    status: "passed",
  });
}

function createPlans({ actionStarted, configured, instrumented }) {
  return RELEASE_QUALIFICATION_SCENARIOS.flatMap((scenario) => {
    const flow =
      scenario.executionKind === "cancellation"
        ? cancellationPlan(actionStarted)
        : instrumented[scenario.key];
    if (
      scenario.availability === "when_exercised" &&
      flow.status !== "exercised"
    ) {
      return [];
    }
    return [
      Object.freeze({
        ...flow,
        scenario,
        targetUrl:
          flow.targetUrl ??
          configured.flows[scenario.targetFlowProperty].targetUrl,
      }),
    ];
  });
}

async function assembleSuccessfulScenario({
  confirmPointerVisualEvidence,
  previousSuccessfulPath,
  scenario,
  success,
}) {
  if (scenario.resultKind === "pointer_visual") {
    const visualEvidence = await confirmPointerVisualEvidence({
      outputPath: success.outputPath,
    });
    if (
      visualEvidence?.pointerMovementVisible !== true ||
      visualEvidence?.clickFeedbackVisible !== true
    ) {
      throw gateError(
        "pointer_visual_evidence_failed",
        "Pointer movement and click feedback were not both confirmed",
      );
    }
    return Object.freeze({
      actionEvidence: success.evidence,
      media: success.media,
      status: "passed",
      visualEvidence: Object.freeze({
        clickFeedbackVisible: true,
        pointerMovementVisible: true,
      }),
    });
  }
  if (scenario.resultKind === "sequential_isolation") {
    if (previousSuccessfulPath === success.outputPath) {
      throw gateError(
        "release_gate_isolation_failed",
        "Sequential recordings used the same output",
      );
    }
    return Object.freeze({
      actionEvidence: success.evidence,
      distinctOutput: true,
      media: success.media,
      status: "passed",
    });
  }
  return Object.freeze({
    actionEvidence: success.evidence,
    media: success.media,
    status: "passed",
  });
}

async function executeScenario({
  actionStarted,
  browser,
  dependencies,
  options,
  outputPaths,
  plan,
  prepared,
  previousSuccessfulPath,
  workspace,
}) {
  const { scenario } = plan;
  if (scenario.executionKind === "expected_failure") {
    return runExpectedFailure({
      browser,
      dependencies,
      outputPaths,
      prepared,
      workspace,
    });
  }
  if (scenario.executionKind === "cancellation") {
    return runCancellation({
      actionStarted,
      browser,
      cancellation: new AbortController(),
      dependencies,
      outputPaths,
      prepared,
      workspace,
    });
  }
  const success = await runSuccessScenario({
    browser,
    dependencies,
    evidence: plan.evidence,
    outputPaths,
    prepared,
    scenario,
    workspace,
  });
  return Object.freeze({
    outputPath: success.outputPath,
    result: await assembleSuccessfulScenario({
      confirmPointerVisualEvidence:
        options.confirmPointerVisualEvidence,
      previousSuccessfulPath,
      scenario,
      success,
    }),
  });
}

export async function runCodexInAppBrowserReleaseGate(options) {
  let configured;
  try {
    configured = validateOptions(options);
  } catch (error) {
    throw publicGateError(error);
  }
  const dependencies = {
    ...defaultDependencies(),
    ...options.dependencies,
  };
  const outputPaths = new Set();
  let workspace;
  let primaryError;
  let cleanupError;
  try {
    workspace = await dependencies.createTemporaryWorkspace();
    const environment = validateEnvironmentEvidence(
      await dependencies.collectEnvironmentEvidence(),
    );
    const actionStarted = createDeferred();
    const runtime = { browser: null };
    const instrumented = instrumentReleaseQualificationFlows({
      flows: configured.flows,
      runtime,
    });
    const plans = createPlans({ actionStarted, configured, instrumented });
    const preparedPlans = [];
    for (const plan of plans) {
      preparedPlans.push({
        plan,
        prepared: await preparePlan(dependencies, workspace, plan),
      });
    }
    const approved = await options.approveQualification({
      consents: Object.freeze(
        preparedPlans.map(({ prepared }) => prepared.consent),
      ),
      surface: SURFACE,
    });
    if (approved !== true) {
      throw gateError(
        "qualification_not_approved",
        "Codex In-app Browser release qualification was not approved",
      );
    }

    const browser = await options.acquireBrowser();
    if (typeof browser?.tabs?.list !== "function") {
      throw gateError(
        "release_gate_browser_unavailable",
        "Codex In-app Browser is unavailable for release qualification",
      );
    }
    runtime.browser = browser;
    const baselineTabs = tabIds(await browser.tabs.list());
    const scenarios = {};
    const successfulPaths = [];
    for (const { plan, prepared } of preparedPlans) {
      const execution = await executeScenario({
        actionStarted,
        browser,
        dependencies,
        options,
        outputPaths,
        plan,
        prepared,
        previousSuccessfulPath: successfulPaths.at(-1),
        workspace,
      });
      if (execution.outputPath !== undefined) {
        successfulPaths.push(execution.outputPath);
      }
      scenarios[plan.scenario.key] = execution.result ?? execution;
      await assertTabState(browser, baselineTabs);
    }
    for (const scenario of RELEASE_QUALIFICATION_SCENARIOS) {
      if (scenario.availability === "when_exercised") {
        scenarios[scenario.key] ??= scenario.runtimeUnsupportedResult;
      }
    }

    let deletedCount = 0;
    for (const outputPath of [...outputPaths]) {
      await dependencies.removePublishedRecording(outputPath);
      outputPaths.delete(outputPath);
      deletedCount += 1;
    }
    const entries = await dependencies.listWorkspaceEntries(workspace);
    if (!Array.isArray(entries) || entries.length !== 0) {
      throw gateError(
        "temporary_artifact_cleanup_failed",
        "Release qualification left temporary artifacts behind",
      );
    }
    await dependencies.removeTemporaryWorkspace(workspace);
    workspace = undefined;

    return Object.freeze({
      cleanup: Object.freeze({
        ownedRecordingsDeleted: deletedCount,
        tabStateRestored: true,
        temporaryWorkspaceRemoved: true,
      }),
      contractVersion: 2,
      evidence: Object.freeze({
        ...environment,
        browserPluginVersion: configured.browserPluginVersion,
        codexDesktopVersion: configured.codexDesktopVersion,
      }),
      scenarios: Object.freeze(scenarios),
      status: "passed",
      surface: SURFACE,
    });
  } catch (error) {
    primaryError = publicGateError(error);
  } finally {
    for (const outputPath of [...outputPaths]) {
      try {
        await dependencies.removePublishedRecording(outputPath);
        outputPaths.delete(outputPath);
      } catch {
        cleanupError ??= gateError(
          "temporary_artifact_cleanup_failed",
          "Release qualification recording cleanup was incomplete",
        );
      }
    }
    if (workspace !== undefined) {
      try {
        await dependencies.removeTemporaryWorkspace(workspace);
      } catch {
        cleanupError ??= gateError(
          "temporary_artifact_cleanup_failed",
          "Release qualification workspace cleanup was incomplete",
        );
      }
    }
  }
  if (cleanupError !== undefined) {
    if (primaryError !== undefined) {
      primaryError.cleanupFailure = Object.freeze({
        code: cleanupError.code,
        summary: cleanupError.message,
      });
      throw primaryError;
    }
    throw publicGateError(cleanupError);
  }
  throw primaryError;
}
