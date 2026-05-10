export function createTranscriptTurnQueue({
  runTurn,
  debounceMs = 150,
  isReady = (_text) => true,
  // Optional: when a new ready chunk arrives while a turn is in flight, the
  // queue calls cancelInflight(nextText). If it returns true, the caller is
  // expected to abort the in-flight turn ASAP; we still buffer the new text so
  // the post-cancel drain picks it up. Returning false (default) preserves the
  // original semantics — the in-flight turn runs to completion and the next
  // text waits in `buffered`.
  cancelInflight = null,
}) {
  let running = false;
  let buffered = [];
  let current = Promise.resolve();
  // Pending bucket holds chunks that arrived too recently to fire yet. Waiting
  // a short window lets bursts of small transcript chunks coalesce into one
  // turn. The isReady predicate gates whether the accumulated buffer has
  // enough substantive content to actually fire - if not, we keep accumulating
  // until the next chunk arrives.
  let pending = [];
  let debounceTimer = null;

  function flushPending({ force = false } = {}) {
    debounceTimer = null;
    if (pending.length === 0) return;
    const text = pending.join("\n");
    if (!force && !isReady(text)) {
      // Not enough content yet - keep pending, wait for more chunks. The next
      // enqueue will restart the debounce timer and we'll re-check then.
      return;
    }
    pending = [];
    if (running) {
      buffered.push(text);
      // Try to cancel the in-flight turn so the agent re-runs with the freshest
      // context instead of finishing on stale input. The actual abort happens
      // inside cancelInflight; the runTurn promise will reject/resolve and the
      // existing drain() loop picks up `buffered` to start the next turn.
      if (typeof cancelInflight === "function") {
        try { cancelInflight(text); } catch { /* swallow */ }
      }
    } else {
      current = drain(text);
    }
  }

  async function drain(text) {
    running = true;
    try {
      await runTurn(text);
    } finally {
      if (buffered.length > 0) {
        const next = buffered.join("\n");
        buffered = [];
        current = drain(next);
      } else {
        running = false;
        // If pending arrived during the turn and is now ready, flush it. If
        // it's still not ready (only fillers), leave it accumulating.
        if (pending.length > 0) {
          if (debounceTimer) clearTimeout(debounceTimer);
          flushPending();
        }
      }
    }
  }

  function enqueue(text) {
    const trimmed = text.trim();
    if (!trimmed) return current;
    pending.push(trimmed);
    if (debounceMs > 0) {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(flushPending, debounceMs);
    } else {
      flushPending();
    }
    return current;
  }

  async function idle() {
    // Force-flush any pending content (bypassing isReady) so idle() always
    // terminates - tests and shutdown paths shouldn't hang on a buffer that
    // happens to contain only fillers.
    while (debounceTimer || running || buffered.length > 0 || pending.length > 0) {
      if (debounceTimer || pending.length > 0) {
        if (debounceTimer) clearTimeout(debounceTimer);
        flushPending({ force: true });
      }
      await current;
    }
  }

  return { enqueue, idle };
}
