import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { access, readFile, stat } from "node:fs/promises";
import { dirname, posix, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";

const execFileAsync = promisify(execFile);
const manifestPath = "plugins/codex-browser-recorder/.codex-plugin/plugin.json";
const evalPath = "evals/plugin-submission-cases.json";
const ciPath = ".github/workflows/ci.yml";
const canonicalCiSha256 =
  "f459d6dc4c998aa09674cda9699046a0aa32d74c2618024ad929151c8b6abcda";
const workflowPaths = [ciPath, ".github/workflows/codeql.yml"];
const publicTextPaths = [
  "README.md",
  "PRIVACY.md",
  "TERMS.md",
  "SUPPORT.md",
  "SECURITY.md",
  "CONTRIBUTING.md",
  "CODE_OF_CONDUCT.md",
  "CHANGELOG.md",
  ".github/CODEOWNERS",
  ".github/dependabot.yml",
  ".github/pull_request_template.md",
  ".github/ISSUE_TEMPLATE/bug_report.yml",
  ".github/ISSUE_TEMPLATE/feature_request.yml",
  ".github/ISSUE_TEMPLATE/config.yml",
];
const assetPaths = [
  "plugins/codex-browser-recorder/assets/icon.png",
  "plugins/codex-browser-recorder/assets/logo.png",
  "plugins/codex-browser-recorder/assets/logo-dark.png",
  "plugins/codex-browser-recorder/assets/screenshot-workflow.png",
  "plugins/codex-browser-recorder/assets/screenshot-result.png",
  "plugins/codex-browser-recorder/assets/source/icon.svg",
  "plugins/codex-browser-recorder/assets/source/logo.svg",
  "plugins/codex-browser-recorder/assets/source/logo-dark.svg",
  "plugins/codex-browser-recorder/assets/source/screenshot-workflow.svg",
  "plugins/codex-browser-recorder/assets/source/screenshot-result.svg",
];
const requiredPaths = [
  manifestPath,
  evalPath,
  ...publicTextPaths,
  ...assetPaths,
  ...workflowPaths,
].toSorted();
const placeholderPattern = /\b(?:TBD|TODO|example@example[.]com|YOUR_NAME)\b/iu;
const candidateVersionPattern = /^0[.]1[.]0(?:[+]codex[.][0-9A-Za-z-]+)?$/u;
const fullShaPattern = /^[0-9a-f]{40}$/u;
const recordingArtifactPattern =
  /(?:^|\/)(?:[^/]+[.](?:webm|mp4|mov|mkv|part)|result[.]json|recording-[^/]+\/)/iu;
const requiredCiSteps = [
  {
    name: "Install pinned Codex CLI",
    commands: ["run: npm install --global @openai/codex@0.144.4"],
  },
  {
    name: "Run official plugin validator",
    commands: [
      'curl --fail --location --silent --show-error "https://raw.githubusercontent.com/openai/codex/08924bca0058eeaf179d2291af2c485123dbf2a2/codex-rs/skills/src/assets/samples/plugin-creator/scripts/validate_plugin.py" --output "$RUNNER_TEMP/validate_plugin.py"',
      'echo "ebda00d55d7518b127f675f062fb5c6e7a1ffdc0a99df1a55ac594400d7d3228  $RUNNER_TEMP/validate_plugin.py" | shasum -a 256 -c -',
      'uv run --no-project --with pyyaml python "$RUNNER_TEMP/validate_plugin.py" plugins/codex-browser-recorder',
    ],
  },
  {
    name: "Run official skill validator",
    commands: [
      'curl --fail --location --silent --show-error "https://raw.githubusercontent.com/openai/skills/49f948faa9258a0c61caceaf225e179651397431/skills/.system/skill-creator/scripts/quick_validate.py" --output "$RUNNER_TEMP/quick_validate.py"',
      'echo "6cc9dc3199c935916cf6f73fcbbbb0e3bb1b58c8f5109fefa499978908164f51  $RUNNER_TEMP/quick_validate.py" | shasum -a 256 -c -',
      'uv run --no-project --with pyyaml python "$RUNNER_TEMP/quick_validate.py" plugins/codex-browser-recorder/skills/record-browser',
    ],
  },
  {
    name: "Verify isolated plugin installation",
    commands: ["run: npm run test:plugin-install"],
  },
  {
    name: "Verify release candidate",
    commands: ["run: npm run check:release-candidate"],
  },
];

export class ReleaseReadinessError extends Error {
  constructor(mode, failures) {
    super(failures.map(({ code, path }) => `${code} ${path}`).join("\n"));
    this.name = "ReleaseReadinessError";
    this.code = failures[0]?.code ?? "RELEASE_READINESS_FAILED";
    this.path = failures[0]?.path ?? ".";
    this.mode = mode;
    this.failures = failures;
  }
}

function repositoryPath(repositoryRoot, relativePath) {
  const root = resolve(repositoryRoot);
  const path = resolve(root, relativePath);
  if (path !== root && !path.startsWith(`${root}${sep}`)) {
    throw new TypeError("repository path escapes root");
  }
  return path;
}

function stableRelativePath(path) {
  return path.split(sep).join(posix.sep);
}

function addFailure(failures, code, path) {
  const failure = { code, path: stableRelativePath(path) };
  if (
    !failures.some(
      (item) => item.code === failure.code && item.path === failure.path,
    )
  ) {
    failures.push(failure);
  }
}

async function existingPaths(repositoryRoot, failures) {
  const existing = new Set();
  for (const relativePath of requiredPaths) {
    try {
      const info = await stat(repositoryPath(repositoryRoot, relativePath));
      if (!info.isFile()) throw new Error("not a file");
      existing.add(relativePath);
    } catch {
      addFailure(failures, "REQUIRED_FILE_MISSING", relativePath);
    }
  }
  return existing;
}

async function readJson(repositoryRoot, relativePath, failures) {
  try {
    return JSON.parse(
      await readFile(repositoryPath(repositoryRoot, relativePath), "utf8"),
    );
  } catch {
    addFailure(failures, "JSON_INVALID", relativePath);
    return null;
  }
}

function manifestLinks(value, key = "") {
  if (Array.isArray(value)) {
    return value.flatMap((item) => manifestLinks(item, key));
  }
  if (value == null || typeof value !== "object") {
    return /(?:url|homepage|repository)$/iu.test(key) && typeof value === "string"
      ? [value]
      : [];
  }
  return Object.entries(value).flatMap(([childKey, child]) =>
    manifestLinks(child, childKey),
  );
}

function validateManifest(manifest, mode, failures) {
  const version = manifest?.version;
  const versionValid =
    mode === "release"
      ? version === "0.1.0"
      : typeof version === "string" && candidateVersionPattern.test(version);
  if (!versionValid) addFailure(failures, "VERSION_INVALID", manifestPath);

  const links = manifestLinks(manifest);
  if (links.length === 0 || links.some((link) => !link.startsWith("https://"))) {
    addFailure(failures, "MANIFEST_LINK_INVALID", manifestPath);
  }

  const prompts = manifest?.interface?.defaultPrompt;
  if (
    !Array.isArray(prompts) ||
    prompts.length !== 3 ||
    prompts.some(
      (prompt) =>
        typeof prompt !== "string" || prompt.length === 0 || prompt.length > 128,
    )
  ) {
    addFailure(failures, "DEFAULT_PROMPTS_INVALID", manifestPath);
  }
}

function validateEvalCorpus(corpus, failures) {
  const cases = corpus?.cases;
  if (
    !Array.isArray(cases) ||
    cases.filter(({ kind }) => kind === "positive").length !== 5 ||
    cases.filter(({ kind }) => kind === "negative").length !== 3
  ) {
    addFailure(failures, "EVAL_COUNT_INVALID", evalPath);
  }
}

async function validatePublicText(repositoryRoot, existing, failures) {
  for (const relativePath of publicTextPaths) {
    if (!existing.has(relativePath)) continue;
    const source = await readFile(
      repositoryPath(repositoryRoot, relativePath),
      "utf8",
    );
    if (placeholderPattern.test(source)) {
      addFailure(failures, "PLACEHOLDER_TEXT", relativePath);
    }
  }
}

async function validateReleaseChangelog(repositoryRoot, existing, failures) {
  if (!existing.has("CHANGELOG.md")) return;
  const changelog = await readFile(
    repositoryPath(repositoryRoot, "CHANGELOG.md"),
    "utf8",
  );
  const releaseHeadings = [
    ...changelog.matchAll(/^## \[0[.]1[.]0\] - (.+)$/gmu),
  ];
  const datedHeadings = releaseHeadings.filter(([, value]) =>
    /^\d{4}-\d{2}-\d{2}$/u.test(value),
  );
  if (releaseHeadings.length !== 1 || datedHeadings.length !== 1) {
    addFailure(failures, "CHANGELOG_RELEASE_INCOMPLETE", "CHANGELOG.md");
  }
}

async function validateActionPins(repositoryRoot, existing, failures) {
  for (const relativePath of workflowPaths) {
    if (!existing.has(relativePath)) continue;
    const source = await readFile(
      repositoryPath(repositoryRoot, relativePath),
      "utf8",
    );
    for (const match of source.matchAll(/^\s*-?\s*uses:\s*([^\s#]+).*$/gmu)) {
      const action = match[1];
      if (action.startsWith("./")) continue;
      const separator = action.lastIndexOf("@");
      if (separator < 1 || !fullShaPattern.test(action.slice(separator + 1))) {
        addFailure(failures, "ACTION_PIN_INVALID", relativePath);
      }
    }
  }
}

function hasRunLine(source, command) {
  return source
    .split("\n")
    .some((line) => line.trim() === `run: ${command}` || line.trim() === command);
}

function namedWorkflowStep(source, name) {
  const lines = source.split("\n");
  const start = lines.findIndex(
    (line) => line.trim() === `- name: ${name}`,
  );
  if (start === -1) return null;
  const indent = lines[start].slice(0, lines[start].indexOf("-"));
  let end = start + 1;
  while (
    end < lines.length &&
    !(
      lines[end].startsWith(indent) &&
      lines[end].slice(indent.length).startsWith("- ")
    )
  ) {
    end += 1;
  }
  return lines.slice(start, end).join("\n");
}

function requiredCiStepsAreUnconditional(source) {
  const lines = source.split("\n");
  const testJobStart = lines.findIndex((line) => line === "  test:");
  let testJobEnd = testJobStart + 1;
  while (
    testJobEnd < lines.length &&
    !/^ {2}\S/u.test(lines[testJobEnd])
  ) {
    testJobEnd += 1;
  }
  const testJob =
    testJobStart === -1 ? "" : lines.slice(testJobStart, testJobEnd).join("\n");
  if (/^ {4}(?:if|continue-on-error):/mu.test(testJob)) return false;

  const forbiddenControl =
    /^\s+(?:if|continue-on-error):|\b(?:if|elif|else|fi|false)\b|(?:[|]{2}|&&|;)\s*(?:true|:|exit\s+0)\b/imu;
  return requiredCiSteps.every(({ commands, name }) => {
    const step = namedWorkflowStep(testJob, name);
    if (step == null || forbiddenControl.test(step)) return false;
    const lines = new Set(step.split("\n").map((line) => line.trim()));
    return commands.every((command) => lines.has(command));
  });
}

async function validateCi(repositoryRoot, existing, failures) {
  if (!existing.has(ciPath)) return;
  const contents = await readFile(repositoryPath(repositoryRoot, ciPath));
  const source = contents.toString("utf8");
  const sha256 = createHash("sha256").update(contents).digest("hex");
  if (sha256 !== canonicalCiSha256) {
    addFailure(failures, "CI_WORKFLOW_HASH_INVALID", ciPath);
  }
  const codexCommandsPresent = [
    "npm install --global @openai/codex@0.144.4",
    "npm run test:plugin-install",
  ].every((command) => hasRunLine(source, command));
  const skipBranchPresent =
    /command\s+-v\s+codex|codex\s+cli\s+unavailable/iu.test(source);
  const codexGateInvalid = !codexCommandsPresent || skipBranchPresent;
  if (codexGateInvalid) {
    addFailure(failures, "CI_CODEX_GATE_INVALID", ciPath);
  }
  if (!codexGateInvalid && !requiredCiStepsAreUnconditional(source)) {
    addFailure(failures, "CI_REQUIRED_STEP_INVALID", ciPath);
  }

  const requiredFragments = [
    "node-version: 24",
    "astral-sh/setup-uv@11f9893b081a58869d3b5fccaea48c9e9e46f990",
    "version: 0.11.29",
    "enable-cache: false",
    "command -v ffmpeg >/dev/null || brew install ffmpeg",
    "npm run check",
    "npm run test:coverage",
    "npm run check:release-candidate",
    "git show --check --format= HEAD",
    "RECORDING_ARTIFACT_PATTERN",
  ];
  if (
    !requiredFragments.every((fragment) => source.includes(fragment)) ||
    !/^permissions:\n  contents: read$/mu.test(source) ||
    /(?:permissions:[\s\S]{0,100}|^\s+)(?:actions|checks|deployments|packages|pull-requests|security-events|statuses):\s*write$/mu.test(
      source,
    )
  ) {
    addFailure(failures, "CI_GATE_INVALID", ciPath);
  }
}

async function validateGitArtifacts(repositoryRoot, failures) {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
      { cwd: repositoryRoot, encoding: "utf8", maxBuffer: 1024 * 1024 },
    );
    for (const path of stdout.split("\0").filter(Boolean).toSorted()) {
      if (recordingArtifactPattern.test(path)) {
        addFailure(failures, "RECORDING_ARTIFACT_PRESENT", path);
      }
    }
  } catch {
    addFailure(failures, "GIT_METADATA_UNAVAILABLE", ".");
  }
}

export async function validateReleaseReadiness({ mode, repositoryRoot }) {
  if (!new Set(["candidate", "release"]).has(mode)) {
    throw new TypeError("mode must be candidate or release");
  }
  if (typeof repositoryRoot !== "string" || repositoryRoot.length === 0) {
    throw new TypeError("repositoryRoot must be a non-empty string");
  }

  await access(repositoryRoot);
  const failures = [];
  const existing = await existingPaths(repositoryRoot, failures);

  if (existing.has(manifestPath)) {
    const manifest = await readJson(repositoryRoot, manifestPath, failures);
    if (manifest != null) validateManifest(manifest, mode, failures);
  }
  if (existing.has(evalPath)) {
    const corpus = await readJson(repositoryRoot, evalPath, failures);
    if (corpus != null) validateEvalCorpus(corpus, failures);
  }
  await validatePublicText(repositoryRoot, existing, failures);
  if (mode === "release") {
    await validateReleaseChangelog(repositoryRoot, existing, failures);
  }
  await validateActionPins(repositoryRoot, existing, failures);
  await validateCi(repositoryRoot, existing, failures);
  await validateGitArtifacts(repositoryRoot, failures);

  failures.sort((left, right) => {
    if (left.path !== right.path) return left.path < right.path ? -1 : 1;
    if (left.code === right.code) return 0;
    return left.code < right.code ? -1 : 1;
  });
  if (failures.length > 0) throw new ReleaseReadinessError(mode, failures);
  return { status: "pass", mode };
}

async function main() {
  const mode =
    process.argv.length === 3 && process.argv[2] === "--candidate"
      ? "candidate"
      : process.argv.length === 3 && process.argv[2] === "--release"
        ? "release"
        : null;
  if (mode == null) {
    process.stderr.write("USAGE_INVALID scripts/validate-release-readiness.mjs\n");
    process.exitCode = 2;
    return;
  }

  const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  try {
    await validateReleaseReadiness({ mode, repositoryRoot });
  } catch (error) {
    if (error instanceof ReleaseReadinessError) {
      for (const { code, path } of error.failures) {
        process.stderr.write(`${code} ${path}\n`);
      }
    } else {
      process.stderr.write("VALIDATOR_INTERNAL_ERROR scripts/validate-release-readiness.mjs\n");
    }
    process.exitCode = 1;
  }
}

if (process.argv[1] != null && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
