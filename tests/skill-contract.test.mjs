import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const skillRoot = join(
  repositoryRoot,
  "plugins",
  "codex-browser-recorder",
  "skills",
  "record-browser",
);
const skill = readFileSync(join(skillRoot, "SKILL.md"), "utf8");
const agent = readFileSync(join(skillRoot, "agents", "openai.yaml"), "utf8");
const frontmatterMatch = skill.match(/^---\n([\s\S]*?)\n---(?:\n|$)/);
assert.ok(frontmatterMatch, "skill must have frontmatter");
const frontmatter = frontmatterMatch[1];
const javascriptBlocks = [...skill.matchAll(/```js\n([\s\S]*?)\n```/g)].map(
  ([, source]) => source,
);

function readBracedBlockAfter(source, marker, fromIndex = 0) {
  const markerIndex = source.indexOf(marker, fromIndex);
  assert.notEqual(markerIndex, -1, `missing ${marker} block`);
  const start = source.indexOf("{", markerIndex + marker.length);
  assert.notEqual(start, -1, `missing opening brace after ${marker}`);

  let depth = 0;
  for (let index = start; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] !== "}") continue;
    depth -= 1;
    if (depth === 0) {
      return {
        body: source.slice(start + 1, index),
        end: index + 1,
        markerIndex,
        start,
      };
    }
  }

  assert.fail(`missing closing brace for ${marker} block`);
}

test("skill requires explicit user recording intent and one consolidated consent", () => {
  assert.match(agent, /allow_implicit_invocation: false/);
  assert.match(frontmatter, /explicitly invokes \$record-browser/);
  assert.match(skill, /target URL/i);
  assert.match(skill, /planned Browser actions/i);
  assert.match(skill, /recording duration/i);
  assert.match(skill, /one consolidated consent/i);
  assert.match(skill, /before any Browser action/i);
  assert.match(frontmatter, /^license: MIT$/m);
  assert.doesNotMatch(frontmatter, /^compatibility:/m);
});

test("skill validates before Browser activity and delegates recording to production code", () => {
  assert.match(skill, /pathToFileURL/);
  assert.match(skill, /scripts\/recording-policy[.]mjs/);
  assert.match(skill, /scripts\/recording-artifacts[.]mjs/);
  assert.match(skill, /scripts\/create-recording[.]mjs/);
  assert.match(skill, /scripts\/doctor[.]mjs/);
  assert.match(skill, /validateRecordingRequest/);
  assert.match(skill, /createRecording/);
  assert.match(skill, /await handle[.]ready/);
  assert.match(skill, /handle[.]status[(][)]/);
  assert.match(skill, /handle[.]stop[(][)]/);
  assert.match(skill, /stop performing Browser actions/i);
  assert.doesNotMatch(skill, /example[.]com|integration gate|createExampleRecording/i);
  assert.match(skill, /Do not inject clocks, animations, test text/i);
  assert.doesNotMatch(
    skill,
    /(?:add|receive).{0,60}(?:disposable clock|CSS animation|DOM state change)/i,
  );
});

test("skill keeps one outer-scoped handle through deterministic cleanup", () => {
  const lifecycle = javascriptBlocks.find(
    (source) => source.includes("createRecording") && source.includes("finally"),
  );
  assert.ok(lifecycle, "skill must show the complete recording lifecycle");
  const outerTry = readBracedBlockAfter(lifecycle, "try");
  const cleanup = readBracedBlockAfter(lifecycle, "finally", outerTry.end);

  assert.match(lifecycle, /let handle\s*;/);
  assert.doesNotMatch(lifecycle, /const handle\s*=/);
  assert.match(
    outerTry.body.trimStart(),
    /^await navigateFreshTab[(]request[.]targetUrl[)];/,
  );
  assert.match(
    outerTry.body,
    /handle\s*=\s*createRecording[(][\s\S]*await handle[.]ready/,
  );
  assert.match(
    lifecycle.slice(outerTry.end, cleanup.markerIndex),
    /catch [(]error[)]\s*{\s*primaryFailure\s*=\s*error;\s*throw error;\s*}/,
  );
  assert.match(cleanup.body, /^\s*let cleanupFailure;/);
  assert.match(
    cleanup.body,
    /try\s*{\s*await handle[?][.]stop[(][)];\s*}\s*catch [(]error[)]\s*{\s*cleanupFailure [?][?]= error;\s*}/,
  );
  assert.match(
    cleanup.body,
    /try\s*{\s*await closeFreshTab[(][)];\s*}\s*catch [(]error[)]\s*{\s*cleanupFailure [?][?]= error;\s*}/,
  );
  assert.ok(
    cleanup.body.indexOf("await handle?.stop()") <
      cleanup.body.indexOf("await closeFreshTab()"),
    "skill must attempt recorder cleanup before closing the fresh tab",
  );
  assert.match(
    cleanup.body,
    /if [(]primaryFailure == null && cleanupFailure != null[)]\s*{\s*throw cleanupFailure;\s*}/,
  );
});

test("skill enforces cancellation, sensitive-flow, and same-origin boundaries", () => {
  assert.match(skill, /denial.{0,80}cancelled|denied.{0,80}cancelled/is);
  assert.match(skill, /never retry|do not retry/i);
  assert.match(skill, /credentials/);
  assert.match(skill, /payment data/);
  assert.match(skill, /passkeys/);
  assert.match(skill, /recovery secrets/);
  assert.match(skill, /health data/);
  assert.match(skill, /confidential communications/);
  assert.match(skill, /approved origin/);
  assert.match(skill, /broaden the origin/i);
  assert.match(skill, /one fresh blank Browser tab/i);
});

test("skill reports product results before bounded diagnostics", () => {
  assert.match(skill, /Recording completed/);
  assert.match(skill, /duration/i);
  assert.match(skill, /VP8 WebM/i);
  assert.match(skill, /no audio/i);
  assert.match(skill, /saved locally/i);
  assert.match(skill, /diagnostics/i);
  assert.match(skill, /summary/i);
  assert.match(skill, /remediation/i);
});

test("skill has no source-checkout or hard-coded cache fallback", () => {
  assert.doesNotMatch(skill, /\/Users\//);
  assert.doesNotMatch(skill, /[.]codex\/plugins\/cache/);
  assert.doesNotMatch(skill, /~\/[.]codex/);
  assert.doesNotMatch(skill, /(?:^|[/'"])[.]?[.]?\/poc\//m);
  assert.doesNotMatch(skill, /all tabs|every tab|wildcard capture/i);
  assert.doesNotMatch(
    skill,
    /(?:may|can|should) (?:retry (?:a )?denied|bypass (?:the )?approval)/i,
  );
});
