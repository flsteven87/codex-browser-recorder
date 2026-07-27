import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { PUBLIC_TEXT_PATHS } from "../scripts/release-materials.mjs";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const canonicalSkillInvocation =
  "$codex-browser-recorder:record-browser";
const bareSkillInvocation = /\$record-browser\b/u;
const architecture = readFileSync(
  join(repositoryRoot, "docs", "architecture.md"),
  "utf8",
);
const changelog = readFileSync(join(repositoryRoot, "CHANGELOG.md"), "utf8");
const evals = readFileSync(
  join(repositoryRoot, "evals", "plugin-submission-cases.json"),
  "utf8",
);
const manifest = readFileSync(
  join(
    repositoryRoot,
    "plugins",
    "codex-browser-recorder",
    ".codex-plugin",
    "plugin.json",
  ),
  "utf8",
);
const privacy = readFileSync(join(repositoryRoot, "PRIVACY.md"), "utf8");
const readme = readFileSync(join(repositoryRoot, "README.md"), "utf8");
const support = readFileSync(join(repositoryRoot, "SUPPORT.md"), "utf8");
const terms = readFileSync(join(repositoryRoot, "TERMS.md"), "utf8");
const troubleshooting = readFileSync(
  join(repositoryRoot, "docs", "troubleshooting.md"),
  "utf8",
);
const skillRoot = join(
  repositoryRoot,
  "plugins",
  "codex-browser-recorder",
  "skills",
  "record-browser",
);
const skill = readFileSync(join(skillRoot, "SKILL.md"), "utf8");
const agent = readFileSync(join(skillRoot, "agents", "openai.yaml"), "utf8");
const publicTextSources = PUBLIC_TEXT_PATHS.map((relativePath) => [
  relativePath,
  readFileSync(join(repositoryRoot, relativePath), "utf8"),
]);
const frontmatterMatch = skill.match(/^---\n([\s\S]*?)\n---(?:\n|$)/u);
assert.ok(frontmatterMatch, "skill must have frontmatter");
const frontmatter = frontmatterMatch[1];
const workflowHeadings = [
  "## Build A Local Plan",
  "## Complete The Setup Check",
  "## Obtain One Consent",
  "## Record The Approved Plan",
  "## Report The Terminal Outcome",
];
const forbiddenReportFields = [
  "URLs",
  "page text",
  "raw frames",
  "CDP payloads",
  "FFmpeg stderr",
  "credentials",
  "internal plugin paths",
];

function assertWorkflowContract(source) {
  const indexes = workflowHeadings.map((heading) => {
    const index = source.indexOf(heading);
    assert.notEqual(index, -1, `missing workflow section: ${heading}`);
    return index;
  });
  assert.deepEqual(
    indexes,
    indexes.toSorted((left, right) => left - right),
    "workflow sections must remain ordered",
  );

  const [planIndex, setupIndex, consentIndex, recordIndex, reportIndex] =
    indexes;
  const plan = source.slice(planIndex, setupIndex);
  const setup = source.slice(setupIndex, consentIndex);
  const consent = source.slice(consentIndex, recordIndex);
  const record = source.slice(recordIndex, reportIndex);

  assert.match(plan, /prepareRecording[(][{]/u);
  assert.match(plan, /without Browser activity/iu);
  assert.match(plan, /opaque/iu);
  assert.doesNotMatch(plan, /agent[.]browsers[.]/u);
  assert.match(setup, /agent[.]browsers[.]get[(]"iab"[)]/u);
  assert.match(setup, /checkSetup[(]preparation,/u);
  assert.match(setup, /acquireBrowser/u);
  assert.match(setup, /consumes the setup preparation exactly once/iu);
  assert.doesNotMatch(setup, /browser[.]tabs[.]new|capabilities[.]get/iu);
  assert.match(consent, /before any Browser activity/iu);
  assert.match(consent, /explicit confirmation/iu);
  assert.match(record, /agent[.]browsers[.]get[(]"iab"[)]/u);
  assert.match(record, /recordApproved[(]preparation,/u);
  assert.match(record, /consumes the preparation exactly once/iu);
  assert.doesNotMatch(record, /browser[.]tabs[.]new|capabilities[.]get/iu);
}

function reportingSentencesWithoutProhibitions(source) {
  return source
    .split(/(?<=[.!?])\s+/u)
    .map((sentence) => sentence.trim())
    .filter((sentence) => !/^(?:Never|Do not)\b/iu.test(sentence))
    .join("\n");
}

function assertPrivacyReportingContract(source) {
  const reportIndex = source.indexOf("## Report The Terminal Outcome");
  assert.notEqual(reportIndex, -1, "missing terminal reporting contract");
  const report = source.slice(reportIndex);
  assert.match(
    report,
    /report only `outcome[.]failure[.]code`, `[.]summary`, and `[.]remediation`/iu,
  );
  const positiveReporting = reportingSentencesWithoutProhibitions(report);
  for (const field of forbiddenReportFields) {
    assert.match(
      report,
      new RegExp(field, "iu"),
      `reporting contract must explicitly forbid ${field}`,
    );
    assert.doesNotMatch(
      positiveReporting,
      new RegExp(field, "iu"),
      `reporting contract must not positively report ${field}`,
    );
  }
}

test("README documents the public recording contract", () => {
  for (const required of [
    canonicalSkillInvocation,
    "fresh Codex In-app Browser tab",
    "Record & Replay",
    "no audio",
    "PRIVACY.md",
    "SUPPORT.md",
    "docs/troubleshooting.md",
  ]) {
    assert.match(readme, new RegExp(required.replaceAll("$", "\\$"), "iu"));
  }
  assert.match(readme, /macOS[^.]*Codex In-app Browser/iu);
  assert.match(
    readme,
    /Passive\s+or\s+wait-only\s+recordings\s+require\s+an\s+explicit\s+duration/iu,
  );
  assert.doesNotMatch(readme, /cursor-complete/iu);
  assert.doesNotMatch(readme, /diagnostic `status[(][)]`/iu);
});

test("public product copy describes only the current product", () => {
  const currentReleaseStart = changelog.indexOf(
    "## [0.4.0] - Unreleased",
  );
  assert.notEqual(currentReleaseStart, -1);
  const currentRelease = changelog.slice(
    currentReleaseStart,
    changelog.indexOf("\n## [0.3.3]"),
  );
  const revisionNarrative =
    /\b(?:this|current|previous) release\b|\b(?:upgrade|migrate|migration)\s+(?:from|to)\s+(?:v?\d|Chrome|the previous)\b|\blegacy\s+(?:release|version|implementation|path|flow)\b|production path|Chrome is not a fallback/iu;
  assert.match("Upgrade from v0.3.3 to use this release.", revisionNarrative);
  assert.doesNotMatch("Upgrade FFmpeg to enable H.264.", revisionNarrative);
  assert.doesNotMatch(
    "A Working Recording is retained after publication failure.",
    revisionNarrative,
  );
  for (const [label, source] of [
    ["README", readme],
    ["support", support],
    ["privacy policy", privacy],
    ["terms", terms],
    ["plugin metadata", manifest],
    ["architecture", architecture],
    ["troubleshooting", troubleshooting],
    ["agent metadata", agent],
    ["current release notes", currentRelease],
  ]) {
    assert.doesNotMatch(
      source,
      revisionNarrative,
      `${label} must describe the current product instead of a revision`,
    );
  }
  for (const [label, source] of [
    ["README", readme],
    ["support", support],
    ["current release notes", currentRelease],
  ]) {
    assert.doesNotMatch(
      source,
      /\bChrome\b/u,
      `${label} must name the supported Browser without discussing alternatives`,
    );
  }
});

test("public surfaces use the canonical namespaced skill invocation", () => {
  for (const [label, source] of [
    ["README", readme],
    ["architecture", architecture],
    ["troubleshooting", troubleshooting],
    ["support", support],
    ["skill", skill],
    ["agent metadata", agent],
    ["plugin manifest", manifest],
    ["submission evals", evals],
  ]) {
    assert.match(
      source,
      new RegExp(canonicalSkillInvocation.replaceAll("$", "\\$"), "u"),
      `${label} must publish the canonical skill invocation`,
    );
    assert.doesNotMatch(
      source,
      bareSkillInvocation,
      `${label} must not publish the unresolvable bare skill invocation`,
    );
  }

  for (const [relativePath, source] of publicTextSources) {
    assert.doesNotMatch(
      source,
      bareSkillInvocation,
      `${relativePath} must not publish the unresolvable bare skill invocation`,
    );
  }

  for (const mutant of [
    "$record-browser",
    "Use $record-browser",
    "Invoke:$record-browser",
  ]) {
    assert.match(
      mutant,
      bareSkillInvocation,
      `bare invocation detector must reject: ${mutant}`,
    );
  }
});

test("public docs expose preflight and the complete visible boundary", () => {
  assert.match(readme, /Local recording preflight passed/iu);
  assert.match(
    support,
    /Codex In-app Browser[^.]*full CDP access[^.]*passed/iu,
  );
  assert.match(readme, /10 frames per second/iu);
  assert.match(readme, /720p/iu);
  assert.match(privacy, /all\s+visible embedded frames/iu);
  assert.match(privacy, /existing session state can affect rendered\s+content/iu);
  assert.match(support, /Local recording preflight passed/iu);
});

test("public policies present a content-neutral Content Warning", () => {
  for (const [label, source] of [
    ["README", readme],
    ["privacy policy", privacy],
    ["terms", terms],
  ]) {
    assert.match(source, /Content Warning/iu, `${label} must name the warning`);
    assert.match(
      source,
      /(?:complete|full)[^.]*page viewport/iu,
      `${label} must disclose the viewport boundary`,
    );
    assert.match(
      source,
      /private[^.]*authenticated[^.]*sensitive/iu,
      `${label} must disclose potentially private content`,
    );
    assert.match(source, /authoriz/iu, `${label} must assign authorization`);
    assert.match(
      source,
      /local (?:file|recording)/iu,
      `${label} must assign downstream local-file handling`,
    );
  }
  assert.match(
    privacy,
    /does not classify[^.]*redact[^.]*refuse/iu,
    "privacy policy must state the content-neutral behavior",
  );
  assert.match(
    architecture,
    /non-blocking Content Warning/iu,
    "architecture must preserve the warning as a flow invariant",
  );

  for (const [label, source] of [
    ["README", readme],
    ["privacy policy", privacy],
    ["terms", terms],
    ["support", support],
    ["troubleshooting", troubleshooting],
    ["skill", skill],
  ]) {
    assert.doesNotMatch(
      source,
      /use a logged-out|continue only with public|no audio, authenticated flows|authenticated or sensitive flows[^.]*outside|refuse[^.]*sensitive|pre[- ]Browser refusal/iu,
      `${label} must not impose a content-category refusal`,
    );
  }
  assert.match(terms, /Codex In-app Browser flow/iu);
  assert.doesNotMatch(terms, /\bselected Browser\b/iu);
});

test("publishes explicit Interactive and Unattended Recording modes", () => {
  assert.match(
    architecture,
    /Interactive Recording[^.]*default[^.]*visible/iu,
  );
  assert.match(architecture, /Unattended Recording[^.]*hidden/iu);
  assert.match(readme, /Interactive Recording[^.]*default/iu);
  assert.match(readme, /automated E2E QA[^.]*Unattended Recording/iu);
  assert.match(skill, /recordingMode[^.]*interactive[^.]*default/iu);
  assert.match(skill, /unattended[^.]*automated E2E QA/iu);
  for (const [label, source] of [
    ["README", readme],
    ["changelog", changelog],
    ["privacy policy", privacy],
    ["support", support],
    ["terms", terms],
    ["troubleshooting", troubleshooting],
    ["Marketplace skill and consent", skill],
    ["Marketplace metadata", agent],
    ["plugin manifest", manifest],
    ["submission evals", evals],
  ]) {
    assert.doesNotMatch(
      source,
      /Background Recording/iu,
      `${label} must not advertise the developer-facing invariant`,
    );
  }
});

test("public copy describes an observable cursor without provenance claims", () => {
  for (const [label, source, cursorPattern] of [
    ["README", readme, /Pointer flows?[^.]*visible cursor/iu],
    ["changelog", changelog, /visible cursor/iu],
    ["skill", skill, /pointer flows?[^.]*visible cursor/iu],
    ["agent metadata", agent, /cursor and click feedback/iu],
  ]) {
    assert.match(source, cursorPattern, `${label} must describe pointer feedback`);
    assert.doesNotMatch(
      source,
      /cursor-complete/iu,
      `${label} must not claim cursor completeness`,
    );
  }
  assert.match(privacy, /page-scripted synthetic events may also be observed/iu);
  assert.match(privacy, /does not authenticate the source of an observed event/iu);
});

test("public docs disclose failure-specific local media retention", () => {
  assert.match(
    privacy,
    /Capture,\s+cancellation,\s+cross-origin,\s+and\s+validation\s+failures\s+do\s+not\s+publish\s+a\s+Saved\s+Recording/iu,
    "privacy policy must disclose non-publication cases",
  );
  assert.match(
    privacy,
    /automatic\s+cleanup\s+fails[^.]*reports\s+the\s+local\s+path\s+for\s+deletion/iu,
    "privacy policy must disclose cleanup failure handling",
  );
  assert.match(
    privacy,
    /durable\s+publication\s+fails[^.]*Working\s+Recording\s+recovery\s+directory/iu,
    "privacy policy must disclose publication recovery",
  );
});

test("skill is explicit and keeps minimal frontmatter", () => {
  assert.match(agent, /allow_implicit_invocation: false/u);
  assert.match(
    frontmatter,
    /explicitly invokes \$codex-browser-recorder:record-browser/iu,
  );
  assert.match(frontmatter, /Codex In-app Browser/iu);
  assert.match(frontmatter, /visible cursor/iu);
  assert.deepEqual(
    frontmatter
      .split("\n")
      .map((line) => line.slice(0, line.indexOf(":")))
      .filter(Boolean),
    ["name", "description"],
  );
  assert.doesNotMatch(frontmatter, /^compatibility:/mu);
});

test("skill keeps preparation, consent, Browser activity, and reporting ordered", () => {
  assertWorkflowContract(skill);
});

test("ordering guard rejects Browser activity before local preparation", () => {
  const mutant = skill.replace(
    "## Complete The Setup Check",
    'agent.browsers.get("iab")\n\n## Complete The Setup Check',
  );
  assert.throws(
    () => assertWorkflowContract(mutant),
    /does not match|agent[.]browsers/u,
  );
});

test("skill delegates the full transaction to the deep Recording Flow", () => {
  assert.match(skill, /scripts[/]record-browser-flow[.]mjs/u);
  assert.match(skill, /pathToFileURL/u);
  assert.match(skill, /prepareRecording[(][{]/u);
  assert.match(skill, /checkSetup[(]preparation,/u);
  assert.match(skill, /recordApproved[(]preparation,/u);
  assert.match(skill, /exact opaque preparation/iu);
  assert.match(skill, /one terminal outcome/iu);
  assert.doesNotMatch(skill, /createRecording|handle[.]ready|handle[.]stop/u);
  assert.doesNotMatch(skill, /cursorEventsCaptured|cursorLastEventEpochMs/u);
  assert.doesNotMatch(skill, /Date[.]now|setTimeout|while [(]/u);
});

test("skill derives pointer policy from semantic actions", () => {
  assert.match(skill, /`pointer`, `keyboard`, or `programmatic`/u);
  assert.match(skill, /Pointer includes click, hover, drag/iu);
  assert.match(skill, /perform[(][{] tab [}][)]/u);
  assert.match(skill, /per-action pointer evidence/iu);
  assert.doesNotMatch(skill, /requirePointerEvents\s*=/u);
});

test("skill uses only the Codex In-app Browser on authorized paths", () => {
  assert.doesNotMatch(skill, /browserSurface/u);
  assert.match(skill, /agent[.]browsers[.]get[(]"iab"[)]/u);
  assert.match(
    skill,
    /do not use Chrome, `getForUrl`, `getDefault`/iu,
  );
  assert.match(skill, /Never switch to another Recording Surface/iu);
  assert.doesNotMatch(skill, /agent[.]browsers[.]get[(]"extension"[)]/u);
  assert.doesNotMatch(skill, /agent[.]browsers[.]getForUrl[(]/u);
  assert.doesNotMatch(skill, /agent[.]browsers[.]getDefault[(]/u);
  assert.equal(
    [...skill.matchAll(/agent[.]browsers[.]get[(]"iab"[)]/gu)].length,
    2,
  );
});

test("Browser selection guard rejects non-IAB acquisition mutants", () => {
  for (const acquisition of [
    "agent.browsers.getForUrl(targetUrl)",
    'agent.browsers.get("extension")',
    "agent.browsers.getDefault()",
  ]) {
    assert.throws(
      () =>
        assertWorkflowContract(
          skill.replace('agent.browsers.get("iab")', acquisition),
        ),
      /did not match|does not match/iu,
    );
  }
});

test("skill uses a non-blocking Content Warning and keeps authorization explicit", () => {
  assert.match(skill, /explicit confirmation/iu);
  assert.match(skill, /Content Warning/iu);
  assert.match(skill, /complete approved page viewport/iu);
  assert.match(skill, /private[^.]*authenticated[^.]*sensitive/iu);
  assert.match(skill, /authorized to record/iu);
  assert.match(skill, /handle the local file/iu);
  assert.match(skill, /non-blocking/iu);
  assert.match(skill, /user\s+denial[^.]*no Browser activity/iu);
  assert.match(skill, /platform rejection/iu);
  assert.match(skill, /Technical Blocker/iu);
  assert.match(skill, /never retry|do not.*retry approval/iu);
  assert.match(skill, /do not classify[^.]*redact[^.]*refuse/iu);
  assert.match(
    skill,
    /does not protect, mask, manage, or authenticate credentials/iu,
  );
  assert.doesNotMatch(
    skill,
    /logged-out|never record authenticated|refuse[^.]*content/iu,
  );
});

test("skill preserves deterministic technical boundaries", () => {
  for (const boundary of [
    "malformed",
    "URL credentials",
    "scheme",
    "approved origin",
    "duration",
    "capture",
    "encoding",
    "validation",
    "cleanup",
  ]) {
    assert.match(skill, new RegExp(boundary, "iu"));
  }
  assert.match(skill, /approved origin/iu);
  assert.match(skill, /broaden the origin/iu);
  assert.match(skill, /fresh tab/iu);
});

test("skill reports one terminal product outcome before bounded diagnostics", () => {
  assert.match(skill, /Recording completed/u);
  assert.match(skill, /duration/iu);
  assert.match(skill, /MP4 video[^.]*H[.]264/iu);
  assert.match(skill, /no audio/iu);
  assert.match(skill, /Saved video/u);
  assert.match(skill, /Open in Finder/u);
  assert.match(skill, /diagnostics/iu);
  assert.match(skill, /summary/iu);
  assert.match(skill, /remediation/iu);
  assert.match(skill, /artifactCleanupIncomplete/u);
  assert.match(skill, /resourceCleanupIncomplete/u);
  assert.match(skill, /operating-system temporary directory/iu);
  assertPrivacyReportingContract(skill);
});

test("privacy guard rejects a synthetic positive reporting directive", () => {
  const positiveReporting = `${skill}\n\nReport URLs for debugging.\n`;
  assert.throws(
    () => assertPrivacyReportingContract(positiveReporting),
    /must not positively report URLs/u,
  );
});

test("skill has no checkout, cache, or broad-capture fallback", () => {
  assert.doesNotMatch(skill, /[/]Users[/]/u);
  assert.doesNotMatch(skill, /[.]codex[/]plugins[/]cache/u);
  assert.doesNotMatch(skill, /~[/][.]codex/u);
  assert.doesNotMatch(skill, /(?:^|[/'"])[.]?[.]?[/]poc[/]/mu);
  assert.doesNotMatch(skill, /all tabs|every tab|wildcard capture/iu);
  assert.doesNotMatch(skill, /bypass (?:the )?approval/iu);
});
