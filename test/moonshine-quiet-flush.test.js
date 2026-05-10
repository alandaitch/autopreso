// @ts-nocheck
// Verifies the new mid-utterance flush logic in moonshine-transcription.js:
// - quiet timer flushes the partial as a turn after partialQuietMs.
// - max-words cap flushes when the partial reaches the threshold.
// - max-time cap flushes after partialStartedAt elapses.
// - flushedPrefix prevents double-queueing already-flushed text on subsequent
//   flushes within the same Moonshine utterance.
// - committed events emit only the unsent suffix.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";

import { createMoonshineTranscription } from "../src/moonshine-transcription.js";

function mkChild() {
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  const stdin = { write: () => {}, end: () => {} };
  const child = new EventEmitter();
  child.stdout = stdout;
  child.stderr = stderr;
  child.stdin = stdin;
  child.kill = () => child.emit("close", 0);
  return { child, stdout, stderr };
}

function mkTranscription(extraOpts = {}) {
  const { child, stdout } = mkChild();
  const messages = [];
  const queued = [];
  const transcription = createMoonshineTranscription({
    sendTranscript: (m) => messages.push(m),
    queueTranscript: (text) => queued.push(text),
    options: { moonshineModel: "medium", ...extraOpts },
    spawnProcess: () => child,
    resolveSidecarPath: () => "/tmp/autopreso-moonshine",
  });
  // Trigger spawn by sending one audio frame, then signal ready.
  transcription.sendAudio("xxx");
  stdout.emit("data", Buffer.from('{"type":"ready"}\n'));
  return { transcription, stdout, messages, queued };
}

test("quiet timer: partial that stops growing for partialQuietMs gets flushed as a turn", async () => {
  const { stdout, queued, messages } = mkTranscription({ moonshinePartialQuietMs: 50 });
  stdout.emit("data", Buffer.from('{"type":"transcript:partial","text":"hello world"}\n'));
  await new Promise((r) => setTimeout(r, 100));
  assert.deepEqual(queued, ["hello world"]);
  assert.ok(messages.some((m) => m.type === "transcript:committed" && m.text === "hello world"));
});

test("max-words cap: partial that grows past the word threshold flushes immediately", async () => {
  const { stdout, queued } = mkTranscription({
    moonshinePartialQuietMs: 5000, // long enough that quiet timer won't fire in this test
    moonshineMaxPartialWords: 3,
  });
  // Three words → triggers cap.
  stdout.emit("data", Buffer.from('{"type":"transcript:partial","text":"one two three"}\n'));
  await Promise.resolve();
  assert.deepEqual(queued, ["one two three"]);
});

test("max-time cap: partial older than maxPartialMs flushes even with no new tokens", async () => {
  const { stdout, queued } = mkTranscription({
    moonshinePartialQuietMs: 5000,
    moonshineMaxPartialWords: 999,
    moonshineMaxPartialMs: 60,
  });
  stdout.emit("data", Buffer.from('{"type":"transcript:partial","text":"a"}\n'));
  await new Promise((r) => setTimeout(r, 80));
  // The cap is checked when a partial event arrives, so emit a tiny growth.
  stdout.emit("data", Buffer.from('{"type":"transcript:partial","text":"a b"}\n'));
  await Promise.resolve();
  assert.deepEqual(queued, ["a b"]);
});

test("flushedPrefix: subsequent partials within the same utterance only queue the new suffix", async () => {
  const { stdout, queued } = mkTranscription({
    moonshinePartialQuietMs: 5000,
    moonshineMaxPartialWords: 2, // cap at 2 words for fast trigger
  });
  stdout.emit("data", Buffer.from('{"type":"transcript:partial","text":"hello world"}\n'));
  await Promise.resolve();
  // First flush queues "hello world".
  assert.deepEqual(queued, ["hello world"]);
  // Moonshine keeps growing partial WITHIN the same utterance.
  stdout.emit("data", Buffer.from('{"type":"transcript:partial","text":"hello world how are"}\n'));
  await Promise.resolve();
  // Second cap flush should ONLY queue the new suffix.
  assert.deepEqual(queued, ["hello world", "how are"]);
});

test("committed after a mid-utterance flush emits only the unsent suffix", async () => {
  const { stdout, queued } = mkTranscription({
    moonshinePartialQuietMs: 5000,
    moonshineMaxPartialWords: 2,
  });
  stdout.emit("data", Buffer.from('{"type":"transcript:partial","text":"hello world"}\n'));
  await Promise.resolve();
  // Now Moonshine commits the full utterance — we already flushed the prefix.
  stdout.emit("data", Buffer.from('{"type":"transcript:committed","text":"hello world how are you"}\n'));
  await Promise.resolve();
  assert.deepEqual(queued, ["hello world", "how are you"]);
});

test("committed without prior mid-utterance flush queues the full text once", async () => {
  const { stdout, queued } = mkTranscription({
    moonshinePartialQuietMs: 5000,
    moonshineMaxPartialWords: 999,
  });
  stdout.emit("data", Buffer.from('{"type":"transcript:partial","text":"a b c"}\n'));
  stdout.emit("data", Buffer.from('{"type":"transcript:committed","text":"a b c d"}\n'));
  await Promise.resolve();
  assert.deepEqual(queued, ["a b c d"]);
});

test("Moonshine that diverges from the flushed prefix falls back to emitting full text", async () => {
  const { stdout, queued } = mkTranscription({
    moonshinePartialQuietMs: 5000,
    moonshineMaxPartialWords: 2,
  });
  stdout.emit("data", Buffer.from('{"type":"transcript:partial","text":"hola mundo"}\n'));
  await Promise.resolve();
  // Moonshine corrects the previous partial to something different. Our
  // prefix-stripping startsWith check fails, so we emit the full corrected
  // text. (Acceptable duplication: an honest correction should NOT be
  // suppressed because the previous flush was based on stale wording.)
  stdout.emit("data", Buffer.from('{"type":"transcript:committed","text":"hola amigo cómo estás"}\n'));
  await Promise.resolve();
  assert.deepEqual(queued, ["hola mundo", "hola amigo cómo estás"]);
});
