import { render, fireEvent } from "@testing-library/react";
import { useShortcut } from "./useShortcut";

function Probe({
  k = "k",
  fn,
  opts,
}: {
  k?: string;
  fn: () => void;
  opts?: Parameters<typeof useShortcut>[2];
}) {
  useShortcut(k, fn, opts);
  return null;
}

const press = (key: string, init: KeyboardEventInit = {}) =>
  fireEvent.keyDown(window, { key, ...init });

afterEach(() => {
  document.body.innerHTML = "";
});

describe("useShortcut", () => {
  it("runs on Ctrl plus the key", () => {
    const fn = jest.fn();
    render(<Probe fn={fn} />);
    press("k", { ctrlKey: true });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("also runs on Cmd, for Macs", () => {
    const fn = jest.fn();
    render(<Probe fn={fn} />);
    press("k", { metaKey: true });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("matches upper and lower case keys", () => {
    const fn = jest.fn();
    render(<Probe k="K" fn={fn} />);
    press("k", { ctrlKey: true });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("ignores the key without Ctrl, with Alt, or with the wrong key", () => {
    const fn = jest.fn();
    render(<Probe fn={fn} />);
    press("k");
    press("k", { ctrlKey: true, altKey: true });
    press("j", { ctrlKey: true });
    expect(fn).not.toHaveBeenCalled();
  });

  it("keeps Ctrl+K and Ctrl+Shift+K apart", () => {
    const plain = jest.fn();
    const shifted = jest.fn();
    render(
      <>
        <Probe fn={plain} />
        <Probe fn={shifted} opts={{ shift: true }} />
      </>,
    );
    press("k", { ctrlKey: true });
    expect(plain).toHaveBeenCalledTimes(1);
    expect(shifted).not.toHaveBeenCalled();
    press("K", { ctrlKey: true, shiftKey: true });
    expect(plain).toHaveBeenCalledTimes(1);
    expect(shifted).toHaveBeenCalledTimes(1);
  });

  it("blocks the browser's own action for the key", () => {
    render(<Probe fn={() => {}} />);
    const event = new KeyboardEvent("keydown", { key: "k", ctrlKey: true, cancelable: true });
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  });

  it("does nothing while disabled, and works once enabled", () => {
    const fn = jest.fn();
    const { rerender } = render(<Probe fn={fn} opts={{ enabled: false }} />);
    press("k", { ctrlKey: true });
    expect(fn).not.toHaveBeenCalled();
    rerender(<Probe fn={fn} opts={{ enabled: true }} />);
    press("k", { ctrlKey: true });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("stops after unmount", () => {
    const fn = jest.fn();
    const { unmount } = render(<Probe fn={fn} />);
    unmount();
    press("k", { ctrlKey: true });
    expect(fn).not.toHaveBeenCalled();
  });

  it("always calls the newest handler", () => {
    const first = jest.fn();
    const second = jest.fn();
    const { rerender } = render(<Probe fn={first} />);
    rerender(<Probe fn={second} />);
    press("k", { ctrlKey: true });
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });

  describe("with a dialog open", () => {
    const openDialog = () => {
      const d = document.createElement("div");
      d.className = "modal-overlay";
      document.body.appendChild(d);
    };

    it("does nothing by default, but still stops the browser action", () => {
      const fn = jest.fn();
      render(<Probe fn={fn} />);
      openDialog();
      const event = new KeyboardEvent("keydown", { key: "k", ctrlKey: true, cancelable: true });
      window.dispatchEvent(event);
      expect(fn).not.toHaveBeenCalled();
      expect(event.defaultPrevented).toBe(true);
    });

    it("runs when the shortcut belongs to the dialog", () => {
      const fn = jest.fn();
      render(<Probe fn={fn} opts={{ allowInDialog: true }} />);
      openDialog();
      press("k", { ctrlKey: true });
      expect(fn).toHaveBeenCalledTimes(1);
    });
  });
});
