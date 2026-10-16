import { createRef } from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";
import { Button } from "./Button";

describe("Button", () => {
  it("renders its label as a button that does not submit forms by default", () => {
    render(<Button>Save</Button>);
    const btn = screen.getByRole("button", { name: "Save" });
    expect(btn).toHaveAttribute("type", "button");
  });

  it("can be a submit button when asked", () => {
    const onSubmit = jest.fn((e) => e.preventDefault());
    render(
      <form onSubmit={onSubmit}>
        <Button type="submit">Send</Button>
      </form>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it("does not submit a surrounding form unless it is a submit button", () => {
    const onSubmit = jest.fn((e) => e.preventDefault());
    render(
      <form onSubmit={onSubmit}>
        <Button>Plain</Button>
      </form>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Plain" }));
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("defaults to the secondary look and takes each variant", () => {
    const { rerender } = render(<Button>x</Button>);
    expect(screen.getByRole("button")).toHaveClass("ui-btn", "ui-btn--secondary");
    for (const variant of ["primary", "ghost", "danger"] as const) {
      rerender(<Button variant={variant}>x</Button>);
      expect(screen.getByRole("button")).toHaveClass(`ui-btn--${variant}`);
    }
  });

  it("supports a small size and a full-width layout", () => {
    render(
      <Button size="sm" block>
        x
      </Button>,
    );
    expect(screen.getByRole("button")).toHaveClass("ui-btn--sm", "ui-btn--block");
  });

  it("keeps extra class names", () => {
    render(<Button className="mine">x</Button>);
    expect(screen.getByRole("button")).toHaveClass("ui-btn", "mine");
  });

  it("calls onClick", () => {
    const onClick = jest.fn();
    render(<Button onClick={onClick}>Go</Button>);
    fireEvent.click(screen.getByRole("button"));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("ignores clicks while disabled", () => {
    const onClick = jest.fn();
    render(
      <Button disabled onClick={onClick}>
        Go
      </Button>,
    );
    fireEvent.click(screen.getByRole("button"));
    expect(onClick).not.toHaveBeenCalled();
  });

  it("blocks clicks and says it is busy while loading", () => {
    const onClick = jest.fn();
    render(
      <Button loading onClick={onClick}>
        Saving
      </Button>,
    );
    const btn = screen.getByRole("button", { name: "Saving" });
    expect(btn).toBeDisabled();
    expect(btn).toHaveAttribute("aria-busy", "true");
    fireEvent.click(btn);
    expect(onClick).not.toHaveBeenCalled();
  });

  it("does not claim to be busy when it is not loading", () => {
    render(<Button>Go</Button>);
    expect(screen.getByRole("button")).not.toHaveAttribute("aria-busy");
  });

  it("shows an icon before the label", () => {
    render(<Button icon={<svg data-testid="icon" />}>Go</Button>);
    expect(screen.getByTestId("icon")).toBeInTheDocument();
  });

  it("replaces the icon with a spinner while loading", () => {
    render(
      <Button loading icon={<svg data-testid="icon" />}>
        Go
      </Button>,
    );
    expect(screen.queryByTestId("icon")).not.toBeInTheDocument();
    expect(document.querySelector(".ui-spin")).toBeInTheDocument();
  });

  it("passes its ref to the button element", () => {
    const ref = createRef<HTMLButtonElement>();
    render(<Button ref={ref}>x</Button>);
    expect(ref.current).toBe(screen.getByRole("button"));
  });

  it("passes other attributes through, such as an accessible name for an icon-only button", () => {
    render(<Button aria-label="Close" icon={<svg />} />);
    expect(screen.getByRole("button", { name: "Close" })).toBeInTheDocument();
  });
});
