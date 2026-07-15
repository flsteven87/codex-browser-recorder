# Public Release Readiness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the completed public browser-recording runtime into a locally verifiable `v0.1.0` release candidate without performing live Browser capture, changing remote GitHub settings, pushing, tagging, publishing, or submitting the plugin before those actions receive separate authorization.

**Architecture:** Keep the shipped runtime unchanged. Add a repository-only release layer: machine-readable submission evals, public listing metadata and deterministic assets, open-source community files, pinned CI checks, and one release-readiness validator with distinct candidate and final-release modes. Candidate mode accepts the existing Codex cachebuster version; release mode requires the exact canonical `0.1.0` version and is intentionally blocked until the installed-desktop two-run gate passes.

**Tech Stack:** Node.js 24 built-ins, Node test runner, JSON, GitHub Actions, SVG source assets rendered to PNG with `rsvg-convert`, Codex CLI `0.144.4`, FFmpeg/FFprobe, official Codex plugin and skill validators.

## Global Constraints

- Work directly on the user-authorized `main` branch.
- Preserve the pre-existing untracked `MEMORY.md`; do not modify, stage, or delete it.
- Keep `$record-browser` as the only public workflow and keep the shipped runtime dependency-free.
- Do not weaken consent, same-origin enforcement, failure sanitization, artifact privacy, cleanup, or media validation.
- Keep authenticated and sensitive flows out of scope.
- Exactly five positive and three negative submission eval cases must exist.
- Published manifest assets must be local files under `plugins/codex-browser-recorder/assets/`.
- Candidate mode permits `0.1.0+codex.<cachebuster>`; final release mode permits only `0.1.0`.
- Pin GitHub Actions by full commit SHA and give workflows the minimum permissions they need.
- Pin the CI Codex CLI to `@openai/codex@0.144.4`, verified on 2026-07-16 against the installed CLI and npm registry.
- Do not install or reinstall the live plugin, run Browser capture, change GitHub settings, push, tag, create a release, or open a public submission without separate explicit authorization.
- Do not retain generated WebM, partial media, result JSON, private recording directories, raw Browser diagnostics, or absolute cache paths in the repository.

---

## File Structure

### Submission evidence

- `evals/plugin-submission-cases.json` — exactly eight portal-ready, non-sensitive eval cases.
- `tests/submission-evals.test.mjs` — structural, privacy, and behavior assertions for the eval corpus.

### Public package and repository baseline

- `plugins/codex-browser-recorder/assets/source/*.svg` — deterministic source artwork.
- `plugins/codex-browser-recorder/assets/*.png` — manifest-ready icon, light/dark logos, and sanitized screenshots.
- `TERMS.md`, `SUPPORT.md`, `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `CHANGELOG.md` — public policies and community baseline.
- `.github/ISSUE_TEMPLATE/*.yml`, `.github/pull_request_template.md`, `.github/CODEOWNERS`, `.github/dependabot.yml` — contribution and maintenance controls.

### Release automation

- `scripts/validate-release-readiness.mjs` — deterministic candidate/release validator.
- `tests/release-readiness.test.mjs` — mutation-sensitive validator tests.
- `.github/workflows/ci.yml` — pinned CLI, validators, install gate, and release-candidate validation.
- `.github/workflows/codeql.yml` — minimal-permission JavaScript static analysis pinned to a full SHA.

---

### Task 1: Add The Submission Eval Contract

**Files:**
- Create: `evals/plugin-submission-cases.json`
- Create: `tests/submission-evals.test.mjs`
- Modify: `package.json`

**Interfaces:**
- Consumes: the public `$record-browser` workflow and stable failure codes documented in `SKILL.md`.
- Produces: schema version 1 with `plugin`, `cases`, five `positive` cases, three `negative` cases, and deterministic expected outcomes for the release validator.

- [ ] **Step 1: Write the failing eval-corpus test**

Create `tests/submission-evals.test.mjs` with these contract checks:

```js
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const evalPath = new URL("../evals/plugin-submission-cases.json", import.meta.url);

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
});

test("keeps every eval explicit, consent-bound, and free of sensitive flows", async () => {
  const { cases } = await loadCases();
  for (const item of cases) {
    assert.match(item.prompt, /\$record-browser/);
    assert.equal(item.expected.browserActivityBeforeConsent, false);
    assert.equal(typeof item.expected.outcome, "string");
    assert.doesNotMatch(JSON.stringify(item), /password|payment|passkey|health record/i);
  }
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
node --test tests/submission-evals.test.mjs
```

Expected: FAIL because `evals/plugin-submission-cases.json` does not exist.

- [ ] **Step 3: Add the eight submission cases**

Create `evals/plugin-submission-cases.json` with this exact top-level shape:

```json
{
  "schemaVersion": 1,
  "plugin": "codex-browser-recorder",
  "cases": []
}
```

Populate exactly these cases:

1. `positive-basic-https` — approved HTTPS page, visible scroll, default 15 seconds, success.
2. `positive-same-origin-navigation` — same-origin path and query navigation, success.
3. `positive-loopback-development` — approved `http://127.0.0.1` development page, success.
4. `positive-minimum-duration` — 5-second approved flow, success.
5. `positive-maximum-duration` — 60-second approved flow, success without changing the 65-second hard limit.
6. `negative-sensitive-flow` — asks to record an authenticated sensitive flow, refused before Browser activity.
7. `negative-credentialed-url` — URL contains credentials, returns `url_credentials_present` before Browser activity.
8. `negative-cross-origin-action` — requested action leaves the approved origin, refuses the scope before capture or returns `origin_changed_during_recording` and discards media.

Every item must contain `id`, `kind`, `prompt`, `setup`, and:

```json
{
  "expected": {
    "browserActivityBeforeConsent": false,
    "outcome": "success",
    "allowedFailureCodes": [],
    "requiredSignals": ["consolidated_consent", "private_local_output"]
  }
}
```

Use only public example or reserved test domains and loopback addresses. Do not include accounts, credentials, private hosts, or personal data.

- [ ] **Step 4: Add mutation-sensitive assertions and the npm command**

Extend the test to assert:

- positive cases require `success` and no allowed failure code;
- negative cases require at least one exact allowlisted outcome code;
- every case declares the approved origin or a pre-Browser refusal;
- cross-origin failure requires media discard;
- approval and consent are never bypassed;
- prompts stay at or below 512 characters.

Add to `package.json`:

```json
"test:submission-evals": "node --test tests/submission-evals.test.mjs"
```

- [ ] **Step 5: Verify GREEN and the full regression gate**

Run:

```bash
npm run test:submission-evals
npm run check
```

Expected: all eval tests and the complete suite PASS.

- [ ] **Step 6: Commit the submission contract**

```bash
git add evals/plugin-submission-cases.json tests/submission-evals.test.mjs package.json
git commit -m "test: define plugin submission evals"
```

---

### Task 2: Complete Public Metadata, Assets, And Community Files

**Files:**
- Modify: `plugins/codex-browser-recorder/.codex-plugin/plugin.json`
- Modify: `README.md`
- Modify: `SECURITY.md`
- Create: `TERMS.md`
- Create: `SUPPORT.md`
- Create: `CONTRIBUTING.md`
- Create: `CODE_OF_CONDUCT.md`
- Create: `CHANGELOG.md`
- Create: `.github/CODEOWNERS`
- Create: `.github/dependabot.yml`
- Create: `.github/pull_request_template.md`
- Create: `.github/ISSUE_TEMPLATE/bug_report.yml`
- Create: `.github/ISSUE_TEMPLATE/feature_request.yml`
- Create: `.github/ISSUE_TEMPLATE/config.yml`
- Create: `plugins/codex-browser-recorder/assets/source/icon.svg`
- Create: `plugins/codex-browser-recorder/assets/source/logo.svg`
- Create: `plugins/codex-browser-recorder/assets/source/logo-dark.svg`
- Create: `plugins/codex-browser-recorder/assets/source/screenshot-workflow.svg`
- Create: `plugins/codex-browser-recorder/assets/source/screenshot-result.svg`
- Create: `plugins/codex-browser-recorder/assets/*.png`
- Modify: `tests/plugin-structure.test.mjs`

**Interfaces:**
- Consumes: official manifest fields from the 2026 Codex manual and plugin validator.
- Produces: a validator-clean public listing with stable HTTPS links and deterministic sanitized raster assets.

- [ ] **Step 1: Write failing public-package assertions**

Extend `tests/plugin-structure.test.mjs` to require:

```js
assert.equal(manifest.interface.privacyPolicyURL,
  "https://github.com/flsteven87/codex-browser-recorder/blob/main/PRIVACY.md");
assert.equal(manifest.interface.termsOfServiceURL,
  "https://github.com/flsteven87/codex-browser-recorder/blob/main/TERMS.md");
assert.match(manifest.interface.brandColor, /^#[0-9A-F]{6}$/);
assert.equal(manifest.interface.defaultPrompt.length, 3);
assert.equal(manifest.interface.screenshots.length, 2);
```

Also require each referenced asset to exist inside the plugin tree, have a PNG signature, and have bounded dimensions. Require the community and GitHub files listed above and reject placeholders such as `TBD`, `TODO`, `example@example.com`, and `YOUR_NAME`.

- [ ] **Step 2: Run the structure test and verify RED**

```bash
node --test tests/plugin-structure.test.mjs
```

Expected: FAIL on missing legal links, assets, and community files.

- [ ] **Step 3: Add the public policy and community baseline**

Write concise project-specific documents:

- `TERMS.md` — experimental local recording, user consent responsibilities, sensitive-flow prohibition, no warranty, MIT license relationship, and local artifact responsibility.
- `SUPPORT.md` — public GitHub issue route for non-sensitive bugs, private vulnerability route for security, what diagnostics are safe to include, and unsupported sensitive/authenticated flows.
- `CONTRIBUTING.md` — Node 24, FFmpeg/FFprobe, TDD, checks, privacy requirements, commit/PR expectations.
- `CODE_OF_CONDUCT.md` — Contributor Covenant 2.1 text with enforcement routed to private maintainer contact through GitHub rather than an invented email.
- `CHANGELOG.md` — Keep a `[Unreleased]` section and a prepared `0.1.0` section whose date remains `Unreleased` until the final release gate.
- issue forms — redact recordings, URLs, credentials, frames, and Browser diagnostics by default.
- `.github/CODEOWNERS` — `* @flsteven87`.
- `.github/dependabot.yml` — weekly `github-actions` and `npm` checks with limits and conventional prefixes.

Update `SECURITY.md` from proof-of-concept wording to pre-release wording without claiming a supported release exists.

- [ ] **Step 4: Create deterministic brand artwork**

Create a restrained visual system using an abstract browser viewport, a circular record mark, and the wordmark “Browser Recorder”. Use:

- brand red `#E5484D`;
- ink `#111827` for light backgrounds;
- near-white `#F9FAFB` for dark backgrounds;
- no OpenAI or Codex trademark glyphs;
- no third-party browser logo;
- no user data, real URLs, page content, or desktop chrome.

Generate:

- `icon.png` — 256×256;
- `logo.png` — 1024×256, transparent/light treatment;
- `logo-dark.png` — 1024×256, transparent/dark treatment;
- `screenshot-workflow.png` — 1600×900 sanitized consent/workflow illustration;
- `screenshot-result.png` — 1600×900 sanitized successful-result illustration.

Render committed SVG sources with:

```bash
rsvg-convert --width 256 --height 256 assets/source/icon.svg --output assets/icon.png
rsvg-convert --width 1024 --height 256 assets/source/logo.svg --output assets/logo.png
rsvg-convert --width 1024 --height 256 assets/source/logo-dark.svg --output assets/logo-dark.png
rsvg-convert --width 1600 --height 900 assets/source/screenshot-workflow.svg --output assets/screenshot-workflow.png
rsvg-convert --width 1600 --height 900 assets/source/screenshot-result.svg --output assets/screenshot-result.png
```

Run from `plugins/codex-browser-recorder/`. Raster generation is mechanical; do not add a runtime dependency.

- [ ] **Step 5: Complete the published manifest**

Keep the candidate cachebuster version unchanged. Add or finalize:

```json
{
  "interface": {
    "privacyPolicyURL": "https://github.com/flsteven87/codex-browser-recorder/blob/main/PRIVACY.md",
    "termsOfServiceURL": "https://github.com/flsteven87/codex-browser-recorder/blob/main/TERMS.md",
    "brandColor": "#E5484D",
    "composerIcon": "./assets/icon.png",
    "logo": "./assets/logo.png",
    "logoDark": "./assets/logo-dark.png",
    "screenshots": [
      "./assets/screenshot-workflow.png",
      "./assets/screenshot-result.png"
    ]
  }
}
```

Use exactly three starter prompts, each at most 128 characters, covering a public HTTPS flow, a same-origin navigation flow, and a loopback development flow. Keep the descriptions explicit about one approved, non-sensitive test flow and private local WebM output.

- [ ] **Step 6: Verify assets, validators, and full tests**

```bash
node --test tests/plugin-structure.test.mjs
uv run --no-project --with pyyaml python /Users/po-chi/.codex/skills/.system/plugin-creator/scripts/validate_plugin.py plugins/codex-browser-recorder
uv run --no-project --with pyyaml python /Users/po-chi/.codex/skills/.system/skill-creator/scripts/quick_validate.py plugins/codex-browser-recorder/skills/record-browser
npm run check
git diff --check
```

Expected: every command PASS; no placeholder or missing asset remains.

- [ ] **Step 7: Commit the public package baseline**

```bash
git add .github CHANGELOG.md CODE_OF_CONDUCT.md CONTRIBUTING.md SECURITY.md SUPPORT.md TERMS.md README.md plugins/codex-browser-recorder tests/plugin-structure.test.mjs
git commit -m "docs: complete public plugin package"
```

---

### Task 3: Add Deterministic Release And CI Gates

**Files:**
- Create: `scripts/validate-release-readiness.mjs`
- Create: `tests/release-readiness.test.mjs`
- Modify: `package.json`
- Modify: `.github/workflows/ci.yml`
- Create: `.github/workflows/codeql.yml`

**Interfaces:**
- Consumes: manifest, eval corpus, community files, assets, and git metadata.
- Produces: `validateReleaseReadiness({ mode, repositoryRoot })` and CLI modes `--candidate` / `--release`.

- [ ] **Step 1: Write failing release-validator tests**

Create mutation-based fixtures in temporary directories and assert:

```js
const candidate = await validateReleaseReadiness({
  mode: "candidate",
  repositoryRoot,
});
assert.deepEqual(candidate, { status: "pass", mode: "candidate" });
```

Required negative tests:

- candidate rejects a version outside `0.1.0` or `0.1.0+codex.<token>`;
- release rejects any build metadata and accepts only `0.1.0`;
- missing privacy, terms, support, changelog, community files, evals, or assets fails with one stable code;
- eval count other than 5/3 fails;
- manifest links using `http:` fail;
- default prompts beyond three or 128 characters fail;
- placeholder text fails;
- missing full-SHA action pin fails;
- CI that skips the Codex CLI/install gate fails;
- repository recording artifacts fail.

- [ ] **Step 2: Run the release-validator test and verify RED**

```bash
node --test tests/release-readiness.test.mjs
```

Expected: FAIL because `scripts/validate-release-readiness.mjs` does not exist.

- [ ] **Step 3: Implement the release validator**

Export:

```js
export async function validateReleaseReadiness({ mode, repositoryRoot }) {}
```

The CLI must:

```text
node scripts/validate-release-readiness.mjs --candidate
node scripts/validate-release-readiness.mjs --release
```

Return non-zero on failure and print only stable codes plus repository-relative paths. Never print file contents, absolute cache paths, raw Browser diagnostics, URLs from eval prompts, or artifact contents. Candidate mode verifies all local materials while permitting the cachebuster. Release mode additionally requires exact `0.1.0`, a completed changelog entry, and no `Unreleased` release date placeholder for version `0.1.0`.

- [ ] **Step 4: Make CI install the pinned Codex CLI and run every local gate**

Update `.github/workflows/ci.yml` so the main test job:

1. checks out with the existing full SHA;
2. sets up Node 24 with the existing full SHA;
3. installs FFmpeg when unavailable;
4. installs `@openai/codex@0.144.4` unconditionally;
5. runs syntax/tests and coverage;
6. runs both official validators;
7. runs `npm run test:plugin-install` without a skip branch;
8. runs `npm run check:release-candidate`;
9. runs whitespace and artifact-residue checks.

Keep `permissions: contents: read`. Do not add write permissions, secrets, uploads, or release behavior.

- [ ] **Step 5: Add pinned CodeQL static analysis**

Create `.github/workflows/codeql.yml` for JavaScript/TypeScript with:

```yaml
permissions:
  contents: read
  security-events: write

jobs:
  analyze:
    runs-on: macos-14
    steps:
      - uses: actions/checkout@34e114876b0b11c390a56381ad16ebd13914f8d5
      - uses: github/codeql-action/init@641a925cfafe92d0fdf8b239ba4053e3f8d99d6d
        with:
          languages: javascript-typescript
      - uses: github/codeql-action/analyze@641a925cfafe92d0fdf8b239ba4053e3f8d99d6d
```

The CodeQL v3 SHA was resolved read-only from the official repository on 2026-07-16. Do not use floating tags.

- [ ] **Step 6: Add npm scripts and verify GREEN**

Add:

```json
"check:release-candidate": "node scripts/validate-release-readiness.mjs --candidate",
"check:release": "node scripts/validate-release-readiness.mjs --release"
```

Run:

```bash
node --test tests/release-readiness.test.mjs
npm run check:release-candidate
npm run check
npm run test:coverage
npm run test:plugin-install
git diff --check
```

Expected: candidate mode and all local gates PASS; release mode remains intentionally blocked while the manifest contains cachebuster metadata.

- [ ] **Step 7: Commit release automation**

```bash
git add .github/workflows package.json scripts/validate-release-readiness.mjs tests/release-readiness.test.mjs
git commit -m "ci: enforce public release readiness"
```

---

### Task 4: Run And Record The Local Release-Candidate Gate

**Files:**
- Modify: `README.md`
- Modify: `docs/superpowers/plans/2026-07-16-public-release-readiness.md`
- Test: all repository gates

**Interfaces:**
- Consumes: Tasks 1–3.
- Produces: sanitized local-candidate evidence and an exact remaining-authorization checklist.

- [ ] **Step 1: Run the complete fresh local gate**

```bash
npm run check
npm run test:coverage
npm run test:submission-evals
npm run test:plugin-install
npm run check:release-candidate
uv run --no-project --with pyyaml python /Users/po-chi/.codex/skills/.system/plugin-creator/scripts/validate_plugin.py plugins/codex-browser-recorder
uv run --no-project --with pyyaml python /Users/po-chi/.codex/skills/.system/skill-creator/scripts/quick_validate.py plugins/codex-browser-recorder/skills/record-browser
git diff --check
```

Also scan the repository for WebM, partial media, result JSON, recording temporary directories, placeholders, and unpinned GitHub Actions.

- [ ] **Step 2: Verify final release mode is correctly blocked**

```bash
npm run check:release
```

Expected: non-zero with only the stable canonical-version/changelog gate because the manifest intentionally remains a cachebuster candidate and the installed-desktop gate is not yet authorized.

- [ ] **Step 3: Review the complete implementation range**

Review from the commit immediately before Task 1 through the candidate head for:

- exact 5/3 eval counts and realistic expected behavior;
- manifest/public-copy/legal consistency;
- asset privacy and path validity;
- no unsupported manifest fields;
- CI full-SHA pins and minimal permissions;
- no false-success skip for Codex CLI/install;
- candidate/release mode separation;
- no runtime behavior regression;
- no remote or live Browser mutation.

Fix Critical and Important findings under TDD, then repeat the review until clean.

- [ ] **Step 4: Record sanitized evidence**

Append a `Local Candidate Status — 2026-07-16` table containing:

- complete test count;
- line, branch, and function coverage;
- submission eval count `5 positive / 3 negative`;
- isolated install result;
- plugin and skill validator results;
- release-candidate validator result;
- asset count and dimensions;
- repository artifact count;
- whole-range review verdict;
- exact remaining authorization gates.

Do not record absolute cache paths, raw Browser details, eval prompt contents, full target URLs, or subprocess output.

- [ ] **Step 5: Update public status copy**

State that the repository is a local `v0.1.0` release candidate only when every local gate above passes. Keep these explicit blockers:

- two sequential installed-desktop recordings from the final installed plugin tree;
- maintainer authorization for canonical version mutation and commit;
- public GitHub settings, push, tag, and release;
- OpenAI verified identity, portal access, listing review, and submission.

- [ ] **Step 6: Commit the local candidate evidence**

```bash
git add README.md docs/superpowers/plans/2026-07-16-public-release-readiness.md
git commit -m "docs: record local release candidate"
```

---

### Task 5: Controlled Installed-Desktop And External Release Gates

This task is intentionally not authorized by the unattended local-readiness request. Stop before every external or live step and obtain explicit user confirmation.

- [ ] **Step 1: Present the consolidated installed-desktop consent**

Request approval for exactly:

- target: `https://example.com/`;
- actions: repository-owned disposable clock, animation, scroll, and DOM-state changes;
- duration: 10–15 seconds per run;
- two sequential runs;
- private local temporary WebM output;
- no audio, browser chrome, other tabs, authenticated content, or sensitive data;
- normal site approval and full-CDP approval;
- deletion of both temporary output directories after evidence is recorded.

- [ ] **Step 2: After consent, update and reinstall the local plugin through the official cachebuster flow**

Use `plugin-creator/scripts/update_plugin_cachebuster.py`, read the configured marketplace name, reinstall with the Codex CLI, restart Codex if necessary, and use a fresh task. Do not edit installed cache contents.

- [ ] **Step 3: Run the repository release scenario twice sequentially**

Both runs must use the installed plugin tree and production `createRecording()` entry point. Require schema v3 success, valid VP8 WebM, no audio, bounded duration and dimensions, singleton release, fresh-tab closure or bounded cleanup instruction, and no repository artifacts.

- [ ] **Step 4: Canonicalize the release only after the desktop gate passes**

Change manifest version to exact `0.1.0`, finalize the `CHANGELOG.md` date, update any pinned installation copy, run `npm run check:release`, rerun every local gate, review, and commit:

```bash
git commit -m "chore: prepare v0.1.0 release"
```

- [ ] **Step 5: Obtain separate authorization for external release mutations**

Before any action, enumerate and obtain approval for:

- push local `main` commits;
- GitHub vulnerability reporting, Dependabot security updates, CodeQL, and branch protection settings;
- create signed or annotated `v0.1.0` tag;
- create GitHub release with matching notes;
- submit the skills-only plugin through the OpenAI portal.

No force push, destructive repository setting, public submission, or marketplace publication is implied by approval of local release readiness.
