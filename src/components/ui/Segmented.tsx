import { useRef, type KeyboardEvent, type ReactNode } from "react";
import { cx } from "./cx";
import "./ui.css";

export interface SegmentedOption<T extends string> {
  value: T;
  label: ReactNode;
  icon?: ReactNode;
  disabled?: boolean;
  /** Tooltip. Useful to say why an option is disabled. */
  title?: string;
}

interface SegmentedProps<T extends string> {
  options: ReadonlyArray<SegmentedOption<T>>;
  value: T;
  onChange: (value: T) => void;
  /** Names the group for screen readers, for example "Theme". */
  label: string;
  /**
   * "options" picks one setting (radio buttons). "tabs" switches the view below it.
   * The look is the same; the roles tell assistive technology which one it is.
   */
  variant?: "options" | "tabs";
  /** Stretches across its container, each option taking an equal share, icon above the label. */
  fill?: boolean;
  className?: string;
}

/**
 * One control for both the settings switches and the tool tabs, replacing the three
 * hand-built tab bars. Arrow keys, Home and End move between the options.
 */
export function Segmented<T extends string>({
  options,
  value,
  onChange,
  label,
  variant = "options",
  fill = false,
  className,
}: SegmentedProps<T>) {
  const group = useRef<HTMLDivElement>(null);
  const isTabs = variant === "tabs";

  function move(from: number, step: 1 | -1 | "first" | "last") {
    const enabled = options.map((o, i) => (o.disabled ? -1 : i)).filter((i) => i >= 0);
    if (enabled.length === 0) return;
    let target: number;
    if (step === "first") target = enabled[0];
    else if (step === "last") target = enabled[enabled.length - 1];
    else {
      const pos = enabled.indexOf(from);
      target = enabled[(pos + step + enabled.length) % enabled.length];
    }
    onChange(options[target].value);
    group.current?.querySelectorAll<HTMLButtonElement>("button")[target]?.focus();
  }

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    const current = options.findIndex((o) => o.value === value);
    switch (e.key) {
      case "ArrowRight":
      case "ArrowDown":
        e.preventDefault();
        move(current, 1);
        break;
      case "ArrowLeft":
      case "ArrowUp":
        e.preventDefault();
        move(current, -1);
        break;
      case "Home":
        e.preventDefault();
        move(current, "first");
        break;
      case "End":
        e.preventDefault();
        move(current, "last");
        break;
    }
  }

  return (
    <div
      ref={group}
      className={cx("ui-seg", fill && "ui-seg--fill", className)}
      role={isTabs ? "tablist" : "radiogroup"}
      aria-label={label}
      onKeyDown={onKeyDown}
    >
      {options.map((o) => {
        const selected = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            className="ui-seg__item"
            role={isTabs ? "tab" : "radio"}
            aria-selected={isTabs ? selected : undefined}
            aria-checked={isTabs ? undefined : selected}
            // Only the chosen option is a tab stop. Arrow keys reach the others.
            tabIndex={selected ? 0 : -1}
            disabled={o.disabled}
            title={o.title}
            onClick={() => !selected && onChange(o.value)}
          >
            {o.icon}
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
