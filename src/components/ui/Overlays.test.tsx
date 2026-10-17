import { useState } from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";
import { Dialog, Drawer, SHEET_CLOSE_DISTANCE } from "./Sheet";
import { dialogIsOpen } from "../../hooks/useShortcut";

const escape = () => fireEvent.keyDown(window, { key: "Escape" });

describe("Dialog", () => {
  it("is a dialog named by its title and described by its description", () => {
    render(
      <Dialog title="Delete item" description="This cannot be undone." onClose={() => {}}>
        <p>body</p>
      </Dialog>,
    );
    const dialog = screen.getByRole("dialog", { name: "Delete item" });
    expect(dialog).toHaveAccessibleDescription("This cannot be undone.");
    expect(dialog).toHaveAttribute("aria-modal", "true");
  });

  it("renders nothing while closed", () => {
    render(<Dialog open={false} title="Hidden" onClose={() => {}} />);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("shows its content and its buttons", () => {
    render(
      <Dialog title="Confirm" actions={<button>Do it</button>} onClose={() => {}}>
        <p>Are you sure?</p>
      </Dialog>,
    );
    expect(screen.getByText("Are you sure?")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Do it" })).toBeInTheDocument();
  });

  it("can be an alert dialog for something that needs an answer", () => {
    render(<Dialog alert title="Shred forever?" onClose={() => {}} />);
    expect(screen.getByRole("alertdialog", { name: "Shred forever?" })).toBeInTheDocument();
  });

  it("turns red for a destructive step", () => {
    render(<Dialog tone="danger" title="Shred" onClose={() => {}} />);
    expect(screen.getByRole("dialog")).toHaveClass("ui-dialog--danger");
  });

  it("closes with Escape", () => {
    const onClose = jest.fn();
    render(<Dialog title="x" onClose={onClose} />);
    escape();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("closes with its close button", () => {
    const onClose = jest.fn();
    render(<Dialog title="x" onClose={onClose} />);
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("closes when the dimmed page around it is pressed, but not when the dialog itself is", () => {
    const onClose = jest.fn();
    render(<Dialog title="x" onClose={onClose} />);
    fireEvent.mouseDown(screen.getByRole("dialog"));
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.mouseDown(document.querySelector(".modal-overlay") as HTMLElement);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("cannot be dismissed while it is busy", () => {
    const onClose = jest.fn();
    render(<Dialog title="Saving" dismissible={false} onClose={onClose} />);
    escape();
    fireEvent.mouseDown(document.querySelector(".modal-overlay") as HTMLElement);
    expect(screen.queryByRole("button", { name: "Close" })).not.toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("stops reacting to Escape once it is closed", () => {
    const onClose = jest.fn();
    const { rerender } = render(<Dialog title="x" onClose={onClose} />);
    rerender(<Dialog open={false} title="x" onClose={onClose} />);
    escape();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("counts as an open dialog, so keyboard shortcuts behind it pause", () => {
    const { rerender } = render(<Dialog title="x" onClose={() => {}} />);
    expect(dialogIsOpen()).toBe(true);
    rerender(<Dialog open={false} title="x" onClose={() => {}} />);
    expect(dialogIsOpen()).toBe(false);
  });

  it("puts focus on the first real control, not on the close button", () => {
    render(
      <Dialog title="x" actions={<button>Cancel</button>} onClose={() => {}}>
        <input aria-label="Name" />
      </Dialog>,
    );
    expect(screen.getByLabelText("Name")).toHaveFocus();
  });

  it("puts focus on the control marked data-autofocus", () => {
    render(
      <Dialog
        title="x"
        actions={
          <>
            <button>Cancel</button>
            <button data-autofocus>Delete</button>
          </>
        }
        onClose={() => {}}
      >
        <input aria-label="Name" />
      </Dialog>,
    );
    expect(screen.getByRole("button", { name: "Delete" })).toHaveFocus();
  });

  it("falls back to the close button when it holds nothing else", () => {
    render(<Dialog title="x" onClose={() => {}} />);
    expect(screen.getByRole("button", { name: "Close" })).toHaveFocus();
  });

  it("leaves focus alone when a field inside has already taken it", () => {
    render(
      <Dialog title="x" onClose={() => {}}>
        <input aria-label="First" />
        <input aria-label="Second" autoFocus />
      </Dialog>,
    );
    expect(screen.getByLabelText("Second")).toHaveFocus();
  });

  it("keeps Tab inside the dialog, wrapping from the last control to the first", async () => {
    const user = userEvent.setup();
    render(
      <>
        <button>Outside</button>
        <Dialog title="x" actions={<button>Last</button>} onClose={() => {}}>
          <input aria-label="Name" />
        </Dialog>
      </>,
    );
    expect(screen.getByLabelText("Name")).toHaveFocus();
    await user.tab();
    expect(screen.getByRole("button", { name: "Last" })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole("button", { name: "Close" })).toHaveFocus();
    await user.tab();
    expect(screen.getByLabelText("Name")).toHaveFocus();
  });

  it("wraps Shift+Tab from the first control to the last", async () => {
    const user = userEvent.setup();
    render(
      <Dialog title="x" actions={<button>Last</button>} onClose={() => {}}>
        <input aria-label="Name" />
      </Dialog>,
    );
    expect(screen.getByLabelText("Name")).toHaveFocus();
    await user.tab({ shift: true });
    expect(screen.getByRole("button", { name: "Close" })).toHaveFocus();
    // The close button is the first control, so one more step back wraps to the last.
    await user.tab({ shift: true });
    expect(screen.getByRole("button", { name: "Last" })).toHaveFocus();
  });

  it("gives focus back to the button that opened it", () => {
    function Opener() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button onClick={() => setOpen(true)}>Open</button>
          <Dialog open={open} title="x" onClose={() => setOpen(false)}>
            <input aria-label="Name" />
          </Dialog>
        </>
      );
    }
    render(<Opener />);
    const opener = screen.getByRole("button", { name: "Open" });
    opener.focus();
    fireEvent.click(opener);
    expect(screen.getByLabelText("Name")).toHaveFocus();
    escape();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(opener).toHaveFocus();
  });

  it("has no body area when it has no children", () => {
    render(<Dialog title="x" onClose={() => {}} />);
    expect(document.querySelector(".ui-sheet__body")).toBeNull();
  });
});

describe("Drawer", () => {
  it("is a labelled dialog that slides in from the side", () => {
    render(
      <Drawer title="Edit bookmark" onClose={() => {}}>
        <p>fields</p>
      </Drawer>,
    );
    expect(screen.getByRole("dialog", { name: "Edit bookmark" })).toHaveClass("ui-drawer");
    expect(document.querySelector(".modal-overlay")).toHaveClass("ui-overlay--drawer");
  });

  it("renders nothing while closed", () => {
    render(<Drawer open={false} title="x" onClose={() => {}} />);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("shows a footer for Save and Cancel", () => {
    render(
      <Drawer title="x" footer={<button>Save</button>} onClose={() => {}}>
        <p>fields</p>
      </Drawer>,
    );
    expect(screen.getByRole("button", { name: "Save" })).toBeInTheDocument();
  });

  it("closes with Escape and with a press on the dimmed page", () => {
    const onClose = jest.fn();
    render(<Drawer title="x" onClose={onClose} />);
    escape();
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.mouseDown(document.querySelector(".modal-overlay") as HTMLElement);
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("cannot be dismissed while saving", () => {
    const onClose = jest.fn();
    render(<Drawer title="x" dismissible={false} onClose={onClose} />);
    escape();
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe("Dialog over a Drawer", () => {
  it("closes only the top one for each Escape", () => {
    const closeDrawer = jest.fn();
    const closeDialog = jest.fn();
    render(
      <>
        <Drawer title="Edit" onClose={closeDrawer} />
        <Dialog title="Delete this?" onClose={closeDialog} />
      </>,
    );
    escape();
    expect(closeDialog).toHaveBeenCalledTimes(1);
    expect(closeDrawer).not.toHaveBeenCalled();
  });
});

describe("Drawer as a phone sheet", () => {
  function phone(matches: boolean) {
    Object.defineProperty(window, "matchMedia", {
      value: () => ({ matches, addEventListener: () => {}, removeEventListener: () => {} }),
      configurable: true,
      writable: true,
    });
  }
  afterEach(() => {
    // @ts-expect-error removed again so other tests see the computer layout
    delete window.matchMedia;
  });

  const zone = () => document.querySelector(".ui-sheet__pull") as HTMLElement;
  const panel = () => screen.getByRole("dialog");
  const touch = (type: "touchStart" | "touchMove" | "touchEnd", y?: number) =>
    fireEvent[type](zone(), y === undefined ? {} : { touches: [{ clientY: y }] });

  it("has a grab handle at the top, which only a phone's style sheet shows", () => {
    phone(true);
    render(<Drawer title="Edit" onClose={() => {}} />);
    expect(document.querySelector(".ui-sheet__grab")).toHaveAttribute("aria-hidden", "true");
  });

  it("follows a finger pulling down", () => {
    phone(true);
    render(<Drawer title="Edit" onClose={() => {}} />);
    touch("touchStart", 100);
    touch("touchMove", 130);
    expect(panel().style.transform).toBe("translateY(30px)");
  });

  it("does not move up when pulled up", () => {
    phone(true);
    render(<Drawer title="Edit" onClose={() => {}} />);
    touch("touchStart", 100);
    touch("touchMove", 60);
    expect(panel().style.transform).toBe("");
  });

  it("closes when let go after a long pull", () => {
    phone(true);
    const onClose = jest.fn();
    render(<Drawer title="Edit" onClose={onClose} />);
    touch("touchStart", 100);
    touch("touchMove", 100 + SHEET_CLOSE_DISTANCE);
    touch("touchEnd");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("springs back, and stays open, after a short pull", () => {
    phone(true);
    const onClose = jest.fn();
    render(<Drawer title="Edit" onClose={onClose} />);
    touch("touchStart", 100);
    touch("touchMove", 100 + SHEET_CLOSE_DISTANCE - 1);
    touch("touchEnd");
    expect(onClose).not.toHaveBeenCalled();
    expect(panel().style.transform).toBe("");
  });

  it("ignores a move that began outside the pull area", () => {
    phone(true);
    const onClose = jest.fn();
    render(<Drawer title="Edit" onClose={onClose}><button>inside</button></Drawer>);
    fireEvent.touchMove(zone(), { touches: [{ clientY: 500 }] });
    fireEvent.touchEnd(zone());
    expect(onClose).not.toHaveBeenCalled();
  });

  it("cannot be pulled shut while it must stay open", () => {
    phone(true);
    const onClose = jest.fn();
    render(<Drawer title="Saving" dismissible={false} onClose={onClose} />);
    touch("touchStart", 100);
    touch("touchMove", 400);
    touch("touchEnd");
    expect(onClose).not.toHaveBeenCalled();
    expect(panel().style.transform).toBe("");
  });

  it("is not pulled on a computer, where it is a side panel", () => {
    phone(false);
    const onClose = jest.fn();
    render(<Drawer title="Edit" onClose={onClose} />);
    touch("touchStart", 100);
    touch("touchMove", 400);
    touch("touchEnd");
    expect(onClose).not.toHaveBeenCalled();
    expect(panel().style.transform).toBe("");
  });

  it("needs a pull of 80 pixels, not less", () => {
    phone(true);
    const onClose = jest.fn();
    render(<Drawer title="Edit" onClose={onClose} />);
    touch("touchStart", 0);
    touch("touchMove", 79);
    touch("touchEnd");
    expect(onClose).not.toHaveBeenCalled();
    touch("touchStart", 0);
    touch("touchMove", 80);
    touch("touchEnd");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("is not moved by a touch that began outside the pull area", () => {
    phone(true);
    render(<Drawer title="Edit" onClose={() => {}} />);
    fireEvent.touchMove(zone(), { touches: [{ clientY: 500 }] });
    expect(panel().style.transform).toBe("");
  });

  it("does not close a dialog by pulling it, on a phone either", () => {
    phone(true);
    const onClose = jest.fn();
    render(<Dialog title="Sure?" onClose={onClose} />);
    touch("touchStart", 0);
    touch("touchMove", 300);
    touch("touchEnd");
    expect(onClose).not.toHaveBeenCalled();
    expect(panel().style.transform).toBe("");
  });

  it("gives a dialog no pull area handle, since it stays in the middle", () => {
    phone(true);
    render(<Dialog title="Sure?" onClose={() => {}} />);
    expect(document.querySelector(".ui-sheet__grab")).toBeNull();
  });
});
