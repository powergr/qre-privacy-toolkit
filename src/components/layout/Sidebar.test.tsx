import { render, screen, fireEvent, within } from "@testing-library/react";
import "@testing-library/jest-dom";
import { Sidebar } from "./Sidebar";

// Every tab id App.tsx knows how to render.
const APP_TAB_IDS = [
  "home",
  "files",
  "shred",
  "vault",
  "notes",
  "breach",
  "cleaner",
  "clipboard",
  "qr",
  "bookmarks",
  "hash",
  "sysclean",
  "analyzer",
  "help",
  "settings",
];

function setNarrowScreen(narrow: boolean) {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: jest.fn().mockImplementation((query: string) => ({
      matches: narrow && query.includes("max-width: 600px"),
      media: query,
      addEventListener: jest.fn(),
      removeEventListener: jest.fn(),
    })),
  });
}

function makeProps() {
  return {
    activeTab: "home",
    setTab: jest.fn(),
    onOpenHelpModal: jest.fn(),
    onOpenAboutModal: jest.fn(),
    onLogout: jest.fn(),
    onTheme: jest.fn(),
    onBackup: jest.fn(),
    onChangePassword: jest.fn(),
    onReset2FA: jest.fn(),
    onUpdate: jest.fn(),
  };
}

function renderSidebar(overrides: Partial<ReturnType<typeof makeProps>> = {}) {
  const props = { ...makeProps(), ...overrides };
  const utils = render(<Sidebar {...props} />);
  return { props, ...utils };
}

const NAV_LABELS = [
  "Home",
  "Encrypt Files",
  "Secure Notes",
  "Passwords Vault",
  "Bookmarks Vault",
  "Secure Clipboard",
  "Privacy Check",
  "Integrity Check",
  "File Analyzer",
  "System Clean",
  "Metadata Cleaner",
  "Shredder",
  "QR Generator",
];

beforeEach(() => {
  setNarrowScreen(false);
  localStorage.clear();
});

describe("Sidebar - navigation", () => {
  it("lists every tool in order", () => {
    renderSidebar();
    // Home sits in the top row, then the four groups.
    const labels = Array.from(document.querySelectorAll(".sidebar-top .nav-btn, .nav-group .nav-btn")).map(
      (b) => b.textContent,
    );
    expect(labels).toEqual(NAV_LABELS);
  });

  it("sends the right tab id for every button, and each id is one the app can render", () => {
    const { props } = renderSidebar();
    for (const label of NAV_LABELS) fireEvent.click(screen.getByRole("button", { name: label }));

    const sent = props.setTab.mock.calls.map(([id]) => id);
    expect(sent).toEqual([
      "home",
      "files",
      "notes",
      "vault",
      "bookmarks",
      "clipboard",
      "breach",
      "hash",
      "analyzer",
      "sysclean",
      "cleaner",
      "shred",
      "qr",
    ]);
    for (const id of sent) expect(APP_TAB_IDS).toContain(id);
  });

  it("highlights only the active tab", () => {
    renderSidebar({ activeTab: "vault" });
    const active = Array.from(document.querySelectorAll(".nav-btn.active")).map((b) => b.textContent);
    expect(active).toEqual(["Passwords Vault"]);
  });

  it("shows a spelled-out tooltip for each tool", () => {
    renderSidebar();
    expect(screen.getByRole("button", { name: "Shredder" })).toHaveAttribute("title", "Permanently destroy files");
    expect(screen.getByRole("button", { name: "Secure Notes" })).toHaveAttribute("title", "Secure notepad");
  });
});

describe("Sidebar - settings menu", () => {
  const openSettings = () => fireEvent.click(screen.getByRole("button", { name: /Settings/ }));

  it("is closed until Settings is clicked, then toggles", () => {
    renderSidebar();
    expect(screen.queryByText("Log Out")).not.toBeInTheDocument();
    openSettings();
    expect(screen.getByText("Log Out")).toBeInTheDocument();
    openSettings();
    expect(screen.queryByText("Log Out")).not.toBeInTheDocument();
  });

  it.each([
    ["Theme", "onTheme"],
    ["Backup", "onBackup"],
    ["Password", "onChangePassword"],
    ["Reset 2FA", "onReset2FA"],
    ["Updates", "onUpdate"],
    ["Log Out", "onLogout"],
  ] as const)("%s calls %s once and closes the menu", (label, handler) => {
    const { props } = renderSidebar();
    openSettings();
    fireEvent.click(screen.getByRole("button", { name: new RegExp(`^${label}$`) }));

    expect(props[handler]).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("Log Out")).not.toBeInTheDocument();
  });

  it("closes when the user clicks elsewhere", () => {
    renderSidebar();
    openSettings();
    fireEvent.mouseDown(document.body);
    expect(screen.queryByText("Log Out")).not.toBeInTheDocument();
  });

  it("stays open when the click is inside the menu", () => {
    renderSidebar();
    openSettings();
    fireEvent.mouseDown(screen.getByText("Theme"));
    expect(screen.getByText("Log Out")).toBeInTheDocument();
  });

  it("closes when the user switches tool", () => {
    const { rerender, props } = renderSidebar();
    openSettings();
    rerender(<Sidebar {...props} activeTab="notes" />);
    expect(screen.queryByText("Log Out")).not.toBeInTheDocument();
  });
});

describe("Sidebar - help menu", () => {
  const openHelp = () => fireEvent.click(screen.getByRole("button", { name: /^Help$/ }));

  it("opens help topics and the about box", () => {
    const { props } = renderSidebar();
    openHelp();
    fireEvent.click(screen.getByRole("button", { name: /Help Topics/ }));
    expect(props.onOpenHelpModal).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("About")).not.toBeInTheDocument();

    openHelp();
    fireEvent.click(screen.getByRole("button", { name: /About/ }));
    expect(props.onOpenAboutModal).toHaveBeenCalledTimes(1);
  });

  it("only one menu is open at a time", () => {
    renderSidebar();
    fireEvent.click(screen.getByRole("button", { name: /Settings/ }));
    expect(screen.getByText("Log Out")).toBeInTheDocument();

    // A real click is a mousedown then a click; the mousedown closes the other menu.
    const help = screen.getByRole("button", { name: /^Help$/ });
    fireEvent.mouseDown(help);
    fireEvent.click(help);
    expect(screen.getByText("Help Topics")).toBeInTheDocument();
    expect(screen.queryByText("Log Out")).not.toBeInTheDocument();
  });
});

describe("Sidebar - narrow screens", () => {
  it("opens full Help and Settings pages instead of popup menus", () => {
    setNarrowScreen(true);
    const { props } = renderSidebar();
    fireEvent.click(screen.getByRole("button", { name: /^Help$/ }));
    fireEvent.click(screen.getByRole("button", { name: /Settings/ }));

    expect(props.setTab.mock.calls.map(([id]) => id)).toEqual(["help", "settings"]);
    expect(screen.queryByText("Log Out")).not.toBeInTheDocument();
    expect(screen.queryByText("Help Topics")).not.toBeInTheDocument();
  });
});

describe("Sidebar - groups", () => {
  const labels = () => Array.from(document.querySelectorAll(".nav-group-label")).map((l) => l.textContent);
  const namesIn = (group: string) =>
    Array.from(screen.getByRole("group", { name: group }).querySelectorAll(".nav-btn")).map((b) => b.textContent);

  it("names the four groups in order, and leaves Home on its own", () => {
    renderSidebar();
    expect(labels()).toEqual(["Protect", "Inspect", "Clean up", "Create"]);
    expect(screen.getByRole("button", { name: "Home" }).closest("[role=group]")).toBeNull();
  });

  it("puts each tool in the group it belongs to", () => {
    renderSidebar();
    expect(namesIn("Protect")).toEqual(["Encrypt Files", "Secure Notes", "Passwords Vault", "Bookmarks Vault", "Secure Clipboard"]);
    expect(namesIn("Inspect")).toEqual(["Privacy Check", "Integrity Check", "File Analyzer"]);
    expect(namesIn("Clean up")).toEqual(["System Clean", "Metadata Cleaner", "Shredder"]);
    expect(namesIn("Create")).toEqual(["QR Generator"]);
  });

  it("gives the tools of a group that group's colour", () => {
    renderSidebar();
    const button = (name: string) => screen.getByRole("button", { name });
    expect(button("Shredder").style.getPropertyValue("--nav-hue")).toBe("var(--hue-clean)");
    expect(button("Privacy Check").style.getPropertyValue("--nav-hue")).toBe("var(--hue-inspect)");
    expect(button("Home").style.getPropertyValue("--nav-hue")).toBe("");
  });

  it("keeps the group names out of the way of screen readers, since the group itself is named", () => {
    renderSidebar();
    for (const label of document.querySelectorAll(".nav-group-label")) {
      expect(label).toHaveAttribute("aria-hidden", "true");
    }
  });
});

describe("Sidebar - no search button", () => {
  it("leaves the jump bar to Home and to Ctrl K, so there is only one button for it", () => {
    renderSidebar();
    expect(screen.queryByRole("button", { name: /Jump to/ })).not.toBeInTheDocument();
    expect(document.querySelector(".sidebar-jump")).toBeNull();
  });

  it("starts with Home and the collapse button side by side, then the tools", () => {
    renderSidebar();
    const top = document.querySelector(".sidebar-top") as HTMLElement;
    const buttons = Array.from(top.querySelectorAll("button"));
    expect(buttons).toHaveLength(2);
    expect(buttons[0]).toHaveAccessibleName("Home");
    expect(buttons[1]).toHaveAccessibleName("Collapse sidebar");
  });
});

describe("Sidebar - collapsing", () => {
  const sidebar = () => document.querySelector(".sidebar") as HTMLElement;
  const toggle = () => screen.getByRole("button", { name: /(Collapse|Expand) sidebar/ });

  it("starts expanded", () => {
    renderSidebar();
    expect(sidebar()).not.toHaveClass("collapsed");
    expect(toggle()).toHaveAccessibleName("Collapse sidebar");
    expect(toggle()).toHaveAttribute("aria-expanded", "true");
  });

  it("collapses to icons and expands again", () => {
    renderSidebar();
    fireEvent.click(toggle());
    expect(sidebar()).toHaveClass("collapsed");
    expect(toggle()).toHaveAccessibleName("Expand sidebar");
    expect(toggle()).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(toggle());
    expect(sidebar()).not.toHaveClass("collapsed");
  });

  it("still lets every tool be reached and named while collapsed", () => {
    const { props } = renderSidebar();
    fireEvent.click(toggle());
    fireEvent.click(screen.getByRole("button", { name: "Shredder" }));
    expect(props.setTab).toHaveBeenCalledWith("shred");
    expect(screen.getByRole("button", { name: "Shredder" })).toHaveAttribute("title", "Permanently destroy files");
  });

  it("remembers the choice for next time", () => {
    const first = renderSidebar();
    fireEvent.click(toggle());
    expect(localStorage.getItem("qre_sidebar_collapsed")).toBe("1");
    first.unmount();

    renderSidebar();
    expect(sidebar()).toHaveClass("collapsed");
    fireEvent.click(toggle());
    expect(localStorage.getItem("qre_sidebar_collapsed")).toBe("0");
  });

  it("collapses and expands with Ctrl+B", () => {
    renderSidebar();
    fireEvent.keyDown(window, { key: "b", ctrlKey: true });
    expect(sidebar()).toHaveClass("collapsed");
    fireEvent.keyDown(window, { key: "b", ctrlKey: true });
    expect(sidebar()).not.toHaveClass("collapsed");
  });

  it("works when the browser will not store anything", () => {
    const get = jest.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    const set = jest.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    renderSidebar();
    expect(sidebar()).not.toHaveClass("collapsed");
    fireEvent.click(toggle());
    expect(sidebar()).toHaveClass("collapsed");
    get.mockRestore();
    set.mockRestore();
  });
});

describe("Sidebar - Home in the top row", () => {
  const top = () => document.querySelector(".sidebar-top") as HTMLElement;

  it("puts the collapse button above Home once the sidebar is collapsed, in the page order as well", () => {
    renderSidebar();
    fireEvent.click(screen.getByRole("button", { name: "Collapse sidebar" }));
    const buttons = Array.from(top().querySelectorAll("button"));
    expect(buttons).toHaveLength(2);
    expect(buttons[0]).toHaveAccessibleName("Expand sidebar");
    expect(buttons[1]).toHaveAccessibleName("Home");
  });

  it("keeps keyboard focus on the collapse button when it moves, in both directions", () => {
    renderSidebar();
    fireEvent.click(screen.getByRole("button", { name: "Collapse sidebar" }));
    expect(screen.getByRole("button", { name: "Expand sidebar" })).toHaveFocus();
    fireEvent.click(screen.getByRole("button", { name: "Expand sidebar" }));
    expect(screen.getByRole("button", { name: "Collapse sidebar" })).toHaveFocus();
  });

  it("does not steal focus when the sidebar is collapsed with the keyboard shortcut", () => {
    renderSidebar();
    const outside = document.createElement("input");
    document.body.appendChild(outside);
    outside.focus();
    fireEvent.keyDown(window, { key: "b", ctrlKey: true });
    expect(outside).toHaveFocus();
    outside.remove();
  });

  it("puts Home back first when the sidebar is opened again", () => {
    renderSidebar();
    fireEvent.click(screen.getByRole("button", { name: "Collapse sidebar" }));
    fireEvent.click(screen.getByRole("button", { name: "Expand sidebar" }));
    const buttons = Array.from(top().querySelectorAll("button"));
    expect(buttons[0]).toHaveAccessibleName("Home");
    expect(buttons[1]).toHaveAccessibleName("Collapse sidebar");
  });

  it("keeps Home out of the scrolling list of tools", () => {
    renderSidebar();
    const list = document.querySelector(".sidebar-scroll-area") as HTMLElement;
    expect(within(list).queryByRole("button", { name: "Home" })).not.toBeInTheDocument();
    expect(within(top()).getByRole("button", { name: "Home" })).toBeInTheDocument();
  });

  it("opens Home when it is pressed", () => {
    const { props } = renderSidebar({ activeTab: "vault" });
    fireEvent.click(within(top()).getByRole("button", { name: "Home" }));
    expect(props.setTab).toHaveBeenCalledWith("home");
  });

  it("highlights Home only while Home is open", () => {
    const { rerender, props } = renderSidebar({ activeTab: "home" });
    expect(within(top()).getByRole("button", { name: "Home" })).toHaveClass("active");
    rerender(<Sidebar {...props} activeTab="notes" />);
    expect(within(top()).getByRole("button", { name: "Home" })).not.toHaveClass("active");
  });

  it("keeps Home reachable and named when the sidebar is collapsed", () => {
    const { props } = renderSidebar();
    fireEvent.click(screen.getByRole("button", { name: "Collapse sidebar" }));
    const home = within(top()).getByRole("button", { name: "Home" });
    expect(home).toHaveAttribute("title", "Dashboard");
    fireEvent.click(home);
    expect(props.setTab).toHaveBeenCalledWith("home");
  });

  it("tells each group how many buttons it holds, so the stylesheet knows the least height it needs", () => {
    renderSidebar();
    const counts = Array.from(document.querySelectorAll(".nav-group-wrapper")).map((w) =>
      (w as HTMLElement).style.getPropertyValue("--count"),
    );
    expect(counts).toEqual(["5", "3", "3", "1"]);
  });

  it("puts no tool name on a second line in a list that has no group labels to wrap", () => {
    renderSidebar();
    // Every label is plain text in one span, so it can be kept on one line by the stylesheet.
    for (const span of document.querySelectorAll(".nav-group .nav-btn span")) {
      expect(span.children).toHaveLength(0);
    }
  });
});
