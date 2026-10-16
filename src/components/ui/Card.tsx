import type { HTMLAttributes, ReactNode } from "react";
import { cx } from "./cx";
import "./ui.css";

export interface CardProps extends HTMLAttributes<HTMLElement> {
  /** The element to render. Use section or article when the card is a real section. */
  as?: "div" | "section" | "article";
  /** A lifted card for the one element that should stand out from its neighbours. */
  raised?: boolean;
  padding?: "none" | "sm" | "md" | "lg";
  children?: ReactNode;
}

export function Card({
  as: Tag = "div",
  raised = false,
  padding = "md",
  className,
  children,
  ...rest
}: CardProps) {
  return (
    <Tag
      className={cx("ui-card", raised && "ui-card--raised", padding !== "md" && `ui-card--pad-${padding}`, className)}
      {...rest}
    >
      {children}
    </Tag>
  );
}
