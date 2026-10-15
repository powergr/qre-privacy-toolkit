import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";
import { HomeView } from "./HomeView";

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
