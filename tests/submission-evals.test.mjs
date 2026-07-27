import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  validateRecordingRequest,
} from "../plugins/codex-browser-recorder/skills/record-browser/scripts/recording-policy.mjs";

const evalPath = new URL("../evals/plugin-submission-cases.json", import.meta.url);
const expectedCaseIds = [
  "positive-basic-https",
  "positive-same-origin-navigation",
  "positive-pointer-click",
  "positive-minimum-duration",
  "positive-maximum-duration",
  "positive-authenticated-private-flow",
  "negative-user-denial",
  "negative-platform-rejection",
  "negative-credentialed-url",
  "negative-cross-origin-action",
];
const allowedNegativeOutcomes = new Set([
  "user_denied",
  "platform_rejected",
  "target_credentials_present",
  "origin_changed_during_recording",
]);
const allowedPublicHosts = new Set([
  "example.com",
  "example.org",
  "example.net",
  "www.w3.org",
]);
const canonicalSkillInvocation =
  "$codex-browser-recorder:record-browser";
const topLevelKeys = ["cases", "fixtures", "plugin", "schemaVersion"];
const caseKeys = ["expected", "id", "kind", "prompt", "setup"];
const expectedKeys = [
  "allowedFailureCodes",
  "browserActivityBeforeConsent",
  "outcome",
  "reviewerExpectation",
  "requiredSignals",
];

async function loadCases() {
  return JSON.parse(await readFile(evalPath, "utf8"));
}

function assertExactKeys(value, keys, label) {
  assert.deepEqual(
    Object.keys(value).toSorted(),
    keys.toSorted(),
    `${label} must contain exactly the documented keys`,
  );
}

function assertExactCorpusSchema(corpus) {
  assertExactKeys(corpus, topLevelKeys, "top-level schema");
  for (const item of corpus.cases) {
    assertExactKeys(item, caseKeys, `${item.id} case schema`);
    assertExactKeys(item.expected, expectedKeys, `${item.id} expected schema`);
  }
}

function stringsIn(value) {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(stringsIn);
  if (value != null && typeof value === "object") {
    return Object.values(value).flatMap(stringsIn);
  }
  return [];
}

function extractUrls(value) {
  return stringsIn(value).flatMap((source) =>
    [...source.matchAll(/https?:\/\/[^\s"'<>]+/giu)].map(([match]) =>
      match.replace(/[),.;!?]+$/u, ""),
    ),
  );
}

function normalizedUrl(url) {
  return new URL(url).href;
}

function assertAllowedEvalUrl(url, itemId) {
  const parsed = new URL(url);
  const hostname = parsed.hostname.toLowerCase();
  if (allowedPublicHosts.has(hostname)) {
    assert.equal(
      parsed.protocol,
      "https:",
      `${itemId} public fixture URLs must use HTTPS`,
    );
    return;
  }
  assert.fail(`${itemId} URL must use an approved public fixture host`);
}

function assertUrlCredentialContract(cases) {
  const credentialed = cases.find(
    ({ id }) => id === "negative-credentialed-url",
  );
  const allowedTarget = new URL(credentialed.setup.targetUrl);
  assert.notEqual(
    allowedTarget.username,
    "",
    "credentialed negative target must contain a username",
  );
  assert.equal(
    allowedTarget.password,
    "",
    "credentialed negative target must not retain a secret",
  );

  for (const item of cases) {
    const urls = [...extractUrls(item.prompt), ...extractUrls(item.setup)];
    for (const url of urls) {
      const parsed = new URL(url);
      if (parsed.username.length === 0 && parsed.password.length === 0) continue;
      assert.ok(
        item.id === credentialed.id && parsed.href === allowedTarget.href,
        "URL credentials are allowed only for the credentialed negative target",
      );
    }
  }
}

function assertCorpusUrlContract(cases) {
  assertUrlCredentialContract(cases);
  for (const item of cases) {
    const promptUrls = extractUrls(item.prompt);
    const setupUrls = extractUrls(item.setup);
    assert.ok(promptUrls.length > 0, `${item.id} prompt must declare its target URL`);
    for (const url of [...promptUrls, ...setupUrls]) {
      assertAllowedEvalUrl(url, item.id);
    }

    const targetUrl = normalizedUrl(item.setup.targetUrl);
    const promptUrlSet = new Set(promptUrls.map(normalizedUrl));
    assert.ok(
      promptUrlSet.has(targetUrl),
      `${item.id} prompt must include setup.targetUrl`,
    );

    if (item.setup.approvedOrigin != null) {
      assert.equal(
        item.setup.approvedOrigin,
        new URL(item.setup.targetUrl).origin,
        `${item.id} approvedOrigin must match setup.targetUrl`,
      );
    }

    const promptDeclaredSetup = Object.fromEntries(
      Object.entries(item.setup).filter(([key]) => key !== "approvedOrigin"),
    );
    const declaredUrlSet = new Set(
      extractUrls(promptDeclaredSetup).map(normalizedUrl),
    );
    for (const url of promptUrlSet) {
      assert.ok(
        declaredUrlSet.has(url),
        `${item.id} prompt URL must be declared in setup`,
      );
    }
  }
}

function assertPositivePolicyContract(cases) {
  const failures = [];
  for (const item of cases.filter(({ kind }) => kind === "positive")) {
    const durationMs = item.setup.durationSeconds * 1_000;
    const requirePointerEvents = item.setup.plannedActions.some((action) =>
      /click|drag|hover|scroll/u.test(action),
    );
    try {
      assert.deepEqual(
        validateRecordingRequest({
          durationMs,
          requirePointerEvents,
          targetUrl: item.setup.targetUrl,
        }),
        {
          approvedOrigin: item.setup.approvedOrigin,
          durationMs,
          recordingMode: "interactive",
          requirePointerEvents,
          targetUrl: item.setup.targetUrl,
        },
      );
    } catch (error) {
      failures.push({
        code: error?.code ?? error?.name ?? "unknown_failure",
        id: item.id,
      });
    }
  }
  assert.deepEqual(
    failures,
    [],
    "positive eval targets must satisfy the production recording policy",
  );
  assert.equal(
    cases
      .filter(({ kind }) => kind === "positive")
      .filter(({ setup }) =>
        setup.plannedActions.some((action) =>
          /click|drag|hover|scroll/u.test(action),
        ),
      ).length,
    4,
    "scroll evals must exercise the production pointer-evidence policy",
  );
}

test("defines exactly six positive and four negative submission cases", async () => {
  const corpus = await loadCases();
  assertExactCorpusSchema(corpus);
  assert.equal(corpus.schemaVersion, 1);
  assert.equal(corpus.plugin, "codex-browser-recorder");
  assert.equal(corpus.cases.filter(({ kind }) => kind === "positive").length, 6);
  assert.equal(corpus.cases.filter(({ kind }) => kind === "negative").length, 4);
  assert.equal(new Set(corpus.cases.map(({ id }) => id)).size, 10);
  assert.deepEqual(
    corpus.cases.map(({ id }) => id).toSorted(),
    expectedCaseIds.toSorted(),
  );
});

test("keeps prompt and setup URLs aligned on public test hosts", async () => {
  const { cases } = await loadCases();
  assertCorpusUrlContract(cases);
});

test("rejects private, link-local, and non-approved URL mutants", async () => {
  const corpus = await loadCases();
  for (const url of [
    "http://192.168.1.20/",
    "http://169.254.169.254/latest",
    "https://not-approved.invalid/",
  ]) {
    const mutant = structuredClone(corpus.cases);
    mutant[0].setup.plannedActions = [`inspect ${url}`];
    assert.throws(
      () => assertCorpusUrlContract(mutant),
      /approved public fixture host/,
    );
  }
});

test("rejects prompt, origin, and schema mismatch mutants", async () => {
  const corpus = await loadCases();

  const promptMutant = structuredClone(corpus.cases);
  promptMutant[0].prompt = promptMutant[0].prompt.replace(
    "https://www.w3.org/TR/pointerevents/",
    "https://example.org/guide",
  );
  assert.throws(
    () => assertCorpusUrlContract(promptMutant),
    /prompt must include setup[.]targetUrl/,
  );

  const originMutant = structuredClone(corpus.cases);
  originMutant[0].setup.approvedOrigin = "https://example.org";
  assert.throws(
    () => assertCorpusUrlContract(originMutant),
    /approvedOrigin must match setup[.]targetUrl/,
  );

  const topLevelMutant = structuredClone(corpus);
  topLevelMutant.unexpected = true;
  assert.throws(
    () => assertExactCorpusSchema(topLevelMutant),
    /top-level schema must contain exactly the documented keys/,
  );

  const expectedMutant = structuredClone(corpus);
  expectedMutant.cases[0].expected.unexpected = true;
  assert.throws(
    () => assertExactCorpusSchema(expectedMutant),
    /expected schema must contain exactly the documented keys/,
  );
});

test("validates positive targets through the production recording policy", async () => {
  const { cases } = await loadCases();
  assertPositivePolicyContract(cases);
});

test("gives reviewers one public fixture with no account or setup dependency", async () => {
  const corpus = await loadCases();
  assert.deepEqual(corpus.fixtures, {
    "w3c-pointer-events": {
      authentication: "none",
      instructions: "No setup required; open the public HTTPS page.",
      url: "https://www.w3.org/TR/pointerevents/",
    },
  });
  for (const item of corpus.cases.filter(
    ({ id, kind }) =>
      kind === "positive" && id !== "positive-authenticated-private-flow",
  )) {
    assert.equal(item.setup.fixtureId, "w3c-pointer-events");
    assert.equal(item.setup.targetUrl, corpus.fixtures[item.setup.fixtureId].url);
    assert.match(item.expected.reviewerExpectation, /Saved Recording|recording/i);
  }
  const authenticated = corpus.cases.find(
    ({ id }) => id === "positive-authenticated-private-flow",
  );
  assert.equal(authenticated.setup.fixtureId, undefined);
  assert.match(authenticated.prompt, /authenticated confidential message thread/iu);
  assert.match(
    authenticated.expected.reviewerExpectation,
    /proceed[^.]*Content Warning[^.]*authorization/iu,
  );
  for (const item of corpus.cases.filter(({ kind }) => kind === "negative")) {
    assert.match(item.expected.reviewerExpectation, /must|stop|discard|distinguish/i);
  }
});

test("rejects username credential mutants through the production policy", async () => {
  const corpus = await loadCases();
  for (const targetUrl of [
    "https://recorder@example.com/guide",
    "https://recorder:synthetic@example.com/guide",
  ]) {
    const mutant = structuredClone(corpus.cases);
    const item = mutant.find(({ id }) => id === "positive-basic-https");
    const originalTarget = item.setup.targetUrl;
    item.prompt = item.prompt.replace(originalTarget, targetUrl);
    item.setup.targetUrl = targetUrl;
    item.setup.approvedOrigin = new URL(targetUrl).origin;

    assert.throws(
      () => assertCorpusUrlContract(mutant),
      /URL credentials are allowed only for the credentialed negative target/,
    );
    assert.throws(
      () => assertPositivePolicyContract(mutant),
      /target_credentials_present/,
    );
  }
});

test("rejects same-origin navigation userinfo mutants", async () => {
  const corpus = await loadCases();
  for (const navigationTarget of [
    "https://recorder@example.com/results?view=list",
    "https://recorder:synthetic@example.com/results?view=list",
  ]) {
    const mutant = structuredClone(corpus.cases);
    const item = mutant.find(
      ({ id }) => id === "positive-same-origin-navigation",
    );
    item.prompt = item.prompt.replace(
      item.setup.navigationTarget,
      navigationTarget,
    );
    item.setup.navigationTarget = navigationTarget;
    assert.throws(
      () => assertCorpusUrlContract(mutant),
      /URL credentials are allowed only for the credentialed negative target/,
    );
  }
});

test("rejects userinfo in future nested setup URL fields", async () => {
  const corpus = await loadCases();
  const mutant = structuredClone(corpus.cases);
  const item = mutant.find(({ id }) => id === "positive-basic-https");
  item.setup.future = {
    nested: {
      callbackUrl: "https://recorder@example.com/callback",
    },
  };
  assert.throws(
    () => assertCorpusUrlContract(mutant),
    /URL credentials are allowed only for the credentialed negative target/,
  );
});

test("proves the sole credentialed negative through production policy", async () => {
  const { cases } = await loadCases();
  const credentialedCases = cases.filter(({ setup }) => {
    const target = new URL(setup.targetUrl);
    return target.username.length > 0 || target.password.length > 0;
  });
  assert.deepEqual(
    credentialedCases.map(({ id }) => id),
    ["negative-credentialed-url"],
  );

  const [credentialed] = credentialedCases;
  const credentialedTarget = new URL(credentialed.setup.targetUrl);
  assert.notEqual(credentialedTarget.username, "");
  assert.equal(credentialedTarget.password, "");
  assert.throws(
    () =>
      validateRecordingRequest({
        durationMs: credentialed.setup.durationSeconds * 1_000,
        targetUrl: credentialed.setup.targetUrl,
      }),
    (error) =>
      error.code === "target_credentials_present" &&
      error.code === credentialed.expected.outcome,
  );
});

test("keeps every eval explicit, consent-bound, and content-neutral", async () => {
  const { cases } = await loadCases();
  for (const item of cases) {
    assert.ok(
      item.prompt.startsWith(`${canonicalSkillInvocation} `),
      `${item.id} must start with the canonical skill invocation`,
    );
    assert.ok(item.prompt.length <= 512);
    assert.equal(item.expected.browserActivityBeforeConsent, false);
    assert.equal(typeof item.expected.outcome, "string");
    assert.equal(item.setup.requiresExplicitConsent, true);
    assert.equal(item.setup.approvalBypassAllowed, false);
    assert.ok(
      typeof item.setup.approvedOrigin === "string" ||
        item.setup.technicalBlockerBeforeConsent === true,
      `${item.id} must declare an approved origin or a pre-Browser Technical Blocker`,
    );
    if (item.setup.technicalBlockerBeforeConsent === true) {
      assert.deepEqual(item.expected.requiredSignals, ["technical_blocker"]);
    } else {
      assert.ok(item.expected.requiredSignals.includes("consolidated_consent"));
      assert.ok(item.expected.requiredSignals.includes("content_warning"));
    }
    assert.doesNotMatch(
      JSON.stringify(item),
      /preBrowserRefusal|pre_browser_refusal|content_category|classify (?:the|page)|redact (?:the|visible)|logged-out/iu,
    );
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
    assert.ok(allowedNegativeOutcomes.has(item.expected.outcome));
  }
  assert.deepEqual(
    cases.find(({ id }) => id === "negative-user-denial").expected.allowedFailureCodes,
    [],
  );
  assert.deepEqual(
    cases.find(({ id }) => id === "negative-platform-rejection").expected.allowedFailureCodes,
    ["cancelled"],
  );
});

test("distinguishes content-neutral authorization from platform and technical stops", async () => {
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
  assert.equal(new URL(sameOrigin.setup.navigationTarget).hash, "#intro");

  const pointerClick = byId.get("positive-pointer-click");
  assert.ok(pointerClick.setup.plannedActions.includes("click_table_of_contents_link"));

  assert.equal(byId.get("positive-minimum-duration").setup.durationSeconds, 5);
  const maximum = byId.get("positive-maximum-duration");
  assert.equal(maximum.setup.durationSeconds, 60);
  assert.equal(maximum.setup.hardLimitSeconds, 65);

  const authenticated = byId.get("positive-authenticated-private-flow");
  assert.equal(authenticated.expected.outcome, "success");
  assert.ok(authenticated.expected.requiredSignals.includes("content_warning"));
  assert.ok(authenticated.expected.requiredSignals.includes("consolidated_consent"));

  const userDenial = byId.get("negative-user-denial");
  assert.equal(userDenial.setup.userDecision, "denied");
  assert.equal(userDenial.expected.outcome, "user_denied");
  assert.deepEqual(userDenial.expected.allowedFailureCodes, []);
  assert.ok(userDenial.expected.requiredSignals.includes("no_browser_activity"));

  const platformRejection = byId.get("negative-platform-rejection");
  assert.equal(platformRejection.setup.userDecision, "authorized");
  assert.equal(platformRejection.setup.platformDecision, "rejected");
  assert.equal(platformRejection.expected.outcome, "platform_rejected");
  assert.deepEqual(platformRejection.expected.allowedFailureCodes, ["cancelled"]);
  assert.ok(platformRejection.expected.requiredSignals.includes("platform_rejection"));

  const credentialed = byId.get("negative-credentialed-url");
  assert.notEqual(new URL(credentialed.setup.targetUrl).username, "");
  assert.equal(credentialed.setup.technicalBlockerBeforeConsent, true);
  assert.equal(credentialed.expected.outcome, "target_credentials_present");
  assert.deepEqual(credentialed.expected.requiredSignals, ["technical_blocker"]);

  const crossOrigin = byId.get("negative-cross-origin-action");
  assert.notEqual(
    new URL(crossOrigin.setup.navigationTarget).origin,
    crossOrigin.setup.approvedOrigin,
  );
  assert.equal(crossOrigin.expected.outcome, "origin_changed_during_recording");
  assert.ok(crossOrigin.expected.requiredSignals.includes("media_discard"));
  assert.ok(crossOrigin.expected.requiredSignals.includes("technical_blocker"));
});
