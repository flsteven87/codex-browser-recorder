# Phase 1 Plugin Integration Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Package the proven browser screencast recorder as a self-contained, explicitly invoked Codex plugin skill and prove that an isolated Codex installation can load it from the installed cache.

**Architecture:** The repository exposes one skill-only plugin through a repository marketplace. Its scripts are the only canonical recorder implementation, and the skill composes them with the installed Browser plugin inside the Browser plugin's persistent Node.js runtime. The integration adapter returns a readiness promise, sanitized status snapshot, and idempotent stop operation; validation permits only one audio-free VP8 video stream in a WebM container.

**Tech Stack:** Node.js 24 built-ins, `node:test`, Codex Browser raw CDP capability, Codex plugin marketplace CLI, FFmpeg/FFprobe, Python plugin validators in an isolated `uv` environment.

## Global Constraints

- Work directly on the existing `main` checkout because that is the repository's recorded user preference; do not create a worktree.
- Do not start a development server, install repository runtime dependencies, or modify the user's real `~/.codex` state.
- Use the official plugin scaffold and validators. Run Python validators with transient PyYAML through `uv`; do not add PyYAML to the project.
- Keep a single canonical recorder implementation under the plugin skill. Do not retain `poc/` compatibility copies, symlinks, cache fallbacks, or repository-relative fallbacks.
- Keep invocation explicit with `policy.allow_implicit_invocation: false` in `agents/openai.yaml`.
- Keep the plugin skill-only: no bundled MCP server, app, hook, asset, Browser implementation, or audio capture.
- Preserve normal Browser site and full-CDP approval boundaries. A denial maps to `cancelled`; the workflow never retries or bypasses it.
- Use temporary private output directories outside the repository and remove partial output on cancellation or failure.
- Never expose raw frames, CDP payloads, full URLs, FFmpeg stderr, absolute plugin-cache paths, or credentials in skill-visible status.
- Do not claim the desktop integration gate passes until a user-approved fresh Codex task installs and runs the plugin. Automated isolated installation is necessary but not sufficient.

---

### Task 1: Scaffold the plugin and establish one canonical source tree

**Files:**
- Create: `.agents/plugins/marketplace.json`
- Create: `plugins/codex-browser-recorder/.codex-plugin/plugin.json`
- Create: `plugins/codex-browser-recorder/skills/record-browser/SKILL.md`
- Create: `plugins/codex-browser-recorder/skills/record-browser/agents/openai.yaml`
- Move: `poc/doctor.mjs` → `plugins/codex-browser-recorder/skills/record-browser/scripts/doctor.mjs`
- Move: `poc/run-browser-poc.mjs` → `plugins/codex-browser-recorder/skills/record-browser/scripts/run-browser-recording.mjs`
- Move: `poc/screencast-recorder.mjs` → `plugins/codex-browser-recorder/skills/record-browser/scripts/screencast-recorder.mjs`
- Move: `poc/validate-video.mjs` → `plugins/codex-browser-recorder/skills/record-browser/scripts/validate-video.mjs`
- Create: `tests/plugin-structure.test.mjs`
- Modify: `tests/browser-poc-result.test.mjs`
- Modify: `tests/doctor.test.mjs`
- Modify: `tests/screencast-recorder.test.mjs`
- Modify: `tests/validate-video.test.mjs`
- Modify: `package.json`

**Interfaces:**
- Marketplace name: `codex-browser-recorder`, chosen as a stable public repository identity rather than the collision-prone scaffold default `personal`.
- Plugin identity: `codex-browser-recorder`, strict semver version, local source `./plugins/codex-browser-recorder`.
- Skill identity: `record-browser`, explicit invocation only.
- Canonical module root: `plugins/codex-browser-recorder/skills/record-browser/scripts/`.

- [x] **Step 1: Write the failing plugin structure test**

Add `tests/plugin-structure.test.mjs` using only Node built-ins. It must parse the two JSON manifests and skill frontmatter, then assert:

```js
assert.equal(plugin.name, "codex-browser-recorder");
assert.match(plugin.version, /^\d+\.\d+\.\d+$/);
assert.equal(marketplace.name, "codex-browser-recorder");
assert.equal(entry.name, plugin.name);
assert.deepEqual(entry.source, {
  source: "local",
  path: "./plugins/codex-browser-recorder",
});
assert.equal(entry.policy.installation, "AVAILABLE");
assert.equal(entry.policy.authentication, "ON_INSTALL");
assert.equal(entry.category, "Developer Tools");
assert.equal(frontmatter.name, "record-browser");
assert.equal(agent.policy.allow_implicit_invocation, false);
```

Also assert that every required script exists, `poc/` no longer exists after migration, and no plugin source contains imports that escape the plugin root or references `poc/`, `.codex/plugins/cache`, or `~/.codex`.

- [x] **Step 2: Run the structure test and verify RED**

Run:

```bash
node --test tests/plugin-structure.test.mjs
```

Expected: FAIL because the repository marketplace and plugin do not exist.

- [x] **Step 3: Generate the official scaffold**

Run the official generator from the system skill:

```bash
python3 /Users/po-chi/.codex/skills/.system/plugin-creator/scripts/create_basic_plugin.py codex-browser-recorder \
  --path /Users/po-chi/Desktop/codex-browser-recorder/plugins \
  --marketplace-path /Users/po-chi/Desktop/codex-browser-recorder/.agents/plugins/marketplace.json \
  --marketplace-name codex-browser-recorder \
  --category "Developer Tools" \
  --with-skills \
  --with-marketplace
```

Treat generated JSON and placeholder skill files as scaffold output, then reduce them to the approved skill-only layout. Do not add speculative capabilities.

- [x] **Step 4: Move the recorder implementation and update imports**

Move the four Phase 0 modules to the skill's `scripts/` directory, rename `run-browser-poc.mjs` to `run-browser-recording.mjs`, update its local imports, and update all test imports. Delete the empty `poc/` directory. Preserve behavior in this task.

Update `package.json` so syntax checks cover the canonical scripts and tests:

```json
"check:syntax": "for file in plugins/codex-browser-recorder/skills/record-browser/scripts/*.mjs tests/*.mjs; do node --check \"$file\"; done"
```

- [x] **Step 5: Fill minimal valid plugin metadata**

Use professional English metadata, keep the plugin private-data neutral, and declare no MCP servers or apps. Set marketplace policy fields to `AVAILABLE`, `ON_INSTALL`, and the schema's developer-tools category value. Set skill frontmatter to explicit invocation only and keep the workflow body minimal until Task 4.

- [x] **Step 6: Validate the scaffold and regression suite**

Run:

```bash
node --test tests/plugin-structure.test.mjs
uv run --no-project --with pyyaml python /Users/po-chi/.codex/skills/.system/plugin-creator/scripts/validate_plugin.py plugins/codex-browser-recorder
uv run --no-project --with pyyaml python /Users/po-chi/.codex/skills/.system/skill-creator/scripts/quick_validate.py plugins/codex-browser-recorder/skills/record-browser
npm run check
git diff --check
```

Expected: all commands PASS and no test imports `poc/`.

- [x] **Step 7: Commit the canonical plugin skeleton**

```bash
git add .agents/plugins/marketplace.json plugins/codex-browser-recorder package.json tests
git commit -m "feat: scaffold browser recorder plugin"
```

### Task 2: Enforce the exact media contract

**Files:**
- Modify: `tests/validate-video.test.mjs`
- Modify: `plugins/codex-browser-recorder/skills/record-browser/scripts/validate-video.mjs`
- Modify: `plugins/codex-browser-recorder/skills/record-browser/scripts/run-browser-recording.mjs`

**Interfaces:**
- Accept exactly one `codec_type: "video"` stream with `codec_name: "vp8"`.
- Require a bounded parse of the EBML header to identify `DocType` as exactly `webm`; FFprobe's shared `matroska,webm` demuxer name is not sufficiently precise.
- Reject every `codec_type: "audio"` stream.
- Return stable codes `container_invalid`, `codec_invalid`, and `audio_stream_present` without raw probe output.

- [x] **Step 1: Create wrong-container, wrong-codec, and audio fixtures**

Extend the existing test fixture setup with FFmpeg-generated files:

```js
// Matroska container with VP8 video: valid codec, invalid exact container.
execFileSync(ffmpegPath, [/* lavfi color input */, "-c:v", "libvpx", "-f", "matroska", matroskaPath]);

// WebM-compatible VP9 video: valid container, wrong codec.
execFileSync(ffmpegPath, [/* lavfi color input */, "-c:v", "libvpx-vp9", vp9Path]);

// VP8 WebM with an Opus audio stream.
execFileSync(ffmpegPath, [/* color + anullsrc inputs */, "-c:v", "libvpx", "-c:a", "libopus", audioPath]);
```

Write tests that require the three stable failure codes.

- [x] **Step 2: Run validator tests and verify RED**

Run:

```bash
node --test tests/validate-video.test.mjs
```

Expected: FAIL because the current validator accepts codec/container/audio variants.

- [x] **Step 3: Implement strict validation in deterministic order**

After establishing exactly one video stream, validate in this order:

```js
if ((await readEbmlDocType(outputPath)) !== "webm") {
  throw new VideoValidationError("container_invalid", "Video output must use the WebM container");
}
if (video.codec_name !== "vp8") {
  throw new VideoValidationError("codec_invalid", "Video output must use the VP8 codec");
}
if (probe.streams.some((stream) => stream?.codec_type === "audio")) {
  throw new VideoValidationError("audio_stream_present", "Video output must not contain audio");
}
```

`readEbmlDocType` must read at most the first 4 KiB, validate EBML element bounds, and return no arbitrary file content. Do not infer exact WebM from FFprobe's `format_name`, because FFprobe reports the shared `matroska,webm` demuxer for both containers. Do not return probe payloads or subprocess diagnostics. Add the new codes to the recorder's known failure-code set.

- [x] **Step 4: Run focused and full tests**

Run:

```bash
node --test tests/validate-video.test.mjs tests/browser-poc-result.test.mjs
npm run check
git diff --check
```

Expected: all tests PASS.

- [x] **Step 5: Commit the strict media boundary**

```bash
git add plugins/codex-browser-recorder/skills/record-browser/scripts tests/validate-video.test.mjs
git commit -m "feat: enforce VP8 WebM output contract"
```

### Task 3: Add the Browser-runtime integration adapter

**Files:**
- Create: `tests/browser-recording-adapter.test.mjs`
- Modify: `plugins/codex-browser-recorder/skills/record-browser/scripts/run-browser-recording.mjs`

**Interfaces:**
- Export `createBrowserRecording(options)`.
- Return `{ ready, status, stop }` immediately after setup.
- `ready` resolves only after the first valid frame has reached the sink.
- `status()` returns only state and bounded capture counters.
- Repeated `stop()` calls return the same promise and finalize exactly once.
- State is one of `recording`, `stopping`, `completed`, or `failed`.

- [ ] **Step 1: Write failing adapter lifecycle tests**

Use dependency injection rather than real Browser/FFmpeg processes. Cover:

```js
test("ready resolves after the underlying session is ready", async () => {});
test("status exposes only sanitized bounded fields", async () => {});
test("stop is idempotent and finalizes once", async () => {});
test("readiness failure is retained and cleaned up", async () => {});
test("finalization failure moves status to failed", async () => {});
```

Assert deep equality for allowed status keys so paths, tab objects, CDP objects, URLs, diagnostics, and frames cannot leak accidentally.

- [ ] **Step 2: Run adapter tests and verify RED**

Run:

```bash
node --test tests/browser-recording-adapter.test.mjs
```

Expected: FAIL because `createBrowserRecording` is not exported.

- [ ] **Step 3: Implement the minimal adapter**

Allow internal test injection through an undocumented `_dependencies` option defaulting to the production functions. Memoize the exact finalization promise:

```js
let finalizationPromise;
function stop() {
  if (finalizationPromise) return finalizationPromise;
  state = startupError ? "failed" : "stopping";
  finalizationPromise = finalizeOnce().then(
    (result) => { state = result.status === "passed" ? "completed" : "failed"; return result; },
    (error) => { state = "failed"; throw error; },
  );
  return finalizationPromise;
}
```

The adapter must reuse `prepareBrowserPoc`, `startBrowserPocForTab`, and `finalizeBrowserPoc`; it must not duplicate the recorder pipeline. Its default output root is `tmpdir()`. A failed `ready` path records the primary error and ensures a later `stop()` performs cleanup.

- [ ] **Step 4: Run adapter and regression tests**

Run:

```bash
node --test tests/browser-recording-adapter.test.mjs tests/browser-poc-result.test.mjs tests/screencast-recorder.test.mjs
npm run check
git diff --check
```

Expected: all tests PASS with no leaked handles.

- [ ] **Step 5: Commit the integration adapter**

```bash
git add plugins/codex-browser-recorder/skills/record-browser/scripts/run-browser-recording.mjs tests/browser-recording-adapter.test.mjs
git commit -m "feat: add browser recording adapter"
```

### Task 4: Author the explicit, approval-aware recording skill

**Files:**
- Modify: `plugins/codex-browser-recorder/skills/record-browser/SKILL.md`
- Modify: `plugins/codex-browser-recorder/skills/record-browser/agents/openai.yaml`
- Modify: `tests/plugin-structure.test.mjs`
- Create: `tests/skill-contract.test.mjs`

**Interfaces:**
- Invoke only when the user explicitly selects `$record-browser`.
- Require the installed Browser plugin and one fresh test tab.
- Resolve scripts relative to the installed skill root, convert the absolute path with `pathToFileURL`, and import inside the Browser plugin's persistent Node.js REPL.
- Store the active handle at `globalThis[Symbol.for("codex-browser-recorder.active")]`.
- Ask for recording scope confirmation and wait for Browser site/full-CDP approval before capture.
- Always call `stop()` and close the fresh test tab in cleanup.

- [ ] **Step 1: Write failing static contract tests**

Read `SKILL.md` as text and assert that it contains the explicit workflow requirements, the global symbol, `pathToFileURL`, `ready`, `status()`, `stop()`, fresh-tab cleanup, and approval/cancellation behavior. Reject hard-coded plugin cache paths, imports from `poc/`, wildcard capture scope, retry-on-denial language, and implicit invocation.

- [ ] **Step 2: Run contract tests and verify RED**

Run:

```bash
node --test tests/plugin-structure.test.mjs tests/skill-contract.test.mjs
```

Expected: FAIL because the scaffold skill does not define the complete workflow.

- [ ] **Step 3: Write the production skill instructions**

Keep the skill concise and deterministic. Its ordered workflow must:

1. confirm macOS, FFmpeg/FFprobe, Browser plugin, output scope, and explicit consent;
2. open a fresh `https://example.com/` Browser tab for the integration gate;
3. resolve `scripts/run-browser-recording.mjs` from the installed skill directory and import it in the Browser persistent REPL;
4. reject a second active handle with `recording_already_active`;
5. create the handle, store it under the global symbol, and await `ready`;
6. report only `status()` snapshots while recording;
7. stop on completion, denial, cancellation, or error;
8. clear the global symbol and close the fresh test tab in `finally`;
9. return only the approved result contract and actionable stable failure code.

The agent metadata must describe the skill accurately without broadening invocation.

- [ ] **Step 4: Validate the skill and run all tests**

Run:

```bash
uv run --no-project --with pyyaml python /Users/po-chi/.codex/skills/.system/skill-creator/scripts/quick_validate.py plugins/codex-browser-recorder/skills/record-browser
node --test tests/plugin-structure.test.mjs tests/skill-contract.test.mjs
npm run check
git diff --check
```

Expected: all commands PASS.

- [ ] **Step 5: Commit the explicit skill workflow**

```bash
git add plugins/codex-browser-recorder/skills/record-browser tests/plugin-structure.test.mjs tests/skill-contract.test.mjs
git commit -m "feat: define explicit browser recording workflow"
```

### Task 5: Prove isolated marketplace installation and cache-only loading

**Files:**
- Create: `tests/plugin-installation.test.mjs`
- Modify: `package.json`
- Modify: `.github/workflows/ci.yml`

**Interfaces:**
- `npm run test:plugin-install` creates a unique temporary `CODEX_HOME` with mode `0700`.
- It copies the repository marketplace and plugin into an isolated fixture root, adds that fixture marketplace, and installs `codex-browser-recorder@codex-browser-recorder` with the `codex` CLI.
- It verifies the listed installation, locates the isolated cache copy, temporarily makes the source plugin unavailable, and imports the recorder only from the cache copy.
- Cleanup removes both the temporary marketplace fixture and temporary Codex home even after failure.

- [ ] **Step 1: Write the failing isolated installation test**

Use `node:child_process`, `node:fs`, `node:os`, `node:path`, and `node:url`. Every `codex` subprocess receives an environment with the temporary `CODEX_HOME`. Never inherit or resolve plugin data from the real home.

The test must fail—not skip—when explicitly selected and `codex` is unavailable. Keep it out of the default `node --test tests/*.test.mjs` glob by naming it `tests/plugin-installation.integration.mjs` instead of `.test.mjs`.

Required assertions:

```js
assert.equal(statSync(codexHome).mode & 0o777, 0o700);
assert.match(listOutput, /codex-browser-recorder/);
assert.ok(cacheModule.startsWith(realpathSync(codexHome)));
assert.equal(typeof imported.createBrowserRecording, "function");
```

- [ ] **Step 2: Run the install test and verify RED**

Run:

```bash
node --test tests/plugin-installation.integration.mjs
```

Expected: FAIL until the exact CLI/cache discovery behavior is implemented correctly.

- [ ] **Step 3: Implement deterministic isolated install helpers**

Parse `--json` output when available rather than scraping presentation text. Locate exactly one installed plugin cache root beneath the isolated home and reject ambiguity. Remove only the copied temporary source fixture after installation, import from the cache via `pathToFileURL`, and leave the repository source untouched.

Add:

```json
"test:plugin-install": "node --test tests/plugin-installation.integration.mjs"
```

Do not add this Codex-CLI-dependent test to the portable default unit-test glob. Add a CI step that runs it only when `command -v codex` succeeds; the local release gate still requires a real PASS.

- [ ] **Step 4: Run the isolated install gate and regressions**

Run:

```bash
npm run test:plugin-install
npm run check
npm run test:coverage
git diff --check
```

Update `test:coverage` so the thresholds precede the test-file arguments:

```json
"test:coverage": "node --test --experimental-test-coverage --test-coverage-lines=90 --test-coverage-branches=80 tests/*.test.mjs"
```

Expected: isolated installation PASS; unit/integration tests PASS; coverage meets thresholds. If current branch coverage legitimately misses the threshold, add focused behavioral tests rather than exclusions or lower thresholds.

- [ ] **Step 5: Commit the installation proof**

```bash
git add tests/plugin-installation.integration.mjs package.json .github/workflows/ci.yml
git commit -m "test: verify isolated plugin installation"
```

### Task 6: Document installation, architecture, security, and the remaining desktop gate

**Files:**
- Modify: `README.md`
- Modify: `docs/superpowers/specs/2026-07-15-phase-1-plugin-integration-gate-design.md`
- Modify: `docs/superpowers/plans/2026-07-15-phase-1-plugin-integration-gate.md`

**Interfaces:**
- README explains purpose, non-goals, architecture, prerequisites, repository marketplace installation, explicit invocation, output behavior, privacy/security boundaries, development commands, current gate status, and uninstall/update guidance.
- Status distinguishes automated PASS from fresh desktop task BLOCKED/PENDING.
- No documentation claims unsupported platforms, audio, browser chrome, or arbitrary background capture.

- [ ] **Step 1: Write the public README around verified behavior**

Use copy-pasteable commands with `codex plugin marketplace add` and `codex plugin add`. State that the Browser plugin remains a separate prerequisite and that recording starts only after explicit user selection and normal approvals. Link the approved design and implementation plan.

- [ ] **Step 2: Run documentation and metadata checks**

Run:

```bash
rg -n "TODO|TBD|poc/|run-browser-poc|\.codex/plugins/cache|~/.codex" README.md plugins .agents package.json tests
uv run --no-project --with pyyaml python /Users/po-chi/.codex/skills/.system/plugin-creator/scripts/validate_plugin.py plugins/codex-browser-recorder
uv run --no-project --with pyyaml python /Users/po-chi/.codex/skills/.system/skill-creator/scripts/quick_validate.py plugins/codex-browser-recorder/skills/record-browser
npm run check
npm run test:plugin-install
npm run test:coverage
git diff --check
git status --short
```

Expected: no stale implementation paths or placeholders; all validators and tests PASS; only intended files are modified.

- [ ] **Step 3: Update implementation status with exact evidence**

Mark completed checkboxes and add an evidence table for plugin validation, skill validation, unit tests, coverage, isolated install, cache-only import, and desktop fresh-task integration. Mark the desktop gate `BLOCKED — explicit user approval required` until the user authorizes modifying real Codex plugin state and starting a fresh task.

- [ ] **Step 4: Commit the public documentation and plan status**

```bash
git add README.md docs/superpowers/specs/2026-07-15-phase-1-plugin-integration-gate-design.md docs/superpowers/plans/2026-07-15-phase-1-plugin-integration-gate.md
git commit -m "docs: publish plugin integration guidance"
```

### Task 7: Execute the user-approved fresh desktop integration gate

**Files:**
- Modify: `docs/superpowers/plans/2026-07-15-phase-1-plugin-integration-gate.md`

**Interfaces:**
- Requires separate explicit approval because it changes the user's real Codex marketplace/plugin state and creates a fresh desktop task.
- Installs the repository marketplace and plugin using supported Codex commands.
- Executes `$record-browser` in a fresh task against a fresh `https://example.com/` tab.
- Produces a validated audio-free VP8 WebM outside the repository and records sanitized evidence only.

- [ ] **Step 1: Pause for explicit external-state approval**

Do not execute this task as part of automated local implementation. Ask the user to authorize both real user-level plugin installation and the fresh Codex task test.

- [ ] **Step 2: Install through the supported marketplace flow**

After approval, add this repository as marketplace `codex-browser-recorder`, install `codex-browser-recorder`, and verify Codex lists it. Do not hand-edit cache files.

- [ ] **Step 3: Run the exact fresh-task integration scenario**

Invoke `$record-browser`, accept only the expected Browser site/full-CDP approvals, animate and interact with the fresh test page, observe sanitized status, stop, and close the test tab.

- [ ] **Step 4: Validate and record sanitized evidence**

Require one VP8 video stream, WebM container, no audio streams, bounded dimensions, plausible duration, continuous frame progress, idempotent cleanup, and no repository artifacts. Record only counters, duration, media metadata, status, and stable failure codes.

- [ ] **Step 5: State the Phase 1 decision**

Mark **Go** only if both automated and fresh desktop gates pass. Mark **No-Go** for a reproducible architectural failure. Mark **Blocked** when approval, policy, capability, or environment prevents execution.

- [ ] **Step 6: Commit final gate evidence**

```bash
git add docs/superpowers/plans/2026-07-15-phase-1-plugin-integration-gate.md
git commit -m "docs: record phase 1 integration result"
```
