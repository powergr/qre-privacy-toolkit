import type { ReactNode } from "react";
import { cx } from "./cx";
import "./ui.css";

export interface ActionBarProps {
  /** Says exactly what the main button will do, such as "2.4 GB in 6 categories". */
  summary?: ReactNode;
  /** The buttons. Put the main action last. */
  children: ReactNode;
  /** Keeps the bar at the bottom of the scrolling page. */
  sticky?: boolean;
  className?: string;
}

/** The row of actions at the bottom of a tool page. */
export function ActionBar({ summary, children, sticky = true, className }: ActionBarProps) {
  return (
    <div className={cx("ui-actionbar", sticky && "ui-actionbar--sticky", className)}>
      {summary !== undefined && <div className="ui-actionbar__summary">{summary}</div>}
      <div className="ui-actionbar__actions">{children}</div>
    </div>
  );
}
