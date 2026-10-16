import type { ReactNode } from "react";
import { cx } from "./cx";
import "./ui.css";

export interface ChipProps {
  children: ReactNode;
  /** Makes the chip a toggle button. Without it the chip is plain text. */
  onClick?: () => void;
  selected?: boolean;
  /** A number shown after the label, such as the size of a filter. */
  count?: number;
  className?: string;
}

/** A pill used for filters and tags. With onClick it is a toggle, without it a label. */
export function Chip({ children, onClick, selected = false, count, className }: ChipProps) {
  const content = (
    <>
      {children}
      {count !== undefined && <span className="ui-chip__count">{count}</span>}
    </>
  );
  if (!onClick) {
    return <span className={cx("ui-chip", className)}>{content}</span>;
  }
  return (
    <button type="button" className={cx("ui-chip", className)} aria-pressed={selected} onClick={onClick}>
      {content}
    </button>
  );
}
