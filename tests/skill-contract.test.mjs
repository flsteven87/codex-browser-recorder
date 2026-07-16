import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const privacy = readFileSync(join(repositoryRoot, "PRIVACY.md"), "utf8");
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
    "scripts/recording-outcome.mjs",
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
    ["recording transaction", "handle = createRecording({"],
    ["fresh-tab ownership", "exactly one fresh blank Browser tab"],
    ["CDP activity", "full-CDP preflight"],
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

function assertOfficialBrowserSelection(source) {
  assert.match(
    source,
    /Set `requestedBrowser` to `"iab"` only when the user explicitly requests the Codex in-app Browser, to `"chrome"` only when the user explicitly requests Chrome, and to `null` otherwise[.]/,
    "skill must preserve the user's explicit Browser choice",
  );

  const setup = javascriptBlocksFor(source).find((block) =>
    block.includes("const browserPluginRoot ="),
  );
  assert.ok(setup, "missing installed Browser setup");
  assert.match(
    setup,
    /requestedBrowser === "iab"[\s\S]*globalThis[.]iab == null[\s\S]*globalThis[.]iab = await agent[.]browsers[.]get[(]"iab"[)][\s\S]*selectedBrowser = globalThis[.]iab/,
    "explicit in-app Browser requests must select the iab Browser",
  );
  assert.match(
    setup,
    /requestedBrowser === "chrome"[\s\S]*globalThis[.]chrome == null[\s\S]*globalThis[.]chrome = await agent[.]browsers[.]get[(]"extension"[)][\s\S]*selectedBrowser = globalThis[.]chrome/,
    "explicit Chrome requests must select the extension Browser",
  );
  assert.match(
    setup,
    /else[\s\S]*globalThis[.]browser == null[\s\S]*globalThis[.]browser = await agent[.]browsers[.]getForUrl[(]request[.]targetUrl[)][\s\S]*selectedBrowser = globalThis[.]browser/,
    "only unspecified Browser requests may use URL-based selection",
  );
  for (const binding of ["iab", "chrome", "browser"]) {
    assert.equal(
      indexesOf(setup, `nodeRepl.write(await ${binding}.documentation())`).length,
      1,
      `the ${binding} Browser's complete documentation must be emitted once when initialized`,
    );
  }
}

function javascriptBlocksFor(source) {
  return [...source.matchAll(/```js\n([\s\S]*?)\n```/g)].map(
    ([, block]) => block,
  );
}

function assertActionFailureBoundary(source) {
  const lifecycle = [...source.matchAll(/```js\n([\s\S]*?)\n```/g)]
    .map(([, block]) => block)
    .find(
      (block) =>
        block.includes("const sanitizeActionFailure = (error) =>") &&
        block.includes("createRecording"),
    );
  assert.ok(lifecycle, "missing approved-action failure boundary");

  const sanitizer = readBracedBlockAfter(
    lifecycle,
    "const sanitizeActionFailure = (error) =>",
  );
  assert.match(
    sanitizer.body,
    /if \(!isBrowserApprovalDenial\(error\)\)\s*{\s*return sanitizeRecordingFailure\(error\);\s*}/,
    "raw and already-sanitized action failures must cross the allowlist sanitizer",
  );
  assert.match(
    sanitizer.body,
    /const cleanup = getRecordingCleanupDetails\(error\);/,
    "action failure sanitization must read only trusted cleanup metadata",
  );
  assert.match(
    sanitizer.body,
    /sanitizeRecordingFailure\(\s*{ code: "cancelled" },\s*cleanup[?][.]cleanupIncomplete === true\s*[?]\s*{ cleanupDirectory: cleanup[.]directory }\s*:\s*undefined,?\s*\)/,
    "action-time Browser approval denial must map to cancelled without losing trusted cleanup metadata",
  );

  const recordingTryIndex = lifecycle.indexOf(
    "try {\n  await navigateFreshTab(request.targetUrl);",
  );
  const outerTry = readBracedBlockAfter(lifecycle, "try", recordingTryIndex);
  const cleanup = readBracedBlockAfter(lifecycle, "finally", outerTry.end);
  const outerCatch = lifecycle.slice(outerTry.end, cleanup.markerIndex);
  assert.match(
    outerCatch,
    /catch \(error\)\s*{\s*primaryFailure = sanitizeActionFailure\(error\);\s*throw primaryFailure;\s*}/,
    "the outer approved-action boundary must never retain or throw a raw error",
  );
  assert.doesNotMatch(
    outerCatch,
    /primaryFailure\s*=\s*error|throw\s+error/,
    "the outer approved-action boundary must not expose raw action diagnostics",
  );
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
  assert.match(
    readme,
    /fresh tab in the browser selected\s+by the installed Browser plugin/i,
  );
  assert.doesNotMatch(readme, /fresh Codex in-app Browser tab/i);
  assert.match(
    readme,
    /attempts to close the fresh tab\s+on every path[^.]*reports bounded manual cleanup instructions/i,
  );
});

test("public docs disclose failure-specific local media retention", () => {
  for (const [label, source] of [
    ["README", readme],
    ["privacy policy", privacy],
  ]) {
    assert.match(
      source,
      /Capture,\s+cancellation,\s+and\s+cross-origin\s+failures\s+discard\s+working\s+media[.]/i,
      `${label} must disclose working-media discard cases`,
    );
    assert.match(
      source,
      /A\s+result-persistence\s+failure\s+attempts\s+to\s+roll\s+back\s+the\s+entire\s+private\s+recording\s+directory[.]/i,
      `${label} must disclose attempted directory rollback`,
    );
    assert.match(
      source,
      /If\s+that\s+cleanup\s+is\s+incomplete,\s+the\s+skill\s+reports\s+the\s+local\s+directory\s+that\s+the\s+user\s+must\s+delete[.]/i,
      `${label} must disclose actionable incomplete cleanup`,
    );
    assert.match(
      source,
      /A\s+validation-rejected\s+finalized\s+WebM\s+may\s+remain\s+in\s+the\s+private\s+operating-system\s+temporary\s+directory[.]/i,
      `${label} must disclose validation-rejected media retention`,
    );
    assert.match(
      source,
      /The\s+user\s+must\s+delete\s+that\s+recording\s+directory[.]/i,
      `${label} must disclose deletion responsibility`,
    );
    assert.doesNotMatch(
      source,
      /(?:Failed or cancelled runs|Failed and cancelled recording transactions)[^.]{0,100}(?:remove|delete)[^.]{0,60}(?:finalized|video output)/i,
      `${label} must not claim blanket failed-output deletion`,
    );
  }
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
  assert.match(
    frontmatter,
    /fresh approved tab in the browser selected by the installed Browser plugin/i,
  );
  assert.match(
    skill,
    /exactly one fresh blank Browser tab/,
  );
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

  const freshTabDirective = "exactly one fresh blank Browser tab";
  const preConsentActivity = skill
    .replace(freshTabDirective, "")
    .replace(
      "## Confirm Once Before Browser Activity",
      `${freshTabDirective}\n\n## Confirm Once Before Browser Activity`,
    );
  assert.throws(
    () => assertPublicWorkflowOrdering(preConsentActivity),
    /fresh-tab ownership must occur only in the post-consent Run section/,
  );
});

test("skill validates before Browser activity and delegates recording to production code", () => {
  assert.match(skill, /pathToFileURL/);
  assert.match(skill, /scripts\/recording-policy[.]mjs/);
  assert.match(skill, /scripts\/recording-outcome[.]mjs/);
  assert.match(skill, /scripts\/create-recording[.]mjs/);
  assert.doesNotMatch(skill, /resolve\(installedSkillRoot, "scripts\/doctor[.]mjs"\)/);
  assert.match(skill, /validateRecordingRequest/);
  assert.match(skill, /createRecording/);
  assert.match(skill, /freshTab = await handle[.]ready/);
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

test("skill delegates the deterministic Browser transaction to createRecording", () => {
  const runSection = skill.slice(
    skill.indexOf("## Run The Recording"),
    skill.indexOf("## Clean Up"),
  );
  assert.match(runSection, /handle = createRecording[(][{][\s\S]*browser: selectedBrowser,/);
  assert.match(runSection, /freshTab = await handle[.]ready;/);
  assert.doesNotMatch(runSection, /browser[.]tabs[.]new[(]/);
  assert.doesNotMatch(runSection, /capabilities[.]get[(]"cdp"[)]/);
  assert.doesNotMatch(runSection, /doctor[(][{]/);
  assert.doesNotMatch(runSection, /freshTab[?]?[.]close[(]/);
});

test("skill defines the Browser binding, action guard, and result workflow", () => {
  assertOfficialBrowserSelection(skill);
  assertActionFailureBoundary(skill);
  assert.match(skill, /recordingResult[.]result[.]status === "passed"/);
  assert.match(skill, /recordingResult[.]result[.]status === "failed"/);
});

test("official Browser selection guard rejects implicit overrides", () => {
  assert.throws(
    () =>
      assertOfficialBrowserSelection(
        skill.replace('agent.browsers.get("iab")', "agent.browsers.getForUrl(request.targetUrl)"),
      ),
    /explicit in-app Browser requests must select the iab Browser/,
  );
  assert.throws(
    () =>
      assertOfficialBrowserSelection(
        skill.replace(
          'agent.browsers.get("extension")',
          "agent.browsers.getForUrl(request.targetUrl)",
        ),
      ),
    /explicit Chrome requests must select the extension Browser/,
  );
});

test("approved-action guard rejects raw errors and action-time approval denial mutants", () => {
  assert.throws(
    () =>
      assertActionFailureBoundary(
        skill.replace(
          "primaryFailure = sanitizeActionFailure(error);\n  throw primaryFailure;",
          "primaryFailure = error;\n  throw error;",
        ),
      ),
    /never retain or throw a raw error|must not expose raw action diagnostics/,
  );
  assert.throws(
    () =>
      assertActionFailureBoundary(
        skill.replace(
          "if (!isBrowserApprovalDenial(error))",
          "if (true)",
        ),
      ),
    /approval denial must map to cancelled|must cross the allowlist sanitizer/,
  );
  assert.throws(
    () =>
      assertActionFailureBoundary(
        skill.replace(
          "const cleanup = getRecordingCleanupDetails(error);",
          "const cleanup = null;",
        ),
      ),
    /trusted cleanup metadata/,
  );
});

test("skill keeps one outer-scoped handle through deterministic cleanup", () => {
  const lifecycle = javascriptBlocks.find(
    (source) => source.includes("createRecording") && source.includes("finally"),
  );
  assert.ok(lifecycle, "skill must show the complete recording lifecycle");
  const recordingTryIndex = lifecycle.indexOf(
    "try {\n  handle = createRecording({",
  );
  assert.notEqual(recordingTryIndex, -1, "missing outer recording try block");
  const outerTry = readBracedBlockAfter(lifecycle, "try", recordingTryIndex);
  const cleanup = readBracedBlockAfter(lifecycle, "finally", outerTry.end);

  assert.match(lifecycle, /let handle\s*;/);
  assert.doesNotMatch(lifecycle, /const handle\s*=/);
  assert.match(
    outerTry.body.trimStart(),
    /^handle = createRecording[(][{]/,
  );
  assert.match(
    outerTry.body,
    /handle\s*=\s*createRecording[(][\s\S]*freshTab = await handle[.]ready/,
  );
  assert.match(
    lifecycle.slice(outerTry.end, cleanup.markerIndex),
    /catch [(]error[)]\s*{\s*primaryFailure\s*=\s*sanitizeActionFailure[(]error[)];\s*throw primaryFailure;\s*}/,
  );
  assert.match(cleanup.body, /^\s*let cleanupFailure;/);
  assert.match(
    cleanup.body,
    /try\s*{\s*await handle[?][.]stop[(][)];\s*}\s*catch [(]error[)]\s*{\s*cleanupFailure [?][?]= error;\s*incompleteCleanup [?][?]= getRecordingCleanupDetails[(]error[)];\s*}/,
  );
  assert.doesNotMatch(cleanup.body, /closeFreshTab|freshTab[?]?[.]close/);
  assert.match(
    cleanup.body,
    /if [(]primaryFailure == null && cleanupFailure != null[)]\s*{\s*primaryFailure = cleanupFailure;\s*throw cleanupFailure;\s*}/,
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
  assert.match(skill, /artifactCleanupIncomplete/);
  assert.match(skill, /operating-system temporary directory/);
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
