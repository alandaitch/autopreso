// Helpers for "slides" layoutMode. Each slide is a small JSON object:
//   { headline, subtitle?, icon?, layout: "hero"|"split"|"quote", index }
// The agent edits the current slide via slide_edit (mutate one field) or
// emits a fresh slide via slide_set (replace whole slide). The frontend
// renders an overlay over the canvas based on state.currentSlide.

export const SLIDE_LAYOUTS = ["hero", "split", "quote"];

export function formatSlideForAgent(slide) {
  if (!slide) return "(no slide yet — emit one with slide_set)";
  const lines = [
    `layout: ${slide.layout}`,
    `headline: ${slide.headline ?? ""}`,
  ];
  if (slide.subtitle) lines.push(`subtitle: ${slide.subtitle}`);
  if (slide.icon) lines.push(`icon: ${slide.icon}`);
  return lines.join("\n");
}

// Apply a single slide_edit field mutation to the current slide. Returns the
// new slide object or null if there's no slide to edit.
export function applySlideEdit(currentSlide, { field, value }) {
  if (!currentSlide) return null;
  const next = { ...currentSlide };
  if (field === "headline") next.headline = String(value ?? "");
  else if (field === "subtitle") next.subtitle = value === "" || value == null ? undefined : String(value);
  else if (field === "icon") next.icon = value === "" || value == null ? undefined : String(value);
  else if (field === "layout") {
    if (!SLIDE_LAYOUTS.includes(value)) return currentSlide;
    next.layout = value;
  }
  return next;
}

// Build a fresh slide from slide_set input. Trims to the agreed shape so the
// frontend never sees stray fields and the line-numbered scene representation
// stays predictable. The input only requires headline + layout; subtitle and
// icon are optional and may be missing entirely from the tool call.
/**
 * @param {{ headline: string, layout: string, subtitle?: string, icon?: string }} input
 * @param {number} index
 */
export function buildSlide(input, index) {
  const { headline, subtitle, icon, layout } = input;
  return {
    index,
    layout: SLIDE_LAYOUTS.includes(layout) ? layout : "hero",
    headline: String(headline ?? ""),
    ...(subtitle ? { subtitle: String(subtitle) } : {}),
    ...(icon ? { icon: String(icon) } : {}),
  };
}
