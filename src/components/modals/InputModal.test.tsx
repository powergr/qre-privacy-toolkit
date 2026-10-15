import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";
import { InputModal } from "./InputModal";

function setup(mode: "rename" | "create", initialValue = "") {
  const props = { onConfirm: jest.fn(), onCancel: jest.fn() };
  render(<InputModal mode={mode} initialValue={initialValue} {...props} />);
  return props;
}

const field = () => screen.getByRole("textbox") as HTMLInputElement;

describe("InputModal - wording", () => {
  it("is a New Folder dialog in create mode", () => {
    setup("create");
    expect(screen.getByRole("heading", { name: "New Folder" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create" })).toBeInTheDocument();
  });

  it("is a Rename dialog in rename mode", () => {
    setup("rename", "old.txt");
    expect(screen.getByRole("heading", { name: "Rename Item" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Rename" })).toBeInTheDocument();
  });

  it("starts with the given name and focuses the field", () => {
    setup("rename", "old.txt");
    expect(field().value).toBe("old.txt");
    expect(field()).toHaveFocus();
  });
});

describe("InputModal - confirming", () => {
  it("confirms with the edited text from the button", () => {
    const { onConfirm } = setup("rename", "old.txt");
    fireEvent.change(field(), { target: { value: "new.txt" } });
    fireEvent.click(screen.getByRole("button", { name: "Rename" }));
    expect(onConfirm).toHaveBeenCalledWith("new.txt");
  });

  it("confirms with Enter", () => {
    const { onConfirm } = setup("create");
    fireEvent.change(field(), { target: { value: "Photos" } });
    fireEvent.keyDown(field(), { key: "Enter" });
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onConfirm).toHaveBeenCalledWith("Photos");
  });

  it("ignores other keys", () => {
    const { onConfirm } = setup("create", "x");
    fireEvent.keyDown(field(), { key: "a" });
    fireEvent.keyDown(field(), { key: "Escape" });
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("passes the text on exactly as typed, leaving checks to the caller", () => {
    const { onConfirm } = setup("create");
    fireEvent.change(field(), { target: { value: "  spaced  " } });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    expect(onConfirm).toHaveBeenCalledWith("  spaced  ");
  });
});

describe("InputModal - cancelling", () => {
  it("cancels from the Cancel button, the X and a click outside", () => {
    const { onCancel, onConfirm } = setup("create");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    fireEvent.click(document.querySelector("svg.lucide-x")!);
    fireEvent.click(document.querySelector(".modal-overlay")!);
    expect(onCancel).toHaveBeenCalledTimes(3);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("does not cancel when the click is inside the card", () => {
    const { onCancel } = setup("create");
    fireEvent.click(screen.getByRole("heading", { name: "New Folder" }));
    fireEvent.click(field());
    expect(onCancel).not.toHaveBeenCalled();
  });
});
