// Lucide icon resolver. Curated whitelist is preloaded at boot for instant use;
// any other valid Lucide name is fetched on demand and cached. Unknown names
// resolve to null and are silently dropped by the caller.
//
// Lucide is MIT-licensed: https://github.com/lucide-icons/lucide

const LUCIDE_CDN_BASE = "https://unpkg.com/lucide-static@latest/icons";
export const LUCIDE_ICON_MIME = "image/svg+xml";

// Curated common icons. ~50 covers ~90% of presentation use cases. Pre-fetched
// at boot — agent gets zero-latency access to these. Names match Lucide kebab-
// case exactly; an outdated entry will fail the prefetch but not break startup.
export const LUCIDE_WHITELIST = [
  // Concepts / ideas
  "lightbulb", "brain", "sparkles", "star", "target", "flag", "trophy",
  // Status / outcome
  "check", "check-circle", "x", "x-circle", "circle-alert", "triangle-alert", "info",
  // Action / verbs
  "play", "pause", "rocket", "send", "zap", "bolt", "wrench",
  // Data / metrics
  "chart-bar", "chart-line", "chart-pie", "trending-up", "trending-down", "calculator",
  // System / tech
  "settings", "cpu", "database", "server", "code", "terminal", "git-branch", "globe",
  // People / org
  "user", "users", "user-check", "shield", "key", "lock",
  // Money / business
  "dollar-sign", "credit-card", "shopping-cart",
  // Time / planning
  "clock", "calendar", "calendar-clock", "timer",
  // Comm / share
  "mail", "message-square", "phone", "share-2", "link", "external-link",
  // Files / data
  "file-text", "file-code", "folder", "image",
  // Direction / flow
  "arrow-right", "arrow-up", "arrow-down", "arrow-left",
  // Misc useful
  "puzzle", "tag", "bookmark", "search", "filter", "eye", "heart",
];

const _cache = new Map();
const _inflight = new Map();
let _excalidrawAPI = null;
let _onIconReady = null;

function urlFor(name) {
  return `${LUCIDE_CDN_BASE}/${name}.svg`;
}

function fileIdFor(name) {
  return `lucide:${name}`;
}

function svgToDataURL(svgText) {
  const colored = svgText
    .replace(/stroke="currentColor"/g, 'stroke="#1f2937"')
    .replace(/fill="currentColor"/g, 'fill="#1f2937"');
  // Lucide SVGs have no fill (line icons), but use currentColor for stroke.
  // Excalidraw will render the SVG verbatim, so we need an explicit color.
  const utf8 = new TextEncoder().encode(colored);
  let binary = "";
  for (const b of utf8) binary += String.fromCharCode(b);
  return `data:${LUCIDE_ICON_MIME};base64,${btoa(binary)}`;
}

async function fetchAndRegister(name) {
  if (_cache.has(name)) return _cache.get(name);
  if (_inflight.has(name)) return _inflight.get(name);

  const promise = (async () => {
    try {
      const res = await fetch(urlFor(name), { mode: "cors" });
      if (!res.ok) {
        _cache.set(name, null); // negative cache so we don't re-hit
        return null;
      }
      const svg = await res.text();
      const dataURL = svgToDataURL(svg);
      const fileId = fileIdFor(name);
      _cache.set(name, fileId);
      if (_excalidrawAPI) {
        _excalidrawAPI.addFiles([
          { id: fileId, dataURL, mimeType: LUCIDE_ICON_MIME, created: Date.now() },
        ]);
      }
      return fileId;
    } catch {
      _cache.set(name, null);
      return null;
    } finally {
      _inflight.delete(name);
    }
  })();
  _inflight.set(name, promise);
  return promise;
}

// Synchronous lookup: returns the registered fileId if cached (positive cache),
// null if known-missing, or undefined if unknown (caller should kick a fetch).
export function getCachedIconFileId(name) {
  return _cache.get(name);
}

// Kick an async fetch in the background; when it lands, fire onIconReady so the
// caller can re-render the scene with the now-resolved fileId.
export function ensureIconLoaded(name) {
  const cached = _cache.get(name);
  if (cached !== undefined) return; // already resolved (positive or negative)
  fetchAndRegister(name).then((fileId) => {
    if (fileId && _onIconReady) _onIconReady(name, fileId);
  });
}

export function attachIconRegistry(api, onIconReady) {
  _excalidrawAPI = api;
  _onIconReady = onIconReady;
  // Re-register everything we already fetched so the new API instance has them.
  const ready = [];
  for (const [name, fileId] of _cache) {
    if (typeof fileId !== "string") continue;
    // We don't keep the dataURL around, so we can't re-register without re-fetch.
    // Force-fetch any cached names that might have lost their file binding.
    ready.push(fetchAndRegister(name));
  }
  return Promise.all(ready);
}

export async function preloadLucideWhitelist() {
  // Fire all in parallel; preload should never block startup, so we swallow errors.
  await Promise.allSettled(LUCIDE_WHITELIST.map(fetchAndRegister));
}
