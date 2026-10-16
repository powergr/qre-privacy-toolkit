import type { ReactNode } from "react";
import { cx } from "./cx";
import "./ui.css";

export interface EmptyStateProps {
  icon?: ReactNode;
  title: string;
  /** One or two plain sentences: what will appear here, and how to add the first thing. */
  description?: ReactNode;
  /** Buttons. Put the main action first. */
  actions?: ReactNode;
  compact?: boolean;
  className?: string;
}

/** What a screen shows before there is anything to show. Never leave a blank area. */
export function EmptyState({ icon, title, description, actions, compact = false, className }: EmptyStateProps) {
  return (
    <div className={cx("ui-empty", compact && "ui-empty--compact", className)}>
      {icon && (
        <div className="ui-empty__icon" aria-hidden="true">
          {icon}
        </div>
      )}
      <h3 className="ui-empty__title">{title}</h3>
      {description && <p className="ui-empty__desc">{description}</p>}
      {actions && <div className="ui-empty__actions">{actions}</div>}
    </div>
  );
}
