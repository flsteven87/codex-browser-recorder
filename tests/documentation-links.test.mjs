import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, normalize, resolve, sep } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  RECORDING_FAILURE_CODES,
  sanitizeRecordingFailure,
} from "../plugins/codex-browser-recorder/skills/record-browser/scripts/recording-outcome.mjs";
import { PUBLIC_MARKDOWN_PATHS } from "../scripts/release-materials.mjs";

const repositoryRoot = resolve(fileURLToPath(new URL("../", import.meta.url)));
function githubAnchors(source) {
  const anchors = new Set();
  const counts = new Map();
  for (const line of source.split("\n")) {
    const heading = line.match(/^#{1,6}\s+(.+?)\s*#*\s*$/u)?.[1];
    if (heading === undefined) continue;
    let anchor = heading
      .toLowerCase()
      .replace(/<[^>]*>/gu, "")
      .replace(/[^\p{L}\p{N}\s-]/gu, "")
      .trim()
      .replace(/\s+/gu, "-");
    const count = counts.get(anchor) ?? 0;
    counts.set(anchor, count + 1);
    if (count > 0) anchor = `${anchor}-${count}`;
    anchors.add(anchor);
  }
  return anchors;
}

function localLinks(source) {
  return [
    ...source.matchAll(
      /\[[^\]]*\]\((<[^>]+>|[^)\s]+)(?:\s+["'][^"']*["'])?\)/gu,
    ),
  ]
    .map((match) => match[1].replace(/^<|>$/gu, ""))
    .filter((target) => !/^(?:https?:|mailto:|codex:)/iu.test(target));
}

test("public Markdown links and anchors resolve inside the repository", () => {
  for (const relativePath of PUBLIC_MARKDOWN_PATHS) {
    const sourcePath = join(repositoryRoot, relativePath);
    assert.ok(existsSync(sourcePath), `${relativePath} must exist`);
    for (const target of localLinks(readFileSync(sourcePath, "utf8"))) {
      const [pathPart, fragment] = target.split("#", 2);
      const targetPath =
        pathPart.length === 0
          ? sourcePath
          : normalize(join(dirname(sourcePath), decodeURIComponent(pathPart)));
      assert.ok(
        targetPath === repositoryRoot ||
          targetPath.startsWith(`${repositoryRoot}${sep}`),
        `${relativePath} link must stay inside the repository: ${target}`,
      );
      assert.ok(
        existsSync(targetPath) && statSync(targetPath).isFile(),
        `${relativePath} link target must exist: ${target}`,
      );
      if (fragment === undefined) continue;
      assert.ok(
        githubAnchors(readFileSync(targetPath, "utf8")).has(
          decodeURIComponent(fragment).toLowerCase(),
        ),
        `${relativePath} anchor must exist: ${target}`,
      );
    }
  }
});

test("troubleshooting indexes every allowlisted public failure code", () => {
  const source = readFileSync(
    join(repositoryRoot, "docs", "troubleshooting.md"),
    "utf8",
  );
  const documentedCodes = new Set(
    [...source.matchAll(/`([a-z][a-z0-9_]+)`/gu)]
      .map((match) => match[1])
      .filter((code) => code === "cancelled" || code.includes("_")),
  );
  assert.ok(
    documentedCodes.size > 0,
    "troubleshooting must name failure codes",
  );
  for (const code of documentedCodes) {
    assert.equal(
      sanitizeRecordingFailure({ code }).code,
      code,
      `troubleshooting code must be allowlisted: ${code}`,
    );
  }
  assert.deepEqual(
    [...documentedCodes].toSorted(),
    RECORDING_FAILURE_CODES,
    "troubleshooting failure-code index must match the public allowlist",
  );
});
