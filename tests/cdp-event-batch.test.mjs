import assert from "node:assert/strict";
import test from "node:test";

import { normalizeCdpEventBatch } from "../plugins/codex-browser-recorder/skills/record-browser/scripts/cdp-event-batch.mjs";

test("normalizes and freezes a complete CDP event batch", () => {
  const events = [{ method: "Page.screencastFrame" }];
  const batch = normalizeCdpEventBatch(
    {
      cursor: 4,
      events,
      extra: "ignored",
      hasMore: false,
      truncated: false,
    },
    3,
  );

  assert.deepEqual(batch, {
    cursor: 4,
    events,
    hasMore: false,
    truncated: false,
  });
  assert.equal(Object.isFrozen(batch), true);
});

test("allows omitted optional CDP event batch flags", () => {
  assert.deepEqual(normalizeCdpEventBatch({ cursor: 0, events: [] }), {
    cursor: 0,
    events: [],
    hasMore: undefined,
    truncated: undefined,
  });
});

test("rejects incomplete or malformed CDP event batches", () => {
  const invalidBatches = [
    null,
    "batch",
    {},
    { cursor: -1, events: [] },
    { cursor: 1.5, events: [] },
    { cursor: 1, events: null },
    { cursor: 1, events: [], hasMore: "false" },
    { cursor: 1, events: [], truncated: 1 },
  ];

  for (const batch of invalidBatches) {
    assert.equal(normalizeCdpEventBatch(batch), null);
  }
  assert.equal(normalizeCdpEventBatch({ cursor: 2, events: [] }, 3), null);
});

test("distinguishes an invalid batch from a valid truncated batch", () => {
  const truncated = normalizeCdpEventBatch({
    cursor: 2,
    events: [],
    hasMore: true,
    truncated: true,
  });

  assert.equal(normalizeCdpEventBatch({ cursor: "2", events: [] }), null);
  assert.equal(truncated?.truncated, true);
});
