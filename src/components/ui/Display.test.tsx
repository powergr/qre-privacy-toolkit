import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";
import { Card } from "./Card";
import { Badge } from "./Badge";
import { Chip } from "./Chip";
import { EmptyState } from "./EmptyState";
import { ActionBar } from "./ActionBar";
import { ProgressCard } from "./ProgressCard";
import { ShortcutHint, shortcutKeys } from "./ShortcutHint";

describe("Card", () => {
  it("is a plain card by default", () => {
    render(<Card data-testid="c">Hi</Card>);
    const card = screen.getByTestId("c");
    expect(card.tagName).toBe("DIV");
    expect(card).toHaveClass("ui-card");
    expect(card).not.toHaveClass("ui-card--raised");
    expect(card.className).not.toMatch(/pad-/);
  });

  it("can be a section, raised, and have other padding", () => {
    render(
      <Card as="section" raised padding="lg" aria-label="Details" data-testid="c">
        Hi
      </Card>,
    );
    const card = screen.getByTestId("c");
    expect(card.tagName).toBe("SECTION");
    expect(card).toHaveClass("ui-card--raised", "ui-card--pad-lg");
  });

  it("supports no padding and small padding", () => {
    const { rerender } = render(<Card padding="none" data-testid="c" />);
    expect(screen.getByTestId("c")).toHaveClass("ui-card--pad-none");
    rerender(<Card padding="sm" data-testid="c" />);
    expect(screen.getByTestId("c")).toHaveClass("ui-card--pad-sm");
  });
});

describe("Badge", () => {
  it("is neutral by default", () => {
    render(<Badge>Draft</Badge>);
    const badge = screen.getByText("Draft");
    expect(badge).toHaveClass("ui-badge");
    expect(badge.className).not.toMatch(/--(ok|warn|danger|info)/);
  });

  it("has a class for each tone", () => {
    for (const tone of ["ok", "warn", "danger", "info"] as const) {
      const { unmount } = render(<Badge tone={tone}>{tone}</Badge>);
      expect(screen.getByText(tone)).toHaveClass(`ui-badge--${tone}`);
      unmount();
    }
  });
});

describe("Chip", () => {
  it("is plain text without a click handler", () => {
    render(<Chip>Work</Chip>);
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(screen.getByText("Work")).toHaveClass("ui-chip");
  });

  it("is a toggle button with a click handler", () => {
    const onClick = jest.fn();
    render(<Chip onClick={onClick}>Work</Chip>);
    fireEvent.click(screen.getByRole("button", { name: "Work" }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("tells assistive technology whether it is selected", () => {
    const { rerender } = render(
      <Chip onClick={() => {}} selected>
        Work
      </Chip>,
    );
    expect(screen.getByRole("button")).toHaveAttribute("aria-pressed", "true");
    rerender(<Chip onClick={() => {}}>Work</Chip>);
    expect(screen.getByRole("button")).toHaveAttribute("aria-pressed", "false");
  });

  it("shows a count after the label, including zero", () => {
    const { rerender } = render(<Chip count={12}>Weak</Chip>);
    expect(screen.getByText("12")).toBeInTheDocument();
    rerender(<Chip count={0}>Weak</Chip>);
    expect(screen.getByText("0")).toBeInTheDocument();
  });
});

describe("EmptyState", () => {
  it("shows a title, a description and actions", () => {
    render(
      <EmptyState
        title="No notes yet"
        description="Notes you write appear here."
        actions={<button>New note</button>}
      />,
    );
    expect(screen.getByRole("heading", { name: "No notes yet" })).toBeInTheDocument();
    expect(screen.getByText("Notes you write appear here.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "New note" })).toBeInTheDocument();
  });

  it("leaves out the parts it was not given", () => {
    const { container } = render(<EmptyState title="Nothing here" />);
    expect(container.querySelector(".ui-empty__desc")).toBeNull();
    expect(container.querySelector(".ui-empty__actions")).toBeNull();
    expect(container.querySelector(".ui-empty__icon")).toBeNull();
  });

  it("hides a decorative icon from screen readers", () => {
    const { container } = render(<EmptyState title="Empty" icon={<svg />} compact />);
    expect(container.querySelector(".ui-empty__icon")).toHaveAttribute("aria-hidden", "true");
    expect(container.firstChild).toHaveClass("ui-empty--compact");
  });
});

describe("ActionBar", () => {
  it("shows the summary and the buttons", () => {
    render(
      <ActionBar summary="2.4 GB in 6 categories">
        <button>Review</button>
      </ActionBar>,
    );
    expect(screen.getByText("2.4 GB in 6 categories")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Review" })).toBeInTheDocument();
  });

  it("is sticky unless told otherwise", () => {
    const { container, rerender } = render(<ActionBar>x</ActionBar>);
    expect(container.firstChild).toHaveClass("ui-actionbar--sticky");
    rerender(<ActionBar sticky={false}>x</ActionBar>);
    expect(container.firstChild).not.toHaveClass("ui-actionbar--sticky");
  });

  it("shows a summary of zero, such as a count of nothing selected", () => {
    const { container } = render(<ActionBar summary={0}>x</ActionBar>);
    expect(container.querySelector(".ui-actionbar__summary")).toHaveTextContent("0");
  });

  it("works without a summary", () => {
    const { container } = render(<ActionBar>x</ActionBar>);
    expect(container.querySelector(".ui-actionbar__summary")).toBeNull();
  });
});

describe("ProgressCard", () => {
  const bar = () => screen.getByRole("progressbar");

  it("shows the percentage and fills the bar", () => {
    render(<ProgressCard title="Cleaning" percent={42} />);
    expect(screen.getByText("42%")).toBeInTheDocument();
    expect(bar()).toHaveAttribute("aria-valuenow", "42");
    expect(bar().firstChild).toHaveStyle({ width: "42%" });
  });

  it("rounds and keeps the value between 0 and 100", () => {
    const { rerender } = render(<ProgressCard title="x" percent={41.6} />);
    expect(bar()).toHaveAttribute("aria-valuenow", "42");
    rerender(<ProgressCard title="x" percent={140} />);
    expect(bar()).toHaveAttribute("aria-valuenow", "100");
    rerender(<ProgressCard title="x" percent={-5} />);
    expect(bar()).toHaveAttribute("aria-valuenow", "0");
  });

  it("is an animated bar with no number until the size of the job is known", () => {
    const { rerender } = render(<ProgressCard title="Starting" />);
    expect(bar()).not.toHaveAttribute("aria-valuenow");
    expect(bar().firstChild).toHaveClass("ui-progress__fill--indeterminate");
    expect(screen.queryByText(/%/)).not.toBeInTheDocument();
    rerender(<ProgressCard title="Starting" percent={null} />);
    expect(bar()).not.toHaveAttribute("aria-valuenow");
    rerender(<ProgressCard title="Starting" percent={Number.NaN} />);
    expect(bar()).not.toHaveAttribute("aria-valuenow");
  });

  it("names the bar after the title and shows the detail", () => {
    render(<ProgressCard title="Shredding" detail="C:\files\old.zip" percent={10} />);
    expect(screen.getByRole("progressbar", { name: "Shredding" })).toBeInTheDocument();
    expect(screen.getByText("C:\\files\\old.zip")).toHaveAttribute("title", "C:\\files\\old.zip");
  });

  it("has no cancel button unless it can be cancelled", () => {
    render(<ProgressCard title="x" percent={1} />);
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("calls onCancel", () => {
    const onCancel = jest.fn();
    render(<ProgressCard title="x" percent={1} onCancel={onCancel} />);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("says Cancelling and blocks a second press while the work winds down", () => {
    const onCancel = jest.fn();
    render(<ProgressCard title="x" percent={1} onCancel={onCancel} cancelling />);
    const btn = screen.getByRole("button", { name: "Cancelling…" });
    expect(btn).toBeDisabled();
    fireEvent.click(btn);
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("can use another label for the cancel button", () => {
    render(<ProgressCard title="x" onCancel={() => {}} cancelLabel="Stop" />);
    expect(screen.getByRole("button", { name: "Stop" })).toBeInTheDocument();
  });
});

describe("shortcutKeys", () => {
  it("turns Mod into Ctrl, and into the command key on a Mac", () => {
    expect(shortcutKeys("Mod+S", false)).toEqual(["Ctrl", "S"]);
    expect(shortcutKeys("Mod+S", true)).toEqual(["⌘", "S"]);
  });

  it("names the other modifier keys for each system", () => {
    expect(shortcutKeys("Mod+Shift+S", false)).toEqual(["Ctrl", "Shift", "S"]);
    expect(shortcutKeys("Mod+Shift+S", true)).toEqual(["⌘", "⇧", "S"]);
    expect(shortcutKeys("Alt+N", false)).toEqual(["Alt", "N"]);
    expect(shortcutKeys("Alt+N", true)).toEqual(["⌥", "N"]);
    expect(shortcutKeys("Ctrl+Shift+Q", true)).toEqual(["⌃", "⇧", "Q"]);
  });

  it("writes single letters in capitals and keeps named keys readable", () => {
    expect(shortcutKeys("Mod+f", false)).toEqual(["Ctrl", "F"]);
    expect(shortcutKeys("esc", false)).toEqual(["Esc"]);
    expect(shortcutKeys("Escape", false)).toEqual(["Esc"]);
    expect(shortcutKeys("Enter", false)).toEqual(["Enter"]);
    expect(shortcutKeys("Enter", true)).toEqual(["↵"]);
    expect(shortcutKeys("Delete", false)).toEqual(["Delete"]);
  });

  it("ignores spaces around the plus sign", () => {
    expect(shortcutKeys("Mod + S", false)).toEqual(["Ctrl", "S"]);
  });
});

describe("ShortcutHint", () => {
  it("shows each key in its own key cap", () => {
    const { container } = render(<ShortcutHint shortcut="Mod+Shift+S" />);
    const caps = Array.from(container.querySelectorAll("kbd")).map((k) => k.textContent);
    // jsdom reports no Mac, so Mod is Ctrl here.
    expect(caps).toEqual(["Ctrl", "Shift", "S"]);
  });

  it("describes the shortcut in a tooltip", () => {
    const { container } = render(<ShortcutHint shortcut="Mod+F" />);
    expect(container.firstChild).toHaveAttribute("title", "Ctrl + F");
  });
});
