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
import { PUBLIC_TEXT_PATHS } from "../scripts/release-materials.mjs";

const sourceRoot = fileURLToPath(new URL("../", import.meta.url));
const manifestPath = "plugins/codex-browser-recorder/.codex-plugin/plugin.json";
const fixturePaths = [
  ...PUBLIC_TEXT_PATHS,
  ".github/workflows/ci.yml",
  ".github/workflows/codeql.yml",
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

async function syncCandidateVersionReferences(repositoryRoot, version) {
  const canonicalVersion = version.split("+", 1)[0];
  for (const [relativePath, pattern, replacement] of [
    [
      "README.md",
      /Version `[0-9]+[.][0-9]+[.][0-9]+` is an upcoming release candidate/u,
      `Version \`${canonicalVersion}\` is an upcoming release candidate`,
    ],
    [
      "SECURITY.md",
      /Version `[0-9]+[.][0-9]+[.][0-9]+` is\s+an unreleased candidate/u,
      `Version \`${canonicalVersion}\` is an unreleased candidate`,
    ],
    [
      "SUPPORT.md",
      /Version\s+`v[0-9]+[.][0-9]+[.][0-9]+` is an unreleased candidate/u,
      `Version \`v${canonicalVersion}\` is an unreleased candidate`,
    ],
  ]) {
    await replaceText(repositoryRoot, relativePath, pattern, replacement);
  }
}

async function syncPublishedVersionReferences(repositoryRoot, version) {
  const canonicalVersion = version.split("+", 1)[0];
  for (const [relativePath, pattern, replacement] of [
    [
      "README.md",
      /Install and verify latest published version [0-9]+[.][0-9]+[.][0-9]+/u,
      `Install and verify latest published version ${canonicalVersion}`,
    ],
    [
      "README.md",
      /git clone --branch v[0-9]+[.][0-9]+[.][0-9]+ --depth 1/u,
      `git clone --branch v${canonicalVersion} --depth 1`,
    ],
    [
      "README.md",
      /releases\/tag\/v[0-9]+[.][0-9]+[.][0-9]+/u,
      `releases/tag/v${canonicalVersion}`,
    ],
    [
      "README.md",
      /\[v[0-9]+[.][0-9]+[.][0-9]+ release page\]/u,
      `[v${canonicalVersion} release page]`,
    ],
    [
      "README.md",
      /recorder_release=v[0-9]+[.][0-9]+[.][0-9]+/u,
      `recorder_release=v${canonicalVersion}`,
    ],
    [
      "SECURITY.md",
      /Version `[0-9]+[.][0-9]+[.][0-9]+` is the latest supported published release/u,
      `Version \`${canonicalVersion}\` is the latest supported published release`,
    ],
    [
      "SUPPORT.md",
      /latest published Browser Recorder for Codex release is `v[0-9]+[.][0-9]+[.][0-9]+`/u,
      `latest published Browser Recorder for Codex release is \`v${canonicalVersion}\``,
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

async function removeCandidateReferences(repositoryRoot) {
  for (const [relativePath, pattern] of [
    [
      "README.md",
      /^Version `[0-9]+[.][0-9]+[.][0-9]+` is an upcoming release candidate\.[\s\S]*?transition\.\n\n/mu,
    ],
    [
      "SECURITY.md",
      / Version `[0-9]+[.][0-9]+[.][0-9]+` is\s+an unreleased candidate\./u,
    ],
    [
      "SUPPORT.md",
      / Version\s+`v[0-9]+[.][0-9]+[.][0-9]+` is an unreleased candidate[^.]*\./u,
    ],
  ]) {
    await replaceText(repositoryRoot, relativePath, pattern, "");
  }
}

async function finalizeReleaseFixture(repositoryRoot, version = releaseVersion) {
  await mutateJson(repositoryRoot, manifestPath, (manifest) => {
    manifest.version = version;
  });
  await syncPublishedVersionReferences(repositoryRoot, version);
  await removeCandidateReferences(repositoryRoot);
  await replaceText(
    repositoryRoot,
    "CHANGELOG.md",
    `## [${version}] - Unreleased`,
    `## [${version}] - 2026-07-27`,
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

test("candidate rejects unavailable candidate artifacts presented as published", async () => {
  const repositoryRoot = await createFixture();
  await syncPublishedVersionReferences(repositoryRoot, releaseVersion);

  await assert.rejects(
    validateReleaseReadiness({ mode: "candidate", repositoryRoot }),
    (error) => {
      assert.deepEqual(error.failures, [
        { code: "PUBLISHED_VERSION_MISMATCH", path: "README.md" },
        { code: "PUBLISHED_VERSION_MISMATCH", path: "SECURITY.md" },
        { code: "PUBLISHED_VERSION_MISMATCH", path: "SUPPORT.md" },
      ]);
      return true;
    },
  );
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
    await syncCandidateVersionReferences(repositoryRoot, version);
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

test("candidate compares oversized semantic version components losslessly", async () => {
  const repositoryRoot = await createFixture();
  const publishedVersion = "9007199254740992.0.0";
  const candidateVersion = "9007199254740993.0.0";
  await mutateJson(repositoryRoot, manifestPath, (manifest) => {
    manifest.version = candidateVersion;
  });
  await syncCandidateVersionReferences(repositoryRoot, candidateVersion);
  await syncPublishedVersionReferences(repositoryRoot, publishedVersion);
  await replaceText(
    repositoryRoot,
    "CHANGELOG.md",
    `## [${releaseVersion}] - Unreleased`,
    `## [${candidateVersion}] - Unreleased`,
  );
  await replaceText(
    repositoryRoot,
    "CHANGELOG.md",
    "## [0.3.3] - 2026-07-24",
    `## [${publishedVersion}] - 2026-07-24`,
  );

  assert.deepEqual(
    await validateReleaseReadiness({ mode: "candidate", repositoryRoot }),
    { status: "pass", mode: "candidate" },
  );
});

test("candidate rejects a changelog version that differs from the manifest", async () => {
  const repositoryRoot = await createFixture();
  await mutateJson(repositoryRoot, manifestPath, (manifest) => {
    manifest.version = nextPatchVersion(releaseVersion);
  });
  await syncCandidateVersionReferences(
    repositoryRoot,
    nextPatchVersion(releaseVersion),
  );

  await assertOnlyFailure(
    repositoryRoot,
    "CHANGELOG_RELEASE_INCOMPLETE",
    "CHANGELOG.md",
  );
});

test("candidate rejects stale latest published references", async () => {
  const staleVersion = nextPatchVersion(releaseVersion);
  for (const [relativePath, currentReference, staleReference] of [
    [
      "README.md",
      /Install and verify latest published version [0-9]+[.][0-9]+[.][0-9]+/u,
      `Install and verify latest published version ${staleVersion}`,
    ],
    [
      "README.md",
      /git clone --branch v[0-9]+[.][0-9]+[.][0-9]+/u,
      `git clone --branch v${staleVersion}`,
    ],
    [
      "README.md",
      /releases\/tag\/v[0-9]+[.][0-9]+[.][0-9]+/u,
      `releases/tag/v${staleVersion}`,
    ],
    [
      "README.md",
      /\[v[0-9]+[.][0-9]+[.][0-9]+ release page\]/u,
      `[v${staleVersion} release page]`,
    ],
    [
      "README.md",
      /recorder_release=v[0-9]+[.][0-9]+[.][0-9]+/u,
      `recorder_release=v${staleVersion}`,
    ],
    [
      "SECURITY.md",
      /Version `[0-9]+[.][0-9]+[.][0-9]+` is the latest supported published release/u,
      `Version \`${staleVersion}\` is the latest supported published release`,
    ],
    [
      "SUPPORT.md",
      /latest published Browser Recorder for Codex release is `v[0-9]+[.][0-9]+[.][0-9]+`/u,
      `latest published Browser Recorder for Codex release is \`v${staleVersion}\``,
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
      "PUBLISHED_VERSION_MISMATCH",
      relativePath,
    );
  }
});

test("candidate requires exactly one candidate reference per public surface", async () => {
  for (const [relativePath, pattern] of [
    [
      "README.md",
      /Version `[0-9]+[.][0-9]+[.][0-9]+` is an upcoming release candidate/u,
    ],
    [
      "SECURITY.md",
      /Version `[0-9]+[.][0-9]+[.][0-9]+` is\s+an unreleased candidate/u,
    ],
    [
      "SUPPORT.md",
      /Version\s+`v[0-9]+[.][0-9]+[.][0-9]+` is an unreleased candidate/u,
    ],
  ]) {
    for (const replacement of ["", "$&\n$&"]) {
      const repositoryRoot = await createFixture();
      await replaceText(repositoryRoot, relativePath, pattern, replacement);
      await assertOnlyFailure(
        repositoryRoot,
        "CANDIDATE_VERSION_MISMATCH",
        relativePath,
      );
    }
  }
});

test("candidate requires exactly one latest-published reference per claim", async () => {
  for (const [description, relativePath, pattern] of [
    [
      "README summary",
      "README.md",
      /Install and verify latest published version [0-9]+[.][0-9]+[.][0-9]+/u,
    ],
    [
      "README clone",
      "README.md",
      /git clone --branch v[0-9]+[.][0-9]+[.][0-9]+ --depth 1/u,
    ],
    [
      "README tag URL",
      "README.md",
      /\(https:\/\/github[.]com\/flsteven87\/codex-browser-recorder\/releases\/tag\/v[0-9]+[.][0-9]+[.][0-9]+\)/u,
    ],
    [
      "README release label",
      "README.md",
      /\[v[0-9]+[.][0-9]+[.][0-9]+ release page\]/u,
    ],
    [
      "README checksum version",
      "README.md",
      /recorder_release=v[0-9]+[.][0-9]+[.][0-9]+/u,
    ],
    [
      "SECURITY latest",
      "SECURITY.md",
      /Version `[0-9]+[.][0-9]+[.][0-9]+` is the latest supported published release/u,
    ],
    [
      "SUPPORT latest",
      "SUPPORT.md",
      /latest published Browser Recorder for Codex release is `v[0-9]+[.][0-9]+[.][0-9]+`/u,
    ],
  ]) {
    for (const replacement of ["", "$&\n$&"]) {
      const repositoryRoot = await createFixture();
      await replaceText(repositoryRoot, relativePath, pattern, replacement);
      await assert.rejects(
        validateReleaseReadiness({ mode: "candidate", repositoryRoot }),
        (error) => {
          assert.deepEqual(
            error.failures,
            [{ code: "PUBLISHED_VERSION_MISMATCH", path: relativePath }],
            `${description} with replacement ${JSON.stringify(replacement)}`,
          );
          return true;
        },
        `${description} with replacement ${JSON.stringify(replacement)}`,
      );
    }
  }
});

test("candidate rejects duplicate or out-of-order published changelog headings", async () => {
  for (const extraHeading of [
    "## [0.3.3] - 2026-07-24",
    "## [9.0.0] - 2026-01-01",
  ]) {
    const repositoryRoot = await createFixture();
    const path = join(repositoryRoot, "CHANGELOG.md");
    const source = await readFile(path, "utf8");
    await writeFile(path, `${source}\n${extraHeading}\n`);

    await assertOnlyFailure(
      repositoryRoot,
      "PUBLISHED_CHANGELOG_INVALID",
      "CHANGELOG.md",
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

test("release rejects every retained candidate-only public claim", async () => {
  for (const [relativePath, candidateClaim] of [
    [
      "README.md",
      `Version \`${releaseVersion}\` is an upcoming release candidate`,
    ],
    [
      "SECURITY.md",
      `Version \`${releaseVersion}\` is an unreleased candidate`,
    ],
    [
      "SUPPORT.md",
      `Version \`v${releaseVersion}\` is an unreleased candidate`,
    ],
  ]) {
    const repositoryRoot = await createFixture();
    await finalizeReleaseFixture(repositoryRoot);
    const path = join(repositoryRoot, relativePath);
    await writeFile(
      path,
      `${await readFile(path, "utf8")}\n${candidateClaim}\n`,
    );

    await assertOnlyFailure(
      repositoryRoot,
      "CANDIDATE_VERSION_MISMATCH",
      relativePath,
      "release",
    );
  }
});

test("release requires every published claim exactly once at the manifest version", async () => {
  const staleVersion = nextPatchVersion(releaseVersion);
  for (const [relativePath, pattern, staleReference] of [
    [
      "README.md",
      /Install and verify latest published version [0-9]+[.][0-9]+[.][0-9]+/u,
      `Install and verify latest published version ${staleVersion}`,
    ],
    [
      "README.md",
      /git clone --branch v[0-9]+[.][0-9]+[.][0-9]+ --depth 1/u,
      `git clone --branch v${staleVersion} --depth 1`,
    ],
    [
      "README.md",
      /\(https:\/\/github[.]com\/flsteven87\/codex-browser-recorder\/releases\/tag\/v[0-9]+[.][0-9]+[.][0-9]+\)/u,
      `(https://github.com/flsteven87/codex-browser-recorder/releases/tag/v${staleVersion})`,
    ],
    [
      "README.md",
      /\[v[0-9]+[.][0-9]+[.][0-9]+ release page\]/u,
      `[v${staleVersion} release page]`,
    ],
    [
      "README.md",
      /recorder_release=v[0-9]+[.][0-9]+[.][0-9]+/u,
      `recorder_release=v${staleVersion}`,
    ],
    [
      "SECURITY.md",
      /Version `[0-9]+[.][0-9]+[.][0-9]+` is the latest supported published release/u,
      `Version \`${staleVersion}\` is the latest supported published release`,
    ],
    [
      "SUPPORT.md",
      /latest published Browser Recorder for Codex release is `v[0-9]+[.][0-9]+[.][0-9]+`/u,
      `latest published Browser Recorder for Codex release is \`v${staleVersion}\``,
    ],
  ]) {
    for (const replacement of ["", "$&\n$&", staleReference]) {
      const repositoryRoot = await createFixture();
      await finalizeReleaseFixture(repositoryRoot);
      await replaceText(repositoryRoot, relativePath, pattern, replacement);

      await assertOnlyFailure(
        repositoryRoot,
        "PUBLISHED_VERSION_MISMATCH",
        relativePath,
        "release",
      );
    }
  }
});

test("rejects impossible calendar dates in published changelog headings", async () => {
  const candidateRoot = await createFixture();
  await replaceText(
    candidateRoot,
    "CHANGELOG.md",
    "## [0.3.3] - 2026-07-24",
    "## [0.3.3] - 2026-02-30",
  );
  await assertOnlyFailure(
    candidateRoot,
    "PUBLISHED_CHANGELOG_INVALID",
    "CHANGELOG.md",
  );

  const releaseRoot = await createFixture();
  await finalizeReleaseFixture(releaseRoot);
  await replaceText(
    releaseRoot,
    "CHANGELOG.md",
    `## [${releaseVersion}] - 2026-07-27`,
    `## [${releaseVersion}] - 2026-02-30`,
  );
  await assertOnlyFailure(
    releaseRoot,
    "CHANGELOG_RELEASE_INCOMPLETE",
    "CHANGELOG.md",
    "release",
  );
});

test("release derives the changelog version from the manifest", async () => {
  const repositoryRoot = await createFixture();
  await syncCandidateVersionReferences(repositoryRoot, "1.0.0");
  await replaceText(
    repositoryRoot,
    "CHANGELOG.md",
    `## [${releaseVersion}] - Unreleased`,
    "## [1.0.0] - Unreleased",
  );
  await finalizeReleaseFixture(repositoryRoot, "1.0.0");

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
  await syncPublishedVersionReferences(
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
  await syncPublishedVersionReferences(repositoryRoot, releaseVersion);
  await removeCandidateReferences(repositoryRoot);

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

test("rejects eval corpora without exactly six positive and four negative cases", async () => {
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
