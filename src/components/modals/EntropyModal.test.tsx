import { render, screen, fireEvent, act } from "@testing-library/react";
import "@testing-library/jest-dom";
import { EntropyModal } from "./EntropyModal";

function setup() {
  const props = { onComplete: jest.fn(), onCancel: jest.fn() };
  const utils = render(<EntropyModal {...props} />);
  return { ...props, ...utils };
}

const overlay = () => document.querySelector(".modal-overlay") as HTMLElement;
const hashText = () => document.querySelector("div[style*='monospace']")!.textContent ?? "";

let x = 0;
/** One mouse movement big enough to count (more than 5 pixels from the last point). */
function wiggle(times = 1) {
  for (let i = 0; i < times; i++) {
    x += 10;
    fireEvent.mouseMove(overlay(), { clientX: x, clientY: 0 });
  }
}

// 67 counted movements add 1.5% each, which is enough to reach 100%.
const MOVES_TO_FILL = 67;

beforeEach(() => {
  jest.useFakeTimers();
  x = 0;
});
afterEach(() => jest.useRealTimers());

describe("EntropyModal - collecting movement", () => {
  it("starts empty and waiting", () => {
    setup();
    expect(screen.getByText("Generating Entropy")).toBeInTheDocument();
    expect(screen.getByText("Waiting for input...")).toBeInTheDocument();
    expect(screen.getByText("0%")).toBeInTheDocument();
  });

  it("counts each real movement as 1.5%", () => {
    setup();
    wiggle(2);
    expect(screen.getByText("3%")).toBeInTheDocument();
    wiggle(2);
    expect(screen.getByText("6%")).toBeInTheDocument();
  });

  it("ignores tiny movements and holding still", () => {
    setup();
    fireEvent.mouseMove(overlay(), { clientX: 3, clientY: 0 });
    fireEvent.mouseMove(overlay(), { clientX: 0, clientY: 5 });
    fireEvent.mouseMove(overlay(), { clientX: 0, clientY: 0 });
    expect(screen.getByText("0%")).toBeInTheDocument();
    expect(screen.getByText("Waiting for input...")).toBeInTheDocument();
  });

  it("counts diagonal movement by its real distance", () => {
    setup();
    fireEvent.mouseMove(overlay(), { clientX: 4, clientY: 4 }); // about 5.7 pixels
    expect(screen.getByText("2%")).toBeInTheDocument();
  });

  it("shows a fresh random-looking value for every movement", () => {
    setup();
    wiggle();
    const first = hashText();
    wiggle();
    const second = hashText();
    expect(first).toMatch(/^[0-9a-f]{32}$/);
    expect(second).toMatch(/^[0-9a-f]{32}$/);
    expect(second).not.toBe(first);
  });

  it("also collects touch movement, and ignores a touch event with no touches", () => {
    setup();
    fireEvent.touchMove(overlay(), { touches: [] });
    expect(screen.getByText("0%")).toBeInTheDocument();
    fireEvent.touchMove(overlay(), { touches: [{ clientX: 50, clientY: 50 }] });
    expect(screen.getByText("2%")).toBeInTheDocument();
  });

  it("does not collect after it reaches 100%", () => {
    setup();
    wiggle(MOVES_TO_FILL + 10);
    expect(screen.getByText("100%")).toBeInTheDocument();
  });
});

describe("EntropyModal - finishing", () => {
  it("hands over exactly 32 bytes, 300 ms after reaching 100%", () => {
    const { onComplete } = setup();
    wiggle(MOVES_TO_FILL);
    expect(screen.getByText("100%")).toBeInTheDocument();
    expect(onComplete).not.toHaveBeenCalled();

    act(() => {
      jest.advanceTimersByTime(299);
    });
    expect(onComplete).not.toHaveBeenCalled();
    act(() => {
      jest.advanceTimersByTime(1);
    });

    expect(onComplete).toHaveBeenCalledTimes(1);
    const bytes = onComplete.mock.calls[0][0] as number[];
    expect(bytes).toHaveLength(32);
    expect(bytes.every((b) => Number.isInteger(b) && b >= 0 && b <= 255)).toBe(true);
  });

  it("gives different bytes every time", () => {
    const run = () => {
      const { onComplete, unmount } = setup();
      wiggle(MOVES_TO_FILL);
      act(() => {
        jest.advanceTimersByTime(300);
      });
      unmount();
      return (onComplete.mock.calls[0][0] as number[]).join(",");
    };
    expect(run()).not.toBe(run());
  });

  it("keeps the most recent 32 of the bytes it collected", () => {
    // Make the random source predictable (1, 2, 3 ...). With no timing jitter in a frozen
    // clock, the collected bytes are then exactly that sequence.
    let next = 0;
    jest.spyOn(window.crypto, "getRandomValues").mockImplementation(((arr: Uint8Array) => {
      if (arr.length === 1) arr[0] = ++next;
      return arr;
    }) as typeof window.crypto.getRandomValues);

    const { onComplete } = setup();
    wiggle(MOVES_TO_FILL);
    act(() => {
      jest.advanceTimersByTime(300);
    });

    const expected = Array.from({ length: 32 }, (_, i) => MOVES_TO_FILL - 31 + i);
    expect(onComplete.mock.calls[0][0]).toEqual(expected);
  });

  it("calls onComplete only once even if the parent re-renders with a new callback", () => {
    const first = jest.fn();
    const second = jest.fn();
    const { rerender } = render(<EntropyModal onComplete={first} onCancel={jest.fn()} />);
    wiggle(MOVES_TO_FILL);

    // A parent that re-renders passes a new function each time.
    rerender(<EntropyModal onComplete={second} onCancel={jest.fn()} />);
    rerender(<EntropyModal onComplete={jest.fn()} onCancel={jest.fn()} />);
    const third = jest.fn();
    rerender(<EntropyModal onComplete={third} onCancel={jest.fn()} />);
    act(() => {
      jest.advanceTimersByTime(1000);
    });

    const total = first.mock.calls.length + second.mock.calls.length + third.mock.calls.length;
    expect(total).toBe(1);
    expect(third).toHaveBeenCalledTimes(1);
  });

  it("does not call onComplete if the dialog is closed during the 300 ms wait", () => {
    const { onComplete, unmount } = setup();
    wiggle(MOVES_TO_FILL);
    unmount();
    act(() => {
      jest.advanceTimersByTime(1000);
    });
    expect(onComplete).not.toHaveBeenCalled();
  });
});

describe("EntropyModal - cancelling", () => {
  it("calls onCancel from the button", () => {
    const { onCancel } = setup();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("a click inside the card does not reach the overlay", () => {
    const { onCancel } = setup();
    fireEvent.click(screen.getByText("Generating Entropy"));
    expect(onCancel).not.toHaveBeenCalled();
  });
});
