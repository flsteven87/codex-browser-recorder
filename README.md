<p align="center">
  <img
    src="plugins/codex-browser-recorder/assets/icon.png"
    width="128"
    alt="Codex Browser Recorder icon"
  >
</p>

# Browser Recorder for Codex

Turn a short browser flow into a local video—without leaving Codex.

Browser Recorder opens one fresh Codex In-app Browser tab, follows the actions
you approve, and saves the result as an MP4. Pointer flows include a visible cursor
and click feedback, so the recording is easy to follow in a bug report, QA
note, or review.

Recordings stay on your Mac. The plugin does not upload or share them, add
telemetry, capture audio, or record your other tabs.

> [!NOTE]
> Browser Recorder is an experimental, community-developed plugin for the Codex
> desktop app on macOS with the Codex In-app Browser.

## Before you record

> [!WARNING]
> **Content Warning:** The complete approved page viewport may include private
> or authenticated data and other sensitive content. Continue only if you are
> authorized to record it and will handle the local recording appropriately.

- A fresh tab may reuse the Codex In-app Browser's existing session, so
  authenticated or personalized content can appear.
- The recording includes the complete visible page viewport, including all
  visible embedded frames.
- If the page sends the tab to another website, recording stops without saving
  a video.
- Browser Recorder does not classify page content, redact visible fields, or
  refuse technically valid recordings based on authentication or sensitivity.
- You control the approved actions and are responsible for consent,
  authorization, storage, sharing, and deletion of the local file.

See the [privacy policy](PRIVACY.md) for the complete data boundary, retention,
cleanup, and failure behavior.

## Quick start

### 1. Install the prerequisites

You will need:

- the Codex desktop app on macOS;
- the official **Browser** plugin available in Codex;
- **Settings > Browser > Developer mode > Enable full CDP access** turned on;
- FFmpeg and FFprobe with H.264 and MP4 support.

Homebrew users can install the media tools with:

```sh
brew install ffmpeg
```

In the ChatGPT desktop app, open **Codex > Plugins**, search for
**Codex Browser Recorder**, and install it. Confirm that the official
**Browser** plugin is available, then start a new task. If the recorder is not
listed for your account or workspace, use the
[local checkout](#install-from-a-local-checkout) below.

### 2. Check your setup

Ask Codex to run the recorder's read-only preflight:

```text
$codex-browser-recorder:record-browser Check whether my recording setup is ready.
```

A successful check begins with `Local recording preflight passed`. It checks
your Mac, media tools, output folder, Codex In-app Browser, and full CDP access.
The check opens and closes one fresh diagnostic tab when needed, but it does not
start a Recording Session, create a video or raw frame dump, or upload anything.

### 3. Record your first flow

Try the public reviewer page:

```text
$codex-browser-recorder:record-browser Open https://www.w3.org/TR/pointerevents/, click the 1. Introduction link in the table of contents, and save the approved flow as pointer-events-intro.
```

Before the Codex In-app Browser opens, Codex shows the page, actions, duration,
recording mode, and output name for your approval. When the flow finishes, the
video is saved to `~/Downloads/Codex Browser Recordings/` by default.

Interactive Recording is the default and shows the Codex In-app Browser before
the approved flow starts. For automated E2E QA, explicitly request an
Unattended Recording to begin and remain hidden:

```text
$codex-browser-recorder:record-browser Record this approved E2E QA flow unattended: open https://example.com/, follow the approved checks, and save it as e2e-evidence.
```

Unattended Recording still uses the Codex In-app Browser renderer and session;
it is not a separate headless Chromium surface. The two modes never silently
fall back to one another.

## What you get

| | |
| --- | --- |
| **A focused capture** | One approved flow in one fresh Codex In-app Browser tab—never the Codex UI, browser controls, or your other tabs. |
| **A ready-to-use file** | A local H.264 MP4, capped at 720p and encoded at 10 frames per second with no audio. |
| **Visible actions** | Pointer flows show the cursor and click feedback. |
| **Two explicit modes** | Interactive Recording is visible by default; Unattended Recording begins hidden for automated QA. |
| **Local by default** | The video is created on your Mac, and page images are not sent to the model. There is no automatic upload, sharing, or telemetry. |

The fixed video profile is designed for short test evidence, not high-motion
product demos.

## Limits

- Requires macOS and the Codex In-app Browser.
- One fresh tab and one approved website at a time.
- `https:` pages, plus explicit loopback development pages on
  `localhost`, `127.0.0.1`, or `[::1]`.
- An optional duration from 5 to 60 seconds. Action-driven recordings can stop
  after the approved actions; passive or wait-only recordings require an
  explicit duration.
- No audio, multiple tabs, uploads, remote storage, or navigation to another
  website.

## Install from a local checkout

Add this repository as a local marketplace:

```sh
codex plugin marketplace add /absolute/path/to/codex-browser-recorder
codex plugin add codex-browser-recorder@codex-browser-recorder
```

Start a new Codex task after installing. Do not copy files into the plugin cache
or edit cache contents by hand.

<details>
<summary>Install and verify latest published version 0.4.0</summary>

Use a release tag when you need to reproduce the published plugin:

```sh
git clone --branch v0.4.0 --depth 1 https://github.com/flsteven87/codex-browser-recorder.git
codex plugin marketplace add /absolute/path/to/codex-browser-recorder
```

The [v0.4.0 release page](https://github.com/flsteven87/codex-browser-recorder/releases/tag/v0.4.0)
lists the release commit. You can also verify the downloaded archive:

```sh
recorder_release=v0.4.0
recorder_archive="codex-browser-recorder-${recorder_release}.zip"
curl --fail --location --remote-name \
  "https://github.com/flsteven87/codex-browser-recorder/releases/download/${recorder_release}/${recorder_archive}"
curl --fail --location --remote-name \
  "https://github.com/flsteven87/codex-browser-recorder/releases/download/${recorder_release}/${recorder_archive}.sha256"
shasum -a 256 -c "${recorder_archive}.sha256"
```

The checksum covers the versioned archive. For stricter reproducibility, also
pin the full release commit.

</details>

## Documentation

- **Can't install or record?** Start with
  [Troubleshooting](docs/troubleshooting.md).
- **Need the full data boundary?** Read [Privacy](PRIVACY.md).
- **Found a bug?** Follow [Support](SUPPORT.md) to share a safe report.
- **Found a security issue?** Use the private process in
  [Security](SECURITY.md).
- **Want to contribute?** See [Contributing](CONTRIBUTING.md).
- **Want to understand the internals?** Read
  [Architecture](docs/architecture.md).
- **Looking for release history?** Open the [Changelog](CHANGELOG.md).

## Development

Repository development requires Node.js 24 or newer. There are no npm runtime
dependencies and no development server.

```sh
npm run check
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for the full validation and Codex
In-app Browser release process.

<details>
<summary>Update or uninstall a local installation</summary>

Install again from the local checkout:

```sh
codex plugin remove codex-browser-recorder@codex-browser-recorder
codex plugin add codex-browser-recorder@codex-browser-recorder
```

Remove both the plugin and its local marketplace:

```sh
codex plugin remove codex-browser-recorder@codex-browser-recorder
codex plugin marketplace remove codex-browser-recorder
```

Start a new task after changing installed plugins.

</details>

## Browser Recorder and Record & Replay

Browser Recorder creates a local video of an approved page flow. Codex
[Record & Replay](https://learn.chatgpt.com/docs/extend/record-and-replay)
turns a demonstrated workflow into a reusable skill. They are separate
features.

## License

[MIT](LICENSE)
