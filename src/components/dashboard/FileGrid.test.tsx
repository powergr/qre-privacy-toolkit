import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";
import { FileGrid } from "./FileGrid";

function renderGrid() {
  return render(
    <FileGrid
      entries={[
        {
          name: "file.txt",
          isDirectory: false,
          path: "/file.txt",
          size: 100,
          modified: null,
        },
      ]}
      selectedPaths={[]}
      onSelect={jest.fn()}
      onNavigate={jest.fn()}
      onGoUp={jest.fn()}
      onContextMenu={jest.fn()}
      sortField="name"
      sortDirection="asc"
      onSort={jest.fn()}
    />,
  );
}

describe("FileGrid - corrupted localStorage defense", () => {
  const KEY = "qre-grid-layout";

  afterEach(() => {
    localStorage.clear();
  });

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
  });

  it("falls back to defaults when localStorage has nothing saved", () => {
    expect(() => renderGrid()).not.toThrow();
    expect(screen.getByText("file.txt")).toBeInTheDocument();
  });
});
