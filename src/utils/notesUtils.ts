// src/utils/notesUtils.ts
//
// Pure utility functions for the Notes feature.
// No React, no DOM, no Tauri — plain string-in / string-out so they can be
// unit-tested directly with Jest without any mocking.

// ─── STRIP MARKDOWN for card previews ────────────────────────────────────────
export function stripMarkdownForPreview(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, "[code]")
    .replace(/^#{1,4} /gm, "")
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/~~(.+?)~~/g, "$1")
    .replace(/`(.+?)`/g, "$1")
    .replace(/\*(.+?)\*/g, "$1")
    .replace(/^\- /gm, "• ")
    .replace(/^\d+\. /gm, "")
    .replace(/^> /gm, "")
    .replace(/\|[-: ]+\|[-: |]+/g, "")
    .replace(/\|/g, " ")
    .replace(/^---+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// ─── CONTEXTUAL SNIPPET for search results ───────────────────────────────────
// When a search query is active, show the text *around* the first match instead
// of always showing the top of the note. This tells the user exactly why the
// note was returned.
export function getCardSnippet(
  note: { title: string; content: string; tags?: string[] },
  query: string,
): string {
  const stripped = stripMarkdownForPreview(note.content);
  if (!query.trim()) return stripped;

  const q = query.toLowerCase();

  // Check if match is in the stripped body
  const strippedLower = stripped.toLowerCase();
  const bodyIdx = strippedLower.indexOf(q);
  if (bodyIdx !== -1) {
    // Show a window of text centred on the match
    const BEFORE = 50;
    const AFTER = 120;
    const start = Math.max(0, bodyIdx - BEFORE);
    const end = Math.min(stripped.length, bodyIdx + AFTER);
    const prefix = start > 0 ? "…" : "";
    const suffix = end < stripped.length ? "…" : "";
    return prefix + stripped.substring(start, end) + suffix;
  }

  // Match is in raw markdown syntax (e.g. a URL or a heading marker that
  // stripped away) or in the title/tags — fall back to the top of the body.
  return stripped;
}

// ─── WORD COUNT — strips markdown before counting ────────────────────────────
// Splits on whitespace only: URLs, emails, and hyphenated-words each count as
// one word. Markdown syntax characters are stripped first so `**bold**` counts
// as 1 word, not 2, and table separators (`|---|---|`) count as 0 words.
export function countWords(content: string): number {
  if (!content) return 0;
  const stripped = stripMarkdownForPreview(content);
  return stripped.split(/\s+/).filter((w) => w.length > 0).length;
}
