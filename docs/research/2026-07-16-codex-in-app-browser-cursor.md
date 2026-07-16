# Codex in-app Browser cursor capture research

Date: 2026-07-16
Scope: OpenAI Browser plugin `26.707.72221`, the current recorder, official Codex Browser documentation, and the Chrome DevTools Protocol (CDP) specification
Status: implementation and installed-browser validation complete

## Decision

The cursor visible in Codex's in-app Browser is maintained separately from the
page pixels captured by `tab.screenshot()`, `Page.captureScreenshot`, and
`Page.startScreencast`. A cursor-inclusive video therefore requires cursor
telemetry plus composition; switching screenshot APIs is insufficient.

Contrary to the initial finding, the installed Browser's public raw-CDP
capability provides a sufficiently complete observation path without changing
Browser action call sites:

1. register one recording-scoped `Runtime.addBinding` for a unique execution
   context name;
2. create a short-lived isolated JavaScript world with that same name for the
   top frame;
3. install capture-phase `window` mouse listeners in that isolated world;
4. receive bounded payloads through `Runtime.bindingCalled` in
   `cdp.readEvents()`; and
5. composite a project-owned cursor sprite into the existing page-only video
   with FFmpeg.

This was dynamically verified for direct CUA movement/clicks, Playwright
locator clicks, and world/listener recreation after reload without
re-registering the name-scoped binding. It observes the page-delivered mouse
events that drive the Browser task, including resolved locator coordinates. It
does not capture the proprietary Browser cursor pixels or its private animation
trajectory; it reconstructs a synchronized cursor from the same input
endpoints.

This **isolated-world observer is the implemented design**. A recorder-owned
coordinate-action facade remains unsuitable because it
misses locator, DOM CUA, concurrent, and manual actions that bypass the facade.

Marketplace submission remains gated on the repository quality gates and
installed-desktop release procedure. Cursor behavior itself has been validated
through a real in-app Browser recording plus bounded public-CDP coverage for
reload recreation, event bounds, cleanup, viewport mapping, and iframe targets.

## Implementation validation

The implementation keeps the existing `createRecording()` public handle and
adds one internal `cursor-recording.mjs` module plus two project-owned XPM
assets. It observes pointer events in isolated worlds, transforms frame-local
coordinates at event time, retains a bounded timeline, and performs one local
FFmpeg composition pass before normal media validation and durable
publication. A planned pointer flow with zero observed events fails closed as
`cursor_recording_failed`.

An installed Codex in-app Browser run on 2026-07-16 produced a 1280 x 720,
2.3-second H.264 `yuv420p` MP4 with one video stream and no audio. Frame-level
inspection confirmed no cursor before the first event, the project-owned arrow
at the click coordinate, and a 200 ms click ring. The page also added its
expected `Delete` button, confirming that the recorded click occurred.

The live probe found one important capability boundary: direct
`Target.setAutoAttach` is rejected by the Browser plugin's public raw-CDP
surface. The supported path is to consume the flattened iframe target sessions
already attached and emitted by the Browser plugin through
`Target.attachedToTarget` and `Target.detachedFromTarget`.

## Source boundary

The public Codex documentation establishes that the built-in Browser is a
shared view, that Computer Use can click, type, inspect, and take screenshots,
and that Developer mode gives controlled CDP access. It does not promise a
cursor-inclusive screenshot or a Browser action subscription API.
[OpenAI Browser documentation](https://learn.chatgpt.com/docs/browser?surface=app)

Detailed Browser implementation findings come from the locally installed,
OpenAI-authored Browser plugin. Its manifest identifies OpenAI as the author
and version `26.707.72221`, but marks the bundle proprietary. These findings
are evidence for the installed build, not a stable public Browser API contract:

- `$CODEX_HOME/plugins/cache/openai-bundled/browser/26.707.72221/.codex-plugin/plugin.json:2-10`
- `$CODEX_HOME/plugins/cache/openai-bundled/browser/26.707.72221/docs/api.json`
- `$CODEX_HOME/plugins/cache/openai-bundled/browser/26.707.72221/scripts/browser-client.mjs`

Protocol claims use the official CDP specification:

- [`Input.dispatchMouseEvent`](https://chromedevtools.github.io/devtools-protocol/tot/Input/#method-dispatchMouseEvent)
- [`Page.captureScreenshot`](https://chromedevtools.github.io/devtools-protocol/tot/Page/#method-captureScreenshot)
- [`Page.createIsolatedWorld`](https://chromedevtools.github.io/devtools-protocol/tot/Page/#method-createIsolatedWorld)
- [`Page.startScreencast`](https://chromedevtools.github.io/devtools-protocol/tot/Page/#method-startScreencast)
- [`Runtime.addBinding`](https://chromedevtools.github.io/devtools-protocol/tot/Runtime/#method-addBinding)
- [`Runtime.bindingCalled`](https://chromedevtools.github.io/devtools-protocol/tot/Runtime/#event-bindingCalled)
- [`Runtime.evaluate`](https://chromedevtools.github.io/devtools-protocol/tot/Runtime/#method-evaluate)
- [`Runtime.removeBinding`](https://chromedevtools.github.io/devtools-protocol/tot/Runtime/#method-removeBinding)

## Findings

### 1. Browser cursor movement and page input are separate operations

The supported CUA API accepts explicit viewport coordinates for `click`,
`double_click`, `move`, and `scroll`, plus a coordinate path for `drag`:

- `docs/api.json:436-520`
- `docs/api.json:1433-1458`

The installed Browser client uses two channels for one action:

1. `Jd.dispatchMouseMove(...)` calls internal `ui.moveMouse(...)`, ultimately
   sending a session-scoped backend `moveMouse` request; and
2. it separately calls CDP `Input.dispatchMouseEvent` so the page receives a
   trusted mouse event.

`Jd.clickPoint(...)` follows the same pattern: await UI movement, then dispatch
CDP move/press/release commands. See `Jd.dispatchMouseMove`, `Jd.clickPoint`,
`tp.moveMouse`, and `up.moveMouse` in
`scripts/browser-client.mjs:3232-3246`.

This explains both the visible Browser cursor and why it is absent from page
captures. It also supplies the observation seam: although CDP does not emit the
input command itself as an event, the page receives corresponding DOM mouse
events that an isolated world can observe.

### 2. Both screenshot paths omit the Browser UI cursor

The supported `Tab` API exposes `screenshot({ clip?, fullPage? })` but no
`includeCursor` option (`docs/api.json:391-399,1427-1431`).

In the installed implementation, `tab_screenshot` delegates to `sR(...)`,
which returns either an internal `Page.startScreencast` frame or
`Page.captureScreenshot`. The automatic Browser response screenshot calls the
same implementation. See `scripts/browser-client.mjs:193` (`sR`, `Rq`) and
`scripts/browser-client.mjs:3248` (`jP` calling `iR`).

The current recorder captures that same page surface:

- [`browser-recording.mjs`](../../plugins/codex-browser-recorder/skills/record-browser/scripts/browser-recording.mjs#L99)
  sends `Page.captureScreenshot` with `fromSurface: true`;
- it starts `Page.startScreencast` and uses later frames as page-change
  notifications before taking another page screenshot
  ([same file](../../plugins/codex-browser-recorder/skills/record-browser/scripts/browser-recording.mjs#L303)); and
- [`media-recorder.mjs`](../../plugins/codex-browser-recorder/skills/record-browser/scripts/media-recorder.mjs#L301)
  samples those page JPEGs into FFmpeg.

### 3. Screenshot A/B test confirms cursor omission

On 2026-07-16, a fresh in-app Browser tab opened
`https://the-internet.herokuapp.com/add_remove_elements/`. The Add Element
button measured `x=155, y=104.695, width=147.445, height=46.5`.
After `tab.cua.move({ x: 229, y: 128 })` and a 250 ms wait, the task captured:

| Capture | Bytes | Dimensions | Cursor |
| --- | ---: | ---: | --- |
| `tab.screenshot()` | 17,296 | 1280 x 720 | absent |
| raw `Page.captureScreenshot` | 68,380 | 2560 x 1440 | absent |

The images were inspected inline and not retained. This is a local dynamic
observation, not a public API guarantee, but it matches the installed source.

### 4. An isolated-world binding observes CUA mouse events and coordinates

The dynamically validated sequence was:

1. `Runtime.enable`;
2. `Page.getFrameTree`;
3. choose a unique `worldName` for the recording;
4. `Runtime.addBinding({ name, executionContextName: worldName })`;
5. `Page.createIsolatedWorld({ frameId, worldName,
   grantUniveralAccess: false })`;
6. `Runtime.evaluate({ contextId })` to install capture-phase `window`
   listeners; and
7. `cdp.readEvents({ methods: ["Runtime.bindingCalled"] })`.

The listener sent only a small JSON string containing `type`, `x`, `y`,
`button`, `buttons`, and `timeStamp`. Direct
`tab.cua.move({ x: 229, y: 128 })` followed by a click produced, in order:

```text
mousemove(229,128)
mousemove(229,128)
mousedown(229,128,buttons=1)
mouseup(229,128)
click(229,128)
```

The second `mousemove` is expected because `clickPoint(...)` moves the Browser
UI to the click coordinate again before dispatching press/release.

This path does not append a DOM element, stylesheet, or script to the page and
does not evaluate in the page's main world. It does execute a short-lived
listener in an isolated world, so it should be described precisely as
**isolated-world instrumentation**, not as zero page instrumentation.

CDP formally supports the pieces: `Page.createIsolatedWorld` returns an
execution context; a binding call emits `Runtime.bindingCalled`; and
`Runtime.evaluate` can target that context. The name-scoped binding form is the
officially preferred replacement for deprecated `executionContextId` scoping
and was dynamically verified in the current in-app Browser. It also binds to
future execution contexts with the same world name, which is what allows one
binding registration to survive document reloads.

The page receives only the final CUA move after the private Browser
`ui.moveMouse` arrival completes. Therefore the observed endpoint and click
position are exact, but intermediate pixels of Codex's UI animation are not
observable. The video should use a short deterministic interpolation between
observed endpoints at the existing 10 fps; it must not claim pixel-for-pixel
reproduction of the private Browser cursor animation.

### 5. Locator clicks are observable without an action facade

A Playwright locator click produced:

```text
mousemove(228,127)
mousedown(228,127,buttons=1)
mouseup(228,127)
click(228,127)
```

This was dynamically observed through the same binding. The installed Browser
source independently explains the result: locator click resolution ends in
`Vd.clickLocator(...)`, which delegates the resolved point to
`cua.clickPoint(...)`.

Therefore, isolated-world observation covers the final page coordinates even
when the original public action exposed only a locator selector. DOM CUA click
also reaches `cua.clickPoint(...)` in the installed source, so the same
coverage is a strong inference, but it still requires a dedicated dynamic test
before release.

### 6. Reload destroys the world, while the name-scoped binding persists

An initial context-scoped proof observed `cua.move({ x: 500, y: 320 })` in
isolated `executionContextId: 6`; after reload, recreating the isolated world
as context 10 and recreating the listeners observed
`cua.move({ x: 240, y: 130 })`.

A follow-up used the preferred name-scoped contract. It registered the binding
once with `executionContextName: "codex-browser-recorder-pointer-named-probe"`,
created an isolated world with that same name, and observed
`cua.move({ x: 360, y: 220 })` in context 11. After reload, it did **not** call
`Runtime.addBinding` again; it only recreated the same-named isolated world and
listener in context 15. `cua.move({ x: 380, y: 240 })` was still delivered to
the binding.

The official protocol offers `Page.addScriptToEvaluateOnNewDocument`, but the
installed Browser raw-CDP allowlist blocks that command
(`scripts/browser-client.mjs:193`). Isolated-world and listener recreation
after cross-document `Page.frameNavigated` is therefore required. The binding
itself is registered once per recording and remains available to a recreated
world with the same name. Same-document navigation does not destroy the
execution context and does not require listener recreation.

The Browser client's private implementation uses the same general patterns:
its DOM CUA support creates isolated worlds with
`grantUniveralAccess: false` (`scripts/browser-client.mjs:178`), while its
clipboard bridge combines Runtime bindings, injected listeners, and explicit
teardown (`scripts/browser-client.mjs:3246`). This is useful first-party design
precedent, although the recorder must use only the public raw-CDP capability.

### 7. CDP still has no direct input-command event stream

The Browser CDP capability separates `readEvents()` from `send()`:

- `$CODEX_HOME/plugins/cache/openai-bundled/browser/26.707.72221/docs/capabilities/tab/cdp.md:1-27`

The official Input domain specifies `Input.dispatchMouseEvent` as a command,
not a mouse event notification. The isolated-world binding succeeds by
observing the resulting DOM events, not by intercepting Browser backend
commands. This distinction matters for security, cleanup, and iframe coverage.

## Feasibility matrix

| Approach | Coverage | Page/runtime impact | Stability | Recommendation |
| --- | --- | --- | --- | --- |
| Isolated-world listeners + Runtime binding | CUA and locator page mouse events; DOM CUA inferred | Temporary isolated-world listeners; no DOM or main-world mutation | Uses public raw CDP, but `bindingCalled` and context scoping have protocol-version risk | **Implement now** |
| Recorder-owned CUA facade | Only calls routed through facade | None beyond normal action | Supported CUA | Fallback only |
| `tab.screenshot()` | No cursor | None | Supported | Verification only |
| CDP screenshot/screencast | No cursor | None | Supported after approval | Keep for page frames |
| CDP `readEvents()` without a binding | No action coordinates | None | Supported | Keep for page/navigation events |
| Main-world listener or DOM cursor element | Broad but site-dependent | Mutates page-visible/runtime state | Site-dependent | Reject |
| Patch/eavesdrop private Browser transport | Potentially broad | None | Private implementation | Reject |
| Parse Codex session files | Potentially delayed/incomplete | Privacy-sensitive local reads | Private format | Reject |
| OS/window capture | May include a cursor | OS permission and visible-window dependence | Platform/layout dependent | Reject |
| Future OpenAI action stream or `includeCursor` | Exact supported coverage | None | Not currently available | Preferred future replacement |

## Recommended MVP

### Instrumentation lifecycle

Use one recorder-scoped binding name and isolated-world name in the fresh tab.
The existing process-local recording singleton prevents conflicting sessions,
so another naming subsystem is unnecessary. The recorder owns this lifecycle
inside the existing CDP transaction:

1. capture the shared CDP event cursor baseline;
2. enable `Page` and `Runtime`;
3. verify the approved top-frame origin;
4. use the recorder-owned binding and world names;
5. add the binding once with `executionContextName: worldName`;
6. create the isolated world with `grantUniveralAccess: false`;
7. evaluate an idempotent installer in that context;
8. consume `Runtime.bindingCalled`, frame lifecycle, and Browser-managed target
   lifecycle events in a dedicated ordered cursor pump;
9. recreate only the same-named isolated world/listener after a cross-document
   top-frame navigation before another approved
   action can run; and
10. tear down listeners and remove the single binding before the fresh tab
    closes.

The installer attaches capture-phase listeners for the minimum event set:
`mousemove`, `mousedown`, `mouseup`, `click`, `dblclick`, and `wheel`. It
ignores untrusted page-scripted events and does not capture event targets,
selectors, page text, URLs, keys, deltas, or arbitrary event objects.

A versioned payload should remain small and explicit:

```js
{
  version: 1,
  type: event.type,
  x: event.clientX,
  y: event.clientY,
  button: event.button,
  buttons: event.buttons,
  width: innerWidth,
  height: innerHeight,
  observedAtEpochMs: performance.timeOrigin + event.timeStamp,
}
```

The binding accepts exactly one string, as required by CDP. Reject unknown
binding names, execution contexts, versions, event types, non-finite values,
invalid viewport dimensions, and events that would exceed the bounded
timeline.

### Navigation and readiness

Cross-document navigation creates an observation gap between context
destruction and world/listener recreation. Mark cursor coverage as `rearming`
as soon as the top-frame navigation event arrives, re-verify the approved
origin, and do not permit the next planned Browser action until instrumentation
is `ready`.

Use a short bounded recreation deadline. If the context is destroyed during
setup, retry only for the current verified frame. If recreation does not
finish, fail closed with a stable cursor-coverage error and discard the
recording rather than silently produce a cursor-incomplete video.

An automatic or manual action during the rearming gap cannot be reconstructed.
The fresh-tab, single-controller workflow minimizes that race but cannot prove
source attribution. Instrumented DOM events also do not distinguish CUA input
from a user's manual input in the same page; both should appear in the video if
they occur during the approved recording.

### Event bounds and timing

Read binding and frame-lifecycle events through a dedicated sequential CDP
pump with its own captured event baseline. Continue paging while `hasMore` is
true and keep the existing fail-closed behavior on event-buffer truncation.

Coalesce pending `mousemove` events to the latest animation-frame sample.
Flush that sample before `mousedown`, `mouseup`, `click`, or `dblclick`, which
are never coalesced. Cap accepted events and derive output samples from the
fixed duration and 10 FPS rate; overflow must fail with a stable bounded error
rather than grow memory.

`Runtime.bindingCalled` does not provide a protocol timestamp. Carry the DOM
event occurrence time as `performance.timeOrigin + event.timeStamp`; the live
workflow uses it only to reject delayed events from an earlier approved action.
Separately timestamp each accepted event before geometry work with the
recorder's injected monotonic clock. That recorder-relative timestamp drives
composition across root and OOPIF events without letting geometry latency move
click feedback. The occurrence timestamp is not persisted in the result.

For ordinary CUA `move`, the DOM event contains the final endpoint after the
private Browser UI movement completes, not each animation step. Interpolate
between accepted endpoints only for video presentation. Drag actions may emit
more path points, but the same event and memory bounds still apply.

### Coordinates and iframes

For top-frame events, `clientX/clientY` and CUA coordinates are both CSS pixels
relative to the viewport. Normalize against the isolated world's current
`innerWidth` and `innerHeight`, map to validated output dimensions, and
subtract the cursor sprite hotspot during composition.

Events inside an iframe do not bubble to the top-frame `window`. Full iframe
support requires an isolated listener per frame plus a transform from each
frame's local coordinates to the top viewport. Same-process frames can use
frame-owner geometry; out-of-process and cross-origin frames also require
target/session handling. The installed Browser source has private frame-quad
transform logic (`DOM.getFrameOwner` and `DOM.getContentQuads` in
`scripts/browser-client.mjs:178`), but the recorder must not call that private
logic.

The implemented release takes the second path: public-CDP per-frame
installation, current frame-owner geometry transforms, and Browser-managed
OOPIF target sessions. Any missing geometry, observer, target, timeline, or
cleanup integrity fails closed; iframe actions are never silently published
without a cursor.

### Cleanup

Before removing the binding, evaluate an idempotent teardown function in every
live recorder-owned isolated context to remove the event listeners and delete
the isolated-world state. Then call `Runtime.removeBinding({ name })`.

The CDP specification notes that `Runtime.removeBinding` unsubscribes the
runtime agent from `bindingCalled` notifications but does not remove the
function from the global object. Listener teardown is therefore required for
each isolated context; the remaining isolated context is finally destroyed
when the fresh tab closes. An incomplete teardown fails the recording closed,
while cleanup still attempts to remove every binding.

Do not disable shared CDP domains unless the recorder can prove it enabled them
exclusively. Preserve the current primary-failure and best-effort cleanup
rules, and never persist raw binding payloads with the saved video.

### Cursor composition

Retain a bounded, in-memory normalized cursor timeline and use the already
required FFmpeg for a second pass after page capture:

1. bundle one project-owned transparent cursor sprite with a documented
   hotspot and license;
2. quantize/interpolate movement at the existing 10 fps;
3. generate bounded output-frame overlay expressions directly in memory;
4. overlay the fixed project-owned cursor and 200 ms click ring;
5. encode the final H.264 `yuv420p` MP4 into a private partial file;
6. run existing validation and atomic artifact commit; and
7. remove the page-only intermediate and composition partials on every success,
   cancellation, and failure path.

The current recording limit is 10 fps and at most 65 seconds
([`recording-policy.mjs`](../../plugins/codex-browser-recorder/skills/record-browser/scripts/recording-policy.mjs#L1)),
so the final schedule is bounded to about 650 output samples.

A local FFmpeg proof and the installed-browser recording both decoded with the
expected cursor positions. The production compositor uses frame-evaluated
overlay expressions, avoiding a separate command file or command-target
protocol.

### Small implementation surface

Preserve the current deep-module design with one focused cursor module and two
small assets:

- `cursor-recording.mjs`: isolated-world lifecycle, payload validation,
  bounded timeline, coordinate normalization, composition, and teardown;
- one project-owned cursor XPM and one click-ring XPM;
- small wiring changes in `browser-recording.mjs`, `create-recording.mjs`, and
  the existing policy/outcome modules; and
- focused unit/integration tests.

Do not add a service, event bus, database, native screen-capture layer,
main-world framework, or persistent telemetry store.

## Submission validation coverage

1. **CUA parity:** move and click events match CUA coordinates and ordering.
2. **Locator parity:** locator click yields resolved coordinates and click
   lifecycle; dynamically test DOM CUA as well.
3. **Isolation:** the binding and recorder state are absent from the page's main
   world; no DOM nodes, styles, text, or page globals are changed.
4. **Reload:** context destruction, rearming, and the first
   post-reload action are captured without a gap.
5. **Race handling:** action attempts while rearming fail closed; context loss
   and event-buffer truncation discard the video.
6. **Bounds:** reject malformed/oversized payloads, coalesce duplicate moves,
   and enforce raw-event and output-sample caps.
7. **Static page:** cursor movement remains visible without page repaint.
8. **Viewport/DPR:** verify CSS coordinates map correctly for DPR 1 and DPR 2,
   resize, zoom, and scroll.
9. **Iframe policy:** prove public-CDP transforms or prove planned iframe
   interactions are rejected before recording.
10. **Cleanup:** teardown listeners, remove binding subscriptions, close the
    fresh tab, and delete intermediate media/command artifacts on all outcomes.
11. **Video E2E:** record Add Element, three adds, and one delete; decode frames
    and verify cursor position and click indication before each page result.
12. **Full gate:** syntax, tests, coverage, plugin validation, release
    readiness, installation, and submission evals all pass.

## Remaining limitations and upstream API request

The recommended observer reconstructs page-delivered pointer activity, not the
exact proprietary Browser cursor bitmap. Its remaining limitations are:

- source attribution: page events cannot distinguish Codex CUA from manual
  input in the same tab;
- navigation gaps: instrumentation must be rebuilt after every cross-document
  top-frame navigation;
- iframe scope: each frame needs its own listener and coordinate transform;
- protocol evolution: `Runtime.bindingCalled` is experimental, although the
  implementation uses the preferred `executionContextName` binding scope; and
- animation fidelity: page events expose exact endpoints/clicks but not the
  private UI cursor's intermediate trajectory;
- browser-level movement outside the webpage surface has no DOM event.

The preferred upstream replacement remains a supported, tab-scoped pointer
event capability with monotonic sequence/timestamps, or
`tab.screenshot({ includeCursor: true })`/a recording capability that explicitly
includes the Computer Use cursor layer. Until then, isolated-world
instrumentation plus bounded FFmpeg composition is the most complete,
privacy-limited, and professional option available through the current public
CDP capability.
