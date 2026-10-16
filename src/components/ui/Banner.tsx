import type { ReactNode } from "react";
import { AlertTriangle, CheckCircle2, Info, X, XCircle } from "lucide-react";
import { cx } from "./cx";
import "./ui.css";

export type BannerTone = "error" | "warning" | "info" | "success";

export interface BannerProps {
  tone?: BannerTone;
  /** What happened, and how to fix it. */
  children: ReactNode;
  /** Shows a close button. */
  onDismiss?: () => void;
  /** A button or link that deals with the problem, such as "Try again". */
  action?: ReactNode;
  /** Replaces the icon that goes with the tone. */
  icon?: ReactNode;
  className?: string;
}

const ICONS: Record<BannerTone, ReactNode> = {
  error: <XCircle size={18} />,
  warning: <AlertTriangle size={18} />,
  info: <Info size={18} />,
  success: <CheckCircle2 size={18} />,
};

/**
 * A message placed next to the thing it is about. It replaces the red and blue boxes that
 * each screen used to build for itself. Errors and warnings are announced to screen readers
 * at once; the other tones wait politely.
 */
export function Banner({ tone = "info", children, onDismiss, action, icon, className }: BannerProps) {
  return (
    <div
      className={cx("ui-banner", `ui-banner--${tone}`, className)}
      role={tone === "error" || tone === "warning" ? "alert" : "status"}
    >
      <span className="ui-banner__icon" aria-hidden="true">
        {icon ?? ICONS[tone]}
      </span>
      <div className="ui-banner__text">{children}</div>
      {action && <div className="ui-banner__action">{action}</div>}
      {onDismiss && (
        <button type="button" className="ui-banner__close" onClick={onDismiss} aria-label="Dismiss message">
          <X size={16} />
        </button>
      )}
    </div>
  );
}
