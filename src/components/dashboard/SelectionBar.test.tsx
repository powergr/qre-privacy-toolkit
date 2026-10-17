import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";
import { SelectionBar } from "./SelectionBar";

function setup(over: Partial<React.ComponentProps<typeof SelectionBar>> = {}) {
  const props = {
    names: ["a.txt"],
    totalSize: 2048,
    detailsOpen: false,
    onToggleDetails: jest.fn(),
    onDelete: jest.fn(),
    onClear: jest.fn(),
    ...over,
  };
  return { props, ...render(<SelectionBar {...props} />) };
}

describe("SelectionBar", () => {
  it("is not there while nothing is selected", () => {
    const { container } = setup({ names: [] });
    expect(container).toBeEmptyDOMElement();
  });

  it("names the one selected item", () => {
    setup();
    expect(screen.getByRole("region", { name: "Selection" })).toHaveTextContent("Selected: a.txt");
  });

  it("gives the count and the total size for several items", () => {
    setup({ names: ["a", "b", "c"], totalSize: 3 * 1024 * 1024 });
    expect(screen.getByText("3 items selected, 3 MB")).toBeInTheDocument();
  });

  it("runs the three actions", () => {
    const { props } = setup();
    fireEvent.click(screen.getByRole("button", { name: "Details" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    fireEvent.click(screen.getByRole("button", { name: "Clear selection" }));
    expect(props.onToggleDetails).toHaveBeenCalledTimes(1);
    expect(props.onDelete).toHaveBeenCalledTimes(1);
    expect(props.onClear).toHaveBeenCalledTimes(1);
  });

  it("shows whether the details are open", () => {
    const { rerender, props } = setup();
    expect(screen.getByRole("button", { name: "Details" })).toHaveAttribute("aria-pressed", "false");
    rerender(<SelectionBar {...props} detailsOpen />);
    expect(screen.getByRole("button", { name: "Details" })).toHaveAttribute("aria-pressed", "true");
  });
});
