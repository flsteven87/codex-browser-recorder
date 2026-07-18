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
const releaseVersion = JSON.parse(
  await readFile(join(sourceRoot, manifestPath), "utf8"),
).version.split("+", 1)[0];
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
  await mutateJson(repositoryRoot, manifestPath, (manifest) => {
    manifest.version = `${releaseVersion}+codex.fixture`;
  });
  await replaceText(
    repositoryRoot,
    "CHANGELOG.md",
    new RegExp(
      `^## \\[${releaseVersion.replaceAll(".", "[.]")}\\] - .+$`,
      "mu",
    ),
    `## [${releaseVersion}] - Unreleased`,
  );
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

async function syncPublicVersionReferences(repositoryRoot, version) {
  const canonicalVersion = version.split("+", 1)[0];
  for (const [relativePath, pattern, replacement] of [
    [
      "README.md",
      /git clone --branch v[0-9]+[.][0-9]+[.][0-9]+ --depth 1/u,
      `git clone --branch v${canonicalVersion} --depth 1`,
    ],
    [
      "SECURITY.md",
      /Version `[0-9]+[.][0-9]+[.][0-9]+` is the latest supported release/u,
      `Version \`${canonicalVersion}\` is the latest supported release`,
    ],
    [
      "SUPPORT.md",
      /Browser Recorder for Codex `v[0-9]+[.][0-9]+[.][0-9]+`/u,
      `Browser Recorder for Codex \`v${canonicalVersion}\``,
    ],
  ]) {
    await replaceText(repositoryRoot, relativePath, pattern, replacement);
  }
}

async function mutateWorkflowStep(repositoryRoot, name, mutate) {
  const path = join(repositoryRoot, ".github/workflows/ci.yml");
  const source = await readFile(path, "utf8");
  const marker = `      - name: ${name}`;
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, `workflow fixture must contain ${name}`);
  const next = source.indexOf("\n      - name: ", start + marker.length);
  const end = next === -1 ? source.length : next + 1;
  const block = source.slice(start, end);
  await writeFile(path, source.slice(0, start) + mutate(block) + source.slice(end));
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

async function assertSemanticAndHashFailures(repositoryRoot, code) {
  await assert.rejects(
    validateReleaseReadiness({ mode: "candidate", repositoryRoot }),
    (error) => {
      assert.deepEqual(error.failures, [
        { code, path: ".github/workflows/ci.yml" },
        {
          code: "CI_WORKFLOW_HASH_INVALID",
          path: ".github/workflows/ci.yml",
        },
      ]);
      return true;
    },
  );
}

async function finalizeReleaseFixture(repositoryRoot) {
  await replaceText(
    repositoryRoot,
    "CHANGELOG.md",
    /^## \[Unreleased\]\n[\s\S]*?(?=^## \[)/mu,
    "",
  );
  await mutateJson(repositoryRoot, manifestPath, (manifest) => {
    manifest.version = releaseVersion;
  });
  await replaceText(
    repositoryRoot,
    "CHANGELOG.md",
    `## [${releaseVersion}] - Unreleased`,
    `## [${releaseVersion}] - 2026-07-16`,
  );
}

function nextPatchVersion(version) {
  const [major, minor, patch] = version.split(".").map(Number);
  return `${major}.${minor}.${patch + 1}`;
}

test("accepts the complete release candidate fixture", async () => {
  const repositoryRoot = await createFixture();

  const candidate = await validateReleaseReadiness({
    mode: "candidate",
    repositoryRoot,
  });

  assert.deepEqual(candidate, { status: "pass", mode: "candidate" });
});

test("candidate accepts semantic versions with at most one Codex cachebuster", async () => {
  for (const version of [
    `${releaseVersion}+other.1`,
    `${releaseVersion}+codex.a.b`,
    `v${releaseVersion}`,
  ]) {
    const repositoryRoot = await createFixture();
    await mutateJson(repositoryRoot, manifestPath, (manifest) => {
      manifest.version = version;
    });
    await syncPublicVersionReferences(repositoryRoot, version);
    await assertOnlyFailure(
      repositoryRoot,
      "VERSION_INVALID",
      manifestPath,
    );
  }
});

test("candidate accepts future canonical versions without validator edits", async () => {
  for (const version of [
    releaseVersion,
    "1.0.0",
    "1.0.0+codex.fixture",
  ]) {
    const repositoryRoot = await createFixture();
    await mutateJson(repositoryRoot, manifestPath, (manifest) => {
      manifest.version = version;
    });
    await syncPublicVersionReferences(repositoryRoot, version);
    await replaceText(
      repositoryRoot,
      "CHANGELOG.md",
      `## [${releaseVersion}] - Unreleased`,
      `## [${version.split("+")[0]}] - Unreleased`,
    );
    assert.deepEqual(
      await validateReleaseReadiness({ mode: "candidate", repositoryRoot }),
      { status: "pass", mode: "candidate" },
    );
  }
});

test("candidate rejects a changelog version that differs from the manifest", async () => {
  const repositoryRoot = await createFixture();
  await mutateJson(repositoryRoot, manifestPath, (manifest) => {
    manifest.version = nextPatchVersion(releaseVersion);
  });
  await syncPublicVersionReferences(
    repositoryRoot,
    nextPatchVersion(releaseVersion),
  );

  await assertOnlyFailure(
    repositoryRoot,
    "CHANGELOG_RELEASE_INCOMPLETE",
    "CHANGELOG.md",
  );
});

test("rejects stale public release version references", async () => {
  const staleVersion = nextPatchVersion(releaseVersion);
  for (const [relativePath, currentReference, staleReference] of [
    [
      "README.md",
      /git clone --branch v[0-9]+[.][0-9]+[.][0-9]+/u,
      `git clone --branch v${staleVersion}`,
    ],
    [
      "SECURITY.md",
      /Version `[0-9]+[.][0-9]+[.][0-9]+` is the latest supported release/u,
      `Version \`${staleVersion}\` is the latest supported release`,
    ],
    [
      "SUPPORT.md",
      /Browser Recorder for Codex `v[0-9]+[.][0-9]+[.][0-9]+`/u,
      `Browser Recorder for Codex \`v${staleVersion}\``,
    ],
  ]) {
    const repositoryRoot = await createFixture();
    await replaceText(
      repositoryRoot,
      relativePath,
      currentReference,
      staleReference,
    );
    await assertOnlyFailure(
      repositoryRoot,
      "PUBLIC_VERSION_MISMATCH",
      relativePath,
    );
  }
});

test("cachebusted candidate requires an Unreleased changelog entry", async () => {
  const repositoryRoot = await createFixture();
  await replaceText(
    repositoryRoot,
    "CHANGELOG.md",
    `## [${releaseVersion}] - Unreleased`,
    `## [${releaseVersion}] - 2026-07-16`,
  );

  await assertOnlyFailure(
    repositoryRoot,
    "CHANGELOG_RELEASE_INCOMPLETE",
    "CHANGELOG.md",
  );
});

test("release accepts a canonical manifest version with a matching dated changelog", async () => {
  const repositoryRoot = await createFixture();
  await finalizeReleaseFixture(repositoryRoot);

  const release = await validateReleaseReadiness({
    mode: "release",
    repositoryRoot,
  });
  assert.deepEqual(release, { status: "pass", mode: "release" });

  await mutateJson(repositoryRoot, manifestPath, (manifest) => {
    manifest.version = `${releaseVersion}+codex.20260716`;
  });
  await assertOnlyFailure(
    repositoryRoot,
    "VERSION_INVALID",
    manifestPath,
    "release",
  );
});

test("release derives the changelog version from the manifest", async () => {
  const repositoryRoot = await createFixture();
  await finalizeReleaseFixture(repositoryRoot);
  await mutateJson(repositoryRoot, manifestPath, (manifest) => {
    manifest.version = "1.0.0";
  });
  await syncPublicVersionReferences(repositoryRoot, "1.0.0");
  await replaceText(
    repositoryRoot,
    "CHANGELOG.md",
    `## [${releaseVersion}] - 2026-07-16`,
    "## [1.0.0] - 2026-07-16",
  );

  assert.deepEqual(
    await validateReleaseReadiness({ mode: "release", repositoryRoot }),
    { status: "pass", mode: "release" },
  );
});

test("release rejects a changelog version that differs from the manifest", async () => {
  const repositoryRoot = await createFixture();
  await finalizeReleaseFixture(repositoryRoot);
  await mutateJson(repositoryRoot, manifestPath, (manifest) => {
    manifest.version = nextPatchVersion(releaseVersion);
  });
  await syncPublicVersionReferences(
    repositoryRoot,
    nextPatchVersion(releaseVersion),
  );

  await assertOnlyFailure(
    repositoryRoot,
    "CHANGELOG_RELEASE_INCOMPLETE",
    "CHANGELOG.md",
    "release",
  );
});

test("release rejects an undated canonical changelog entry", async () => {
  const repositoryRoot = await createFixture();
  await mutateJson(repositoryRoot, manifestPath, (manifest) => {
    manifest.version = releaseVersion;
  });

  await assertOnlyFailure(
    repositoryRoot,
    "CHANGELOG_RELEASE_INCOMPLETE",
    "CHANGELOG.md",
    "release",
  );
});

test("release rejects duplicate or residual Unreleased release headings", async () => {
  for (const extraHeading of [
    `## [${releaseVersion}] - 2026-07-17`,
    `## [${releaseVersion}] - Unreleased`,
    "## [Unreleased]\n\n### Changed\n\n- Pending work.",
  ]) {
    const repositoryRoot = await createFixture();
    await finalizeReleaseFixture(repositoryRoot);
    const path = join(repositoryRoot, "CHANGELOG.md");
    const source = await readFile(path, "utf8");
    await writeFile(path, `${source}\n${extraHeading}\n`);

    await assertOnlyFailure(
      repositoryRoot,
      "CHANGELOG_RELEASE_INCOMPLETE",
      "CHANGELOG.md",
      "release",
    );
  }
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

  await assertSemanticAndHashFailures(
    repositoryRoot,
    "ACTION_PIN_INVALID",
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
    await assertSemanticAndHashFailures(
      repositoryRoot,
      "CI_CODEX_GATE_INVALID",
    );
  }
});

test("rejects required CI steps with YAML-level failure suppression", async () => {
  for (const [name, control] of [
    ["Install pinned Codex CLI", "        if: false\n"],
    ["Run official plugin validator", "        continue-on-error: true\n"],
    ["Verify isolated plugin installation", "        continue-on-error: true\n"],
    ["Verify release candidate", "        if: false\n"],
  ]) {
    const repositoryRoot = await createFixture();
    await mutateWorkflowStep(repositoryRoot, name, (block) =>
      block.replace(`      - name: ${name}\n`, `      - name: ${name}\n${control}`),
    );
    await assertSemanticAndHashFailures(
      repositoryRoot,
      "CI_REQUIRED_STEP_INVALID",
    );
  }
});

test("rejects a conditional CI test job", async () => {
  for (const [pattern, replacement] of [
    [
      "  test:\n    runs-on: macos-14",
      "  test:\n    if: false\n    runs-on: macos-14",
    ],
    [
      "    timeout-minutes: 15",
      "    timeout-minutes: 15\n    if: false",
    ],
  ]) {
    const repositoryRoot = await createFixture();
    await replaceText(
      repositoryRoot,
      ".github/workflows/ci.yml",
      pattern,
      replacement,
    );
    await assertSemanticAndHashFailures(
      repositoryRoot,
      "CI_REQUIRED_STEP_INVALID",
    );
  }
});

test("rejects required named steps moved outside the CI test job", async () => {
  const repositoryRoot = await createFixture();
  await replaceText(
    repositoryRoot,
    ".github/workflows/ci.yml",
    "      - name: Verify release candidate",
    "      - name: Candidate command without required binding",
  );
  const path = join(repositoryRoot, ".github/workflows/ci.yml");
  const source = await readFile(path, "utf8");
  await writeFile(
    path,
    `${source}\n  decoy:\n    runs-on: macos-14\n    steps:\n      - name: Verify release candidate\n        run: npm run check:release-candidate\n`,
  );
  await assertSemanticAndHashFailures(
    repositoryRoot,
    "CI_REQUIRED_STEP_INVALID",
  );
});

test("rejects false branches and shell failure suppression in official validator steps", async () => {
  for (const mutate of [
    (block) =>
      block.replace("        run: |\n", "        run: |\n          if false; then\n") +
      "          fi\n",
    (block) => block.replace(/(uv run [^\n]+)/u, "$1 || true"),
    (block) => block.replace(/(uv run [^\n]+)/u, "$1 || echo suppressed"),
  ]) {
    const repositoryRoot = await createFixture();
    await mutateWorkflowStep(
      repositoryRoot,
      "Run official skill validator",
      mutate,
    );
    await assertSemanticAndHashFailures(
      repositoryRoot,
      "CI_REQUIRED_STEP_INVALID",
    );
  }
});

test("rejects setup-uv moved from the test job to a decoy job", async () => {
  const repositoryRoot = await createFixture();
  let movedStep;
  await mutateWorkflowStep(repositoryRoot, "Set up pinned uv", (block) => {
    movedStep = block;
    return "";
  });
  const path = join(repositoryRoot, ".github/workflows/ci.yml");
  const source = await readFile(path, "utf8");
  await writeFile(
    path,
    `${source}\n  decoy:\n    runs-on: macos-14\n    steps:\n${movedStep}`,
  );

  await assertOnlyFailure(
    repositoryRoot,
    "CI_WORKFLOW_HASH_INVALID",
    ".github/workflows/ci.yml",
  );
});

test("rejects unparsed shell control and custom-shell bypasses", async () => {
  for (const mutate of [
    (block) =>
      block.replace("        run: |\n", "        run: |\n          while ! true; do\n") +
      "          done\n",
    (block) =>
      block.replace("        run: |\n", "        run: |\n          set +e\n") +
      "          true\n",
    (block) =>
      block.replace(
        "      - name: Run official plugin validator\n",
        "      - name: Run official plugin validator\n        shell: /usr/bin/true {0}\n",
      ),
  ]) {
    const repositoryRoot = await createFixture();
    await mutateWorkflowStep(
      repositoryRoot,
      "Run official plugin validator",
      mutate,
    );
    await assertOnlyFailure(
      repositoryRoot,
      "CI_WORKFLOW_HASH_INVALID",
      ".github/workflows/ci.yml",
    );
  }
});

test("rejects a single-byte change to the canonical CI workflow", async () => {
  const repositoryRoot = await createFixture();
  const path = join(repositoryRoot, ".github/workflows/ci.yml");
  const source = await readFile(path, "utf8");
  await writeFile(path, `${source} `);

  await assertOnlyFailure(
    repositoryRoot,
    "CI_WORKFLOW_HASH_INVALID",
    ".github/workflows/ci.yml",
  );
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
