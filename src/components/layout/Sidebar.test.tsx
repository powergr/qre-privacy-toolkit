import { render, screen, fireEvent } from "@testing-library/react";
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
  "System Clean",
  "Metadata Cleaner",
  "Shredder",
  "File Analyzer",
  "QR Generator",
];

beforeEach(() => setNarrowScreen(false));

describe("Sidebar - navigation", () => {
  it("lists every tool in order", () => {
    renderSidebar();
    const labels = Array.from(document.querySelectorAll(".nav-group .nav-btn")).map((b) => b.textContent);
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
      "sysclean",
      "cleaner",
      "shred",
      "analyzer",
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
