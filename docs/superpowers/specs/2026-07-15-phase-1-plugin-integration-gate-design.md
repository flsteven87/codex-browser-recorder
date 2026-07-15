# Phase 1 Plugin Integration Gate Design

## Status

- Design date: 2026-07-15
- Status: Approved for implementation
- Milestone: Phase 1 installable integration gate
- Target surface: macOS Codex desktop with the in-app Browser

## Objective

Package the proven Phase 0 recorder as an installable, skills-only Codex plugin
and prove that a fresh Codex task can load the recorder from the installed
plugin cache, record a non-sensitive in-app Browser test tab, stop cleanly, and
produce a validated local WebM file.

This milestone proves the packaging and runtime boundary. It does not claim that
the recorder is a complete or production-ready user workflow.

## Success Criteria

The milestone passes only when all of the following are true:

1. A repository marketplace exposes `codex-browser-recorder` as an installable
   plugin.
2. The installed plugin contributes an explicitly invoked `record-browser`
   skill in a fresh Codex task.
3. The skill loads recorder modules from its installed cache copy rather than
   from the repository checkout.
4. The recorder and selected in-app Browser tab share the same persistent
   Browser runtime and current tab-scoped CDP capability.
5. A 10–15 second non-sensitive test run receives fresh source frames while a
   visible page animation and at least one Browser interaction occur.
6. Stop and finalization produce one validated, audio-free VP8 WebM plus a
   sanitized JSON result.
7. Failure paths stop screencasting, stop the frame pump, terminate FFmpeg,
   remove partial output, clear the active runtime handle, and close the fresh
   test tab.

## Non-Goals

- Persistent recording state across runtime or app restarts.
- Crash recovery or stale-session cleanup after a process restart.
- Automatic sensitive-form detection or general authenticated-flow support.
- A user-selected permanent output directory or retention management.
- Twenty-minute, hidden-panel, minimized-app, sleep, or lock-screen validation.
- Chrome extension support.
- A separate Playwright browser backend.
- A local or remote MCP server.
- Public plugin-directory submission, production brand assets, or hosted legal
  pages.

## Researched Constraints

- Codex plugins use `.codex-plugin/plugin.json` as their required entry point.
- Skills are the correct surface for reusable workflow instructions and may
  bundle deterministic scripts.
- A repository marketplace lives at `.agents/plugins/marketplace.json` and
  points at a plugin below `plugins/` with a `./`-prefixed relative path.
- The desktop app installs a local plugin into its plugin cache and loads the
  cached copy, not the source marketplace directory.
- Skill metadata can set `policy.allow_implicit_invocation: false` in
  `agents/openai.yaml`.
- Raw CDP access is tab-scoped, origin-scoped, permission-gated, and available
  only through the current Browser runtime.
- Skill scripts invoked as separate CLI processes cannot independently recover
  the live tab capability. Recorder modules must therefore be imported into the
  runtime that already owns the Browser binding.

Primary references:

- <https://learn.chatgpt.com/docs/build-plugins>
- <https://learn.chatgpt.com/docs/build-skills>
- <https://learn.chatgpt.com/docs/browser>
- <https://agentskills.io/specification>
- <https://github.com/openai/plugins>

## Considered Approaches

### Selected: Skills-only plugin imported into the Browser runtime

The `record-browser` skill obtains the approved in-app Browser binding through
the installed Browser plugin, resolves its own installed skill root, and
dynamically imports the recorder from that root in the same persistent runtime.
The existing recorder continues to own CDP event pumping, FFmpeg sampling,
resource bounds, finalization, and video validation.

This approach preserves the Phase 0 architecture and introduces the fewest new
failure boundaries.

### Rejected: Separate recorder child process with frame IPC

A separate process would require the Browser runtime to serialize every frame
over IPC and would add another backpressure, shutdown, error propagation, and
security boundary. Phase 0 did not validate this architecture, and it is not
needed to prove installation.

### Rejected: Local MCP server

An MCP server does not independently own the in-app Browser tab capability. A
Browser-runtime bridge would still be required, creating two cooperating
runtimes without improving the first milestone's outcome.

## Plugin Layout

```text
.agents/plugins/marketplace.json
plugins/codex-browser-recorder/
├── .codex-plugin/plugin.json
└── skills/
    └── record-browser/
        ├── SKILL.md
        ├── agents/
        │   └── openai.yaml
        └── scripts/
            ├── doctor.mjs
            ├── run-browser-recording.mjs
            ├── screencast-recorder.mjs
            └── validate-video.mjs
```

The recorder implementation under `poc/` moves into the plugin skill and becomes
the only canonical implementation. Repository tests import the installed-plugin
layout directly. The project does not keep copied implementations, symlinks, or
fallback imports outside the plugin root because they would either drift or
break when Codex installs the cache copy.

The initial manifest contains only fields supported by the current validator.
It declares the skills directory but does not declare apps, MCP servers, hooks,
or assets that do not exist. The marketplace entry includes explicit
installation, authentication, and category policy fields.

## Skill Contract

The skill is experimental and must be invoked explicitly. Its metadata sets:

```yaml
policy:
  allow_implicit_invocation: false
```

The skill supports only a fresh, non-sensitive HTTPS test tab in this milestone.
It explains that page content will be recorded locally without Codex UI, browser
chrome, or audio. It does not treat a general Browser task as recording consent.

The skill must stop with a bounded blocker if the Browser plugin, macOS platform,
full CDP capability, Node.js 24 runtime, FFmpeg, FFprobe, or writable temporary
directory is unavailable. It must not enable Developer mode, change workspace
policy, install system packages, or retry denied approval.

## Runtime Ownership

The installed Browser plugin owns Browser bootstrap, browser selection, the tab
binding, and permission-gated CDP access. Browser Recorder does not bundle or
initialize another Browser client.

After Browser setup, the skill:

1. Creates a fresh in-app Browser test tab and navigates it to the fixed test
   origin.
2. Obtains the tab's current `cdp` capability after navigation.
3. Resolves `<installed-skill-root>/scripts/run-browser-recording.mjs` as an
   absolute module URL.
4. Imports that module inside the same persistent runtime that owns the tab.
5. Starts the recorder and waits for its first valid frame.

The skill must not guess a cache directory, fall back to the repository `poc/`
directory, start an external Node process to reacquire CDP, or pass a tab ID to
another process and assume it can reconstruct the capability.

## Integration Handle

The integration adapter returns an explicit runtime handle:

```js
const handle = await createBrowserRecording({
  tab,
  temporaryRoot,
  ffmpegPath,
  ffprobePath,
  fps: 10,
  maxDecodedBytes: 5 * 1024 * 1024,
});
```

The public handle surface is deliberately small:

```js
{
  ready,
  status(),
  stop()
}
```

- `ready` resolves after the first valid source frame has been acknowledged and
  accepted by the sink.
- `status()` returns only `recording`, `stopping`, `completed`, or `failed`,
  together with sanitized bounded counters.
- `stop()` is idempotent and memoizes one finalization promise.

The Browser runtime stores this handle under one plugin-specific global key so
later Browser calls can interact with the tab and then stop the same recording.
The global value contains the handle, not frames, page content, URLs, or CDP
event payloads. This is explicit in-memory ownership, not the persistent Phase 1
state machine planned for a later milestone.

## Recording Data Flow

1. The skill confirms explicit invocation and the experimental test scope.
2. Browser setup provides a fresh tab and obtains normal site and CDP approval.
3. The environment doctor resolves required executables and blockers without
   changing the system.
4. The recorder allocates a unique `0700` temporary directory.
5. The recorder starts a JPEG screencast at quality 70, at most 1280×720.
6. The frame pump acknowledges every valid session ID before handing the frame
   to the encoder and retains only bounded counters.
7. The FFmpeg sink retains only the latest bounded JPEG and samples it at 10 fps
   into an audio-free VP8 WebM partial file.
8. After readiness, the skill injects a known clock and CSS animation into the
   test page and performs one scroll or SPA-style DOM state change.
9. The skill confirms that fresh source-frame counters increase during the
   10–15 second recording window.
10. Stop finalizes the encoder, validates the output, writes the sanitized
    result, clears the runtime handle, and closes the test tab.

## Stop and Cleanup Order

All success and failure paths use the same order:

1. Request `Page.stopScreencast`.
2. Stop the CDP frame pump.
3. End FFmpeg stdin and wait for bounded encoder shutdown.
4. Remove the partial output on cancellation or failure.
5. Validate the finalized WebM on success.
6. Persist a private sanitized result file.
7. Clear the plugin-specific runtime handle.
8. Close the fresh test tab.

Cleanup failures do not replace the primary failure code. A video is never
reported as successful unless finalization and validation both pass.

## Security Boundary

The recorder uses only these CDP commands:

- `Page.enable`
- `Page.startScreencast`
- `Page.screencastFrameAck`
- `Page.stopScreencast`

It reads only:

- `Page.screencastFrame`
- `Page.screencastVisibilityChanged`

It does not use Network, Storage, browser-profile, cookie, credential, or
authorization-header APIs. Page content is untrusted data. JPEG frames are
bounded bytes sent to FFmpeg and are not placed in model context as text or
instructions.

The fixed integration page contains no credentials or personal data. Direct
page modifications are known test-only changes and are discarded by closing
the fresh tab.

## Result Contract

Successful user-visible output includes only:

- status;
- elapsed duration;
- received and acknowledged frame counts;
- output samples;
- drop and truncation counters;
- validated codec, dimensions, size, and duration;
- final local WebM path.

Failed or blocked output includes a stable failure code and one actionable
message. It excludes raw frames, CDP payloads, FFmpeg stderr, full URLs, and
internal plugin-cache paths.

## Failure Taxonomy

Environment or permission blockers:

- `browser_plugin_unavailable`
- `unsupported_platform`
- `cdp_unavailable`
- `ffmpeg_missing`
- `ffprobe_missing`
- `output_directory_not_writable`

Integration or recording failures:

- `plugin_module_unavailable`
- `recording_already_active`
- `frame_stream_unavailable`
- `frame_stream_stalled`
- `event_stream_invalid`
- `encoder_failed`
- `encoder_shutdown_timeout`
- `recording_output_limit`
- `duration_mismatch`
- `video_stream_missing`
- `video_stream_count_invalid`
- `container_invalid`
- `codec_invalid`
- `audio_stream_present`
- `dimensions_out_of_bounds`

Unknown failures map to `integration_failed`. A denied site or full-CDP approval
maps to `cancelled` and is not retried or bypassed.

## Automated Test Strategy

### Plugin structure

Tests verify that manifest name, folder name, and marketplace entry match; the
version is strict semver; all declared paths exist; marketplace policy fields
are present; implicit invocation is disabled; skill frontmatter is valid; and
the plugin contains no repository-external fallback imports.

### Recorder regression

The existing Phase 0 tests remain authoritative after their imports move to the
plugin scripts. New integration-adapter tests cover first-frame readiness,
sanitized status, idempotent stop, startup failure, encoder failure cleanup,
validation failure, and stable environment blockers.

### Isolated installation

An automated install test uses a unique temporary `CODEX_HOME` rather than the
user's real Codex configuration. It adds the repository marketplace, installs
the plugin into the isolated cache, verifies that Codex lists the cached plugin,
and imports the recorder from that cached copy. The test proves that the cache
copy has no dependency on files outside the plugin root and then removes the
temporary environment.

This test must not edit the user's `~/.codex/config.toml`, installed plugin
cache, or marketplace configuration.

## Manual Fresh-Task Acceptance Gate

Actual desktop installation changes user-level Codex state and therefore
requires separate explicit approval after automated validation passes. The
manual gate then verifies in a fresh task that:

1. The plugin is visible and installable from the repository marketplace.
2. `$record-browser` is visible and does not invoke implicitly.
3. Normal site and full-CDP approval are requested.
4. The recorder loads from the installed cache copy.
5. Fresh source frames increase during page animation and Browser interaction.
6. Stop produces one audio-free VP8 WebM with plausible duration.
7. No partial output or FFmpeg process remains.
8. The test tab closes and the result contains no raw diagnostics or absolute
   cache path.

## Completion Gate

The implementation work is complete only after all automated requirements below
pass:

- Node syntax checks pass.
- All existing and new Node tests pass.
- Plugin validation passes.
- Skill validation passes.
- The isolated marketplace installation and cache-import test passes.
- Recorder coverage remains at least 90% line and 80% branch.
- `git diff --check` passes.
- The worktree contains no accidental WebM, result JSON, or partial files.

The approved manual fresh-task test passed on 2026-07-15. The overall Phase 1
integration gate is therefore `PASS` for the fixed `https://example.com/`
open-source alpha scope. This does not authorize broader origins or establish a
general-purpose production recorder.

## Rollback

If the installed-cache import or shared Browser-runtime gate fails, revert the
plugin packaging changes while preserving the Phase 0 design, evidence, and
tests. Do not introduce broader permissions, a hidden browser-profile bridge,
or an unreviewed separate-browser fallback to force the milestone to pass.
