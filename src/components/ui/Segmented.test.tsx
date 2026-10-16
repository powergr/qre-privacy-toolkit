import { useState } from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";
import { Segmented, type SegmentedOption } from "./Segmented";

type Theme = "system" | "dark" | "light";
const THEMES: SegmentedOption<Theme>[] = [
  { value: "system", label: "System" },
  { value: "dark", label: "Dark" },
  { value: "light", label: "Light" },
];

function Harness({
  options = THEMES,
  initial = "system",
  variant,
  onChange,
}: {
  options?: SegmentedOption<Theme>[];
  initial?: Theme;
  variant?: "options" | "tabs";
  onChange?: (v: Theme) => void;
}) {
  const [value, setValue] = useState<Theme>(initial);
  return (
    <Segmented
      label="Theme"
      options={options}
      value={value}
      variant={variant}
      onChange={(v) => {
        setValue(v);
        onChange?.(v);
      }}
    />
  );
}

// Keys are handled on the group, so pressing one on any option reaches it.
const key = (_role: string, k: string) => fireEvent.keyDown(screen.getByRole("radiogroup"), { key: k });

describe("Segmented", () => {
  it("is a named radio group by default, with the current option checked", () => {
    render(<Harness />);
    expect(screen.getByRole("radiogroup", { name: "Theme" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "System" })).toBeChecked();
    expect(screen.getByRole("radio", { name: "Dark" })).not.toBeChecked();
  });

  it("is a tab list when used for tabs", () => {
    render(<Harness variant="tabs" />);
    expect(screen.getByRole("tablist", { name: "Theme" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "System" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name: "Dark" })).toHaveAttribute("aria-selected", "false");
  });

  it("changes the value when an option is clicked", () => {
    const onChange = jest.fn();
    render(<Harness onChange={onChange} />);
    fireEvent.click(screen.getByRole("radio", { name: "Dark" }));
    expect(onChange).toHaveBeenCalledWith("dark");
    expect(screen.getByRole("radio", { name: "Dark" })).toBeChecked();
  });

  it("does not report a click on the option that is already chosen", () => {
    const onChange = jest.fn();
    render(<Harness onChange={onChange} />);
    fireEvent.click(screen.getByRole("radio", { name: "System" }));
    expect(onChange).not.toHaveBeenCalled();
  });

  it("makes only the chosen option a tab stop", () => {
    render(<Harness initial="dark" />);
    expect(screen.getByRole("radio", { name: "Dark" })).toHaveAttribute("tabindex", "0");
    expect(screen.getByRole("radio", { name: "System" })).toHaveAttribute("tabindex", "-1");
    expect(screen.getByRole("radio", { name: "Light" })).toHaveAttribute("tabindex", "-1");
  });

  it("moves to the next and previous option with the arrow keys, and wraps around", () => {
    render(<Harness initial="light" />);
    key("radio", "ArrowRight");
    expect(screen.getByRole("radio", { name: "System" })).toBeChecked();
    key("radio", "ArrowLeft");
    expect(screen.getByRole("radio", { name: "Light" })).toBeChecked();
  });

  it("also accepts the down and up arrows", () => {
    render(<Harness initial="system" />);
    key("radio", "ArrowDown");
    expect(screen.getByRole("radio", { name: "Dark" })).toBeChecked();
    key("radio", "ArrowUp");
    expect(screen.getByRole("radio", { name: "System" })).toBeChecked();
  });

  it("jumps to the first and last option with Home and End", () => {
    render(<Harness initial="dark" />);
    key("radio", "End");
    expect(screen.getByRole("radio", { name: "Light" })).toBeChecked();
    key("radio", "Home");
    expect(screen.getByRole("radio", { name: "System" })).toBeChecked();
  });

  it("moves keyboard focus along with the choice", () => {
    render(<Harness initial="system" />);
    key("radio", "ArrowRight");
    expect(screen.getByRole("radio", { name: "Dark" })).toHaveFocus();
  });

  it("skips disabled options when using the keyboard", () => {
    const options: SegmentedOption<Theme>[] = [
      THEMES[0],
      { ...THEMES[1], disabled: true },
      THEMES[2],
    ];
    render(<Harness options={options} initial="system" />);
    key("radio", "ArrowRight");
    expect(screen.getByRole("radio", { name: "Light" })).toBeChecked();
  });

  it("cannot choose a disabled option, and shows why in its tooltip", () => {
    const onChange = jest.fn();
    const options: SegmentedOption<Theme>[] = [
      THEMES[0],
      { ...THEMES[1], disabled: true, title: "Not available on this device" },
      THEMES[2],
    ];
    render(<Harness options={options} onChange={onChange} />);
    const dark = screen.getByRole("radio", { name: "Dark" });
    expect(dark).toBeDisabled();
    expect(dark).toHaveAttribute("title", "Not available on this device");
    fireEvent.click(dark);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("ignores other keys", () => {
    const onChange = jest.fn();
    render(<Harness onChange={onChange} />);
    key("radio", "a");
    key("radio", "Enter");
    expect(onChange).not.toHaveBeenCalled();
  });

  it("does nothing on the keyboard when every option is disabled", () => {
    const onChange = jest.fn();
    const options = THEMES.map((o) => ({ ...o, disabled: true }));
    render(
      <Segmented label="Theme" options={options} value="system" onChange={onChange} />,
    );
    fireEvent.keyDown(screen.getByRole("radiogroup"), { key: "ArrowRight" });
    expect(onChange).not.toHaveBeenCalled();
  });
});
