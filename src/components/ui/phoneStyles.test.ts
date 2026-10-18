// jsdom cannot apply media queries, so these read the style sheets themselves. They guard
// the rules a phone depends on from being dropped by an edit that looks harmless.

// The project has no Node type definitions, so the two things used here are described by hand.
declare const __dirname: string;
const { readFileSync } = jest.requireActual("fs") as { readFileSync(path: string, encoding: string): string };

const read = (...parts: string[]) =>
  readFileSync([__dirname, "..", "..", ...parts].join("/"), "utf8").replace(/\r\n/g, "\n");

/** The text of the block that follows the first occurrence of `opening`, braces matched. */
function block(css: string, opening: string): string {
  const start = css.indexOf(opening);
  if (start < 0) throw new Error(`missing: ${opening}`);
  let depth = 0;
  for (let i = css.indexOf("{", start); i < css.length; i++) {
    if (css[i] === "{") depth++;
    if (css[i] === "}" && --depth === 0) return css.slice(css.indexOf("{", start) + 1, i);
  }
  throw new Error("unbalanced");
}

describe("touch targets", () => {
  const ui = read("components", "ui", "ui.css");
  const coarse = block(ui, "/* ---------- Touch screens");

  it("has its own block for touch screens", () => {
    expect(ui).toContain("@media (pointer: coarse)");
  });

  it.each([".ui-chip", ".ui-seg__item"])("makes %s at least 44 pixels tall", (selector) => {
    const rule = coarse.slice(coarse.indexOf(selector));
    expect(rule.slice(0, rule.indexOf("}"))).toMatch(/min-height:\s*44px/);
  });

  it.each([".ui-banner__close", ".details-panel__close", ".icon-btn-ghost"])("makes %s 44 by 44 pixels", (selector) => {
    const from = coarse.indexOf(selector);
    expect(from).toBeGreaterThanOrEqual(0);
    const rule = coarse.slice(from, coarse.indexOf("}", from));
    expect(rule).toMatch(/min-width:\s*44px/);
    expect(rule).toMatch(/min-height:\s*44px/);
  });

  it("lets the colour dots wrap and grow", () => {
    expect(coarse).toMatch(/\.color-picker\s*{[^}]*flex-wrap:\s*wrap/);
    expect(coarse).toMatch(/\.color-dot\s*{[^}]*width:\s*40px/);
  });

  it("keeps buttons and fields at 44 pixels on touch screens", () => {
    expect(ui).toMatch(/@media \(pointer: coarse\) {\s*\.ui-btn {\s*min-height: 44px/);
    expect(ui).toMatch(/@media \(pointer: coarse\) {\s*\.ui-input {\s*min-height: 44px/);
  });
});

describe("phone sheets", () => {
  const ui = read("components", "ui", "ui.css");
  const phone = block(ui, "@media (max-width: 600px) {\n  .modal-overlay.ui-overlay--drawer");

  it("beats the dialog rule that centres every overlay on a phone", () => {
    expect(phone).toMatch(/\.modal-overlay\.ui-overlay--drawer\s*{[^}]*align-items:\s*flex-end\s*!important/);
  });

  it("rises from the bottom, rounded on top, clear of the gesture bar", () => {
    const drawer = phone.slice(phone.indexOf(".ui-drawer {"), phone.indexOf("}", phone.indexOf(".ui-drawer {")));
    expect(drawer).toMatch(/width:\s*100%/);
    expect(drawer).toMatch(/max-height:\s*90vh/);
    expect(drawer).toMatch(/border-radius:[^;]*0 0/);
    expect(drawer).toContain("env(safe-area-inset-bottom)");
  });

  it("shows the grab handle only on a phone", () => {
    expect(ui).toMatch(/\.ui-sheet__grab\s*{\s*display:\s*none/);
    expect(phone).toMatch(/\.ui-sheet__grab\s*{[^}]*display:\s*block/);
  });

  it("lifts the toasts above the bottom bar", () => {
    const toasts = block(ui, "/* On a phone the toasts sit above the bottom bar");
    expect(toasts).toMatch(/bottom:\s*calc\(72px \+ env\(safe-area-inset-bottom\)\)/);
  });
});

describe("bottom bar", () => {
  const css = read("components", "layout", "BottomBar.css");

  it("stays at the bottom edge, above page content, clear of the gesture bar", () => {
    const bar = css.slice(css.indexOf(".bottom-bar {"), css.indexOf("}"));
    expect(bar).toMatch(/position:\s*fixed/);
    expect(bar).toMatch(/bottom:\s*0/);
    expect(bar).toContain("env(safe-area-inset-bottom)");
  });

  it("makes each button at least 56 pixels tall", () => {
    expect(css).toMatch(/\.bottom-bar__item\s*{[^}]*min-height:\s*56px/);
  });
});

describe("details panel on a phone", () => {
  const css = read("components", "dashboard", "DetailsPanel.css");

  it("becomes a sheet above the bottom bar", () => {
    const phone = block(css, "@media (max-width: 600px)");
    expect(phone).toMatch(/position:\s*fixed/);
    expect(phone).toContain("bottom: calc(56px + env(safe-area-inset-bottom))");
    expect(phone).toMatch(/max-height:\s*45vh/);
  });
});

describe("sign-in screen", () => {
  const css = read("components", "auth", "AuthOverlay.css");

  it("scrolls when the keyboard takes the space and keeps clear of notches and gesture bars", () => {
    expect(css).toMatch(/\.auth-overlay\s*{[^}]*overflow-y:\s*auto/);
    expect(css).toContain("env(safe-area-inset-top)");
    expect(css).toContain("env(safe-area-inset-bottom)");
  });

  it("makes its links 44 pixels tall on touch screens", () => {
    expect(css).toMatch(/@media \(pointer: coarse\)\s*{\s*\.auth-link\s*{\s*min-height:\s*44px/);
  });
});

describe("Passwords and Notes headers", () => {
  const vault = read("components", "views", "VaultView.css");
  const notes = read("components", "views", "NotesView.css");
  const phoneOf = (css: string) => block(css, "@media (max-width: 600px)");

  it.each([
    ["Vault", ".vault-header", vault],
    ["Notes", ".notes-header", notes],
  ])("%s: the header wraps on any narrow window instead of scrolling sideways", (_name, selector, css) => {
    expect(css).toMatch(new RegExp(`${selector.replace(".", "\\.")}\\s*{\\s*flex-wrap:\\s*wrap`));
  });

  it.each([
    ["Vault", ".vault-header", vault],
    ["Notes", ".notes-header", notes],
  ])("%s: the header stacks in a column on a phone", (_name, selector, css) => {
    const phone = phoneOf(css);
    const rule = phone.slice(phone.indexOf(`${selector} {`), phone.indexOf("}", phone.indexOf(`${selector} {`)));
    expect(rule).toMatch(/flex-direction:\s*column/);
    expect(rule).toMatch(/align-items:\s*stretch/);
  });

  it.each([
    ["Vault", vault],
    ["Notes", notes],
  ])("%s: the search box takes the full width on a phone", (_name, css) => {
    expect(phoneOf(css)).toMatch(/\.search-container\s*{[^}]*width:\s*100%[^}]*max-width:\s*none/);
  });

  it("Vault: Add New comes first and fills the row, beside the three icon buttons", () => {
    expect(phoneOf(vault)).toMatch(/\.vault-primary-btn\s*{[^}]*order:\s*-1[^}]*flex:\s*1 1 auto/);
  });

  it("Notes: New Note comes first on its own full-width line, and the controls wrap below it", () => {
    expect(phoneOf(notes)).toMatch(/\.header-action-btn\s*{[^}]*order:\s*-1[^}]*flex:\s*1 1 100%/);
    expect(notes).toMatch(/\.notes-controls-row\s*{[^}]*flex-wrap:\s*wrap/);
  });

  it("Notes: the sort menu may shrink so it never pushes the buttons out of the row", () => {
    expect(phoneOf(notes)).toMatch(/\.custom-select-container\s*{[^}]*min-width:\s*0/);
  });

  it("make the header controls 44 pixels on touch screens", () => {
    expect(vault).toMatch(/@media \(pointer: coarse\)\s*{\s*\.vault-action-btn\s*{\s*width:\s*44px;\s*height:\s*44px/);
    expect(notes).toMatch(/\.notes-icon-btn\s*{\s*width:\s*44px/);
  });
});

// Makes this file a module, so its helper names do not clash with those of other test files.
export {};
