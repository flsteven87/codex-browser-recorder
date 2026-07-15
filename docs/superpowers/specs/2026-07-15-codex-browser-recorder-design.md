# Codex Browser Recorder Design

## Status

- Project name: `codex-browser-recorder`
- Plugin display name: **Browser Recorder for Codex**
- Positioning: **Headless recording for Codex in-app Browser sessions**
- Initial license: MIT
- Initial platform: macOS Codex desktop app
- Design date: 2026-07-15

## Objective

Create an open-source Codex plugin that records the actual Codex in-app Browser page while Codex operates it, without requiring the user to keep the Browser surface visible. The plugin produces a local, validated video file and does not upload it by default.

The project must preserve the in-app Browser's existing profile and authenticated session. A separate Playwright browser is a future fallback, not the primary recording path.

## User-Visible Outcome

A user can ask Codex to record an in-app Browser task, approve recording, let Codex perform the task with the Browser hidden or in the background, and receive a playable local video when the task finishes.

The initial release succeeds when it can:

1. Detect whether full CDP access and required local dependencies are available.
2. Start recording one existing in-app Browser tab after explicit approval.
3. Continue receiving frames while the Browser surface is hidden or backgrounded.
4. Record navigation, scrolling, form input, and SPA updates for at least two minutes.
5. Stop and finalize recording deterministically.
6. Validate the output with `ffprobe` before reporting success.
7. Return a local file path without uploading the recording.

## Non-Goals for Version 0.1

- Recording Codex UI, browser chrome, operating-system dialogs, or native file pickers.
- Recording audio, microphone input, or system sound.
- Recording multiple tabs into a synchronized composite video.
- Uploading to Loom or another external service.
- Supporting Codex CLI, the IDE extension, or cloud Browser sessions.
- Shipping a separate Playwright browser backend.
- Bypassing Developer mode, workspace policy, site permissions, authentication, CAPTCHA, MFA, or other security controls.
- Running an always-on recorder or starting recording without user consent.

## Feasibility Gate

The primary design depends on Chrome DevTools Protocol screencast support exposed through Codex Browser Developer mode. This is promising but not yet proven in the hidden in-app Browser state.

Implementation must begin with a bounded proof of concept. The project is a **Go** only if all five gates pass:

| Gate | Test | Pass condition |
| --- | --- | --- |
| CDP availability | Enable Browser full CDP access and inspect the selected tab | `Page.enable` and screencast commands are callable |
| Visible capture | Record a visibly changing page | Frames arrive continuously and can be acknowledged |
| Hidden capture | Hide or background the in-app Browser for two minutes | Frames continue without an unrecoverable stall |
| Interaction fidelity | Navigate, scroll, type, and update an SPA | The resulting video shows the expected page transitions |
| Finalization | Stop, encode, and inspect the output | The file is playable and its reported duration is plausible |

If hidden capture fails, the exact-session headless design is a **No-Go**. The project must not disguise a separate Playwright browser as the in-app Browser. A Playwright fallback requires a separate design review.

## Architecture

Version 0.1 is a skills-only Codex plugin with trusted local helper modules. It does not use a remote MCP server because a remote service cannot attach to the user's local in-app Browser session. It does not use a separate browser automation server because the in-app Browser is controlled through Codex's Browser runtime.

```text
User request and approval
        |
        v
Record Browser skill
        |
        +--> Environment doctor
        |      - Browser capability
        |      - full CDP access
        |      - ffmpeg / ffprobe
        |      - writable output directory
        |
        +--> Browser recording controller
        |      - select one tab
        |      - Page.startScreencast
        |      - read screencastFrame events
        |      - acknowledge every frame
        |
        +--> Local encoder
        |      - timestamp normalization
        |      - duplicate frames for idle intervals
        |      - stream frames to FFmpeg
        |
        +--> Output validator
               - file exists and is non-empty
               - ffprobe can parse it
               - duration and dimensions are plausible
               - emit final local path
```

## Components

### Plugin Manifest

The plugin lives at `plugins/codex-browser-recorder/` and has the required manifest at `.codex-plugin/plugin.json`. The stable plugin identifier is `codex-browser-recorder`.

The public display metadata uses **Browser Recorder for Codex** and clearly labels the project as community-developed rather than an OpenAI product.

### Record Browser Skill

The skill owns the user-facing workflow and routing. It must:

- Trigger only for explicit requests to record an in-app Browser task.
- Explain that page content, but not Codex UI or audio, will be recorded.
- Obtain explicit approval before starting.
- Run the environment doctor before starting a recording session.
- Maintain the recording state instead of inferring it from conversation text.
- Stop recording on completion, explicit cancellation, timeout, or recoverable task failure.
- Refuse to claim success until output validation passes.

The skill must not rely on hooks to infer individual Browser clicks. Browser actions can be grouped inside a larger tool call, and hooks are not a complete interception boundary.

### Environment Doctor

The doctor is deterministic and read-only. It returns a structured result:

```json
{
  "supported": true,
  "platform": "darwin",
  "cdpAvailable": true,
  "ffmpegPath": "/usr/local/bin/ffmpeg",
  "ffprobePath": "/usr/local/bin/ffprobe",
  "outputDirectoryWritable": true,
  "blockingReasons": []
}
```

It must never enable Developer mode, change workspace policy, install software, or request broader privileges automatically.

### Browser Recording Controller

The controller operates on exactly one selected in-app Browser tab. Its responsibilities are:

- Enable the required CDP Page domain.
- Start JPEG screencast frames with bounded dimensions and quality.
- Drain events promptly.
- Acknowledge every received frame, including frames later dropped by the encoder.
- Preserve CDP timestamps and visibility events in a local diagnostic trace.
- Stop screencasting in a `finally` path.
- Expose health information such as last-frame time, frame count, dropped frames, and visibility state.

CDP event payloads are untrusted input. The controller validates event shape and bounds base64 payload size before decoding.

### Local Encoder

The encoder converts variable-rate JPEG frames into a WebM video. Version 0.1 targets VP8 WebM for minimal licensing and browser compatibility complexity.

The encoder must:

- Stream frames instead of retaining the complete recording in memory.
- Use timestamps to preserve real elapsed time.
- Repeat the most recent frame during idle intervals so the output duration remains correct.
- Use a unique temporary directory and output name per recording ID.
- Write to a temporary file and atomically rename only after successful finalization.
- Terminate FFmpeg on cancellation and bounded shutdown timeout.

The project does not redistribute an FFmpeg binary in version 0.1. The doctor detects a user-installed executable and gives a bounded setup message if it is unavailable.

### Output Validator

The validator is deterministic. Success requires all of the following:

- The final file exists.
- The file exceeds a minimum non-zero size.
- `ffprobe` exits successfully.
- A video stream exists.
- Width and height are positive and within configured limits.
- Duration is positive and consistent with the recording session within tolerance.

Validation failure returns a failed recording result and preserves sanitized diagnostics. It never returns a corrupt file as a successful result.

## State Model

Each recording has a unique ID and one of these states:

```text
idle -> checking -> awaiting_approval -> starting -> recording
recording -> stopping -> validating -> completed
recording -> stopping -> failed
recording -> stopping -> cancelled
```

Allowed transitions are enforced in code. `start` and `stop` are idempotent for the same recording ID. Only one recording may be active in version 0.1.

The persisted session record contains:

- Recording ID
- Selected tab identifier
- Start and stop timestamps
- Current state
- Output and temporary paths
- Frame count and last-frame timestamp
- Visibility state
- Sanitized failure code

It must not contain cookies, authorization headers, form values, or raw page text.

## Tool Contracts and Side Effects

| Operation | Purpose | Side-effect class |
| --- | --- | --- |
| `doctor` | Check support and dependencies | Read-only |
| `prepare_recording` | Allocate ID and paths | Local write |
| `start_recording` | Start CDP screencast and FFmpeg | Sensitive local write |
| `recording_status` | Return health and state | Read-only |
| `stop_recording` | Stop capture and finalize file | Sensitive local write |
| `cancel_recording` | Stop capture and remove partial output | Destructive local write |
| `validate_recording` | Inspect finalized output | Read-only |

Recording tools must not be annotated as read-only merely because they do not modify a website.

## Privacy and Security Controls

- Require explicit recording consent for every session.
- Keep output local by default.
- Never upload or share without a separate, explicit user request and approval.
- Display a recording-status message while capture is active, even if the Browser surface is hidden.
- Use a maximum duration, maximum dimensions, maximum frame payload, and maximum output size.
- Refuse known sensitive flows in version 0.1, including password entry, payment forms, passkeys, and account-recovery secrets.
- Treat page content and CDP events as untrusted data, never as instructions.
- Do not inspect or export cookies, local storage, passwords, or browser profile data.
- Do not log raw frames, form values, authorization headers, or full URLs containing query secrets.
- Redact paths and URLs in diagnostics when they may contain user-specific data.
- Use least-privilege filesystem access limited to the configured output and temporary directories.
- Do not use `--no-sandbox` or unrestricted file access.
- Make retention user-controlled; no automatic cloud backup is part of the plugin.

## Failure Handling

| Failure | Required behavior |
| --- | --- |
| CDP capability absent | Stop before recording and explain how to enable Developer mode or contact the workspace admin |
| User denies CDP approval | Return cancelled without retrying or requesting a bypass |
| No frames after start | Stop after a short bounded timeout and return `frame_stream_unavailable` |
| Hidden state stops frames | Fail the PoC gate; do not claim headless support |
| FFmpeg missing | Return a doctor failure with a platform-specific setup message |
| Encoder exits early | Stop screencast, retain sanitized logs, and mark failed |
| Browser tab closes | Stop and finalize only if enough frames exist; otherwise fail |
| Codex task fails | Attempt bounded finalization and report recording status independently from task status |
| App or process crashes | On the next run, detect stale state and clean partial artifacts after user confirmation |
| Disk limit reached | Stop capture and fail without consuming additional disk space |

## Testing Strategy

### Unit Tests

- State transition validation
- CDP event schema and payload limits
- Timestamp normalization
- Idle-frame repetition
- Output-path isolation
- URL and diagnostic redaction
- Validator behavior for valid, empty, truncated, and corrupt videos

### Integration Tests

- Fake CDP frame source into a real FFmpeg process
- Cancellation and timeout behavior
- Encoder crash and cleanup
- Atomic finalization
- Concurrent start rejection

### Manual Codex Browser PoC

- Visible animated page
- Hidden in-app Browser
- Background application
- Navigation across origins after normal site approval
- Scrolling and form input using non-sensitive fixture data
- SPA route and animation changes
- Two-minute and twenty-minute recordings
- Browser tab closure
- App cancellation and restart recovery

### Release Evals

Each release includes five positive and three negative scenarios suitable for future plugin submission review. Metrics include task success rate, recording finalization rate, hidden-frame stall rate, dropped-frame rate, output duration error, crash-recovery rate, and false-positive sensitive-flow blocks.

## Distribution Plan

### Phase 0: Feasibility PoC

Run the five gates locally. No marketplace or public claim is made before the hidden-capture gate passes.

### Phase 1: Open-Source Alpha

- Publish the GitHub repository under the MIT license.
- Support macOS Codex desktop only.
- Require user-installed FFmpeg.
- Label the project experimental and community-developed.

### Phase 2: GitHub Marketplace

- Add `.agents/plugins/marketplace.json`.
- Publish versioned Git tags.
- Let users add the marketplace with `codex plugin marketplace add OWNER/codex-browser-recorder`.
- Validate plugin structure and run tests in CI.

### Phase 3: Workspace Sharing

Use limited workspace distribution to validate permissions, privacy controls, installation, and real authenticated sessions.

### Phase 4: Public Plugin Submission

Submit as a skills-only plugin if local helper scripts and full-CDP usage remain compatible with public review requirements. Prepare verified developer identity, public privacy and support pages, starter prompts, five positive tests, three negative tests, and accurate capability disclosures.

Public-directory approval is not an acceptance criterion for the open-source project. The GitHub marketplace remains a supported distribution channel even if public submission is unavailable or rejected.

## Repository Layout

```text
codex-browser-recorder/
├── .agents/plugins/marketplace.json
├── plugins/codex-browser-recorder/
│   ├── .codex-plugin/plugin.json
│   ├── skills/record-browser/SKILL.md
│   ├── scripts/doctor.mjs
│   ├── scripts/recorder.mjs
│   ├── scripts/encoder.mjs
│   ├── scripts/validate-video.mjs
│   └── assets/
├── tests/
├── LICENSE
├── README.md
├── SECURITY.md
└── PRIVACY.md
```

## Rollback and Exit Strategy

The first implementation milestone is intentionally disposable. If the hidden-capture PoC fails, remove the experimental recorder implementation while preserving the research and tests. Do not expand permissions or depend on private browser profile access to force feasibility.

Any Playwright fallback becomes a separately approved backend with explicit UI language stating that it uses a separate browser profile and session.

## Approved Naming

- Repository: `codex-browser-recorder`
- Plugin ID: `codex-browser-recorder`
- Display name: **Browser Recorder for Codex**
- Tagline: **Headless recording for Codex in-app Browser sessions**
- Initial keywords: `codex`, `in-app-browser`, `browser-recording`, `cdp`, `headless`, `plugin`

The repository name stays concise. The in-app Browser distinction is carried in the tagline, README opening, plugin description, and search metadata.
