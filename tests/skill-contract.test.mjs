import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const readme = readFileSync(join(repositoryRoot, "README.md"), "utf8");
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
const publicWorkflowSections = [
  "## Collect The Request",
  "## Validate The Request Locally",
  "## Confirm Once Before Browser Activity",
  "## Resolve Installed Modules",
  "## Run The Recording",
  "## Clean Up",
  "## Report The Result",
];
const forbiddenReportFields = [
  "full URLs",
  "page text",
  "raw frames",
  "CDP payloads",
  "FFmpeg stderr",
  "credentials",
  "internal plugin paths",
];

function indexesOf(source, marker) {
  const indexes = [];
  let index = source.indexOf(marker);
  while (index !== -1) {
    indexes.push(index);
    index = source.indexOf(marker, index + marker.length);
  }
  return indexes;
}

function assertPublicWorkflowOrdering(source) {
  const sectionIndexes = publicWorkflowSections.map((heading) => {
    const index = source.indexOf(heading);
    assert.notEqual(index, -1, `missing public workflow section: ${heading}`);
    return index;
  });
  assert.deepEqual(
    sectionIndexes,
    sectionIndexes.toSorted((left, right) => left - right),
    "public workflow sections must remain in their required order",
  );

  const validationIndex = sectionIndexes[1];
  const consentIndex = sectionIndexes[2];
  const runIndex = sectionIndexes[4];
  const cleanupIndex = sectionIndexes[5];
  for (const marker of [
    "scripts/recording-policy.mjs",
    "scripts/recording-artifacts.mjs",
    "validateRecordingRequest",
    "describeRecordingFailure(error.code)",
  ]) {
    const markerIndexes = indexesOf(source, marker);
    assert.ok(markerIndexes.length > 0, `missing local instruction: ${marker}`);
    assert.ok(
      markerIndexes.every(
        (index) => index >= validationIndex && index < consentIndex,
      ),
      `${marker} must run locally before consent`,
    );
  }

  const runSection = source.slice(runIndex, cleanupIndex);
  for (const [label, marker] of [
    ["fresh-tab creation", "Create one fresh blank Browser tab"],
    ["fresh-tab navigation", "navigateFreshTab(request.targetUrl)"],
    ["CDP activity", "full-CDP approval"],
  ]) {
    const markerIndexes = indexesOf(source, marker);
    assert.ok(markerIndexes.length > 0, `missing ${label} instruction`);
    assert.ok(
      markerIndexes.every(
        (index) => index >= runIndex && index < cleanupIndex,
      ),
      `${label} must occur only in the post-consent Run section`,
    );
    assert.ok(runSection.includes(marker));
  }
}

function reportingSentencesWithoutProhibitions(source) {
  return source
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => !/^(?:Never|Do not)\b/i.test(sentence))
    .join("\n");
}

function assertPrivacyReportingContract(source) {
  const reportIndex = source.indexOf("## Report The Result");
  assert.notEqual(reportIndex, -1, "missing final reporting contract");
  const reportSection = source.slice(reportIndex);
  assert.match(
    reportSection,
    /On failure, report the stable failure code plus its allowlisted summary and remediation[.]/,
  );

  const positiveReporting = reportingSentencesWithoutProhibitions(reportSection);
  for (const field of forbiddenReportFields) {
    assert.match(
      reportSection,
      new RegExp(field, "i"),
      `reporting contract must explicitly forbid ${field}`,
    );
    assert.doesNotMatch(
      positiveReporting,
      new RegExp(field, "i"),
      `reporting contract must not positively report ${field}`,
    );
  }
}

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

test("README documents the public recording contract", () => {
  for (const required of [
    "$record-browser",
    "same-origin",
    "cross-origin",
    "Record & Replay",
    "temporary",
    "no audio",
  ]) {
    assert.match(readme, new RegExp(required.replaceAll("$", "\\$"), "i"));
  }
  assert.doesNotMatch(
    readme,
    /(?:run|invoke|use|start)[^\n.]{0,80}integration gate/i,
  );
});

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

test("skill keeps local validation, consent, and Browser activity in exact order", () => {
  assertPublicWorkflowOrdering(skill);
});

test("workflow ordering guard rejects reordered and pre-consent activity mutants", () => {
  const reordered = skill
    .replace("## Validate The Request Locally", "## TEMP")
    .replace(
      "## Confirm Once Before Browser Activity",
      "## Validate The Request Locally",
    )
    .replace("## TEMP", "## Confirm Once Before Browser Activity");
  assert.throws(
    () => assertPublicWorkflowOrdering(reordered),
    /public workflow sections must remain in their required order/,
  );

  const freshTabDirective = "Create one fresh blank Browser tab";
  const preConsentActivity = skill
    .replace(freshTabDirective, "")
    .replace(
      "## Confirm Once Before Browser Activity",
      `${freshTabDirective}\n\n## Confirm Once Before Browser Activity`,
    );
  assert.throws(
    () => assertPublicWorkflowOrdering(preConsentActivity),
    /fresh-tab creation must occur only in the post-consent Run section/,
  );
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
  assertPrivacyReportingContract(skill);
});

test("privacy guard rejects a synthetic positive reporting directive", () => {
  const positiveReporting = `${skill}\n\nReport full URLs for debugging.\n`;
  assert.throws(
    () => assertPrivacyReportingContract(positiveReporting),
    /must not positively report full URLs/,
  );
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
