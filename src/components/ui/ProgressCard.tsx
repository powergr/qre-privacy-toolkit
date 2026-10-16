import type { ReactNode } from "react";
import { Card } from "./Card";
import { Button } from "./Button";
import "./ui.css";

export interface ProgressCardProps {
  title: string;
  /** What is happening right now, such as the name of the file being processed. */
  detail?: string;
  /** 0 to 100. Leave it out, or pass null, while the size of the job is not known yet. */
  percent?: number | null;
  /** Shows a Cancel button when given. */
  onCancel?: () => void;
  /**
   * True after Cancel was pressed but the work has not stopped yet. The card says
   * so and blocks a second press, because the backend finishes the current step first.
   */
  cancelling?: boolean;
  cancelLabel?: string;
  /** Extra lines under the bar, for tools that report more than one detail. */
  children?: ReactNode;
}

/**
 * The same working screen for every tool. It appears the moment work starts, with an
 * animated bar until the first real progress arrives, so the screen is never idle.
 */
export function ProgressCard({
  title,
  detail,
  percent,
  onCancel,
  cancelling = false,
  cancelLabel = "Cancel",
  children,
}: ProgressCardProps) {
  const known = typeof percent === "number" && Number.isFinite(percent);
  const value = known ? Math.min(100, Math.max(0, Math.round(percent as number))) : 0;

  return (
    <Card className="ui-progress" data-testid="progress-card">
      <div className="ui-progress__head">
        <span className="ui-progress__title">{title}</span>
        {known && <span className="ui-progress__pct">{value}%</span>}
      </div>
      {detail && (
        <p className="ui-progress__detail" title={detail}>
          {detail}
        </p>
      )}
      <div
        className="ui-progress__track"
        role="progressbar"
        aria-label={title}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={known ? value : undefined}
      >
        <div
          className={known ? "ui-progress__fill" : "ui-progress__fill ui-progress__fill--indeterminate"}
          style={known ? { width: `${value}%` } : undefined}
        />
      </div>
      {children && <div className="ui-progress__extra">{children}</div>}
      {onCancel && (
        <div className="ui-progress__foot">
          <Button size="sm" onClick={onCancel} disabled={cancelling}>
            {cancelling ? "Cancelling…" : cancelLabel}
          </Button>
        </div>
      )}
    </Card>
  );
}
