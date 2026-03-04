// notesUtils.test.ts
//
// Unit tests for the three pure utility functions extracted from NotesView.tsx.
//
// Setup:
//   1. Copy stripMarkdownForPreview, getCardSnippet, and countWords out of
//      NotesView.tsx into a shared file, e.g. src/utils/notesUtils.ts, and
//      export them.
//   2. Import them here.
//   3. Run with: npx jest notesUtils.test.ts
//
// These functions contain no React, no DOM, and no Tauri calls — plain
// string-in / string-out, so no mocking is needed.

import {
  stripMarkdownForPreview,
  countWords,
  getCardSnippet,
} from "../utils/notesUtils";

// ─────────────────────────────────────────────────────────────────────────────
// stripMarkdownForPreview
// ─────────────────────────────────────────────────────────────────────────────

describe("stripMarkdownForPreview", () => {
  // Headings
  test("strips H1 heading marker", () => {
    expect(stripMarkdownForPreview("# Title")).toBe("Title");
  });

  test("strips H2 heading marker", () => {
    expect(stripMarkdownForPreview("## Title")).toBe("Title");
  });

  test("strips H3 heading marker", () => {
    expect(stripMarkdownForPreview("### Title")).toBe("Title");
  });

  test("strips H4 heading marker", () => {
    expect(stripMarkdownForPreview("#### Title")).toBe("Title");
  });

  test("does not strip # that is not at start of line (inline hash)", () => {
    // A # mid-sentence is a hashtag, not a heading
    expect(stripMarkdownForPreview("note #3")).toBe("note #3");
  });

  // Bold / italic / strikethrough
  test("strips bold markers and keeps inner text", () => {
    expect(stripMarkdownForPreview("**important**")).toBe("important");
  });

  test("strips italic markers and keeps inner text", () => {
    expect(stripMarkdownForPreview("*emphasis*")).toBe("emphasis");
  });

  test("strips strikethrough markers and keeps inner text", () => {
    expect(stripMarkdownForPreview("~~deleted~~")).toBe("deleted");
  });

  // Inline code
  test("strips inline code backticks and keeps inner text", () => {
    expect(stripMarkdownForPreview("`sk-abc123`")).toBe("sk-abc123");
  });

  // Fenced code block
  test("replaces fenced code block with [code]", () => {
    const input = "intro\n```\nconst x = 1;\n```\noutro";
    const result = stripMarkdownForPreview(input);
    expect(result).toContain("[code]");
    expect(result).not.toContain("const x");
  });

  // Lists
  test("converts unordered list marker to bullet character", () => {
    expect(stripMarkdownForPreview("- item")).toBe("• item");
  });

  test("strips ordered list number prefix", () => {
    expect(stripMarkdownForPreview("1. first")).toBe("first");
  });

  // Blockquote
  test("strips blockquote marker", () => {
    expect(stripMarkdownForPreview("> quoted")).toBe("quoted");
  });

  // Horizontal rule
  test("strips horizontal rule", () => {
    expect(stripMarkdownForPreview("---")).toBe("");
  });

  // Table
  test("strips table pipe characters", () => {
    const table = "| Name | Value |\n|---|---|\n| key | val |";
    const result = stripMarkdownForPreview(table);
    expect(result).not.toContain("|");
    expect(result).toContain("Name");
    expect(result).toContain("Value");
  });

  test("strips table separator row", () => {
    const result = stripMarkdownForPreview("|---|---|");
    expect(result).toBe("");
  });

  // Edge cases
  test("returns empty string for empty input", () => {
    expect(stripMarkdownForPreview("")).toBe("");
  });

  test("trims leading and trailing whitespace", () => {
    expect(stripMarkdownForPreview("  hello  ")).toBe("hello");
  });

  test("collapses 3+ consecutive newlines to 2", () => {
    const result = stripMarkdownForPreview("a\n\n\n\nb");
    expect(result).toBe("a\n\nb");
  });

  test("preserves plain text with no markdown", () => {
    const plain = "This is a plain note with a PIN: 1234";
    expect(stripMarkdownForPreview(plain)).toBe(plain);
  });

  test("preserves URLs intact", () => {
    expect(stripMarkdownForPreview("https://example.com/path?q=1")).toBe(
      "https://example.com/path?q=1",
    );
  });

  test("preserves email addresses intact", () => {
    expect(stripMarkdownForPreview("user@example.com")).toBe(
      "user@example.com",
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// countWords
// ─────────────────────────────────────────────────────────────────────────────

describe("countWords", () => {
  test("returns 0 for empty string", () => {
    expect(countWords("")).toBe(0);
  });

  test("counts simple prose correctly", () => {
    expect(countWords("This is it.")).toBe(3);
  });

  test("URL counts as one word", () => {
    // The real-world case: "This is it.\nhttps://laoutaris.com\ntest@example.com"
    // should be 5 words, not inflated by slashes and dots
    expect(
      countWords("This is it.\nhttps://laoutaris.com\npowergr@gmail.com"),
    ).toBe(5);
  });

  test("email address counts as one word", () => {
    expect(countWords("contact powergr@gmail.com please")).toBe(3);
  });

  test("markdown bold syntax does not inflate word count", () => {
    // **bold** should count as 1 word (bold), not 3 (**bold**)
    expect(countWords("**important**")).toBe(1);
  });

  test("heading markers do not count as words", () => {
    // "# Title" → "Title" → 1 word
    expect(countWords("# Title")).toBe(1);
  });

  test("table separator row counts as 0 words", () => {
    expect(countWords("|---|---|")).toBe(0);
  });

  test("multiple blank lines do not add phantom words", () => {
    expect(countWords("one\n\n\n\ntwo")).toBe(2);
  });

  test("hyphenated word counts as one word", () => {
    expect(countWords("two-factor authentication")).toBe(2);
  });

  test("counts a realistic seed phrase correctly", () => {
    const seed =
      "word1 word2 word3 word4 word5 word6 word7 word8 word9 word10 word11 word12";
    expect(countWords(seed)).toBe(12);
  });

  test("returns 0 for whitespace-only input", () => {
    expect(countWords("   \n\t  ")).toBe(0);
  });

  test("inline code content counts as one word", () => {
    // `sk-abc123` → "sk-abc123" → 1 word
    expect(countWords("`sk-abc123`")).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// getCardSnippet
// ─────────────────────────────────────────────────────────────────────────────

describe("getCardSnippet", () => {
  const note = (content: string) => ({
    title: "Test Note",
    content,
    tags: [],
  });

  // No query → return full stripped content
  test("returns full stripped content when query is empty", () => {
    const result = getCardSnippet(note("Hello world"), "");
    expect(result).toBe("Hello world");
  });

  test("returns full stripped content when query is only whitespace", () => {
    const result = getCardSnippet(note("Hello world"), "   ");
    expect(result).toBe("Hello world");
  });

  // Match found in body
  test("returns content containing the matched term", () => {
    const content = "The quick brown fox jumps over the lazy dog";
    const result = getCardSnippet(note(content), "fox");
    expect(result.toLowerCase()).toContain("fox");
  });

  test("is case-insensitive", () => {
    const content = "Store your SEED PHRASE securely";
    const result = getCardSnippet(note(content), "seed phrase");
    expect(result.toLowerCase()).toContain("seed phrase");
  });

  test("adds leading ellipsis when match is far into the note", () => {
    // Put the match beyond the 50-char BEFORE window
    const prefix = "a".repeat(100);
    const content = prefix + " target word here";
    const result = getCardSnippet(note(content), "target");
    expect(result.startsWith("…")).toBe(true);
  });

  test("adds trailing ellipsis when note continues after the window", () => {
    const suffix = "z".repeat(200);
    const content = "target " + suffix;
    const result = getCardSnippet(note(content), "target");
    expect(result.endsWith("…")).toBe(true);
  });

  test("no leading ellipsis when match is near the start", () => {
    const content = "target is right at the start of this note";
    const result = getCardSnippet(note(content), "target");
    expect(result.startsWith("…")).toBe(false);
  });

  test("no trailing ellipsis when match is near the end of a short note", () => {
    const content = "short note with target";
    const result = getCardSnippet(note(content), "target");
    expect(result.endsWith("…")).toBe(false);
  });

  // Match only in markdown syntax that gets stripped
  test("falls back to top of note when query only matches stripped syntax", () => {
    // The raw content has **target** but after stripping it becomes "target"
    // so it WILL match in the stripped body — this is the correct behaviour
    const content = "visible text\n**target**\nmore text";
    const result = getCardSnippet(note(content), "target");
    expect(result).toContain("target");
  });

  test("falls back to full content when query matches nothing", () => {
    const content = "This note has no mention of the search term";
    const result = getCardSnippet(note(content), "xyzzy");
    // Should return the full stripped note, not empty
    expect(result).toBe(content);
  });

  // Empty content
  test("returns empty string for empty note content", () => {
    const result = getCardSnippet(note(""), "anything");
    expect(result).toBe("");
  });

  // Markdown is stripped from the snippet
  test("snippet does not contain raw markdown syntax", () => {
    const content = "## Heading\n**bold value**: 1234\nsome more text";
    const result = getCardSnippet(note(content), "bold value");
    expect(result).not.toContain("**");
    expect(result).not.toContain("##");
  });
});
