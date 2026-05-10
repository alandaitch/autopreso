// @ts-nocheck
// End-to-end test of the live transcript -> agent -> whiteboard update flow,
// driving everything from a fake transcription provider so we can simulate
// continuous speech and verify (1) the canvas updates at all, (2) latency
// behaves sensibly, and (3) in-flight cancellation reroll works as designed.
import assert from "node:assert/strict";
import { test } from "node:test";
import { WebSocket } from "ws";

import { startServer } from "../src/server.js";

function wsUrl(httpUrl) {
  return httpUrl.replace("http:", "ws:") + "/ws";
}

function waitForMessage(ws, predicate, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.off("message", handler);
      reject(new Error("waitForMessage timed out"));
    }, timeoutMs);
    const handler = (raw) => {
      const msg = JSON.parse(raw.toString());
      if (predicate(msg)) {
        clearTimeout(timer);
        ws.off("message", handler);
        resolve(msg);
      }
    };
    ws.on("message", handler);
  });
}

function collectMessages(ws) {
  const messages = [];
  ws.on("message", (raw) => messages.push(JSON.parse(raw.toString())));
  return messages;
}

// buildWhiteboardAgentMessages emits two user messages per turn — the speaker
// turn (formatSpeakerTurn output starts with "Speaker turn:") followed by the
// canvas task message. Tests want the speaker turn so they can assert what the
// agent was reacting to.
function extractSpeakerTurn(messages) {
  for (const m of messages) {
    if (m.role !== "user") continue;
    const text =
      typeof m.content === "string"
        ? m.content
        : Array.isArray(m.content)
          ? m.content.find((p) => p.type === "text")?.text ?? ""
          : "";
    if (text.startsWith("Speaker turn:")) {
      return text.replace(/^Speaker turn:\s*/, "");
    }
  }
  return null;
}

function makeFakeTranscription() {
  const fake = {
    queueTranscript: null,
    feedTranscript: () => {
      throw new Error("fake transcription factory wasn't invoked yet");
    },
    factory: null,
  };
  fake.factory = ({ queueTranscript }) => {
    fake.queueTranscript = queueTranscript;
    fake.feedTranscript = (text) => queueTranscript(text);
    return {
      ready: async () => {},
      sendAudio: () => {},
      stop: () => {},
      close: () => {},
    };
  };
  return fake;
}

async function harness({ generateTextFn, agentLatencyMs = 0 } = {}) {
  const fake = makeFakeTranscription();
  const opts = {
    host: "127.0.0.1",
    port: 0,
    moonshineModel: "medium",
    openaiApiKey: "test-key",
    createTranscription: fake.factory,
  };
  if (generateTextFn) opts.generateTextFn = generateTextFn;
  const server = await startServer(opts);
  // Force live mode without going through the warmup primer round-trip.
  // The warmup loop blocks the queue until it resolves; for these tests we
  // just want raw turn behavior.
  server.state.mode = "live";
  server.state.warmupPromise = Promise.resolve();
  const ws = new WebSocket(wsUrl(server.url));
  await new Promise((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });
  return {
    ...server,
    fake,
    ws,
    close: async () => {
      ws.close();
      await new Promise((r) => server.httpServer.close(r));
    },
  };
}

// Build a generateTextFn stub that pretends the model called whiteboard_apply
// with a single rectangle. Records every call so the test can assert.
function makeDrawingStub({ delayMs = 0, label = "Note" } = {}) {
  const calls = [];
  let counter = 0;
  const fn = async ({ messages, tools, abortSignal }) => {
    counter += 1;
    const myCall = { id: counter, transcript: null, aborted: false, completedAt: null };
    // Pull the latest user transcript out of the messages so the assertion can
    // see what the agent was responding to.
    myCall.transcript = extractSpeakerTurn(messages);
    calls.push(myCall);
    if (delayMs > 0) {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, delayMs);
        if (abortSignal) {
          abortSignal.addEventListener("abort", () => {
            clearTimeout(timer);
            myCall.aborted = true;
            const err = new Error("Aborted");
            err.name = "AbortError";
            reject(err);
          });
        }
      });
    }
    // Invoke the actual tool execute fn so the broadcast loop fires.
    const id = `note-${counter}`;
    await tools.whiteboard_apply.execute({
      operations: [
        {
          type: "insert_after",
          line: 0,
          element: {
            id,
            type: "rectangle",
            x: counter * 100,
            y: 0,
            width: 80,
            height: 40,
            label: { text: `${label} ${counter}` },
          },
        },
      ],
    });
    myCall.completedAt = Date.now();
    return { text: "DONE", finishReason: "stop" };
  };
  return { fn, calls };
}

test("realtime: a single transcript triggers a whiteboard:update broadcast", async () => {
  const { fn, calls } = makeDrawingStub();
  const h = await harness({ generateTextFn: fn });
  try {
    const updatePromise = waitForMessage(
      h.ws,
      (m) => m.type === "whiteboard:update",
      3000,
    );
    h.fake.feedTranscript("OpenAI just released a new model");
    const msg = await updatePromise;
    assert.equal(calls.length, 1);
    assert.equal(calls[0].transcript?.includes("OpenAI"), true);
    assert.equal(Array.isArray(msg.elements), true);
    assert.equal(msg.elements.length, 1);
    assert.equal(msg.elements[0].id, "note-1");
  } finally {
    await h.close();
  }
});

test("realtime: rapid transcripts during a slow turn are buffered AND eventually drawn", async () => {
  // Agent takes 300ms — slow enough that 3 transcripts will land while it's running.
  const { fn, calls } = makeDrawingStub({ delayMs: 300 });
  const h = await harness({ generateTextFn: fn });
  try {
    h.fake.feedTranscript("first");
    await new Promise((r) => setTimeout(r, 50));
    h.fake.feedTranscript("second");
    await new Promise((r) => setTimeout(r, 50));
    h.fake.feedTranscript("third");

    // Drain.
    await h.state.idle();
    // We expect: 1st turn ran for "first" (got cancelled because no draw yet),
    // then a fresh turn ran on combined "first\nsecond\nthird" (or similar),
    // OR if the first turn drew first, it ran to completion and the rest
    // queued. Either way, the combined content of all transcripts should land.
    const drawnTexts = h.state.elements
      .map((el) => el.label?.text || el.text)
      .filter(Boolean);
    assert.ok(drawnTexts.length >= 1, "expected at least one drawing");
    // The agent must have been invoked at least once with the LAST transcript.
    const sawAllThree = calls.some((c) => c.transcript?.includes("third"));
    assert.ok(sawAllThree, `agent should have seen 'third' in some call (calls=${JSON.stringify(calls.map((c) => c.transcript))})`);
  } finally {
    await h.close();
  }
});

test("realtime: cancelled turn's words are re-merged into the next turn (not lost)", async () => {
  // First call: takes 200ms, never draws, gets cancelled.
  // Second call: should see BOTH "first" AND "second" in its transcript.
  const seenTranscripts = [];
  let counter = 0;
  const fn = async ({ messages, abortSignal, tools }) => {
    counter += 1;
    const myId = counter;
    const transcript = extractSpeakerTurn(messages);
    seenTranscripts.push({ id: myId, transcript });
    if (myId === 1) {
      // First turn: stall 200ms, then would draw — but expect to be aborted first.
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => resolve({ text: "DONE", finishReason: "stop" }), 200);
        abortSignal?.addEventListener("abort", () => {
          clearTimeout(timer);
          const e = new Error("Aborted"); e.name = "AbortError"; reject(e);
        });
      });
    }
    // Second turn: draw immediately so we can assert it ran with combined text.
    await tools.whiteboard_apply.execute({
      operations: [{
        type: "insert_after", line: 0,
        element: { id: "ok", type: "rectangle", x: 0, y: 0, width: 60, height: 40, label: { text: "ok" } },
      }],
    });
    return { text: "DONE", finishReason: "stop" };
  };
  const h = await harness({ generateTextFn: fn });
  try {
    h.fake.feedTranscript("first");
    await new Promise((r) => setTimeout(r, 50)); // give turn 1 time to start (but not finish)
    h.fake.feedTranscript("second");
    await h.state.idle();
    const second = seenTranscripts.find((t) => t.id === 2);
    assert.ok(second, "expected a second turn to run after cancel");
    // Both fragments must be present in the merged transcript.
    assert.match(second.transcript, /first/);
    assert.match(second.transcript, /second/);
  } finally {
    await h.close();
  }
});

test("realtime: a model that returned DONE quickly (no draw) does NOT get retroactively cancelled", async () => {
  // Without onModelReturned locking the turn in, a fast no-draw turn followed
  // immediately by a fresh chunk would be aborted post-hoc, the cancelled-text
  // recovery would re-prepend its transcript, and we'd grow an endless
  // super-turn instead of letting each chunk run as its own turn.
  // Model returns at 30ms; chunk 2 arrives at 60ms. Second turn must see ONLY
  // "second" — the first turn is finished, no merge.
  const seen = [];
  let counter = 0;
  const drawingFn = async ({ messages }) => {
    counter += 1;
    seen.push({ id: counter, transcript: extractSpeakerTurn(messages) });
    await new Promise((r) => setTimeout(r, 30));
    return { text: "DONE", finishReason: "stop" };
  };
  const hMid = await harness({ generateTextFn: drawingFn });
  try {
    hMid.fake.feedTranscript("first");
    await new Promise((r) => setTimeout(r, 60));
    hMid.fake.feedTranscript("second");
    await hMid.state.idle();
    const second = seen.find((s) => s.id === 2);
    assert.ok(second, `expected a second turn, got: ${JSON.stringify(seen)}`);
    assert.equal(second.transcript, "second", `second turn should see only 'second' (got: ${JSON.stringify(second.transcript)})`);
  } finally {
    await hMid.close();
  }
});

test("realtime: in-flight turn IS cancelled while the model is still thinking", async () => {
  // Agent stalls 200ms before returning; chunk 2 arrives at 50ms. That's
  // squarely inside the model-thinking window where cancellation is useful.
  const aborts = [];
  const fn = async ({ messages, abortSignal }) => {
    const t = extractSpeakerTurn(messages);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => resolve({ text: "DONE", finishReason: "stop" }), 200);
      abortSignal?.addEventListener("abort", () => {
        clearTimeout(timer);
        aborts.push(t);
        const err = new Error("Aborted");
        err.name = "AbortError";
        reject(err);
      });
    });
  };
  const h = await harness({ generateTextFn: fn });
  try {
    h.fake.feedTranscript("first");
    await new Promise((r) => setTimeout(r, 50));
    h.fake.feedTranscript("second");
    await h.state.idle();
    assert.ok(aborts.includes("first"), `expected 'first' to be aborted, aborts=${JSON.stringify(aborts)}`);
  } finally {
    await h.close();
  }
});

test("realtime: full flow via POST /api/preso/start + queueTranscript draws something", async () => {
  // Reproduces the exact path the browser takes: hit /api/preso/start, then
  // a transcript arrives via the (stubbed) transcription provider, and we
  // expect a whiteboard:update broadcast within a few seconds.
  const { fn, calls } = makeDrawingStub({ label: "FullFlow" });
  const fake = makeFakeTranscription();
  const server = await startServer({
    host: "127.0.0.1",
    port: 0,
    moonshineModel: "medium",
    openaiApiKey: "test-key",
    createTranscription: fake.factory,
    generateTextFn: fn,
    // Skip the multi-attempt warmup so the test doesn't sit through delays.
    warmupMaxAttempts: 1,
    warmupDelays: [0],
  });
  const ws = new WebSocket(wsUrl(server.url));
  await new Promise((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });
  try {
    const startResp = await fetch(`${server.url}/api/preso/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ stagingElements: [] }),
    });
    assert.equal(startResp.ok, true, `preso/start failed: ${startResp.status} ${await startResp.text()}`);
    await server.state.warmupPromise;
    const updatePromise = waitForMessage(ws, (m) => m.type === "whiteboard:update" && Array.isArray(m.elements) && m.elements.length > 0, 5000);
    fake.feedTranscript("Hello from the integration test");
    const msg = await updatePromise;
    assert.ok(msg.elements.length >= 1, "expected at least one drawn element");
    assert.ok(calls.length >= 1, "agent stub should have been invoked at least once");
  } finally {
    ws.close();
    await new Promise((r) => server.httpServer.close(r));
  }
});

test("realtime: turn that already drew is NOT cancelled by a follow-up transcript", async () => {
  // Agent draws at 50ms, then "thinks" until 250ms. A second transcript at
  // 100ms must NOT abort the in-flight turn.
  const finishedTurns = [];
  let counter = 0;
  const fn = async ({ messages, tools, abortSignal }) => {
    counter += 1;
    const myId = counter;
    const t = extractSpeakerTurn(messages);
    // Draw early.
    await new Promise((r) => setTimeout(r, 50));
    if (abortSignal?.aborted) {
      const e = new Error("Aborted"); e.name = "AbortError"; throw e;
    }
    await tools.whiteboard_apply.execute({
      operations: [{
        type: "insert_after", line: 0,
        element: { id: `t${myId}`, type: "rectangle", x: 0, y: myId * 50, width: 60, height: 40, label: { text: `T${myId}` } },
      }],
    });
    // Pretend more thinking.
    await new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, 200);
      abortSignal?.addEventListener("abort", () => {
        clearTimeout(timer);
        const e = new Error("Aborted"); e.name = "AbortError"; reject(e);
      });
    });
    finishedTurns.push({ id: myId, transcript: t });
    return { text: "DONE", finishReason: "stop" };
  };
  const h = await harness({ generateTextFn: fn });
  try {
    h.fake.feedTranscript("alpha");
    await new Promise((r) => setTimeout(r, 100)); // give first turn time to draw
    h.fake.feedTranscript("beta");
    await h.state.idle();
    // First turn drew + completed; second turn drew + completed.
    assert.equal(finishedTurns.length, 2, `expected both turns to finish, got ${JSON.stringify(finishedTurns)}`);
  } finally {
    await h.close();
  }
});
