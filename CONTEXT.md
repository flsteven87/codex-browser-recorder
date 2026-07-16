# Browser Recording

This context describes the user-authorized capture and delivery of a Browser recording.

## Language

**Recording Session**:
One user-authorized attempt to capture page content from a single approved Browser tab.
_Avoid_: Capture job, recorder run

**Working Recording**:
Provisional media produced during a Recording Session that has not yet been validated and delivered. It is not a successful user outcome and may be discarded.
_Avoid_: Saved recording, final recording

**Saved Recording**:
A validated recording delivered to a user-approved, durable location where the user can find and retain it. This is the successful product outcome.
_Avoid_: Temporary recording, working output

**Cursor-complete Recording**:
A recording in which every pointer action in the top-level page and its embedded frames is represented by a synchronized visible cursor. The recorder observes every frame it can reliably instrument through public CDP APIs; if any participating frame cannot be observed or its cursor timeline cannot be preserved, the Recording Session fails closed. Only cursor-complete media may become a Saved Recording.
_Avoid_: Page-only recording, cursor-optional recording
