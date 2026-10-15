import { render, screen, fireEvent, act } from "@testing-library/react";
import "@testing-library/jest-dom";
import { FileGrid } from "./FileGrid";
import type { FileEntry } from "../../types";

const KEY = "qre-grid-layout";

function entry(name: string, over: Partial<FileEntry> = {}): FileEntry {
  return {
    name,
    isDirectory: false,
    path: `/d/${name}`,
    size: 100,
    modified: null,
    ...over,
  } as FileEntry;
}

type GridProps = React.ComponentProps<typeof FileGrid>;

function setup(entries: FileEntry[], over: Partial<GridProps> = {}) {
  const props: GridProps = {
    entries,
    selectedPaths: [],
    onSelect: jest.fn(),
    onNavigate: jest.fn(),
    onGoUp: jest.fn(),
    onContextMenu: jest.fn(),
    sortField: "name",
    sortDirection: "asc",
    onSort: jest.fn(),
    ...over,
  };
  const utils = render(<FileGrid {...props} />);
  return { props, ...utils };
}

function renderGrid() {
  return setup([entry("file.txt", { path: "/file.txt" })]);
}

const rows = () => Array.from(document.querySelectorAll(".file-row")) as HTMLElement[];
const header = () => document.querySelector(".file-header") as HTMLElement;

afterEach(() => {
  localStorage.clear();
  jest.useRealTimers();
});

describe("FileGrid - corrupted localStorage defense", () => {
  it("falls back to default column widths when localStorage contains malformed JSON", () => {
    localStorage.setItem(KEY, "{not valid json");

    // Regression test: JSON.parse(saved) previously had no try/catch, so a
    // corrupted value here threw synchronously inside the useState
    // initializer and crashed the whole Files view instead of falling back.
    expect(() => renderGrid()).not.toThrow();
    expect(screen.getByText("file.txt")).toBeInTheDocument();
  });

  it("still uses the saved layout when it's valid JSON", () => {
    localStorage.setItem(
      KEY,
      JSON.stringify({ name: 250, type: 80, size: 90 }),
    );

    expect(() => renderGrid()).not.toThrow();
    expect(screen.getByText("file.txt")).toBeInTheDocument();
    expect(header().style.gridTemplateColumns).toBe("40px 250px 80px 90px 1fr");
  });

  it("falls back to defaults when localStorage has nothing saved", () => {
    expect(() => renderGrid()).not.toThrow();
    expect(screen.getByText("file.txt")).toBeInTheDocument();
    expect(header().style.gridTemplateColumns).toBe("40px 400px 100px 100px 1fr");
  });

  it.each([
    ["null", "null"],
    ["a number", "42"],
    ["a string", '"wide"'],
    ["an array", "[1,2,3]"],
    ["an empty object", "{}"],
    ["missing a column", JSON.stringify({ name: 250, type: 80 })],
    ["text widths", JSON.stringify({ name: "250", type: 80, size: 90 })],
    ["a negative width", JSON.stringify({ name: -5, type: 80, size: 90 })],
    ["a non-finite width", '{"name": 1e999, "type": 80, "size": 90}'],
  ])("uses the defaults when the saved value is valid JSON of the wrong shape (%s)", (_label, raw) => {
    localStorage.setItem(KEY, raw);
    expect(() => renderGrid()).not.toThrow();
    expect(header().style.gridTemplateColumns).toBe("40px 400px 100px 100px 1fr");
  });

  it("still renders when the browser refuses to store the layout", () => {
    const spy = jest.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceededError");
    });
    expect(() => renderGrid()).not.toThrow();
    expect(screen.getByText("file.txt")).toBeInTheDocument();
    spy.mockRestore();
  });

  it("saves the layout it is showing", () => {
    renderGrid();
    expect(JSON.parse(localStorage.getItem(KEY)!)).toEqual({
      name: 400,
      type: 100,
      size: 100,
    });
  });
});

describe("FileGrid - header and sorting", () => {
  it("sorts by name, size and modified, but not by type", () => {
    const { props } = setup([entry("a.txt")]);
    fireEvent.click(screen.getByText("Name"));
    expect(props.onSort).toHaveBeenLastCalledWith("name");
    fireEvent.click(screen.getByText("Size"));
    expect(props.onSort).toHaveBeenLastCalledWith("size");
    fireEvent.click(screen.getByText(/Date Modified/));
    expect(props.onSort).toHaveBeenLastCalledWith("modified");
    fireEvent.click(screen.getByText("Type"));
    expect(props.onSort).toHaveBeenCalledTimes(3);
  });

  it("shows the sort arrow only on the active column, pointing the right way", () => {
    const asc = setup([entry("a.txt")], { sortField: "size", sortDirection: "asc" });
    expect(document.querySelectorAll("svg.lucide-chevron-up")).toHaveLength(1);
    expect(document.querySelectorAll("svg.lucide-chevron-down")).toHaveLength(0);
    expect(screen.getByText("Size").querySelector("svg")).not.toBeNull();
    expect(screen.getByText("Name").querySelector("svg")).toBeNull();
    asc.unmount();

    setup([entry("a.txt")], { sortField: "modified", sortDirection: "desc" });
    expect(document.querySelectorAll("svg.lucide-chevron-down")).toHaveLength(1);
    expect(document.querySelectorAll("svg.lucide-chevron-up")).toHaveLength(0);
  });
});

describe("FileGrid - rows", () => {
  it("shows name, type, size and no size for folders", () => {
    setup([
      entry("report.pdf", { size: 2048 }),
      entry("Pictures", { isDirectory: true, size: null }),
    ]);
    const [file, folder] = rows();
    expect(file).toHaveTextContent("report.pdf");
    expect(file).toHaveTextContent("PDF");
    expect(file).toHaveTextContent("2 KB");
    expect(folder).toHaveTextContent("Pictures");
    expect(folder).toHaveTextContent("Folder");
    expect(folder.querySelector(".grid-cell.details[style]")).toHaveTextContent(/^$/);
  });

  it("shows the modified date", () => {
    setup([entry("a.txt", { modified: new Date(2026, 2, 5, 14, 30) })]);
    expect(rows()[0]).toHaveTextContent("2026");
  });

  it("passes the click modifiers to onSelect with the row index", () => {
    const { props } = setup([entry("a.txt"), entry("b.txt")]);
    fireEvent.click(screen.getByText("b.txt"));
    expect(props.onSelect).toHaveBeenLastCalledWith("/d/b.txt", 1, false, false);
    fireEvent.click(screen.getByText("a.txt"), { ctrlKey: true });
    expect(props.onSelect).toHaveBeenLastCalledWith("/d/a.txt", 0, true, false);
    fireEvent.click(screen.getByText("a.txt"), { shiftKey: true });
    expect(props.onSelect).toHaveBeenLastCalledWith("/d/a.txt", 0, false, true);
  });

  it("highlights only the selected rows", () => {
    setup([entry("a.txt"), entry("b.txt"), entry("c.txt")], {
      selectedPaths: ["/d/a.txt", "/d/c.txt"],
    });
    expect(rows().map((r) => r.classList.contains("selected"))).toEqual([
      true,
      false,
      true,
    ]);
  });

  it("opens a folder on double click but not a file", () => {
    const { props } = setup([
      entry("docs", { isDirectory: true }),
      entry("a.txt"),
    ]);
    fireEvent.doubleClick(screen.getByText("a.txt"));
    expect(props.onNavigate).not.toHaveBeenCalled();
    fireEvent.doubleClick(screen.getByText("docs"));
    expect(props.onNavigate).toHaveBeenCalledWith("/d/docs");
  });

  it("opens a drive on double click", () => {
    const { props } = setup([
      entry("C:\\", { isDirectory: true, isDrive: true, path: "C:\\" }),
    ]);
    fireEvent.doubleClick(screen.getByText("C:\\"));
    expect(props.onNavigate).toHaveBeenCalledWith("C:\\");
  });

  it("renders an empty folder without rows", () => {
    setup([]);
    expect(rows()).toHaveLength(0);
    expect(header()).toBeInTheDocument();
  });
});

describe("FileGrid - context menu", () => {
  it("selects an unselected row first, then opens the menu for it", () => {
    const order: string[] = [];
    const { props } = setup([entry("a.txt")]);
    (props.onSelect as jest.Mock).mockImplementation(() => order.push("select"));
    (props.onContextMenu as jest.Mock).mockImplementation(() => order.push("menu"));

    const notPrevented = fireEvent.contextMenu(screen.getByText("a.txt"));
    expect(notPrevented).toBe(false);
    expect(props.onSelect).toHaveBeenCalledWith("/d/a.txt", 0, false, false);
    expect(props.onContextMenu).toHaveBeenCalledWith(expect.anything(), "/d/a.txt");
    expect(order).toEqual(["select", "menu"]);
  });

  it("keeps a multi selection when the right click lands inside it", () => {
    const { props } = setup([entry("a.txt"), entry("b.txt")], {
      selectedPaths: ["/d/a.txt", "/d/b.txt"],
    });
    fireEvent.contextMenu(screen.getByText("b.txt"));
    expect(props.onSelect).not.toHaveBeenCalled();
    expect(props.onContextMenu).toHaveBeenCalledWith(expect.anything(), "/d/b.txt");
  });

  it("does not let the right click reach the background handler", () => {
    const outer = jest.fn();
    const { props } = setup([entry("a.txt")]);
    document.body.addEventListener("contextmenu", outer);
    fireEvent.contextMenu(screen.getByText("a.txt"));
    document.body.removeEventListener("contextmenu", outer);
    expect(props.onContextMenu).toHaveBeenCalledTimes(1);
    expect(outer).not.toHaveBeenCalled();
  });
});

describe("FileGrid - icons", () => {
  const cases: [string, string][] = [
    ["a.qre", "lucide-lock"],
    ["a.jpg", "lucide-image"],
    ["A.PNG", "lucide-image"],
    ["a.mp4", "lucide-film"],
    ["a.flac", "lucide-music"],
    ["a.zip", "lucide-archive"],
    ["a.pdf", "lucide-file-text"],
    ["a.docx", "lucide-file-text"],
    ["a.xlsx", "lucide-sheet"],
    ["a.pptx", "lucide-file-text"],
    ["a.txt", "lucide-file-text"],
    ["a.exe", "lucide-app-window"],
    ["a.dll", "lucide-cpu"],
    ["a.iso", "lucide-disc"],
    ["a.json", "lucide-file-cog"],
    ["a.rs", "lucide-file-code"],
    ["a.unknown", "lucide-file"],
  ];

  it.each(cases)("%s gets %s", (name, cls) => {
    setup([entry(name)]);
    const svg = rows()[0].querySelector(".grid-cell.icon svg")!;
    expect(svg.classList.contains(cls)).toBe(true);
  });

  it("gives folders and drives their own icons", () => {
    setup([
      entry("docs", { isDirectory: true }),
      entry("D:\\", { isDirectory: true, isDrive: true }),
    ]);
    const [folder, drive] = rows();
    expect(folder.querySelector(".grid-cell.icon svg")).toHaveClass("lucide-folder");
    expect(drive.querySelector(".grid-cell.icon svg")).toHaveClass("lucide-hard-drive");
  });

  it("does not give a folder named like a file extension a file icon", () => {
    setup([entry("photos.jpg", { isDirectory: true })]);
    expect(rows()[0].querySelector(".grid-cell.icon svg")).toHaveClass("lucide-folder");
  });
});

describe("FileGrid - time-lock badge", () => {
  const NOW = new Date(2026, 5, 1, 12, 0, 0);
  const nowSec = () => Math.floor(NOW.getTime() / 1000);

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(NOW);
  });

  function lockedGrid(remainingSecs: number, name = "a.txt.qre") {
    const e = entry(name);
    return setup([e], {
      timeLockPaths: new Set([e.path]),
      timeLockInfo: new Map([[e.path, nowSec() + remainingSecs]]),
    });
  }

  const badge = () => rows()[0].querySelector(".grid-cell:not(.icon) span") as HTMLElement | null;

  it.each([
    [30, "1m"],
    [60, "1m"],
    [61, "2m"],
    [59 * 60, "59m"],
    [3600, "1h"],
    [3600 + 29 * 60, "1h 29m"],
    [23 * 3600 + 59 * 60, "23h 59m"],
    [86400, "1d"],
    [86400 + 5 * 3600, "1d 5h"],
    [3 * 86400 + 59 * 60, "3d"],
  ])("shows %i seconds left as %s", (secs, label) => {
    lockedGrid(secs);
    expect(badge()).toHaveTextContent(label);
  });

  it("never shows 60m: just under an hour reads as 1h", () => {
    // 59m 30s rounds up to a whole minute; "60m" next to a plain "1h" looks like a mistake.
    lockedGrid(59 * 60 + 30);
    expect(badge()).not.toHaveTextContent("60m");
    expect(badge()).toHaveTextContent("1h");
  });

  it("says expired once the time has passed, including the exact second", () => {
    lockedGrid(-5);
    expect(badge()).toHaveTextContent("expired");
  });

  it("says expired at exactly zero seconds left, not 0m", () => {
    lockedGrid(0);
    expect(badge()).toHaveTextContent("expired");
    expect(badge()).not.toHaveTextContent("0m");
  });

  it("falls back to a plain label when there is no timestamp", () => {
    const e = entry("a.txt.qre");
    setup([e], { timeLockPaths: new Set([e.path]) });
    expect(badge()).toHaveTextContent("locked");
    expect(rows()[0].querySelector(".grid-cell.icon")).toHaveAttribute("title", "Time-locked");
  });

  it("describes the unlock moment in the tooltip", () => {
    lockedGrid(2 * 86400);
    const title = rows()[0].querySelector(".grid-cell.icon")!.getAttribute("title")!;
    expect(title).toMatch(/^Time-locked until /);
    expect(title).toContain("2026");
    expect(badge()!.getAttribute("title")).toBe(title);
  });

  it("marks the icon with a clock", () => {
    lockedGrid(3600);
    expect(rows()[0].querySelector("svg.lucide-calendar-clock")).not.toBeNull();
  });

  it("shows nothing for a file that is not in the time-lock set", () => {
    setup([entry("a.txt.qre")], {
      timeLockPaths: new Set(["/d/other.qre"]),
      timeLockInfo: new Map([["/d/other.qre", nowSec() + 100]]),
    });
    expect(badge()).toBeNull();
    expect(rows()[0].querySelector("svg.lucide-calendar-clock")).toBeNull();
  });

  it("shows nothing for a non-.qre file even if it is in the set", () => {
    const e = entry("a.txt");
    setup([e], {
      timeLockPaths: new Set([e.path]),
      timeLockInfo: new Map([[e.path, nowSec() + 100]]),
    });
    expect(badge()).toBeNull();
  });

  it("shows nothing when no set is passed", () => {
    setup([entry("a.txt.qre")]);
    expect(badge()).toBeNull();
  });
});

describe("FileGrid - resizing columns", () => {
  const handles = () => Array.from(document.querySelectorAll(".resize-handle")) as HTMLElement[];

  function drag(handle: HTMLElement, dx: number) {
    fireEvent.mouseDown(handle);
    const move = new MouseEvent("mousemove", { bubbles: true });
    Object.defineProperty(move, "movementX", { value: dx });
    act(() => {
      window.dispatchEvent(move);
    });
  }

  const template = () => header().style.gridTemplateColumns;

  it("widens the dragged column and leaves the others alone", () => {
    setup([entry("a.txt")]);
    const [name, type, size] = handles();
    drag(name, 30);
    expect(template()).toBe("40px 430px 100px 100px 1fr");
    fireEvent.mouseUp(window);
    drag(type, -20);
    expect(template()).toBe("40px 430px 80px 100px 1fr");
    fireEvent.mouseUp(window);
    drag(size, 5);
    expect(template()).toBe("40px 430px 80px 105px 1fr");
  });

  it("never makes a column narrower than 50px", () => {
    setup([entry("a.txt")]);
    drag(handles()[1], -500);
    expect(template()).toBe("40px 400px 50px 100px 1fr");
  });

  it("stops resizing on mouse up", () => {
    setup([entry("a.txt")]);
    drag(handles()[0], 10);
    fireEvent.mouseUp(window);
    const move = new MouseEvent("mousemove", { bubbles: true });
    Object.defineProperty(move, "movementX", { value: 99 });
    act(() => {
      window.dispatchEvent(move);
    });
    expect(template()).toBe("40px 410px 100px 100px 1fr");
  });

  it("keeps following the pointer across several moves", () => {
    setup([entry("a.txt")]);
    fireEvent.mouseDown(handles()[0]);
    for (let i = 0; i < 3; i++) {
      const move = new MouseEvent("mousemove", { bubbles: true });
      Object.defineProperty(move, "movementX", { value: 10 });
      act(() => {
        window.dispatchEvent(move);
      });
    }
    expect(template()).toBe("40px 430px 100px 100px 1fr");
  });

  it("saves the new width", () => {
    setup([entry("a.txt")]);
    drag(handles()[0], 25);
    expect(JSON.parse(localStorage.getItem(KEY)!).name).toBe(425);
  });

  it("does not sort when the drag handle is pressed", () => {
    const { props } = setup([entry("a.txt")]);
    fireEvent.mouseDown(handles()[0]);
    expect(props.onSort).not.toHaveBeenCalled();
  });

  it("removes its window listeners when the grid goes away", () => {
    const remove = jest.spyOn(window, "removeEventListener");
    const { unmount } = setup([entry("a.txt")]);
    fireEvent.mouseDown(handles()[0]);
    unmount();
    const removed = remove.mock.calls.map(([type]) => type);
    expect(removed).toEqual(expect.arrayContaining(["mousemove", "mouseup"]));
    remove.mockRestore();
  });
});
