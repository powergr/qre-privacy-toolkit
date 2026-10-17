import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";
import { LoadError } from "./LoadError";

describe("LoadError", () => {
  it("says what failed, why, and that nothing was changed", () => {
    render(<LoadError title="Could not open the vault" detail="disk unreadable" onRetry={() => {}} />);
    expect(screen.getByRole("heading", { name: "Could not open the vault" })).toBeInTheDocument();
    expect(screen.getByText("disk unreadable").tagName).toBe("CODE");
    expect(screen.getByText(/Your data has not been changed/)).toBeInTheDocument();
  });

  it("offers Try again, which runs the retry once per press", () => {
    const onRetry = jest.fn();
    render(<LoadError title="t" detail="d" onRetry={onRetry} />);
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("uses the shared empty state, with the warning icon hidden from screen readers", () => {
    render(<LoadError title="t" detail="d" onRetry={() => {}} />);
    expect(document.querySelector(".ui-empty")).toBeInTheDocument();
    expect(document.querySelector(".ui-empty__icon")).toHaveAttribute("aria-hidden", "true");
  });
});
