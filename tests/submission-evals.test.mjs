import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const evalPath = new URL("../evals/plugin-submission-cases.json", import.meta.url);
const expectedCaseIds = [
  "positive-basic-https",
  "positive-same-origin-navigation",
  "positive-loopback-development",
  "positive-minimum-duration",
  "positive-maximum-duration",
  "negative-sensitive-flow",
  "negative-credentialed-url",
  "negative-cross-origin-action",
];
const allowedNegativeOutcomes = new Set([
  "cancelled",
  "target_credentials_present",
  "origin_changed_during_recording",
]);

async function loadCases() {
  return JSON.parse(await readFile(evalPath, "utf8"));
}

test("defines exactly five positive and three negative submission cases", async () => {
  const corpus = await loadCases();
  assert.equal(corpus.schemaVersion, 1);
  assert.equal(corpus.plugin, "codex-browser-recorder");
  assert.equal(corpus.cases.filter(({ kind }) => kind === "positive").length, 5);
  assert.equal(corpus.cases.filter(({ kind }) => kind === "negative").length, 3);
  assert.equal(new Set(corpus.cases.map(({ id }) => id)).size, 8);
  assert.deepEqual(
    corpus.cases.map(({ id }) => id).toSorted(),
    expectedCaseIds.toSorted(),
  );
});

test("keeps every eval explicit, consent-bound, and free of sensitive flows", async () => {
  const { cases } = await loadCases();
  for (const item of cases) {
    assert.match(item.prompt, /\$record-browser/);
    assert.ok(item.prompt.length <= 512);
    assert.equal(item.expected.browserActivityBeforeConsent, false);
    assert.equal(typeof item.expected.outcome, "string");
    assert.equal(item.setup.requiresExplicitConsent, true);
    assert.equal(item.setup.approvalBypassAllowed, false);
    assert.ok(
      typeof item.setup.approvedOrigin === "string" ||
        item.setup.preBrowserRefusal === true,
      `${item.id} must declare an approved origin or a pre-Browser refusal`,
    );
    assert.ok(item.expected.requiredSignals.includes("consolidated_consent"));
    assert.ok(item.expected.requiredSignals.includes("private_local_output"));
    assert.doesNotMatch(JSON.stringify(item), /password|payment|passkey|health record/i);
  }
});

test("keeps positive outcomes deterministic and failure-free", async () => {
  const { cases } = await loadCases();
  for (const item of cases.filter(({ kind }) => kind === "positive")) {
    assert.equal(item.expected.outcome, "success");
    assert.deepEqual(item.expected.allowedFailureCodes, []);
  }
});

test("uses only exact allowlisted outcomes for negative cases", async () => {
  const { cases } = await loadCases();
  for (const item of cases.filter(({ kind }) => kind === "negative")) {
    assert.ok(item.expected.allowedFailureCodes.length > 0);
    assert.ok(allowedNegativeOutcomes.has(item.expected.outcome));
    assert.deepEqual(item.expected.allowedFailureCodes, [item.expected.outcome]);
  }
});

test("covers the requested duration, navigation, and refusal boundaries", async () => {
  const { cases } = await loadCases();
  const byId = new Map(cases.map((item) => [item.id, item]));

  const basic = byId.get("positive-basic-https");
  assert.equal(basic.setup.durationSeconds, 15);
  assert.equal(basic.setup.usesDefaultDuration, true);
  assert.ok(basic.setup.plannedActions.includes("scroll_visible_page"));

  const sameOrigin = byId.get("positive-same-origin-navigation");
  assert.equal(
    new URL(sameOrigin.setup.navigationTarget).origin,
    sameOrigin.setup.approvedOrigin,
  );
  assert.match(new URL(sameOrigin.setup.navigationTarget).search, /view=/);

  const loopback = byId.get("positive-loopback-development");
  assert.equal(new URL(loopback.setup.targetUrl).hostname, "127.0.0.1");
  assert.equal(new URL(loopback.setup.targetUrl).protocol, "http:");

  assert.equal(byId.get("positive-minimum-duration").setup.durationSeconds, 5);
  const maximum = byId.get("positive-maximum-duration");
  assert.equal(maximum.setup.durationSeconds, 60);
  assert.equal(maximum.setup.hardLimitSeconds, 65);

  const sensitive = byId.get("negative-sensitive-flow");
  assert.equal(sensitive.setup.preBrowserRefusal, true);
  assert.equal(sensitive.expected.outcome, "cancelled");

  const credentialed = byId.get("negative-credentialed-url");
  assert.notEqual(new URL(credentialed.setup.targetUrl).username, "");
  assert.equal(credentialed.setup.preBrowserRefusal, true);
  assert.equal(credentialed.expected.outcome, "target_credentials_present");

  const crossOrigin = byId.get("negative-cross-origin-action");
  assert.notEqual(
    new URL(crossOrigin.setup.navigationTarget).origin,
    crossOrigin.setup.approvedOrigin,
  );
  assert.equal(crossOrigin.expected.outcome, "origin_changed_during_recording");
  assert.ok(crossOrigin.expected.requiredSignals.includes("media_discard"));
});
