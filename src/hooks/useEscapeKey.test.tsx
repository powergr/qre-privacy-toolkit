import { render } from "@testing-library/react";
import { fireEvent } from "@testing-library/react";
import { useEscapeKey } from "./useEscapeKey";

function Probe({ onEscape, active = true }: { onEscape: () => void; active?: boolean }) {
  useEscapeKey(onEscape, active);
  return null;
}

const press = (key = "Escape", init: KeyboardEventInit = {}) => fireEvent.keyDown(window, { key, ...init });

describe("useEscapeKey", () => {
  it("calls the handler when Escape is pressed", () => {
    const fn = jest.fn();
    render(<Probe onEscape={fn} />);
    press();
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("ignores other keys", () => {
    const fn = jest.fn();
    render(<Probe onEscape={fn} />);
    press("Enter");
    press("a");
    expect(fn).not.toHaveBeenCalled();
  });

  it("does nothing while inactive, and starts when it becomes active", () => {
    const fn = jest.fn();
    const { rerender } = render(<Probe onEscape={fn} active={false} />);
    press();
    expect(fn).not.toHaveBeenCalled();
    rerender(<Probe onEscape={fn} active />);
    press();
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("stops after unmount", () => {
    const fn = jest.fn();
    const { unmount } = render(<Probe onEscape={fn} />);
    unmount();
    press();
    expect(fn).not.toHaveBeenCalled();
  });

  it("only the newest dialog reacts, then the one beneath it", () => {
    const lower = jest.fn();
    const upper = jest.fn();
    render(<Probe onEscape={lower} />);
    const top = render(<Probe onEscape={upper} />);

    press();
    expect(upper).toHaveBeenCalledTimes(1);
    expect(lower).not.toHaveBeenCalled();

    top.unmount();
    press();
    expect(lower).toHaveBeenCalledTimes(1);
  });

  it("always runs the latest handler without re-registering", () => {
    const first = jest.fn();
    const second = jest.fn();
    const { rerender } = render(<Probe onEscape={first} />);
    rerender(<Probe onEscape={second} />);
    press();
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it("ignores Escape pressed while an input method is composing", () => {
    const fn = jest.fn();
    render(<Probe onEscape={fn} />);
    press("Escape", { isComposing: true });
    expect(fn).not.toHaveBeenCalled();
  });
});
