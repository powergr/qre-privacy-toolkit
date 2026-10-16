import { HOME_TOOL, TOOLS, TOOL_GROUPS, toolsInGroup, groupHue } from "./tools";

// Every tab id App.tsx renders a screen for.
const APP_TAB_IDS = [
  "home", "files", "shred", "vault", "notes", "breach", "cleaner", "clipboard",
  "qr", "bookmarks", "hash", "sysclean", "analyzer", "help", "settings",
];

describe("tools", () => {
  it("lists twelve tools plus Home, each once", () => {
    const ids = [HOME_TOOL, ...TOOLS].map((t) => t.id);
    expect(ids).toHaveLength(13);
    expect(new Set(ids).size).toBe(13);
  });

  it("only offers tabs the app can show", () => {
    for (const t of [HOME_TOOL, ...TOOLS]) expect(APP_TAB_IDS).toContain(t.id);
  });

  it("puts every tool except Home in one of the four groups", () => {
    const groupIds = TOOL_GROUPS.map((g) => g.id);
    expect(groupIds).toEqual(["protect", "inspect", "clean", "create"]);
    expect(HOME_TOOL.group).toBeNull();
    for (const t of TOOLS) expect(groupIds).toContain(t.group);
  });

  it("returns the tools of a group in sidebar order", () => {
    expect(toolsInGroup("protect").map((t) => t.id)).toEqual(["files", "notes", "vault", "bookmarks", "clipboard"]);
    expect(toolsInGroup("inspect").map((t) => t.id)).toEqual(["breach", "hash", "analyzer"]);
    expect(toolsInGroup("clean").map((t) => t.id)).toEqual(["sysclean", "cleaner", "shred"]);
    expect(toolsInGroup("create").map((t) => t.id)).toEqual(["qr"]);
  });

  it("covers every tool in exactly one group listing", () => {
    const total = TOOL_GROUPS.reduce((n, g) => n + toolsInGroup(g.id).length, 0);
    expect(total).toBe(TOOLS.length);
  });

  it("gives each tool a label, a tooltip, an icon and search words", () => {
    for (const t of [HOME_TOOL, ...TOOLS]) {
      expect(t.label.length).toBeGreaterThan(0);
      expect(t.desc.length).toBeGreaterThan(0);
      expect(t.Icon).toBeTruthy();
      expect(t.keywords.length).toBeGreaterThan(0);
    }
  });

  it("maps a group to its colour variable, and Home to none", () => {
    expect(groupHue("protect")).toBe("var(--hue-protect)");
    expect(groupHue("create")).toBe("var(--hue-create)");
    expect(groupHue(null)).toBeUndefined();
  });
});
