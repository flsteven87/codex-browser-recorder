import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, relative, sep } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { resolveExecutable } from "./test-tools.mjs";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));

function findFiles(root, filename) {
  return readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name === filename)
    .map((entry) => join(entry.parentPath, entry.name));
}

test("installs from an isolated marketplace and imports only from cache", async () => {
  const codexPath = resolveExecutable("codex");
  const testRoot = mkdtempSync(
    join(tmpdir(), "codex-browser-recorder-installation-"),
  );
  const codexHome = join(testRoot, "codex-home");
  const isolatedHome = join(testRoot, "home");
  const marketplaceRoot = join(testRoot, "marketplace-source");

  mkdirSync(codexHome, { mode: 0o700 });
  mkdirSync(isolatedHome, { mode: 0o700 });
  mkdirSync(join(marketplaceRoot, ".agents", "plugins"), {
    mode: 0o700,
    recursive: true,
  });
  chmodSync(testRoot, 0o700);
  cpSync(
    join(repositoryRoot, ".agents", "plugins", "marketplace.json"),
    join(marketplaceRoot, ".agents", "plugins", "marketplace.json"),
  );
  cpSync(
    join(repositoryRoot, "plugins"),
    join(marketplaceRoot, "plugins"),
    { recursive: true },
  );

  const environment = {
    ...process.env,
    CODEX_HOME: codexHome,
    HOME: isolatedHome,
  };
  const runCodex = (arguments_) =>
    execFileSync(codexPath, arguments_, {
      encoding: "utf8",
      env: environment,
      maxBuffer: 4 * 1024 * 1024,
    });

  try {
    assert.equal(statSync(codexHome).mode & 0o777, 0o700);

    const marketplaceAdd = JSON.parse(
      runCodex([
        "plugin",
        "marketplace",
        "add",
        marketplaceRoot,
        "--json",
      ]),
    );
    assert.match(JSON.stringify(marketplaceAdd), /codex-browser-recorder/);

    const installation = JSON.parse(
      runCodex([
        "plugin",
        "add",
        "codex-browser-recorder@codex-browser-recorder",
        "--json",
      ]),
    );
    assert.match(JSON.stringify(installation), /codex-browser-recorder/);

    const listed = JSON.parse(runCodex(["plugin", "list", "--json"]));
    assert.match(JSON.stringify(listed), /codex-browser-recorder/);

    const cacheModules = findFiles(codexHome, "run-browser-recording.mjs");
    assert.equal(
      cacheModules.length,
      1,
      `expected one cached recorder, found ${cacheModules
        .map((path) => relative(codexHome, path))
        .join(", ")}`,
    );
    const cacheModule = realpathSync(cacheModules[0]);
    const canonicalCodexHome = realpathSync(codexHome);
    assert.equal(basename(cacheModule), "run-browser-recording.mjs");
    assert.ok(cacheModule.startsWith(`${canonicalCodexHome}${sep}`));

    rmSync(marketplaceRoot, { force: true, recursive: true });
    const imported = await import(pathToFileURL(cacheModule).href);
    assert.equal(typeof imported.createBrowserRecording, "function");
  } finally {
    rmSync(testRoot, { force: true, recursive: true });
  }
});
