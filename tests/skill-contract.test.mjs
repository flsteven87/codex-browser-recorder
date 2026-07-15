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

test("skill invocation remains explicit", () => {
  assert.match(agent, /^policy:\n(?: {2}.+\n)* {2}allow_implicit_invocation: false$/m);
  assert.match(agent, /\$record-browser/);
  assert.match(frontmatter, /^license: MIT$/m);
  assert.match(
    frontmatter,
    /^description: .*user explicitly invokes \$record-browser.*$/m,
  );
  assert.doesNotMatch(frontmatter, /^compatibility:/m);
  assert.match(
    skill,
    /Compatibility:.*Codex desktop.*macOS.*Browser.*FFmpeg.*FFprobe.*VP8.*WebM/is,
  );
  assert.match(skill, /confirm.{0,80}(?:scope|duration|output)/is);
});

test("skill reuses the installed Browser runtime and a fresh test tab", () => {
  assert.match(skill, /Browser plugin/);
  assert.match(skill, /scripts\/browser-client[.]mjs/);
  assert.match(skill, /agent[.]browsers/);
  assert.match(skill, /documentation[(][)]/);
  assert.match(skill, /fresh.{0,40}https:\/\/example[.]com\//is);
  assert.match(skill, /full-CDP approval/i);
  assert.match(skill, /Runtime[.]evaluate/);
  assert.match(skill, /exceptionDetails/);
  assert.match(skill, /do not read.{0,120}process[.]platform/is);
});

test("skill delegates fixed policy to the deterministic gate", () => {
  assert.match(skill, /pathToFileURL/);
  assert.match(skill, /scripts\/example-recording-gate[.]mjs/);
  assert.match(skill, /scripts\/doctor[.]mjs/);
  assert.match(skill, /createExampleRecording/);
  assert.match(skill, /https:\/\/example[.]com\//);
  assert.match(skill, /10[–-]15 seconds/);
  assert.doesNotMatch(skill, /Symbol[.]for/);
  assert.doesNotMatch(skill, /maxDurationMs\s*:/);
  assert.doesNotMatch(skill, /maxDecodedBytes\s*:/);
  assert.match(skill, /await handle[.]ready/);
  assert.match(skill, /handle[.]status[(][)]/);
  assert.match(skill, /handle[.]stop[(][)]/);
});

test("skill cleanup and result reporting preserve the security boundary", () => {
  assert.match(skill, /finally/);
  assert.match(skill, /close.{0,50}fresh.{0,20}tab|fresh.{0,20}tab.{0,50}close/is);
  assert.match(skill, /denial.{0,80}cancelled|denied.{0,80}cancelled/is);
  assert.match(skill, /never retry|do not retry/i);
  assert.match(skill, /audio-free VP8 WebM/i);
  assert.match(skill, /stable failure code/i);
  assert.match(skill, /raw frames/i);
  assert.match(skill, /full URLs/i);
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
