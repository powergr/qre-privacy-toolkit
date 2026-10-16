import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";
import { Banner } from "./Banner";
import { DropZone } from "./DropZone";

describe("Banner", () => {
  it("shows its message", () => {
    render(<Banner>Could not read the file.</Banner>);
    expect(screen.getByText("Could not read the file.")).toBeInTheDocument();
  });

  it("is a polite status message by default", () => {
    render(<Banner>Tip</Banner>);
    expect(screen.getByRole("status")).toHaveClass("ui-banner--info");
  });

  it("announces errors and warnings at once", () => {
    const { rerender } = render(<Banner tone="error">Bad</Banner>);
    expect(screen.getByRole("alert")).toHaveClass("ui-banner--error");
    rerender(<Banner tone="warning">Careful</Banner>);
    expect(screen.getByRole("alert")).toHaveClass("ui-banner--warning");
  });

  it("keeps success quiet", () => {
    render(<Banner tone="success">Saved</Banner>);
    expect(screen.getByRole("status")).toHaveClass("ui-banner--success");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("has no close button unless it can be dismissed", () => {
    render(<Banner>Plain</Banner>);
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("closes through its dismiss button", () => {
    const onDismiss = jest.fn();
    render(<Banner onDismiss={onDismiss}>Oops</Banner>);
    fireEvent.click(screen.getByRole("button", { name: "Dismiss message" }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("draws the dismiss button with the close icon, which older tests and styles look for", () => {
    render(<Banner onDismiss={() => {}}>Oops</Banner>);
    expect(document.querySelector("button svg.lucide-x")).toBeInTheDocument();
  });

  it("shows an action next to the message", () => {
    const onClick = jest.fn();
    render(<Banner tone="error" action={<button onClick={onClick}>Try again</button>}>Failed</Banner>);
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("hides the decorative icon from screen readers, and lets a caller replace it", () => {
    const { container, rerender } = render(<Banner tone="error">x</Banner>);
    expect(container.querySelector(".ui-banner__icon")).toHaveAttribute("aria-hidden", "true");
    rerender(
      <Banner icon={<svg data-testid="mine" />}>x</Banner>,
    );
    expect(screen.getByTestId("mine")).toBeInTheDocument();
  });

  it("keeps extra class names", () => {
    render(<Banner className="mine">x</Banner>);
    expect(screen.getByRole("status")).toHaveClass("ui-banner", "mine");
  });
});

describe("DropZone", () => {
  const zone = () => document.querySelector(".ui-drop") as HTMLElement;

  it("shows the icon, the title, a description and a hint", () => {
    render(
      <DropZone
        icon={<svg data-testid="icon" />}
        title="Drag & Drop a File"
        description="Supports ISOs and archives"
        hint="Maximum file size: 10 GB"
      />,
    );
    expect(screen.getByRole("heading", { name: "Drag & Drop a File" })).toBeInTheDocument();
    expect(screen.getByText("Supports ISOs and archives")).toBeInTheDocument();
    expect(screen.getByText("Maximum file size: 10 GB")).toBeInTheDocument();
    expect(screen.getByTestId("icon")).toBeInTheDocument();
  });

  it("keeps the older shred-zone class, which styles and tests look for", () => {
    render(<DropZone icon={<svg />} title="Drop" />);
    expect(zone()).toHaveClass("shred-zone", "ui-drop");
  });

  it("marks itself active while a file is dragged over the window", () => {
    const { rerender } = render(<DropZone icon={<svg />} title="Drop" />);
    expect(zone()).not.toHaveClass("active");
    rerender(<DropZone icon={<svg />} title="Drop" active />);
    expect(zone()).toHaveClass("active");
  });

  it("opens the picker when the zone is pressed", () => {
    const onBrowse = jest.fn();
    render(<DropZone icon={<svg />} title="Drop" onBrowse={onBrowse} />);
    fireEvent.click(zone());
    expect(onBrowse).toHaveBeenCalledTimes(1);
  });

  it("opens the picker once, not twice, when its button is pressed", () => {
    const onBrowse = jest.fn();
    render(<DropZone icon={<svg />} title="Drop" buttonLabel="Select File" onBrowse={onBrowse} />);
    fireEvent.click(screen.getByRole("button", { name: /Select File/ }));
    expect(onBrowse).toHaveBeenCalledTimes(1);
  });

  it("lets only the button respond when the zone is not clickable", () => {
    const onBrowse = jest.fn();
    render(<DropZone icon={<svg />} title="Scan Your Device" buttonLabel="Start" onBrowse={onBrowse} clickable={false} />);
    fireEvent.click(screen.getByText("Scan Your Device"));
    expect(onBrowse).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: /Start/ }));
    expect(onBrowse).toHaveBeenCalledTimes(1);
  });

  it("can use another icon on its button", () => {
    render(<DropZone icon={<svg />} title="x" buttonLabel="Go" onBrowse={() => {}} buttonIcon={<svg data-testid="mine" />} />);
    expect(screen.getByTestId("mine")).toBeInTheDocument();
    expect(document.querySelector(".ui-drop__button svg.lucide-upload")).toBeNull();
  });

  it("uses the upload arrow on its button by default", () => {
    render(<DropZone icon={<svg />} title="x" buttonLabel="Go" onBrowse={() => {}} />);
    expect(document.querySelector(".ui-drop__button svg.lucide-upload")).toBeInTheDocument();
  });

  it("has no button without a picker to open", () => {
    render(<DropZone icon={<svg />} title="Drop" buttonLabel="Select File" />);
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("does nothing when disabled, and disables its button", () => {
    const onBrowse = jest.fn();
    render(<DropZone icon={<svg />} title="Drop" buttonLabel="Select File" onBrowse={onBrowse} disabled />);
    fireEvent.click(zone());
    expect(onBrowse).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: /Select File/ })).toBeDisabled();
  });

  it("can be a shorter zone, take a colour, and hold extra content", () => {
    render(
      <DropZone icon={<svg />} title="Drop" compact hue="var(--hue-clean)">
        <span>extra</span>
      </DropZone>,
    );
    expect(zone()).toHaveClass("ui-drop--compact");
    expect(zone().style.getPropertyValue("--drop-hue")).toBe("var(--hue-clean)");
    expect(screen.getByText("extra")).toBeInTheDocument();
  });

  it("leaves out the parts it was not given", () => {
    render(<DropZone icon={<svg />} title="Only a title" />);
    expect(document.querySelector(".ui-drop__desc")).toBeNull();
    expect(document.querySelector(".ui-drop__hint")).toBeNull();
  });
});
