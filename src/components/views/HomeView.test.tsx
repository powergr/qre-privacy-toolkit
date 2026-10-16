import { render, screen, fireEvent, within } from "@testing-library/react";
import "@testing-library/jest-dom";
import { HomeView, greeting } from "./HomeView";

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

const CARDS: [string, string][] = [
  ["Encrypt Files", "files"],
  ["Secure Notes", "notes"],
  ["Passwords", "vault"],
  ["Bookmarks", "bookmarks"],
  ["Clipboard", "clipboard"],
  ["Privacy Check", "breach"],
  ["Integrity Check", "hash"],
  ["System Clean", "sysclean"],
  ["Metadata Cleaner", "cleaner"],
  ["Shredder", "shred"],
  ["File Analyzer", "analyzer"],
  ["QR Generator", "qr"],
];

describe("HomeView", () => {
  it("shows the app name and one card per tool", () => {
    render(<HomeView setTab={jest.fn()} />);
    expect(screen.getByRole("heading", { name: "QRE Privacy Toolkit" })).toBeInTheDocument();
    expect(document.querySelectorAll(".home-card")).toHaveLength(CARDS.length);
  });

  it.each(CARDS)("the %s card opens the %s tab", (title, tabId) => {
    const setTab = jest.fn();
    render(<HomeView setTab={setTab} />);
    fireEvent.click(screen.getByRole("heading", { name: title }));
    expect(setTab).toHaveBeenCalledTimes(1);
    expect(setTab).toHaveBeenCalledWith(tabId);
  });

  it("only links to tabs the app can render, with no duplicates", () => {
    const setTab = jest.fn();
    render(<HomeView setTab={setTab} />);
    for (const card of Array.from(document.querySelectorAll(".home-card"))) fireEvent.click(card);

    const ids = setTab.mock.calls.map(([id]) => id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(APP_TAB_IDS).toContain(id);
  });
});

describe("greeting", () => {
  const at = (hour: number) => greeting(new Date(2026, 0, 1, hour, 30));

  it("changes through the day", () => {
    expect(at(5)).toBe("Good morning");
    expect(at(11)).toBe("Good morning");
    expect(at(12)).toBe("Good afternoon");
    expect(at(17)).toBe("Good afternoon");
    expect(at(18)).toBe("Good evening");
    expect(at(23)).toBe("Good evening");
    expect(at(2)).toBe("Good evening");
    expect(at(4)).toBe("Good evening");
  });
});

describe("HomeView - layout", () => {
  it("keeps everything in one centred column, so a wide window never pushes it to one side", () => {
    render(<HomeView setTab={jest.fn()} />);
    const inner = document.querySelector(".home__inner") as HTMLElement;
    expect(inner).toBeInTheDocument();
    // The header, the panels and every tool group are all inside that one column.
    expect(inner.querySelector(".home__hero")).toBeInTheDocument();
    expect(inner.querySelectorAll(".home-group")).toHaveLength(4);
    expect(inner.querySelectorAll(".home-card")).toHaveLength(12);
    expect(document.querySelector(".home")!.children).toHaveLength(1);
  });

  it("greets the user and says the data stays on the device", () => {
    render(<HomeView setTab={jest.fn()} />);
    expect(screen.getByText(/Everything is stored on this device/)).toBeInTheDocument();
    expect(screen.getByText(/^Good (morning|afternoon|evening)\./)).toBeInTheDocument();
  });
});

describe("HomeView - tool groups", () => {
  const group = (name: string) => screen.getByRole("region", { name });
  const titlesIn = (name: string) =>
    within(group(name))
      .getAllByRole("heading", { level: 3 })
      .map((h) => h.textContent);

  it("shows the four groups, each with a short description", () => {
    render(<HomeView setTab={jest.fn()} />);
    for (const [name, blurb] of [
      ["Protect", /Keep your data private/],
      ["Inspect", /Check what you already have/],
      ["Clean up", /Remove traces for good/],
      ["Create", /Make things offline/],
    ] as const) {
      expect(group(name)).toHaveTextContent(blurb);
    }
  });

  it("puts each tool under its group, in sidebar order", () => {
    render(<HomeView setTab={jest.fn()} />);
    expect(titlesIn("Protect")).toEqual(["Encrypt Files", "Secure Notes", "Passwords", "Bookmarks", "Clipboard"]);
    expect(titlesIn("Inspect")).toEqual(["Privacy Check", "Integrity Check", "File Analyzer"]);
    expect(titlesIn("Clean up")).toEqual(["System Clean", "Metadata Cleaner", "Shredder"]);
    expect(titlesIn("Create")).toEqual(["QR Generator"]);
  });

  it("makes every tile a real button, so the keyboard can reach and press it", () => {
    const setTab = jest.fn();
    render(<HomeView setTab={setTab} />);
    const tile = screen.getByRole("button", { name: /Shredder/ });
    expect(tile.tagName).toBe("BUTTON");
    expect(tile).toHaveAccessibleName("Shredder Permanently destroy files.");
    fireEvent.click(tile);
    expect(setTab).toHaveBeenCalledWith("shred");
  });

  it("keeps each tile's description as a tooltip, for when a short window hides the text", () => {
    render(<HomeView setTab={jest.fn()} />);
    expect(screen.getByRole("button", { name: /Shredder/ })).toHaveAttribute("title", "Permanently destroy files.");
    expect(screen.getByRole("button", { name: /Metadata Cleaner/ })).toHaveAttribute(
      "title",
      "Strip hidden metadata from any file.",
    );
  });

  it("colours each tile by its group", () => {
    render(<HomeView setTab={jest.fn()} />);
    const hue = (name: RegExp) => screen.getByRole("button", { name }).style.getPropertyValue("--tile-hue");
    expect(hue(/Encrypt Files/)).toBe("var(--hue-protect)");
    expect(hue(/File Analyzer/)).toBe("var(--hue-inspect)");
    expect(hue(/Shredder/)).toBe("var(--hue-clean)");
    expect(hue(/QR Generator/)).toBe("var(--hue-create)");
  });
});

describe("HomeView - jump button", () => {
  it("is left out when the app cannot open the jump bar", () => {
    render(<HomeView setTab={jest.fn()} />);
    expect(screen.queryByRole("button", { name: "Jump to a tool or action" })).not.toBeInTheDocument();
  });

  it("opens the jump bar and shows its shortcut", () => {
    const onOpenPalette = jest.fn();
    render(<HomeView setTab={jest.fn()} onOpenPalette={onOpenPalette} />);
    const button = screen.getByRole("button", { name: "Jump to a tool or action" });
    expect(button).toHaveTextContent("K");
    fireEvent.click(button);
    expect(onOpenPalette).toHaveBeenCalledTimes(1);
  });
});

describe("HomeView - protection", () => {
  const panel = () => screen.getByRole("region", { name: /Protection/ });

  it("is left out when the backup state is not known", () => {
    render(<HomeView setTab={jest.fn()} />);
    expect(screen.queryByRole("region", { name: /Protection/ })).not.toBeInTheDocument();
  });

  it("says all is set once the keychain is backed up", () => {
    render(<HomeView setTab={jest.fn()} backupDone onBackup={jest.fn()} />);
    expect(panel()).toHaveTextContent("All set");
    expect(panel()).toHaveTextContent("Keychain backed up");
    expect(within(panel()).queryByRole("button", { name: "Back up now" })).not.toBeInTheDocument();
  });

  it("asks for a backup when there is none, with a button that opens it", () => {
    const onBackup = jest.fn();
    render(<HomeView setTab={jest.fn()} backupDone={false} onBackup={onBackup} />);
    expect(panel()).toHaveTextContent("1 to do");
    expect(panel()).toHaveTextContent("Back up your keychain");
    fireEvent.click(within(panel()).getByRole("button", { name: "Back up now" }));
    expect(onBackup).toHaveBeenCalledTimes(1);
  });

  it("states the automatic protections that are always on", () => {
    render(<HomeView setTab={jest.fn()} backupDone />);
    expect(panel()).toHaveTextContent("Locks after 15 minutes of inactivity");
    expect(panel()).toHaveTextContent("Copied secrets are wiped after 30 seconds");
  });

  it("shows no button when there is nothing to open the backup with", () => {
    render(<HomeView setTab={jest.fn()} backupDone={false} />);
    expect(within(panel()).queryByRole("button")).not.toBeInTheDocument();
  });
});

describe("HomeView - recent tools", () => {
  const panel = () => screen.getByRole("region", { name: "Pick up where you left off" });

  it("explains itself while there is nothing to show", () => {
    render(<HomeView setTab={jest.fn()} />);
    expect(panel()).toHaveTextContent("kept in memory only");
    expect(panel()).toHaveTextContent("cleared when the app locks");
    expect(within(panel()).queryByRole("button")).not.toBeInTheDocument();
  });

  it("lists the recent tools in the order given and opens one when clicked", () => {
    const setTab = jest.fn();
    render(<HomeView setTab={setTab} recent={["vault", "notes", "shred"]} />);
    const buttons = within(panel()).getAllByRole("button");
    expect(buttons.map((b) => b.textContent)).toEqual(["Passwords", "Secure Notes", "Shredder"]);
    fireEvent.click(buttons[1]);
    expect(setTab).toHaveBeenCalledWith("notes");
  });

  it("shows at most three", () => {
    render(<HomeView setTab={jest.fn()} recent={["vault", "notes", "shred", "qr", "hash"]} />);
    expect(within(panel()).getAllByRole("button")).toHaveLength(3);
  });

  it("ignores ids that are not tools", () => {
    render(<HomeView setTab={jest.fn()} recent={["settings", "nonsense", "qr"]} />);
    expect(within(panel()).getAllByRole("button").map((b) => b.textContent)).toEqual(["QR Generator"]);
  });

  it("does not count the recent buttons as tool tiles", () => {
    render(<HomeView setTab={jest.fn()} recent={["vault", "notes"]} />);
    expect(document.querySelectorAll(".home-card")).toHaveLength(12);
  });
});

describe("HomeView - everything on one screen", () => {
  const columns = () => Array.from(document.querySelectorAll(".home__col")) as HTMLElement[];
  const groupNames = (col: HTMLElement) =>
    Array.from(col.querySelectorAll(".home-group__title")).map((h) => h.textContent);

  it("lays the tools out in three columns, so no group has to be scrolled to", () => {
    render(<HomeView setTab={jest.fn()} backupDone />);
    expect(columns()).toHaveLength(3);
    expect(groupNames(columns()[0])).toEqual(["Protect"]);
    expect(groupNames(columns()[1])).toEqual(["Inspect", "Create"]);
    expect(groupNames(columns()[2])).toEqual(["Clean up"]);
  });

  it("holds all twelve tools in those columns, each once", () => {
    render(<HomeView setTab={jest.fn()} />);
    const perColumn = columns().map((c) => c.querySelectorAll(".home-card").length);
    expect(perColumn).toEqual([5, 4, 3]);
    expect(perColumn.reduce((a, b) => a + b, 0)).toBe(12);
  });

  it("puts the recent tools under Create, in the middle column", () => {
    render(<HomeView setTab={jest.fn()} recent={["vault"]} />);
    const middle = columns()[1];
    const order = Array.from(middle.children).map((c) =>
      c.classList.contains("home-recent-panel") ? "recent" : c.querySelector(".home-group__title")!.textContent,
    );
    expect(order).toEqual(["Inspect", "Create", "recent"]);
  });

  it("puts the protection panel under Clean up, in the right column", () => {
    render(<HomeView setTab={jest.fn()} backupDone={false} onBackup={jest.fn()} />);
    const right = columns()[2];
    const order = Array.from(right.children).map((c) =>
      c.classList.contains("home-protection") ? "protection" : c.querySelector(".home-group__title")!.textContent,
    );
    expect(order).toEqual(["Clean up", "protection"]);
    expect(right.querySelectorAll(".home-panel__row")).toHaveLength(3);
  });

  it("leaves the right column with just its group when the backup state is unknown", () => {
    render(<HomeView setTab={jest.fn()} />);
    expect(columns()[2].querySelector(".home-protection")).toBeNull();
    expect(columns()[2].children).toHaveLength(1);
  });

  it("puts the name and the jump button in one header row", () => {
    render(<HomeView setTab={jest.fn()} onOpenPalette={jest.fn()} />);
    const hero = document.querySelector(".home__hero") as HTMLElement;
    expect(within(hero).getByRole("heading", { level: 1, name: "QRE Privacy Toolkit" })).toBeInTheDocument();
    expect(within(hero).getByRole("button", { name: "Jump to a tool or action" })).toBeInTheDocument();
  });

  it("has only the header and the columns, with no long list below them", () => {
    render(<HomeView setTab={jest.fn()} backupDone />);
    const inner = document.querySelector(".home__inner") as HTMLElement;
    expect(Array.from(inner.children).map((c) => c.className.split(" ")[0])).toEqual([
      "home__hero",
      "home__columns",
    ]);
  });
});
