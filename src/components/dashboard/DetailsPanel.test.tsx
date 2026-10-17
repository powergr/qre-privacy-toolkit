import { render, screen, fireEvent, within } from "@testing-library/react";
import "@testing-library/jest-dom";
import { DetailsPanel, parentFolder } from "./DetailsPanel";
import type { FileEntry } from "../../types";

const entry = (over: Partial<FileEntry> = {}): FileEntry => ({
  name: "report.pdf",
  isDirectory: false,
  path: "C:\\Users\\me\\report.pdf",
  size: 2048,
  modified: new Date(2026, 0, 15, 10, 30),
  ...over,
});

const none = new Map<string, number>();
const value = (label: string) => {
  const row = screen.getByText(label, { selector: "dt" }).closest(".details-panel__row") as HTMLElement;
  return row.querySelector("dd")!.textContent;
};

describe("parentFolder", () => {
  it("returns the folder a path is in, for either kind of slash", () => {
    expect(parentFolder("C:\\Users\\me\\report.pdf")).toBe("C:\\Users\\me");
    expect(parentFolder("/home/me/report.pdf")).toBe("/home/me");
  });
  it("keeps the slash of a drive root and of the filesystem root", () => {
    expect(parentFolder("C:\\Users")).toBe("C:\\");
    expect(parentFolder("/home")).toBe("/");
  });
  it("gives an empty string for a bare name", () => {
    expect(parentFolder("report.pdf")).toBe("");
  });
});

describe("DetailsPanel", () => {
  it("asks for a selection when nothing is selected", () => {
    render(<DetailsPanel selected={[]} timeLockInfo={none} onClose={() => {}} />);
    expect(screen.getByText("Select a file or folder to see its details.")).toBeInTheDocument();
    expect(document.querySelector("dl")).toBeNull();
  });

  it("describes one file: type, size, date and where it is", () => {
    render(<DetailsPanel selected={[entry()]} timeLockInfo={none} onClose={() => {}} />);
    expect(screen.getByText("report.pdf")).toBeInTheDocument();
    expect(value("Type")).toBe("PDF file");
    expect(value("Size")).toBe("2 KB");
    expect(value("Location")).toBe("C:\\Users\\me");
    expect(value("Modified")).not.toBe("");
  });

  it("calls a folder a folder and shows no size for it", () => {
    render(
      <DetailsPanel selected={[entry({ name: "Taxes", isDirectory: true, size: null })]} timeLockInfo={none} onClose={() => {}} />,
    );
    expect(value("Type")).toBe("Folder");
    expect(screen.queryByText("Size", { selector: "dt" })).not.toBeInTheDocument();
  });

  it("shows no size for a folder even when the listing gave one", () => {
    render(
      <DetailsPanel selected={[entry({ name: "Taxes", isDirectory: true, size: 4096 })]} timeLockInfo={none} onClose={() => {}} />,
    );
    expect(screen.queryByText("Size", { selector: "dt" })).not.toBeInTheDocument();
  });

  it("names an encrypted file by what it is", () => {
    render(<DetailsPanel selected={[entry({ name: "taxes.qre" })]} timeLockInfo={none} onClose={() => {}} />);
    expect(value("Type")).toBe("QRE encrypted file");
  });

  it("says plain File for a name with no extension, and for a hidden file", () => {
    const { rerender } = render(<DetailsPanel selected={[entry({ name: "README" })]} timeLockInfo={none} onClose={() => {}} />);
    expect(value("Type")).toBe("File");
    rerender(<DetailsPanel selected={[entry({ name: ".env" })]} timeLockInfo={none} onClose={() => {}} />);
    expect(value("Type")).toBe("File");
    rerender(<DetailsPanel selected={[entry({ name: "trailing." })]} timeLockInfo={none} onClose={() => {}} />);
    expect(value("Type")).toBe("File");
  });

  it("describes a drive without a size or a location", () => {
    render(
      <DetailsPanel
        selected={[entry({ name: "C:", isDrive: true, isDirectory: true, size: null, path: "C:\\" })]}
        timeLockInfo={none}
        onClose={() => {}}
      />,
    );
    expect(value("Type")).toBe("Drive");
    expect(screen.queryByText("Location", { selector: "dt" })).not.toBeInTheDocument();
  });

  it("leaves out the date when the folder listing has none", () => {
    render(<DetailsPanel selected={[entry({ modified: null })]} timeLockInfo={none} onClose={() => {}} />);
    expect(screen.queryByText("Modified", { selector: "dt" })).not.toBeInTheDocument();
  });

  it("shows when a time-locked file opens", () => {
    const e = entry({ name: "later.qre", path: "C:\\later.qre" });
    render(<DetailsPanel selected={[e]} timeLockInfo={new Map([[e.path, 1_900_000_000]])} onClose={() => {}} />);
    expect(value("Time lock")).toMatch(/^Until /);
    expect(value("Time lock")).toContain("2030");
  });

  it("shows no time lock for a file that has none", () => {
    render(<DetailsPanel selected={[entry()]} timeLockInfo={none} onClose={() => {}} />);
    expect(screen.queryByText("Time lock", { selector: "dt" })).not.toBeInTheDocument();
  });

  it("totals several items, counting folders and files apart", () => {
    render(
      <DetailsPanel
        selected={[
          entry({ name: "a.txt", size: 1024 }),
          entry({ name: "b.txt", size: 2048, path: "C:\\b.txt" }),
          entry({ name: "dir", isDirectory: true, size: null, path: "C:\\dir" }),
        ]}
        timeLockInfo={none}
        onClose={() => {}}
      />,
    );
    expect(screen.getByText("3 items selected")).toBeInTheDocument();
    expect(value("Folders")).toBe("1");
    expect(value("Files")).toBe("2");
    expect(value("Total size")).toBe("3 KB");
    expect(screen.queryByText("Type", { selector: "dt" })).not.toBeInTheDocument();
    expect(screen.queryByText("Location", { selector: "dt" })).not.toBeInTheDocument();
  });

  it("switches to the totals as soon as a second item is selected", () => {
    render(
      <DetailsPanel
        selected={[entry({ name: "a.txt" }), entry({ name: "b.txt", path: "C:\b.txt" })]}
        timeLockInfo={none}
        onClose={() => {}}
      />,
    );
    expect(screen.getByText("2 items selected")).toBeInTheDocument();
    expect(value("Files")).toBe("2");
  });

  it("closes through its button", () => {
    const onClose = jest.fn();
    render(<DetailsPanel selected={[]} timeLockInfo={none} onClose={onClose} />);
    fireEvent.click(within(screen.getByRole("complementary", { name: "Details" })).getByRole("button", { name: "Close details" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
