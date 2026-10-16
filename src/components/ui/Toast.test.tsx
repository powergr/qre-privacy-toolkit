import { act, render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";
import { ToastProvider, useToast, type ToastApi } from "./Toast";

let api: ToastApi;
function Grab() {
  api = useToast();
  return null;
}

function setup(max?: number) {
  return render(
    <ToastProvider max={max}>
      <Grab />
    </ToastProvider>,
  );
}

beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

const advance = (ms: number) => act(() => void jest.advanceTimersByTime(ms));

describe("Toast", () => {
  it("shows a message", () => {
    setup();
    act(() => void api.success("Saved"));
    expect(screen.getByText("Saved")).toBeInTheDocument();
  });

  it("shows a title above the message", () => {
    setup();
    act(() => void api.info("Three files were skipped.", { title: "Done" }));
    expect(screen.getByText("Done")).toBeInTheDocument();
    expect(screen.getByText(/Three files were skipped/)).toBeInTheDocument();
  });

  it("lets assistive technology announce it politely, and errors urgently", () => {
    setup();
    act(() => {
      api.success("Saved");
      api.error("Could not save");
    });
    expect(screen.getByText("Saved").closest(".ui-toast")).toHaveAttribute("role", "status");
    expect(screen.getByText("Could not save").closest(".ui-toast")).toHaveAttribute("role", "alert");
  });

  it("marks the tone of each toast", () => {
    setup(4);
    act(() => {
      api.success("a");
      api.error("b");
      api.warning("c");
      api.info("d");
    });
    expect(screen.getByText("a").closest(".ui-toast")).toHaveClass("ui-toast--success");
    expect(screen.getByText("b").closest(".ui-toast")).toHaveClass("ui-toast--error");
    expect(screen.getByText("c").closest(".ui-toast")).toHaveClass("ui-toast--warning");
    expect(screen.getByText("d").closest(".ui-toast")).toHaveClass("ui-toast--info");
  });

  it("uses a general show function with a tone, defaulting to info", () => {
    setup();
    act(() => void api.show({ message: "Plain" }));
    expect(screen.getByText("Plain").closest(".ui-toast")).toHaveClass("ui-toast--info");
  });

  it("closes itself after a few seconds", () => {
    setup();
    act(() => void api.success("Saved"));
    advance(3900);
    expect(screen.getByText("Saved")).toBeInTheDocument();
    advance(200);
    expect(screen.queryByText("Saved")).not.toBeInTheDocument();
  });

  it("leaves errors up longer than successes", () => {
    setup();
    act(() => void api.error("Could not save"));
    advance(5000);
    expect(screen.getByText("Could not save")).toBeInTheDocument();
    advance(3500);
    expect(screen.queryByText("Could not save")).not.toBeInTheDocument();
  });

  it("keeps a toast with an action for longer", () => {
    setup();
    act(() => void api.success("Deleted", { action: { label: "Undo", onClick: () => {} } }));
    advance(9000);
    expect(screen.getByText("Deleted")).toBeInTheDocument();
    advance(1500);
    expect(screen.queryByText("Deleted")).not.toBeInTheDocument();
  });

  it("stays until dismissed when the duration is 0", () => {
    setup();
    act(() => void api.info("Stay", { duration: 0 }));
    advance(60_000);
    expect(screen.getByText("Stay")).toBeInTheDocument();
  });

  it("honours a custom duration", () => {
    setup();
    act(() => void api.info("Quick", { duration: 500 }));
    advance(600);
    expect(screen.queryByText("Quick")).not.toBeInTheDocument();
  });

  it("stops the countdown while the pointer is over it, then starts it again", () => {
    setup();
    act(() => void api.success("Reading"));
    const toast = screen.getByText("Reading").closest(".ui-toast")!;
    advance(3000);
    fireEvent.mouseEnter(toast);
    advance(10_000);
    expect(screen.getByText("Reading")).toBeInTheDocument();
    fireEvent.mouseLeave(toast);
    advance(4100);
    expect(screen.queryByText("Reading")).not.toBeInTheDocument();
  });

  it("also pauses while a button inside it has keyboard focus", () => {
    setup();
    act(() => void api.success("Focused"));
    const toast = screen.getByText("Focused").closest(".ui-toast")!;
    fireEvent.focus(toast);
    advance(10_000);
    expect(screen.getByText("Focused")).toBeInTheDocument();
    fireEvent.blur(toast);
    advance(4100);
    expect(screen.queryByText("Focused")).not.toBeInTheDocument();
  });

  it("runs the action and then closes the toast", () => {
    setup();
    const onClick = jest.fn();
    act(() => void api.success("Deleted", { action: { label: "Undo", onClick } }));
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("Deleted")).not.toBeInTheDocument();
  });

  it("closes with its dismiss button", () => {
    setup();
    act(() => void api.error("Oops"));
    fireEvent.click(screen.getByRole("button", { name: "Dismiss notification" }));
    expect(screen.queryByText("Oops")).not.toBeInTheDocument();
  });

  it("can be closed from code with the id it returned", () => {
    setup();
    let id = 0;
    act(() => {
      id = api.info("Temp", { duration: 0 });
    });
    expect(screen.getByText("Temp")).toBeInTheDocument();
    act(() => api.dismiss(id));
    expect(screen.queryByText("Temp")).not.toBeInTheDocument();
  });

  it("gives every toast its own id", () => {
    setup();
    let a = 0;
    let b = 0;
    act(() => {
      a = api.info("a");
      b = api.info("b");
    });
    expect(a).not.toBe(b);
  });

  it("keeps only the newest few on screen", () => {
    setup(2);
    act(() => {
      api.info("one", { duration: 0 });
      api.info("two", { duration: 0 });
      api.info("three", { duration: 0 });
    });
    expect(screen.queryByText("one")).not.toBeInTheDocument();
    expect(screen.getByText("two")).toBeInTheDocument();
    expect(screen.getByText("three")).toBeInTheDocument();
  });

  it("allows three at once by default", () => {
    setup();
    act(() => {
      for (const m of ["a", "b", "c", "d"]) api.info(m, { duration: 0 });
    });
    expect(screen.queryByText("a")).not.toBeInTheDocument();
    expect(screen.getAllByRole("status")).toHaveLength(3);
  });

  it("puts the toasts in a named region", () => {
    setup();
    expect(screen.getByRole("region", { name: "Notifications" })).toBeInTheDocument();
  });

  it("is safe to use where no provider is mounted", () => {
    let loose: ToastApi | undefined;
    function Loose() {
      loose = useToast();
      return <p>content</p>;
    }
    render(<Loose />);
    expect(screen.getByText("content")).toBeInTheDocument();
    expect(() => {
      loose!.success("x");
      loose!.error("x");
      loose!.info("x");
      loose!.warning("x");
      loose!.show({ message: "x" });
      loose!.dismiss(1);
    }).not.toThrow();
  });

  it("clears its timers when the app goes away", () => {
    const { unmount } = setup();
    act(() => void api.success("Bye"));
    unmount();
    expect(jest.getTimerCount()).toBe(0);
  });
});
