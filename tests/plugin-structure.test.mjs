import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { extname, join, relative, resolve, sep } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const strictSemver =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const marketplacePath = join(
  repositoryRoot,
  ".agents",
  "plugins",
  "marketplace.json",
);
const pluginRoot = join(repositoryRoot, "plugins", "codex-browser-recorder");
const skillRoot = join(pluginRoot, "skills", "record-browser");
const requiredScripts = [
  "browser-recording.mjs",
  "create-recording.mjs",
  "doctor.mjs",
  "media-recorder.mjs",
  "recording-artifacts.mjs",
  "recording-outcome.mjs",
  "recording-policy.mjs",
  "validate-video.mjs",
];
const requiredPublicFiles = [
  "README.md",
  "SECURITY.md",
  "TERMS.md",
  "SUPPORT.md",
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
const requiredAssetSources = [
  "icon.svg",
  "logo.svg",
  "logo-dark.svg",
  "screenshot-workflow.svg",
  "screenshot-result.svg",
];
const expectedPngDimensions = new Map([
  ["icon.png", [256, 256]],
  ["logo.png", [1024, 256]],
  ["logo-dark.png", [1024, 256]],
  ["screenshot-workflow.png", [1600, 900]],
  ["screenshot-result.png", [1600, 900]],
]);

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function readFrontmatter(path) {
  const source = readFileSync(path, "utf8");
  const match = source.match(/^---\n([\s\S]*?)\n---(?:\n|$)/);
  assert.ok(match, `${relative(repositoryRoot, path)} must have frontmatter`);

  return Object.fromEntries(
    match[1]
      .split("\n")
      .filter((line) => line.includes(":"))
      .map((line) => {
        const separator = line.indexOf(":");
        return [line.slice(0, separator).trim(), line.slice(separator + 1).trim()];
      }),
  );
}

function walkFiles(directory) {
  return readdirSync(directory, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name));
}

function assertPngAsset(relativePath) {
  assert.match(relativePath, /^\.\/assets\/[a-z0-9-]+\.png$/);
  const assetPath = resolve(pluginRoot, relativePath);
  assert.ok(
    assetPath.startsWith(`${pluginRoot}${sep}`),
    `${relativePath} must stay inside the plugin tree`,
  );
  assert.ok(existsSync(assetPath), `${relativePath} must exist`);

  const contents = readFileSync(assetPath);
  assert.deepEqual(
    contents.subarray(0, 8),
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    `${relativePath} must have a PNG signature`,
  );
  const dimensions = [contents.readUInt32BE(16), contents.readUInt32BE(20)];
  assert.deepEqual(
    dimensions,
    expectedPngDimensions.get(relativePath.slice("./assets/".length)),
    `${relativePath} must have its bounded listing dimensions`,
  );
}

test("plugin manifest and repository marketplace stay aligned", () => {
  const marketplace = readJson(marketplacePath);
  const plugin = readJson(join(pluginRoot, ".codex-plugin", "plugin.json"));
  const entry = marketplace.plugins.find(({ name }) => name === plugin.name);

  assert.equal(plugin.name, "codex-browser-recorder");
  assert.match(plugin.version, strictSemver);
  assert.equal(
    plugin.description,
    "Record one explicitly approved Codex Browser test flow to a private local WebM file.",
  );
  assert.equal(
    plugin.interface.shortDescription,
    "Record an approved Browser test flow to local WebM.",
  );
  assert.doesNotMatch(
    JSON.stringify(plugin.interface),
    /integration gate|example[.]com/i,
  );
  assert.equal(marketplace.name, "codex-browser-recorder");
  assert.ok(entry, "marketplace must contain the plugin entry");
  assert.equal(entry.name, plugin.name);
  assert.deepEqual(entry.source, {
    source: "local",
    path: "./plugins/codex-browser-recorder",
  });
  assert.equal(entry.policy.installation, "AVAILABLE");
  assert.equal(entry.policy.authentication, "ON_INSTALL");
  assert.equal(entry.category, "Developer Tools");
});

test("public plugin metadata, listing assets, and community files are complete", () => {
  const manifest = readJson(join(pluginRoot, ".codex-plugin", "plugin.json"));

  assert.equal(
    manifest.interface.privacyPolicyURL,
    "https://github.com/flsteven87/codex-browser-recorder/blob/main/PRIVACY.md",
  );
  assert.equal(
    manifest.interface.termsOfServiceURL,
    "https://github.com/flsteven87/codex-browser-recorder/blob/main/TERMS.md",
  );
  assert.match(manifest.interface.brandColor, /^#[0-9A-F]{6}$/);
  assert.equal(manifest.interface.defaultPrompt.length, 3);
  for (const prompt of manifest.interface.defaultPrompt) {
    assert.ok(prompt.length <= 128, "starter prompts must be at most 128 characters");
  }
  assert.equal(manifest.interface.screenshots.length, 2);

  for (const relativePath of [
    manifest.interface.composerIcon,
    manifest.interface.logo,
    manifest.interface.logoDark,
    ...manifest.interface.screenshots,
  ]) {
    assertPngAsset(relativePath);
  }

  for (const source of requiredAssetSources) {
    assert.ok(
      existsSync(join(pluginRoot, "assets", "source", source)),
      `assets/source/${source} must exist`,
    );
  }

  for (const relativePath of requiredPublicFiles) {
    const publicPath = join(repositoryRoot, relativePath);
    assert.ok(existsSync(publicPath), `${relativePath} must exist`);
    assert.doesNotMatch(
      readFileSync(publicPath, "utf8"),
      /\b(?:TBD|TODO|example@example[.]com|YOUR_NAME)\b/i,
      `${relativePath} must not contain placeholders`,
    );
  }
});

test("record-browser is an explicit skill with one canonical script tree", () => {
  const frontmatter = readFrontmatter(join(skillRoot, "SKILL.md"));
  const agentManifest = readFileSync(
    join(skillRoot, "agents", "openai.yaml"),
    "utf8",
  );

  assert.equal(frontmatter.name, "record-browser");
  assert.equal(frontmatter.license, "MIT");
  assert.match(
    frontmatter.description,
    /user explicitly invokes \$record-browser/,
  );
  assert.ok(
    !("compatibility" in frontmatter),
    "compatibility must stay in the skill body for Codex validator support",
  );
  assert.match(agentManifest, /^policy:\n(?: {2}.+\n)* {2}allow_implicit_invocation: false$/m);
  assert.match(
    agentManifest,
    /short_description: "Record one approved Browser test flow to local WebM"/,
  );
  assert.match(
    agentManifest,
    /default_prompt: "Use \$record-browser to record an approved Browser test flow[.]"/,
  );
  assert.doesNotMatch(agentManifest, /integration gate|example[.]com/i);
  for (const script of requiredScripts) {
    assert.ok(existsSync(join(skillRoot, "scripts", script)), `${script} must exist`);
  }
  for (const forbidden of [
    "example-recording-gate.mjs",
    "run-browser-recording.mjs",
    "screencast-recorder.mjs",
  ]) {
    assert.equal(existsSync(join(skillRoot, "scripts", forbidden)), false);
  }
  assert.deepEqual(
    readdirSync(join(skillRoot, "scripts"))
      .filter((path) => extname(path) === ".mjs")
      .sort(),
    requiredScripts.toSorted(),
  );
  const legacyRoot = join(repositoryRoot, "poc");
  assert.ok(
    !existsSync(legacyRoot) || readdirSync(legacyRoot).length === 0,
    "legacy implementation directory must not retain files",
  );
});

test("plugin source does not fall back outside the installed plugin root", () => {
  const forbiddenReferences = [
    /(?:^|[/'"])[.]?[.]?\/poc\//,
    /[.]codex\/plugins\/cache/,
    /~\/[.]codex/,
  ];

  for (const path of walkFiles(pluginRoot)) {
    if (![".md", ".mjs", ".yaml", ".json"].includes(extname(path))) continue;
    const source = readFileSync(path, "utf8");
    for (const forbidden of forbiddenReferences) {
      assert.doesNotMatch(source, forbidden, relative(repositoryRoot, path));
    }

    if (extname(path) !== ".mjs") continue;
    for (const forbidden of [
      "createExampleRecording",
      "runBrowserPocGate",
      "EXAMPLE_PAGE_URL",
    ]) {
      assert.doesNotMatch(source, new RegExp(forbidden), relative(repositoryRoot, path));
    }
    for (const match of source.matchAll(/(?:from\s+|import\()(["'])([^"']+)\1/g)) {
      const specifier = match[2];
      if (!specifier.startsWith(".")) continue;
      const target = resolve(path, "..", specifier);
      assert.ok(
        target === pluginRoot || target.startsWith(`${pluginRoot}${sep}`),
        `${relative(repositoryRoot, path)} imports outside the plugin root`,
      );
    }
  }
});
