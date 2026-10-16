import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import { Loader2 } from "lucide-react";
import { cx } from "./cx";
import "./ui.css";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** primary for the one main action, secondary for the rest, danger for destructive ones. */
  variant?: ButtonVariant;
  size?: "md" | "sm";
  /** Shows a spinner and blocks clicks while work is running. */
  loading?: boolean;
  icon?: ReactNode;
  /** Fills the width of its container. */
  block?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    variant = "secondary",
    size = "md",
    loading = false,
    icon,
    block = false,
    className,
    children,
    disabled,
    // A button inside a form must not submit it by accident.
    type = "button",
    ...rest
  },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      className={cx(
        "ui-btn",
        `ui-btn--${variant}`,
        size === "sm" && "ui-btn--sm",
        block && "ui-btn--block",
        className,
      )}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...rest}
    >
      {loading ? <Loader2 size={16} className="ui-spin" aria-hidden="true" /> : icon}
      {children}
    </button>
  );
});
