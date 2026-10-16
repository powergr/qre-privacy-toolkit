import type { HTMLAttributes, ReactNode } from "react";
import { cx } from "./cx";
import "./ui.css";

export type BadgeTone = "neutral" | "ok" | "warn" | "danger" | "info";

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: BadgeTone;
  children?: ReactNode;
}

/**
 * A small status label. Always put the meaning in the text ("Weak", "Encrypted"):
 * colour alone is not enough for people who cannot tell the tones apart.
 */
export function Badge({ tone = "neutral", className, children, ...rest }: BadgeProps) {
  return (
    <span className={cx("ui-badge", tone !== "neutral" && `ui-badge--${tone}`, className)} {...rest}>
      {children}
    </span>
  );
}
