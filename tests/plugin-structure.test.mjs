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
  "doctor.mjs",
  "run-browser-recording.mjs",
  "screencast-recorder.mjs",
  "validate-video.mjs",
];

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

test("plugin manifest and repository marketplace stay aligned", () => {
  const marketplace = readJson(marketplacePath);
  const plugin = readJson(join(pluginRoot, ".codex-plugin", "plugin.json"));
  const entry = marketplace.plugins.find(({ name }) => name === plugin.name);

  assert.equal(plugin.name, "codex-browser-recorder");
  assert.match(plugin.version, strictSemver);
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

test("record-browser is an explicit skill with one canonical script tree", () => {
  const frontmatter = readFrontmatter(join(skillRoot, "SKILL.md"));
  const agentManifest = readFileSync(
    join(skillRoot, "agents", "openai.yaml"),
    "utf8",
  );

  assert.equal(frontmatter.name, "record-browser");
  assert.match(agentManifest, /^policy:\n(?: {2}.+\n)* {2}allow_implicit_invocation: false$/m);
  for (const script of requiredScripts) {
    assert.ok(existsSync(join(skillRoot, "scripts", script)), `${script} must exist`);
  }
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
