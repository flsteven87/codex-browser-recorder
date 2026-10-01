# Maintenance review — 2026-10-01

Scope: Codex Browser Recorder `v0.4.0` (`main` = `94cb4c3`), live in the OpenAI
Plugin Directory as
[`plugins_6a58f693814c8191b576ffaed4af2e78`](https://chatgpt.com/plugins/plugins_6a58f693814c8191b576ffaed4af2e78).
This review changed no product code, tracker item, release, or dashboard.

**Status (2026-10-01, after the review):**
- Action 2 has landed as the `0.4.1` release candidate in
  [#75](https://github.com/flsteven87/codex-browser-recorder/pull/75).
- `interface.supportURL` was left out, because the pinned official plugin
  validator in CI rejects it.
- Tagging and the directory upload still wait on the real Browser qualification
  (§2.4).

## Recommendation

Keep the plugin alive in **compatibility-only mode**: ship one small `v0.4.1`
that makes the listed plugin work on today's ChatGPT desktop. Do not build a
`v0.5` yet. As a sample of whether a directory listing brings users, the plugin
only counts if a directory user's first run works. Today that first run probably
fails, for two reasons found in this review:

1. The skill's browser bootstrap code no longer matches the host runtime shipped
   in ChatGPT desktop 26.917 (§2.1).
2. One of the three starter prompts shown on the listing fails by design (§2.2).

Decide on `v0.5` on **2026-12-31** from directory install numbers (§5), not
before.

### First three actions

1. **Owner runs the 10-minute check on ChatGPT desktop 26.917** (§2.4). It
   either confirms the bootstrap break or clears it. Either way it records the
   first real-runtime evidence since the July qualification on 26.721.
2. **Ship `v0.4.1` as a compatibility patch.** It contains only these changes:
   - Replace the skill's bootstrap with the host-documented pattern (§2.1).
   - Replace starter prompt 3 with the same-site W3C prompt already used in
     the README and evals (§2.2).
   - Cut `shortDescription` to 30 characters or fewer (§1).
   - Add `interface.supportURL` (§1).
   - Correct the setup wording and the "Codex desktop" wording (§4).

   Qualify it with the existing release harness on 26.917, then upload it at
   `platform.openai.com/plugins` using **Upload plugin to make changes**.
3. **Unblock routine upkeep and record a usage baseline.**
   - Loosen the release validator's hard-coded `setup-uv` SHA so Dependabot can
     merge (§4.3).
   - Close issue #39 with a pointer to PR #69.
   - Write down the directory install and usage numbers from
     `platform.openai.com/plugins` today, so 2026-12-31 has a baseline.

### Worth doing, in priority order

| # | Item | Why | Cost |
|---|---|---|---|
| 1 | Owner check on 26.917 (§2.4) | Only way to observe the listed product working. | 10 min, owner |
| 2 | Bootstrap fix (§2.1) | The likely first-run failure for every directory user. | Small; skill text plus a contract test |
| 3 | Starter prompt 3 (§2.2) | A listed one-click example fails by design. | One line plus an eval |
| 4 | `shortDescription` ≤30 characters, add `supportURL` (§1) | Makes the source match what the directory shows and meets the support-contact guideline. | Trivial |
| 5 | Setup-check honesty (§2.3) | "Preflight passed" can be followed by a CDP approval prompt or failure. | Wording only, unless the owner check shows a timeout |
| 6 | User-facing "Codex desktop" wording (§4.1) | The setup instructions point at a product name that no longer exists. | Docs only |
| 7 | Unblock Dependabot, close #39 (§4.3) | Keeps CI green and the tracker honest. | Small |

### Not worth doing now

- **All four Deferred Work refactors (§3).** None of them changes the user's
  result, and each touches the CDP-coupled code that only a manual desktop run
  can verify.
- **Moving to the root `plugin.json` (Agent Plugins) format.** The current
  format remains a supported fallback (§1).
- **Copying OpenAI's normalized icon layout** into the repository (§4.2).
- **Dark icons and a plugin rename.** Both are optional, and neither is needed
  for the listing to work.
- **Any `v0.5` feature work**, such as multi-site flows, Chrome support, other
  formats, or sharing, until the 2026-12-31 decision (§5).

## Evidence

### 1. Platform drift

Sources: the [submission guide](https://developers.openai.com/plugins/deploy/submission)
(SUB), [submission errors](https://developers.openai.com/plugins/deploy/submission-errors)
(ERR), [build plugins](https://developers.openai.com/plugins/build/plugins) (PKG),
and the [plugin guidelines](https://developers.openai.com/plugins/plugin-guidelines).

| Area | Current OpenAI rule | Repo state | Action |
|---|---|---|---|
| `interface.shortDescription` | Required, at most 30 characters (SUB; ERR `submission_subtitle_too_long`). | 60 characters (`plugin.json:22`). The directory shows OpenAI's 26-character rewrite. | **Fix in `v0.4.1`.** Adopt "Record Codex Browser flows" or a similar ≤30-character text. Update `tests/plugin-structure.test.mjs:104`, which pins the current wording. |
| `interface.supportURL` | New optional field. The guidelines require support contact details for every plugin. | Absent. | **Add.** Point it at `SUPPORT.md`. |
| `brandColorDark` | "A dark color is derived if you supply only `brandColor`" (SUB). | Absent. OpenAI derived `#E5484D`. | None. `#E5484D` passes both contrast floors (3.9:1 on white, 4.1:1 on #212121). |
| Manifest location | Root `plugin.json` with the Agent Plugins `$schema` is now preferred. `.codex-plugin/plugin.json` "remain[s] supported as a compatibility fallback" (PKG). Added in CLI 0.146.0, July 2026 ([changelog](https://learn.chatgpt.com/docs/changelog)). | `.codex-plugin/plugin.json`. | None now. Revisit only if OpenAI announces the fallback's removal. |
| `agents/openai.yaml` `policy` | May contain `allow_implicit_invocation` and a new `products` list (`CHAT`, `CODEX`) (ERR). Plugin skills now also appear in ChatGPT Chat on web and mobile ([build skills](https://learn.chatgpt.com/docs/build-skills)). | Only `allow_implicit_invocation: false`. | Optional for `v0.4.1`: `products: [CODEX]`, so the skill is not offered where it cannot run. Its exact effect is documented only by the error text, so confirm it in the upload's scan output. |
| Category, `defaultPrompt` limits, SKILL frontmatter, `$plugin:skill` syntax, marketplace shape | Unchanged ([security scans example](https://learn.chatgpt.com/docs/security/plugin/scans) still uses `$plugin:skill`). | Compliant. | None. |
| Updating a listed plugin | Upload a new ZIP with **Upload plugin to make changes**. Each upload is a package version with its own checks and review. The `version` must change (ERR `plugin_version_unchanged`). Skill scans take up to 2 hours. Skills-only plugins need no test cases or demo video (SUB). | — | Use this path for `v0.4.1`. Whether a skills-only update gets human review is not documented. |
| Naming | "Plugins should not imply that they are made or endorsed by OpenAI" (guidelines). | "Codex Browser Recorder". This name was accepted at `v0.4.0`. | None now. Expect it as a possible reviewer comment. |

The **Codex In-app Browser** is now called the "built-in browser" (also "in-app
browser") of the ChatGPT desktop app. It is desktop-only, and it is not available
in the Codex CLI or the IDE extension ([Browser docs](https://learn.chatgpt.com/docs/browser)).

### 2. Runtime risk on ChatGPT desktop 26.917

Evidence comes from the installed app's bundled Browser plugin:
`/Applications/ChatGPT.app/Contents/Resources/plugins/openai-bundled/plugins/browser`,
version `26.917.62051`. I read its `SKILL.md`, its `docs/capabilities/*`, and
`scripts/browser-{client,service}.mjs`. None of these runtime APIs are publicly
documented.

#### 2.1 Bootstrap code no longer matches the host (high)

- **What our skill tells the agent.** `record-browser/SKILL.md:72,116` says to
  run `await setupBrowserRuntime({ globals: globalThis })` and then
  `agent.browsers.get("iab")`. That assumes setup installs a global `agent`.
- **What the 26.917 code does instead.** `setupBrowserRuntime(r={})` reads only
  `environment`, `undocumentedApiMembers` and `excludedDocumentation`. It
  *returns* the agent. The only globals `browser-client.mjs` touches are
  `globalThis.nodeRepl` and `globalThis.display`.
- **What the host's own skill says.** `control-in-app-browser/SKILL.md` now
  instructs `const agent = await setupBrowserRuntime();` and "Never use
  `globalThis`."
- **Likely failure.** Followed literally, both our setup check and our recording
  path stop with `ReferenceError: agent is not defined`. That happens before
  `checkSetup` or `recordApproved` runs, so the user gets no Technical Blocker
  text.
- **Caveat.** An agent may improvise a working bootstrap, but our skill forbids
  improvising. The owner check shows which happens.
- **Fix.** Use the host's pattern and reuse one `iab` binding across turns.
  Better still, state the requirement instead of copying host code: "acquire
  only `agent.browsers.get("iab")` as the installed Browser skill instructs." The
  copied snippet is exactly what drifted. Update
  `tests/skill-contract.test.mjs:408` accordingly.

#### 2.2 Starter prompt 3 fails by design (high, certain)

- **The prompt.** `plugin.json:37`:
  `Record clicking the link on https://example.com.`
- **Where the link goes.** example.com's only link is
  `https://iana.org/help/example-domains` (fetched 2026-10-01).
- **Why it fails.** The recorder ends any top-level move to another site with
  `origin_changed_during_recording` (`browser-recording.mjs:444-450`), and saves
  no video.
- **History.** Added in #35 (2026-07-24). No eval covers it. The README and the
  evals use the same-site W3C Pointer Events prompt, which should replace it.

#### 2.3 Host behaviour the code depends on

| Dependency | 26.917 evidence | Risk |
|---|---|---|
| `browser.tabs.new/list`, `tab.goto/close`, `tab.screenshot({fullPage:false})` | Present in the bundled API documentation. | Low |
| `browser.capabilities.get("visibility")` → `get()` / `set()` (`create-recording.mjs:260-290`) | Same interface in `docs/capabilities/browser/visibility.md`. | Low. July's `browser_visibility_unavailable` flake remains the known weak spot (issue #39). |
| `tab.capabilities.get("cdp")` → `readEvents({afterSequence,…})` / `send()` | Same interface in `docs/capabilities/tab/cdp.md`. | Low |
| **Full CDP permission** | The service now checks it when each command runs: `assertFullCdpEnabled` plus a per-origin `fullCdp` approval, approval lifetime defaulting to `"turn"`, and an enterprise `fullCdpAccess` origin policy. The docs say "ChatGPT asks for explicit approval before it uses full CDP to inspect a website." | **Medium.** Our setup check (`record-browser-flow.mjs:409-418`) only checks that `readEvents` and `send` exist on a blank tab and never sends a command. "Preflight passed" therefore does not prove a recording may use CDP on the target site. An approval prompt during startup may also outrun the first-frame deadline. |
| `Page.startScreencast` / `screencastFrameAck` | The host now tracks raw screencasts (`rawScreencastTabIds`) and skips its own screenshot screencast while ours runs. Our pixel-priming screenshot runs before the raw start. | Low. The host now explicitly accommodates this path. |
| `Runtime.addBinding`, `Page.createIsolatedWorld`, child-target commands (cursor capture) | Raw CDP is "scoped to the tab's current web origin". Commands may only target attached sessions (`rawCdpTarget`). | Medium-low. Cursor feedback inside cross-site embedded frames may degrade; the top-level frame is unaffected. |
| Auto-review of `node_repl` calls | [openai/codex#47647](https://github.com/openai/codex/pull/47647) (2026-09-23) applies auto-review to the Browser connector and "nested tool calls". | Watch item. Binding injection could be flagged. |

#### 2.4 Owner-run check sequence (ChatGPT desktop, Codex section, new task)

1. **Settings.** Confirm **Codex Browser Recorder 0.4.0** is installed from
   Plugins. Confirm **Settings → Browser Use (`codex://settings/browser-use`) →
   Developer mode → Enable full CDP access** is on.
2. **Setup check.** Run:
   `$codex-browser-recorder:record-browser Check whether my recording setup is ready.`
   - Expect `Local recording preflight passed`.
   - Note any `agent is not defined` error, or the agent rewriting the bootstrap
     (§2.1).
3. **Pointer recording.** Run:
   `$codex-browser-recorder:record-browser Open https://www.w3.org/TR/pointerevents/, click the 1. Introduction link in the table of contents, and save the approved flow as pointer-events-intro.`
   - Approve. Note whether, and when, a per-site CDP approval prompt appears.
   - Expect `Recording completed`, then open the MP4 and confirm the cursor and
     click ring are visible.
4. **Starter prompt 3.** Run:
   `$codex-browser-recorder:record-browser Record clicking the link on https://example.com.`
   - Expect `origin_changed_during_recording`, which confirms §2.2.
5. **Report back:** the ChatGPT desktop version, each result line or error code,
   and whether a CDP prompt appeared.

The full harness (`runCodexInAppBrowserReleaseQualification`, see
`CONTRIBUTING.md:61`) is reserved for qualifying `v0.4.1`.

### 3. Code health

All four MEMORY.md Deferred Work items were re-checked against `94cb4c3`.

| Item | Still accurate? | Verdict |
|---|---|---|
| Cursor frame registry. `startCursorCapture` is `cursor-recording.mjs:580`, with seven `Map`s at `:583-590`. `renderCursorRecording` reads `RECORDING_FPS` directly (`:325`). | Yes. The fps desync stays latent: `browser-recording.mjs:264` defaults `fps = RECORDING_FPS`, and no production caller passes `fps`. | **Skip.** If touched, delete the unused `fps` override (single path) rather than threading it through. |
| Recording Surface module. The CDP-handle shape check is repeated at 15 sites in 7 files. Six test files hand-build `capabilities.get`. | Yes. The count grew from the recorded eight. | **Skip for now.** This is the right seam if §2.3 forces a CDP-permission change. Do it then, not before. |
| Technical Blocker tables. `recording-outcome.mjs:19,35,58` hold three hand-kept tables. | Yes. | **Skip.** A missing entry degrades to a generic blocker, not a wrong result. Revisit only when adding a code. |
| Bounded cleanup written several times. `awaitAbortable` is duplicated (`browser-recording.mjs:46`, `create-recording.mjs:53`), next to `runSetupOperation` and `settleBeforeDeadline`. | Yes. The cited line numbers drifted slightly. | **Skip.** Behaviour is covered by tests, and unifying it touches every cleanup path. |

The suite is 17.6k test lines against 9.1k script lines, and is green: 453/453
for `npm run check`, plus `check:release-state` exit 0 on 2026-10-01. Its cost
is upkeep time, not risk. The binding constraint is that only a manual desktop
run verifies CDP code, so refactors there cost an owner session each.

### 4. Docs and tracker drift

#### 4.1 Public docs

- **README.**
  - `README.md:22,52` still says "the Codex desktop app". `:54` says
    "Settings > Browser > Developer mode". The 26.917 app keeps the
    `settings/browser-use` route and the "Developer mode → Enable full CDP
    access" labels, under a "Browser Use" settings namespace.
  - The README never links the directory listing, which is the one install path
    the listing experiment measures. Add it to Quick start.
- **SUPPORT.** `SUPPORT.md:39` and `.github/ISSUE_TEMPLATE/bug_report.yml:50` ask
  for the "Codex desktop version". It should be the ChatGPT desktop version.
- **Troubleshooting and CONTRIBUTING.** `docs/troubleshooting.md:42-43` and
  `CONTRIBUTING.md:68` use the same "Codex desktop" wording. `CHANGELOG.md:21`
  is historical, so leave it.
- **SECURITY and PRIVACY.** `SECURITY.md` and `PRIVACY.md` are accurate.
  `TERMS.md` is accurate, apart from the "Codex In-app Browser" name.
- **Naming.** Keep "Codex In-app Browser" where it is a defined term in
  PRIVACY and TERMS. Change it only in setup instructions a user follows.

#### 4.2 Repo manifest vs OpenAI's normalized copy

The cache is at
`~/.codex/plugins/cache/openai-curated-remote/codex-browser-recorder/0.4.0`,
cached 2026-09-28.

- **Skills and scripts:** `diff -r` against `plugins/codex-browser-recorder`
  shows them byte-identical.
- **Manifest:** a key-sorted diff shows four differences:
  - `shortDescription`: a real divergence; fix it in source (§1).
  - `brandColorDark`: derived by OpenAI.
  - `composerIcon` / `logo` paths: moved to `.codex-plugin/assets/`. The icons
    are the same PNG (SHA-1 `383527ed…`). This is a portal artifact (ERR
    `manifest_normalized`). Do not mirror it, because PKG says to keep only
    `plugin.json` inside `.codex-plugin/`, and `tests/plugin-structure.test.mjs:179`
    pins `./assets/icon.png`.
- **Stale-copy risk.** The risk is a future upload drifting from what users see.
  After each publish, diff against the portal's **Download release ZIP**, or
  against the refreshed cache.

#### 4.3 Tracker and CI

- **Issue #39** is still open. Its last comment (2026-07-27) says the release is
  blocked, but PR #69 records the full contract-v2 qualification passing
  (2026-07-29), and `v0.4.0` shipped. Close it with links to #69, #70 and the
  listing.
- **Dependabot #74** (`setup-uv` 9 → 10.2) fails CI by construction:
  `scripts/validate-release-readiness.mjs:504` requires the exact old SHA, so
  the bump fails 36 of 453 tests, mostly release-readiness. Change the check to
  require *a* full-SHA pin rather than *this* SHA.
- **Dependabot #71** (CodeQL 4.37.5): `analyze` was cancelled at its 15-minute
  timeout. Re-run it.
- **CI pins Codex CLI `0.144.4`.** It is installed locally as `0.159.3`. Bump the
  pin with `v0.4.1` so plugin-install tests run against a current CLI.

### 5. Value

- **Who uses it, and why.** A ChatGPT-desktop user doing frontend work or QA who
  wants a shareable MP4 of one flow. The video is recorded in the *built-in
  browser with that user's signed-in session*, with cursor and click feedback.
  It never leaves the Mac, and it is attached to a bug report, PR, or QA note.
  The distinctive parts are the signed-in built-in browser and the local-only,
  explicit-consent recording boundary. Video capture alone is not distinctive.
- **What competes:**
  - **Playwright 1.59+** ([release notes](https://playwright.dev/docs/release-notes)).
    1.59 added `page.screencast` start and stop with action annotations, and
    "Agentic video receipts — coding agents can produce video evidence of their
    work". 1.61 added a `cursor` option. It is free, works in CI, and makes WebM,
    but it drives its own browser rather than the user's signed-in built-in
    browser. It is the default substitute for anyone automating QA.
  - **OpenAI first-party.** Nothing records video.
    [Record & Replay](https://learn.chatgpt.com/docs/extend/record-and-replay)
    turns a demonstration into a skill, and the Browser shares screenshots
    inline. This is the largest threat to watch: one Browser feature release
    could replace the plugin.
  - **Loom-style tools.** These are a different job. A person narrates the whole
    screen, and the video goes to the cloud for sharing.
  - **Other directory plugins.** The listing pages return 403 unauthenticated.
    [openai/plugins](https://github.com/openai/plugins) (62 plugins) has no
    recorder or screen-capture plugin. Not verified beyond that.
- **Observed demand (2026-10-01), all small:**
  - GitHub traffic over 14 days: 29 views from 24 unique visitors, and 150
    clones from 19 unique cloners.
  - `v0.4.0` ZIP downloads: 7.
  - Stars: 5, with no external issues.
  - Directory installs are visible only in `platform.openai.com/plugins` and
    have not been read.
- **Decision: no `v0.5` now.**
  - On 2026-12-31, compare directory installs and inbound issues against the
    baseline from action 3. Build `v0.5` only if the listing shows real pull
    without promotion, with installs clearly beyond the GitHub numbers above.
  - If it does, the first candidate is the most likely real-world blocker:
    approved multi-site flows, such as a sign-in redirect.
  - If not, keep compatibility-only mode. That means re-running the §2.4 check
    when the bundled Browser plugin version changes. If a host change ever needs
    more than a skill-text fix, retire the listing.
