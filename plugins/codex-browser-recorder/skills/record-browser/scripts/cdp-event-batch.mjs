export function normalizeCdpEventBatch(batch, currentCursor) {
  if (
    batch === null ||
    typeof batch !== "object" ||
    !Number.isInteger(batch.cursor) ||
    batch.cursor < 0 ||
    (currentCursor !== undefined && batch.cursor < currentCursor) ||
    !Array.isArray(batch.events) ||
    (batch.hasMore !== undefined && typeof batch.hasMore !== "boolean") ||
    (batch.truncated !== undefined && typeof batch.truncated !== "boolean")
  ) {
    return null;
  }

  const { cursor, events, hasMore, truncated } = batch;
  return Object.freeze({ cursor, events, hasMore, truncated });
}
