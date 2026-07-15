import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  cp,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  validateReleaseReadiness,
} from "../scripts/validate-release-readiness.mjs";

const sourceRoot = fileURLToPath(new URL("../", import.meta.url));
const manifestPath = "plugins/codex-browser-recorder/.codex-plugin/plugin.json";
const fixturePaths = [
  ".github/CODEOWNERS",
  ".github/ISSUE_TEMPLATE/bug_report.yml",
  ".github/ISSUE_TEMPLATE/config.yml",
  ".github/ISSUE_TEMPLATE/feature_request.yml",
  ".github/dependabot.yml",
  ".github/pull_request_template.md",
  ".github/workflows/ci.yml",
  ".github/workflows/codeql.yml",
  "CHANGELOG.md",
  "CODE_OF_CONDUCT.md",
  "CONTRIBUTING.md",
  "PRIVACY.md",
  "README.md",
  "SECURITY.md",
  "SUPPORT.md",
  "TERMS.md",
  "evals/plugin-submission-cases.json",
  manifestPath,
  "plugins/codex-browser-recorder/assets",
];
const temporaryRoots = [];

test.after(async () => {
  await Promise.all(
    temporaryRoots.map((root) => rm(root, { force: true, recursive: true })),
  );
});

async function createFixture() {
  const repositoryRoot = await mkdtemp(join(tmpdir(), "release-readiness-test-"));
  temporaryRoots.push(repositoryRoot);

  for (const relativePath of fixturePaths) {
    const source = join(sourceRoot, relativePath);
    const target = join(repositoryRoot, relativePath);
    await mkdir(dirname(target), { recursive: true });
    await cp(source, target, { recursive: true });
  }
  execFileSync("git", ["init", "--quiet"], { cwd: repositoryRoot });
  return repositoryRoot;
}

async function mutateJson(repositoryRoot, relativePath, mutate) {
  const path = join(repositoryRoot, relativePath);
  const value = JSON.parse(await readFile(path, "utf8"));
  mutate(value);
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function replaceText(repositoryRoot, relativePath, pattern, replacement) {
  const path = join(repositoryRoot, relativePath);
  const source = await readFile(path, "utf8");
  if (typeof pattern === "string") {
    assert.ok(
      source.includes(pattern),
      `${relativePath} fixture must contain mutation target`,
    );
  } else {
    assert.match(source, pattern, `${relativePath} fixture must contain mutation target`);
  }
  await writeFile(path, source.replace(pattern, replacement));
}

async function assertOnlyFailure(repositoryRoot, code, path, mode = "candidate") {
  await assert.rejects(
    validateReleaseReadiness({ mode, repositoryRoot }),
    (error) => {
      assert.deepEqual(error.failures, [{ code, path }]);
      return true;
    },
  );
}

async function finalizeReleaseFixture(repositoryRoot) {
  await mutateJson(repositoryRoot, manifestPath, (manifest) => {
    manifest.version = "0.1.0";
  });
  await replaceText(
    repositoryRoot,
    "CHANGELOG.md",
    "## [0.1.0] - Unreleased",
    "## [0.1.0] - 2026-07-16",
  );
}

test("accepts the complete release candidate fixture", async () => {
  const repositoryRoot = await createFixture();

  const candidate = await validateReleaseReadiness({
    mode: "candidate",
    repositoryRoot,
  });

  assert.deepEqual(candidate, { status: "pass", mode: "candidate" });
});

test("candidate accepts only the canonical version or one Codex cachebuster", async () => {
  for (const version of ["0.1.1", "0.1.0+other.1", "0.1.0+codex.a.b"]) {
    const repositoryRoot = await createFixture();
    await mutateJson(repositoryRoot, manifestPath, (manifest) => {
      manifest.version = version;
    });
    await assertOnlyFailure(
      repositoryRoot,
      "VERSION_INVALID",
      manifestPath,
    );
  }
});

test("release accepts only canonical 0.1.0 with a dated changelog", async () => {
  const repositoryRoot = await createFixture();
  await finalizeReleaseFixture(repositoryRoot);

  const release = await validateReleaseReadiness({
    mode: "release",
    repositoryRoot,
  });
  assert.deepEqual(release, { status: "pass", mode: "release" });

  await mutateJson(repositoryRoot, manifestPath, (manifest) => {
    manifest.version = "0.1.0+codex.20260716";
  });
  await assertOnlyFailure(
    repositoryRoot,
    "VERSION_INVALID",
    manifestPath,
    "release",
  );
});

test("release rejects an undated canonical changelog entry", async () => {
  const repositoryRoot = await createFixture();
  await mutateJson(repositoryRoot, manifestPath, (manifest) => {
    manifest.version = "0.1.0";
  });

  await assertOnlyFailure(
    repositoryRoot,
    "CHANGELOG_RELEASE_INCOMPLETE",
    "CHANGELOG.md",
    "release",
  );
});

test("reports one stable missing-file failure for every release material", async () => {
  for (const relativePath of [
    "PRIVACY.md",
    "TERMS.md",
    "SUPPORT.md",
    "CHANGELOG.md",
    "CODE_OF_CONDUCT.md",
    "evals/plugin-submission-cases.json",
    "plugins/codex-browser-recorder/assets/icon.png",
  ]) {
    const repositoryRoot = await createFixture();
    await unlink(join(repositoryRoot, relativePath));
    await assertOnlyFailure(
      repositoryRoot,
      "REQUIRED_FILE_MISSING",
      relativePath,
    );
  }
});

test("rejects eval corpora without exactly five positive and three negative cases", async () => {
  const repositoryRoot = await createFixture();
  await mutateJson(
    repositoryRoot,
    "evals/plugin-submission-cases.json",
    (corpus) => corpus.cases.pop(),
  );

  await assertOnlyFailure(
    repositoryRoot,
    "EVAL_COUNT_INVALID",
    "evals/plugin-submission-cases.json",
  );
});

test("rejects insecure manifest links", async () => {
  const repositoryRoot = await createFixture();
  await mutateJson(repositoryRoot, manifestPath, (manifest) => {
    manifest.interface.privacyPolicyURL = "http://invalid.example/privacy";
  });

  await assertOnlyFailure(repositoryRoot, "MANIFEST_LINK_INVALID", manifestPath);
});

test("rejects too many or oversized default prompts", async () => {
  for (const mutate of [
    (manifest) => manifest.interface.defaultPrompt.push("Fourth prompt"),
    (manifest) => {
      manifest.interface.defaultPrompt[0] = "x".repeat(129);
    },
  ]) {
    const repositoryRoot = await createFixture();
    await mutateJson(repositoryRoot, manifestPath, mutate);
    await assertOnlyFailure(
      repositoryRoot,
      "DEFAULT_PROMPTS_INVALID",
      manifestPath,
    );
  }
});

test("rejects placeholder text in public materials", async () => {
  const repositoryRoot = await createFixture();
  await writeFile(join(repositoryRoot, "SUPPORT.md"), "TODO\n");

  await assertOnlyFailure(repositoryRoot, "PLACEHOLDER_TEXT", "SUPPORT.md");
});

test("rejects workflow actions that are not pinned to full SHAs", async () => {
  const repositoryRoot = await createFixture();
  await replaceText(
    repositoryRoot,
    ".github/workflows/ci.yml",
    /actions\/checkout@[0-9a-f]{40}/,
    "actions/checkout@v4",
  );

  await assertOnlyFailure(
    repositoryRoot,
    "ACTION_PIN_INVALID",
    ".github/workflows/ci.yml",
  );
});

test("rejects CI that conditionally skips the Codex CLI or install gate", async () => {
  for (const [pattern, replacement] of [
    [
      "npm install --global @openai/codex@0.144.4",
      "command -v codex >/dev/null || npm install --global @openai/codex@0.144.4",
    ],
    [
      "npm run test:plugin-install",
      "command -v codex >/dev/null && npm run test:plugin-install",
    ],
  ]) {
    const repositoryRoot = await createFixture();
    await replaceText(
      repositoryRoot,
      ".github/workflows/ci.yml",
      pattern,
      replacement,
    );
    await assertOnlyFailure(
      repositoryRoot,
      "CI_CODEX_GATE_INVALID",
      ".github/workflows/ci.yml",
    );
  }
});

test("rejects recording artifacts present in repository metadata", async () => {
  const repositoryRoot = await createFixture();
  await writeFile(join(repositoryRoot, "recording.webm"), "synthetic fixture");

  await assertOnlyFailure(
    repositoryRoot,
    "RECORDING_ARTIFACT_PRESENT",
    "recording.webm",
  );
});

test("does not confuse recording source filenames with artifact directories", async () => {
  const repositoryRoot = await createFixture();
  const sourcePath = join(repositoryRoot, "scripts", "recording-policy.mjs");
  await mkdir(dirname(sourcePath), { recursive: true });
  await writeFile(sourcePath, "export const policy = true;\n");

  const candidate = await validateReleaseReadiness({
    mode: "candidate",
    repositoryRoot,
  });
  assert.deepEqual(candidate, { status: "pass", mode: "candidate" });
});
