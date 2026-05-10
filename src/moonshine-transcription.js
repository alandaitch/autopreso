import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);
const SAMPLE_RATE = 24000;
// If the rolling partial transcript hasn't grown for this long, treat it as
// a turn even if Moonshine itself hasn't emitted `transcript:committed` yet.
// Without this, the agent only acts on the model's natural utterance breaks
// (which require ~1s of silence), and continuous speech never triggers it.
const DEFAULT_PARTIAL_QUIET_MS = 700;
// Continuous speech caps. Without these, a long monologue accumulates into one
// huge turn and the agent has nothing on screen until the speaker finally pauses.
// Flushing on either threshold keeps the canvas reactive (~every 4s or 12 words);
// the agent is built to refine prior elements on the next turn, so a partially
// transcribed first turn is fine — it gets corrected as more arrives.
const DEFAULT_MAX_PARTIAL_WORDS = 12;
const DEFAULT_MAX_PARTIAL_MS = 4000;
const SIDECAR_PACKAGE_BY_PLATFORM = new Map([
  ["darwin:arm64", "@autopreso/moonshine-darwin-arm64"],
  ["darwin:x64", "@autopreso/moonshine-darwin-x64"],
]);

export function moonshinePlatformPackageName(platform = process.platform, arch = process.arch) {
  const packageName = SIDECAR_PACKAGE_BY_PLATFORM.get(`${platform}:${arch}`);
  if (!packageName) {
    throw new Error("Moonshine local transcription is currently available for macOS arm64 and x64.");
  }
  return packageName;
}

export function resolveMoonshineSidecarPath({
  env = process.env,
  platform = process.platform,
  arch = process.arch,
  requireResolve = require.resolve,
} = {}) {
  if (env.AUTOPRESO_MOONSHINE_BIN) return env.AUTOPRESO_MOONSHINE_BIN;

  const packageName = moonshinePlatformPackageName(platform, arch);
  const packageJsonPath = requireResolve(`${packageName}/package.json`);
  return path.join(path.dirname(packageJsonPath), "bin", "autopreso-moonshine");
}

export function createMoonshineTranscription({
  sendTranscript,
  queueTranscript,
  options,
  spawnProcess = spawn,
  resolveSidecarPath = () => resolveMoonshineSidecarPath(),
}) {
  let child = null;
  let stdoutBuffer = "";
  let stderrBuffer = "";
  let readyPromise = null;
  let resolveReady = null;
  let rejectReady = null;
  let partialText = "";
  let partialStartedAt = 0;
  // Mid-utterance flushes (caps / quiet timer) are virtual — Moonshine itself
  // keeps growing the same partial until it commits. Track what we've already
  // queued so the next flush emits only the unsent suffix instead of repeating
  // the whole partial as a new turn.
  let flushedPrefix = "";
  let lastQueuedText = "";
  let quietTimer = null;
  const partialQuietMs = Number.isFinite(options?.moonshinePartialQuietMs)
    ? options.moonshinePartialQuietMs
    : DEFAULT_PARTIAL_QUIET_MS;
  const maxPartialWords = Number.isFinite(options?.moonshineMaxPartialWords)
    ? options.moonshineMaxPartialWords
    : DEFAULT_MAX_PARTIAL_WORDS;
  const maxPartialMs = Number.isFinite(options?.moonshineMaxPartialMs)
    ? options.moonshineMaxPartialMs
    : DEFAULT_MAX_PARTIAL_MS;

  function cancelQuietTimer() {
    if (quietTimer) {
      clearTimeout(quietTimer);
      quietTimer = null;
    }
  }

  function flushPartialAsTurn() {
    cancelQuietTimer();
    const text = partialText.trim();
    if (!text) return;
    const newText = text.startsWith(flushedPrefix)
      ? text.slice(flushedPrefix.length).trim()
      : text;
    if (!newText || newText === lastQueuedText) return;
    flushedPrefix = text;
    lastQueuedText = newText;
    partialStartedAt = 0;
    sendTranscript({ type: "transcript:committed", text: newText });
    queueTranscript(newText);
  }

  function partialExceededCaps(text) {
    if (maxPartialWords > 0) {
      const wordCount = text.trim().split(/\s+/).filter(Boolean).length;
      if (wordCount >= maxPartialWords) return true;
    }
    if (maxPartialMs > 0 && partialStartedAt > 0) {
      if (Date.now() - partialStartedAt >= maxPartialMs) return true;
    }
    return false;
  }

  function scheduleQuietFlush() {
    cancelQuietTimer();
    if (partialQuietMs <= 0) return;
    quietTimer = setTimeout(() => {
      quietTimer = null;
      flushPartialAsTurn();
    }, partialQuietMs);
  }
  // After a sidecar crash, sendAudio respawns and the new process can die before
  // its stdin write returns, surfacing EPIPE on the next event-loop tick. Latch
  // the failure so we stop respawning until applyCurrent rebuilds us cleanly.
  let failed = false;
  let lastError = null;

  function ensureChild() {
    if (child) return child;
    if (failed) return null;

    const binary = resolveSidecarPath();
    readyPromise = new Promise((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    const language = options.moonshineLanguage || "en";
    child = spawnProcess(binary, ["--model", options.moonshineModel, "--language", language], {
      stdio: ["pipe", "pipe", "pipe"],
    });

    // EPIPE on stdin is expected if the child died between our last write and now.
    // Swallow it — the close handler below already surfaces the underlying error.
    // (Defensive .on call: tests mock stdin as a plain object without EventEmitter.)
    if (typeof child.stdin?.on === "function") {
      child.stdin.on("error", (error) => {
        if (/** @type {NodeJS.ErrnoException} */ (error).code !== "EPIPE") {
          sendTranscript({ type: "error", message: error.message });
        }
      });
    }

    child.stdout.on("data", (chunk) => {
      stdoutBuffer += chunk.toString("utf8");
      const lines = stdoutBuffer.split("\n");
      stdoutBuffer = lines.pop() ?? "";
      for (const line of lines) {
        handleSidecarLine(line, {
          sendTranscript,
          onReady: () => {
            // Once the sidecar is healthy, clear the failure latch and stderr buffer.
            failed = false;
            stderrBuffer = "";
            resolveReady?.();
          },
          onPartial: (text) => {
            // Re-arm the quiet timer on every partial growth. When deltas stop
            // arriving for partialQuietMs, flushPartialAsTurn fires and the
            // agent turn runs without waiting for Moonshine to commit on its own.
            if (text === partialText) return;
            if (!partialText && text) partialStartedAt = Date.now();
            partialText = text;
            if (!text) {
              partialStartedAt = 0;
              cancelQuietTimer();
              return;
            }
            // Cap: continuous speech with no pause should still produce frequent
            // turns so the canvas updates while the speaker keeps talking.
            if (partialExceededCaps(text)) {
              flushPartialAsTurn();
              return;
            }
            scheduleQuietFlush();
          },
          onCommitted: (text) => {
            // Moonshine's own utterance break beat us to it. Cancel the quiet
            // timer, emit only the unsent suffix (anything already flushed
            // mid-utterance was sent as its own turn), and reset partial state.
            cancelQuietTimer();
            partialText = "";
            partialStartedAt = 0;
            const trimmed = text.trim();
            const newText = trimmed.startsWith(flushedPrefix)
              ? trimmed.slice(flushedPrefix.length).trim()
              : trimmed;
            // Utterance closed: drop the prefix tracker so the next utterance
            // starts fresh regardless of what Moonshine emits.
            flushedPrefix = "";
            if (!newText || newText === lastQueuedText) return;
            lastQueuedText = newText;
            sendTranscript({ type: "transcript:committed", text: newText });
            queueTranscript(newText);
          },
        });
      }
    });

    child.stderr.on("data", (chunk) => {
      const text = chunk.toString("utf8");
      stderrBuffer += text;
      const message = text.trim();
      if (message) sendTranscript({ type: "error", message });
    });

    child.on("error", (error) => {
      lastError = error;
      sendTranscript({ type: "error", message: error.message });
      rejectReady?.(error);
    });

    child.on("close", (code) => {
      // If the sidecar exited before emitting `ready`, surface the captured stderr
      // (more useful than a generic "exited" message) and latch the failure so we
      // don't enter a respawn loop on every audio frame.
      const stderrTail = stderrBuffer.trim().split("\n").slice(-3).join("\n");
      const reason = stderrTail || `exit code ${code}`;
      const error = new Error(`Moonshine sidecar exited before it was ready: ${reason}`);
      lastError = error;
      failed = true;
      sendTranscript({ type: "error", message: friendlyMoonshineError(stderrTail, options) });
      rejectReady?.(error);
      cancelQuietTimer();
      partialText = "";
      partialStartedAt = 0;
      flushedPrefix = "";
      lastQueuedText = "";
      child = null;
      readyPromise = null;
      resolveReady = null;
      rejectReady = null;
    });

    return child;
  }

  return {
    ready: async () => {
      ensureChild();
      await readyPromise;
    },
    sendAudio: (audio) => {
      if (!audio) return;
      let process;
      try {
        process = ensureChild();
      } catch (error) {
        sendTranscript({ type: "error", message: error.message });
        return;
      }
      if (!process) return; // failed-latch: don't re-spawn until applyCurrent rebuilds us
      try {
        process.stdin.write(`${JSON.stringify({ type: "audio", encoding: "pcm16le", sampleRate: SAMPLE_RATE, audio })}\n`);
      } catch (error) {
        if (error?.code !== "EPIPE") sendTranscript({ type: "error", message: error.message });
      }
    },
    stop: () => {
      // User-initiated stop should drain whatever partial we have right now
      // rather than wait for the quiet timer; idempotent.
      flushPartialAsTurn();
      if (!child) return;
      try {
        child.stdin.write(`${JSON.stringify({ type: "stop" })}\n`);
      } catch (error) {
        if (error?.code !== "EPIPE") sendTranscript({ type: "error", message: error.message });
      }
    },
    close: () => {
      cancelQuietTimer();
      if (!child) return;
      child.stdin.end();
      child.kill();
      child = null;
    },
  };
}

function friendlyMoonshineError(stderrTail, options) {
  if (/Model not found for language/.test(stderrTail)) {
    const lang = options?.moonshineLanguage || "en";
    const model = options?.moonshineModel || "medium";
    return `Moonshine model "${model}" is not available for language "${lang}". The shipped sidecar only ships English (tiny/small/medium); other languages require a sidecar rebuild that registers the "base" arch.`;
  }
  return stderrTail
    ? `Moonshine sidecar exited before it was ready: ${stderrTail}`
    : "Moonshine sidecar exited before it was ready.";
}

function handleSidecarLine(line, { sendTranscript, onReady, onPartial, onCommitted }) {
  if (!line.trim()) return;

  let message;
  try {
    message = JSON.parse(line);
  } catch {
    sendTranscript({ type: "error", message: `Invalid Moonshine sidecar message: ${line}` });
    return;
  }

  if (message.type === "ready") {
    onReady?.();
    return;
  }

  if (message.type === "transcript:partial") {
    const text = message.text ?? "";
    sendTranscript({ type: "transcript:partial", text });
    onPartial?.(text);
  }

  if (message.type === "transcript:committed") {
    const text = message.text ?? "";
    onCommitted?.(text);
  }

  if (message.type === "error") {
    sendTranscript({ type: "error", message: message.message ?? "Moonshine transcription error" });
  }
}
